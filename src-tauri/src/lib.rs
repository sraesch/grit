mod git;
mod graph;
mod watcher;

use std::path::PathBuf;

use tauri::{AppHandle, State};

use git::{Branches, CommitDetails, GitResult, LogEntry, RepoInfo, Status};
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
    // Replacing the old debouncer drops it, which stops watching the previous repo.
    *watch.0.lock().map_err(|e| e.to_string())? = Some(debouncer);
    Ok(info)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            get_status,
            get_log,
            get_branches,
            get_working_diff,
            get_commit_details,
            get_commit_file_diff,
            stage,
            stage_all,
            unstage,
            unstage_all,
            commit,
            checkout_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
