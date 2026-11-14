//! Thin wrapper around the `git` executable.
//!
//! Every operation shells out to the user's installed git so that hooks, credential
//! helpers, SSH config, signing and `.gitconfig` behave exactly as on the command line.
//! Read-heavy paths can later move to an in-process library (gix) where it pays off.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::graph::{self, GraphRow};

pub type GitResult<T> = Result<T, String>;

const FIELD_SEP: char = '\x1f';

fn git_command(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo)
        // Read commands must never take the index lock, otherwise our own status
        // refreshes would race with the user's git commands and retrigger the watcher.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Never block on an interactive credential prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run(repo: &Path, args: &[&str]) -> GitResult<String> {
    run_with(repo, args, None, &[0])
}

fn run_with(repo: &Path, args: &[&str], stdin: Option<&str>, ok_codes: &[i32]) -> GitResult<String> {
    let mut cmd = git_command(repo);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start git: {e}"))?;
    if let Some(input) = stdin {
        // The handle is dropped at the end of the statement, closing stdin.
        child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let code = out.status.code().unwrap_or(-1);
    if ok_codes.contains(&code) {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} exited with code {code}", args.join(" "))
        } else {
            stderr
        })
    }
}

fn has_head(repo: &Path) -> bool {
    run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub git_dir: String,
    pub name: String,
}

