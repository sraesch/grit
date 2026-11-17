import { Branches, FetchResult, Operation, PullResult, PushResult, Remote, Status } from "./api";

/** Value of the remote picker that fetches every remote. */
export const ALL_REMOTES = "*";

/**
 * Splits a remote branch like "origin/feature/x" into its remote and branch name. The longest
 * matching remote wins, so remotes whose names contain a slash work too.
 */
export function splitRemoteBranch(name: string, remotes: Remote[]): { remote: string; branch: string } | null {
  const remote = remotes
    .map((r) => r.name)
    .filter((r) => name.startsWith(`${r}/`) && name.length > r.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  return remote === undefined ? null : { remote, branch: name.slice(remote.length + 1) };
}

/** The remote the fetch dialog starts with: the current branch's, then "origin", then the first one. */
export function defaultFetchRemote(status: Status | null, remotes: Remote[]): string | null {
  const upstream = status?.upstream ? splitRemoteBranch(status.upstream, remotes)?.remote : undefined;
  return upstream ?? remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? null;
}

/**
 * Remote branches the current branch can pull from, with the one to preselect: its upstream,
 * else the branch of the same name on the default remote.
 */
export function pullSources(branches: Branches, status: Status | null): { sources: string[]; preferred: string | null } {
  const sources = branches.remote.map((b) => b.name);
  const branch = status?.branch;
  if (!branch) return { sources, preferred: null };
  const remote = defaultFetchRemote(status, branches.remotes);
  const candidates = [status.upstream, remote && `${remote}/${branch}`, ...branches.remotes.map((r) => `${r.name}/${branch}`)];
  const preferred = candidates.find((c): c is string => !!c && sources.includes(c)) ?? null;
  // The preselected branch goes first, so it is also the first entry when the list is long.
  return { sources: preferred ? [preferred, ...sources.filter((s) => s !== preferred)] : sources, preferred };
}

/** Where a local branch is pushed to: a branch on a remote. */
export interface PushTarget {
  remote: string;
  /** Branch name on the remote, e.g. "main". */
  remoteBranch: string;
}

/**
 * Where `branch` is pushed by default: its upstream, else the branch of the same name on the
 * default remote.
 */
export function defaultPushTarget(branch: string, branches: Branches, status: Status | null): PushTarget | null {
  const upstream = branches.local.find((b) => b.name === branch)?.upstream;
  const split = upstream ? splitRemoteBranch(upstream, branches.remotes) : null;
  if (split) return { remote: split.remote, remoteBranch: split.branch };
  const remote = defaultFetchRemote(status, branches.remotes);
  return remote ? { remote, remoteBranch: branch } : null;
}

/** Parses a branch's tracking info, e.g. "[ahead 1, behind 2]" or "[gone]". */
export function parseTrack(track: string | null): { ahead: number; behind: number; gone: boolean } {
  const n = (word: string) => Number(track?.match(new RegExp(`${word} (\\d+)`))?.[1] ?? 0);
  return { ahead: n("ahead"), behind: n("behind"), gone: track === "[gone]" };
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "Fetched origin: 1 new branch, 2 updated, 1 pruned, 3 new tags". */
export function fetchSummary(result: FetchResult, remote: string | null): string {
  const parts = [
    result.newBranches.length && plural(result.newBranches.length, "new branch", "new branches"),
    result.updatedBranches.length && `${result.updatedBranches.length} updated`,
    result.deletedBranches.length && `${result.deletedBranches.length} pruned`,
    result.newTags.length && plural(result.newTags.length, "new tag"),
  ].filter(Boolean);
  const what = remote ?? "all remotes";
  return parts.length ? `Fetched ${what}: ${parts.join(", ")}` : `Fetched ${what}: everything is up to date`;
}

export type NoticeKind = "info" | "warning";

/** What to tell the user after pulling `source` into `branch`. */
export function pullSummary(result: PullResult, source: string, branch: string): { text: string; kind: NoticeKind } {
  const commits = (n: number) => plural(n, "commit");
  switch (result.outcome) {
    case "up-to-date":
      return { kind: "info", text: `${branch} is already up to date with ${source}` };
    case "fast-forward":
      return { kind: "info", text: `Pulled ${commits(result.incoming)} from ${source} into ${branch}` };
    case "merge":
      return { kind: "info", text: `Merged ${commits(result.incoming)} from ${source} into ${branch}` };
    case "rebase":
      return {
        kind: "info",
        text: `Rebased ${commits(result.rebased)} of ${branch} onto ${source} (${result.incoming} new)`,
      };
    case "conflicts":
      return {
        kind: "warning",
        text: `Pulling ${source} stopped with conflicts in ${plural(result.conflicts, "file")}. Resolve them in Local changes.`,
      };
    case "stash-conflicts":
      return {
        kind: "warning",
        text:
          `Pulled ${source}, but your local changes conflict with it in ${plural(result.conflicts, "file")}. ` +
          "Resolve them in Local changes; your changes are also kept in the stash.",
      };
  }
}

/** What to tell the user after pushing `branch` to `target` (e.g. "origin/main"). */
export function pushSummary(result: PushResult, branch: string, target: string): { text: string; kind: NoticeKind } {
  let text: string;
  let kind: NoticeKind = "info";
  switch (result.outcome) {
    case "up-to-date":
      text = `${target} is already up to date with ${branch}`;
      break;
    case "pushed":
      text = `Pushed ${plural(result.commits, "commit")} from ${branch} to ${target}`;
      break;
    case "new-branch":
      text = `Pushed ${branch} to the new branch ${target}`;
      break;
    case "forced":
      text = `Force pushed ${branch} to ${target}`;
      break;
    case "rejected":
      kind = "warning";
      text = `Push rejected: ${target} has commits that ${branch} doesn't have. Pull them first, or force push to overwrite them.`;
      break;
    case "stale":
      kind = "warning";
      text =
        `Force push refused: ${target} has commits you haven't pulled, which it would throw away. ` +
        "Pull them first, then push again.";
      break;
  }
  if (result.newTags.length) text += `, with ${plural(result.newTags.length, "new tag")}`;
  if (result.rejectedTags.length) {
    kind = "warning";
    const s = result.rejectedTags.length === 1 ? "" : "s";
    text += `. The remote already has a different tag${s} ${result.rejectedTags.join(", ")}, which ${s ? "were" : "was"} not pushed`;
  }
  return { text, kind };
}

/** True when an automatic fetch is due: nothing was fetched or tried within the interval. */
export function autoFetchDue(lastFetch: number | null, lastAttempt: number | null, minutes: number, now: number): boolean {
  if (minutes <= 0) return false;
  const last = Math.max(lastFetch ?? 0, lastAttempt ?? 0);
  return now - last >= minutes * 60;
}

const OPERATION_NAMES: Record<Operation["kind"], string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
};

export function operationName(op: Operation): string {
  return OPERATION_NAMES[op.kind];
}

/** "Rebasing main (commit 2 of 3)", "Merging", … */
export function operationTitle(op: Operation): string {
  const progress = op.step && op.total ? ` (commit ${op.step} of ${op.total})` : "";
  switch (op.kind) {
    case "merge":
      return "Merge in progress";
    case "rebase":
      return `Rebasing${op.head ? ` ${op.head}` : ""}${progress}`;
    case "cherry-pick":
      return "Cherry-pick in progress";
    case "revert":
      return "Revert in progress";
  }
}

export interface FetchPrefs {
  prune: boolean;
  tags: boolean;
}

export interface PullPrefs {
  rebase: boolean;
  autostash: boolean;
}

/** Force push is deliberately not remembered: it is chosen for one push at a time. */
export interface PushPrefs {
  tags: boolean;
}

function readPrefs<T extends object>(key: string, defaults: T): T {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || typeof stored !== "object") return defaults;
    const result = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      if (typeof stored[k] === typeof defaults[k]) result[k] = stored[k];
    }
    return result;
  } catch {
    return defaults;
  }
}

function savePrefs(key: string, prefs: object) {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: the options just aren't remembered */
  }
}

/** The fetch, pull and push dialogs remember their options, as Fork does. */
export const prefs = {
  fetch: () => readPrefs<FetchPrefs>("fetchOptions", { prune: true, tags: false }),
  saveFetch: (p: FetchPrefs) => savePrefs("fetchOptions", p),
  pull: () => readPrefs<PullPrefs>("pullOptions", { rebase: false, autostash: true }),
  savePull: (p: PullPrefs) => savePrefs("pullOptions", p),
  push: () => readPrefs<PushPrefs>("pushOptions", { tags: false }),
  savePush: (p: PushPrefs) => savePrefs("pushOptions", p),
};
