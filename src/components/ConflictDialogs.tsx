import { useEffect, useRef } from "react";
import { ConflictSide, FileChange } from "../api";
import { ConflictSides, removedBy, sideName } from "../conflict";
import { plural } from "../remote";
import { Dialog } from "./RemoteDialogs";

/** How many paths a dialog names before summing up the rest. */
const MAX_LISTED = 10;

interface ResolveSideDialogProps {
  /** The conflicted files to resolve. */
  files: FileChange[];
  side: ConflictSide;
  sides: ConflictSides;
  onResolve: (files: FileChange[], side: ConflictSide) => void;
  onClose: () => void;
}

/** Confirms resolving several conflicted files at once with one side, which drops the other side's changes. */
export function ResolveSideDialog({ files, side, sides, onResolve, onClose }: ResolveSideDialogProps) {
  const chosen = sides[side];
  const other = sides[side === "ours" ? "theirs" : "ours"];
  const removed = new Set(removedBy(files, side).map((f) => f.path));
  const listed = files.slice(0, MAX_LISTED);
  return (
    <Dialog
      id="resolve-side"
      title="Resolve Conflicts"
      submitLabel={`Use ${chosen.name}`}
      canSubmit={files.length > 0}
      onSubmit={() => onResolve(files, side)}
      onClose={onClose}
    >
      <p className="settings-hint">
        Resolve {plural(files.length, "conflicted file")} with {sideName(chosen)}?
      </p>
      <ul className="discard-list">
        {listed.map((f) => (
          <li key={f.path}>
            {f.path}
            {removed.has(f.path) && <span className="more"> (deleted)</span>}
          </li>
        ))}
        {files.length > listed.length && <li className="more">and {files.length - listed.length} more</li>}
      </ul>
      <p className="settings-hint warning-text" role="note">
        The changes of {other.name} to {files.length === 1 ? "this file" : "these files"} are left out, along with
        anything edited in them by hand.
        {removed.size > 0 && ` ${plural(removed.size, "file")} that ${chosen.name} doesn't have will be deleted.`}
      </p>
    </Dialog>
  );
}

interface MergeToolDialogProps {
  /** Opens the settings, where a merge tool can be chosen. Without it, the button isn't offered. */
  onOpenSettings?: () => void;
  onClose: () => void;
}

/** Explains how to choose a merge tool, shown when a file should be opened in one and none is set. */
export function MergeToolDialog({ onOpenSettings, onClose }: MergeToolDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes; focus returns to whatever opened the dialog.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="merge-tool-title">
        <header className="modal-header">
          <h2 id="merge-tool-title">No Merge Tool Configured</h2>
        </header>
        <div className="settings-body">
          <p className="settings-hint">
            grit opens conflicted files in the merge tool chosen in Settings or, without one, in the merge tool that
            git is set up with, and none is set yet. Choose one in Settings, or for git in a terminal, for example
            Meld:
          </p>
          <pre className="dialog-code selectable">git config --global merge.tool meld</pre>
          <p className="settings-hint">
            <code>git mergetool --tool-help</code> lists the tools git knows. If the tool isn't found when it is
            opened, also say where it is installed:
          </p>
          <pre className="dialog-code selectable">git config --global mergetool.meld.path /path/to/meld</pre>
          <p className="settings-hint">
            A tool set as <code>merge.guitool</code> is used first. Tools that run in a terminal, such as vimdiff,
            can't be opened from grit.
          </p>
        </div>
        <footer className="modal-footer">
          {onOpenSettings ? (
            <>
              <button ref={closeRef} onClick={onClose}>
                Close
              </button>
              <button
                className="primary"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                Open Settings
              </button>
            </>
          ) : (
            <button ref={closeRef} className="primary" onClick={onClose}>
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
