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

interface DeleteRemoteBranchDialogProps {
  /** The remote branch, e.g. "origin/feature". */
  name: string;
  remote: string;
  /** Its name on the remote, e.g. "feature". */
  branch: string;
  /** Local branches tracking it, which are kept. */
  trackedBy: string[];
  onDelete: () => void;
  onClose: () => void;
}

/** Confirms deleting a branch on its remote. */
export function DeleteRemoteBranchDialog({ name, remote, branch, trackedBy, onDelete, onClose }: DeleteRemoteBranchDialogProps) {
  return (
    <Dialog
      id="delete-remote-branch"
      title="Delete Remote Branch"
      submitLabel="Delete"
      danger
      canSubmit
      onSubmit={onDelete}
      onClose={onClose}
    >
      <p className="settings-hint">
        Delete the branch <strong className="mono">{branch}</strong> on <span className="mono">{remote}</span>? This
        changes the remote for everyone who uses it, and grit can't undo it. Nothing is deleted when someone pushed to{" "}
        <span className="mono">{name}</span> since it was last fetched.
      </p>
      {trackedBy.length > 0 && (
        <p className="settings-hint" role="note">
          {trackedBy.length === 1 ? "The local branch " : "The local branches "}
          <span className="mono">{trackedBy.join(", ")}</span>
          {trackedBy.length === 1 ? " tracks it and is kept." : " track it and are kept."}
        </p>
      )}
    </Dialog>
  );
}
