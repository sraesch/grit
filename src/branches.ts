import { api, Branch, Branches, LogEntry } from "./api";

/** Something the branch switcher can switch to. */
export type SwitchTarget =
  | { kind: "local"; name: string }
  /** A remote branch without a local branch of the same name; switching creates one that tracks it. */
  | { kind: "remote"; name: string; localName: string }
  /** A new branch at HEAD. */
  | { kind: "create"; name: string }
  /** A commit, checked out without a branch (detached HEAD); `name` is its sha. */
  | { kind: "commit"; name: string };

/** Something the branch switcher lists; it never offers bare commits. */
export type SwitchOption = Exclude<SwitchTarget, { kind: "commit" }> & { current?: boolean; track?: string | null };

/** The target of an option, without its display-only fields. */
export function targetOf(option: SwitchOption): SwitchTarget {
  return option.kind === "remote"
    ? { kind: "remote", name: option.name, localName: option.localName }
    : { kind: option.kind, name: option.name };
}

/** "origin/feature/x" → "feature/x", the name `git switch --track` gives the local branch. */
export function localNameOf(remoteBranch: string): string {
  const slash = remoteBranch.indexOf("/");
  return slash < 0 ? remoteBranch : remoteBranch.slice(slash + 1);
}

/** Turns typed text into a branch name: spaces become dashes, as most git tools do. */
export function toBranchName(text: string): string {
  return text.trim().replace(/\s+/g, "-");
}

/**
 * What to switch to for a remote branch: its local branch if one exists, otherwise a new
 * tracking branch.
 */
export function targetForRemote(branches: Branches, remote: Pick<Branch, "name">): SwitchTarget {
  const localName = localNameOf(remote.name);
  const local = branches.local.find((b) => b.upstream === remote.name) ?? branches.local.find((b) => b.name === localName);
  return local ? { kind: "local", name: local.name } : { kind: "remote", name: remote.name, localName };
}

/**
 * What double-clicking a commit in the history checks out. A commit at the tip of a branch checks
 * out the branch: a local branch pointing at it (as Fork does), otherwise the local branch of a
 * remote branch pointing at it, created if needed (as double-clicking the remote branch does).
 * Other commits are checked out as a detached HEAD. Null when there is nothing to do: the commit
 * or its branch is checked out already.
 */
export function targetForCommit(entry: LogEntry, branches: Branches | null): SwitchTarget | null {
  if (entry.refs.some((r) => r.current)) return null;
  const local = entry.refs.find((r) => r.kind === "local");
  if (local) return { kind: "local", name: local.name };

  const isCurrent = (t: SwitchTarget) =>
    t.kind === "local" && !!branches?.local.some((b) => b.name === t.name && b.current);
  const viaRemote = branches
    ? entry.refs.filter((r) => r.kind === "remote").map((r) => targetForRemote(branches, r))
    : [];
  // An existing local branch beats creating a new one.
  const target = viaRemote.find((t) => t.kind === "local") ?? viaRemote[0];
  if (target) return isCurrent(target) ? null : target;
  return { kind: "commit", name: entry.sha };
}

/** The switcher's options for `filter`: local branches, untracked remote branches, then "create". */
export function switchOptions(branches: Branches, filter: string): SwitchOption[] {
  const needle = filter.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);

  const local: SwitchOption[] = branches.local
    .filter((b) => matches(b.name))
    .map((b) => ({ kind: "local", name: b.name, current: b.current, track: b.track }));

  const localNames = new Set(branches.local.map((b) => b.name));
  const upstreams = new Set(branches.local.map((b) => b.upstream));
  const remote: SwitchOption[] = branches.remote
    .filter((b) => !upstreams.has(b.name) && !localNames.has(localNameOf(b.name)) && matches(b.name))
    .map((b) => ({ kind: "remote", name: b.name, localName: localNameOf(b.name) }));

  const name = toBranchName(filter);
  const taken =
    localNames.has(name) || branches.remote.some((b) => localNameOf(b.name) === name || b.name === name);
  const create: SwitchOption[] = name && !taken ? [{ kind: "create", name }] : [];

  return [...local, ...remote, ...create];
}

export function switchTo(repo: string, target: SwitchTarget): Promise<void> {
  switch (target.kind) {
    case "local":
      return api.checkout(repo, target.name);
    case "remote":
      return api.checkoutRemote(repo, target.name);
    case "create":
      return api.createBranch(repo, target.name);
    case "commit":
      return api.checkoutCommit(repo, target.name);
  }
}
