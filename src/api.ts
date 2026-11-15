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

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
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

export interface Branches {
  local: Branch[];
  remote: Branch[];
  tags: Branch[];
}

export interface Settings {
  /** Folder that holds cloned repositories; the Open dialog starts here. Null means the home folder. */
  reposDir: string | null;
}

export interface RepoChanged {
  worktree: boolean;
  refs: boolean;
}

export const api = {
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
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
  /** Creates a branch at HEAD and switches to it. */
  createBranch: (repo: string, name: string) => invoke<void>("create_branch", { repo, name }),
};

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
