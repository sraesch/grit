import { Branches, Divergence, MergeMode, MergeResult, Status } from "./api";
import { BASE_BRANCHES, RebaseTargets, rebaseTargets } from "./rebase";
import { NoticeKind, plural, prefs } from "./remote";

/** The merge modes in the order the dialog lists them, with their labels. */
export const MERGE_MODES: { mode: MergeMode; label: string }[] = [
  { mode: "ff", label: "Fast-forward if possible" },
  { mode: "no-ff", label: "Always create a merge commit" },
  { mode: "ff-only", label: "Fast-forward only" },
  { mode: "squash", label: "Squash into one change to commit" },
];

/** The merge dialog's remembered options; an unknown stored mode falls back to the default. */
export function mergePrefs() {
  const stored = prefs.merge();
  return MERGE_MODES.some((m) => m.mode === stored.mode) ? stored : { ...stored, mode: "ff" as const };
}

/**
 * Branches and tags to merge into the current branch, grouped like the rebase targets. It starts
 * on the branch checked out before (you switch to develop to merge the feature you were on), then
 * on the base branch a feature branch most likely came from, then on the upstream.
 */
export function mergeTargets(branches: Branches, status: Status | null): RebaseTargets {
  const { local, remote, tags } = rebaseTargets(branches, status);
  const previous = branches.previous && local.includes(branches.previous) ? branches.previous : null;
  const base = BASE_BRANCHES.find((name) => local.includes(name)) ?? null;
  const upstream = status?.upstream && remote.includes(status.upstream) ? status.upstream : null;
  const preferred = [previous, base, upstream].find((c) => c !== null) ?? local[0] ?? remote[0] ?? tags[0] ?? null;
  return { local, remote, tags, preferred };
}

/** True when `mode` can't merge `source`: a fast-forward-only merge into a branch that diverged. */
export function mergeBlocked(d: Divergence, mode: MergeMode): boolean {
  return mode === "ff-only" && d.ahead > 0 && d.behind > 0;
}

/** What merging `source` into `branch` will do, for the dialog. */
export function mergePreview(d: Divergence, branch: string, source: string, mode: MergeMode): string {
  const commits = (n: number) => plural(n, "commit");
  if (d.behind === 0) return `${branch} already contains everything on ${source}. There is nothing to merge.`;
  if (mode === "squash") {
    return `Stages the changes of ${commits(d.behind)} from ${source} on ${branch}, for you to review and commit as one.`;
  }
  if (mergeBlocked(d, mode)) {
    return `${branch} has ${commits(d.ahead)} ${source} doesn't, so it can't fast-forward. Choose another option to merge.`;
  }
  if (d.ahead === 0 && mode !== "no-ff") return `Moves ${branch} forward to ${source} (${commits(d.behind)}).`;
  return `Creates a merge commit on ${branch} that brings in ${commits(d.behind)} from ${source}.`;
}

/** What to tell the user after merging `source` into `branch`. */
export function mergeSummary(result: MergeResult, source: string, branch: string): { text: string; kind: NoticeKind } {
  const commits = (n: number) => plural(n, "commit");
  const files = (n: number) => plural(n, "file");
  switch (result.outcome) {
    case "up-to-date":
      return { kind: "info", text: `${branch} already contains everything on ${source}` };
    case "fast-forward":
      return { kind: "info", text: `Moved ${branch} forward to ${source} (${commits(result.incoming)})` };
    case "merge":
      return { kind: "info", text: `Merged ${source} into ${branch} (${commits(result.incoming)})` };
    case "squash":
      return {
        kind: "info",
        text: `Staged the changes of ${commits(result.incoming)} from ${source}. Review and commit them in Local changes.`,
      };
    case "conflicts":
      return {
        kind: "warning",
        text:
          result.conflicts > 0
            ? `Merging ${source} into ${branch} stopped with conflicts in ${files(result.conflicts)}. Resolve them in Local changes.`
            : `Merging ${source} into ${branch} stopped. Commit or abort it from the banner.`,
      };
    case "stash-conflicts":
      return {
        kind: "warning",
        text:
          `Merged ${source} into ${branch}, but your local changes conflict with it in ${files(result.conflicts)}. ` +
          "Resolve them in Local changes; your changes are also kept in the stash.",
      };
  }
}
