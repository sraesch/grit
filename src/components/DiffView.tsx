import { MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { changesBetween, DiffHunk, isChange, LineSelection, MAX_LINES, parseDiff, selectionByHunk } from "../diff";

/** A button on each hunk header, e.g. "Stage hunk". */
export interface HunkAction {
  label: string;
  /** Marks a destructive action. */
  danger?: boolean;
  title?: string;
  onClick: (hunk: DiffHunk) => void;
}

/** A button in the header for the selected lines, e.g. "Stage 3 lines". */
export interface LineAction {
  /** The verb, e.g. "Stage"; the button reads "Stage 3 lines". */
  label: string;
  danger?: boolean;
  onClick: (selection: LineSelection[]) => void;
}

interface DiffViewProps {
  diff: string | null;
  loading?: boolean;
  error?: string | null;
  title?: string;
  /** Controls shown at the right of the header. */
  actions?: ReactNode;
  /** A remark shown between the header and the diff, e.g. why a conflict is shown as a diff. */
  note?: string | null;
  /**
   * Buttons for each hunk. Left out of truncated diffs and renames, whose hunks can't be patched
   * on their own.
   */
  hunkActions?: HunkAction[];
  /**
   * Makes changed lines selectable (click, Shift+click, Ctrl/Cmd+click, or drag over the line numbers)
   * and offers these actions for the selection. Not for truncated diffs and renames either.
   */
  lineActions?: LineAction[];
  /** Disables the hunk and line buttons, e.g. while one of them is running. */
  hunkActionsDisabled?: boolean;
}

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

export function DiffView({
  diff,
  loading,
  error,
  title,
  actions,
  note,
  hunkActions,
  lineActions,
  hunkActionsDisabled,
}: DiffViewProps) {
  const parsed = useMemo(() => (diff == null ? null : parseDiff(diff)), [diff]);
  const patchable = !!parsed && !parsed.truncated && !parsed.renamed && !parsed.binary;
  const withHunkActions = patchable && !!hunkActions?.length;
  const selectable = patchable && !!lineActions?.length;

  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);

  // A different diff (another file, or this one after a change) starts without a selection.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [parsed]);

  useEffect(() => {
    const stopDrag = () => (dragging.current = false);
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      // Dialogs close on Escape too; leave them be.
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  /** Click: select the line (or clear a lone selected line). Shift: extend from the last click. Ctrl/Cmd: toggle. */
  function pick(i: number, e: MouseEvent) {
    if (!parsed) return;
    if (e.shiftKey && anchor.current !== null) {
      const range = changesBetween(parsed.lines, anchor.current, i);
      setSelected((prev) => new Set(e.metaKey || e.ctrlKey ? [...prev, ...range] : range));
      return;
    }
    anchor.current = i;
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(i)) next.add(i);
        return next;
      });
    } else {
      setSelected((prev) => (prev.size === 1 && prev.has(i) ? new Set() : new Set([i])));
    }
  }

  const gutterProps = (i: number) =>
    selectable
      ? {
          onMouseDown: (e: MouseEvent) => {
            if (e.button !== 0) return;
            // Dragging over the line numbers selects lines, not text.
            e.preventDefault();
            pick(i, e);
            dragging.current = !e.shiftKey && !e.metaKey && !e.ctrlKey;
          },
        }
      : {};

  const lineProps = (i: number) =>
    selectable
      ? {
          onMouseEnter: () => {
            if (dragging.current && anchor.current !== null && parsed) {
              setSelected(new Set(changesBetween(parsed.lines, anchor.current, i)));
            }
          },
          // A click on the code selects too, unless it was a drag that selected text to copy.
          onClick: (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest(".code") && window.getSelection()?.isCollapsed !== false) pick(i, e);
          },
        }
      : {};

  const selection = useMemo(() => (parsed ? selectionByHunk(parsed, selected) : []), [parsed, selected]);

  const lineButtons =
    selectable && selected.size > 0 ? (
      <span className="line-actions">
        {lineActions.map((a) => (
          <button
            key={a.label}
            className={a.danger ? "small danger" : "small"}
            disabled={hunkActionsDisabled}
            onClick={() => a.onClick(selection)}
          >
            {a.label} {plural(selected.size)}
          </button>
        ))}
      </span>
    ) : null;

  let body;
  if (error) body = <div className="empty error-text">{error}</div>;
  else if (loading && !parsed) body = <div className="empty">Loading…</div>;
  else if (!parsed) body = <div className="empty">Select a file to see its changes</div>;
  else if (parsed.binary) body = <div className="empty">Binary file</div>;
  else if (parsed.lines.length === 0) body = <div className="empty">No textual changes</div>;
  else
    body = (
      <div className={selectable ? "diff-table selectable-lines" : "diff-table"}>
        {parsed.lines.map((l, i) => {
          if (l.kind === "hunk") {
            return (
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
            );
          }
          const change = isChange(l);
          const classes = `diff-line diff-${l.kind}${selected.has(i) ? " selected" : ""}`;
          return (
            <div key={i} className={classes} {...(change ? lineProps(i) : {})}>
              <span className="gutter" {...(change ? gutterProps(i) : {})}>
                <span className="ln">{l.oldNo ?? ""}</span>
                <span className="ln">{l.newNo ?? ""}</span>
                <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              </span>
              <span className="code">{l.text || " "}</span>
            </div>
          );
        })}
        {parsed.truncated && <div className="diff-truncated">Diff truncated after {MAX_LINES} lines</div>}
      </div>
    );

  return (
    <div className="diff-view">
      <PaneTitle
        title={title}
        actions={
          lineButtons || actions ? (
            <>
              {lineButtons}
              {actions}
            </>
          ) : undefined
        }
      />
      {note && title && (
        <p className="conflict-note" role="note">
          {note}
        </p>
      )}
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
