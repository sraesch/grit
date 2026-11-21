import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  root: string;
  gitDir: string;
  name: string;
}

export interface FileChange {
  path: string;
  origPath: string | null;
  /** M, T, A, D, R, C, U (conflict) or ? (untracked) */
  status: string;
}

/** "squash" is a squash merge whose changes are staged (or conflict) and wait to be committed. */
export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "squash";

/**
 * A merge, squash merge, rebase, cherry-pick or revert that stopped (usually on conflicts) and
 * waits for the user.
 */
export interface Operation {
  kind: OperationKind;
  /** The branch being rebased. */
  head: string | null;
  /** Rebase progress: the commit being applied (1-based) and the number of commits. */
  step: number | null;
  total: number | null;
  /** The prepared commit message of a merge or squash merge. */
  message: string | null;
}

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  operation: Operation | null;
  /** When the repository was last fetched (unix seconds), or null if never. */
  lastFetch: number | null;
}

export interface Segment {
  from: number;
  to: number;
  half: "top" | "bottom";
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  width: number;
  segments: Segment[];
}

export interface RefLabel {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
  current: boolean;
}

export interface LogEntry {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  refs: RefLabel[];
  graph: GraphRow;
}

export interface CommitDetails {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  committerTime: number;
  message: string;
  files: FileChange[];
}

export interface Branch {
  name: string;
  sha: string;
  current: boolean;
  upstream: string | null;
  track: string | null;
}

/**
 * "not-merged": nothing was deleted because the branch has unmerged commits; deleting it needs `force`.
 * With the remote branch, merged means into the current branch, as the upstream goes away too.
 */
export type DeleteBranchOutcome = "deleted" | "not-merged";

export interface Remote {
  name: string;
  /** The fetch URL. */
  url: string;
}

export interface Branches {
  local: Branch[];
  remote: Branch[];
  tags: Branch[];
  remotes: Remote[];
  /** The branch checked out before the current one, if it still exists. */
  previous?: string | null;
}

export interface FetchOptions {
  /** Null fetches every remote. */
  remote: string | null;
  /** Remove remote branches that were deleted on the remote. */
  prune: boolean;
  /** Fetch all tags, not only those in the fetched history. */
  tags: boolean;
  /** An automatic fetch: never prompts and reports no progress. */
  background: boolean;
}

export interface FetchResult {
  newBranches: string[];
  updatedBranches: string[];
  deletedBranches: string[];
  newTags: string[];
}

export interface PullOptions {
  remote: string;
  /** Branch name on the remote, e.g. "main" (not "origin/main"). */
  branch: string;
  rebase: boolean;
  /** Stash uncommitted changes before the pull and reapply them afterwards. */
  autostash: boolean;
}

export type PullOutcome = "up-to-date" | "fast-forward" | "merge" | "rebase" | "conflicts" | "stash-conflicts";

export interface PullResult {
  outcome: PullOutcome;
  /** Commits that came from the remote branch. */
  incoming: number;
  /** Local commits that were rebased onto the remote branch. */
  rebased: number;
  /** Files with conflicts. */
  conflicts: number;
}

export interface PushOptions {
  /** The local branch to push. */
  branch: string;
  remote: string;
  /** Branch name on the remote, e.g. "main" (not "origin/main"); created if it doesn't exist. */
  remoteBranch: string;
  /** Make the remote branch the upstream of the local one. */
  setUpstream: boolean;
  /** Push all tags along with the branch. */
  tags: boolean;
  /**
   * Overwrite the remote branch even if that drops commits from it. It is still refused when
   * the remote has commits that were never pulled (--force-with-lease and --force-if-includes).
   */
  force: boolean;
}

/**
 * "rejected": the remote branch has commits the local one doesn't; pull first or force push.
 * "stale": a force push was refused because the remote has commits that were never pulled.
 */
export type PushOutcome = "up-to-date" | "pushed" | "new-branch" | "forced" | "rejected" | "stale";

export interface PushResult {
  outcome: PushOutcome;
  /** Commits the remote branch gained. */
  commits: number;
  /** Tags created on the remote. */
  newTags: string[];
  /** Tags the remote refused, usually because it has a different tag of the same name. */
  rejectedTags: string[];
}

export interface RebaseOptions {
  /** Branch, tag or commit to rebase the current branch onto, e.g. "main" or "origin/main". */
  onto: string;
  /** Stash uncommitted changes before the rebase and reapply them afterwards. */
  autostash: boolean;
}

export type RebaseOutcome = "up-to-date" | "fast-forward" | "rebase" | "conflicts" | "stash-conflicts";

export interface RebaseResult {
  outcome: RebaseOutcome;
  /** Commits of the new base the branch didn't contain yet. */
  incoming: number;
  /** The branch's own commits on top of the new base; for "conflicts", the commits being replayed. */
  rebased: number;
  /** Files with conflicts. */
  conflicts: number;
}

/**
 * How a merge combines the other branch with the current one: fast-forward when possible, always
 * create a merge commit, only fast-forward, or stage the changes for one commit (squash).
 */
export type MergeMode = "ff" | "no-ff" | "ff-only" | "squash";

export interface MergeOptions {
  /** Branch, tag or commit to merge into the current branch, e.g. "feature" or "origin/main". */
  source: string;
  mode: MergeMode;
  /** Stash uncommitted changes before the merge and reapply them afterwards; not for squash merges. */
  autostash: boolean;
}

export type MergeOutcome = "up-to-date" | "fast-forward" | "merge" | "squash" | "conflicts" | "stash-conflicts";

