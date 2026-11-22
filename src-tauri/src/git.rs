//! Thin wrapper around the `git` executable.
//!
//! Every operation shells out to the user's installed git so that hooks, credential
//! helpers, SSH config, signing and `.gitconfig` behave exactly as on the command line.
//! Read-heavy paths can later move to an in-process library (gix) where it pays off.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::graph::{self, GraphRow};
use crate::patch::{self, HunkSelection};

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
    exec(repo, args, stdin.map(str::as_bytes), ok_codes).map(|out| String::from_utf8_lossy(&out).into_owned())
}

/// Runs git and returns its stdout unmodified, for binary content such as images.
fn run_bytes(repo: &Path, args: &[&str]) -> GitResult<Vec<u8>> {
    exec(repo, args, None, &[0])
}

fn exec(repo: &Path, args: &[&str], stdin: Option<&[u8]>, ok_codes: &[i32]) -> GitResult<Vec<u8>> {
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
            .write_all(input)
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
    let out = run(path, &["rev-parse", "--show-toplevel", "--absolute-git-dir"]).map_err(|_| {
        if is_bare(path) {
            format!(
                "{} is a bare repository, which has no working tree to show. Clone it to work with it.",
                path.display()
            )
        } else {
            format!("{} is not inside a git repository", path.display())
        }
    })?;
    let mut lines = out.lines();
    let root = lines.next().ok_or("Unexpected rev-parse output")?.to_string();
    let git_dir = lines.next().ok_or("Unexpected rev-parse output")?.to_string();
    let name = Path::new(&root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    Ok(RepoInfo { root, git_dir, name })
}

/// Whether `path` is an existing folder inside a repository, bare ones included. Such a folder must
/// never be offered for `init_repo`, even when `open_repo` can't open it (a bare repository).
pub fn is_repository(path: &Path) -> bool {
    path.is_dir() && run(path, &["rev-parse", "--git-dir"]).is_ok()
}

/// Whether `path` is inside a bare repository, which has no working tree.
fn is_bare(path: &Path) -> bool {
    path.is_dir() && run(path, &["rev-parse", "--is-bare-repository"]).is_ok_and(|out| out.trim() == "true")
}

/// The branch name `git init` starts with: `init.defaultBranch` from the user's config, else "main".
pub fn default_branch_name() -> String {
    let home = std::env::temp_dir();
    run(&home, &["config", "--global", "--get", "init.defaultBranch"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

/// Checks that `name` can be a branch name, with git's own rules.
fn valid_branch_name(name: &str) -> GitResult<()> {
    branch_arg(name)?;
    run(&std::env::temp_dir(), &["check-ref-format", "--branch", name])
        .map(drop)
        .map_err(|_| format!("'{name}' is not a valid branch name"))
}

/// Creates a repository in `path` (created if missing) whose first branch is `branch`.
pub fn init_repo(path: &Path, branch: &str) -> GitResult<RepoInfo> {
    valid_branch_name(branch)?;
    if path.join(".git").exists() {
        return Err(format!("{} is already a git repository", path.display()));
    }
    // `git init` in a bare repository would hide it behind a new, empty repository.
    if is_bare(path) {
        return Err(format!("{} is inside a bare repository", path.display()));
    }
    if path.exists() && !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    std::fs::create_dir_all(path).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
    run(path, &["init", "-q"])?;
    // Instead of `git init -b`, which needs git 2.28.
    run(path, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
    open_repo(path)
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
    /// A merge, rebase, cherry-pick or revert that stopped (usually on conflicts) and waits
    /// to be continued or aborted.
    pub operation: Option<Operation>,
    /// When the repository was last fetched (unix seconds), from the time of `FETCH_HEAD`.
    pub last_fetch: Option<i64>,
}

pub fn status(repo: &Path) -> GitResult<Status> {
    let out = run(
        repo,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    )?;
    let mut st = parse_status(&out);
    let git_dir = git_dir(repo)?;
    st.operation = operation(&git_dir);
    st.last_fetch = modified_secs(&git_dir.join("FETCH_HEAD"));
    Ok(st)
}

/// The git directory of the worktree at `repo` (per-worktree state such as `MERGE_HEAD` lives here).
fn git_dir(repo: &Path) -> GitResult<PathBuf> {
    Ok(PathBuf::from(
        run(repo, &["rev-parse", "--absolute-git-dir"])?.trim_end(),
    ))
}

fn modified_secs(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
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

/// Git LFS pointer files are always smaller than this, per the LFS specification.
const LFS_POINTER_MAX_BYTES: u64 = 1024;

/// Contents of `path` (relative to the repository root) as of `rev`, as raw bytes.
/// Files over `max_bytes` are refused, so a huge asset can't flood the UI.
///
/// Files stored in Git LFS are committed as a small pointer; for those the real content
/// is returned, which Git LFS may have to download first.
pub fn file_at_revision(repo: &Path, rev: &str, path: &str, max_bytes: u64) -> GitResult<Vec<u8>> {
    // "rev:path" reads the path from the root of rev's tree, independent of the working directory.
    let object = format!("{rev}:{path}");
    let size: u64 = run(repo, &["cat-file", "-s", &object])?
        .trim()
        .parse()
        .map_err(|_| format!("Unexpected size for {object}"))?;
    if size >= LFS_POINTER_MAX_BYTES {
        check_preview_size(size, max_bytes)?;
        return run_bytes(repo, &["cat-file", "blob", &object]);
    }

    let blob = run_bytes(repo, &["cat-file", "blob", &object])?;
    let Some(lfs_size) = lfs_pointer_size(&blob) else {
        check_preview_size(size, max_bytes)?;
        return Ok(blob);
    };
    check_preview_size(lfs_size, max_bytes)?;
    // `--filters` runs the smudge filter that the path's attributes name (`filter=lfs`, set up by
    // `git lfs track`), which turns the pointer back into the file, as a checkout would.
    let content = run_bytes(repo, &["cat-file", "--filters", &object])?;
    if lfs_pointer_size(&content).is_some() {
        return Err(
            "This file is stored in Git LFS, which didn't provide its content. Is Git LFS installed (git lfs install)?"
                .into(),
        );
    }
    Ok(content)
}

fn check_preview_size(size: u64, max_bytes: u64) -> GitResult<()> {
    if size > max_bytes {
        return Err(format!(
            "File is too large to preview ({:.1} MB, limit {:.0} MB)",
            size as f64 / 1_048_576.0,
            max_bytes as f64 / 1_048_576.0
        ));
    }
    Ok(())
}

/// The size of the real file if `blob` is a Git LFS pointer, which looks like:
///
/// ```text
/// version https://git-lfs.github.com/spec/v1
/// oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
/// size 12345
/// ```
fn lfs_pointer_size(blob: &[u8]) -> Option<u64> {
    if blob.len() as u64 >= LFS_POINTER_MAX_BYTES {
        return None;
    }
    let text = std::str::from_utf8(blob).ok()?;
    let mut lines = text.lines();
    let version = lines.next()?.strip_prefix("version ")?;
    // "hawser" is an early name of Git LFS; Git LFS still reads pointers that use it.
    if version != "https://git-lfs.github.com/spec/v1" && version != "https://hawser.github.com/spec/v1" {
        return None;
    }
    let (mut oid, mut size) = (false, None);
    for line in lines {
        if line.starts_with("oid sha256:") {
            oid = true;
        } else if let Some(value) = line.strip_prefix("size ") {
            size = value.parse().ok();
        }
    }
    size.filter(|_| oid)
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
    pub remotes: Vec<Remote>,
    /// The branch checked out before the current one (`@{-1}`), if it still exists.
    pub previous: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    /// The fetch URL.
    pub url: String,
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
    result.remotes = remotes(repo)?;
    result.previous = run(repo, &["rev-parse", "--abbrev-ref", "@{-1}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|name| result.local.iter().any(|b| &b.name == name));
    Ok(result)
}

pub fn remotes(repo: &Path) -> GitResult<Vec<Remote>> {
    Ok(parse_remotes(&run(repo, &["remote", "-v"])?))
}

/// Parses `git remote -v`: `origin\thttps://host/repo.git (fetch)`, one fetch and one push line per remote.
fn parse_remotes(out: &str) -> Vec<Remote> {
    out.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once('\t')?;
            let url = rest.strip_suffix(" (fetch)")?;
            Some(Remote {
                name: name.to_string(),
                url: url.to_string(),
            })
        })
        .collect()
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

/// Throws away local changes: `tracked` files get their unstaged changes reverted to the
/// staged (or committed) version, staged changes stay; `untracked` files are deleted, along
/// with folders they leave empty. Paths are taken literally, never as glob patterns.
pub fn discard(repo: &Path, tracked: &[String], untracked: &[String]) -> GitResult<()> {
    if !tracked.is_empty() {
        let mut args = vec!["--literal-pathspecs", "restore", "--worktree", "--"];
        args.extend(tracked.iter().map(String::as_str));
        run(repo, &args)?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["--literal-pathspecs", "clean", "-f", "-q", "--"];
        args.extend(untracked.iter().map(String::as_str));
        run(repo, &args)?;
        remove_empty_parents(repo, untracked);
    }
    Ok(())
}

/// What to do with the selected parts of a diff.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PatchAction {
    /// Unstaged changes into the index.
    Stage,
    /// Staged changes out of the index.
    Unstage,
    /// Unstaged changes out of the working tree.
    Discard,
}

/// Diffs with more lines than this aren't shown in full, so parts of them can't be selected.
const MAX_PATCH_LINES: usize = 5000;

/// Stages, unstages or discards the selected hunks or lines of one file's diff.
///
/// The diff is generated again, exactly as `working_diff` shows it, and the selection is checked
/// against it, so a file that changed since it was shown is refused instead of patched wrongly.
/// An untracked file is first added with intent to add (`git add -N`), so it has a diff to take
/// parts of; after a discard, or if anything fails, it is untracked again.
pub fn apply_selection(
    repo: &Path,
    path: &str,
    staged: bool,
    untracked: bool,
    action: PatchAction,
    selection: &[HunkSelection],
) -> GitResult<()> {
    if staged != (action == PatchAction::Unstage) {
        return Err("Only staged changes can be unstaged, and only unstaged ones staged or discarded".into());
    }
    let intent_to_add = untracked && !staged;
    if intent_to_add {
        run(repo, &["--literal-pathspecs", "add", "-N", "--", path])?;
    }
    let result = apply_selection_to_diff(repo, path, staged, action, selection);
    if intent_to_add && (result.is_err() || action == PatchAction::Discard) {
        // Takes back the intent to add; what is left of the file is untracked again.
        let _ = run(repo, &["--literal-pathspecs", "rm", "--cached", "-q", "--", path]);
    }
    result
}

fn apply_selection_to_diff(
    repo: &Path,
    path: &str,
    staged: bool,
    action: PatchAction,
    selection: &[HunkSelection],
) -> GitResult<()> {
    let mut args = vec!["--literal-pathspecs", "diff", "-M"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let diff = exec(repo, &args, None, &[0])?;
    let parsed = patch::parse(&diff)?;
    if parsed.hunks.is_empty() {
        return Err(patch::STALE.into());
    }
    if patch::shown_lines(&parsed) > MAX_PATCH_LINES {
        return Err("The diff is too large to stage parts of it".into());
    }
    let reverse = action != PatchAction::Stage;
    let Some(built) = patch::build(&parsed, selection, reverse)? else {
        return Ok(());
    };
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if action != PatchAction::Discard {
        args.push("--cached");
    }
    if reverse {
        args.push("-R");
    }
    // Only a diff without context (diff.context=0) produces hunks git would otherwise refuse.
    if !built.split(|&b| b == b'\n').any(|l| l.first() == Some(&b' ')) {
        args.push("--unidiff-zero");
    }
    args.push("-");
    exec(repo, &args, Some(&built), &[0]).map(drop)
}

/// Appends `pattern` as a line to the `.gitignore` in the repository root, creating the file
/// if needed. A pattern that is already listed is not added again. Keeps the file's line
/// endings (LF or CRLF).
pub fn add_to_gitignore(repo: &Path, pattern: &str) -> GitResult<()> {
    if pattern.trim().is_empty() {
        return Err("The pattern is empty".into());
    }
    if pattern.contains(['\n', '\r']) {
        return Err("The pattern must be a single line".into());
    }
    let path = repo.join(".gitignore");
    let existing = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Could not read .gitignore: {e}")),
    };
    if existing.lines().any(|line| line.trim_end_matches('\r') == pattern) {
        return Ok(());
    }
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        addition.push_str(newline);
    }
    addition.push_str(pattern);
    addition.push_str(newline);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Could not write .gitignore: {e}"))?;
    file.write_all(addition.as_bytes())
        .map_err(|e| format!("Could not write .gitignore: {e}"))
}

/// Removes the folders that deleting `paths` left empty, up to (not including) the repository root.
fn remove_empty_parents(repo: &Path, paths: &[String]) {
    for path in paths {
        let mut dir = Path::new(path).parent();
        while let Some(d) = dir.filter(|d| !d.as_os_str().is_empty()) {
            // Fails, and stops the walk, as soon as a folder still has something in it.
            if std::fs::remove_dir(repo.join(d)).is_err() {
                break;
            }
            dir = d.parent();
        }
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

/// Checks out a commit without a branch (detached HEAD). Like switching branches, uncommitted
/// changes are carried over and git refuses when they would be overwritten.
pub fn checkout_commit(repo: &Path, sha: &str) -> GitResult<()> {
    let sha = plain_arg(sha, "commit")?;
    run(repo, &["switch", "--detach", &format!("{sha}^{{commit}}")]).map(drop)
}

/// Creates a branch at HEAD and switches to it.
pub fn create_branch(repo: &Path, name: &str) -> GitResult<()> {
    run(repo, &["switch", "-c", branch_arg(name)?]).map(drop)
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum DeleteBranchOutcome {
    Deleted,
    /// Nothing was deleted because the branch has commits that aren't merged; deleting it needs
    /// `force`. Merged means into its upstream (or HEAD when it has none), as `git branch -d`
    /// checks, and into HEAD when the remote branch is deleted too, since the upstream goes away.
    NotMerged,
}

/// The remote branch a local branch tracks: the remote, the branch's ref there and the
/// remote-tracking ref, e.g. ("origin", "refs/heads/feature", "refs/remotes/origin/feature").
fn upstream_of(repo: &Path, local_ref: &str) -> Option<(String, String, String)> {
    let out = run(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream:remotename)%1f%(upstream:remoteref)%1f%(upstream)",
            local_ref,
        ],
    )
    .ok()?;
    let mut f = out.trim_end().splitn(3, FIELD_SEP).map(str::to_string);
    let (remote, remote_ref, tracking) = (f.next()?, f.next()?, f.next()?);
    // "." is a local upstream, not a remote; a missing tracking ref means the branch is gone.
    let valid = !remote.is_empty() && remote != "." && remote_ref.starts_with("refs/heads/");
    (valid && rev(repo, &tracking).is_some()).then_some((remote, remote_ref, tracking))
}

/// Deletes a local branch and, with `delete_remote`, the remote branch it tracks.
///
/// Without `force`, a branch with unmerged commits is kept and reported as `NotMerged`. git
/// refuses to delete the branch that is checked out, here or in another worktree. The remote
/// branch is deleted first, so nothing changes when that fails. It is only deleted if it still
/// points where it was last fetched (`--force-with-lease`), so commits pushed by others since are
/// never lost, even with `force`.
pub fn delete_branch(
    repo: &Path,
    name: &str,
    force: bool,
    delete_remote: bool,
    on_progress: &mut dyn FnMut(&str),
) -> GitResult<DeleteBranchOutcome> {
    let name = branch_arg(name)?;
    let local_ref = format!("refs/heads/{name}");
    if rev(repo, &local_ref).is_none() {
        return Err(format!("There is no local branch '{name}'"));
    }
    if !delete_remote {
        let flag = if force { "-D" } else { "-d" };
        // Untranslated messages, so the refusal can be recognized.
        return match exec_with_env(repo, &["branch", flag, name], &[("LC_ALL", "C")]) {
            Ok(_) => Ok(DeleteBranchOutcome::Deleted),
            Err(e) if !force && e.contains("not fully merged") => Ok(DeleteBranchOutcome::NotMerged),
            Err(e) => Err(e),
        };
    }

    let (remote, remote_ref, tracking) =
        upstream_of(repo, &local_ref).ok_or_else(|| format!("'{name}' doesn't track a remote branch to delete"))?;
    if status(repo)?.branch.as_deref() == Some(name) {
        return Err(format!(
            "Cannot delete '{name}' while it is checked out. Switch to another branch first."
        ));
    }
    if !force && !(is_ancestor(repo, &local_ref, "HEAD") && is_ancestor(repo, &tracking, "HEAD")) {
        return Ok(DeleteBranchOutcome::NotMerged);
    }

    let remote_name = tracking.strip_prefix("refs/remotes/").unwrap_or(&tracking).to_string();
    let lease = format!("--force-with-lease={remote_ref}");
    let out = exec_streaming(
        repo,
        &[
            "push",
            "--progress",
            "--porcelain",
            &lease,
            &remote,
            "--delete",
            &remote_ref,
        ],
        &[("LC_ALL", "C")],
        on_progress,
    )?;
    let refs = parse_push_porcelain(&out.stdout);
    match refs.iter().find(|r| r.dst == remote_ref) {
        Some(r) if r.flag == '-' => {}
        // The lease also fails when the branch is gone from the remote already: then there is
        // nothing left to delete but the stale remote-tracking ref.
        Some(r) if r.summary.contains("stale info") => {
            let listed = run(repo, &["ls-remote", "--heads", &remote, &remote_ref])?;
            if !listed.trim().is_empty() {
                return Err(format!(
                    "{remote_name} has commits that were pushed since it was last fetched, so nothing was deleted. \
                     Fetch to see them."
                ));
            }
            run(repo, &["update-ref", "-d", &tracking])?;
        }
        _ => return Err(error_text(&out.stderr, &format!("Deleting {remote_name} failed"))),
    }

    // Unmerged commits were checked (or forced) above.
    run(repo, &["branch", "-D", name])
        .map_err(|e| format!("Deleted {remote_name}, but not the local branch '{name}': {e}"))?;
    Ok(DeleteBranchOutcome::Deleted)
}

// ---------------------------------------------------------------------------
// Stashes
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// Position in the stash list: 0 is the newest, `stash@{0}`.
    pub index: usize,
    /// The stash commit. Unlike the index it doesn't change when other stashes are added or deleted.
    pub sha: String,
    /// The message given when stashing, or git's "WIP on main: abc1234 subject" without one.
    pub message: String,
    /// The branch that was checked out when stashing; None for a detached HEAD.
    pub branch: Option<String>,
    pub time: i64,
    /// Untracked files were stashed too; they are in the stash commit's third parent.
    pub untracked: bool,
}

pub fn stashes(repo: &Path) -> GitResult<Vec<Stash>> {
    let out = run(repo, &["stash", "list", "--format=%H%x1f%P%x1f%ct%x1f%gs"])?;
    Ok(parse_stashes(&out))
}

fn parse_stashes(out: &str) -> Vec<Stash> {
    let mut list = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(4, FIELD_SEP).collect();
        let [sha, parents, time, subject] = f.as_slice() else {
            continue;
        };
        // "On main: message" with a message, "WIP on main: abc1234 subject" without one;
        // "(no branch)" for a detached HEAD.
        let (custom, rest) = match subject.strip_prefix("On ") {
            Some(rest) => (true, rest),
            None => (false, subject.strip_prefix("WIP on ").unwrap_or(subject)),
        };
        let (branch, text) = rest.split_once(": ").unwrap_or(("", rest));
        list.push(Stash {
            index: list.len(),
            sha: sha.to_string(),
            message: if custom { text } else { subject }.to_string(),
            branch: (!branch.is_empty() && branch != "(no branch)").then(|| branch.to_string()),
            time: time.parse().unwrap_or(0),
            untracked: parents.split(' ').filter(|p| !p.is_empty()).count() >= 3,
        });
    }
    list
}

/// The stash with commit `sha`, so actions keep their target when the list changed meanwhile.
fn find_stash(repo: &Path, sha: &str) -> GitResult<Stash> {
    stashes(repo)?
        .into_iter()
        .find(|s| s.sha == sha)
        .ok_or_else(|| "This stash doesn't exist anymore. It may have been applied or deleted elsewhere.".into())
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StashOptions {
    /// Empty for git's default "WIP on <branch>: <commit>".
    pub message: String,
    pub include_untracked: bool,
    /// Leave the staged changes in place (and in the stash).
    pub keep_index: bool,
}

/// Stashes the local changes and reverts them, like `git stash push`; returns the new stash.
pub fn stash_push(repo: &Path, opts: &StashOptions) -> GitResult<Stash> {
    let before = rev(repo, "refs/stash");
    let mut args = vec!["stash", "push"];
    let message = opts.message.trim();
    if !message.is_empty() {
        args.extend(["-m", message]);
    }
    if opts.include_untracked {
        args.push("--include-untracked");
    }
    if opts.keep_index {
        args.push("--keep-index");
    }
    run(repo, &args)?;
    // git succeeds without doing anything when there is nothing to stash.
    if rev(repo, "refs/stash") == before {
        return Err(if opts.include_untracked {
            "There are no local changes to stash.".into()
        } else {
            "There are no changes to tracked files to stash. Include untracked files to stash new files.".into()
        });
    }
    stashes(repo)?
        .into_iter()
        .next()
        .ok_or_else(|| "The stash wasn't saved".into())
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum StashApplyOutcome {
    Applied,
    /// Applied, but some files have conflicts to resolve; the stash is kept, even when popping.
    Conflicts,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyResult {
    pub outcome: StashApplyOutcome,
    /// Files with conflicts.
    pub conflicts: u32,
}

/// Applies the stash with commit `sha` to the working tree and, with `pop`, deletes it once it
/// applied cleanly. git refuses (and reports the files) when local changes would be overwritten.
pub fn stash_apply(repo: &Path, sha: &str, pop: bool) -> GitResult<StashApplyResult> {
    let stash = find_stash(repo, plain_arg(sha, "stash")?)?;
    // Untranslated messages, as other git errors are passed on as they are.
    if let Err(e) = exec_with_env(repo, &["stash", "apply", &stash.sha], &[("LC_ALL", "C")]) {
        let conflicts = status(repo)?.conflicted.len() as u32;
        if conflicts == 0 {
            return Err(e);
        }
        return Ok(StashApplyResult {
            outcome: StashApplyOutcome::Conflicts,
            conflicts,
        });
    }
    if pop {
        stash_drop(repo, &stash.sha)?;
    }
    Ok(StashApplyResult {
        outcome: StashApplyOutcome::Applied,
        conflicts: 0,
    })
}

/// Deletes the stash with commit `sha`. Its commit stays in the repository until git cleans up,
/// so `git stash apply <sha>` still brings it back for a while.
pub fn stash_drop(repo: &Path, sha: &str) -> GitResult<()> {
    let stash = find_stash(repo, plain_arg(sha, "stash")?)?;
    run(repo, &["stash", "drop", "-q", &format!("stash@{{{}}}", stash.index)]).map(drop)
}

// ---------------------------------------------------------------------------
// Fetch and pull
// ---------------------------------------------------------------------------

/// Output of a git command that talks to a remote. The exit code is returned rather than
/// turned into an error, because a failed pull can still leave a state to report (conflicts).
struct NetOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Runs git with `--progress` output streamed to `on_progress`, one line (or `\r`-separated
/// update) at a time, e.g. "Receiving objects:  45% (450/1000)".
fn exec_streaming(
    repo: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    on_progress: &mut dyn FnMut(&str),
) -> GitResult<NetOutput> {
    let mut cmd = git_command(repo);
    cmd.args(args)
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start git: {e}"))?;

    // Drain stdout on its own thread so a chatty merge can't fill the pipe and block git
    // while we are reading stderr. Push reports its result there.
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let stdout_reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });

    let mut stderr = child.stderr.take().expect("stderr is piped");
    let mut all = Vec::new();
    let mut line = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        all.extend_from_slice(&buf[..n]);
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                emit_line(&mut line, on_progress);
            } else {
                line.push(b);
            }
        }
    }
    emit_line(&mut line, on_progress);

    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = stdout_reader.join().unwrap_or_default();
    Ok(NetOutput {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&all).into_owned(),
    })
}

fn emit_line(line: &mut Vec<u8>, on_progress: &mut dyn FnMut(&str)) {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if !text.is_empty() {
        on_progress(text);
    }
    line.clear();
}

/// Turns git's stderr into a readable error: progress updates are dropped and only the final
/// state of each `\r`-overwritten line is kept.
fn error_text(stderr: &str, fallback: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .filter_map(|l| l.rsplit('\r').map(str::trim_end).find(|s| !s.trim().is_empty()))
        .filter(|l| !is_progress(l))
        .collect();
    if lines.is_empty() {
        fallback.to_string()
    } else {
        lines.join("\n")
    }
}

fn is_progress(line: &str) -> bool {
    let l = line.trim_start();
    let l = l.strip_prefix("remote:").map(str::trim_start).unwrap_or(l);
    const PHASES: [&str; 11] = [
        "Enumerating objects",
        "Counting objects",
        "Compressing objects",
        "Receiving objects",
        "Resolving deltas",
        "Unpacking objects",
        "Writing objects",
        "Updating files",
        "Checking out files",
        "Total ",
        // A rebase's "Rebasing (2/5)".
        "Rebasing (",
    ];
    PHASES.iter().any(|p| l.starts_with(p)) || (l.contains("% (") && l.contains(')'))
}

/// Environment for network commands. Background fetches must never pop up a prompt: ssh runs
/// in batch mode (unless the user configured their own ssh command) and Git Credential Manager
/// stays non-interactive. Credential helpers and ssh agents still work.
fn network_env(repo: &Path, background: bool) -> Vec<(&'static str, &'static str)> {
    if !background {
        return Vec::new();
    }
    let mut env = vec![("GCM_INTERACTIVE", "never"), ("SSH_ASKPASS_REQUIRE", "never")];
    let custom_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || run_with(repo, &["config", "--get", "core.sshCommand"], None, &[0, 1]).is_ok_and(|v| !v.trim().is_empty());
    if !custom_ssh {
        env.push(("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"));
    }
    env
}

/// Rejects arguments git would parse as an option, e.g. a remote named "--upload-pack=…".
fn plain_arg<'a>(value: &'a str, what: &str) -> GitResult<&'a str> {
    if value.is_empty() || value.starts_with('-') {
        Err(format!("'{value}' is not a valid {what}"))
    } else {
        Ok(value)
    }
}

