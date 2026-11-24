import { useEffect, useState } from "react";
import { api, errorMessage, LogEntry, ResetMode, ResetPreview, Status } from "../api";
import { RESET_MODES, resetPreviewText, resetPushedWarning } from "../commit";
import { prefs } from "../remote";
import { Dialog } from "./RemoteDialogs";

interface ResetDialogProps {
  repo: string;
  entry: LogEntry;
  /** The current branch; null for a detached HEAD. */
  branch: string | null;
  status: Status;
  onReset: (mode: ResetMode) => void;
  onClose: () => void;
}

type Preview = { state: "loading" } | { state: "ready"; preview: ResetPreview } | { state: "error"; message: string };

/** Moves the current branch to a commit: soft, mixed or hard, with what that drops and a warning for pushed commits. */
export function ResetDialog({ repo, entry, branch, status, onReset, onClose }: ResetDialogProps) {
  const [mode, setMode] = useState<ResetMode>(() => prefs.reset().mode);
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  const name = branch ?? "HEAD";
  const hard = mode === "hard";
  const dirty = status.staged.length + status.unstaged.filter((f) => f.status !== "?").length > 0;

  useEffect(() => {
    let current = true;
    api.resetPreview(repo, entry.sha).then(
      (preview) => current && setPreview({ state: "ready", preview }),
      (e) => current && setPreview({ state: "error", message: errorMessage(e) }),
    );
    return () => {
      current = false;
    };
  }, [repo, entry.sha]);

  const pushed = preview.state === "ready" ? resetPushedWarning(preview.preview, name) : null;

  return (
    <Dialog
      id="reset"
      title={`Reset ${name}`}
      submitLabel={hard ? "Reset Hard" : "Reset"}
      danger={hard}
      canSubmit
      onSubmit={() => {
        if (mode !== "hard") prefs.saveReset({ mode });
        onReset(mode);
      }}
      onClose={onClose}
    >
      <p className="settings-hint">
        Move <strong className="mono">{name}</strong> to <span className="mono">{entry.sha.slice(0, 7)}</span> “
        {entry.subject}”.{" "}
        {preview.state === "loading"
          ? "Counting commits…"
          : preview.state === "error"
            ? preview.message
            : resetPreviewText(preview.preview, name)}
      </p>
      <div className="dialog-options" role="radiogroup" aria-label="Mode">
        {RESET_MODES.map((m) => (
          <label key={m.mode} className="checkbox reset-mode">
            <input type="radio" name="reset-mode" value={m.mode} checked={mode === m.mode} onChange={() => setMode(m.mode)} />
            <span>
              <strong>{m.label}</strong>
              <span className="reset-mode-description">{m.description}</span>
            </span>
          </label>
        ))}
      </div>
      {pushed && (
        <p className="settings-hint warning-text" role="note">
          {pushed}
        </p>
      )}
      {hard && dirty && (
        <p className="settings-hint warning-text" role="note">
          You have uncommitted changes. A hard reset discards them, and they can't be recovered.
        </p>
      )}
    </Dialog>
  );
}
