mod git;
mod graph;
#[cfg(target_os = "macos")]
mod menu;
mod patch;
mod settings;
mod watcher;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, ipc::Response};

use git::{
    Branches, CommitDetails, DeleteBranchOutcome, Divergence, FetchOptions, FetchResult, GitResult, LogEntry,
    MergeMode, MergeOptions, MergeResult, PatchAction, PickOptions, PickResult, PullOptions, PullResult, PushOptions,
    PushResult, RebaseOptions, RebaseResult, RepoInfo, Stash, StashApplyResult, StashOptions, Status,
};
use settings::{Settings, SettingsStore};
use watcher::WatchState;

/// Runs blocking git work off the async runtime so the UI never stalls.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> GitResult<T> + Send + 'static) -> GitResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_repo(app: AppHandle, watch: State<'_, WatchState>, path: String) -> GitResult<RepoInfo> {
    let info = blocking(move || git::open_repo(&PathBuf::from(path))).await?;
    let debouncer = watcher::watch(app, &info.root, &info.git_dir)?;
    // Several repositories can be open in tabs; reopening one replaces (and stops) its old watcher.
    watch
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(info.root.clone(), debouncer);
    Ok(info)
}

/// Whether `path` is inside a repository, so Open… can offer to initialize other folders.
#[tauri::command]
async fn is_repository(path: String) -> GitResult<bool> {
    blocking(move || Ok(git::is_repository(&PathBuf::from(path)))).await
}

/// The branch name new repositories start with.
#[tauri::command]
async fn default_branch_name() -> GitResult<String> {
    blocking(|| Ok(git::default_branch_name())).await
}

/// Creates a repository; the frontend then opens it with `open_repo`.
#[tauri::command]
async fn init_repo(path: String, branch: String) -> GitResult<RepoInfo> {
    blocking(move || git::init_repo(&PathBuf::from(path), &branch)).await
}

/// Clones a repository; progress arrives as `git-progress` events whose `root` is `dest`.
/// The frontend then opens it with `open_repo`.
#[tauri::command]
async fn clone_repo(app: AppHandle, url: String, dest: String, branch: Option<String>) -> GitResult<RepoInfo> {
    blocking(move || {
        let mut progress = progress_emitter(app, dest.clone());
        git::clone_repo(&url, &PathBuf::from(&dest), branch.as_deref(), &mut progress)
    })
    .await
}

/// Stops watching a repository whose tab was closed.
#[tauri::command]
fn close_repo(watch: State<'_, WatchState>, root: String) -> GitResult<()> {
    watch.0.lock().map_err(|e| e.to_string())?.remove(&root);
    Ok(())
}

