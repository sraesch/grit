import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, GitProgress, RepoInfo } from "../api";
import { repoNameFromUrl } from "../clone";
import { joinPath, repositoriesFolder } from "../paths";
import { Dialog } from "./RemoteDialogs";

interface CloneDialogProps {
  /** Called with the clone, to open it in a tab. */
  onCloned: (info: RepoInfo) => void;
  onClose: () => void;
}

/** Clones a repository into a folder named after it in the repositories folder, showing git's progress. */
export function CloneDialog({ onCloned, onClose }: CloneDialogProps) {
  const [url, setUrl] = useState("");
  // Where clones go by default; the folder follows the URL until it is edited.
  const [baseDir, setBaseDir] = useState<string | null>(null);
  const [customDest, setCustomDest] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    repositoriesFolder().then((dir) => mounted.current && setBaseDir(dir));
    return () => {
      mounted.current = false;
    };
  }, []);

  const name = repoNameFromUrl(url);
  const dest = customDest ?? (baseDir && name ? joinPath(baseDir, name) : "");

  async function browse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose where to clone the repository",
      defaultPath: baseDir ?? undefined,
    });
    if (typeof selected === "string") {
      setCustomDest(name ? joinPath(selected, name) : selected);
      setError(null);
    }
  }

  async function clone() {
    const target = dest.trim();
    setBusy(true);
    setError(null);
    setProgress("");
    // Progress is keyed by the destination, since there is no repository yet.
    const unlisten = await listen<GitProgress>("git-progress", ({ payload }) => {
      if (payload.root === target && mounted.current) setProgress(payload.text);
    });
    try {
      const info = await api.cloneRepo(url.trim(), target, branch.trim() || null);
      onCloned(info);
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      setError(errorMessage(e));
      setBusy(false);
    } finally {
      unlisten();
    }
  }

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setError(null);
  };

  return (
    <Dialog
      id="clone"
      title="Clone Repository"
      submitLabel="Clone"
      canSubmit={url.trim() !== "" && dest.trim() !== ""}
      onSubmit={clone}
      onClose={onClose}
      busy={busy}
      error={error}
      status={
        busy && (
          <p className="dialog-status" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>Cloning…</span>
            <span className="mono">{progress}</span>
          </p>
        )
      }
    >
      <label className="settings-label" htmlFor="clone-url">
        Repository URL
      </label>
      <div className="settings-row">
        <input
          id="clone-url"
          className="mono"
          value={url}
          placeholder="https://github.com/owner/repository.git"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => edit(setUrl)(e.target.value)}
        />
      </div>
      <label className="settings-label push-to-label" htmlFor="clone-dest">
        Folder
      </label>
      <div className="settings-row">
        <input
          id="clone-dest"
          className="mono"
          value={dest}
          spellCheck={false}
          autoComplete="off"
          aria-describedby="clone-dest-hint"
          onChange={(e) => edit(setCustomDest)(e.target.value)}
        />
        <button type="button" onClick={browse}>
          Browse…
        </button>
      </div>
      <p id="clone-dest-hint" className="settings-hint">
        Created for the clone; it must not exist yet or be empty.
      </p>
      <label className="settings-label push-to-label" htmlFor="clone-branch">
        Branch
      </label>
      <div className="settings-row">
        <input
          id="clone-branch"
          className="mono"
          value={branch}
          placeholder="The remote's default branch"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => edit(setBranch)(e.target.value)}
        />
      </div>
    </Dialog>
  );
}
