import { useState } from "react";
import { Branch, Remote } from "../api";
import { prefs } from "../remote";
import { Dialog } from "./RemoteDialogs";
import { useSave } from "./RemoteManageDialogs";

interface CreateTagDialogProps {
  /** Where the tag points, as shown to the user, e.g. "a1b2c3d Fix the build". */
  startLabel: string;
  remotes: Remote[];
  /**
   * Creates the tag (annotated when there is a message) and pushes it to `pushTo` when given;
   * rejects to show why creating it failed.
   */
  onCreate: (name: string, message: string | null, pushTo: string | null) => Promise<void>;
  onClose: () => void;
}

/** Creates a tag at a commit, lightweight or annotated with a message, and optionally pushes it. */
export function CreateTagDialog({ startLabel, remotes, onCreate, onClose }: CreateTagDialogProps) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(() => prefs.createTag().push);
  const [remote, setRemote] = useState(() => {
    const last = prefs.createTag().remote;
    return remotes.some((r) => r.name === last) ? last : (remotes.find((r) => r.name === "origin") ?? remotes[0])?.name;
  });
  const { busy, error, clearError, save } = useSave();
  const pushTo = push && remote ? remote : null;

  return (
    <Dialog
      id="create-tag"
      title="New Tag"
      submitLabel={pushTo ? "Create and Push" : "Create"}
      canSubmit={name.trim() !== ""}
      onSubmit={() =>
        save(() => {
          if (remotes.length > 0) prefs.saveCreateTag({ push, remote: remote ?? "" });
          return onCreate(name.trim(), message.trim() || null, pushTo);
        })
      }
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <label className="settings-label" htmlFor="create-tag-name">
        Name
      </label>
      <div className="settings-row">
        <input
          id="create-tag-name"
          className="mono"
          value={name}
          placeholder="v1.0.0"
          spellCheck={false}
          autoComplete="off"
          aria-describedby="create-tag-hint"
          onChange={(e) => {
            setName(e.target.value);
            clearError();
          }}
        />
      </div>
      <p id="create-tag-hint" className="settings-hint">
        Points at <span className="mono">{startLabel}</span>.
      </p>
      <label className="settings-label push-to-label" htmlFor="create-tag-message">
        Message
      </label>
      <div className="settings-row">
        <textarea
          id="create-tag-message"
          rows={3}
          value={message}
          placeholder="Optional"
          aria-describedby="create-tag-message-hint"
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      <p id="create-tag-message-hint" className="settings-hint">
        With a message the tag is annotated; without one it is a lightweight tag.
      </p>
      {remotes.length > 0 && (
        <div className="dialog-options">
          <div className="inline-option">
            <label className="checkbox">
              <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
              {remotes.length === 1 ? (
                <>
                  Push to <span className="mono">{remote}</span>
                </>
              ) : (
                "Push to"
              )}
            </label>
            {remotes.length > 1 && (
              <select aria-label="Remote" value={remote} disabled={!push} onChange={(e) => setRemote(e.target.value)}>
                {remotes.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

interface DeleteTagDialogProps {
  tag: Branch;
  onDelete: (tag: Branch) => void;
  onClose: () => void;
}

/** Confirms deleting a tag in this repository. */
export function DeleteTagDialog({ tag, onDelete, onClose }: DeleteTagDialogProps) {
  return (
    <Dialog
      id="delete-tag"
      title="Delete Tag"
      submitLabel="Delete"
      danger
      canSubmit
      onSubmit={() => onDelete(tag)}
      onClose={onClose}
    >
      <p className="settings-hint">
        Delete the tag <strong className="mono">{tag.name}</strong> (at <span className="mono">{tag.sha}</span>) in this
        repository? Tags of the same name on remotes are kept.
      </p>
    </Dialog>
  );
}

interface DeleteRemoteTagDialogProps {
  tag: Branch;
  remotes: Remote[];
  onDelete: (tag: Branch, remote: string) => void;
  onClose: () => void;
}

/** Confirms deleting a tag on a remote. */
export function DeleteRemoteTagDialog({ tag, remotes, onDelete, onClose }: DeleteRemoteTagDialogProps) {
  const [remote, setRemote] = useState(() => (remotes.find((r) => r.name === "origin") ?? remotes[0])?.name ?? "");
  return (
    <Dialog
      id="delete-remote-tag"
      title="Delete Tag on Remote"
      submitLabel="Delete"
      danger
      canSubmit={remote !== ""}
      onSubmit={() => onDelete(tag, remote)}
      onClose={onClose}
    >
      <label className="settings-label" htmlFor="delete-remote-tag-remote">
        Remote
      </label>
      <div className="settings-row">
        <select id="delete-remote-tag-remote" value={remote} onChange={(e) => setRemote(e.target.value)}>
          {remotes.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <p className="settings-hint">
        Delete the tag <strong className="mono">{tag.name}</strong> on <span className="mono">{remote}</span>? The tag in
        this repository is kept.
      </p>
      <p className="settings-hint warning-text" role="note">
        grit can't undo this. Others who fetched the tag keep it until they delete it themselves.
      </p>
    </Dialog>
  );
}
