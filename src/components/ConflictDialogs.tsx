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
