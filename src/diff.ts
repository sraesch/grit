export const MAX_LINES = 5000;

export type LineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export function parseDiff(diff: string): { lines: DiffLine[]; binary: boolean; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let binary = false;

  const raw = diff.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();

  for (const text of raw) {
    if (text.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      inHunk = true;
      lines.push({ kind: "hunk", text });
    } else if (!inHunk) {
      if (text.startsWith("Binary files")) binary = true;
      // File headers (diff --git, index, ---, +++) are noise in a per-file view.
    } else if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), newNo: newNo++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "del", text: text.slice(1), oldNo: oldNo++ });
    } else if (text.startsWith("\\")) {
      lines.push({ kind: "meta", text });
    } else if (text.startsWith("diff --git")) {
      inHunk = false;
    } else {
      lines.push({ kind: "ctx", text: text.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    if (lines.length > MAX_LINES) {
      return { lines: lines.slice(0, MAX_LINES), binary, truncated: true };
    }
  }
  return { lines, binary, truncated: false };
}
