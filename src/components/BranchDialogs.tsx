import { useState } from "react";
import { Branch } from "../api";
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

interface RenameBranchDialogProps {
  branch: Branch;
  /** The remote branch it tracks, when that exists, e.g. "origin/feature". */
  remoteBranch: string | null;
  /** Renames the branch (and its remote branch with `withRemote`); rejects to show why it failed. */
  onRename: (branch: Branch, newName: string, withRemote: boolean) => Promise<void>;
  onClose: () => void;
}

/** Renames a local branch, optionally along with the remote branch it tracks. */
export function RenameBranchDialog({ branch, remoteBranch, onRename, onClose }: RenameBranchDialogProps) {
  const [name, setName] = useState(branch.name);
  const [withRemote, setWithRemote] = useState(false);
  const { busy, error, clearError, save } = useSave();
  const newName = toBranchName(name);

  return (
    <Dialog
      id="rename-branch"
      title={`Rename ${branch.name}`}
      submitLabel="Rename"
      canSubmit={newName !== "" && newName !== branch.name}
      onSubmit={() => save(() => onRename(branch, newName, withRemote && !!remoteBranch))}
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <label className="settings-label" htmlFor="rename-branch-name">
        New name
      </label>
      <div className="settings-row">
        <input
          id="rename-branch-name"
          className="mono"
          value={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            clearError();
          }}
        />
      </div>
      {remoteBranch && (
        <>
          <div className="dialog-options">
            <label className="checkbox">
              <input type="checkbox" checked={withRemote} onChange={(e) => setWithRemote(e.target.checked)} />
              Also rename the remote branch {remoteBranch}
            </label>
          </div>
          {withRemote && (
            <p className="settings-hint warning-text" role="note">
              The branch is pushed under its new name and {remoteBranch} is deleted. Others who work on it have to
              switch to the new name.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

interface UpstreamDialogProps {
  branch: Branch;
  /** Remote branches it can track, e.g. "origin/main". */
  remoteBranches: string[];
  /** Sets the upstream; rejects to show why it failed. */
  onSet: (branch: Branch, upstream: string) => Promise<void>;
  onClose: () => void;
}

/** Chooses the remote branch a local branch tracks, which pull and push use by default. */
export function UpstreamDialog({ branch, remoteBranches, onSet, onClose }: UpstreamDialogProps) {
  const [upstream, setUpstream] = useState(() => {
    const preferred = [branch.upstream, `origin/${branch.name}`].find((u) => u && remoteBranches.includes(u));
    return preferred ?? remoteBranches[0] ?? "";
  });
  const { busy, error, clearError, save } = useSave();

  return (
    <Dialog
      id="set-upstream"
      title={`Set Upstream of ${branch.name}`}
      submitLabel="Set Upstream"
      canSubmit={upstream !== "" && upstream !== branch.upstream}
      onSubmit={() => save(() => onSet(branch, upstream))}
      onClose={onClose}
      busy={busy}
      error={error}
    >
      {remoteBranches.length === 0 ? (
        <p className="settings-hint">There are no remote branches to track. Push the branch to create one.</p>
      ) : (
        <>
          <label className="settings-label" htmlFor="set-upstream-branch">
            Remote branch
          </label>
          <div className="settings-row">
            <select
              id="set-upstream-branch"
              value={upstream}
              onChange={(e) => {
                setUpstream(e.target.value);
                clearError();
              }}
            >
              {remoteBranches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <p className="settings-hint">
            {branch.upstream ? (
              <>
                It tracks <span className="mono">{branch.upstream}</span> now.{" "}
              </>
            ) : null}
            Pull and push use the upstream by default, and the sidebar shows how far the branch is ahead or behind it.
          </p>
        </>
      )}
    </Dialog>
  );
}
