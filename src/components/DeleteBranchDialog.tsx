import { useState } from "react";
import { Branch } from "../api";
import { Dialog } from "./RemoteDialogs";

interface DeleteBranchDialogProps {
  branch: Branch;
  /** The remote branch it tracks, e.g. "origin/feature", if that still exists; offered for deletion too. */
  remoteBranch: string | null;
  /** Whether the remote branch starts selected, e.g. when asking again. */
  withRemote: boolean;
  /** Nothing was deleted because of unmerged commits; confirming deletes anyway. */
  unmerged: boolean;
  onDelete: (branch: Branch, force: boolean, withRemote: boolean) => void;
  onClose: () => void;
}

/** Confirms deleting a local branch, optionally with its remote branch, and again before dropping unmerged commits. */
export function DeleteBranchDialog({
  branch,
  remoteBranch,
  withRemote: initialWithRemote,
  unmerged,
  onDelete,
  onClose,
}: DeleteBranchDialogProps) {
  const [withRemote, setWithRemote] = useState(initialWithRemote && !!remoteBranch);

  return (
    <Dialog
      id="delete-branch"
      title="Delete Branch"
      submitLabel={unmerged ? "Delete Anyway" : "Delete"}
      danger
      canSubmit
      onSubmit={() => onDelete(branch, unmerged, withRemote)}
      onClose={onClose}
    >
      <p className="settings-hint">
        Delete the local branch <strong className="mono">{branch.name}</strong>?
      </p>
      {remoteBranch && (
        <div className="dialog-options">
          <label className="checkbox">
            <input type="checkbox" checked={withRemote} onChange={(e) => setWithRemote(e.target.checked)} />
            Also delete the remote branch <span className="mono">{remoteBranch}</span>
          </label>
        </div>
      )}
      {unmerged && (
        <p className="settings-hint warning-text" role="note">
          {withRemote
            ? `${branch.name} or ${remoteBranch} has commits that aren't merged into the current branch.`
            : `${branch.name} has commits that aren't merged yet.`}{" "}
          Unless they are on another branch too, deleting loses them.
        </p>
      )}
    </Dialog>
  );
}
