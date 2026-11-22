import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, errorMessage, RepoInfo } from "../api";
import { joinPath, repositoriesFolder } from "../paths";
import { Dialog } from "./RemoteDialogs";

interface InitRepoDialogProps {
  /** The folder to initialize, e.g. one Open… chose that isn't a repository. Without it, the dialog
   * starts in the repositories folder. */
  folder?: string;
  /** Called with the new repository, to open it in a tab. */
  onCreated: (info: RepoInfo) => void;
  onClose: () => void;
}

/** Creates a repository in a new or existing folder, with a chosen first branch. */
export function InitRepoDialog({ folder, onCreated, onClose }: InitRepoDialogProps) {
  const [path, setPath] = useState(folder ?? "");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .defaultBranchName()
      .catch(() => "main")
      .then((name) => !cancelled && setBranch((current) => current || name));
    // Start in the repositories folder, ready for the new folder's name.
    if (!folder) {
      repositoriesFolder().then((dir) => !cancelled && dir && setPath((current) => current || joinPath(dir, "")));
    }
    return () => {
      cancelled = true;
    };
  }, [folder]);

  async function browse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a folder for the new repository",
      defaultPath: path.trim() || undefined,
    });
    if (typeof selected === "string") {
      setPath(selected);
      setError(null);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.initRepo(path.trim(), branch.trim()));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      id="init-repo"
      title={folder ? "Initialize Repository" : "New Repository"}
      submitLabel={folder ? "Initialize" : "Create"}
      canSubmit={path.trim() !== "" && branch.trim() !== ""}
      onSubmit={create}
      onClose={onClose}
      busy={busy}
      error={error}
    >
      {folder && (
        <p className="settings-hint init-hint">
          <span className="mono">{folder}</span> isn't a git repository yet. Initialize it as a new one?
        </p>
      )}
      <label className="settings-label" htmlFor="init-repo-path">
        Folder
      </label>
      <div className="settings-row">
        <input
          id="init-repo-path"
          className="mono"
          value={path}
          spellCheck={false}
          autoComplete="off"
          aria-describedby="init-repo-path-hint"
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
        />
        <button type="button" onClick={browse}>
          Browse…
        </button>
      </div>
      <p id="init-repo-path-hint" className="settings-hint">
        A folder that doesn't exist yet is created.
      </p>
      <label className="settings-label push-to-label" htmlFor="init-repo-branch">
        Initial branch
      </label>
      <div className="settings-row">
        <input
          id="init-repo-branch"
          className="mono"
          value={branch}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setBranch(e.target.value);
            setError(null);
          }}
        />
      </div>
    </Dialog>
  );
}