export interface MergeResult {
  outcome: MergeOutcome;
  /** Commits of the other branch the current one didn't contain yet. */
  incoming: number;
  /** Files with conflicts. */
  conflicts: number;
}

/** How far HEAD and another branch or commit have diverged. */
export interface Divergence {
  /** Commits only on HEAD. */
  ahead: number;
  /** Commits only on the other side. */
  behind: number;
}

/** A progress line of a running fetch, pull, push, rebase or merge. */
export interface GitProgress {
  root: string;
  text: string;
}

export interface Settings {
  /** Folder that holds cloned repositories; the Open dialog starts here. Null means the home folder. */
  reposDir: string | null;
  /** Open repositories are fetched in the background this often; 0 turns it off. */
  autoFetchMinutes: number;
}

export interface RepoChanged {
  /** Root of the repository that changed, as returned by openRepo. */
  root: string;
  worktree: boolean;
  refs: boolean;
}

export const api = {
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  /** Stops watching a repository whose tab was closed. */
  closeRepo: (root: string) => invoke<void>("close_repo", { root }),
  status: (repo: string) => invoke<Status>("get_status", { repo }),
  log: (repo: string, limit?: number) => invoke<LogEntry[]>("get_log", { repo, limit }),
  branches: (repo: string) => invoke<Branches>("get_branches", { repo }),
  workingDiff: (repo: string, path: string, staged: boolean, untracked: boolean) =>
    invoke<string>("get_working_diff", { repo, path, staged, untracked }),
  commitDetails: (repo: string, sha: string) => invoke<CommitDetails>("get_commit_details", { repo, sha }),
  commitFileDiff: (repo: string, sha: string, path: string, origPath: string | null) =>
    invoke<string>("get_commit_file_diff", { repo, sha, path, origPath }),
  /** Raw contents of `path` (relative to the repository root) at revision `rev`. */
  fileAtRevision: (repo: string, rev: string, path: string) =>
    invoke<ArrayBuffer>("get_file_at_revision", { repo, rev, path }),
  stage: (repo: string, paths: string[]) => invoke<void>("stage", { repo, paths }),
  stageAll: (repo: string) => invoke<void>("stage_all", { repo }),
  unstage: (repo: string, paths: string[]) => invoke<void>("unstage", { repo, paths }),
  unstageAll: (repo: string) => invoke<void>("unstage_all", { repo }),
  commit: (repo: string, message: string, amend: boolean) => invoke<void>("commit", { repo, message, amend }),
  checkout: (repo: string, branch: string) => invoke<void>("checkout_branch", { repo, branch }),
  /** Creates a local branch tracking `branch` (e.g. "origin/feature") and switches to it. */
  getSettings: () => invoke<Settings>("get_settings"),
  /** Validates and saves the settings; resolves to what was stored (e.g. with "~" expanded). */
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  checkoutRemote: (repo: string, branch: string) => invoke<void>("checkout_remote_branch", { repo, branch }),
  /** Checks out a commit without a branch (detached HEAD). */
  checkoutCommit: (repo: string, sha: string) => invoke<void>("checkout_commit", { repo, sha }),
  /** Creates a branch at HEAD and switches to it. */
  createBranch: (repo: string, name: string) => invoke<void>("create_branch", { repo, name }),
  /**
   * Deletes a local branch and, with `deleteRemote`, the remote branch it tracks (first; progress
   * arrives as `git-progress` events). Without `force`, a branch with unmerged commits is kept
   * ("not-merged"). The remote branch is never deleted when it has commits that weren't fetched.
   */
  deleteBranch: (repo: string, name: string, force: boolean, deleteRemote: boolean) =>
    invoke<DeleteBranchOutcome>("delete_branch", { repo, name, force, deleteRemote }),
  /** Progress arrives as `git-progress` events unless `background` is set. */
  fetch: (repo: string, options: FetchOptions) => invoke<FetchResult>("fetch", { repo, ...options }),
  /** Progress arrives as `git-progress` events. Conflicts resolve with outcome "conflicts" rather than rejecting. */
  pull: (repo: string, options: PullOptions) => invoke<PullResult>("pull", { repo, ...options }),
  /** Progress arrives as `git-progress` events. A rejected push resolves with outcome "rejected" or "stale". */
  push: (repo: string, options: PushOptions) => invoke<PushResult>("push", { repo, ...options }),
  /** Commits HEAD has that `base` doesn't (ahead), and the other way round (behind). */
  divergence: (repo: string, base: string) => invoke<Divergence>("get_divergence", { repo, base }),
  /**
   * Rebases the current branch onto `options.onto`. Progress arrives as `git-progress` events.
   * Conflicts resolve with outcome "conflicts" rather than rejecting.
   */
  rebase: (repo: string, options: RebaseOptions) => invoke<RebaseResult>("rebase", { repo, ...options }),
  /**
   * Merges `options.source` into the current branch. Progress arrives as `git-progress` events.
   * Conflicts resolve with outcome "conflicts" rather than rejecting.
   */
  merge: (repo: string, options: MergeOptions) => invoke<MergeResult>("merge", { repo, ...options }),
  /** Aborts the merge, squash merge, rebase, cherry-pick or revert in progress. */
  abortOperation: (repo: string) => invoke<void>("abort_operation", { repo }),
  /** Continues the operation in progress once its conflicts are resolved; a merge is committed. */
  continueOperation: (repo: string) => invoke<void>("continue_operation", { repo }),
  /** Skips the commit that stopped a rebase, cherry-pick or revert. */
  skipOperation: (repo: string) => invoke<void>("skip_operation", { repo }),
};

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
