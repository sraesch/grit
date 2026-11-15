# Changelog

All notable changes to grit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Linux packages now include a long description, the Development menu category and a 512×512 icon
- The Linux dev desktop-entry script refuses to run while grit is installed, because its entry hid the installed app from the app search and dock

## [0.1.0] - 2026-11-14

### Added

- Local changes view: unstaged, staged and conflicted files with a per-file diff
- Stage and unstage files by button or double-click, and stage or unstage everything at once
- Commit and amend, with Ctrl/Cmd+Enter to commit
- History view: virtualized commit list with branch graph, branch and tag badges, and keyboard navigation
- Commit details with message, author, parents, changed files (including renames) and per-file diffs
- Sidebar with local branches (ahead/behind counts), remotes and tags; double-click a local branch to check it out
- Automatic refresh when the working tree or repository changes
- Resizable panes, light and dark themes, and reopening the last repository on start
- CI on GitHub Actions: frontend typecheck, tests and build; Rust formatting, clippy, tests and app builds on Linux, macOS and Windows
- Release workflow that builds installers for macOS, Linux and Windows into a draft GitHub release when a `v*` tag is pushed, using the changelog section as release notes
- Rolling "Latest main build" pre-release with installers for every platform, rebuilt after each successful CI run on `main`
- Dependabot updates for npm, Cargo and GitHub Actions
- Frontend unit and component tests (Vitest) and backend tests against real git repositories
- MIT license
- App icon and logo: a lowercase "r" drawn as a branch forking from a commit, shown in the toolbar and on the welcome screen and adapting to light and dark themes
- About dialog with the app version, logo and a short changelog of what's new in each release

[Unreleased]: https://github.com/sraesch/grit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sraesch/grit/releases/tag/v0.1.0
