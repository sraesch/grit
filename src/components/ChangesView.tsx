import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, errorMessage, FileChange, Status } from "../api";
import { DiffView } from "./DiffView";
import { FileList } from "./FileList";
import { CommitMessage } from "./Markdown";
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
  const [preview, setPreview] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const focusEditor = useRef(false);

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];
  const merging = status?.operation?.kind === "merge";
  // A squash merge is finished with an ordinary commit of the staged changes.
  const squashing = status?.operation?.kind === "squash";
  const mergeMessage = merging || squashing ? status?.operation?.message : null;

  // Offer the prepared message of a merge or squash merge in progress (e.g. after a pull with conflicts), unless
  // something is typed already. Each message is offered once, so clearing it sticks.
  const offeredMessage = useRef<string | null>(null);
  useEffect(() => {
    if (mergeMessage && mergeMessage !== offeredMessage.current) {
      offeredMessage.current = mergeMessage;
      setMessage((current) => (current.trim() ? current : mergeMessage));
    }
  }, [mergeMessage]);

  // Drop the selection once the file no longer appears in the list it was selected from.
  useEffect(() => {
    if (!selection || !status) return;
    const list = selection.staged ? status.staged : [...status.unstaged, ...status.conflicted];
    if (!list.some((f) => f.path === selection.path)) setSelection(null);
  }, [status, selection]);

  // Return focus to the message when switching back from the preview with the Write tab.
  useEffect(() => {
    if (!preview && focusEditor.current) {
      focusEditor.current = false;
      editorRef.current?.focus();
    }
  }, [preview]);

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

  const stageFiles = (files: FileChange[]) => run(() => api.stage(repo, files.map((f) => f.path)));
  const unstageFiles = (files: FileChange[]) =>
    run(() => api.unstage(repo, files.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]))));
  const stageFile = (f: FileChange) => stageFiles([f]);
  const unstageFile = (f: FileChange) => unstageFiles([f]);

  async function doCommit() {
    if (!message.trim()) return;
    await run(async () => {
      await api.commit(repo, message, amend);
      setMessage("");
      setAmend(false);
      setPreview(false);
    });
  }

  // A merge can be committed with nothing staged: resolving may have kept our side of every file.
  // During a rebase, cherry-pick or revert, committing would add a stray commit: they go on
  // with Continue in the banner instead.
  const continuing = !!status?.operation && !merging && !squashing;
  const canCommit =
    !busy &&
    !continuing &&
    message.trim().length > 0 &&
    (staged.length > 0 || amend || merging) &&
    conflicted.length === 0;

  const commitOnShortcut = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canCommit) doCommit();
    }
  };

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
                onFolderAction={stageFiles}
              />
            )}
            <FileList
              files={unstaged}
              selectedPath={selection && !selection.staged ? selection.path : null}
              onSelect={(f) => select(f, false)}
              onActivate={stageFile}
              actionLabel="Stage"
              onAction={stageFile}
              onFolderAction={stageFiles}
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
              onFolderAction={unstageFiles}
            />
            {staged.length === 0 && <div className="empty small">Nothing staged</div>}
          </div>
        </section>

        <section className="commit-box">
          <div className="commit-tabs" role="tablist" aria-label="Commit message mode">
            <button
              role="tab"
              id="commit-tab-write"
              aria-selected={!preview}
              aria-controls="commit-panel-write"
              onClick={() => {
                focusEditor.current = true;
                setPreview(false);
              }}
            >
              Write
            </button>
            <button
              role="tab"
              id="commit-tab-preview"
              aria-selected={preview}
              aria-controls="commit-panel-preview"
              onClick={() => setPreview(true)}
            >
              Preview
            </button>
            <span className="commit-tabs-hint">Markdown supported</span>
          </div>
          {preview ? (
            <div
              id="commit-panel-preview"
              className="commit-preview selectable"
              role="tabpanel"
              aria-labelledby="commit-tab-preview"
              tabIndex={0}
              onKeyDown={commitOnShortcut}
            >
              {message.trim() ? (
                <CommitMessage message={message} />
              ) : (
                <div className="empty small">Nothing to preview</div>
              )}
            </div>
          ) : (
            <div id="commit-panel-write" className="commit-editor" role="tabpanel" aria-labelledby="commit-tab-write">
              <textarea
                ref={editorRef}
                aria-label="Commit message"
                placeholder="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={commitOnShortcut}
              />
            </div>
          )}
          <div className="commit-actions">
            <label className="checkbox">
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
              Amend last commit
            </label>
            <button
              className="primary"
              disabled={!canCommit}
              onClick={doCommit}
              title={continuing ? "Use Continue above to go on with the operation in progress" : "Ctrl/Cmd + Enter"}
            >
              {amend ? "Amend" : merging ? "Commit merge" : "Commit"}
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
