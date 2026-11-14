//! Watches the working tree and git directory and tells the frontend to refresh.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<Debouncer<RecommendedWatcher>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    /// Working tree or index changed: status needs a refresh.
    worktree: bool,
    /// Branches, tags or HEAD moved: history needs a refresh.
    refs: bool,
}

#[derive(Default)]
struct Changes {
    worktree: bool,
    refs: bool,
}

fn classify(path: &Path, git_dir: &Path, changes: &mut Changes) {
    let Ok(rel) = path.strip_prefix(git_dir) else {
        changes.worktree = true;
        return;
    };
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str.starts_with("objects") || rel_str.starts_with("logs") || rel_str.ends_with(".lock") {
        return;
    }
    if rel_str == "HEAD" || rel_str == "packed-refs" || rel_str.starts_with("refs") {
        changes.refs = true;
    }
    // index, MERGE_HEAD, rebase state etc. all affect the status view.
    changes.worktree = true;
}

pub fn watch(app: AppHandle, root: &str, git_dir: &str) -> Result<Debouncer<RecommendedWatcher>, String> {
    let root: PathBuf = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    let git_dir: PathBuf = dunce::canonicalize(git_dir).map_err(|e| e.to_string())?;
    let git_dir_for_cb = git_dir.clone();

    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut changes = Changes::default();
        for event in events {
            classify(&event.path, &git_dir_for_cb, &mut changes);
        }
        if changes.worktree || changes.refs {
            let _ = app.emit("repo-changed", RepoChanged { worktree: changes.worktree, refs: changes.refs });
        }
    })
    .map_err(|e| e.to_string())?;

    debouncer.watcher().watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    if !git_dir.starts_with(&root) {
        // Linked worktrees and submodules keep their git dir elsewhere.
        debouncer.watcher().watch(&git_dir, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    }
    Ok(debouncer)
}
