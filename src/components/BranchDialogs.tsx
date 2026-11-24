import { useState } from "react";
import { toBranchName } from "../branches";
import { prefs } from "../remote";
import { Dialog } from "./RemoteDialogs";
import { useSave } from "./RemoteManageDialogs";

interface CreateBranchDialogProps {
  /** Where the branch starts, as shown to the user, e.g. "a1b2c3d4 Fix the build" or "origin/main". */
  startLabel: string;
  /** Creates the branch and, with `checkout`, switches to it; rejects to show why it failed. */
  onCreate: (name: string, checkout: boolean) => Promise<void>;
  onClose: () => void;
}

/** Creates a branch at a commit or another branch, optionally switching to it. */
export function CreateBranchDialog({ startLabel, onCreate, onClose }: CreateBranchDialogProps) {
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(() => prefs.createBranch().checkout);
  const { busy, error, clearError, save } = useSave();
  const branchName = toBranchName(name);

  return (
    <Dialog
      id="create-branch"
      title="New Branch"
      submitLabel={checkout ? "Create and Check Out" : "Create"}
      canSubmit={branchName !== ""}
      onSubmit={() =>
        save(() => {
          prefs.saveCreateBranch({ checkout });
          return onCreate(branchName, checkout);
        })
      }
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <label className="settings-label" htmlFor="create-branch-name">
        Name
      </label>
      <div className="settings-row">
        <input
          id="create-branch-name"
          className="mono"
          value={name}
          placeholder="feature/my-change"
          spellCheck={false}
          autoComplete="off"
          aria-describedby="create-branch-hint"
          onChange={(e) => {
            setName(e.target.value);
            clearError();
          }}
        />
      </div>
      <p id="create-branch-hint" className="settings-hint">
        Starts at <span className="mono">{startLabel}</span>.
        {branchName !== name.trim() && branchName && (
          <>
            {" "}
            Spaces become dashes: <span className="mono">{branchName}</span>.
          </>
        )}
      </p>
      <div className="dialog-options">
        <label className="checkbox">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
          Check out the new branch
        </label>
      </div>
    </Dialog>
  );
}
