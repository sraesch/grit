import { ReactNode, useMemo } from "react";
import { DiffHunk, MAX_LINES, parseDiff } from "../diff";

/** A button on each hunk header, e.g. "Stage hunk". */
export interface HunkAction {
  label: string;
  /** Marks a destructive action. */
  danger?: boolean;
  title?: string;
  onClick: (hunk: DiffHunk) => void;
}

interface DiffViewProps {
  diff: string | null;
  loading?: boolean;
  error?: string | null;
  title?: string;
  /** Controls shown at the right of the header. */
  actions?: ReactNode;
  /**
   * Buttons for each hunk. Left out of truncated diffs and renames, whose hunks can't be patched
   * on their own.
   */
  hunkActions?: HunkAction[];
  /** Disables the hunk buttons, e.g. while one of them is running. */
  hunkActionsDisabled?: boolean;
}

export function DiffView({ diff, loading, error, title, actions, hunkActions, hunkActionsDisabled }: DiffViewProps) {
  const parsed = useMemo(() => (diff == null ? null : parseDiff(diff)), [diff]);
  const withHunkActions = !!hunkActions?.length && !!parsed && !parsed.truncated && !parsed.renamed;

  let body;
  if (error) body = <div className="empty error-text">{error}</div>;
  else if (loading && !parsed) body = <div className="empty">Loading…</div>;
  else if (!parsed) body = <div className="empty">Select a file to see its changes</div>;
  else if (parsed.binary) body = <div className="empty">Binary file</div>;
  else if (parsed.lines.length === 0) body = <div className="empty">No textual changes</div>;
  else
    body = (
      <div className="diff-table">
        {parsed.lines.map((l, i) =>
          l.kind === "hunk" ? (
            <div key={i} className="diff-line diff-hunk">
              <span className="code">{l.text}</span>
              {withHunkActions && (
                <span className="hunk-actions">
                  {hunkActions.map((a) => (
                    <button
                      key={a.label}
                      className={a.danger ? "small danger" : "small"}
                      title={a.title}
                      disabled={hunkActionsDisabled}
                      onClick={() => a.onClick(parsed.hunks[l.hunk!])}
                    >
                      {a.label}
                    </button>
                  ))}
                </span>
              )}
            </div>
          ) : (
            <div key={i} className={`diff-line diff-${l.kind}`}>
              <span className="ln">{l.oldNo ?? ""}</span>
              <span className="ln">{l.newNo ?? ""}</span>
              <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              <span className="code">{l.text || " "}</span>
            </div>
          ),
        )}
        {parsed.truncated && <div className="diff-truncated">Diff truncated after {MAX_LINES} lines</div>}
      </div>
    );

  return (
    <div className="diff-view">
      <PaneTitle title={title} actions={actions} />
      <div className="diff-scroll">{body}</div>
    </div>
  );
}

/** Header of the diff pane, shared with the image preview. */
export function PaneTitle({ title, actions }: { title?: string; actions?: ReactNode }) {
  if (!title) return null;
  return (
    <div className="pane-header mono">
      <span className="pane-title">{title}</span>
      {actions}
    </div>
  );
}