/// Remote-tracking branches and tags with the commit each points at.
fn remote_refs(repo: &Path) -> GitResult<HashMap<String, String>> {
    let out = run(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once(FIELD_SEP))
        .filter(|(name, _)| !name.ends_with("/HEAD"))
        .map(|(name, sha)| (name.to_string(), sha.to_string()))
        .collect())
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    /// Remote branches that appeared, e.g. "origin/feature".
    pub new_branches: Vec<String>,
    /// Remote branches that moved.
    pub updated_branches: Vec<String>,
    /// Remote branches removed by pruning.
    pub deleted_branches: Vec<String>,
    pub new_tags: Vec<String>,
}

impl FetchResult {
    /// What changed between two snapshots of `remote_refs`. Comparing refs instead of parsing
    /// git's output keeps this independent of git's version and language.
    fn diff(before: &HashMap<String, String>, after: &HashMap<String, String>) -> Self {
        let mut result = FetchResult::default();
        for (name, sha) in after {
            if let Some(branch) = name.strip_prefix("refs/remotes/") {
                match before.get(name) {
                    None => result.new_branches.push(branch.to_string()),
                    Some(old) if old != sha => result.updated_branches.push(branch.to_string()),
                    Some(_) => {}
                }
            } else if let Some(tag) = name.strip_prefix("refs/tags/")
                && !before.contains_key(name)
            {
                result.new_tags.push(tag.to_string());
            }
        }
        for name in before.keys() {
            if let Some(branch) = name.strip_prefix("refs/remotes/")
                && !after.contains_key(name)
            {
                result.deleted_branches.push(branch.to_string());
            }
        }
        for list in [
            &mut result.new_branches,
            &mut result.updated_branches,
            &mut result.deleted_branches,
            &mut result.new_tags,
        ] {
            list.sort();
        }
        result
    }
}

#[derive(Default)]
pub struct FetchOptions {
    /// `None` fetches every remote.
    pub remote: Option<String>,
    /// Remove remote-tracking branches whose branch was deleted on the remote.
    pub prune: bool,
    /// Fetch all tags, not only those pointing into fetched history.
    pub tags: bool,
    /// An automatic fetch: never prompt for credentials.
    pub background: bool,
}

