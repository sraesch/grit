# Changelog

All notable changes to grit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Resolve a conflicted file with one side: "Use ours" and "Use theirs" on its row in Local changes, in its context menu and above its diff take that side's version and stage the file. The sides are named after what they are in the operation in progress: the current branch and the branch being merged or the commit being cherry-picked, or, for a rebase, the new base and the commit being replayed. A file that the chosen side deleted is removed. On a folder, all its conflicted files are resolved after a confirmation. Once a conflict is resolved, the next one is selected
- Open a conflicted file in the merge tool configured in git (`merge.guitool`, else `merge.tool`) from its context menu or with "Open in merge tool" above its diff. grit waits until the tool is closed, with the merge, rebase or cherry-pick on hold meanwhile, and then says whether the file was resolved and where git kept the conflicted copy. Without a configured tool, a dialog explains how to set one up; files that one side deleted are resolved by taking a side instead
- Choose the merge tool in Settings: one of git's graphical tools, optionally with where its program is installed, or a command of your own with `$BASE`, `$LOCAL`, `$REMOTE` and `$MERGED`. It is used instead of the tool configured in git, which stays the default, and grit's choice is never written to git's configuration. The dialog shown when no merge tool is configured opens the settings

## [0.6.0] - 2026-11-24

### Added

- Right-clicking a commit in the history opens a menu to check it out (as double-clicking does), create a branch at it, or copy its SHA or message. Shift+F10 or the menu key opens the menu for the selected commit. A new branch can be checked out right away or just created; the choice is remembered
- Cherry-pick a commit onto the current branch from its context menu in the history. The dialog names the commit and the branch, can only apply the changes without committing them (remembered), and asks which parent is the mainline for a merge commit. Conflicts stop in the banner, which continues, skips or aborts the cherry-pick; when the changes were only applied, the conflicts are resolved and committed like any other change
- Revert a commit from its context menu in the history: a new commit undoes its changes, or, if you choose so (remembered separately from cherry-pick), the changes are only staged and the revert stays in the banner until they are committed. For a merge commit, the dialog asks which parent is the mainline. Conflicts stop in the banner, which continues, skips or aborts the revert
- Reset the current branch to a commit from its context menu in the history: soft keeps the changes staged, mixed keeps them unstaged, and hard discards them. The dialog says how many commits the branch drops, warns when some of them were already pushed and, for a hard reset, when uncommitted changes would be lost. Soft or mixed is remembered; hard is chosen each time. Afterwards the message names the commit the branch pointed at, so it can be restored
- Create tags: "New Tag Here…" in a commit's context menu creates a lightweight tag, or an annotated one when you enter a message, and can push it to a remote right away (remembered)
- Right-clicking a tag in the sidebar opens a menu to check it out (as double-clicking does), push it to a remote, copy its name, delete it, or delete it on a remote after a confirmation. Pushing a single tag never overwrites a different tag of the same name on the remote. Annotated tags now show the commit they point at
- More in the branch context menus of the sidebar: "Rename…" renames a local branch and optionally the remote branch it tracks (pushed under the new name, then the old one deleted unless someone pushed to it since the last fetch); "Set Upstream…" chooses the remote branch it tracks and "Clear Upstream" stops tracking it, without pushing; and "New Branch from Here…" on a local or remote branch creates a branch starting there

## [0.5.0] - 2026-11-22

### Added

- Discard local changes without leaving grit: the Discard button on a file in Unstaged changes (or "Discard Changes…" in its context menu) throws away its unstaged changes and keeps the staged ones; on an untracked file it deletes the file. The Discard button on a folder does this for every file in it, and "Discard all…" in the section header for all unstaged changes and untracked files. A confirmation names the files first, since discarded changes can't be recovered. Conflicted files are never discarded
- Right-clicking a file or folder in Local changes opens a menu to stage, unstage or discard it
- Stage, unstage and discard single hunks: each hunk of a diff in Local changes has buttons to stage or discard it (unstaged changes) or to unstage it (staged changes). This works for untracked files too. Discarding a hunk takes effect right away. A file that changed since its diff was shown is never patched; the diff is refreshed instead. Truncated diffs (more than 5000 lines) and renamed files can only be staged as a whole
- Stage, unstage and discard selected lines: click a changed line in a diff in Local changes to select it, Shift+click to select a range (across hunks too), Ctrl/Cmd+click to add or remove a line, or drag over the line numbers. The header then offers to stage or discard the selected lines (unstaged changes) or to unstage them (staged changes); Escape clears the selection. Discarding lines takes effect right away
- Ignore untracked files without editing `.gitignore` by hand: right-click an untracked file and choose "Ignore…" to ignore only this file, all files with its name, or all files with its extension; on a folder of untracked files, "Ignore Folder…" ignores only this folder or all folders with its name. The pattern can be adjusted before it is added to the `.gitignore` in the repository root, which is created if needed
- Create a repository: "New repository…" on the welcome screen, in the "+" menu of the tab bar or in the macOS File menu asks for a folder (created if needed, starting in the repositories folder from Settings) and the name of the first branch (by default `init.defaultBranch` from your git config, else `main`), then opens the new repository in a tab. When Open… chooses a folder that isn't a repository, grit offers to initialize it. A bare repository is never initialized again; opening one explains that it has no working tree to show
- Clone a repository: "Clone repository…" on the welcome screen, in the "+" menu of the tab bar or in the macOS File menu asks for its URL, the folder to clone into (by default a folder named after the repository inside the repositories folder from Settings) and optionally a branch. git's progress is shown while it runs, and the clone then opens in a tab. Credential helpers and SSH agents can ask for credentials while cloning
- The "+" in the tab bar opens a menu to open, clone or create a repository; the macOS File menu has "New Repository…", "Open…" and "Clone…" too
- Manage remotes without the command line: the Remotes group in the sidebar lists each remote (hover for its URL) with its remote branches beneath it, and a remote without fetched branches shows up too. Its "+" button (or right-click on the group) adds a remote by name and URL and optionally fetches it right away. Right-clicking a remote fetches it, edits its URL, renames it (its remote branches and the local branches tracking them follow) or removes it after a confirmation that names the local branches that lose their upstream
- Right-clicking a remote branch in the sidebar opens a menu to check it out (through a local branch tracking it), merge it into the current branch, copy its name, or delete it on the remote after a confirmation. Local branches tracking it are kept, and nothing is deleted when someone pushed to the branch since the last fetch
- Branches with path-like names such as `ftr/gitignore` are nested in collapsible folders in the sidebar, for local branches, the branches of each remote and tags alike. Each folder has a folder icon and shows how many branches it holds

### Fixed

- Aborting a merge or squash merge (or finishing it outside grit) no longer leaves its prepared message, e.g. "Merge branch 'other'", in the commit message box of Local changes; a message you edited is kept

## [0.4.2] - 2026-11-21

### Fixed

- The image preview in the history shows images stored in Git LFS instead of failing on their pointer file. Git LFS downloads them if needed, the size limit applies to the real image, and when Git LFS isn't installed the preview says so

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

[Unreleased]: https://github.com/sraesch/grit/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/sraesch/grit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/sraesch/grit/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/sraesch/grit/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sraesch/grit/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sraesch/grit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sraesch/grit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sraesch/grit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sraesch/grit/releases/tag/v0.1.0
