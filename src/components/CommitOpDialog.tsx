import { useState } from "react";
import { LogEntry, PickOptions } from "../api";
import { PickKind } from "../commit";
import { prefs } from "../remote";
import { Dialog } from "./RemoteDialogs";

/** A parent of the commit, for choosing the mainline of a merge commit. */
export interface ParentInfo {
  sha: string;
  /** Its subject, when it is in the loaded history. */
  subject: string | null;
}

interface PickDialogProps {
  kind: PickKind;
  entry: LogEntry;
  parents: ParentInfo[];
  /** The current branch; null for a detached HEAD. */
  branch: string | null;
  onPick: (options: PickOptions) => void;
  onClose: () => void;
}

/**
 * Confirms cherry-picking a commit onto HEAD, or reverting it, with the option to only apply the
 * changes; for a merge commit it asks for the mainline.
 */
export function PickDialog({ kind, entry, parents, branch, onPick, onClose }: PickDialogProps) {
  const revert = kind === "revert";
  const [noCommit, setNoCommit] = useState(() => (revert ? prefs.revert() : prefs.cherryPick()).noCommit);
  const [mainline, setMainline] = useState(1);
  const isMerge = entry.parents.length > 1;
  const target = branch ? <strong className="mono">{branch}</strong> : "the detached HEAD";

  return (
    <Dialog
      id={kind}
      title={revert ? "Revert Commit" : "Cherry-pick"}
      submitLabel={revert ? "Revert" : "Cherry-pick"}
      canSubmit
      onSubmit={() => {
        (revert ? prefs.saveRevert : prefs.saveCherryPick)({ noCommit });
        onPick({ commit: entry.sha, noCommit, mainline: isMerge ? mainline : null });
      }}
      onClose={onClose}
    >
      {revert ? (
        noCommit ? (
          <p className="settings-hint">
            Undo the changes of <CommitRef entry={entry} /> on {target}, without committing.
          </p>
        ) : (
          <p className="settings-hint">
            Create a commit on {target} that undoes the changes of <CommitRef entry={entry} />.
          </p>
        )
      ) : (
        <p className="settings-hint">
          Apply the changes of <CommitRef entry={entry} /> onto {target}
          {noCommit ? ", without committing them." : " as a new commit."}
        </p>
      )}
      {isMerge && (
        <MainlineSelect id={kind} parents={parents} value={mainline} onChange={setMainline} revert={revert} />
      )}
      <div className="dialog-options">
        <label className="checkbox">
          <input type="checkbox" checked={noCommit} onChange={(e) => setNoCommit(e.target.checked)} />
          Only apply the changes, don't commit
        </label>
      </div>
    </Dialog>
  );
}

function CommitRef({ entry }: { entry: LogEntry }) {
  return (
    <>
      <span className="mono">{entry.sha.slice(0, 7)}</span> “{entry.subject}”
    </>
  );
}

interface MainlineSelectProps {
  id: string;
  parents: ParentInfo[];
  /** 1-based, as `git -m` takes it. */
  value: number;
  onChange: (mainline: number) => void;
  revert: boolean;
}

/** Which parent of a merge commit its changes are taken relative to. */
function MainlineSelect({ id, parents, value, onChange, revert }: MainlineSelectProps) {
  return (
    <>
      <label className="settings-label" htmlFor={`${id}-mainline`}>
        Mainline
      </label>
      <div className="settings-row">
        <select
          id={`${id}-mainline`}
          value={value}
          aria-describedby={`${id}-mainline-hint`}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {parents.map((p, i) => (
            <option key={p.sha} value={i + 1}>
              {`Parent ${i + 1}: ${p.sha.slice(0, 7)}${p.subject ? ` ${p.subject}` : ""}`}
            </option>
          ))}
        </select>
      </div>
      <p id={`${id}-mainline-hint`} className="settings-hint">
        {revert
          ? "This is a merge commit. Reverting it undoes what it brought in relative to the mainline, usually parent 1, the branch that was merged into."
          : "This is a merge commit. Its changes are taken relative to the mainline, usually parent 1, the branch that was merged into."}
      </p>
    </>
  );
}