pub fn fetch(repo: &Path, opts: &FetchOptions, on_progress: &mut dyn FnMut(&str)) -> GitResult<FetchResult> {
    let before = remote_refs(repo)?;
    let mut args = vec!["fetch", "--progress"];
    if opts.prune {
        args.push("--prune");
    }
    if opts.tags {
        args.push("--tags");
    }
    match &opts.remote {
        Some(remote) => args.push(plain_arg(remote, "remote name")?),
        None => args.push("--all"),
    }
    let env = network_env(repo, opts.background);
    let out = exec_streaming(repo, &args, &env, on_progress)?;
    if out.code != 0 {
        return Err(error_text(&out.stderr, "Fetch failed"));
    }
    Ok(FetchResult::diff(&before, &remote_refs(repo)?))
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum PullOutcome {
    /// Nothing new on the remote branch.
    UpToDate,
    FastForward,
    /// A merge commit was created.
    Merge,
    /// Local commits were replayed on top of the remote branch.
    Rebase,
    /// The merge or rebase stopped on conflicts; `Status::operation` describes it.
    Conflicts,
    /// The pull succeeded, but reapplying the stashed local changes conflicted.
    /// The changes are kept in the stash.
    StashConflicts,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub outcome: PullOutcome,
    /// Commits that came from the remote branch.
    pub incoming: u32,
    /// Local commits that were rebased onto the remote branch.
    pub rebased: u32,
    /// Files with conflicts, for the `Conflicts` and `StashConflicts` outcomes.
    pub conflicts: u32,
}

pub struct PullOptions {
    pub remote: String,
    /// Branch name on the remote, e.g. "main" (not "origin/main").
    pub branch: String,
    pub rebase: bool,
    /// Stash uncommitted changes before and reapply them after the pull.
    pub autostash: bool,
}

fn rev(repo: &Path, name: &str) -> Option<String> {
    run(repo, &["rev-parse", "--verify", "-q", name])
        .ok()
        .map(|s| s.trim().to_string())
}

fn count(repo: &Path, range: &str) -> u32 {
    run(repo, &["rev-list", "--count", range])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> bool {
    run(repo, &["merge-base", "--is-ancestor", ancestor, descendant]).is_ok()
}

/// Fetches `opts.branch` from `opts.remote` and merges or rebases the current branch onto it.
pub fn pull(repo: &Path, opts: &PullOptions, on_progress: &mut dyn FnMut(&str)) -> GitResult<PullResult> {
    let remote = plain_arg(&opts.remote, "remote name")?;
    let branch = plain_arg(&opts.branch, "branch name")?;
    // A rebase in progress detaches HEAD, so check for it first.
    if let Some(op) = operation(&git_dir(repo)?) {
        return Err(format!(
            "A {} is in progress. Finish or abort it before pulling.",
            op.kind.label()
        ));
    }
    if run(repo, &["symbolic-ref", "-q", "HEAD"]).is_err() {
        return Err("Pulling needs a current branch, but HEAD is detached. Switch to a branch first.".into());
    }
    let old = rev(repo, "HEAD");

    // A full ref keeps a tag with the branch's name from being pulled instead.
    let refspec = format!("refs/heads/{branch}");
    // An explicit --rebase/--no-rebase keeps newer git from refusing divergent branches when
    // pull.rebase is unset; pull.ff from the user's config still applies.
    let args = [
        "pull",
        "--progress",
        "--no-edit",
        if opts.rebase { "--rebase" } else { "--no-rebase" },
        if opts.autostash {
            "--autostash"
        } else {
            "--no-autostash"
        },
        remote,
        &refspec,
    ];
    let out = exec_streaming(repo, &args, &[], on_progress)?;

    let st = status(repo)?;
    let conflicts = st.conflicted.len() as u32;
    let result = |outcome, incoming, rebased| PullResult {
        outcome,
        incoming,
        rebased,
        conflicts,
    };
    if conflicts > 0 {
        let outcome = if st.operation.is_some() {
            PullOutcome::Conflicts
        } else {
            PullOutcome::StashConflicts
        };
        let incoming = old.as_deref().map_or(0, |o| count(repo, &format!("{o}..FETCH_HEAD")));
        return Ok(result(outcome, incoming, 0));
    }
    if out.code != 0 {
        return Err(error_text(&out.stderr, "Pull failed"));
    }

    let new = rev(repo, "HEAD");
    let outcome_and_counts = match (old.as_deref(), new.as_deref()) {
        (Some(o), Some(n)) if o == n => (PullOutcome::UpToDate, 0, 0),
        (None, _) | (_, None) => (
            PullOutcome::FastForward,
            new.as_deref().map_or(0, |n| count(repo, n)),
            0,
        ),
        (Some(o), Some(n)) => {
            let incoming = count(repo, &format!("{o}..FETCH_HEAD"));
            let parents = run(repo, &["rev-list", "--parents", "-n1", n]).unwrap_or_default();
            let parents: Vec<&str> = parents.split_whitespace().skip(1).collect();
            if parents.len() > 1 && parents[0] == o {
                (PullOutcome::Merge, incoming, 0)
            } else if is_ancestor(repo, o, n) {
                (PullOutcome::FastForward, incoming, 0)
            } else {
                (PullOutcome::Rebase, incoming, count(repo, "FETCH_HEAD..HEAD"))
            }
        }
    };
    let (outcome, incoming, rebased) = outcome_and_counts;
    Ok(result(outcome, incoming, rebased))
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

pub struct PushOptions {
    /// The local branch to push, e.g. "main".
    pub branch: String,
    pub remote: String,
    /// Branch name on the remote, e.g. "main" (not "origin/main"); created if it doesn't exist.
    pub remote_branch: String,
    /// Make the remote branch the local branch's upstream.
    pub set_upstream: bool,
    /// Push all tags along with the branch.
    pub tags: bool,
    /// Overwrite the remote branch even if that drops commits from it. Uses
    /// `--force-with-lease` (and `--force-if-includes` where git supports it), so commits on
    /// the remote that were never integrated locally are still not lost.
    pub force: bool,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum PushOutcome {
    /// The remote branch already pointed at the local branch.
    UpToDate,
    /// The remote branch was fast-forwarded.
    Pushed,
    /// The remote branch didn't exist and was created.
    NewBranch,
    /// The remote branch was overwritten by a force push.
    Forced,
    /// The remote branch has commits the local branch doesn't; pull first or force push.
    Rejected,
    /// A force push was refused because the remote branch has commits that were never
    /// integrated locally (someone else pushed since, or they were only fetched in the background).
    Stale,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub outcome: PushOutcome,
    /// Commits the remote branch gained.
    pub commits: u32,
    /// Tags created on the remote.
    pub new_tags: Vec<String>,
    /// Tags the remote refused, usually because it has a different tag of the same name.
    pub rejected_tags: Vec<String>,
}

/// One ref of `git push --porcelain`: `<flag>\t<src>:<dst>\t<summary>`, where the flag is
/// ' ' (fast-forward), '+' (forced), '-' (deleted), '*' (new), '!' (rejected) or '=' (up to date).
#[derive(Debug, PartialEq)]
struct PushedRef<'a> {
    flag: char,
    dst: &'a str,
    summary: &'a str,
}

fn parse_push_porcelain(out: &str) -> Vec<PushedRef<'_>> {
    out.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let flag = fields.next()?;
            let (_, dst) = fields.next()?.split_once(':')?;
            let summary = fields.next()?;
            let mut chars = flag.chars();
            match (chars.next(), chars.next()) {
                (Some(flag), None) => Some(PushedRef { flag, dst, summary }),
                _ => None,
            }
        })
        .collect()
}

