import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, errorMessage, FileChange, HunkSelection, PatchAction, Status } from "../api";
import { DiffHunk } from "../diff";
import { IgnoreTarget } from "../gitignore";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { DiffView, HunkAction, LineAction } from "./DiffView";
import { DiscardDialog } from "./DiscardDialog";
import { FileList, RowAction, RowTarget } from "./FileList";
import { IgnoreDialog } from "./IgnoreDialog";
import { CommitMessage } from "./Markdown";
import { Split } from "./Split";

interface Selection {
  path: string;
  staged: boolean;
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
  /** Files waiting for the discard confirmation. */
  const [discarding, setDiscarding] = useState<FileChange[] | null>(null);
  const [ignoring, setIgnoring] = useState<IgnoreTarget | null>(null);
  const [menu, setMenu] = useState<{ target: RowTarget; staged: boolean; x: number; y: number } | null>(null);
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
  // something is typed already. Each message is offered once, so clearing it sticks. When the operation ends
  // without a commit (aborted, or finished outside grit), the offered message is taken back unless it was edited.
  const offeredMessage = useRef<string | null>(null);
  const hasStatus = status != null;
  useEffect(() => {
    if (mergeMessage && mergeMessage !== offeredMessage.current) {
      offeredMessage.current = mergeMessage;
      setMessage((current) => (current.trim() ? current : mergeMessage));
    } else if (!mergeMessage && hasStatus && offeredMessage.current !== null) {
      const offered = offeredMessage.current;
      offeredMessage.current = null;
      setMessage((current) => (current === offered ? "" : current));
    }
  }, [mergeMessage, hasStatus]);

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

  // Whether the selected file is untracked, from the current status: staging part of it makes it tracked.
  const selectedUntracked =
    !!selection && !selection.staged && unstaged.some((f) => f.path === selection.path && f.status === "?");
  const selectedConflict = !!selection && !selection.staged && conflicted.some((f) => f.path === selection.path);

