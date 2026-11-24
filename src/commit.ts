import { Branches, LogEntry, PickResult, ResetMode, ResetPreview } from "./api";
import { SwitchTarget, targetForCommit } from "./branches";
import { NoticeKind, plural } from "./remote";

/** What an item of a commit's context menu does. */
export type CommitAction =
  | "checkout"
  | "create-branch"
  | "cherry-pick"
  | "revert"
  | "reset"
  | "copy-sha"
  | "copy-message";

/** Applying a commit's changes, or undoing them. */
export type PickKind = "cherry-pick" | "revert";

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
  /** The current branch; null for a detached HEAD. */
  branch: string | null;
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
    {
      action: "revert",
      label: "Revert…",
      blocked: changeBlocked,
      title: "Create a commit that undoes the changes of this commit",
    },
    {
      action: "reset",
      label: `Reset ${ctx.branch ?? "HEAD"} to Here…`,
      blocked: isHead ? "This commit is checked out" : changeBlocked,
      title: `Move ${ctx.branch ?? "the detached HEAD"} to this commit`,
    },
    "separator",
    { action: "copy-sha", label: "Copy SHA", blocked: null },
    { action: "copy-message", label: "Copy Message", blocked: null },
  ];
}

/** "Cherry-picked a1b2c3d onto main" or "Reverted a1b2c3d on main", and how to go on after conflicts. */
export function pickSummary(
  kind: PickKind,
  result: PickResult,
  short: string,
  branch: string,
): { text: string; kind: NoticeKind } {
  const files = plural(result.conflicts, "file");
  const revert = kind === "revert";
  switch (result.outcome) {
    case "committed":
      return { kind: "info", text: revert ? `Reverted ${short} on ${branch}.` : `Cherry-picked ${short} onto ${branch}.` };
    case "staged":
      return {
        kind: "info",
        text: revert
          ? `Staged the changes that undo ${short}. Review and commit them in Local changes.`
          : `Staged the changes of ${short}. Review and commit them in Local changes.`,
      };
    case "conflicts":
      return {
        kind: "warning",
        text: `${revert ? "Reverting" : "Cherry-picking"} ${short} stopped with conflicts in ${files}. Resolve them in Local changes, then continue or abort.`,
      };
    case "conflicts-no-commit":
      return {
        kind: "warning",
        text: `Applied the changes of ${short} with conflicts in ${files}. Resolve them in Local changes, then commit.`,
      };
  }
}

export const RESET_MODES: { mode: ResetMode; label: string; description: string }[] = [
  {
    mode: "soft",
    label: "Soft",
    description: "Keep the changes of the dropped commits and your local changes staged.",
  },
  {
    mode: "mixed",
    label: "Mixed",
    description: "Keep the changes of the dropped commits and your local changes, unstaged.",
  },
  {
    mode: "hard",
    label: "Hard",
    description: "Discard the changes of the dropped commits and all local changes to tracked files.",
  },
];

/** What resetting `branch` does to its commits, e.g. "2 commits will no longer be on main." */
export function resetPreviewText(preview: ResetPreview, branch: string): string {
  const { dropped, added } = preview;
  if (dropped === 0 && added === 0) return `${branch} already points at this commit.`;
  if (dropped === 0) return `${branch} moves forward by ${plural(added, "commit")}.`;
  const gone = `${plural(dropped, "commit")} will no longer be on ${branch}`;
  return added > 0 ? `${gone}, and ${plural(added, "commit")} it doesn't contain yet will be.` : `${gone}.`;
}

/** Warns before dropping commits that were pushed; null when none are. */
export function resetPushedWarning(preview: ResetPreview, branch: string): string | null {
  const n = preview.droppedPushed;
  if (n === 0) return null;
  return `${plural(n, "commit")} that ${n === 1 ? "was" : "were"} already pushed will be dropped from ${branch}. Pushing ${branch} afterwards needs a force push, and others may still build on ${n === 1 ? "it" : "them"}.`;
}
