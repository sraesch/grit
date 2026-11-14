# Git Utils

A cross-platform (Windows, macOS, Linux) interactive Git client built with Tauri 2, Rust and React.

## Features

- **Local changes**: unstaged/staged file lists, per-file diff, stage/unstage (button or double-click), stage/unstage all, commit and amend (Ctrl/Cmd+Enter)
- **History**: virtualized commit list with branch graph, ref badges, keyboard navigation, commit details, changed files and diffs
- **Branches**: local, remote and tag lists; double-click a local branch to check it out
- **Live refresh**: the working tree and `.git` are watched; the UI updates automatically

## Architecture

- `src-tauri/src/git.rs`: runs the installed `git` executable for all operations, so hooks, credentials, SSH and signing behave like the CLI
- `src-tauri/src/graph.rs`: commit graph lane layout, computed in Rust and sent per row to the frontend
- `src-tauri/src/watcher.rs`: debounced file watcher that emits `repo-changed` events
- `src/`: React frontend (`components/` holds the views, `api.ts` the typed command bindings)

## Development

Prerequisites: Node.js, Rust, git, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev               # run the app
cd src-tauri && cargo test      # backend tests
npm run tauri build             # build installers for the current OS
```

Keep the Tauri Rust crates and `@tauri-apps/*` npm packages on the same minor version: when updating,
run `cargo update` in `src-tauri` and update the npm packages together (`npx tauri info` shows both sides).