/// The installed git's major and minor version, from "git version 2.39.3 (Apple Git-145)".
fn git_version(repo: &Path) -> Option<(u32, u32)> {
    let out = run(repo, &["version"]).ok()?;
    let mut parts = out.split_whitespace().nth(2)?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// Pushes a local branch to a branch on a remote.
pub fn push(repo: &Path, opts: &PushOptions, on_progress: &mut dyn FnMut(&str)) -> GitResult<PushResult> {
    let remote = plain_arg(&opts.remote, "remote name")?;
    let branch = plain_arg(&opts.branch, "branch name")?;
    let target = plain_arg(&opts.remote_branch, "branch name")?;
    let local_ref = format!("refs/heads/{branch}");
    let remote_ref = format!("refs/heads/{target}");
    if run(repo, &["check-ref-format", &remote_ref]).is_err() {
        return Err(format!("'{target}' is not a valid branch name"));
    }
    if rev(repo, &local_ref).is_none() {
        return Err(format!("There is no local branch '{branch}'"));
    }
    // What a new remote branch brings: the commits the remote doesn't have on any branch yet.
    let remote_glob = format!("--remotes={remote}");
    let unpushed = run(repo, &["rev-list", "--count", &local_ref, "--not", &remote_glob])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    let lease = format!("--force-with-lease={remote_ref}");
    let refspec = format!("{local_ref}:{remote_ref}");
    let mut args = vec!["push", "--progress", "--porcelain"];
    if opts.set_upstream {
        args.push("--set-upstream");
    }
    if opts.tags {
        args.push("--tags");
    }
    if opts.force {
        // The lease names only the branch, so pushing tags never overwrites any.
        args.push(&lease);
        // Without it, a background fetch would make the lease pass even though nobody looked
        // at the fetched commits (git 2.30+).
        if git_version(repo).is_some_and(|v| v >= (2, 30)) {
            args.push("--force-if-includes");
        }
    }
    args.extend([remote, refspec.as_str()]);
    let out = exec_streaming(repo, &args, &[], on_progress)?;

    let refs = parse_push_porcelain(&out.stdout);
    let Some(pushed) = refs.iter().find(|r| r.dst == remote_ref) else {
        return Err(error_text(&out.stderr, "Push failed"));
    };
    let tags = |flag: char| -> Vec<String> {
        refs.iter()
            .filter(|r| r.flag == flag)
            .filter_map(|r| r.dst.strip_prefix("refs/tags/"))
            .map(String::from)
            .collect()
    };
    let (outcome, commits) = match pushed.flag {
        '=' => (PushOutcome::UpToDate, 0),
        '*' => (PushOutcome::NewBranch, unpushed),
        // "4e328f7..ad65bd3" or "f82346d...821567d (forced update)"
        ' ' | '+' => {
            let range = pushed.summary.split_whitespace().next().unwrap_or_default();
            let (old, new) = range
                .split_once("...")
                .or_else(|| range.split_once(".."))
                .unwrap_or_default();
            let commits = if old.is_empty() {
                0
            } else {
                count(repo, &format!("{old}..{new}"))
            };
            let outcome = if pushed.flag == '+' {
                PushOutcome::Forced
            } else {
                PushOutcome::Pushed
            };
            (outcome, commits)
        }
        '!' if pushed.summary.starts_with("[rejected]") => {
            if pushed.summary.contains("non-fast-forward") || pushed.summary.contains("fetch first") {
                (PushOutcome::Rejected, 0)
            } else if pushed.summary.contains("stale info") || pushed.summary.contains("updated since checkout") {
                (PushOutcome::Stale, 0)
            } else {
                return Err(error_text(&out.stderr, pushed.summary));
            }
        }
        // E.g. "[remote rejected] (protected branch hook declined)"; the remote's explanation
        // is in its "remote:" lines.
        _ => return Err(error_text(&out.stderr, pushed.summary)),
    };
    Ok(PushResult {
        outcome,
        commits,
        new_tags: tags('*'),
        rejected_tags: tags('!'),
    })
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

/// How far HEAD and another branch or commit have diverged.
#[derive(Serialize, Debug, PartialEq)]
pub struct Divergence {
    /// Commits only on HEAD.
    pub ahead: u32,
    /// Commits only on the other side.
    pub behind: u32,
}

/// Counts the commits HEAD has that `base` doesn't (ahead) and the other way round (behind).
pub fn divergence(repo: &Path, base: &str) -> GitResult<Divergence> {
    let base = plain_arg(base, "branch or commit")?;
    let range = format!("{base}...HEAD");
    // "<behind>\t<ahead>": the left side of the symmetric range is `base`.
    let out = run(repo, &["rev-list", "--left-right", "--count", &range, "--"])?;
    let mut counts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    let behind = counts.next().unwrap_or(0);
    let ahead = counts.next().unwrap_or(0);
    Ok(Divergence { ahead, behind })
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum RebaseOutcome {
    /// The branch already contains everything on the new base.
    UpToDate,
    /// The branch had no commits of its own and was moved to the new base.
    FastForward,
    /// The branch's commits were replayed on top of the new base.
    Rebase,
    /// The rebase stopped (usually on conflicts); `Status::operation` describes it.
    Conflicts,
    /// The rebase succeeded, but reapplying the stashed local changes conflicted.
    /// The changes are kept in the stash.
    StashConflicts,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    pub outcome: RebaseOutcome,
    /// Commits of the new base the branch didn't contain yet.
    pub incoming: u32,
    /// Commits of the branch on top of the new base afterwards; for `Conflicts`, the commits
    /// being replayed.
    pub rebased: u32,
    /// Files with conflicts, for the `Conflicts` and `StashConflicts` outcomes.
    pub conflicts: u32,
}

pub struct RebaseOptions {
    /// Branch, tag or commit to rebase onto, e.g. "main" or "origin/main".
    pub onto: String,
    /// Stash uncommitted changes before and reapply them after the rebase.
    pub autostash: bool,
}

/// Replays the current branch's own commits on top of `opts.onto`.
pub fn rebase(repo: &Path, opts: &RebaseOptions, on_progress: &mut dyn FnMut(&str)) -> GitResult<RebaseResult> {
    let onto = plain_arg(&opts.onto, "branch or commit")?;
    // A rebase in progress detaches HEAD, so check for it first.
    if let Some(op) = operation(&git_dir(repo)?) {
        return Err(format!(
            "A {} is in progress. Finish or abort it before rebasing.",
            op.kind.label()
        ));
    }
    if run(repo, &["symbolic-ref", "-q", "HEAD"]).is_err() {
        return Err("Rebasing needs a current branch, but HEAD is detached. Switch to a branch first.".into());
    }
    let old = rev(repo, "HEAD").ok_or("The current branch has no commits to rebase yet.")?;
    let base =
        rev(repo, &format!("{onto}^{{commit}}")).ok_or_else(|| format!("'{onto}' is not a branch, tag or commit."))?;
    let incoming = count(repo, &format!("{old}..{base}"));
    let own = count(repo, &format!("{base}..{old}"));

    let args = [
        "rebase",
        if opts.autostash {
            "--autostash"
        } else {
            "--no-autostash"
        },
        onto,
    ];
    // A non-interactive rebase shouldn't open an editor, but never wait for one that can't show.
    let out = exec_streaming(repo, &args, &[("GIT_EDITOR", "true")], on_progress)?;

    let st = status(repo)?;
    let conflicts = st.conflicted.len() as u32;
    let result = |outcome, rebased| RebaseResult {
        outcome,
        incoming,
        rebased,
        conflicts,
    };
    if st.operation.is_some() {
        return Ok(result(RebaseOutcome::Conflicts, own));
    }
    if conflicts > 0 {
        return Ok(result(
            RebaseOutcome::StashConflicts,
            count(repo, &format!("{base}..HEAD")),
        ));
    }
    if out.code != 0 {
        return Err(error_text(&out.stderr, "Rebase failed"));
    }
    Ok(match rev(repo, "HEAD") {
        Some(new) if new == old => result(RebaseOutcome::UpToDate, 0),
        _ if own == 0 => result(RebaseOutcome::FastForward, 0),
        _ => result(RebaseOutcome::Rebase, count(repo, &format!("{base}..HEAD"))),
    })
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/// How `merge` combines the other branch with the current one.
#[derive(Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum MergeMode {
    /// Fast-forward when possible, else create a merge commit.
    Ff,
    /// Always create a merge commit.
    NoFf,
    /// Only fast-forward; refuse when the branches have diverged.
    FfOnly,
    /// Stage the other branch's changes for one ordinary commit, without committing.
    Squash,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum MergeOutcome {
    /// The current branch already contains everything on the other one.
    UpToDate,
    FastForward,
    /// A merge commit was created.
    Merge,
    /// The changes were staged for a squash commit; `Status::operation` describes it.
    Squash,
    /// The merge stopped on conflicts; `Status::operation` describes it.
    Conflicts,
    /// The merge succeeded, but reapplying the stashed local changes conflicted.
    /// The changes are kept in the stash.
    StashConflicts,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub outcome: MergeOutcome,
    /// Commits of the other branch the current one didn't contain yet.
    pub incoming: u32,
    /// Files with conflicts, for the `Conflicts` and `StashConflicts` outcomes.
    pub conflicts: u32,
}

pub struct MergeOptions {
    /// Branch, tag or commit to merge into the current branch, e.g. "feature" or "origin/main".
    pub source: String,
    pub mode: MergeMode,
    /// Stash uncommitted changes before and reapply them after the merge. Ignored for squash
    /// merges: git would only reapply them once the squash is committed, and never tells.
    pub autostash: bool,
}

/// Merges `opts.source` into the current branch.
pub fn merge(repo: &Path, opts: &MergeOptions, on_progress: &mut dyn FnMut(&str)) -> GitResult<MergeResult> {
    let source = plain_arg(&opts.source, "branch or commit")?;
    // A rebase in progress detaches HEAD, so check for it first.
    if let Some(op) = operation(&git_dir(repo)?) {
        return Err(format!(
            "A {} is in progress. Finish or abort it before merging.",
            op.kind.label()
        ));
    }
    if run(repo, &["symbolic-ref", "-q", "HEAD"]).is_err() {
        return Err("Merging needs a current branch, but HEAD is detached. Switch to a branch first.".into());
    }
    let old = rev(repo, "HEAD").ok_or("The current branch has no commits to merge into yet.")?;
    let theirs = rev(repo, &format!("{source}^{{commit}}"))
        .ok_or_else(|| format!("'{source}' is not a branch, tag or commit."))?;
    let incoming = count(repo, &format!("{old}..{theirs}"));

    let squash = opts.mode == MergeMode::Squash;
    // Explicit flags, so merge.ff or merge.autoStash in the user's config can't change what the
    // dialog promised.
    let args = [
        "merge",
        "--progress",
        "--no-edit",
        match opts.mode {
            MergeMode::Ff => "--ff",
            MergeMode::NoFf => "--no-ff",
            MergeMode::FfOnly => "--ff-only",
            MergeMode::Squash => "--squash",
        },
        if opts.autostash && !squash {
            "--autostash"
        } else {
            "--no-autostash"
        },
        source,
    ];
    let out = exec_streaming(repo, &args, &[("GIT_EDITOR", "true")], on_progress)?;

    let st = status(repo)?;
    let conflicts = st.conflicted.len() as u32;
    let result = |outcome| MergeResult {
        outcome,
        incoming,
        conflicts,
    };
    if conflicts > 0 {
        return Ok(result(if st.operation.is_some() {
            MergeOutcome::Conflicts
        } else {
            MergeOutcome::StashConflicts
        }));
    }
    if out.code != 0 {
        // "Not possible to fast-forward" and the files that block the merge are on stderr.
        let text = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        return Err(error_text(text, "Merge failed"));
    }
    if squash {
        let staged = st.operation.is_some_and(|op| op.kind == OperationKind::Squash);
        return Ok(result(if staged {
            MergeOutcome::Squash
        } else {
            MergeOutcome::UpToDate
        }));
    }
    let new = rev(repo, "HEAD").unwrap_or_default();
    if new == old {
        return Ok(result(MergeOutcome::UpToDate));
    }
    // A fast-forward can land on someone else's merge commit; ours has the old HEAD as first parent.
    let parents = run(repo, &["rev-list", "--parents", "-n1", &new]).unwrap_or_default();
    let parents: Vec<&str> = parents.split_whitespace().skip(1).collect();
    let merged = parents.len() > 1 && parents[0] == old;
    Ok(result(if merged {
        MergeOutcome::Merge
    } else {
        MergeOutcome::FastForward
    }))
}

// ---------------------------------------------------------------------------
// Merge, rebase, cherry-pick and revert in progress
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    /// A squash merge whose changes are staged (or conflict) and wait to be committed.
    Squash,
}

impl OperationKind {
    fn label(self) -> &'static str {
        match self {
            OperationKind::Merge => "merge",
            OperationKind::Rebase => "rebase",
            OperationKind::CherryPick => "cherry-pick",
            OperationKind::Revert => "revert",
            OperationKind::Squash => "squash merge",
        }
    }
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub kind: OperationKind,
    /// The branch being rebased, e.g. "main".
    pub head: Option<String>,
    /// Rebase progress: the commit being applied (1-based) and the number of commits.
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// The prepared commit message (`MERGE_MSG` or `SQUASH_MSG` without comments), for merges.
    pub message: Option<String>,
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Detects an operation that stopped and waits for the user, from git's state files.
fn operation(git_dir: &Path) -> Option<Operation> {
    let blank = |kind| Operation {
        kind,
        head: None,
        step: None,
        total: None,
        message: None,
    };
    // A rebase that stops on a picked commit also leaves CHERRY_PICK_HEAD behind, so check it first.
    for (dir, step_file, total_file) in [("rebase-merge", "msgnum", "end"), ("rebase-apply", "next", "last")] {
        let dir = git_dir.join(dir);
        // rebase-apply is also used by `git am`, which is not a rebase.
        if dir.is_dir() && !dir.join("applying").exists() {
            let number = |f: &str| read_trimmed(&dir.join(f)).and_then(|s| s.parse().ok());
            return Some(Operation {
                head: read_trimmed(&dir.join("head-name"))
                    .map(|h| h.strip_prefix("refs/heads/").unwrap_or(&h).to_string()),
                step: number(step_file),
                total: number(total_file),
                ..blank(OperationKind::Rebase)
            });
        }
    }
    let message = |file: &str| {
        let m = std::fs::read_to_string(git_dir.join(file)).ok()?;
        let m = m.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n");
        Some(m.trim().to_string()).filter(|m| !m.is_empty())
    };
    if git_dir.join("MERGE_HEAD").exists() {
        return Some(Operation {
            message: message("MERGE_MSG"),
            ..blank(OperationKind::Merge)
        });
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some(blank(OperationKind::CherryPick));
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some(blank(OperationKind::Revert));
    }
    // `merge --squash` leaves only SQUASH_MSG behind; committing or resetting removes it.
    if git_dir.join("SQUASH_MSG").exists() {
        return Some(Operation {
            message: message("SQUASH_MSG"),
            ..blank(OperationKind::Squash)
        });
    }
    None
}

fn current_operation(repo: &Path) -> GitResult<Operation> {
    operation(&git_dir(repo)?).ok_or_else(|| "There is no merge or rebase in progress.".to_string())
}

/// Gives up the operation in progress and returns to the state before it started.
pub fn abort_operation(repo: &Path) -> GitResult<()> {
    let op = current_operation(repo)?;
    let args: &[&str] = match op.kind {
        // Like `merge --abort`: drops the staged squash, keeps unrelated unstaged changes.
        OperationKind::Squash => &["reset", "--merge"],
        kind => &[kind.label(), "--abort"],
    };
    run(repo, args).map(drop)
}

/// Continues after the conflicts were resolved and staged. A merge or squash merge is finished
/// by committing with its prepared message.
pub fn continue_operation(repo: &Path) -> GitResult<()> {
    let op = current_operation(repo)?;
    let args: &[&str] = match op.kind {
        OperationKind::Merge | OperationKind::Squash => &["commit", "--no-edit"],
        kind => &[kind.label(), "--continue"],
    };
    // Accept the prepared messages instead of waiting for an editor that never opens.
    exec_with_env(repo, args, &[("GIT_EDITOR", "true")]).map(drop)
}

/// Skips the commit that stopped a rebase, cherry-pick or revert.
pub fn skip_operation(repo: &Path) -> GitResult<()> {
    let op = current_operation(repo)?;
    if matches!(op.kind, OperationKind::Merge | OperationKind::Squash) {
        return Err(format!("A {} can't be skipped; abort it instead.", op.kind.label()));
    }
    exec_with_env(repo, &[op.kind.label(), "--skip"], &[("GIT_EDITOR", "true")]).map(drop)
}

fn exec_with_env(repo: &Path, args: &[&str], envs: &[(&str, &str)]) -> GitResult<String> {
    let out = git_command(repo)
        .args(args)
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to start git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        // `rebase --continue` explains itself on stdout ("You must edit all merge conflicts…").
        let text = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(error_text(&text, &format!("git {} failed", args.join(" "))))
    }
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
                // Pull flags are explicit, but a global pull.ff=only would still refuse merges.
                ("pull.ff", "true"),
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

        /// Clones `origin` into a new throwaway repository.
        fn clone_of(origin: &TestRepo, name: &str) -> TestRepo {
            let clone = TestRepo {
                dir: std::env::temp_dir().join(format!("grit-test-{}-{name}", std::process::id())),
            };
            let _ = std::fs::remove_dir_all(&clone.dir);
            // Set before the checkout: Git for Windows enables core.autocrlf system-wide, which
            // would check files out with CRLF that then show up as changes once it is turned off.
            origin.git(&[
                "clone",
                "-q",
                "-c",
                "core.autocrlf=false",
                origin.dir.to_str().unwrap(),
                clone.dir.to_str().unwrap(),
            ]);
            clone.configure();
            clone
        }

        fn head(&self) -> String {
            self.git(&["rev-parse", "HEAD"]).trim().to_string()
        }

        fn read(&self, path: &str) -> String {
            std::fs::read_to_string(self.dir.join(path)).unwrap()
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
    fn bare_repositories_are_repositories_but_not_opened_or_initialized() {
        let origin = bare("bare-detect");
        let objects = origin.dir.join("objects");
        assert!(is_repository(&origin.dir));
        assert!(is_repository(&objects));
        assert!(open_repo(&origin.dir).err().unwrap().contains("bare repository"));
        assert!(init_repo(&origin.dir, "main").err().unwrap().contains("bare repository"));
        assert!(init_repo(&objects, "main").err().unwrap().contains("bare repository"));
        assert!(!origin.dir.join(".git").exists() && !objects.join(".git").exists());
    }

    #[test]
    fn init_repo_creates_the_folder_and_the_first_branch() {
        let dir = std::env::temp_dir().join(format!("grit-test-{}-init/new/repo", std::process::id()));
        let base = dir.parent().unwrap().parent().unwrap().to_path_buf();
        let _ = std::fs::remove_dir_all(&base);
        assert!(!is_repository(&dir));
        let info = init_repo(&dir, "trunk").unwrap();
        let head = run(&dir, &["symbolic-ref", "HEAD"]).unwrap();
        let again = init_repo(&dir, "trunk").err();
        let bad = init_repo(&base.join("other"), "no..dots").err();
        let is_repo = is_repository(&dir);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(info.name, "repo");
        assert_eq!(head.trim(), "refs/heads/trunk");
        assert!(again.unwrap().contains("already a git repository"));
        assert!(bad.unwrap().contains("not a valid branch name"));
        assert!(is_repo);
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
    fn discard_reverts_unstaged_changes_and_keeps_staged_ones() {
        let repo = TestRepo::new("discard-tracked");
        repo.write("a.txt", "one\n");
        repo.write("gone.txt", "keep me\n");
        repo.commit_all("initial");
        repo.write("a.txt", "two\n");
        stage(&repo.dir, &["a.txt".into()]).unwrap();
        repo.write("a.txt", "three\n");
        std::fs::remove_file(repo.dir.join("gone.txt")).unwrap();

        discard(&repo.dir, &["a.txt".into(), "gone.txt".into()], &[]).unwrap();
        assert_eq!(repo.read("a.txt"), "two\n");
        assert_eq!(repo.read("gone.txt"), "keep me\n");
        let st = status(&repo.dir).unwrap();
        assert!(st.unstaged.is_empty());
        assert_eq!(st.staged.len(), 1);
    }

    #[test]
    fn discard_deletes_untracked_files_and_the_folders_they_leave_empty() {
        let repo = TestRepo::new("discard-untracked");
        repo.commit_all_initial();
        repo.write("dir/sub/new.txt", "x\n");
        repo.write("dir/other.txt", "y\n");
        repo.write("dir with space/ü [x].txt", "z\n");
        repo.write("ignored.log", "log\n");
        repo.write(".gitignore", "*.log\n");
        repo.git(&["add", ".gitignore"]);

        discard(
            &repo.dir,
            &[],
            &["dir/sub/new.txt".into(), "dir with space/ü [x].txt".into()],
        )
        .unwrap();
        assert!(!repo.dir.join("dir/sub").exists());
        assert!(!repo.dir.join("dir with space").exists());
        assert_eq!(repo.read("dir/other.txt"), "y\n");
        assert!(repo.dir.join("ignored.log").exists());
        let st = status(&repo.dir).unwrap();
        assert_eq!(st.unstaged.len(), 1);
        assert_eq!(st.unstaged[0].path, "dir/other.txt");
    }

    #[test]
    fn discard_takes_paths_literally() {
        let repo = TestRepo::new("discard-literal");
        repo.write("[ab].txt", "star\n");
        repo.write("a.txt", "a\n");
        repo.commit_all("initial");
        repo.write("[ab].txt", "changed\n");
        repo.write("a.txt", "changed\n");
        discard(&repo.dir, &["[ab].txt".into()], &[]).unwrap();
        assert_eq!(repo.read("[ab].txt"), "star\n");
        assert_eq!(repo.read("a.txt"), "changed\n");
    }

    #[test]
    fn add_to_gitignore_creates_the_file_and_hides_the_file() {
        let repo = TestRepo::new("ignore-create");
        repo.commit_all_initial();
        repo.write("build/out.bin", "x");
        repo.write("debug.log", "x");
        add_to_gitignore(&repo.dir, "/build/").unwrap();
        assert_eq!(repo.read(".gitignore"), "/build/\n");
        let paths: Vec<String> = status(&repo.dir)
            .unwrap()
            .unstaged
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(paths, [".gitignore", "debug.log"]);
    }

    #[test]
    fn add_to_gitignore_appends_once_and_keeps_line_endings() {
        let repo = TestRepo::new("ignore-append");
        repo.write(".gitignore", "node_modules");
        add_to_gitignore(&repo.dir, "*.log").unwrap();
        add_to_gitignore(&repo.dir, "*.log").unwrap();
        add_to_gitignore(&repo.dir, "node_modules").unwrap();
        assert_eq!(repo.read(".gitignore"), "node_modules\n*.log\n");

        repo.write(".gitignore", "a\r\nb\r\n");
        add_to_gitignore(&repo.dir, "c").unwrap();
        add_to_gitignore(&repo.dir, "b").unwrap();
        assert_eq!(repo.read(".gitignore"), "a\r\nb\r\nc\r\n");
    }

    #[test]
    fn add_to_gitignore_rejects_empty_and_multiline_patterns() {
        let repo = TestRepo::new("ignore-invalid");
        assert!(add_to_gitignore(&repo.dir, "  ").is_err());
        assert!(add_to_gitignore(&repo.dir, "a\nb").is_err());
        assert!(!repo.dir.join(".gitignore").exists());
    }

    /// The hunk headers of a file's diff, as the frontend sees them.
    fn hunk_headers(repo: &TestRepo, path: &str, staged: bool, untracked: bool) -> Vec<String> {
        let diff = working_diff(&repo.dir, path, staged, untracked).unwrap();
        patch::parse(diff.as_bytes())
            .unwrap()
            .hunks
            .into_iter()
            .map(|h| h.header)
            .collect()
    }

    fn hunk(index: usize, header: &str, lines: Option<Vec<usize>>) -> HunkSelection {
        HunkSelection {
            index,
            header: header.to_string(),
            lines,
        }
    }

    /// Twenty numbered lines; far enough apart, two edits make two hunks.
    fn numbered(edit: impl Fn(usize) -> Option<String>) -> String {
        (1..=20)
            .map(|i| edit(i).unwrap_or_else(|| format!("line {i}")) + "\n")
            .collect()
    }

    fn two_hunk_repo(name: &str) -> TestRepo {
        let repo = TestRepo::new(name);
        repo.write("f.txt", &numbered(|_| None));
        repo.commit_all("initial");
        repo.write(
            "f.txt",
            &numbered(|i| match i {
                2 => Some("TWO".into()),
                18 => Some("EIGHTEEN".into()),
                _ => None,
            }),
        );
        repo
    }

    #[test]
    fn stages_unstages_and_discards_single_hunks() {
        let repo = two_hunk_repo("hunks");
        let headers = hunk_headers(&repo, "f.txt", false, false);
        assert_eq!(headers.len(), 2);

        apply_selection(
            &repo.dir,
            "f.txt",
            false,
            false,
            PatchAction::Stage,
            &[hunk(1, &headers[1], None)],
        )
        .unwrap();
        let cached = repo.git(&["diff", "--cached"]);
        assert!(cached.contains("+EIGHTEEN") && !cached.contains("+TWO"), "{cached}");
        let unstaged = repo.git(&["diff"]);
        assert!(
            unstaged.contains("+TWO") && !unstaged.contains("+EIGHTEEN"),
            "{unstaged}"
        );

        let staged_headers = hunk_headers(&repo, "f.txt", true, false);
        apply_selection(
            &repo.dir,
            "f.txt",
            true,
            false,
            PatchAction::Unstage,
            &[hunk(0, &staged_headers[0], None)],
        )
        .unwrap();
        assert_eq!(repo.git(&["diff", "--cached"]), "");

        let headers = hunk_headers(&repo, "f.txt", false, false);
        apply_selection(
            &repo.dir,
            "f.txt",
            false,
            false,
            PatchAction::Discard,
            &[hunk(0, &headers[0], None)],
        )
        .unwrap();
        let content = repo.read("f.txt");
        assert!(
            content.contains("line 2\n") && content.contains("EIGHTEEN"),
            "{content}"
        );
    }

    #[test]
    fn refuses_a_hunk_that_changed_since_it_was_shown() {
        let repo = two_hunk_repo("hunk-stale");
        let headers = hunk_headers(&repo, "f.txt", false, false);
        repo.write("f.txt", &numbered(|i| (i == 1).then(|| "ONE".into())));
        let err = apply_selection(
            &repo.dir,
            "f.txt",
            false,
            false,
            PatchAction::Stage,
            &[hunk(0, &headers[0], None)],
        )
        .unwrap_err();
        assert_eq!(err, patch::STALE);
        assert_eq!(repo.git(&["diff", "--cached"]), "");
        let err = apply_selection(
            &repo.dir,
            "f.txt",
            true,
            false,
            PatchAction::Stage,
            &[hunk(0, &headers[0], None)],
        );
        assert!(err.is_err());
    }

    #[test]
    fn stages_and_discards_selected_lines_across_hunks() {
        let repo = TestRepo::new("lines");
        repo.write("f.txt", &numbered(|_| None));
        repo.commit_all("initial");
        repo.write(
            "f.txt",
            &numbered(|i| match i {
                2 => Some("TWO\nextra a".into()),
                18 => Some("EIGHTEEN\nextra b".into()),
                _ => None,
            }),
        );
        let headers = hunk_headers(&repo, "f.txt", false, false);
        // Hunk bodies: context " line 1", "-line 2", "+TWO", "+extra a", context... (the first hunk
        // starts at line 1, so it has one line of context before).
        let diff = working_diff(&repo.dir, "f.txt", false, false).unwrap();
        let parsed = patch::parse(diff.as_bytes()).unwrap();
        let index_of = |h: usize, text: &str| parsed.hunks[h].lines.iter().position(|l| l == text.as_bytes()).unwrap();
        let selection = [
            hunk(0, &headers[0], Some(vec![index_of(0, "-line 2"), index_of(0, "+TWO")])),
            hunk(1, &headers[1], Some(vec![index_of(1, "+extra b")])),
        ];
        apply_selection(&repo.dir, "f.txt", false, false, PatchAction::Stage, &selection).unwrap();
        let index = repo.git(&["show", ":f.txt"]);
        assert!(index.starts_with("line 1\nTWO\nline 3\n"), "{index}");
        assert!(index.contains("line 18\nextra b\nline 19\n"), "{index}");
        assert!(!index.contains("extra a") && !index.contains("EIGHTEEN"));

        // Discard "extra a" from the working tree; the rest stays.
        let diff = working_diff(&repo.dir, "f.txt", false, false).unwrap();
        let parsed = patch::parse(diff.as_bytes()).unwrap();
        let (h, i) = parsed
            .hunks
            .iter()
            .enumerate()
            .find_map(|(h, hk)| hk.lines.iter().position(|l| l == b"+extra a").map(|i| (h, i)))
            .unwrap();
        apply_selection(
            &repo.dir,
            "f.txt",
            false,
            false,
            PatchAction::Discard,
            &[hunk(h, &parsed.hunks[h].header, Some(vec![i]))],
        )
        .unwrap();
        let content = repo.read("f.txt");
        assert!(!content.contains("extra a") && content.contains("TWO") && content.contains("EIGHTEEN"));
    }

    #[test]
    fn stages_parts_of_untracked_files() {
        let repo = TestRepo::new("untracked-parts");
        repo.commit_all_initial();
        repo.write("dir with space/n.txt", "x\ny\nz\n");
        let path = "dir with space/n.txt";
        let headers = hunk_headers(&repo, path, false, true);
        assert_eq!(headers, ["@@ -0,0 +1,3 @@"]);

        apply_selection(
            &repo.dir,
            path,
            false,
            true,
            PatchAction::Stage,
            &[hunk(0, &headers[0], Some(vec![0, 2]))],
        )
        .unwrap();
        assert_eq!(repo.git(&["show", &format!(":{path}")]), "x\nz\n");
        let st = status(&repo.dir).unwrap();
        assert_eq!(st.staged[0].status, "A");
        assert_eq!(st.unstaged[0].status, "M");

        repo.write("w.txt", "a\nb\n");
        let headers = hunk_headers(&repo, "w.txt", false, true);
        apply_selection(
            &repo.dir,
            "w.txt",
            false,
            true,
            PatchAction::Stage,
            &[hunk(0, &headers[0], None)],
        )
        .unwrap();
        assert_eq!(repo.git(&["show", ":w.txt"]), "a\nb\n");
    }

    #[test]
    fn discarding_lines_of_an_untracked_file_keeps_it_untracked() {
        let repo = TestRepo::new("untracked-discard");
        repo.commit_all_initial();
        repo.write("n.txt", "x\ny\nz\n");
        let headers = hunk_headers(&repo, "n.txt", false, true);
        apply_selection(
            &repo.dir,
            "n.txt",
            false,
            true,
            PatchAction::Discard,
            &[hunk(0, &headers[0], Some(vec![1]))],
        )
        .unwrap();
        assert_eq!(repo.read("n.txt"), "x\nz\n");
        let st = status(&repo.dir).unwrap();
        assert_eq!(st.unstaged.len(), 1);
        assert_eq!(st.unstaged[0].status, "?");
        assert!(st.staged.is_empty());

        // A failed attempt leaves it untracked too.
        let err = apply_selection(
            &repo.dir,
            "n.txt",
            false,
            true,
            PatchAction::Stage,
            &[hunk(0, "@@ -0,0 +1,9 @@", None)],
        );
        assert!(err.is_err());
        assert_eq!(status(&repo.dir).unwrap().unstaged[0].status, "?");
    }

    #[test]
    fn unstages_lines_of_a_new_file() {
        let repo = TestRepo::new("unstage-new-lines");
        repo.commit_all_initial();
        repo.write("s.txt", "p\nq\nr\n");
        stage(&repo.dir, &["s.txt".into()]).unwrap();
        let headers = hunk_headers(&repo, "s.txt", true, false);
        apply_selection(
            &repo.dir,
            "s.txt",
            true,
            false,
            PatchAction::Unstage,
            &[hunk(0, &headers[0], Some(vec![1]))],
        )
        .unwrap();
        assert_eq!(repo.git(&["show", ":s.txt"]), "p\nr\n");
        assert_eq!(repo.read("s.txt"), "p\nq\nr\n");
    }

    #[test]
    fn stages_parts_of_a_deleted_file() {
        let repo = TestRepo::new("deleted-lines");
        repo.write("d.txt", "x\ny\n");
        repo.commit_all("initial");
        std::fs::remove_file(repo.dir.join("d.txt")).unwrap();
        let headers = hunk_headers(&repo, "d.txt", false, false);
        apply_selection(
            &repo.dir,
            "d.txt",
            false,
            false,
            PatchAction::Stage,
            &[hunk(0, &headers[0], Some(vec![0]))],
        )
        .unwrap();
        assert_eq!(repo.git(&["show", ":d.txt"]), "y\n");
        // Discarding the rest of the deletion brings the line back into the working tree.
        let headers = hunk_headers(&repo, "d.txt", false, false);
        apply_selection(
            &repo.dir,
            "d.txt",
            false,
            false,
            PatchAction::Discard,
            &[hunk(0, &headers[0], None)],
        )
        .unwrap();
        assert_eq!(repo.read("d.txt"), "y\n");
    }

    #[test]
    fn stages_hunks_with_crlf_and_without_a_final_newline() {
        let repo = TestRepo::new("hunk-crlf");
        repo.write_bytes("w.txt", b"a\r\nb\r\nc");
        repo.commit_all("initial");
        repo.write_bytes("w.txt", b"a\r\nB\r\nc\r\nd");
        let headers = hunk_headers(&repo, "w.txt", false, false);
        apply_selection(
            &repo.dir,
            "w.txt",
            false,
            false,
            PatchAction::Stage,
            &[hunk(0, &headers[0], None)],
        )
        .unwrap();
        assert_eq!(run_bytes(&repo.dir, &["show", ":w.txt"]).unwrap(), b"a\r\nB\r\nc\r\nd");
        assert_eq!(repo.git(&["diff"]), "");
    }

    #[test]
    fn discard_works_before_the_first_commit() {
        let repo = TestRepo::new("discard-unborn");
        repo.write("a.txt", "staged\n");
        stage_all(&repo.dir).unwrap();
        repo.write("a.txt", "edited\n");
        repo.write("b.txt", "untracked\n");
        discard(&repo.dir, &["a.txt".into()], &["b.txt".into()]).unwrap();
        assert_eq!(repo.read("a.txt"), "staged\n");
        assert!(!repo.dir.join("b.txt").exists());
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
    fn checks_out_commits_detached() {
        let repo = TestRepo::new("checkout-commit");
        let first = repo.commit_all_initial();
        repo.write("b.txt", "b\n");
        repo.commit_all("second");

        checkout_commit(&repo.dir, &first).unwrap();
        assert_eq!(status(&repo.dir).unwrap().branch, None);
        assert_eq!(repo.head(), first);
        assert!(!repo.dir.join("b.txt").exists());

        // Back on the branch, everything is there again.
        checkout(&repo.dir, "main").unwrap();
        assert!(repo.dir.join("b.txt").exists());

        assert!(checkout_commit(&repo.dir, "0000000000000000000000000000000000000000").is_err());
        assert!(checkout_commit(&repo.dir, "--orphan").is_err());
        assert_eq!(status(&repo.dir).unwrap().branch.as_deref(), Some("main"));
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
    fn deletes_local_branches() {
        let repo = TestRepo::new("delete-branch");
        repo.commit_all_initial();
        repo.git(&["branch", "merged"]);
        repo.git(&["switch", "-q", "-c", "unmerged"]);
        repo.write("a.txt", "one\n");
        repo.commit_all("only on unmerged");
        repo.git(&["switch", "-q", "main"]);
        let delete = |name: &str, force: bool| delete_branch(&repo.dir, name, force, false, &mut |_| {});
        let names = || -> Vec<String> { branches(&repo.dir).unwrap().local.into_iter().map(|b| b.name).collect() };

        assert_eq!(delete("merged", false).unwrap(), DeleteBranchOutcome::Deleted);
        assert_eq!(names(), ["main", "unmerged"]);

        // Unmerged commits are only dropped when forced.
        assert_eq!(delete("unmerged", false).unwrap(), DeleteBranchOutcome::NotMerged);
        assert_eq!(names(), ["main", "unmerged"]);
        assert_eq!(delete("unmerged", true).unwrap(), DeleteBranchOutcome::Deleted);
        assert_eq!(names(), ["main"]);

        // The current branch, missing branches and option-like names are refused.
        assert!(delete("main", true).is_err());
        assert!(delete("does-not-exist", false).is_err());
        assert!(delete("-D", false).unwrap_err().contains("not a valid branch name"));
        assert_eq!(names(), ["main"]);
    }

    #[test]
    fn deletes_remote_branches_along() {
        let origin = TestRepo::new("delete-remote-origin");
        origin.commit_all_initial();
        for name in ["merged", "unmerged", "moved", "gone", "local-only"] {
            origin.git(&["branch", name]);
        }
        origin.git(&["switch", "-q", "unmerged"]);
        origin.write("u.txt", "u\n");
        origin.commit_all("only on unmerged");
        origin.git(&["switch", "-q", "main"]);

        let clone = TestRepo::clone_of(&origin, "delete-remote-clone");
        for name in ["merged", "unmerged", "moved", "gone"] {
            checkout_remote(&clone.dir, &format!("origin/{name}")).unwrap();
        }
        clone.git(&["branch", "--no-track", "local-only", "main"]);
        checkout(&clone.dir, "main").unwrap();
        let delete = |name: &str, force: bool| delete_branch(&clone.dir, name, force, true, &mut |_| {});
        let local = |name: &str| rev(&clone.dir, &format!("refs/heads/{name}")).is_some();
        let tracking = |name: &str| rev(&clone.dir, &format!("refs/remotes/origin/{name}")).is_some();
        let on_origin = |name: &str| rev(&origin.dir, &format!("refs/heads/{name}")).is_some();

        assert_eq!(delete("merged", false).unwrap(), DeleteBranchOutcome::Deleted);
        assert!(!local("merged") && !tracking("merged") && !on_origin("merged"));

        // Merged into its upstream isn't enough when the upstream goes too: nothing is deleted.
        assert_eq!(delete("unmerged", false).unwrap(), DeleteBranchOutcome::NotMerged);
        assert!(local("unmerged") && tracking("unmerged") && on_origin("unmerged"));
        assert_eq!(delete("unmerged", true).unwrap(), DeleteBranchOutcome::Deleted);
        assert!(!local("unmerged") && !tracking("unmerged") && !on_origin("unmerged"));

        // Someone pushed to it since the last fetch: even forced, nothing is deleted.
        origin.git(&["switch", "-q", "moved"]);
        origin.write("m.txt", "m\n");
        origin.commit_all("pushed by someone else");
        origin.git(&["switch", "-q", "main"]);
        let err = delete("moved", true).unwrap_err();
        assert!(err.contains("Fetch"), "{err}");
        assert!(local("moved") && on_origin("moved"));

        // Already deleted on the remote: the stale remote-tracking branch goes with the local one.
        origin.git(&["branch", "-D", "gone"]);
        assert_eq!(delete("gone", false).unwrap(), DeleteBranchOutcome::Deleted);
        assert!(!local("gone") && !tracking("gone"));

        // Without an upstream there is no remote branch to delete.
        assert!(delete("local-only", false).unwrap_err().contains("remote branch"));
        assert!(local("local-only") && on_origin("local-only"));
        // The current branch is refused before anything is deleted.
        assert!(delete("main", true).is_err());
        assert!(on_origin("main"));
    }

    #[test]
    fn parses_stash_list() {
        let out = [
            "aaa\x1fp1 p2 p3\x1f100\x1fOn main: my message: with colon",
            "bbb\x1fp1 p2\x1f90\x1fWIP on feature/x: abc1234 Subject",
            "ccc\x1fp1 p2\x1f80\x1fOn (no branch): detached",
        ]
        .join("\n");
        let s = parse_stashes(&out);
        assert_eq!(s.len(), 3);
        assert_eq!((s[0].index, s[0].sha.as_str(), s[0].time), (0, "aaa", 100));
        assert_eq!(s[0].message, "my message: with colon");
        assert_eq!(s[0].branch.as_deref(), Some("main"));
        assert!(s[0].untracked);
        assert_eq!(s[1].message, "WIP on feature/x: abc1234 Subject");
        assert_eq!(s[1].branch.as_deref(), Some("feature/x"));
        assert!(!s[1].untracked);
        assert_eq!((s[2].index, s[2].branch.as_deref()), (2, None));
    }

    #[test]
    fn stashes_applies_and_deletes() {
        let repo = TestRepo::new("stash");
        repo.write("a.txt", "one\n");
        repo.commit_all("first");
        let opts = |message: &str, include_untracked: bool| StashOptions {
            message: message.into(),
            include_untracked,
            keep_index: false,
        };
        assert!(
            stash_push(&repo.dir, &opts("", true))
                .unwrap_err()
                .contains("no local changes")
        );

        // Without untracked files, a new file stays behind.
        repo.write("a.txt", "two\n");
        repo.write("new.txt", "new\n");
        stash_push(&repo.dir, &opts("tracked only", false)).unwrap();
        assert_eq!(repo.read("a.txt"), "one\n");
        assert!(repo.dir.join("new.txt").exists());
        assert!(
            stash_push(&repo.dir, &opts("", false))
                .unwrap_err()
                .contains("untracked")
        );

        let newest = stash_push(&repo.dir, &opts("with new file", true)).unwrap();
        assert_eq!((newest.index, newest.message.as_str()), (0, "with new file"));
        assert!(!repo.dir.join("new.txt").exists());
        let list = stashes(&repo.dir).unwrap();
        assert_eq!(
            list.iter().map(|s| s.message.as_str()).collect::<Vec<_>>(),
            ["with new file", "tracked only"]
        );
        assert!(list[0].untracked && !list[1].untracked);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        // The untracked file is in the third parent, where the history view shows it from.
        let untracked = commit_details(&repo.dir, &format!("{}^3", list[0].sha)).unwrap();
        assert_eq!(untracked.files[0].path, "new.txt");

        // Pop the older one by its commit: the newer one keeps its place.
        let result = stash_apply(&repo.dir, &list[1].sha, true).unwrap();
        assert_eq!(result.outcome, StashApplyOutcome::Applied);
        assert_eq!(repo.read("a.txt"), "two\n");
        let left = stashes(&repo.dir).unwrap();
        assert_eq!((left.len(), left[0].sha.as_str()), (1, list[0].sha.as_str()));
        assert!(
            stash_apply(&repo.dir, &list[1].sha, false)
                .unwrap_err()
                .contains("doesn't exist")
        );

        // Applying keeps the stash.
        repo.git(&["checkout", "--", "a.txt"]);
        stash_apply(&repo.dir, &list[0].sha, false).unwrap();
        assert_eq!(repo.read("new.txt"), "new\n");
        assert_eq!(stashes(&repo.dir).unwrap().len(), 1);

        stash_drop(&repo.dir, &list[0].sha).unwrap();
        assert!(stashes(&repo.dir).unwrap().is_empty());
        assert!(stash_drop(&repo.dir, &list[0].sha).is_err());
        assert!(stash_drop(&repo.dir, "--all").is_err());
    }

    #[test]
    fn keeps_the_stash_when_applying_conflicts() {
        let repo = TestRepo::new("stash-conflict");
        repo.write("a.txt", "one\n");
        repo.commit_all("first");
        repo.write("a.txt", "stashed\n");
        stash_push(
            &repo.dir,
            &StashOptions {
                message: "change".into(),
                include_untracked: false,
                keep_index: false,
            },
        )
        .unwrap();
        let sha = stashes(&repo.dir).unwrap()[0].sha.clone();

        // Uncommitted changes to the same file: git refuses and nothing changes.
        repo.write("a.txt", "local\n");
        assert!(stash_apply(&repo.dir, &sha, true).unwrap_err().contains("a.txt"));
        assert_eq!(repo.read("a.txt"), "local\n");

        // Committed changes to the same file: applied with conflicts, the stash stays.
        repo.commit_all("committed");
        let result = stash_apply(&repo.dir, &sha, true).unwrap();
        assert_eq!((result.outcome, result.conflicts), (StashApplyOutcome::Conflicts, 1));
        assert_eq!(status(&repo.dir).unwrap().conflicted[0].path, "a.txt");
        assert_eq!(stashes(&repo.dir).unwrap().len(), 1);
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

    fn lfs_pointer(size: u64) -> String {
        format!(
            "version https://git-lfs.github.com/spec/v1\n\
             oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n\
             size {size}\n"
        )
    }

    #[test]
    fn recognizes_lfs_pointers() {
        assert_eq!(lfs_pointer_size(lfs_pointer(9).as_bytes()), Some(9));
        let legacy = lfs_pointer(9).replace("git-lfs.github.com", "hawser.github.com");
        assert_eq!(lfs_pointer_size(legacy.as_bytes()), Some(9));

        assert_eq!(lfs_pointer_size(b"version https://example.com/spec/v1\nsize 9\n"), None);
        assert_eq!(
            lfs_pointer_size(b"version https://git-lfs.github.com/spec/v1\nsize 9\n"),
            None
        );
        let no_size = lfs_pointer(9).replace("size 9\n", "");
        assert_eq!(lfs_pointer_size(no_size.as_bytes()), None);
        assert_eq!(
            lfs_pointer_size(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            None
        );
        assert_eq!(lfs_pointer_size(b""), None);
    }

    #[test]
    fn reads_files_stored_in_git_lfs() {
        let repo = TestRepo::new("lfs");
        // Stands in for Git LFS's smudge filter, so the test runs without Git LFS installed. A driver
        // name of its own keeps a Git LFS that is set up on this machine out of the test.
        repo.git(&["config", "filter.fakelfs.smudge", "cat >/dev/null; printf 'real file'"]);
        repo.write(".gitattributes", "*.png filter=fakelfs\n");
        repo.write("logo.png", &lfs_pointer(9));
        repo.write("huge.png", &lfs_pointer(50 * 1_048_576));
        // No attribute names a filter for GIFs, as when Git LFS isn't set up.
        repo.write("anim.gif", &lfs_pointer(9));
        let sha = repo.commit_all("add files stored in LFS");

        assert_eq!(
            file_at_revision(&repo.dir, &sha, "logo.png", 1024).unwrap(),
            b"real file"
        );
        // The size limit applies to the real file, not to its much smaller pointer.
        let too_large = file_at_revision(&repo.dir, &sha, "huge.png", 1024).unwrap_err();
        assert!(too_large.contains("too large to preview (50.0 MB"), "{too_large}");
        // Returning the pointer would show as a broken image; explain instead.
        let not_set_up = file_at_revision(&repo.dir, &sha, "anim.gif", 1024).unwrap_err();
        assert!(not_set_up.contains("Git LFS"), "{not_set_up}");
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

    fn fetch_opts(remote: Option<&str>, prune: bool) -> FetchOptions {
        FetchOptions {
            remote: remote.map(String::from),
            prune,
            ..FetchOptions::default()
        }
    }

    fn pull_opts(rebase: bool, autostash: bool) -> PullOptions {
        PullOptions {
            remote: "origin".into(),
            branch: "main".into(),
            rebase,
            autostash,
        }
    }

    fn no_progress(_: &str) {}

    #[test]
    fn fetch_reports_new_updated_and_pruned_branches_and_tags() {
        let origin = TestRepo::new("fetch-origin");
        origin.commit_all_initial();
        origin.git(&["branch", "doomed"]);
        let clone = TestRepo::clone_of(&origin, "fetch-clone");

        origin.write("more.txt", "more\n");
        origin.commit_all("more");
        origin.git(&["branch", "fresh"]);
        origin.git(&["branch", "-D", "doomed"]);
        origin.git(&["tag", "v1"]);

        let mut lines = Vec::new();
        let result = fetch(&clone.dir, &fetch_opts(Some("origin"), false), &mut |l| {
            lines.push(l.to_string())
        })
        .unwrap();
        assert_eq!(
            result,
            FetchResult {
                new_branches: vec!["origin/fresh".into()],
                updated_branches: vec!["origin/main".into()],
                deleted_branches: vec![],
                new_tags: vec!["v1".into()],
            }
        );
        // git's own report ("From …", "* [new branch] …") arrives as progress.
        assert!(lines.iter().any(|l| l.contains("fresh")), "{lines:?}");
        assert!(status(&clone.dir).unwrap().last_fetch.is_some());
        assert_eq!(status(&clone.dir).unwrap().behind, 1);

        // Branches deleted on the remote stay until pruned.
        assert!(
            branches(&clone.dir)
                .unwrap()
                .remote
                .iter()
                .any(|b| b.name == "origin/doomed")
        );
        let pruned = fetch(&clone.dir, &fetch_opts(None, true), &mut no_progress).unwrap();
        assert_eq!(pruned.deleted_branches, vec!["origin/doomed".to_string()]);
        assert!(
            branches(&clone.dir)
                .unwrap()
                .remote
                .iter()
                .all(|b| b.name != "origin/doomed")
        );

        assert_eq!(
            fetch(&clone.dir, &fetch_opts(None, true), &mut no_progress).unwrap(),
            FetchResult::default()
        );
    }

    #[test]
    fn fetches_all_tags_on_request_and_every_remote() {
        let origin = TestRepo::new("fetch-tags-origin");
        origin.commit_all_initial();
        let clone = TestRepo::clone_of(&origin, "fetch-tags-clone");
        let other = TestRepo::new("fetch-tags-other");
        other.commit_all_initial();
        clone.git(&["remote", "add", "other", other.dir.to_str().unwrap()]);
        assert_eq!(
            branches(&clone.dir)
                .unwrap()
                .remotes
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["origin", "other"]
        );

        // A tag on a commit outside the fetched history only comes with --tags.
        origin.git(&["switch", "-q", "-c", "side"]);
        origin.write("side.txt", "s\n");
        origin.commit_all("side");
        origin.git(&["tag", "side-tag"]);
        origin.git(&["switch", "-q", "main"]);
        origin.git(&["branch", "-D", "side"]);

        let all = fetch(&clone.dir, &fetch_opts(None, false), &mut no_progress).unwrap();
        assert_eq!(all.new_branches, vec!["other/main".to_string()]);
        assert!(all.new_tags.is_empty());

        let opts = FetchOptions {
            tags: true,
            ..fetch_opts(Some("origin"), false)
        };
        assert_eq!(
            fetch(&clone.dir, &opts, &mut no_progress).unwrap().new_tags,
            vec!["side-tag".to_string()]
        );
    }

    #[test]
    fn fetch_errors_are_readable() {
        let repo = TestRepo::new("fetch-errors");
        repo.commit_all_initial();
        let err = fetch(&repo.dir, &fetch_opts(Some("nowhere"), false), &mut no_progress).unwrap_err();
        assert!(err.contains("nowhere"), "{err}");
        let err = fetch(
            &repo.dir,
            &fetch_opts(Some("--upload-pack=touch x"), false),
            &mut no_progress,
        )
        .unwrap_err();
        assert!(err.contains("not a valid remote name"), "{err}");
        repo.git(&["remote", "add", "gone", "/does/not/exist/grit"]);
        let err = fetch(&repo.dir, &fetch_opts(Some("gone"), false), &mut no_progress).unwrap_err();
        assert!(err.contains("/does/not/exist/grit"), "{err}");
    }

    #[test]
    fn pulls_fast_forward_and_reports_up_to_date() {
        let origin = TestRepo::new("pull-ff-origin");
        origin.commit_all_initial();
        let clone = TestRepo::clone_of(&origin, "pull-ff-clone");
        for name in ["a", "b"] {
            origin.write(name, name);
            origin.commit_all(name);
        }

        let r = pull(&clone.dir, &pull_opts(false, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming), (PullOutcome::FastForward, 2));
        assert_eq!(clone.head(), origin.head());
        // The remote-tracking branch moved along, so the branch is no longer behind.
        assert_eq!(status(&clone.dir).unwrap().behind, 0);

        let r = pull(&clone.dir, &pull_opts(true, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming), (PullOutcome::UpToDate, 0));
    }

    /// An origin and a clone that both committed on main since the clone was made.
    fn diverged(name: &str) -> (TestRepo, TestRepo) {
        let origin = TestRepo::new(&format!("{name}-origin"));
        origin.write("shared.txt", "base\n");
        origin.commit_all("base");
        let clone = TestRepo::clone_of(&origin, &format!("{name}-clone"));
        origin.write("theirs.txt", "theirs\n");
        origin.commit_all("theirs");
        clone.write("ours.txt", "ours\n");
        clone.commit_all("ours");
        (origin, clone)
    }

    #[test]
    fn pulls_divergent_branches_with_a_merge() {
        let (origin, clone) = diverged("pull-merge");
        let before = clone.head();
        let r = pull(&clone.dir, &pull_opts(false, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming), (PullOutcome::Merge, 1));
        let parents = clone.git(&["rev-list", "--parents", "-n1", "HEAD"]);
        assert_eq!(
            parents.split_whitespace().skip(1).collect::<Vec<_>>(),
            [before, origin.head()]
        );
        assert!(status(&clone.dir).unwrap().operation.is_none());
    }

    #[test]
    fn pulls_divergent_branches_with_a_rebase() {
        let (origin, clone) = diverged("pull-rebase");
        let r = pull(&clone.dir, &pull_opts(true, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming, r.rebased), (PullOutcome::Rebase, 1, 1));
        assert_eq!(clone.git(&["rev-parse", "HEAD~1"]).trim(), origin.head());
        assert_eq!(clone.read("ours.txt"), "ours\n");
    }

    #[test]
    fn stashes_local_changes_around_a_pull_on_request() {
        let (_origin, clone) = diverged("pull-stash");
        clone.write("shared.txt", "local edit\n");

        // Rebasing refuses to start with uncommitted changes, and nothing changes.
        let before = clone.head();
        let err = pull(&clone.dir, &pull_opts(true, false), &mut no_progress).unwrap_err();
        assert!(err.to_lowercase().contains("unstaged changes"), "{err}");
        assert_eq!(clone.head(), before);

        let r = pull(&clone.dir, &pull_opts(true, true), &mut no_progress).unwrap();
        assert_eq!(r.outcome, PullOutcome::Rebase);
        assert_eq!(clone.read("shared.txt"), "local edit\n");
        assert_eq!(clone.git(&["stash", "list"]), "");
    }

    #[test]
    fn keeps_local_changes_in_the_stash_when_reapplying_them_conflicts() {
        let origin = TestRepo::new("pull-stash-conflict-origin");
        origin.write("f.txt", "base\n");
        origin.commit_all("base");
        let clone = TestRepo::clone_of(&origin, "pull-stash-conflict-clone");
        origin.write("f.txt", "theirs\n");
        origin.commit_all("theirs");
        clone.write("f.txt", "mine\n");

        let r = pull(&clone.dir, &pull_opts(false, true), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.conflicts), (PullOutcome::StashConflicts, 1));
        assert_eq!(clone.head(), origin.head());
        assert!(status(&clone.dir).unwrap().operation.is_none());
        assert_eq!(clone.git(&["stash", "list"]).lines().count(), 1);
    }

    /// Like `diverged`, but both sides changed the same line of shared.txt.
    fn conflicting(name: &str) -> (TestRepo, TestRepo) {
        let (origin, clone) = diverged(name);
        origin.write("shared.txt", "theirs\n");
        origin.commit_all("theirs edits shared");
        clone.write("shared.txt", "ours\n");
        clone.commit_all("ours edits shared");
        (origin, clone)
    }

    #[test]
    fn stops_a_conflicting_merge_for_the_user_to_abort_or_finish() {
        let (_origin, clone) = conflicting("pull-merge-conflict");
        let before = clone.head();

        let r = pull(&clone.dir, &pull_opts(false, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.conflicts, r.incoming), (PullOutcome::Conflicts, 1, 2));
        let op = status(&clone.dir).unwrap().operation.unwrap();
        assert_eq!(op.kind, OperationKind::Merge);
        let message = op.message.unwrap();
        assert!(message.starts_with("Merge branch 'main' of "), "{message}");
        assert!(!message.contains('#'), "{message}");

        // Pulling again is refused until the merge is finished.
        let err = pull(&clone.dir, &pull_opts(false, false), &mut no_progress).unwrap_err();
        assert!(err.contains("merge is in progress"), "{err}");
        assert!(skip_operation(&clone.dir).is_err());

        abort_operation(&clone.dir).unwrap();
        assert!(status(&clone.dir).unwrap().operation.is_none());
        assert_eq!(clone.head(), before);
        assert_eq!(clone.read("shared.txt"), "ours\n");
        assert!(abort_operation(&clone.dir).unwrap_err().contains("no merge or rebase"));

        // This time resolve the conflict and finish the merge with the prepared message.
        pull(&clone.dir, &pull_opts(false, false), &mut no_progress).unwrap();
        assert!(
            continue_operation(&clone.dir).is_err(),
            "unresolved conflicts must block"
        );
        clone.write("shared.txt", "both\n");
        stage(&clone.dir, &["shared.txt".into()]).unwrap();
        continue_operation(&clone.dir).unwrap();
        assert!(status(&clone.dir).unwrap().operation.is_none());
        let subject = clone.git(&["log", "-1", "--format=%s"]);
        assert!(subject.starts_with("Merge branch 'main' of "), "{subject}");
    }

    #[test]
    fn stops_a_conflicting_rebase_for_the_user_to_continue_skip_or_abort() {
        let (origin, clone) = conflicting("pull-rebase-conflict");
        let before = clone.head();

        let r = pull(&clone.dir, &pull_opts(true, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.conflicts), (PullOutcome::Conflicts, 1));
        let op = status(&clone.dir).unwrap().operation.unwrap();
        assert_eq!(op.kind, OperationKind::Rebase);
        assert_eq!(op.head.as_deref(), Some("main"));
        // "ours" applies cleanly, "ours edits shared" stops.
        assert_eq!((op.step, op.total), (Some(2), Some(2)));

        abort_operation(&clone.dir).unwrap();
        assert_eq!(clone.head(), before);
        assert_eq!(status(&clone.dir).unwrap().branch.as_deref(), Some("main"));

        // Resolve and continue: both local commits end up on top of the remote ones.
        pull(&clone.dir, &pull_opts(true, false), &mut no_progress).unwrap();
        let err = continue_operation(&clone.dir).unwrap_err();
        assert!(!err.is_empty());
        clone.write("shared.txt", "both\n");
        stage(&clone.dir, &["shared.txt".into()]).unwrap();
        continue_operation(&clone.dir).unwrap();
        assert!(status(&clone.dir).unwrap().operation.is_none());
        assert_eq!(clone.git(&["rev-parse", "HEAD~2"]).trim(), origin.head());
        assert_eq!(clone.git(&["log", "-1", "--format=%s"]).trim(), "ours edits shared");

        // Skipping drops the conflicting commit instead.
        let (origin, clone) = conflicting("pull-rebase-skip");
        pull(&clone.dir, &pull_opts(true, false), &mut no_progress).unwrap();
        skip_operation(&clone.dir).unwrap();
        assert!(status(&clone.dir).unwrap().operation.is_none());
        assert_eq!(clone.git(&["rev-parse", "HEAD~1"]).trim(), origin.head());
        assert_eq!(clone.read("shared.txt"), "theirs\n");
    }

    #[test]
    fn refuses_to_pull_without_a_branch_or_with_bad_arguments() {
        let origin = TestRepo::new("pull-refuse-origin");
        let first = origin.commit_all_initial();
        let clone = TestRepo::clone_of(&origin, "pull-refuse-clone");
        let bad = PullOptions {
            branch: "--exec=x".into(),
            ..pull_opts(false, false)
        };
        assert!(
            pull(&clone.dir, &bad, &mut no_progress)
                .unwrap_err()
                .contains("not a valid branch")
        );
        let missing = PullOptions {
            branch: "nope".into(),
            ..pull_opts(false, false)
        };
        assert!(
            pull(&clone.dir, &missing, &mut no_progress)
                .unwrap_err()
                .contains("nope")
        );

        clone.git(&["switch", "-q", "--detach", &first]);
        assert!(
            pull(&clone.dir, &pull_opts(false, false), &mut no_progress)
                .unwrap_err()
                .contains("detached")
        );
    }

    /// A bare repository to push to (a non-bare one refuses pushes to its checked-out branch).
    fn bare(name: &str) -> TestRepo {
        let dir = std::env::temp_dir().join(format!("grit-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q", "--bare", "-b", "main"]).unwrap();
        TestRepo { dir }
    }

    /// A bare origin with one commit on main and two clones of it.
    fn shared(name: &str) -> (TestRepo, TestRepo, TestRepo) {
        let origin = bare(&format!("{name}-origin"));
        let seed = TestRepo::clone_of(&origin, &format!("{name}-seed"));
        seed.commit_all_initial();
        seed.git(&["push", "-q", "origin", "main"]);
        let ours = TestRepo::clone_of(&origin, &format!("{name}-ours"));
        let theirs = TestRepo::clone_of(&origin, &format!("{name}-theirs"));
        (origin, ours, theirs)
    }

    fn push_opts(branch: &str, target: &str) -> PushOptions {
        PushOptions {
            branch: branch.into(),
            remote: "origin".into(),
            remote_branch: target.into(),
            set_upstream: false,
            tags: false,
            force: false,
        }
    }

    fn remote_head(origin: &TestRepo, branch: &str) -> Option<String> {
        rev(&origin.dir, &format!("refs/heads/{branch}"))
    }

    #[test]
    fn pushes_new_branches_fast_forwards_and_reports_up_to_date() {
        let (origin, ours, _theirs) = shared("push-ff");
        ours.write("a.txt", "a\n");
        ours.commit_all("a");
        ours.write("b.txt", "b\n");
        ours.commit_all("b");
        assert_eq!(status(&ours.dir).unwrap().ahead, 2);

        let mut lines = Vec::new();
        let r = push(&ours.dir, &push_opts("main", "main"), &mut |l| {
            lines.push(l.to_string())
        })
        .unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::Pushed, 2));
        assert_eq!(remote_head(&origin, "main"), Some(ours.head()));
        assert_eq!(status(&ours.dir).unwrap().ahead, 0);
        assert!(lines.iter().any(|l| l.starts_with("Writing objects")), "{lines:?}");

        let r = push(&ours.dir, &push_opts("main", "main"), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::UpToDate, 0));

        // A new branch, under another name on the remote, becomes the upstream on request.
        ours.git(&["switch", "-q", "-c", "feature"]);
        ours.write("c.txt", "c\n");
        ours.commit_all("c");
        let opts = PushOptions {
            set_upstream: true,
            ..push_opts("feature", "team/feature")
        };
        let r = push(&ours.dir, &opts, &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::NewBranch, 1));
        assert_eq!(remote_head(&origin, "team/feature"), Some(ours.head()));
        let st = status(&ours.dir).unwrap();
        assert_eq!(st.upstream.as_deref(), Some("origin/team/feature"));
        assert_eq!(st.ahead, 0);

        // A branch other than the current one can be pushed too.
        let r = push(&ours.dir, &push_opts("main", "copy"), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::NewBranch, 0));
    }

    #[test]
    fn force_pushes_only_over_commits_that_were_integrated() {
        let (origin, ours, theirs) = shared("push-force");
        theirs.write("theirs.txt", "theirs\n");
        theirs.commit_all("theirs");
        theirs.git(&["push", "-q", "origin", "main"]);
        let theirs_head = theirs.head();

        ours.write("ours.txt", "ours\n");
        ours.commit_all("ours");
        let r = push(&ours.dir, &push_opts("main", "main"), &mut no_progress).unwrap();
        assert_eq!(r.outcome, PushOutcome::Rejected);

        // Never fetched: the lease protects their commit.
        let force = PushOptions {
            force: true,
            ..push_opts("main", "main")
        };
        assert_eq!(
            push(&ours.dir, &force, &mut no_progress).unwrap().outcome,
            PushOutcome::Stale
        );
        // Fetched (as a background fetch would), but not integrated: still protected where git
        // supports --force-if-includes.
        fetch(&ours.dir, &fetch_opts(Some("origin"), false), &mut no_progress).unwrap();
        if git_version(&ours.dir).is_some_and(|v| v >= (2, 30)) {
            assert_eq!(
                push(&ours.dir, &force, &mut no_progress).unwrap().outcome,
                PushOutcome::Stale
            );
        }
        assert_eq!(remote_head(&origin, "main"), Some(theirs_head.clone()));

        // Integrated by a rebase, then rewritten: now the force push goes through.
        pull(&ours.dir, &pull_opts(true, false), &mut no_progress).unwrap();
        let r = push(&ours.dir, &push_opts("main", "main"), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::Pushed, 1));
        ours.git(&["commit", "-q", "--amend", "-m", "ours, reworded"]);
        assert_eq!(
            push(&ours.dir, &push_opts("main", "main"), &mut no_progress)
                .unwrap()
                .outcome,
            PushOutcome::Rejected
        );
        let r = push(&ours.dir, &force, &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::Forced, 1));
        assert_eq!(remote_head(&origin, "main"), Some(ours.head()));
        // Their commit is still there, below ours.
        assert!(is_ancestor(&origin.dir, &theirs_head, &ours.head()));
    }

    #[test]
    fn pushes_tags_without_ever_overwriting_them() {
        let (origin, ours, theirs) = shared("push-tags");
        theirs.git(&["tag", "v1"]);
        theirs.git(&["push", "-q", "origin", "v1"]);
        ours.write("a.txt", "a\n");
        ours.commit_all("a");
        ours.git(&["tag", "v1"]);
        ours.git(&["tag", "v2"]);

        // Not even a force push replaces their v1.
        let opts = PushOptions {
            tags: true,
            force: true,
            ..push_opts("main", "main")
        };
        let r = push(&ours.dir, &opts, &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.commits), (PushOutcome::Pushed, 1));
        assert_eq!(r.new_tags, vec!["v2".to_string()]);
        assert_eq!(r.rejected_tags, vec!["v1".to_string()]);
        assert_eq!(rev(&origin.dir, "refs/tags/v1"), rev(&theirs.dir, "refs/tags/v1"));
        assert_eq!(rev(&origin.dir, "refs/tags/v2"), Some(ours.head()));
    }

    #[test]
    fn refuses_to_push_bad_arguments_and_reports_errors() {
        let (_origin, ours, _theirs) = shared("push-errors");
        for (opts, message) in [
            (
                PushOptions {
                    remote: "--receive-pack=x".into(),
                    ..push_opts("main", "main")
                },
                "not a valid remote name",
            ),
            (push_opts("--all", "main"), "not a valid branch name"),
            (push_opts("main", "two words"), "'two words' is not a valid branch name"),
            (push_opts("main", "a:b"), "not a valid branch name"),
            (push_opts("nope", "nope"), "no local branch 'nope'"),
            (
                PushOptions {
                    remote: "nowhere".into(),
                    ..push_opts("main", "main")
                },
                "nowhere",
            ),
        ] {
            let err = push(&ours.dir, &opts, &mut no_progress).unwrap_err();
            assert!(err.contains(message), "{err}");
        }
    }

    #[test]
    fn parses_push_porcelain() {
        let out = "To /srv/origin.git\n\
                   =\trefs/heads/main:refs/heads/main\t[up to date]\n\
                   +\trefs/heads/a:refs/heads/team/a\tf82346d...821567d (forced update)\n\
                   !\trefs/tags/v1:refs/tags/v1\t[rejected] (already exists)\n\
                   Done\n";
        assert_eq!(
            parse_push_porcelain(out),
            vec![
                PushedRef {
                    flag: '=',
                    dst: "refs/heads/main",
                    summary: "[up to date]"
                },
                PushedRef {
                    flag: '+',
                    dst: "refs/heads/team/a",
                    summary: "f82346d...821567d (forced update)"
                },
                PushedRef {
                    flag: '!',
                    dst: "refs/tags/v1",
                    summary: "[rejected] (already exists)"
                },
            ]
        );
    }

    fn rebase_opts(onto: &str, autostash: bool) -> RebaseOptions {
        RebaseOptions {
            onto: onto.into(),
            autostash,
        }
    }

    /// main with one commit since `feature` branched off, and `feature` with two of its own,
    /// checked out. With `conflict`, both sides change the same line of shared.txt.
    fn feature_branch(name: &str, conflict: bool) -> TestRepo {
        let repo = TestRepo::new(name);
        repo.write("shared.txt", "base\n");
        repo.commit_all("base");
        repo.git(&["switch", "-q", "-c", "feature"]);
        repo.write("a.txt", "a\n");
        repo.commit_all("feature a");
        repo.write("shared.txt", if conflict { "feature\n" } else { "base\n" });
        repo.write("b.txt", "b\n");
        repo.commit_all("feature b");
        repo.git(&["switch", "-q", "main"]);
        repo.write("shared.txt", if conflict { "main\n" } else { "base\n" });
        repo.write("main.txt", "main\n");
        repo.commit_all("main moves on");
        repo.git(&["switch", "-q", "feature"]);
        repo
    }

    #[test]
    fn rebases_a_branch_onto_another() {
        let repo = feature_branch("rebase-onto", false);
        let main = repo.git(&["rev-parse", "main"]).trim().to_string();
        assert_eq!(
            divergence(&repo.dir, "main").unwrap(),
            Divergence { ahead: 2, behind: 1 }
        );

        let mut progress = Vec::new();
        let r = rebase(&repo.dir, &rebase_opts("main", false), &mut |p| {
            progress.push(p.to_string())
        })
        .unwrap();
        assert_eq!(
            (r.outcome, r.incoming, r.rebased, r.conflicts),
            (RebaseOutcome::Rebase, 1, 2, 0)
        );
        assert_eq!(repo.git(&["rev-parse", "HEAD~2"]).trim(), main);
        assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "feature b");
        assert_eq!(status(&repo.dir).unwrap().branch.as_deref(), Some("feature"));
        assert!(repo.dir.join("main.txt").exists());
        assert!(!progress.is_empty());
        assert_eq!(
            divergence(&repo.dir, "main").unwrap(),
            Divergence { ahead: 2, behind: 0 }
        );

        let r = rebase(&repo.dir, &rebase_opts("main", false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming, r.rebased), (RebaseOutcome::UpToDate, 0, 0));
    }

    #[test]
    fn rebasing_a_branch_without_own_commits_fast_forwards() {
        let repo = feature_branch("rebase-ff", false);
        repo.git(&["switch", "-q", "-c", "behind", "main~1"]);
        let r = rebase(&repo.dir, &rebase_opts("feature", false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming, r.rebased), (RebaseOutcome::FastForward, 2, 0));
        assert_eq!(repo.head(), repo.git(&["rev-parse", "feature"]).trim());
    }

    #[test]
    fn stashes_local_changes_around_a_rebase_on_request() {
        let repo = feature_branch("rebase-stash", false);
        repo.write("a.txt", "local edit\n");
        let before = repo.head();
        let err = rebase(&repo.dir, &rebase_opts("main", false), &mut no_progress).unwrap_err();
        assert!(err.to_lowercase().contains("unstaged changes"), "{err}");
        assert!(!err.contains("Rebasing ("), "{err}");
        assert_eq!(repo.head(), before);

        let r = rebase(&repo.dir, &rebase_opts("main", true), &mut no_progress).unwrap();
        assert_eq!(r.outcome, RebaseOutcome::Rebase);
        assert_eq!(repo.read("a.txt"), "local edit\n");
        assert_eq!(repo.git(&["stash", "list"]), "");
    }

    #[test]
    fn stops_a_conflicting_rebase_onto_a_branch() {
        let repo = feature_branch("rebase-conflict", true);
        let before = repo.head();

        let r = rebase(&repo.dir, &rebase_opts("main", false), &mut no_progress).unwrap();
        assert_eq!(
            (r.outcome, r.incoming, r.rebased, r.conflicts),
            (RebaseOutcome::Conflicts, 1, 2, 1)
        );
        let op = status(&repo.dir).unwrap().operation.unwrap();
        assert_eq!(op.kind, OperationKind::Rebase);
        assert_eq!(op.head.as_deref(), Some("feature"));
        assert_eq!((op.step, op.total), (Some(2), Some(2)));

        let err = rebase(&repo.dir, &rebase_opts("main", false), &mut no_progress).unwrap_err();
        assert!(err.contains("rebase is in progress"), "{err}");

        abort_operation(&repo.dir).unwrap();
        assert_eq!(repo.head(), before);
        assert_eq!(repo.read("shared.txt"), "feature\n");

        rebase(&repo.dir, &rebase_opts("main", false), &mut no_progress).unwrap();
        repo.write("shared.txt", "both\n");
        stage(&repo.dir, &["shared.txt".into()]).unwrap();
        continue_operation(&repo.dir).unwrap();
        assert!(status(&repo.dir).unwrap().operation.is_none());
        assert_eq!(
            repo.git(&["rev-parse", "HEAD~2"]).trim(),
            repo.git(&["rev-parse", "main"]).trim()
        );
    }

    #[test]
    fn refuses_to_rebase_without_a_branch_or_with_bad_arguments() {
        let repo = feature_branch("rebase-refuse", false);
        for (onto, expected) in [
            ("--exec=x", "not a valid"),
            ("", "not a valid"),
            ("nope", "'nope' is not a branch"),
        ] {
            let err = rebase(&repo.dir, &rebase_opts(onto, false), &mut no_progress).unwrap_err();
            assert!(err.contains(expected), "{onto}: {err}");
            assert!(divergence(&repo.dir, onto).is_err(), "{onto}");
        }
        repo.git(&["switch", "-q", "--detach", "HEAD"]);
        let err = rebase(&repo.dir, &rebase_opts("main", false), &mut no_progress).unwrap_err();
        assert!(err.contains("detached"), "{err}");
    }

    fn merge_opts(source: &str, mode: MergeMode, autostash: bool) -> MergeOptions {
        MergeOptions {
            source: source.into(),
            mode,
            autostash,
        }
    }

    fn parent_count(repo: &TestRepo) -> usize {
        repo.git(&["rev-list", "--parents", "-n1", "HEAD"])
            .split_whitespace()
            .count()
            - 1
    }

    #[test]
    fn merges_a_branch_with_a_merge_commit_or_fast_forward() {
        let repo = feature_branch("merge-modes", false);
        repo.git(&["switch", "-q", "main"]);
        let main = repo.head();

        // Diverged: --ff and --no-ff both create a merge commit, --ff-only refuses.
        let err = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::FfOnly, false),
            &mut no_progress,
        )
        .unwrap_err();
        assert!(err.contains("fast-forward"), "{err}");
        assert_eq!(repo.head(), main);

        let r = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Ff, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!((r.outcome, r.incoming, r.conflicts), (MergeOutcome::Merge, 2, 0));
        assert_eq!(parent_count(&repo), 2);
        assert_eq!(repo.git(&["rev-parse", "HEAD^1"]).trim(), main);
        assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "Merge branch 'feature'");
        assert!(repo.dir.join("a.txt").exists());

        let r = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Ff, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!((r.outcome, r.incoming), (MergeOutcome::UpToDate, 0));

        // feature is behind main now: it fast-forwards, unless a merge commit is asked for.
        repo.git(&["switch", "-q", "feature"]);
        let r = merge(
            &repo.dir,
            &merge_opts("main", MergeMode::FfOnly, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!((r.outcome, r.incoming), (MergeOutcome::FastForward, 2));
        assert_eq!(repo.head(), repo.git(&["rev-parse", "main"]).trim());

        repo.git(&["switch", "-q", "-c", "behind", "main~1"]);
        let r = merge(&repo.dir, &merge_opts("main", MergeMode::NoFf, false), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.incoming), (MergeOutcome::Merge, 3));
        assert_eq!(parent_count(&repo), 2);
    }

    #[test]
    fn merges_remote_branches_and_ignores_the_users_merge_config() {
        let repo = feature_branch("merge-config", false);
        repo.git(&["config", "merge.ff", "only"]);
        repo.git(&["update-ref", "refs/remotes/origin/feature", "feature"]);
        repo.git(&["switch", "-q", "main"]);
        let r = merge(
            &repo.dir,
            &merge_opts("origin/feature", MergeMode::Ff, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!(r.outcome, MergeOutcome::Merge);
        assert_eq!(
            repo.git(&["log", "-1", "--format=%s"]).trim(),
            "Merge remote-tracking branch 'origin/feature'"
        );
    }

    #[test]
    fn squash_merges_stage_the_changes_for_one_commit() {
        let repo = feature_branch("merge-squash", false);
        repo.git(&["switch", "-q", "main"]);
        let main = repo.head();

        let r = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Squash, true),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!((r.outcome, r.incoming), (MergeOutcome::Squash, 2));
        assert_eq!(repo.head(), main);
        let st = status(&repo.dir).unwrap();
        let staged: Vec<&str> = st.staged.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(staged, ["a.txt", "b.txt"]);
        let op = st.operation.unwrap();
        assert_eq!(op.kind, OperationKind::Squash);
        assert!(op.message.unwrap().starts_with("Squashed commit of the following:"));

        // Nothing else starts until the squash is committed or aborted.
        let err = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Squash, false),
            &mut no_progress,
        )
        .unwrap_err();
        assert!(err.contains("squash merge is in progress"), "{err}");
        assert!(skip_operation(&repo.dir).unwrap_err().contains("can't be skipped"));

        abort_operation(&repo.dir).unwrap();
        let st = status(&repo.dir).unwrap();
        assert!(st.operation.is_none() && st.staged.is_empty() && st.unstaged.is_empty());
        assert!(!repo.dir.join("a.txt").exists());

        // Committing with your own message ends it, like with the prepared one.
        merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Squash, false),
            &mut no_progress,
        )
        .unwrap();
        commit(&repo.dir, "Add a and b", false).unwrap();
        assert!(status(&repo.dir).unwrap().operation.is_none());
        assert_eq!(parent_count(&repo), 1);
        assert_eq!(repo.git(&["rev-parse", "HEAD~1"]).trim(), main);

        repo.git(&["reset", "-q", "--hard", &main]);
        merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Squash, false),
            &mut no_progress,
        )
        .unwrap();
        continue_operation(&repo.dir).unwrap();
        assert!(status(&repo.dir).unwrap().operation.is_none());
        assert_eq!(
            repo.git(&["log", "-1", "--format=%s"]).trim(),
            "Squashed commit of the following:"
        );

        let r = merge(
            &repo.dir,
            &merge_opts("main~1", MergeMode::Squash, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!(r.outcome, MergeOutcome::UpToDate);
        assert!(status(&repo.dir).unwrap().operation.is_none());
    }

    #[test]
    fn stops_a_conflicting_merge_of_a_branch() {
        let repo = feature_branch("merge-conflict", true);
        repo.git(&["switch", "-q", "main"]);
        let before = repo.head();

        let r = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Ff, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!((r.outcome, r.incoming, r.conflicts), (MergeOutcome::Conflicts, 2, 1));
        let op = status(&repo.dir).unwrap().operation.unwrap();
        assert_eq!(op.kind, OperationKind::Merge);
        assert!(op.message.unwrap().starts_with("Merge branch 'feature'"));

        abort_operation(&repo.dir).unwrap();
        assert_eq!(repo.head(), before);
        assert_eq!(repo.read("shared.txt"), "main\n");

        // A conflicting squash merge waits the same way and is aborted with `reset --merge`.
        let r = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Squash, false),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!((r.outcome, r.conflicts), (MergeOutcome::Conflicts, 1));
        assert_eq!(
            status(&repo.dir).unwrap().operation.unwrap().kind,
            OperationKind::Squash
        );
        assert!(
            continue_operation(&repo.dir).is_err(),
            "unresolved conflicts must block"
        );
        abort_operation(&repo.dir).unwrap();
        let st = status(&repo.dir).unwrap();
        assert!(st.operation.is_none() && st.conflicted.is_empty() && st.staged.is_empty());
        assert_eq!(repo.read("shared.txt"), "main\n");

        merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::NoFf, false),
            &mut no_progress,
        )
        .unwrap();
        repo.write("shared.txt", "both\n");
        stage(&repo.dir, &["shared.txt".into()]).unwrap();
        continue_operation(&repo.dir).unwrap();
        assert!(status(&repo.dir).unwrap().operation.is_none());
        assert_eq!(parent_count(&repo), 2);
    }

    #[test]
    fn stashes_local_changes_around_a_merge_on_request() {
        let repo = feature_branch("merge-stash", false);
        repo.git(&["switch", "-q", "main"]);
        // Touches a file the merge brings in, so git refuses without stashing.
        repo.write("a.txt", "local\n");
        repo.git(&["add", "a.txt"]);
        let before = repo.head();
        let err = merge(
            &repo.dir,
            &merge_opts("feature", MergeMode::Ff, false),
            &mut no_progress,
        )
        .unwrap_err();
        assert!(err.contains("a.txt"), "{err}");
        assert_eq!(repo.head(), before);

        let r = merge(&repo.dir, &merge_opts("feature", MergeMode::Ff, true), &mut no_progress).unwrap();
        assert_eq!((r.outcome, r.conflicts), (MergeOutcome::StashConflicts, 1));
        assert_eq!(parent_count(&repo), 2);
        assert!(status(&repo.dir).unwrap().operation.is_none());
        assert_eq!(repo.git(&["stash", "list"]).lines().count(), 1);
    }

    #[test]
    fn refuses_to_merge_without_a_branch_or_with_bad_arguments() {
        let repo = feature_branch("merge-refuse", false);
        for (source, expected) in [
            ("--squash", "not a valid"),
            ("", "not a valid"),
            ("nope", "'nope' is not a branch"),
        ] {
            let err = merge(&repo.dir, &merge_opts(source, MergeMode::Ff, false), &mut no_progress).unwrap_err();
            assert!(err.contains(expected), "{source}: {err}");
        }
        repo.git(&["switch", "-q", "--detach", "HEAD"]);
        let err = merge(&repo.dir, &merge_opts("main", MergeMode::Ff, false), &mut no_progress).unwrap_err();
        assert!(err.contains("detached"), "{err}");
    }

    #[test]
    fn remembers_the_previous_branch() {
        let repo = feature_branch("previous-branch", false);
        assert_eq!(branches(&repo.dir).unwrap().previous.as_deref(), Some("main"));
        repo.git(&["switch", "-q", "main"]);
        assert_eq!(branches(&repo.dir).unwrap().previous.as_deref(), Some("feature"));
        repo.git(&["switch", "-q", "--detach", "HEAD"]);
        repo.git(&["switch", "-q", "main"]);
        assert_eq!(branches(&repo.dir).unwrap().previous, None);
        repo.git(&["switch", "-q", "feature"]);
        repo.git(&["switch", "-q", "main"]);
        repo.git(&["branch", "-q", "-D", "feature"]);
        assert_eq!(branches(&repo.dir).unwrap().previous, None);
    }

    #[test]
    fn detects_cherry_picks_in_progress() {
        let repo = TestRepo::new("cherry-pick");
        repo.write("f.txt", "base\n");
        repo.commit_all("base");
        repo.git(&["switch", "-q", "-c", "other"]);
        repo.write("f.txt", "other\n");
        let pick = repo.commit_all("other");
        repo.git(&["switch", "-q", "main"]);
        repo.write("f.txt", "main\n");
        repo.commit_all("main");
        assert!(run(&repo.dir, &["cherry-pick", &pick]).is_err());

        let op = status(&repo.dir).unwrap().operation.unwrap();
        assert_eq!(op.kind, OperationKind::CherryPick);
        abort_operation(&repo.dir).unwrap();
        assert!(status(&repo.dir).unwrap().operation.is_none());
        assert_eq!(repo.read("f.txt"), "main\n");
    }

    #[test]
    fn background_fetches_never_prompt() {
        let repo = TestRepo::new("network-env");
        assert!(network_env(&repo.dir, false).is_empty());
        let env = network_env(&repo.dir, true);
        assert!(env.contains(&("GCM_INTERACTIVE", "never")));
        if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
            assert!(env.contains(&("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")));
        }
        // A configured ssh command is the user's choice and is left alone.
        repo.git(&["config", "core.sshCommand", "ssh -i ~/.ssh/work"]);
        assert!(
            network_env(&repo.dir, true)
                .iter()
                .all(|(k, _)| *k != "GIT_SSH_COMMAND")
        );
    }

    #[test]
    fn parses_remotes() {
        let remotes = parse_remotes(
            "origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n\
             up stream\t/path with space (fetch)\nup stream\t/path with space (push)\n",
        );
        assert_eq!(
            remotes,
            vec![
                Remote {
                    name: "origin".into(),
                    url: "git@github.com:a/b.git".into()
                },
                Remote {
                    name: "up stream".into(),
                    url: "/path with space".into()
                },
            ]
        );
    }

    #[test]
    fn cleans_progress_out_of_errors() {
        let stderr = "remote: Enumerating objects: 5, done.\n\
                      remote: Counting objects:  50% (2/4)\rremote: Counting objects: 100% (4/4), done.\n\
                      Receiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\n\
                      fatal: unable to access 'https://example.com/': Could not resolve host\n";
        assert_eq!(
            error_text(stderr, "fallback"),
            "fatal: unable to access 'https://example.com/': Could not resolve host"
        );
        assert_eq!(error_text("Receiving objects: 100% (1/1)\n", "fallback"), "fallback");
    }

    #[test]
    fn diffs_ref_snapshots() {
        let snapshot = |refs: &[(&str, &str)]| -> HashMap<String, String> {
            refs.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect()
        };
        let before = snapshot(&[
            ("refs/remotes/origin/main", "1"),
            ("refs/remotes/origin/old", "2"),
            ("refs/tags/v1", "3"),
        ]);
        let after = snapshot(&[
            ("refs/remotes/origin/main", "4"),
            ("refs/remotes/origin/b", "5"),
            ("refs/remotes/origin/a", "5"),
            ("refs/tags/v1", "3"),
            ("refs/tags/v2", "6"),
        ]);
        assert_eq!(
            FetchResult::diff(&before, &after),
            FetchResult {
                new_branches: vec!["origin/a".into(), "origin/b".into()],
                updated_branches: vec!["origin/main".into()],
                deleted_branches: vec!["origin/old".into()],
                new_tags: vec!["v2".into()],
            }
        );
    }
}
