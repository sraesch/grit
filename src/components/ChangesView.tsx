import { useEffect, useState } from "react";
import { api, errorMessage, FileChange, Status } from "../api";
import { DiffView } from "./DiffView";
import { FileList } from "./FileList";
import { Split } from "./Split";

interface Selection {
  path: string;
  staged: boolean;
  untracked: boolean;
}

interface ChangesViewProps {
  repo: string;
  status: Status | null;
  onChanged: () => void;
  onError: (message: string) => void;
}

export function ChangesView({ repo, status, onChanged, onError }: ChangesViewProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];

  // Drop the selection once the file no longer appears in the list it was selected from.
  useEffect(() => {
    if (!selection || !status) return;
    const list = selection.staged ? status.staged : [...status.unstaged, ...status.conflicted];
    if (!list.some((f) => f.path === selection.path)) setSelection(null);
  }, [status, selection]);

  // Reload the diff whenever the selection or the repository status changes.
  useEffect(() => {
    if (!selection) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    api
      .workingDiff(repo, selection.path, selection.staged, selection.untracked)
      .then((d) => {
        if (!cancelled) {
          setDiff(d);
          setDiffError(null);
        }
      })
      .catch((e) => !cancelled && setDiffError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, selection, status]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const select = (f: FileChange, isStaged: boolean) =>
    setSelection({ path: f.path, staged: isStaged, untracked: f.status === "?" });

  const stageFile = (f: FileChange) => run(() => api.stage(repo, [f.path]));
  const unstageFile = (f: FileChange) =>
    run(() => api.unstage(repo, f.origPath ? [f.origPath, f.path] : [f.path]));

  async function doCommit() {
    if (!message.trim()) return;
    await run(async () => {
      await api.commit(repo, message, amend);
      setMessage("");
      setAmend(false);
    });
  }

  const canCommit = !busy && message.trim().length > 0 && (staged.length > 0 || amend) && conflicted.length === 0;

  return (
    <Split direction="horizontal" initial={380} min={260} storageKey="changes">
      <div className="changes-sidebar">
        <section className="change-section">
          <div className="pane-header">
            <span>Unstaged changes</span>
            <span className="count">{unstaged.length + conflicted.length}</span>
            <button className="small" disabled={busy || unstaged.length === 0} onClick={() => run(() => api.stageAll(repo))}>
              Stage all
            </button>
          </div>
          <div className="section-scroll">
            {conflicted.length > 0 && (
              <FileList
                files={conflicted}
                selectedPath={selection && !selection.staged ? selection.path : null}
                onSelect={(f) => select(f, false)}
                actionLabel="Mark resolved"
                onAction={stageFile}
              />
            )}
            <FileList
              files={unstaged}
              selectedPath={selection && !selection.staged ? selection.path : null}
              onSelect={(f) => select(f, false)}
              onActivate={stageFile}
              actionLabel="Stage"
              onAction={stageFile}
            />
            {unstaged.length + conflicted.length === 0 && <div className="empty small">Working tree clean</div>}
          </div>
        </section>

        <section className="change-section">
          <div className="pane-header">
            <span>Staged changes</span>
            <span className="count">{staged.length}</span>
            <button className="small" disabled={busy || staged.length === 0} onClick={() => run(() => api.unstageAll(repo))}>
              Unstage all
            </button>
          </div>
          <div className="section-scroll">
            <FileList
              files={staged}
              selectedPath={selection?.staged ? selection.path : null}
              onSelect={(f) => select(f, true)}
              onActivate={unstageFile}
              actionLabel="Unstage"
              onAction={unstageFile}
            />
            {staged.length === 0 && <div className="empty small">Nothing staged</div>}
          </div>
        </section>

        <section className="commit-box">
          <textarea
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canCommit) doCommit();
              }
            }}
          />
          <div className="commit-actions">
            <label className="checkbox">
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
              Amend last commit
            </label>
            <button className="primary" disabled={!canCommit} onClick={doCommit} title="Ctrl/Cmd + Enter">
              {amend ? "Amend" : "Commit"}
              {staged.length > 0 ? ` ${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
            </button>
          </div>
        </section>
      </div>

      <DiffView
        diff={selection ? diff : null}
        error={diffError}
        title={selection ? `${selection.path}${selection.staged ? "  (staged)" : ""}` : undefined}
      />
    </Split>
  );
}
