export const MAX_LINES = 5000;

export type LineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Index of the hunk the line belongs to (for hunk headers: the hunk they start). */
  hunk?: number;
  /** Position among the hunk's body lines, as the backend counts them when patching. */
  offset?: number;
}

export interface DiffHunk {
  index: number;
  /** The hunk's `@@` line, which the backend checks before patching. */
  header: string;
}

export interface ParsedDiff {
  lines: DiffLine[];
  hunks: DiffHunk[];
  binary: boolean;
  truncated: boolean;
  /** A rename or copy, whose hunks can't be staged on their own. */
  renamed: boolean;
}

export function parseDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  let oldNo = 0;
  let newNo = 0;
  let offset = 0;
  let inHunk = false;
  let binary = false;
  let renamed = false;

  const raw = diff.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();

  for (const text of raw) {
    if (text.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      inHunk = true;
      offset = 0;
      lines.push({ kind: "hunk", text, hunk: hunks.length });
      hunks.push({ index: hunks.length, header: text });
    } else if (!inHunk) {
      if (text.startsWith("Binary files")) binary = true;
      if (text.startsWith("rename from") || text.startsWith("copy from")) renamed = true;
      // File headers (diff --git, index, ---, +++) are noise in a per-file view.
    } else if (text.startsWith("diff --git")) {
      inHunk = false;
    } else {
      const at = { hunk: hunks.length - 1, offset: offset++ };
      if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), newNo: newNo++, ...at });
      else if (text.startsWith("-")) lines.push({ kind: "del", text: text.slice(1), oldNo: oldNo++, ...at });
      else if (text.startsWith("\\")) lines.push({ kind: "meta", text, ...at });
      else lines.push({ kind: "ctx", text: text.slice(1), oldNo: oldNo++, newNo: newNo++, ...at });
    }
    if (lines.length > MAX_LINES) {
      return { lines: lines.slice(0, MAX_LINES), hunks, binary, truncated: true, renamed };
    }
  }
  return { lines, hunks, binary, truncated: false, renamed };
}

/** Whether a line can be selected for staging, unstaging or discarding: only changed lines can. */
export const isChange = (line: DiffLine) => line.kind === "add" || line.kind === "del";

/** The changed lines between two line indexes, both included, in either order. */
export function changesBetween(lines: DiffLine[], from: number, to: number): number[] {
  const [start, end] = from <= to ? [from, to] : [to, from];
  const range: number[] = [];
  for (let i = start; i <= end; i++) if (lines[i] && isChange(lines[i])) range.push(i);
  return range;
}

/** Selected changes in one hunk, as the backend takes them (see `HunkSelection` in api.ts). */
export interface LineSelection {
  index: number;
  header: string;
  lines: number[];
}

/** Groups selected line indexes into per-hunk selections of body offsets, in diff order. */
export function selectionByHunk(parsed: ParsedDiff, selected: Iterable<number>): LineSelection[] {
  const byHunk = new Map<number, number[]>();
  for (const i of [...selected].sort((a, b) => a - b)) {
    const line = parsed.lines[i];
    if (!line || !isChange(line) || line.hunk === undefined || line.offset === undefined) continue;
    const offsets = byHunk.get(line.hunk) ?? [];
    offsets.push(line.offset);
    byHunk.set(line.hunk, offsets);
  }
  return [...byHunk].map(([index, lines]) => ({ index, header: parsed.hunks[index].header, lines }));
}