#[tauri::command]
async fn get_status(repo: String) -> GitResult<Status> {
    blocking(move || git::status(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn get_log(repo: String, limit: Option<usize>) -> GitResult<Vec<LogEntry>> {
    blocking(move || git::log(&PathBuf::from(repo), limit.unwrap_or(10_000))).await
}

#[tauri::command]
async fn get_branches(repo: String) -> GitResult<Branches> {
    blocking(move || git::branches(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn get_working_diff(repo: String, path: String, staged: bool, untracked: bool) -> GitResult<String> {
    blocking(move || git::working_diff(&PathBuf::from(repo), &path, staged, untracked)).await
}

#[tauri::command]
async fn get_commit_details(repo: String, sha: String) -> GitResult<CommitDetails> {
    blocking(move || git::commit_details(&PathBuf::from(repo), &sha)).await
}

#[tauri::command]
async fn get_commit_file_diff(repo: String, sha: String, path: String, orig_path: Option<String>) -> GitResult<String> {
    blocking(move || git::commit_file_diff(&PathBuf::from(repo), &sha, &path, orig_path.as_deref())).await
}

/// Largest file `get_file_at_revision` returns, to keep previews of huge assets from stalling the UI.
const MAX_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;

/// Raw file contents at a revision, sent as binary (an ArrayBuffer in the frontend) rather than JSON.
#[tauri::command]
async fn get_file_at_revision(repo: String, rev: String, path: String) -> GitResult<Response> {
    let bytes = blocking(move || git::file_at_revision(&PathBuf::from(repo), &rev, &path, MAX_PREVIEW_BYTES)).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn stage(repo: String, paths: Vec<String>) -> GitResult<()> {
    blocking(move || git::stage(&PathBuf::from(repo), &paths)).await
}

#[tauri::command]
async fn stage_all(repo: String) -> GitResult<()> {
    blocking(move || git::stage_all(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn unstage(repo: String, paths: Vec<String>) -> GitResult<()> {
    blocking(move || git::unstage(&PathBuf::from(repo), &paths)).await
}

#[tauri::command]
async fn unstage_all(repo: String) -> GitResult<()> {
    blocking(move || git::unstage_all(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn discard(repo: String, tracked: Vec<String>, untracked: Vec<String>) -> GitResult<()> {
    blocking(move || git::discard(&PathBuf::from(repo), &tracked, &untracked)).await
}

#[tauri::command]
async fn apply_selection(
    repo: String,
    path: String,
    staged: bool,
    untracked: bool,
    action: PatchAction,
    selection: Vec<patch::HunkSelection>,
) -> GitResult<()> {
    blocking(move || git::apply_selection(&PathBuf::from(repo), &path, staged, untracked, action, &selection)).await
}

#[tauri::command]
async fn add_to_gitignore(repo: String, pattern: String) -> GitResult<()> {
    blocking(move || git::add_to_gitignore(&PathBuf::from(repo), &pattern)).await
}

#[tauri::command]
async fn commit(repo: String, message: String, amend: bool) -> GitResult<()> {
    blocking(move || git::commit(&PathBuf::from(repo), &message, amend)).await
}

#[tauri::command]
async fn add_remote(repo: String, name: String, url: String) -> GitResult<()> {
    blocking(move || git::add_remote(&PathBuf::from(repo), &name, &url)).await
}

#[tauri::command]
async fn rename_remote(repo: String, name: String, new_name: String) -> GitResult<()> {
    blocking(move || git::rename_remote(&PathBuf::from(repo), &name, &new_name)).await
}

#[tauri::command]
async fn set_remote_url(repo: String, name: String, url: String) -> GitResult<()> {
    blocking(move || git::set_remote_url(&PathBuf::from(repo), &name, &url)).await
}

#[tauri::command]
async fn remove_remote(repo: String, name: String) -> GitResult<()> {
    blocking(move || git::remove_remote(&PathBuf::from(repo), &name)).await
}

#[tauri::command]
async fn checkout_branch(repo: String, branch: String) -> GitResult<()> {
    blocking(move || git::checkout(&PathBuf::from(repo), &branch)).await
}

#[tauri::command]
async fn checkout_remote_branch(repo: String, branch: String) -> GitResult<()> {
    blocking(move || git::checkout_remote(&PathBuf::from(repo), &branch)).await
}

#[tauri::command]
async fn checkout_commit(repo: String, sha: String) -> GitResult<()> {
    blocking(move || git::checkout_commit(&PathBuf::from(repo), &sha)).await
}

#[tauri::command]
async fn create_branch(repo: String, name: String, start: Option<String>, checkout: Option<bool>) -> GitResult<()> {
    blocking(move || git::create_branch(&PathBuf::from(repo), &name, start.as_deref(), checkout.unwrap_or(true))).await
}

/// A progress line of a running fetch, pull, push, rebase or merge, e.g. "Receiving objects:  45% (450/1000)".
#[derive(Serialize, Clone)]
struct GitProgress {
    /// The repository root, as passed to the command, so only its tab shows the progress.
    root: String,
    text: String,
}

/// Emits git's progress output as `git-progress` events for the repository's tab.
fn progress_emitter(app: AppHandle, root: String) -> impl FnMut(&str) {
    move |text: &str| {
        let _ = app.emit(
            "git-progress",
            GitProgress {
                root: root.clone(),
                text: text.to_string(),
            },
        );
    }
}

#[tauri::command]
async fn fetch(
    app: AppHandle,
    repo: String,
    remote: Option<String>,
    prune: bool,
    tags: bool,
    background: bool,
) -> GitResult<FetchResult> {
    blocking(move || {
        let opts = FetchOptions {
            remote,
            prune,
            tags,
            background,
        };
        let path = PathBuf::from(&repo);
        if background {
            // Nobody watches an automatic fetch, so its progress isn't sent.
            git::fetch(&path, &opts, &mut |_| {})
        } else {
            git::fetch(&path, &opts, &mut progress_emitter(app, repo))
        }
    })
    .await
}

#[tauri::command]
async fn pull(
    app: AppHandle,
    repo: String,
    remote: String,
    branch: String,
    rebase: bool,
    autostash: bool,
) -> GitResult<PullResult> {
    blocking(move || {
        let opts = PullOptions {
            remote,
            branch,
            rebase,
            autostash,
        };
        git::pull(&PathBuf::from(&repo), &opts, &mut progress_emitter(app, repo.clone()))
    })
    .await
}

// Flat arguments, like fetch and pull, so the frontend passes its options object spread out.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn push(
    app: AppHandle,
    repo: String,
    branch: String,
    remote: String,
    remote_branch: String,
    set_upstream: bool,
    tags: bool,
    force: bool,
) -> GitResult<PushResult> {
    blocking(move || {
        let opts = PushOptions {
            branch,
            remote,
            remote_branch,
            set_upstream,
            tags,
            force,
        };
        git::push(&PathBuf::from(&repo), &opts, &mut progress_emitter(app, repo.clone()))
    })
    .await
}

#[tauri::command]
async fn get_stashes(repo: String) -> GitResult<Vec<Stash>> {
    blocking(move || git::stashes(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn stash(repo: String, options: StashOptions) -> GitResult<Stash> {
    blocking(move || git::stash_push(&PathBuf::from(repo), &options)).await
}

#[tauri::command]
async fn apply_stash(repo: String, sha: String, pop: bool) -> GitResult<StashApplyResult> {
    blocking(move || git::stash_apply(&PathBuf::from(repo), &sha, pop)).await
}

#[tauri::command]
async fn drop_stash(repo: String, sha: String) -> GitResult<()> {
    blocking(move || git::stash_drop(&PathBuf::from(repo), &sha)).await
}

/// Progress of deleting the remote branch arrives as `git-progress` events.
/// Deletes a branch on its remote; progress arrives as `git-progress` events.
#[tauri::command]
async fn delete_remote_branch(app: AppHandle, repo: String, remote: String, branch: String) -> GitResult<()> {
    blocking(move || {
        let mut progress = progress_emitter(app, repo.clone());
        git::delete_remote_branch(&PathBuf::from(&repo), &remote, &branch, &mut progress)
    })
    .await
}

#[tauri::command]
async fn delete_branch(
    app: AppHandle,
    repo: String,
    name: String,
    force: bool,
    delete_remote: bool,
) -> GitResult<DeleteBranchOutcome> {
    blocking(move || {
        let path = PathBuf::from(&repo);
        git::delete_branch(&path, &name, force, delete_remote, &mut progress_emitter(app, repo))
    })
    .await
}

#[tauri::command]
async fn get_divergence(repo: String, base: String) -> GitResult<Divergence> {
    blocking(move || git::divergence(&PathBuf::from(repo), &base)).await
}

#[tauri::command]
async fn rebase(app: AppHandle, repo: String, onto: String, autostash: bool) -> GitResult<RebaseResult> {
    blocking(move || {
        let opts = RebaseOptions { onto, autostash };
        git::rebase(&PathBuf::from(&repo), &opts, &mut progress_emitter(app, repo.clone()))
    })
    .await
}

#[tauri::command]
async fn merge(
    app: AppHandle,
    repo: String,
    source: String,
    mode: MergeMode,
    autostash: bool,
) -> GitResult<MergeResult> {
    blocking(move || {
        let opts = MergeOptions {
            source,
            mode,
            autostash,
        };
        git::merge(&PathBuf::from(&repo), &opts, &mut progress_emitter(app, repo.clone()))
    })
    .await
}

#[tauri::command]
async fn cherry_pick(repo: String, commit: String, no_commit: bool, mainline: Option<u32>) -> GitResult<PickResult> {
    blocking(move || {
        let opts = PickOptions {
            commit,
            no_commit,
            mainline,
        };
        git::cherry_pick(&PathBuf::from(repo), &opts)
    })
    .await
}

#[tauri::command]
async fn abort_operation(repo: String) -> GitResult<()> {
    blocking(move || git::abort_operation(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn continue_operation(repo: String) -> GitResult<()> {
    blocking(move || git::continue_operation(&PathBuf::from(repo))).await
}

#[tauri::command]
async fn skip_operation(repo: String) -> GitResult<()> {
    blocking(move || git::skip_operation(&PathBuf::from(repo))).await
}

#[tauri::command]
fn get_settings(store: State<'_, SettingsStore>) -> Settings {
    store.get()
}

#[tauri::command]
fn set_settings(store: State<'_, SettingsStore>, settings: Settings) -> Result<Settings, String> {
    store.update(settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Elsewhere there is no app menu; the toolbar's settings button and Ctrl+, open the settings.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("settings.json");
            app.manage(SettingsStore::load(path, app.path().home_dir().ok()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_repo,
            close_repo,
            is_repository,
            default_branch_name,
            init_repo,
            clone_repo,
            get_status,
            get_log,
            get_branches,
            get_working_diff,
            get_commit_details,
            get_commit_file_diff,
            get_file_at_revision,
            stage,
            stage_all,
            unstage,
            unstage_all,
            discard,
            add_to_gitignore,
            apply_selection,
            commit,
            checkout_branch,
            checkout_remote_branch,
            checkout_commit,
            create_branch,
            delete_branch,
            delete_remote_branch,
            get_stashes,
            stash,
            apply_stash,
            drop_stash,
            add_remote,
            rename_remote,
            set_remote_url,
            remove_remote,
            fetch,
            pull,
            push,
            get_divergence,
            rebase,
            merge,
            cherry_pick,
            abort_operation,
            continue_operation,
            skip_operation,
            get_settings,
            set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
