import {
  Branch,
  Branches,
  ConflictKind,
  ConflictSegment,
  ConflictSide,
  FileChange,
  MergeToolResult,
  Status,
} from "./api";
import { NoticeKind, plural } from "./remote";

/** One side of a conflict, named after what it is in the operation in progress. */
export interface SideLabel {
  /** A branch or a short commit, e.g. "main" or "abc1234". */
  name: string;
  /** What that is, e.g. "current branch". */
  detail: string;
}

export interface ConflictSides {
  ours: SideLabel;
  theirs: SideLabel;
}

/** The sides when nothing is known about them. */
export const GENERIC_SIDES: ConflictSides = {
  ours: { name: "ours", detail: "current branch" },
  theirs: { name: "theirs", detail: "incoming changes" },
};

const short = (sha: string) => sha.slice(0, 7);

/**
 * The name of a branch or tag that points at `sha`: one of `preferred` if it does, else a local
 * branch before a remote one before a tag. Null when nothing points there, so a name is never a guess.
 */
function refName(sha: string, branches: Branches | null, preferred: (string | null | undefined)[]): string | null {
  if (!branches) return null;
  // Branches come with abbreviated SHAs.
  const at = (b: Branch) => b.sha.length > 0 && sha.startsWith(b.sha);
  const all = [...branches.local, ...branches.remote, ...branches.tags];
  for (const name of preferred) {
    if (name && all.some((b) => b.name === name && at(b))) return name;
  }
  return all.find(at)?.name ?? null;
}