  // Reload the diff whenever the selection or the repository status changes.
  useEffect(() => {
    if (!selection) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    const untracked =
      !selection.staged && !!status?.unstaged.some((f) => f.path === selection.path && f.status === "?");
    api
      .workingDiff(repo, selection.path, selection.staged, untracked)
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

  const select = (f: FileChange, isStaged: boolean) => setSelection({ path: f.path, staged: isStaged });

  /** Applies hunks or lines of the shown diff. Refreshes even on failure, e.g. when the diff was stale. */
  async function applySelection(action: PatchAction, parts: HunkSelection[]) {
    if (!selection || parts.length === 0) return;
    setBusy(true);
    try {
      await api.applySelection(repo, selection.path, selection.staged, selectedUntracked, action, parts);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const applyHunk = (action: PatchAction) => (hunk: DiffHunk) =>
    applySelection(action, [{ index: hunk.index, header: hunk.header, lines: null }]);

  let hunkActions: HunkAction[] | undefined;
  let lineActions: LineAction[] | undefined;
  if (selection?.staged) {
    hunkActions = [{ label: "Unstage hunk", onClick: applyHunk("unstage") }];
    lineActions = [{ label: "Unstage", onClick: (parts) => applySelection("unstage", parts) }];
  } else if (selection && !selectedConflict) {
    lineActions = [
      { label: "Stage", onClick: (parts) => applySelection("stage", parts) },
      { label: "Discard", danger: true, onClick: (parts) => applySelection("discard", parts) },
    ];
    hunkActions = [{ label: "Stage hunk", onClick: applyHunk("stage") }];
    // An untracked file's diff is one hunk, the whole file: it is deleted from its row, with a confirmation.
    if (!selectedUntracked) {
      hunkActions.push({
        label: "Discard hunk",
        danger: true,
        title: "Throw away the changes in this hunk",
        onClick: applyHunk("discard"),
      });
    }
  }

  const stageFiles = (files: FileChange[]) => run(() => api.stage(repo, files.map((f) => f.path)));
  const unstageFiles = (files: FileChange[]) =>
    run(() => api.unstage(repo, files.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]))));
  const stageFile = (f: FileChange) => stageFiles([f]);
  const unstageFile = (f: FileChange) => unstageFiles([f]);
  const discardFiles = (files: FileChange[]) => {
    setDiscarding(null);
    const untracked = files.filter((f) => f.status === "?").map((f) => f.path);
    const tracked = files.filter((f) => f.status !== "?").map((f) => f.path);
    return run(() => api.discard(repo, tracked, untracked));
  };

  const ignore = (pattern: string) => {
    setIgnoring(null);
    return run(() => api.addToGitignore(repo, pattern));
  };

  const isUntracked = (f: FileChange) => f.status === "?";
  const stageAction: RowAction = { label: "Stage", onFile: stageFile, onFolder: stageFiles };
  const discardAction: RowAction = {
    label: "Discard",
    danger: true,
    onFile: (f) => setDiscarding([f]),
    onFolder: setDiscarding,
    fileTitle: (f) => (isUntracked(f) ? "Delete this untracked file" : "Discard the unstaged changes"),
  };
  const unstageAction: RowAction = { label: "Unstage", onFile: unstageFile, onFolder: unstageFiles };
  const resolveAction: RowAction = { label: "Mark resolved", onFile: stageFile, onFolder: stageFiles };

  function menuItems(target: RowTarget, isStaged: boolean): MenuItem[] {
    if (target.kind === "folder") {
      const n = target.files.length;
      const count = `${n} file${n === 1 ? "" : "s"}`;
      if (isStaged) return [{ label: "Unstage Folder", title: count, onSelect: () => unstageFiles(target.files) }];
      const items: MenuItem[] = [
        { label: "Stage Folder", title: count, onSelect: () => stageFiles(target.files) },
        { label: "Discard Folder…", danger: true, title: count, onSelect: () => setDiscarding(target.files) },
      ];
      // Only a folder of untracked files: ignoring tracked files has no effect.
      if (target.files.every(isUntracked)) {
        items.push({ label: "Ignore Folder…", onSelect: () => setIgnoring({ kind: "folder", path: target.path }) });
      }
      return items;
    }
    const f = target.file;
    if (isStaged) return [{ label: "Unstage", onSelect: () => unstageFile(f) }];
    const items: MenuItem[] = [
      { label: "Stage", onSelect: () => stageFile(f) },
      {
        label: isUntracked(f) ? "Delete File…" : "Discard Changes…",
        danger: true,
        onSelect: () => setDiscarding([f]),
      },
    ];
    if (isUntracked(f)) items.push({ label: "Ignore…", onSelect: () => setIgnoring({ kind: "file", path: f.path }) });
    return items;
  }

  const openMenu = (isStaged: boolean) => (target: RowTarget, x: number, y: number) =>
    setMenu({ target, staged: isStaged, x, y });

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
    <>
      <Split direction="horizontal" initial={380} min={260} storageKey="changes">
        <div className="changes-sidebar">
          <section className="change-section">
            <div className="pane-header">
              <span>Unstaged changes</span>
              <span className="count">{unstaged.length + conflicted.length}</span>
              <button
                className="small"
                disabled={busy || unstaged.length === 0}
                onClick={() => run(() => api.stageAll(repo))}
              >
                Stage all
              </button>
              <button
                className="small danger"
                disabled={busy || unstaged.length === 0}
                onClick={() => setDiscarding(unstaged)}
                title="Discard all unstaged changes and delete untracked files"
              >
                Discard all…
              </button>
            </div>
            <div className="section-scroll">
              {conflicted.length > 0 && (
                <FileList
                  files={conflicted}
                  selectedPath={selection && !selection.staged ? selection.path : null}
                  onSelect={(f) => select(f, false)}
                  actions={[resolveAction]}
                />
              )}
              <FileList
                files={unstaged}
                selectedPath={selection && !selection.staged ? selection.path : null}
                onSelect={(f) => select(f, false)}
                onActivate={stageFile}
                actions={[stageAction, discardAction]}
                onContextMenu={openMenu(false)}
              />
              {unstaged.length + conflicted.length === 0 && <div className="empty small">Working tree clean</div>}
            </div>
          </section>

          <section className="change-section">
            <div className="pane-header">
              <span>Staged changes</span>
              <span className="count">{staged.length}</span>
              <button
                className="small"
                disabled={busy || staged.length === 0}
                onClick={() => run(() => api.unstageAll(repo))}
              >
                Unstage all
              </button>
            </div>
            <div className="section-scroll">
              <FileList
                files={staged}
                selectedPath={selection?.staged ? selection.path : null}
                onSelect={(f) => select(f, true)}
                onActivate={unstageFile}
                actions={[unstageAction]}
                onContextMenu={openMenu(true)}
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
          hunkActions={hunkActions}
          lineActions={lineActions}
          hunkActionsDisabled={busy}
        />
      </Split>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.target.kind === "file" ? menu.target.file.path : `Folder ${menu.target.path}`}
          items={menuItems(menu.target, menu.staged)}
          onClose={() => setMenu(null)}
        />
      )}
      {ignoring && <IgnoreDialog target={ignoring} onIgnore={ignore} onClose={() => setIgnoring(null)} />}
      {discarding && <DiscardDialog files={discarding} onDiscard={discardFiles} onClose={() => setDiscarding(null)} />}
    </>
  );
}
