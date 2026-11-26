import { vi } from "vitest";
import type { ConflictKind, FileChange, LogEntry, Operation, OperationKind, Stash, Status } from "../api";

type Handler = (args: Record<string, unknown>) => unknown;

/** Commands most tests don't care about, answered as for a repository without stashes. */
const DEFAULT_HANDLERS: Record<string, Handler> = {
  get_stashes: () => [],
};

/**
 * Routes `invoke(command, args)` calls to per-command handlers so tests can
 * stand in for the Rust backend. Unhandled commands reject, which surfaces
 * unexpected backend calls as test failures.
 */
export function mockBackend(invoke: ReturnType<typeof vi.fn>, handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = handlers[cmd] ?? DEFAULT_HANDLERS[cmd];
    if (!handler) throw `unexpected command: ${cmd}`;
    return handler(args ?? {});
  });
}

export function file(path: string, status = "M", origPath: string | null = null): FileChange {
  return { path, status, origPath };
}

/** A conflicted file, by default one that both sides changed. */
export function conflictFile(path: string, conflict: ConflictKind = "both-modified"): FileChange {
  return { path, status: "U", origPath: null, conflict };
}

export function makeOperation(kind: OperationKind, partial: Partial<Operation> = {}): Operation {
  return { kind, head: null, step: null, total: null, message: null, commit: null, onto: null, ...partial };
}

export function makeStatus(partial: Partial<Status> = {}): Status {
  return {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicted: [],
    operation: null,
    lastFetch: null,
    ...partial,
  };
}

export function makeStash(sha: string, message: string, partial: Partial<Stash> = {}): Stash {
  return { index: 0, sha, message, branch: "main", time: 1_700_000_000, untracked: false, ...partial };
}

export function makeCommit(sha: string, subject: string, partial: Partial<LogEntry> = {}): LogEntry {
  return {
    sha,
    parents: [],
    author: "Ada",
    email: "ada@example.com",
    time: 1_700_000_000,
    subject,
    refs: [],
    graph: { col: 0, color: 0, width: 1, segments: [] },
    ...partial,
  };
}