/** The names git quotes in the first line of a merge message, e.g. "Merge branch 'feature' into main". */
function quotedNames(message: string | null): string[] {
  const firstLine = message?.split("\n", 1)[0] ?? "";
  return [...firstLine.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Who the two sides of the current conflicts are. Ours is what was checked out when the operation
 * started, theirs what it brings in; a rebase turns that around, as it replays the branch's commits
 * onto the other branch.
 */
export function conflictSides(status: Status | null, branches: Branches | null): ConflictSides {
  if (!status) return GENERIC_SIDES;
  const current: SideLabel = status.branch
    ? { name: status.branch, detail: "current branch" }
    : { name: "HEAD", detail: "checked-out commit" };
  const incoming = (detail: string): SideLabel => ({ name: "incoming", detail });
  const op = status.operation;

  switch (op?.kind) {
    case "merge": {
      // A pull names the remote's branch like the local one: the upstream is what points at the commit.
      const name = op.commit
        ? (refName(op.commit, branches, [...quotedNames(op.message), status.upstream]) ?? short(op.commit))
        : null;
      return { ours: current, theirs: name ? { name, detail: "being merged" } : incoming("changes being merged") };
    }
    case "squash": {
      // The prepared message lists the squashed commits, newest first.
      const tip = op.message?.match(/^commit ([0-9a-f]{7,64})\b/m)?.[1];
      const name = tip ? refName(tip, branches, []) : null;
      return { ours: current, theirs: name ? { name, detail: "being squashed" } : incoming("changes being squashed") };
    }
    case "rebase": {
      const upstream = branches?.local.find((b) => b.name === op.head)?.upstream;
      const onto = op.onto ? (refName(op.onto, branches, [upstream]) ?? short(op.onto)) : null;
      const replayed = op.commit ? `commit ${short(op.commit)} being replayed` : "commit being replayed";
      return {
        ours: onto
          ? { name: onto, detail: op.head ? `new base of ${op.head}` : "new base" }
          : { name: "ours", detail: "new base" },
        theirs: { name: op.head ?? (op.commit ? short(op.commit) : "theirs"), detail: replayed },
      };
    }
    case "cherry-pick":
      return {
        ours: current,
        theirs: op.commit
          ? { name: short(op.commit), detail: "commit being cherry-picked" }
          : incoming("commit being cherry-picked"),
      };
    case "revert":
      return {
        ours: current,
        theirs: { name: "the revert", detail: op.commit ? `undoing ${short(op.commit)}` : "undoing a commit" },
      };
    default:
      // Applying a stash, or a cherry-pick without a commit, leaves conflicts behind without an operation.
      return { ours: current, theirs: incoming("changes being applied") };
  }
}

/** Whether a side has a version of the file: taking a side that deleted it (or never had it) removes the file. */
export function sideKeeps(kind: ConflictKind | null | undefined, side: ConflictSide): boolean {
  switch (kind) {
    case "both-deleted":
      return false;
    case "deleted-by-us":
    case "added-by-them":
      return side === "theirs";
    case "deleted-by-them":
    case "added-by-us":
      return side === "ours";
    default:
      return true;
  }
}

/** "Deleted in feature, changed in main": what the sides did to a conflicted file. */
export function conflictKindLabel(kind: ConflictKind | null | undefined, sides: ConflictSides): string {
  const { ours, theirs } = sides;
  switch (kind) {
    case "both-added":
      return "Added on both sides";
    case "both-deleted":
      return "Deleted on both sides";
    case "deleted-by-us":
      return `Deleted in ${ours.name}, changed in ${theirs.name}`;
    case "deleted-by-them":
      return `Changed in ${ours.name}, deleted in ${theirs.name}`;
    case "added-by-us":
      return `Only in ${ours.name}`;
    case "added-by-them":
      return `Only in ${theirs.name}`;
    default:
      return "Changed on both sides";
  }
}

/** "main (current branch)". */
export const sideName = (side: SideLabel) => `${side.name} (${side.detail})`;

/** Tooltip of "Use ours" / "Use theirs" on a file: who that side is, and what happens to the file. */
export function resolveTitle(file: FileChange, side: ConflictSide, sides: ConflictSides): string {
  const who = sideName(sides[side]);
  return sideKeeps(file.conflict, side)
    ? `Resolve with the version of ${who}`
    : `${who} has no such file: resolving deletes it`;
}

/** The files that taking `side` removes instead of keeping a version. */
export function removedBy(files: FileChange[], side: ConflictSide): FileChange[] {
  return files.filter((f) => !sideKeeps(f.conflict, side));
}

/** Why a conflicted file can't be opened in a merge tool; null when it can. */
export function mergeToolBlocked(kind: ConflictKind | null | undefined): string | null {
  return kind == null || kind === "both-modified" || kind === "both-added"
    ? null
    : "A merge tool needs a version from both sides: use one of the sides instead";
}

/** A tool that returns this quickly most likely didn't wait for its window to be closed. */
const DID_NOT_WAIT_MS = 2000;

/** What to tell the user after the merge tool was closed. */
export function mergeToolSummary(
  result: MergeToolResult,
  path: string,
  elapsedMs: number,
): { text: string; kind: NoticeKind } {
  if (result.outcome === "resolved") {
    const backup = result.backup ? `. git kept the conflicted file as ${result.backup}` : "";
    return { kind: "info", text: `Resolved ${path} in ${result.tool}${backup}` };
  }
  const hint =
    elapsedMs < DID_NOT_WAIT_MS
      ? ` If its window is still open, ${result.tool} didn't wait for it: set it up to wait until the file is closed.`
      : "";
  return {
    kind: "warning",
    text: `${path} is still conflicted: ${result.tool} was closed without saving a result.${hint}`,
  };
}

/** What an item of a conflicted file's context menu does. */
export type ConflictAction = "use-ours" | "use-theirs" | "merge-tool" | "mark-resolved";

export interface ConflictMenuItem {
  action: ConflictAction;
  label: string;
  /** Why the item can't be chosen right now; null when it can. */
  blocked: string | null;
  /** Tooltip when the item isn't blocked. */
  title?: string;
}

export type ConflictMenuEntry = ConflictMenuItem | "separator";

/** What the menu is about: one conflicted file, or every conflicted file in a folder. */
export type ConflictTarget = { kind: "file"; file: FileChange } | { kind: "folder"; path: string; files: FileChange[] };

export interface ConflictMenuContext {
  sides: ConflictSides;
  /** Why no merge tool can be opened right now, e.g. one is open already; null when one can. */
  toolBusy: string | null;
}

/** The context menu of a conflicted file, or of a folder of conflicted files. */
export function conflictMenu(target: ConflictTarget, ctx: ConflictMenuContext): ConflictMenuEntry[] {
  const { ours, theirs } = ctx.sides;
  if (target.kind === "folder") {
    const count = plural(target.files.length, "file");
    return [
      { action: "use-ours", label: `Use ${ours.name} for Folder…`, blocked: null, title: count },
      { action: "use-theirs", label: `Use ${theirs.name} for Folder…`, blocked: null, title: count },
      "separator",
      { action: "mark-resolved", label: "Mark Folder Resolved", blocked: null, title: count },
    ];
  }
  const file = target.file;
  return [
    {
      action: "use-ours",
      label: `Use ${sideName(ours)}`,
      blocked: null,
      title: resolveTitle(file, "ours", ctx.sides),
    },
    {
      action: "use-theirs",
      label: `Use ${sideName(theirs)}`,
      blocked: null,
      title: resolveTitle(file, "theirs", ctx.sides),
    },
    {
      action: "merge-tool",
      label: "Open in Merge Tool",
      blocked: mergeToolBlocked(file.conflict) ?? ctx.toolBusy,
      title: "Open the file in your merge tool and wait until it is closed",
    },
    "separator",
    { action: "mark-resolved", label: "Mark Resolved", blocked: null, title: "Stage the file as it is now" },
  ];
}

/** Why a conflicted file can't be shown in the conflict editor; null when it can be tried. */
export function editorBlocked(kind: ConflictKind | null | undefined): string | null {
  return kind == null || kind === "both-modified" || kind === "both-added"
    ? null
    : "One side has no version of this file, so there is nothing to merge line by line. Take one of the sides.";
}

/** How the backend's refusal to save starts when the conflict changed since it was loaded. */
export const STALE_CONFLICT = "The conflict changed since it was opened.";

/** How a conflict is resolved with the text of the sides: one of them, or both in either order. */
export type ConflictChoice = "ours" | "theirs" | "ours-theirs" | "theirs-ours";

/** The text a choice puts in the place of a conflict. */
export function takeText(conflict: { ours: string; theirs: string }, choice: ConflictChoice): string {
  // The last line of a file may lack its line break, which the lines put after it need.
  const both = (first: string, second: string) =>
    first && second && !first.endsWith("\n") ? `${first}\n${second}` : first + second;
  switch (choice) {
    case "ours":
      return conflict.ours;
    case "theirs":
      return conflict.theirs;
    case "ours-theirs":
      return both(conflict.ours, conflict.theirs);
    case "theirs-ours":
      return both(conflict.theirs, conflict.ours);
  }
}

/** A stretch of a document, as character offsets. */
export interface TextRange {
  from: number;
  to: number;
}

/** One conflict of a file: its text on each side and where it is in the editor's three documents. */
export interface ConflictPlace {
  ours: TextRange;
  theirs: TextRange;
  result: TextRange;
  oursText: string;
  theirsText: string;
  /** The text of the common ancestor; null when there is none. */
  base: string | null;
}

/** The three documents of the conflict editor and the conflicts in them. */
export interface ConflictLayout {
  ours: string;
  theirs: string;
  /** The merged file, with the common ancestor's text in the place of each conflict until it is resolved. */
  result: string;
  conflicts: ConflictPlace[];
}

/** Lays a conflicted file out as the documents the editor shows side by side. */
export function layoutConflict(segments: ConflictSegment[]): ConflictLayout {
  let [ours, theirs, result] = ["", "", ""];
  const conflicts: ConflictPlace[] = [];
  for (const segment of segments) {
    if (segment.kind === "common") {
      ours += segment.text;
      theirs += segment.text;
      result += segment.text;
      continue;
    }
    const start = segment.base ?? "";
    conflicts.push({
      ours: { from: ours.length, to: ours.length + segment.ours.length },
      theirs: { from: theirs.length, to: theirs.length + segment.theirs.length },
      result: { from: result.length, to: result.length + start.length },
      oursText: segment.ours,
      theirsText: segment.theirs,
      base: segment.base,
    });
    ours += segment.ours;
    theirs += segment.theirs;
    result += start;
  }
  return { ours, theirs, result, conflicts };
}

/**
 * The line of one pane that shows the same place as `line` of another, for scrolling them together.
 * `from` and `to` list, for the two panes, the lines at which each conflict starts and ends, framed
 * by 0 and the number of lines: between two of these fixed points, lines are spread evenly.
 */
export function mapLine(from: number[], to: number[], line: number): number {
  let i = 1;
  while (i < from.length - 1 && from[i] <= line) i++;
  const span = from[i] - from[i - 1];
  const within = span > 0 ? Math.min(1, Math.max(0, (line - from[i - 1]) / span)) : 0;
  return to[i - 1] + within * (to[i] - to[i - 1]);
}
