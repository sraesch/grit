import { useState } from "react";
import { errorMessage, Remote } from "../api";
import { prefs } from "../remote";
import { Dialog } from "./RemoteDialogs";

/** Runs a dialog's save: busy meanwhile, and the error shown in the dialog if it fails. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return { busy, error, clearError: () => setError(null), save };
}

interface AddRemoteDialogProps {
  /** Adds the remote and fetches it if asked to; rejects to show why it failed. */
  onAdd: (name: string, url: string, fetch: boolean) => Promise<void>;
  onClose: () => void;
}

/** Adds a remote by name and URL, optionally fetching it right away. */
export function AddRemoteDialog({ onAdd, onClose }: AddRemoteDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [fetch, setFetch] = useState(() => prefs.addRemote().fetch);
  const { busy, error, clearError, save } = useSave();

  return (
    <Dialog
      id="add-remote"
      title="Add Remote"
      submitLabel="Add"
      canSubmit={name.trim() !== "" && url.trim() !== ""}
      onSubmit={() =>
        save(() => {
          prefs.saveAddRemote({ fetch });
          return onAdd(name.trim(), url.trim(), fetch);
        })
      }
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <label className="settings-label" htmlFor="add-remote-name">
        Name
      </label>
      <div className="settings-row">
        <input
          id="add-remote-name"
          className="mono"
          value={name}
          placeholder="upstream"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            clearError();
          }}
        />
      </div>
      <label className="settings-label push-to-label" htmlFor="add-remote-url">
        URL
      </label>
      <div className="settings-row">
        <input
          id="add-remote-url"
          className="mono"
          value={url}
          placeholder="https://github.com/owner/repository.git"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setUrl(e.target.value);
            clearError();
          }}
        />
      </div>
      <div className="dialog-options">
        <label className="checkbox">
          <input type="checkbox" checked={fetch} onChange={(e) => setFetch(e.target.checked)} />
          Fetch it right away
        </label>
      </div>
    </Dialog>
  );
}

interface EditRemoteDialogProps {
  remote: Remote;
  /** What is edited: the remote's URL or its name. */
  field: "url" | "name";
  /** Saves the new value; rejects to show why it failed. */
  onSave: (remote: Remote, value: string) => Promise<void>;
  onClose: () => void;
}

/** Changes a remote's URL or renames it. */
export function EditRemoteDialog({ remote, field, onSave, onClose }: EditRemoteDialogProps) {
  const initial = field === "url" ? remote.url : remote.name;
  const [value, setValue] = useState(initial);
  const { busy, error, clearError, save } = useSave();
  const id = field === "url" ? "remote-url" : "rename-remote";

  return (
    <Dialog
      id={id}
      title={field === "url" ? `Edit URL of ${remote.name}` : `Rename ${remote.name}`}
      submitLabel={field === "url" ? "Save" : "Rename"}
      canSubmit={value.trim() !== "" && value.trim() !== initial}
      onSubmit={() => save(() => onSave(remote, value.trim()))}
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <label className="settings-label" htmlFor={`${id}-value`}>
        {field === "url" ? "URL" : "Name"}
      </label>
      <div className="settings-row">
        <input
          id={`${id}-value`}
          className="mono"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={field === "name" ? `${id}-hint` : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            clearError();
          }}
        />
      </div>
      {field === "name" && (
        <p id={`${id}-hint`} className="settings-hint">
          Its remote branches are renamed along, and local branches keep tracking them.
        </p>
      )}
    </Dialog>
  );
}

interface RemoveRemoteDialogProps {
  remote: Remote;
  /** Local branches that track one of its branches and lose their upstream. */
  trackingBranches: string[];
  /** Removes the remote; rejects to show why it failed. */
  onRemove: (remote: Remote) => Promise<void>;
  onClose: () => void;
}

/** Confirms removing a remote with its remote branches. */
export function RemoveRemoteDialog({ remote, trackingBranches, onRemove, onClose }: RemoveRemoteDialogProps) {
  const { busy, error, save } = useSave();
  return (
    <Dialog
      id="remove-remote"
      title="Remove Remote"
      submitLabel="Remove"
      danger
      canSubmit
      onSubmit={() => save(() => onRemove(remote))}
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <p className="settings-hint">
        Remove the remote <strong className="mono">{remote.name}</strong> (<span className="mono">{remote.url}</span>)
        and its remote branches from this repository? The repository it points at is not changed.
      </p>
      {trackingBranches.length > 0 && (
        <p className="settings-hint warning-text" role="note">
          {trackingBranches.length === 1 ? "The local branch " : "The local branches "}
          <span className="mono">{trackingBranches.join(", ")}</span>
          {trackingBranches.length === 1 ? " tracks" : " track"} a branch of it and will no longer track anything.
        </p>
      )}
    </Dialog>
  );
}
