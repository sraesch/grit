# Changelog

All notable changes to grit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-11-21

### Changed

- The macOS installers are signed with a Developer ID and notarized by Apple, so they open without Gatekeeper warnings

## [0.4.0] - 2026-11-21

### Added

- Right-clicking a local branch in the sidebar opens a menu to check it out or delete it
- Double-clicking a commit in the history checks it out. A commit at the tip of a branch checks out the branch: the local branch pointing at it, or else the local branch of a remote branch pointing at it (created if needed). Other commits are checked out by themselves (detached HEAD)
- Delete a local branch: right-click it in the sidebar and choose "Delete Branch…". A branch with commits that aren't merged yet is only deleted after a second confirmation, and the message afterwards names the commit it pointed at, in case it has to be restored. The current branch can't be deleted. Optionally the remote branch it tracks is deleted along; then the branch counts as merged only once it is merged into the current branch, and the remote branch is never deleted when someone pushed to it since the last fetch
- Merge: the Merge button (or Ctrl/Cmd+Shift+M) merges a local or remote branch or a tag into the current branch. Choose to fast-forward when possible, always create a merge commit, only fast-forward, or squash the changes into one commit you review and commit yourself; optionally stash and reapply local changes. The dialog starts on the branch you were on before (switch to develop, merge the feature you just finished), previews how many commits come in and whether it will fast-forward, and remembers its options. git's progress is shown while it runs, and a merge that stops on conflicts is committed or aborted from the banner
- A squash merge waiting to be committed shows a banner too, with its prepared message in the commit box, and can be committed or aborted from there
- Stashes: the Stash button (or Ctrl/Cmd+Shift+S) stashes the local changes with an optional message, optionally including untracked files or keeping the staged changes; the dialog remembers its options. Stashes are listed in the sidebar: click one to see its changed files and diffs (untracked files included), and apply it, pop it (apply and delete) or delete it from there or its context menu. A stash that applies with conflicts is kept, and the conflicts are resolved in Local changes

## [0.3.0] - 2026-11-17

### Added

- Fetch: the Fetch button (or Ctrl/Cmd+Shift+F) fetches one remote or all of them, optionally pruning remote branches deleted on the remote and fetching all tags. git's progress is shown while it runs, followed by a summary of new, updated and pruned branches and new tags
- Pull: the Pull button (or Ctrl/Cmd+Shift+L) shows how far behind the upstream the branch is and pulls a remote branch into the current one, by merge or rebase, optionally stashing and reapplying local changes. The result says what happened (fast-forward, merge, rebase or already up to date). The dialogs remember their options
- Push: the Push button (or Ctrl/Cmd+Shift+P) shows how far ahead of the upstream the branch is and pushes a local branch to a branch on a remote, creating it if needed. Optionally push all tags and set the remote branch as upstream (on by default for branches without one). Force push replaces the remote branch, but is refused when the remote has commits you haven't pulled, even if a background fetch brought them in (`--force-with-lease` with `--force-if-includes`), and never overwrites tags. When a push is rejected because the remote branch moved on, the message offers to pull or to force push
- When a pull, merge, rebase, cherry-pick or revert stops on conflicts, a banner explains what to do and offers to continue, skip the commit or abort; a merge in progress can be committed from the banner or with its prepared message in the commit box
- Rebase: the Rebase button (or Ctrl/Cmd+Shift+E) rebases the current branch onto a local or remote branch or a tag, optionally stashing and reapplying local changes. The dialog starts on the branch a feature branch most likely came from (develop, main, …), previews how many commits will be replayed, and warns when commits that were already pushed would be rewritten. git's progress is shown while it runs, and a rebase that stops on conflicts continues, skips or aborts from the banner
- Automatic fetching: open repositories fetch all remotes in the background (every 10 minutes by default, configurable or off in Settings). Automatic fetches never prompt for credentials, and a failure shows quietly on the Fetch button, which also tells when the repository was last fetched
- macOS: "Settings…" (Cmd+,) in the app menu opens the settings

### Changed

- Fork-style layout: Fetch, Pull and Push sit in the main toolbar as icon buttons with their label underneath, with the commits to pull and push as badges on the icons; Settings and About are on the right. The repository tabs moved to their own bar below the toolbar, where they share the width equally and the selected tab is a raised pill; a tab's close button appears on hover
- Changed files (unstaged, staged and in a commit's details) are shown as a folder tree instead of a flat list. Folders sort before files, chains of folders with a single subfolder share one row (`src/main/java`), and clicking a folder collapses it, showing how many files it holds. Hovering a folder offers Stage, Unstage or Mark resolved for all of its files

## [0.2.0] - 2026-11-15

### Added

- Markdown preview for commit messages: a Write/Preview toggle in the commit box shows the message as it will render
- Commit bodies in the history details are rendered as GitHub-flavored markdown (lists, code, links, tables, task lists), with a toggle back to plain text that is remembered; links open in the system browser
- Image preview in the history: selecting a changed image (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG) shows it before and after the commit side by side, with dimensions and file size, on a checkerboard for transparency; a toggle switches to the diff
- Branch switcher: click the branch above the sidebar or press Ctrl/Cmd+B to filter branches and switch with the keyboard or mouse; remote branches without a local branch are checked out as a new tracking branch, and typing a new name creates a branch from HEAD. Uncommitted changes are carried over, and git's reason is shown when it refuses to switch
- Tabs: open several repositories side by side. Each tab keeps its own view, selection and commit message draft and stays up to date in the background. Close tabs with ×, a middle-click or Ctrl/Cmd+W; open one with + or Ctrl/Cmd+O; cycle with Ctrl+Tab / Ctrl+Shift+Tab. Opening a repository that is already open shows its tab, and the open tabs are restored on the next start
- Settings dialog (toolbar or Ctrl/Cmd+,) with the repositories folder where cloned repositories live; Open… starts there. Settings are saved in the app's config folder
- Double-click a remote branch in the sidebar to switch to its local branch, creating a tracking branch if needed

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

[Unreleased]: https://github.com/sraesch/grit/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/sraesch/grit/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sraesch/grit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sraesch/grit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sraesch/grit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sraesch/grit/releases/tag/v0.1.0
