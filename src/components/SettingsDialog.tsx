import { open } from "@tauri-apps/plugin-dialog";
import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, Settings } from "../api";

interface SettingsDialogProps {
  onClose: () => void;
  onSaved?: (settings: Settings) => void;
}

/** Modal with the app settings, loaded from and saved to the backend. */
export function SettingsDialog({ onClose, onSaved }: SettingsDialogProps) {
  const [reposDir, setReposDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => !cancelled && setReposDir(s.reposDir ?? ""))
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

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!loaded || saving) return;
    setSaving(true);
    try {
      const saved = await api.setSettings({ reposDir: (reposDir ?? "").trim() || null });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

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
                aria-invalid={error ? true : undefined}
                aria-errormessage={error ? "settings-error" : undefined}
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
            {error && (
              <p id="settings-error" className="settings-error" role="alert">
                {error}
              </p>
            )}
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
