import { Branches, LogEntry } from "./api";
import { SwitchTarget, targetForCommit } from "./branches";

/** What an item of a commit's context menu does. */
export type CommitAction = "checkout" | "create-branch" | "copy-sha" | "copy-message";

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
  return [
    {
      action: "checkout",
      label: checkoutLabel(target),
      blocked: target ? ctx.busy : "Already checked out",
      title: checkoutTitle(target),
    },
    { action: "create-branch", label: "New Branch Here…", blocked: ctx.busy },
    "separator",
    { action: "copy-sha", label: "Copy SHA", blocked: null },
    { action: "copy-message", label: "Copy Message", blocked: null },
  ];
}
