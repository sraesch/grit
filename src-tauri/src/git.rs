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
    exec(repo, args, stdin, ok_codes).map(|out| String::from_utf8_lossy(&out).into_owned())
}

/// Runs git and returns its stdout unmodified, for binary content such as images.
fn run_bytes(repo: &Path, args: &[&str]) -> GitResult<Vec<u8>> {
    exec(repo, args, None, &[0])
}

fn exec(repo: &Path, args: &[&str], stdin: Option<&str>, ok_codes: &[i32]) -> GitResult<Vec<u8>> {
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
        Ok(out.stdout)
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
    let out = run(
        repo,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    )?;
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
                let orig_path = if kind == b'2' {
                    entries.next().map(String::from)
                } else {
                    None
                };
                push_xy(&mut st, xy, path, orig_path);
            }
            b'u' => {
                let fields: Vec<&str> = entry.splitn(11, ' ').collect();
                if let Some(path) = fields.get(10) {
                    st.conflicted.push(FileChange {
                        path: path.to_string(),
                        orig_path: None,
                        status: "U".into(),
                    });
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
            orig_path: if matches!(x, b'R' | b'C') {
                orig_path.clone()
            } else {
                None
            },
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
            RefLabel {
                name: "HEAD".into(),
                kind: "head".into(),
                current: true,
            }
        } else if let Some(n) = full.strip_prefix("refs/heads/") {
            RefLabel {
                name: n.into(),
                kind: "local".into(),
                current,
            }
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                continue;
            }
            RefLabel {
                name: n.into(),
                kind: "remote".into(),
                current: false,
            }
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            RefLabel {
                name: n.into(),
                kind: "tag".into(),
                current: false,
            }
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
        &[
            "show",
            "-s",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B",
            sha,
            "--",
        ],
    )?;
    let f: Vec<&str> = out.splitn(9, FIELD_SEP).collect();
    if f.len() < 9 {
        return Err("Unexpected git show output".into());
    }
    let parents: Vec<String> = f[1].split(' ').filter(|p| !p.is_empty()).map(String::from).collect();

    // Merge commits are shown relative to their first parent, like most GUI clients do.
    let files_out = match parents.first() {
        Some(parent) => run(repo, &["diff", "--name-status", "-z", "-M", parent, sha, "--"])?,
        None => run(
            repo,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--name-status",
                "-z",
                "-M",
                sha,
            ],
        )?,
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
            let (Some(old), Some(new)) = (tokens.next(), tokens.next()) else {
                break;
            };
            files.push(FileChange {
                path: new.into(),
                orig_path: Some(old.into()),
                status: status.to_string(),
            });
        } else if let Some(path) = tokens.next() {
            files.push(FileChange {
                path: path.into(),
                orig_path: None,
                status: status.to_string(),
            });
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

/// Contents of `path` (relative to the repository root) as of `rev`, as raw bytes.
/// Files over `max_bytes` are refused, so a huge asset can't flood the UI.
pub fn file_at_revision(repo: &Path, rev: &str, path: &str, max_bytes: u64) -> GitResult<Vec<u8>> {
    // "rev:path" reads the path from the root of rev's tree, independent of the working directory.
    let object = format!("{rev}:{path}");
    let size: u64 = run(repo, &["cat-file", "-s", &object])?
        .trim()
        .parse()
        .map_err(|_| format!("Unexpected size for {object}"))?;
    if size > max_bytes {
        return Err(format!(
            "File is too large to preview ({:.1} MB, limit {:.0} MB)",
            size as f64 / 1_048_576.0,
            max_bytes as f64 / 1_048_576.0
        ));
    }
    run_bytes(repo, &["cat-file", "blob", &object])
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
    let mut args = if has_head(repo) {
        vec!["reset", "-q", "HEAD", "--"]
    } else {
        vec!["rm", "--cached", "-q", "-r", "--"]
    };
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

/// Rejects names git would parse as an option instead of a branch.
fn branch_arg(name: &str) -> GitResult<&str> {
    if name.is_empty() || name.starts_with('-') {
        Err(format!("'{name}' is not a valid branch name"))
    } else {
        Ok(name)
    }
}

/// Switches to an existing local branch. Uncommitted changes are carried over; git refuses
/// (and reports the files) when they would be overwritten.
pub fn checkout(repo: &Path, branch: &str) -> GitResult<()> {
    run(repo, &["switch", branch_arg(branch)?]).map(drop)
}

/// Creates a local branch that tracks `remote_branch` (e.g. "origin/feature" → "feature")
/// and switches to it.
pub fn checkout_remote(repo: &Path, remote_branch: &str) -> GitResult<()> {
    run(repo, &["switch", "--track", branch_arg(remote_branch)?]).map(drop)
}

/// Creates a branch at HEAD and switches to it.
pub fn create_branch(repo: &Path, name: &str) -> GitResult<()> {
    run(repo, &["switch", "-c", branch_arg(name)?]).map(drop)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// A throwaway repository in the system temp dir, removed on drop.
    struct TestRepo {
        dir: PathBuf,
    }

    impl TestRepo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("grit-test-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TestRepo { dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.configure();
            repo
        }

        /// Local config so tests never depend on the machine's global git config.
        fn configure(&self) {
            for (key, value) in [
                ("user.name", "Test"),
                ("user.email", "test@example.com"),
                ("commit.gpgsign", "false"),
                ("tag.gpgsign", "false"),
                ("core.autocrlf", "false"),
                ("core.hooksPath", "/dev/null"),
                ("merge.conflictStyle", "merge"),
            ] {
                self.git(&["config", key, value]);
            }
        }

        fn git(&self, args: &[&str]) -> String {
            run(&self.dir, args).unwrap_or_else(|e| panic!("git {}: {e}", args.join(" ")))
        }

        fn write(&self, path: &str, content: &str) {
            let full = self.dir.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, content).unwrap();
        }

        fn write_bytes(&self, path: &str, content: &[u8]) {
            std::fs::write(self.dir.join(path), content).unwrap();
        }

        fn commit_all(&self, message: &str) -> String {
            stage_all(&self.dir).unwrap();
            commit(&self.dir, message, false).unwrap();
            self.git(&["rev-parse", "HEAD"]).trim().to_string()
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn open_repo_finds_the_root_from_a_subdirectory() {
        let repo = TestRepo::new("open");
        repo.write("nested/deep/file.txt", "x\n");
        let info = open_repo(&repo.dir.join("nested/deep")).unwrap();
        let root = dunce::canonicalize(&info.root).unwrap();
        assert_eq!(root, dunce::canonicalize(&repo.dir).unwrap());
        assert_eq!(info.name, repo.dir.file_name().unwrap().to_string_lossy());
        assert!(info.git_dir.ends_with(".git"));
    }

    #[test]
    fn open_repo_rejects_plain_directories() {
        let dir = std::env::temp_dir().join(format!("grit-test-{}-plain", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Assumes the system temp dir is not itself inside a git repository.
        let err = open_repo(&dir).err();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.unwrap().contains("not inside a git repository"));
    }

    #[test]
    fn unstage_all_works_before_the_first_commit() {
        let repo = TestRepo::new("unborn");
        repo.write("a.txt", "a\n");
        repo.write("dir/b.txt", "b\n");
        stage_all(&repo.dir).unwrap();
        assert_eq!(status(&repo.dir).unwrap().staged.len(), 2);
        unstage_all(&repo.dir).unwrap();
        let st = status(&repo.dir).unwrap();
        assert!(st.staged.is_empty());
        assert_eq!(st.unstaged.len(), 2);
        assert!(branches(&repo.dir).unwrap().local.is_empty());
    }

    #[test]
    fn handles_spaces_and_unicode_in_paths() {
        let repo = TestRepo::new("unicode");
        repo.commit_all_initial();
        let name = "dir with space/ünïcödé 文件.txt";
        repo.write(name, "hello\n");
        let st = status(&repo.dir).unwrap();
        assert_eq!(st.unstaged[0].path, name);
        assert!(working_diff(&repo.dir, name, false, true).unwrap().contains("+hello"));
        stage(&repo.dir, &[name.to_string()]).unwrap();
        let st = status(&repo.dir).unwrap();
        assert_eq!(st.staged[0].path, name);
        assert_eq!(st.staged[0].status, "A");
        let sha = repo.commit_all("unicode");
        assert_eq!(commit_details(&repo.dir, &sha).unwrap().files[0].path, name);
    }

    #[test]
    fn reports_deletions_on_both_sides() {
        let repo = TestRepo::new("delete");
        repo.write("gone.txt", "bye\n");
        repo.commit_all("add");
        std::fs::remove_file(repo.dir.join("gone.txt")).unwrap();
        assert_eq!(status(&repo.dir).unwrap().unstaged[0].status, "D");
        stage(&repo.dir, &["gone.txt".into()]).unwrap();
        let st = status(&repo.dir).unwrap();
        assert_eq!(st.staged[0].status, "D");
        assert!(
            working_diff(&repo.dir, "gone.txt", true, false)
                .unwrap()
                .contains("-bye")
        );
    }

    #[test]
    fn detects_merge_conflicts() {
        let repo = TestRepo::new("conflict");
        repo.write("f.txt", "base\n");
        repo.commit_all("base");
        repo.git(&["switch", "-q", "-c", "other"]);
        repo.write("f.txt", "theirs\n");
        repo.commit_all("theirs");
        checkout(&repo.dir, "main").unwrap();
        repo.write("f.txt", "ours\n");
        repo.commit_all("ours");
        assert!(run(&repo.dir, &["merge", "-q", "other"]).is_err());

        let st = status(&repo.dir).unwrap();
        assert_eq!(st.conflicted.len(), 1);
        assert_eq!(st.conflicted[0].path, "f.txt");
        assert!(
            working_diff(&repo.dir, "f.txt", false, false)
                .unwrap()
                .contains("<<<<<<<")
        );

        // Resolving and staging moves the file out of the conflict list.
        repo.write("f.txt", "resolved\n");
        stage(&repo.dir, &["f.txt".into()]).unwrap();
        let st = status(&repo.dir).unwrap();
        assert!(st.conflicted.is_empty());
        assert_eq!(st.staged.len(), 1);
    }

    #[test]
    fn shows_detached_head() {
        let repo = TestRepo::new("detached");
        let first = repo.commit_all_initial();
        repo.write("b.txt", "b\n");
        repo.commit_all("second");
        repo.git(&["switch", "-q", "--detach", &first]);

        let st = status(&repo.dir).unwrap();
        assert_eq!(st.branch, None);
        let entries = log(&repo.dir, 10).unwrap();
        // Both commits stay visible because the branch still points at the second one.
        assert_eq!(entries.len(), 2);
        let head = entries.iter().find(|e| e.sha == first).unwrap();
        assert!(head.refs.iter().any(|r| r.kind == "head" && r.current));
        assert!(entries[0].refs.iter().any(|r| r.name == "main" && !r.current));
    }

    #[test]
    fn tracks_upstream_ahead_and_behind() {
        let origin = TestRepo::new("origin");
        origin.commit_all_initial();
        let clone_dir = std::env::temp_dir().join(format!("grit-test-{}-clone", std::process::id()));
        let _ = std::fs::remove_dir_all(&clone_dir);
        run(
            &std::env::temp_dir(),
            &[
                "clone",
                "-q",
                &origin.dir.to_string_lossy(),
                &clone_dir.to_string_lossy(),
            ],
        )
        .unwrap();
        let clone = TestRepo { dir: clone_dir };
        clone.configure();

        clone.write("local.txt", "l\n");
        clone.commit_all("local");
        origin.write("remote.txt", "r\n");
        origin.commit_all("remote");
        clone.git(&["fetch", "-q"]);

        let st = status(&clone.dir).unwrap();
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (1, 1));
        let b = branches(&clone.dir).unwrap();
        assert_eq!(b.local[0].track.as_deref(), Some("[ahead 1, behind 1]"));
        assert!(b.remote.iter().any(|r| r.name == "origin/main"));
        assert!(b.remote.iter().all(|r| !r.name.ends_with("/HEAD")));
        // History includes the fetched remote commit.
        let subjects: Vec<_> = log(&clone.dir, 10).unwrap().into_iter().map(|e| e.subject).collect();
        assert!(subjects.contains(&"remote".to_string()), "{subjects:?}");
    }

    #[test]
    fn surfaces_git_errors() {
        let repo = TestRepo::new("errors");
        repo.commit_all_initial();
        assert!(checkout(&repo.dir, "does-not-exist").is_err());
        let err = commit(&repo.dir, "nothing staged", false).unwrap_err();
        assert!(!err.is_empty());
        assert!(commit_details(&repo.dir, "0000000000000000000000000000000000000000").is_err());
    }

    impl TestRepo {
        fn commit_all_initial(&self) -> String {
            self.write("README.md", "# test\n");
            self.commit_all("initial")
        }
    }

    /// End-to-end check against a real repository in a temp dir.
    #[test]
    fn real_repository_roundtrip() {
        let repo = TestRepo::new("roundtrip");
        let dir = repo.dir.clone();
        let sh = |args: &[&str]| repo.git(args);

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
        let refs: Vec<_> = entries[0]
            .refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str(), r.current))
            .collect();
        assert!(refs.contains(&("main", "local", true)), "{refs:?}");
        assert!(refs.contains(&("v1", "tag", false)), "{refs:?}");
        assert!(
            entries.iter().any(|e| e.graph.col == 1),
            "merge should open a second lane"
        );

        let rename = entries.iter().find(|e| e.subject == "rename").unwrap();
        let details = commit_details(&dir, &rename.sha).unwrap();
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].status, "R");
        assert_eq!(details.files[0].orig_path.as_deref(), Some("a.txt"));
        let d = commit_file_diff(&dir, &rename.sha, "b.txt", Some("a.txt")).unwrap();
        assert!(d.contains("rename from a.txt"), "{d}");
        let root = entries.last().unwrap();
        assert!(
            commit_file_diff(&dir, &root.sha, "a.txt", None)
                .unwrap()
                .contains("+one")
        );

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
    }

    #[test]
    fn switches_creates_and_tracks_branches() {
        let origin = TestRepo::new("switch-origin");
        origin.write("a.txt", "main\n");
        origin.commit_all("first");
        origin.git(&["branch", "feature/remote"]);

        let clone = TestRepo {
            dir: std::env::temp_dir().join(format!("grit-test-{}-switch-clone", std::process::id())),
        };
        let _ = std::fs::remove_dir_all(&clone.dir);
        origin.git(&["clone", "-q", origin.dir.to_str().unwrap(), clone.dir.to_str().unwrap()]);
        clone.configure();

        // A remote branch becomes a local branch with the remote's name, tracking it.
        checkout_remote(&clone.dir, "origin/feature/remote").unwrap();
        let b = branches(&clone.dir).unwrap();
        let local = b.local.iter().find(|x| x.name == "feature/remote").unwrap();
        assert!(local.current);
        assert_eq!(local.upstream.as_deref(), Some("origin/feature/remote"));

        create_branch(&clone.dir, "topic").unwrap();
        assert_eq!(status(&clone.dir).unwrap().branch.as_deref(), Some("topic"));
        assert!(
            create_branch(&clone.dir, "topic")
                .unwrap_err()
                .contains("already exists")
        );
        assert!(create_branch(&clone.dir, "bad..name").is_err());

        checkout(&clone.dir, "main").unwrap();
        assert_eq!(status(&clone.dir).unwrap().branch.as_deref(), Some("main"));

        // Names that look like options are refused before git sees them.
        for name in ["-f", "--orphan", ""] {
            assert!(
                checkout(&clone.dir, name)
                    .unwrap_err()
                    .contains("not a valid branch name")
            );
            assert!(create_branch(&clone.dir, name).is_err());
            assert!(checkout_remote(&clone.dir, name).is_err());
        }
    }

    #[test]
    fn refuses_to_switch_when_local_changes_would_be_lost() {
        let repo = TestRepo::new("switch-dirty");
        repo.write("a.txt", "one\n");
        repo.commit_all("first");
        repo.git(&["switch", "-q", "-c", "other"]);
        repo.write("a.txt", "two\n");
        repo.commit_all("change on other");
        repo.write("a.txt", "uncommitted\n");

        let err = checkout(&repo.dir, "main").unwrap_err();
        assert!(err.contains("a.txt"), "{err}");
        assert_eq!(status(&repo.dir).unwrap().branch.as_deref(), Some("other"));
    }

    #[test]
    fn reads_binary_files_at_a_revision() {
        let repo = TestRepo::new("blob");
        // Not valid UTF-8: must come back byte for byte, without lossy conversion.
        let v1 = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
        repo.write_bytes("logo.png", &v1);
        repo.write("dir/a b.svg", "<svg/>");
        let first = repo.commit_all("add images");
        repo.write_bytes("logo.png", b"second");
        let second = repo.commit_all("change logo");

        assert_eq!(file_at_revision(&repo.dir, &first, "logo.png", 1024).unwrap(), v1);
        assert_eq!(
            file_at_revision(&repo.dir, &second, "logo.png", 1024).unwrap(),
            b"second"
        );
        assert_eq!(
            file_at_revision(&repo.dir, &second, "dir/a b.svg", 1024).unwrap(),
            b"<svg/>"
        );

        let too_large = file_at_revision(&repo.dir, &first, "logo.png", 4).unwrap_err();
        assert!(too_large.contains("too large"), "{too_large}");
        assert!(file_at_revision(&repo.dir, &first, "missing.png", 1024).is_err());
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
        let refs = parse_decorations(
            "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1",
        );
        let names: Vec<_> = refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str(), r.current))
            .collect();
        assert_eq!(
            names,
            vec![
                ("main", "local", true),
                ("origin/main", "remote", false),
                ("v1", "tag", false)
            ]
        );
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
