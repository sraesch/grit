import { useMemo } from "react";
import { MAX_LINES, parseDiff } from "../diff";

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
