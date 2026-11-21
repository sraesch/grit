import { Stash, StashApplyResult, Status } from "./api";
import { NoticeKind } from "./remote";

/** How a stash is named in messages: its message in quotes. */
export function stashName(stash: Pick<Stash, "message">): string {
  return `“${stash.message}”`;
}

/** What stashing would take: changed tracked files and untracked files. */
export function stashableCounts(status: Status): { tracked: number; untracked: number } {
  const untracked = status.unstaged.filter((f) => f.status === "?").length;
  const tracked = new Set([...status.staged, ...status.unstaged.filter((f) => f.status !== "?")].map((f) => f.path))
    .size;
  return { tracked, untracked };
}

export function stashApplySummary(
  result: StashApplyResult,
  stash: Stash,
  pop: boolean,
): { text: string; kind: NoticeKind } {
  if (result.outcome === "conflicts") {
    const files = result.conflicts === 1 ? "1 file" : `${result.conflicts} files`;
    return {
      kind: "warning",
      text: `Applied stash ${stashName(stash)} with conflicts in ${files}. Resolve them in Local changes; the stash was kept.`,
    };
  }
  return { kind: "info", text: `${pop ? "Applied and deleted" : "Applied"} stash ${stashName(stash)}.` };
}
