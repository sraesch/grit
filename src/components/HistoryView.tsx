import { useVirtualizer } from "@tanstack/react-virtual";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, CommitDetails, errorMessage, FileChange, LogEntry, RefLabel } from "../api";
import { imageType } from "../image";
import { fullDate, relativeTime } from "../util";
import { DiffView } from "./DiffView";
import { FileList } from "./FileList";
import { GraphCell, graphWidth, ROW_HEIGHT } from "./GraphCell";
import { ImagePreview, ImageVersion } from "./ImagePreview";
import { CommitMessage, splitCommitMessage } from "./Markdown";
import { Split } from "./Split";

interface HistoryViewProps {
  repo: string;
  log: LogEntry[] | null;
  onError: (message: string) => void;
  /** Double-click on a commit. */
  onCheckout: (entry: LogEntry) => void;
}

function RefBadge({ r }: { r: RefLabel }) {
  return (
    <span className={`ref-badge ref-${r.kind}${r.current ? " ref-current" : ""}`} title={r.name}>
      {r.kind === "tag" ? "🏷 " : ""}
      {r.name}
    </span>
  );
}

export function HistoryView({ repo, log, onError, onCheckout }: HistoryViewProps) {
  const entries = log ?? [];
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const headSha = useMemo(
    () => entries.find((e) => e.refs.some((r) => r.current))?.sha ?? null,
    [entries],
  );
  const width = useMemo(() => graphWidth(entries.reduce((m, e) => Math.max(m, e.graph.width), 1)), [entries]);
  const selectedIndex = useMemo(() => entries.findIndex((e) => e.sha === selectedSha), [entries, selectedSha]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Select HEAD initially, and keep the selection valid when history is rewritten.
  useEffect(() => {
    if (entries.length === 0) setSelectedSha(null);
    else if (!selectedSha || !entries.some((e) => e.sha === selectedSha)) setSelectedSha(headSha ?? entries[0].sha);
  }, [entries, headSha, selectedSha]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.min(Math.max(selectedIndex + (e.key === "ArrowDown" ? 1 : -1), 0), entries.length - 1);
    if (next >= 0) {
      setSelectedSha(entries[next].sha);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  }

  return (
    <Split direction="vertical" initial={380} min={140} storageKey="history">
      <div className="history-list">
        <div className="history-header">
          <span style={{ width }}>Graph</span>
          <span className="col-subject">Description</span>
          <span className="col-author">Author</span>
          <span className="col-date">Date</span>
          <span className="col-sha">Commit</span>
        </div>
        <div ref={scrollRef} className="history-scroll" tabIndex={0} onKeyDown={onKeyDown}>
          {entries.length === 0 && <div className="empty">{log ? "No commits yet" : "Loading history…"}</div>}
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const c = entries[item.index];
              return (
                <div
                  key={c.sha}
                  className={`commit-row${c.sha === selectedSha ? " selected" : ""}`}
                  style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                  onClick={() => setSelectedSha(c.sha)}
                  onDoubleClick={() => onCheckout(c)}
                  title={c.sha === headSha ? undefined : "Double-click to check out"}
                >
                  <GraphCell row={c.graph} isMerge={c.parents.length > 1} isHead={c.sha === headSha} width={width} />
                  <span className="col-subject">
                    {c.refs.map((r) => (
                      <RefBadge key={`${r.kind}:${r.name}`} r={r} />
                    ))}
                    <span className="subject-text">{c.subject}</span>
                  </span>
                  <span className="col-author" title={c.email}>
                    {c.author}
                  </span>
                  <span className="col-date" title={fullDate(c.time)}>
                    {relativeTime(c.time)}
                  </span>
                  <span className="col-sha mono">{c.sha.slice(0, 8)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <CommitPanel repo={repo} sha={selectedSha} onError={onError} />
    </Split>
  );
}

const MARKDOWN_KEY = "commit-message-markdown";

/** Whether commit bodies are rendered as markdown; remembered across commits and restarts. */
function useMarkdownPreference(): [boolean, (on: boolean) => void] {
  const [markdown, setMarkdown] = useState(() => localStorage.getItem(MARKDOWN_KEY) !== "false");
  const update = (on: boolean) => {
    setMarkdown(on);
    localStorage.setItem(MARKDOWN_KEY, String(on));
  };
  return [markdown, update];
}

function CommitPanel({ repo, sha, onError }: { repo: string; sha: string | null; onError: (m: string) => void }) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [file, setFile] = useState<FileChange | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useMarkdownPreference();
  const [showImageDiff, setShowImageDiff] = useState(false);

  useEffect(() => {
    setDetails(null);
    setFile(null);
    if (!sha) return;
    let cancelled = false;
    api
      .commitDetails(repo, sha)
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setFile(d.files[0] ?? null);
      })
      .catch((e) => !cancelled && onError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, sha, onError]);

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    if (!sha || !file) return;
    let cancelled = false;
    api
      .commitFileDiff(repo, sha, file.path, file.origPath)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setDiffError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, sha, file]);

  if (!sha) return <div className="empty">Select a commit</div>;
  if (!details) return <div className="empty">Loading…</div>;

  return (
    <Split direction="horizontal" initial={380} min={240} storageKey="commit-panel">
      <div className="commit-panel">
        <div className="commit-meta">
          {splitCommitMessage(details.message).body && (
            <button
              className="small commit-format-toggle"
              aria-pressed={markdown}
              title={markdown ? "Show the message as plain text" : "Render the message as markdown"}
              onClick={() => setMarkdown(!markdown)}
            >
              Markdown
            </button>
          )}
          <CommitMessage message={details.message} markdown={markdown} />
          <dl>
            <dt>Author</dt>
            <dd>
              {details.author} &lt;{details.authorEmail}&gt;
            </dd>
            <dt>Date</dt>
            <dd>{fullDate(details.authorTime)}</dd>
            {details.committer !== details.author && (
              <>
                <dt>Committer</dt>
                <dd>{details.committer}</dd>
              </>
            )}
            <dt>Commit</dt>
            <dd className="mono selectable">{details.sha}</dd>
            {details.parents.length > 0 && (
              <>
                <dt>Parents</dt>
                <dd className="mono">{details.parents.map((p) => p.slice(0, 8)).join(", ")}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="pane-header">
          <span>Changed files</span>
          <span className="count">{details.files.length}</span>
        </div>
        <div className="section-scroll">
          <FileList files={details.files} selectedPath={file?.path ?? null} onSelect={setFile} />
        </div>
      </div>
      {file && imageType(file.path) ? (
        <ImageChange
          repo={repo}
          rev={details.sha}
          parent={details.parents[0] ?? null}
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

interface ImageChangeProps {
  repo: string;
  /** The commit that changed the file. */
  rev: string;
  /** What it is compared to, its first parent; null for a root commit. */
  parent: string | null;
  file: FileChange;
  showDiff: boolean;
  onShowDiff: (show: boolean) => void;
  diff: string | null;
  diffError: string | null;
}

/** An image file changed by a commit: a before/after preview, or its diff on request (useful for SVG). */
export function ImageChange({ repo, rev, parent, file, showDiff, onShowDiff, diff, diffError }: ImageChangeProps) {
  // Like the diff, the preview compares against the first parent.
  const before: ImageVersion | null =
    file.status !== "A" && file.status !== "?" && parent ? { rev: parent, path: file.origPath ?? file.path } : null;
  const after: ImageVersion | null = file.status !== "D" ? { rev, path: file.path } : null;

  const toggle = (
    <button className="small" aria-pressed={showDiff} onClick={() => onShowDiff(!showDiff)}>
      {showDiff ? "Show image" : "Show diff"}
    </button>
  );

  if (showDiff) {
    return <DiffView diff={diff} error={diffError} loading={diff == null} title={file.path} actions={toggle} />;
  }
  return <ImagePreview repo={repo} before={before} after={after} title={file.path} actions={toggle} />;
}
