import { Branches, Divergence, RebaseResult, Status } from "./api";
import { NoticeKind, plural } from "./remote";

/** What the current branch can be rebased onto, grouped for the picker. */
export interface RebaseTargets {
  local: string[];
  remote: string[];
  tags: string[];
  /** The one to preselect. */
  preferred: string | null;
}

/** Branches that other branches usually start from, most likely first. */
const BASE_BRANCHES = ["develop", "main", "master", "trunk"];

/**
 * Branches and tags to rebase the current branch onto. A feature branch starts on the branch it
 * most likely came from (develop, main, …); one of those base branches starts on its upstream.
 */
export function rebaseTargets(branches: Branches, status: Status | null): RebaseTargets {
  const current = status?.branch ?? null;
  const local = branches.local.filter((b) => b.name !== current).map((b) => b.name);
  const remote = branches.remote.map((b) => b.name);
  const tags = branches.tags.map((b) => b.name);

  const upstream = status?.upstream && remote.includes(status.upstream) ? status.upstream : null;
  const base = BASE_BRANCHES.find((name) => local.includes(name)) ?? null;
  const candidates = current && BASE_BRANCHES.includes(current) ? [upstream, base] : [base, upstream];
  const preferred = candidates.find((c) => c !== null) ?? local[0] ?? remote[0] ?? tags[0] ?? null;
  return { local, remote, tags, preferred };
}

export function hasRebaseTargets(targets: RebaseTargets): boolean {
  return targets.local.length + targets.remote.length + targets.tags.length > 0;
}

/** What rebasing `branch` onto `onto` will do, for the dialog. */
export function rebasePreview(d: Divergence, branch: string, onto: string): string {
  const commits = (n: number) => plural(n, "commit");
  if (d.behind === 0) return `${branch} already contains everything on ${onto}. There is nothing to rebase.`;
  if (d.ahead === 0) return `${branch} has no commits of its own, so it moves to ${onto} (${commits(d.behind)} ahead).`;
  return `Replays ${commits(d.ahead)} of ${branch} on top of ${onto}, which has ${commits(d.behind)} ${branch} doesn't.`;
}

/**
 * True when some of the commits to replay were already pushed to the branch's upstream, so the
 * rebased branch has to be force-pushed.
 */
export function rewritesPushedCommits(d: Divergence, status: Status): boolean {
  return !!status.upstream && d.behind > 0 && d.ahead > status.ahead;
}

/** What to tell the user after rebasing `branch` onto `onto`. */
export function rebaseSummary(result: RebaseResult, onto: string, branch: string): { text: string; kind: NoticeKind } {
  const commits = (n: number) => plural(n, "commit");
  const files = (n: number) => plural(n, "file");
  switch (result.outcome) {
    case "up-to-date":
      return { kind: "info", text: `${branch} already contains everything on ${onto}` };
    case "fast-forward":
      return { kind: "info", text: `Moved ${branch} forward to ${onto} (${commits(result.incoming)})` };
    case "rebase":
      return {
        kind: "info",
        text:
          result.rebased > 0
            ? `Rebased ${commits(result.rebased)} of ${branch} onto ${onto} (${result.incoming} new)`
            : `${branch} now matches ${onto}: its commits were already there`,
      };
    case "conflicts":
      return {
        kind: "warning",
        text:
          result.conflicts > 0
            ? `Rebasing ${branch} onto ${onto} stopped with conflicts in ${files(result.conflicts)}. Resolve them in Local changes.`
            : `Rebasing ${branch} onto ${onto} stopped. Continue or abort it from the banner.`,
      };
    case "stash-conflicts":
      return {
        kind: "warning",
        text:
          `Rebased ${branch} onto ${onto}, but your local changes conflict with it in ${files(result.conflicts)}. ` +
          "Resolve them in Local changes; your changes are also kept in the stash.",
      };
  }
}
