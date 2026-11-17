mod git;
mod graph;
#[cfg(target_os = "macos")]
mod menu;
mod settings;
mod watcher;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, ipc::Response};

use git::{
    Branches, CommitDetails, FetchOptions, FetchResult, GitResult, LogEntry, PullOptions, PullResult, RepoInfo, Status,
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
async fn commit(repo: String, message: String, amend: bool) -> GitResult<()> {
    blocking(move || git::commit(&PathBuf::from(repo), &message, amend)).await
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
async fn create_branch(repo: String, name: String) -> GitResult<()> {
    blocking(move || git::create_branch(&PathBuf::from(repo), &name)).await
}

/// A progress line of a running fetch or pull, e.g. "Receiving objects:  45% (450/1000)".
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
            commit,
            checkout_branch,
            checkout_remote_branch,
            create_branch,
            fetch,
            pull,
            abort_operation,
            continue_operation,
            skip_operation,
            get_settings,
            set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
