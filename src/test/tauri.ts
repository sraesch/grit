import { vi } from "vitest";
import type { FileChange, LogEntry, Status } from "../api";

type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Routes `invoke(command, args)` calls to per-command handlers so tests can
 * stand in for the Rust backend. Unhandled commands reject, which surfaces
 * unexpected backend calls as test failures.
 */
export function mockBackend(invoke: ReturnType<typeof vi.fn>, handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = handlers[cmd];
    if (!handler) throw `unexpected command: ${cmd}`;
    return handler(args ?? {});
  });
}

export function file(path: string, status = "M", origPath: string | null = null): FileChange {
  return { path, status, origPath };
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
    ...partial,
  };
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
