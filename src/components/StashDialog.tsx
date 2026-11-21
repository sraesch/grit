import { useState } from "react";
import { Stash, StashOptions, Status } from "../api";
import { prefs, StashPrefs } from "../remote";
import { stashableCounts, stashName } from "../stash";
import { Dialog } from "./RemoteDialogs";

interface StashDialogProps {
  status: Status;
  onStash: (options: StashOptions) => void;
  onClose: () => void;
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Stash the local changes, with an optional message. */
export function StashDialog({ status, onStash, onClose }: StashDialogProps) {
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<StashPrefs>(prefs.stash);
  const { tracked, untracked } = stashableCounts(status);
  const count = tracked + (options.includeUntracked ? untracked : 0);

  function submit() {
    prefs.saveStash(options);
    onStash({ message, ...options });
  }

  let hint: string;
  if (count === 0) hint = "Only untracked files changed. Include them to stash them.";
  else {
    hint = `Stashes ${plural(count, "changed file")}`;
    if (status.branch) hint += ` on ${status.branch}`;
    hint += " and reverts them. Apply the stash to bring them back.";
  }

  return (
    <Dialog id="stash" title="Stash" submitLabel="Stash" canSubmit={count > 0} onSubmit={submit} onClose={onClose}>
      <label className="settings-label" htmlFor="stash-message">
        Message
      </label>
      <div className="settings-row">
        <input
          id="stash-message"
          type="text"
          value={message}
          placeholder="Optional"
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          aria-describedby="stash-hint"
        />
      </div>
      <p id="stash-hint" className="settings-hint">
        {hint}
      </p>
      <div className="dialog-options">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.includeUntracked}
            onChange={(e) => setOptions({ ...options, includeUntracked: e.target.checked })}
          />
          Include untracked files{untracked > 0 && ` (${untracked})`}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.keepIndex}
            onChange={(e) => setOptions({ ...options, keepIndex: e.target.checked })}
          />
          Keep staged changes
        </label>
      </div>
    </Dialog>
  );
}

interface DropStashDialogProps {
  stash: Stash;
  onDrop: (stash: Stash) => void;
  onClose: () => void;
}

/** Confirms deleting a stash. */
export function DropStashDialog({ stash, onDrop, onClose }: DropStashDialogProps) {
  return (
    <Dialog
      id="drop-stash"
      title="Delete Stash"
      submitLabel="Delete"
      danger
      canSubmit
      onSubmit={() => onDrop(stash)}
      onClose={onClose}
    >
      <p className="settings-hint">
        Delete the stash <strong>{stashName(stash)}</strong>? Its changes are lost unless they were applied.
      </p>
    </Dialog>
  );
}