pub fn open_repo(path: &Path) -> GitResult<RepoInfo> {
    let out = run(path, &["rev-parse", "--show-toplevel", "--absolute-git-dir"])
        .map_err(|_| format!("{} is not inside a git repository", path.display()))?;
    let mut lines = out.lines();
    let root = lines.next().ok_or("Unexpected rev-parse output")?.to_string();
    let git_dir = lines.next().ok_or("Unexpected rev-parse output")?.to_string();
    let name = Path::new(&root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    Ok(RepoInfo { root, git_dir, name })
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub orig_path: Option<String>,
    /// Single letter: M, T, A, D, R, C, U (conflict) or ? (untracked).
    pub status: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
}

pub fn status(repo: &Path) -> GitResult<Status> {
    let out = run(repo, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    Ok(parse_status(&out))
}

fn parse_status(out: &str) -> Status {
    let mut st = Status::default();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());

    while let Some(entry) = entries.next() {
        let kind = entry.as_bytes()[0];
        match kind {
            b'#' => {
                let mut parts = entry.splitn(3, ' ');
                let (_, key, value) = (parts.next(), parts.next(), parts.next().unwrap_or(""));
                match key {
                    Some("branch.head") if value != "(detached)" => st.branch = Some(value.into()),
                    Some("branch.upstream") => st.upstream = Some(value.into()),
                    Some("branch.ab") => {
                        for v in value.split(' ') {
                            if let Some(n) = v.strip_prefix('+') {
                                st.ahead = n.parse().unwrap_or(0);
                            } else if let Some(n) = v.strip_prefix('-') {
                                st.behind = n.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
            }
            b'1' | b'2' => {
                let field_count = if kind == b'1' { 9 } else { 10 };
                let fields: Vec<&str> = entry.splitn(field_count, ' ').collect();
                if fields.len() < field_count {
                    continue;
                }
                let xy = fields[1].as_bytes();
                let path = fields[field_count - 1].to_string();
                // Renames/copies carry the original path in the next NUL-separated token.
                let orig_path = if kind == b'2' { entries.next().map(String::from) } else { None };
                push_xy(&mut st, xy, path, orig_path);
            }
            b'u' => {
                let fields: Vec<&str> = entry.splitn(11, ' ').collect();
                if let Some(path) = fields.get(10) {
                    st.conflicted.push(FileChange { path: path.to_string(), orig_path: None, status: "U".into() });
                }
            }
            b'?' => st.unstaged.push(FileChange {
                path: entry[2..].to_string(),
                orig_path: None,
                status: "?".into(),
            }),
            _ => {}
        }
    }
    st
}

fn push_xy(st: &mut Status, xy: &[u8], path: String, orig_path: Option<String>) {
    let (x, y) = (xy[0], xy[1]);
    if x != b'.' {
        st.staged.push(FileChange {
            path: path.clone(),
            orig_path: if matches!(x, b'R' | b'C') { orig_path.clone() } else { None },
            status: (x as char).to_string(),
        });
    }
    if y != b'.' {
        st.unstaged.push(FileChange {
            path,
            orig_path: if matches!(y, b'R' | b'C') { orig_path } else { None },
            status: (y as char).to_string(),
        });
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// "head" (detached HEAD), "local", "remote" or "tag".
    pub kind: String,
    /// True for the branch HEAD points at.
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    pub graph: GraphRow,
}

pub fn log(repo: &Path, limit: usize) -> GitResult<Vec<LogEntry>> {
    if !has_head(repo) {
        return Ok(Vec::new());
    }
    let limit_arg = format!("-n{limit}");
    let out = run(
        repo,
        &[
            "log",
            "--date-order",
            "--decorate=full",
            "-z",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D",
            &limit_arg,
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
        ],
    )?;

    let mut entries: Vec<LogEntry> = out
        .split('\0')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|record| {
            let f: Vec<&str> = record.trim_start_matches('\n').splitn(7, FIELD_SEP).collect();
            if f.len() < 7 {
                return None;
            }
            Some(LogEntry {
                sha: f[0].to_string(),
                parents: f[1].split(' ').filter(|p| !p.is_empty()).map(String::from).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
                refs: parse_decorations(f[6]),
                graph: GraphRow::default(),
            })
        })
        .collect();

    let rows = graph::layout(entries.iter().map(|e| (e.sha.as_str(), e.parents.as_slice())));
    for (entry, row) in entries.iter_mut().zip(rows) {
        entry.graph = row;
    }
    Ok(entries)
}

/// Parses `%D` output with `--decorate=full`, e.g.
/// `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0`.
fn parse_decorations(d: &str) -> Vec<RefLabel> {
    let mut refs = Vec::new();
    for part in d.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        let (full, current) = match part.strip_prefix("HEAD -> ") {
            Some(rest) => (rest, true),
            None => (part, false),
        };
        let full = full.strip_prefix("tag: ").unwrap_or(full);
        let label = if full == "HEAD" {
            RefLabel { name: "HEAD".into(), kind: "head".into(), current: true }
        } else if let Some(n) = full.strip_prefix("refs/heads/") {
            RefLabel { name: n.into(), kind: "local".into(), current }
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                continue;
            }
            RefLabel { name: n.into(), kind: "remote".into(), current: false }
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            RefLabel { name: n.into(), kind: "tag".into(), current: false }
        } else {
            continue; // stash and other refs are not shown as labels
        };
        refs.push(label);
    }
    refs
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub message: String,
    pub files: Vec<FileChange>,
}

pub fn commit_details(repo: &Path, sha: &str) -> GitResult<CommitDetails> {
    let out = run(
        repo,
        &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", sha, "--"],
    )?;
    let f: Vec<&str> = out.splitn(9, FIELD_SEP).collect();
    if f.len() < 9 {
        return Err("Unexpected git show output".into());
    }
    let parents: Vec<String> = f[1].split(' ').filter(|p| !p.is_empty()).map(String::from).collect();

    // Merge commits are shown relative to their first parent, like most GUI clients do.
    let files_out = match parents.first() {
        Some(parent) => run(repo, &["diff", "--name-status", "-z", "-M", parent, sha, "--"])?,
        None => run(repo, &["diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", "-M", sha])?,
    };

    Ok(CommitDetails {
        sha: f[0].to_string(),
        parents,
        author: f[2].to_string(),
        author_email: f[3].to_string(),
        author_time: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        committer_email: f[6].to_string(),
        committer_time: f[7].parse().unwrap_or(0),
        message: f[8].trim_end().to_string(),
        files: parse_name_status(&files_out),
    })
}

/// Parses `--name-status -z` output: `M\0path\0`, `R100\0old\0new\0`.
fn parse_name_status(out: &str) -> Vec<FileChange> {
    let mut files = Vec::new();
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    while let Some(code) = tokens.next() {
        let status = code.chars().next().unwrap_or('M');
        if matches!(status, 'R' | 'C') {
            let (Some(old), Some(new)) = (tokens.next(), tokens.next()) else { break };
            files.push(FileChange { path: new.into(), orig_path: Some(old.into()), status: status.to_string() });
        } else if let Some(path) = tokens.next() {
            files.push(FileChange { path: path.into(), orig_path: None, status: status.to_string() });
        }
    }
    files
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

pub fn working_diff(repo: &Path, path: &str, staged: bool, untracked: bool) -> GitResult<String> {
    if untracked {
        // `--no-index` exits with 1 when the files differ, which is always the case here.
        // git treats "/dev/null" specially on every platform, including Windows.
        return run_with(repo, &["diff", "--no-index", "--", "/dev/null", path], None, &[0, 1]);
    }
    let mut args = vec!["diff", "-M"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    run(repo, &args)
}

pub fn commit_file_diff(repo: &Path, sha: &str, path: &str, orig_path: Option<&str>) -> GitResult<String> {
    let parents = run(repo, &["rev-list", "--parents", "-n1", sha])?;
    let first_parent = parents.split_whitespace().nth(1).map(String::from);

    let mut args: Vec<&str> = vec!["diff", "-M"];
    match &first_parent {
        Some(parent) => args.extend([parent.as_str(), sha]),
        // Root commit: compare against the empty tree.
        None => args.extend(["4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha]),
    }
    args.push("--");
    if let Some(orig) = orig_path {
        args.push(orig);
    }
    args.push(path);
    run(repo, &args)
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub sha: String,
    pub current: bool,
    pub upstream: Option<String>,
    /// e.g. "[ahead 1, behind 2]" or "[gone]".
    pub track: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub local: Vec<Branch>,
    pub remote: Vec<Branch>,
    pub tags: Vec<Branch>,
}

pub fn branches(repo: &Path) -> GitResult<Branches> {
    let out = run(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let mut result = Branches::default();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(5, FIELD_SEP).collect();
        if f.len() < 5 {
            continue;
        }
        let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_string());
        let make = |name: &str| Branch {
            name: name.to_string(),
            sha: f[1].to_string(),
            current: f[2] == "*",
            upstream: non_empty(f[3]),
            track: non_empty(f[4]),
        };
        if let Some(n) = f[0].strip_prefix("refs/heads/") {
            result.local.push(make(n));
        } else if let Some(n) = f[0].strip_prefix("refs/remotes/") {
            if !n.ends_with("/HEAD") {
                result.remote.push(make(n));
            }
        } else if let Some(n) = f[0].strip_prefix("refs/tags/") {
            result.tags.push(make(n));
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

pub fn stage(repo: &Path, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(repo, &args).map(drop)
}

pub fn stage_all(repo: &Path) -> GitResult<()> {
    run(repo, &["add", "-A"]).map(drop)
}

pub fn unstage(repo: &Path, paths: &[String]) -> GitResult<()> {
    let mut args = if has_head(repo) { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "--cached", "-q", "-r", "--"] };
    args.extend(paths.iter().map(String::as_str));
    run(repo, &args).map(drop)
}

pub fn unstage_all(repo: &Path) -> GitResult<()> {
    if has_head(repo) {
        run(repo, &["reset", "-q"]).map(drop)
    } else {
        run(repo, &["rm", "--cached", "-q", "-r", "."]).map(drop)
    }
}

pub fn commit(repo: &Path, message: &str, amend: bool) -> GitResult<()> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    run_with(repo, &args, Some(message), &[0]).map(drop)
}

pub fn checkout(repo: &Path, branch: &str) -> GitResult<()> {
    run(repo, &["switch", branch]).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end check against a real repository in a temp dir.
    #[test]
    fn real_repository_roundtrip() {
        let dir = std::env::temp_dir().join(format!("grit-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sh = |args: &[&str]| run(&dir, args).unwrap();
        sh(&["init", "-q", "-b", "main"]);
        sh(&["config", "user.name", "Test"]);
        sh(&["config", "user.email", "test@example.com"]);
        sh(&["config", "commit.gpgsign", "false"]);

        // Unborn branch: status, staging and unstaging must all work before the first commit.
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        assert_eq!(status(&dir).unwrap().unstaged[0].status, "?");
        assert!(log(&dir, 10).unwrap().is_empty());
        stage(&dir, &["a.txt".into()]).unwrap();
        unstage(&dir, &["a.txt".into()]).unwrap();
        assert!(status(&dir).unwrap().staged.is_empty());
        assert!(working_diff(&dir, "a.txt", false, true).unwrap().contains("+one"));
        stage_all(&dir).unwrap();
        commit(&dir, "first", false).unwrap();

        // Feature branch with a rename, merged back into main.
        sh(&["switch", "-q", "-c", "feature"]);
        sh(&["mv", "a.txt", "b.txt"]);
        commit(&dir, "rename", false).unwrap();
        checkout(&dir, "main").unwrap();
        std::fs::write(dir.join("c.txt"), "c\n").unwrap();
        stage_all(&dir).unwrap();
        commit(&dir, "add c", false).unwrap();
        sh(&["merge", "-q", "--no-edit", "feature"]);
        sh(&["tag", "v1"]);

        let entries = log(&dir, 100).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].parents.len(), 2);
        let refs: Vec<_> = entries[0].refs.iter().map(|r| (r.name.as_str(), r.kind.as_str(), r.current)).collect();
        assert!(refs.contains(&("main", "local", true)), "{refs:?}");
        assert!(refs.contains(&("v1", "tag", false)), "{refs:?}");
        assert!(entries.iter().any(|e| e.graph.col == 1), "merge should open a second lane");

        let rename = entries.iter().find(|e| e.subject == "rename").unwrap();
        let details = commit_details(&dir, &rename.sha).unwrap();
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].status, "R");
        assert_eq!(details.files[0].orig_path.as_deref(), Some("a.txt"));
        let d = commit_file_diff(&dir, &rename.sha, "b.txt", Some("a.txt")).unwrap();
        assert!(d.contains("rename from a.txt"), "{d}");
        let root = entries.last().unwrap();
        assert!(commit_file_diff(&dir, &root.sha, "a.txt", None).unwrap().contains("+one"));

        // Staged vs unstaged modifications and amend.
        std::fs::write(dir.join("c.txt"), "c2\n").unwrap();
        stage(&dir, &["c.txt".into()]).unwrap();
        std::fs::write(dir.join("c.txt"), "c3\n").unwrap();
        let st = status(&dir).unwrap();
        assert_eq!((st.staged.len(), st.unstaged.len()), (1, 1));
        assert!(working_diff(&dir, "c.txt", true, false).unwrap().contains("+c2"));
        assert!(working_diff(&dir, "c.txt", false, false).unwrap().contains("+c3"));
        commit(&dir, "amended", true).unwrap();
        assert_eq!(log(&dir, 100).unwrap()[0].subject, "amended");

        let b = branches(&dir).unwrap();
        assert_eq!(b.local.len(), 2);
        assert!(b.local.iter().any(|x| x.name == "main" && x.current));
        assert_eq!(b.tags[0].name, "v1");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_status() {
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 M. N... 100644 100644 100644 a b src/a.rs\0\
1 .M N... 100644 100644 100644 a b src/b file.rs\0\
2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? new dir/x.txt\0";
        let st = parse_status(out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.staged.len(), 2);
        assert_eq!(st.staged[1].path, "new.rs");
        assert_eq!(st.staged[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(st.unstaged.len(), 2);
        assert_eq!(st.unstaged[0].path, "src/b file.rs");
        assert_eq!(st.unstaged[1].status, "?");
        assert_eq!(st.conflicted[0].path, "conflict.txt");
    }

    #[test]
    fn parses_decorations() {
        let refs = parse_decorations("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1");
        let names: Vec<_> = refs.iter().map(|r| (r.name.as_str(), r.kind.as_str(), r.current)).collect();
        assert_eq!(names, vec![("main", "local", true), ("origin/main", "remote", false), ("v1", "tag", false)]);
    }

    #[test]
    fn parses_name_status() {
        let files = parse_name_status("M\0a.rs\0R087\0old.rs\0new.rs\0D\0gone.rs\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[2].status, "D");
    }
}
