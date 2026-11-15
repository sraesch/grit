import { api, Branch, Branches } from "./api";

/** Something the branch switcher can switch to. */
export type SwitchTarget =
  | { kind: "local"; name: string }
  /** A remote branch without a local branch of the same name; switching creates one that tracks it. */
  | { kind: "remote"; name: string; localName: string }
  /** A new branch at HEAD. */
  | { kind: "create"; name: string };

export type SwitchOption = SwitchTarget & { current?: boolean; track?: string | null };

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
export function targetForRemote(branches: Branches, remote: Branch): SwitchTarget {
  const localName = localNameOf(remote.name);
  const local = branches.local.find((b) => b.upstream === remote.name) ?? branches.local.find((b) => b.name === localName);
  return local ? { kind: "local", name: local.name } : { kind: "remote", name: remote.name, localName };
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
  }
}
