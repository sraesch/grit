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
    pub remotes: Vec<Remote>,
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

// ---------------------------------------------------------------------------
// Fetch and pull
// ---------------------------------------------------------------------------

/// Output of a git command that talks to a remote. The exit code is returned rather than
/// turned into an error, because a failed pull can still leave a state to report (conflicts).
struct NetOutput {
    code: i32,
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
    // while we are reading stderr.
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let stdout_reader = std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = stdout.read_to_end(&mut sink);
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
    let _ = stdout_reader.join();
    Ok(NetOutput {
        code: status.code().unwrap_or(-1),
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
    const PHASES: [&str; 10] = [
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
    if run(repo, &["symbolic-ref", "-q", "HEAD"]).is_err() {
        return Err("Pulling needs a current branch, but HEAD is detached. Switch to a branch first.".into());
    }
    if let Some(op) = operation(&git_dir(repo)?) {
        return Err(format!(
            "A {} is in progress. Finish or abort it before pulling.",
            op.kind.label()
        ));
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
// Merge, rebase, cherry-pick and revert in progress
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl OperationKind {
    fn label(self) -> &'static str {
        match self {
            OperationKind::Merge => "merge",
            OperationKind::Rebase => "rebase",
            OperationKind::CherryPick => "cherry-pick",
            OperationKind::Revert => "revert",
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
    /// The prepared commit message (`MERGE_MSG` without comments), for merges.
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
    if git_dir.join("MERGE_HEAD").exists() {
        let message = std::fs::read_to_string(git_dir.join("MERGE_MSG")).ok().map(|m| {
            m.lines()
                .filter(|l| !l.starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string()
        });
        return Some(Operation {
            message: message.filter(|m| !m.is_empty()),
            ..blank(OperationKind::Merge)
        });
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some(blank(OperationKind::CherryPick));
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some(blank(OperationKind::Revert));
    }
    None
}

fn current_operation(repo: &Path) -> GitResult<Operation> {
    operation(&git_dir(repo)?).ok_or_else(|| "There is no merge or rebase in progress.".to_string())
}

/// Gives up the operation in progress and returns to the state before it started.
pub fn abort_operation(repo: &Path) -> GitResult<()> {
    let op = current_operation(repo)?;
    run(repo, &[op.kind.label(), "--abort"]).map(drop)
}

/// Continues after the conflicts were resolved and staged. A merge is finished by committing
/// with its prepared message.
pub fn continue_operation(repo: &Path) -> GitResult<()> {
    let op = current_operation(repo)?;
    let args: &[&str] = match op.kind {
        OperationKind::Merge => &["commit", "--no-edit"],
        kind => &[kind.label(), "--continue"],
    };
    // Accept the prepared messages instead of waiting for an editor that never opens.
    exec_with_env(repo, args, &[("GIT_EDITOR", "true")]).map(drop)
}

/// Skips the commit that stopped a rebase, cherry-pick or revert.
pub fn skip_operation(repo: &Path) -> GitResult<()> {
    let op = current_operation(repo)?;
    if op.kind == OperationKind::Merge {
        return Err("A merge can't be skipped; abort it instead.".into());
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
            origin.git(&["clone", "-q", origin.dir.to_str().unwrap(), clone.dir.to_str().unwrap()]);
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
