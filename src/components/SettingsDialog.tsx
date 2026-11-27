import { open } from "@tauri-apps/plugin-dialog";
import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, Settings } from "../api";
import { CUSTOM_MERGE_TOOL, isMergeToolError, mergeToolChoices } from "../mergeTools";

interface SettingsDialogProps {
  onClose: () => void;
  onSaved?: (settings: Settings) => void;
}

/** Choices for automatic fetching, in minutes; 0 is off. */
const AUTO_FETCH_CHOICES = [0, 5, 10, 15, 30, 60];

function autoFetchLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** Modal with the app settings, loaded from and saved to the backend. */
export function SettingsDialog({ onClose, onSaved }: SettingsDialogProps) {
  const [reposDir, setReposDir] = useState<string | null>(null);
  const [autoFetch, setAutoFetch] = useState(10);
  const [mergeTool, setMergeTool] = useState("");
  const [mergeToolPath, setMergeToolPath] = useState("");
  const [mergeToolCommand, setMergeToolCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setReposDir(s.reposDir ?? "");
        setAutoFetch(s.autoFetchMinutes);
        setMergeTool(s.mergeTool ?? "");
        setMergeToolPath(s.mergeToolPath ?? "");
        setMergeToolCommand(s.mergeToolCommand ?? "");
      })
      .catch((e) => {
        if (cancelled) return;
        setReposDir("");
        setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loaded = reposDir !== null;
  // Focus in the same commit that enables the field, so typing right away always lands in it.
  useLayoutEffect(() => {
    if (loaded) inputRef.current?.focus();
  }, [loaded]);

  // Escape closes; focus returns to whatever opened the dialog.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  async function browse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose the repositories folder",
      defaultPath: reposDir || undefined,
    });
    if (typeof selected === "string") {
      setReposDir(selected);
      setError(null);
    }
  }

  async function browseMergeTool() {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Choose the merge tool",
      defaultPath: mergeToolPath || undefined,
    });
    if (typeof selected === "string") {
      setMergeToolPath(selected);
      setError(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!loaded || saving) return;
    setSaving(true);
    try {
      const saved = await api.setSettings({
        reposDir: (reposDir ?? "").trim() || null,
        autoFetchMinutes: autoFetch,
        mergeTool: mergeTool || null,
        mergeToolPath: mergeToolPath.trim() || null,
        mergeToolCommand: mergeToolCommand.trim() || null,
      });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const disabled = !loaded || saving;
  const toolError = error !== null && isMergeToolError(error);
  const reposError = error !== null && !toolError;
  const custom = mergeTool === CUSTOM_MERGE_TOOL;
  const errorText = (
    <p id="settings-error" className="settings-error" role="alert">
      {error}
    </p>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onSubmit={save}
        noValidate
      >
        <header className="modal-header">
          <h2 id="settings-title">Settings</h2>
        </header>
        <div className="settings-body">
          <section className="settings-section">
            <h3>Repositories</h3>
            <label className="settings-label" htmlFor="settings-repos-dir">
              Repositories folder
            </label>
            <div className="settings-row">
              <input
                ref={inputRef}
                id="settings-repos-dir"
                className="mono"
                value={reposDir ?? ""}
                placeholder={loaded ? "Your home folder" : "Loading…"}
                disabled={!loaded || saving}
                spellCheck={false}
                aria-describedby="settings-repos-dir-hint"
                aria-invalid={reposError ? true : undefined}
                aria-errormessage={reposError ? "settings-error" : undefined}
                onChange={(e) => {
                  setReposDir(e.target.value);
                  setError(null);
                }}
              />
              <button type="button" onClick={browse} disabled={!loaded || saving}>
                Browse…
              </button>
            </div>
            <p id="settings-repos-dir-hint" className="settings-hint">
              Where your cloned repositories live. Opening a repository starts here. Leave empty to use your home
              folder.
            </p>
            {reposError && errorText}
          </section>
          <section className="settings-section">
            <h3>Remotes</h3>
            <label className="settings-label" htmlFor="settings-auto-fetch">
              Fetch automatically
            </label>
            <div className="settings-row">
              <select
                id="settings-auto-fetch"
                value={autoFetch}
                disabled={!loaded || saving}
                aria-describedby="settings-auto-fetch-hint"
                onChange={(e) => setAutoFetch(Number(e.target.value))}
              >
                {(AUTO_FETCH_CHOICES.includes(autoFetch) ? AUTO_FETCH_CHOICES : [...AUTO_FETCH_CHOICES, autoFetch]).map((m) => (
                  <option key={m} value={m}>
                    {autoFetchLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <p id="settings-auto-fetch-hint" className="settings-hint">
              Open repositories fetch all their remotes in the background, so new commits show up in the history and
              the Pull button. Automatic fetches never ask for passwords.
            </p>
          </section>
          <section className="settings-section">
            <h3>Conflicts</h3>
            <label className="settings-label" htmlFor="settings-merge-tool">
              Merge tool
            </label>
            <div className="settings-row">
              <select
                id="settings-merge-tool"
                value={mergeTool}
                disabled={disabled}
                aria-describedby="settings-merge-tool-hint"
                onChange={(e) => {
                  setMergeTool(e.target.value);
                  setError(null);
                }}
              >
                {mergeToolChoices(mergeTool).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <p id="settings-merge-tool-hint" className="settings-hint">
              {mergeTool === ""
                ? "Conflicted files open in the merge tool git is set up with (merge.guitool, else merge.tool)."
                : "Conflicted files open in this tool, whatever git is set up with. grit waits until it is closed."}
            </p>
            {mergeTool !== "" && !custom && (
              <>
                <label className="settings-label settings-sublabel" htmlFor="settings-merge-tool-path">
                  Program
                </label>
                <div className="settings-row">
                  <input
                    id="settings-merge-tool-path"
                    className="mono"
                    value={mergeToolPath}
                    placeholder="Found on the PATH"
                    disabled={disabled}
                    spellCheck={false}
                    aria-describedby="settings-merge-tool-path-hint"
                    aria-invalid={toolError ? true : undefined}
                    aria-errormessage={toolError ? "settings-error" : undefined}
                    onChange={(e) => {
                      setMergeToolPath(e.target.value);
                      setError(null);
                    }}
                  />
                  <button type="button" onClick={browseMergeTool} disabled={disabled}>
                    Browse…
                  </button>
                </div>
                <p id="settings-merge-tool-path-hint" className="settings-hint">
                  Where the tool is installed, if git doesn't find it. Leave empty to find it on the PATH.
                </p>
              </>
            )}
            {custom && (
              <>
                <label className="settings-label settings-sublabel" htmlFor="settings-merge-tool-command">
                  Command
                </label>
                <div className="settings-row">
                  <input
                    id="settings-merge-tool-command"
                    className="mono"
                    value={mergeToolCommand}
                    placeholder={'meld "$LOCAL" "$MERGED" "$REMOTE"'}
                    disabled={disabled}
                    spellCheck={false}
                    aria-describedby="settings-merge-tool-command-hint"
                    aria-invalid={toolError ? true : undefined}
                    aria-errormessage={toolError ? "settings-error" : undefined}
                    onChange={(e) => {
                      setMergeToolCommand(e.target.value);
                      setError(null);
                    }}
                  />
                </div>
                <p id="settings-merge-tool-command-hint" className="settings-hint">
                  Runs in a shell. $BASE, $LOCAL and $REMOTE name the common ancestor and the two sides; save the
                  result to $MERGED. The command must wait until the tool is closed.
                </p>
              </>
            )}
            {toolError && errorText}
          </section>
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!loaded || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
