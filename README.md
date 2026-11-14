# grit

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
npm run tauri build             # build installers for the current OS
```

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
- **Release** (`release.yml`): pushing a `v*` tag checks that the tag matches the app version, builds installers for
  macOS (Apple Silicon and Intel), Linux (`.deb`, `.rpm`, AppImage) and Windows (`.msi`, NSIS `.exe`), and attaches
  them to a **draft** GitHub release. Running it manually builds installers as workflow artifacts without releasing.
- **Dependabot** (`.github/dependabot.yml`): weekly update PRs for npm, Cargo and the workflow actions.

### Making a release

1. Set the same version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
   (`node .github/scripts/check-version.mjs` verifies them).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. Review the draft release on GitHub and publish it.

Installers are unsigned until signing secrets are configured (see the comments in `release.yml`), so macOS
Gatekeeper and Windows SmartScreen will warn on first launch.
