import { Branch } from "../api";
import { Dialog } from "./RemoteDialogs";

interface DeleteBranchDialogProps {
  branch: Branch;
  /** git kept the branch because it has unmerged commits; confirming deletes it anyway. */
  unmerged: boolean;
  onDelete: (branch: Branch, force: boolean) => void;
  onClose: () => void;
}

/** Confirms deleting a local branch, and again before dropping unmerged commits. */
export function DeleteBranchDialog({ branch, unmerged, onDelete, onClose }: DeleteBranchDialogProps) {
  return (
    <Dialog
      id="delete-branch"
      title="Delete Branch"
      submitLabel={unmerged ? "Delete Anyway" : "Delete"}
      danger
      canSubmit
      onSubmit={() => onDelete(branch, unmerged)}
      onClose={onClose}
    >
      <p className="settings-hint">
        Delete the local branch <strong className="mono">{branch.name}</strong>?
      </p>
      {unmerged ? (
        <p className="settings-hint warning-text" role="note">
          {branch.name} has commits that aren't merged yet. Unless they are on another branch too, deleting it loses
          them.
        </p>
      ) : (
        branch.upstream && (
          <p className="settings-hint">
            The remote branch <span className="mono">{branch.upstream}</span> is kept.
          </p>
        )
      )}
    </Dialog>
  );
}
