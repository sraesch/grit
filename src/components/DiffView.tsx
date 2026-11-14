import { useMemo } from "react";

const MAX_LINES = 5000;

type LineKind = "add" | "del" | "ctx" | "hunk" | "meta";

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

function parseDiff(diff: string): { lines: DiffLine[]; binary: boolean; truncated: boolean } {
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

interface DiffViewProps {
  diff: string | null;
  loading?: boolean;
  error?: string | null;
  title?: string;
}

export function DiffView({ diff, loading, error, title }: DiffViewProps) {
  const parsed = useMemo(() => (diff == null ? null : parseDiff(diff)), [diff]);

  let body;
  if (error) body = <div className="empty error-text">{error}</div>;
  else if (loading && !parsed) body = <div className="empty">Loading…</div>;
  else if (!parsed) body = <div className="empty">Select a file to see its changes</div>;
  else if (parsed.binary) body = <div className="empty">Binary file</div>;
  else if (parsed.lines.length === 0) body = <div className="empty">No textual changes</div>;
  else
    body = (
      <div className="diff-table">
        {parsed.lines.map((l, i) => (
          <div key={i} className={`diff-line diff-${l.kind}`}>
            <span className="ln">{l.oldNo ?? ""}</span>
            <span className="ln">{l.newNo ?? ""}</span>
            <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
            <span className="code">{l.text || " "}</span>
          </div>
        ))}
        {parsed.truncated && <div className="diff-truncated">Diff truncated after {MAX_LINES} lines</div>}
      </div>
    );

  return (
    <div className="diff-view">
      {title && <div className="pane-header mono">{title}</div>}
      <div className="diff-scroll">{body}</div>
    </div>
  );
}
