import { useEffect, useState } from "react";
import { api, errorMessage, FileChange, Stash } from "../api";
import { imageType } from "../image";
import { fullDate, relativeTime } from "../util";
import { DiffView } from "./DiffView";
import { FileList } from "./FileList";
import { ImageChange } from "./HistoryView";
import { Split } from "./Split";

interface StashViewProps {
  repo: string;
  stash: Stash;
  /** Why the stash can't be applied right now, e.g. unresolved conflicts; null when it can. */
  applyBlocked: string | null;
  onApply: (stash: Stash, pop: boolean) => void;
  onDrop: (stash: Stash) => void;
  onError: (message: string) => void;
}

/** A stashed file: tracked changes are in the stash commit, untracked files in its third parent. */
interface StashFile extends FileChange {
  rev: string;
  parent: string | null;
}

/** A stash: what it is, the buttons to apply or delete it, and its files and their diffs. */
export function StashView({ repo, stash, applyBlocked, onApply, onDrop, onError }: StashViewProps) {
  const [files, setFiles] = useState<StashFile[] | null>(null);
  const [file, setFile] = useState<StashFile | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showImageDiff, setShowImageDiff] = useState(false);

  useEffect(() => {
    setFiles(null);
    setFile(null);
    let cancelled = false;
    const untrackedRev = `${stash.sha}^3`;
    Promise.all([api.commitDetails(repo, stash.sha), stash.untracked ? api.commitDetails(repo, untrackedRev) : null])
      .then(([tracked, untracked]) => {
        if (cancelled) return;
        const list: StashFile[] = [
          ...tracked.files.map((f) => ({ ...f, rev: stash.sha, parent: tracked.parents[0] ?? null })),
          // Shown as untracked, as they were when stashed.
          ...(untracked?.files ?? []).map((f) => ({ ...f, status: "?", rev: untrackedRev, parent: null })),
        ];
        setFiles(list);
        setFile(list[0] ?? null);
      })
      .catch((e) => !cancelled && onError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, stash.sha, stash.untracked, onError]);

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    if (!file) return;
    let cancelled = false;
    api
      .commitFileDiff(repo, file.rev, file.path, file.origPath)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setDiffError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, file]);

  return (
    <Split direction="horizontal" initial={380} min={240} storageKey="commit-panel">
      <div className="commit-panel">
        <div className="commit-meta">
          <div className="commit-summary selectable">{stash.message}</div>
          <dl>
            <dt>Stash</dt>
            <dd className="mono">stash@{`{${stash.index}}`}</dd>
            {stash.branch && (
              <>
                <dt>Branch</dt>
                <dd className="mono">{stash.branch}</dd>
              </>
            )}
            <dt>Date</dt>
            <dd title={fullDate(stash.time)}>{relativeTime(stash.time)}</dd>
            <dt>Commit</dt>
            <dd className="mono selectable">{stash.sha}</dd>
          </dl>
          <div className="stash-actions">
            <button
              className="small"
              disabled={!!applyBlocked}
              title={applyBlocked ?? "Apply the changes and keep the stash"}
              onClick={() => onApply(stash, false)}
            >
              Apply
            </button>
            <button
              className="small"
              disabled={!!applyBlocked}
              title={applyBlocked ?? "Apply the changes and delete the stash"}
              onClick={() => onApply(stash, true)}
            >
              Pop
            </button>
            <button className="small danger" onClick={() => onDrop(stash)}>
              Delete…
            </button>
          </div>
        </div>
        <div className="pane-header">
          <span>Changed files</span>
          {files && <span className="count">{files.length}</span>}
        </div>
        <div className="section-scroll">
          {files ? (
            <FileList files={files} selectedPath={file?.path ?? null} onSelect={(f) => setFile(f as StashFile)} />
          ) : (
            <div className="empty">Loading…</div>
          )}
        </div>
      </div>
      {file && imageType(file.path) ? (
        <ImageChange
          repo={repo}
          rev={file.rev}
          parent={file.parent}
          file={file}
          showDiff={showImageDiff}
          onShowDiff={setShowImageDiff}
          diff={diff}
          diffError={diffError}
        />
      ) : (
        <DiffView diff={file ? diff : null} error={diffError} loading={!!file && diff == null} title={file?.path} />
      )}
    </Split>
  );
}
