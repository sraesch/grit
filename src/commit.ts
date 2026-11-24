import { Branches, LogEntry, PickResult } from "./api";
import { SwitchTarget, targetForCommit } from "./branches";
import { NoticeKind, plural } from "./remote";

/** What an item of a commit's context menu does. */
export type CommitAction = "checkout" | "create-branch" | "cherry-pick" | "copy-sha" | "copy-message";

export interface CommitMenuItem {
  action: CommitAction;
  label: string;
  /** Why the item can't be chosen right now; null when it can. */
  blocked: string | null;
  /** Tooltip when the item isn't blocked. */
  title?: string;
  danger?: boolean;
}

export type CommitMenuEntry = CommitMenuItem | "separator";

export interface CommitMenuContext {
  branches: Branches | null;
  /** The checked-out commit; null before the first commit. */
  headSha: string | null;
  /** Why commits can't be cherry-picked, reverted or reset onto right now, e.g. a merge in progress; null when they can. */
  operationBlocked: string | null;
  /** Why the repository can't be changed right now, e.g. a branch switch is running; null when it can. */
  busy: string | null;
}

/** "Check Out main", or "Check Out" for a detached HEAD, for what double-clicking the commit checks out. */
function checkoutLabel(target: SwitchTarget | null): string {
  if (!target || target.kind === "commit") return "Check Out";
  return `Check Out ${target.kind === "remote" ? target.localName : target.name}`;
}

function checkoutTitle(target: SwitchTarget | null): string | undefined {
  if (target?.kind === "commit") return "Check out this commit without a branch (detached HEAD)";
  if (target?.kind === "remote") return `Create ${target.localName} tracking ${target.name} and switch to it`;
  return undefined;
}

/** The items of a commit's context menu in the history, as Fork groups them. */
export function commitMenu(entry: LogEntry, ctx: CommitMenuContext): CommitMenuEntry[] {
  const target = targetForCommit(entry, ctx.branches);
  const isHead = entry.sha === ctx.headSha;
  const changeBlocked = ctx.busy ?? ctx.operationBlocked;
  return [
    {
      action: "checkout",
      label: checkoutLabel(target),
      blocked: target ? ctx.busy : "Already checked out",
      title: checkoutTitle(target),
    },
    { action: "create-branch", label: "New Branch Here…", blocked: ctx.busy },
    "separator",
    {
      action: "cherry-pick",
      label: "Cherry-pick…",
      blocked: isHead ? "This commit is checked out" : changeBlocked,
      title: "Apply the changes of this commit onto HEAD",
    },
    "separator",
    { action: "copy-sha", label: "Copy SHA", blocked: null },
    { action: "copy-message", label: "Copy Message", blocked: null },
  ];
}

/** "Cherry-picked a1b2c3d onto main", and how to go on after conflicts. */
export function pickSummary(result: PickResult, short: string, branch: string): { text: string; kind: NoticeKind } {
  const files = plural(result.conflicts, "file");
  switch (result.outcome) {
    case "committed":
      return { kind: "info", text: `Cherry-picked ${short} onto ${branch}.` };
    case "staged":
      return { kind: "info", text: `Staged the changes of ${short}. Review and commit them in Local changes.` };
    case "conflicts":
      return {
        kind: "warning",
        text: `Cherry-picking ${short} stopped with conflicts in ${files}. Resolve them in Local changes, then continue or abort.`,
      };
    case "conflicts-no-commit":
      return {
        kind: "warning",
        text: `Applied the changes of ${short} with conflicts in ${files}. Resolve them in Local changes, then commit.`,
      };
  }
}
