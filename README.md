<p align="center">
  <img src="src-tauri/icons/app-icon.svg" width="128" height="128" alt="grit logo: a lowercase r drawn as a branch forking from a commit">
</p>

# grit

A cross-platform (Windows, macOS, Linux) interactive Git client built with Tauri 2, Rust and React.

See the [changelog](CHANGELOG.md) for what changed in each release.

## Features

- **Local changes**: unstaged/staged file lists, per-file diff, stage/unstage (button, double-click or context menu),
  stage/unstage all, discard changes and delete untracked files (per file, per folder or all, after confirming),
  stage, unstage or discard single hunks or selected lines, add untracked files and folders to `.gitignore`, commit and amend
  (Ctrl/Cmd+Enter)
- **History**: virtualized commit list with branch graph, ref badges, keyboard navigation, commit details, changed files and diffs; double-click a commit to check it out
- **Branches**: local, remote and tag lists; double-click a local branch to check it out, right-click it to check it out or delete it
- **Fetch, pull and push**: fetch one or all remotes (prune, tags), pull by merge or rebase with optional autostash,
  push any local branch to any remote branch (tags, set upstream, force push with lease), live progress and result
  summaries, a banner to continue/skip/abort a merge or rebase stopped on conflicts, and automatic background fetching
- **Merge**: merge a local or remote branch or a tag into the current branch: fast-forward if possible, always create
  a merge commit, fast-forward only, or squash; with a preview, optional autostash, live progress and the same
  commit/abort banner on conflicts
- **Stash**: stash local changes with a message, optionally with untracked files or keeping staged changes;
  browse stashes with their files and diffs, and apply, pop or delete them
- **Rebase**: rebase the current branch onto a local or remote branch or a tag, with a preview of the commits to
  replay, optional autostash, live progress and the same continue/skip/abort banner on conflicts
- **Live refresh**: the working tree and `.git` are watched; the UI updates automatically

## Architecture

- `src-tauri/src/git.rs`: runs the installed `git` executable for all operations, so hooks, credentials, SSH and signing behave like the CLI
- `src-tauri/src/patch.rs`: builds patches from selected hunks and lines of a freshly generated diff, for `git apply`
- `src-tauri/src/graph.rs`: commit graph lane layout, computed in Rust and sent per row to the frontend
- `src-tauri/src/watcher.rs`: debounced file watcher that emits `repo-changed` events
- Fetch, pull, push, rebase and merge stream git's progress output to the frontend as `git-progress` events; background fetches run
  with ssh in batch mode and Git Credential Manager non-interactive, so they never prompt
- `src/`: React frontend (`components/` holds the views, `api.ts` the typed command bindings)

## Development

Prerequisites: Node.js, Rust, git, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev               # run the app
npm run tauri build             # build installers for the current OS
```

On Linux with Wayland (e.g. Ubuntu/GNOME), the dock only shows an app's icon if a matching `.desktop` file is
installed. Installed packages include one; for `npm run tauri dev`, run `scripts/install-linux-dev-desktop-entry.sh`
once (`--uninstall` removes it). Remove the dev entry before installing a package: a user-level `grit.desktop`
overrides the installed one and hides grit from the app search.

Keep the Tauri Rust crates and `@tauri-apps/*` npm packages on the same minor version: when updating,
run `cargo update` in `src-tauri` and update the npm packages together (`npx tauri info` shows both sides).

## Tests

```sh
npm test                        # frontend unit and component tests (Vitest + Testing Library)
npm run coverage                # same, with a coverage report in coverage/
npm run typecheck               # TypeScript
cd src-tauri && cargo test      # backend: parsers, graph layout, watcher, real-repository tests
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

- Frontend tests mock the Tauri backend (`src/test/tauri.ts`), so they run in plain Node without the app.
- Backend tests create throwaway git repositories in the system temp dir and run the real `git` binary.

## CI/CD

GitHub Actions workflows live in `.github/workflows/`:

- **CI** (`ci.yml`): runs on pushes to `main`/`develop` and on pull requests:
  - Frontend: typecheck, tests with coverage, production build
  - Rust: `cargo fmt --check` and `clippy -D warnings`
  - Rust tests plus a full app build on Linux, macOS and Windows
- **Release** (`release.yml`): builds installers for macOS (Apple Silicon and Intel), Linux (`.deb`, `.rpm`,
  AppImage) and Windows (`.msi`, NSIS `.exe`):
  - **Every push to `main`**: once CI passes for that commit, the installers are published to the rolling
    **[Latest main build](https://github.com/sraesch/grit/releases/tag/main-build)** pre-release, which is replaced on
    every push. It is a pre-release, so GitHub's "latest release" keeps pointing to the newest stable version.
  - **`v*` tags**: checks that the tag matches the app version and attaches the installers to a **draft** release,
    with that version's [changelog](CHANGELOG.md) section as release notes.
  - **Manual run** (Actions › Release › Run workflow): installers are kept as workflow artifacts only.
- **Dependabot** (`.github/dependabot.yml`): weekly update PRs for npm, Cargo and the workflow actions.

### Making a release

1. Set the same version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
   (`node .github/scripts/check-version.mjs` verifies them).
2. In [CHANGELOG.md](CHANGELOG.md), rename the `[Unreleased]` section to the new version and date
   (e.g. `## [0.2.0] - 2026-12-01`), start a fresh empty `[Unreleased]` section, and update the links at the bottom.
3. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
4. Review the draft release on GitHub and publish it.

Installers are unsigned until signing secrets are configured (see the comments in `release.yml`), so macOS
Gatekeeper and Windows SmartScreen will warn on first launch.

## License

[MIT](LICENSE) © 2026 Sascha Raesch
