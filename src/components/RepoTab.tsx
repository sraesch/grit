import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Branches, errorMessage, FetchOptions, GitProgress, LogEntry, PullOptions, RepoChanged, RepoInfo, Status } from "../api";
import { switchTo, SwitchTarget } from "../branches";
import { autoFetchDue, defaultFetchRemote, fetchSummary, NoticeKind, pullSources, pullSummary } from "../remote";
import { relativeTime } from "../util";
import { BranchSwitcher } from "./BranchSwitcher";
import { ChangesView } from "./ChangesView";
import { HistoryView } from "./HistoryView";
import { OperationBanner } from "./OperationBanner";
import { FetchDialog, PullDialog } from "./RemoteDialogs";
import { Sidebar, View } from "./Sidebar";
import { Split } from "./Split";

interface RepoTabProps {
  repo: RepoInfo;
  /** Only the active tab is shown and reacts to keyboard shortcuts; the others keep their state. */
  active: boolean;
  /** Fetch in the background this often; 0 or null (settings not loaded) turns it off. */
  autoFetchMinutes: number | null;
  onError: (message: string) => void;
  /** Clears a previous error, e.g. after a successful branch switch. */
  onClearError: () => void;
}

/** A fetch or pull that is running; background fetches don't show progress. */
interface RemoteOp {
  label: string;
  background: boolean;
}

/** How long a success message stays in the branch bar. */
const NOTICE_MS = 8000;

/** One open repository: its branch bar, sidebar and changes/history views. */
export function RepoTab({ repo, active, autoFetchMinutes, onError, onClearError }: RepoTabProps) {
  const root = repo.root;
  const [view, setView] = useState<View>("changes");
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [dialog, setDialog] = useState<"fetch" | "pull" | null>(null);
  const [remoteOp, setRemoteOp] = useState<RemoteOp | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: NoticeKind } | null>(null);
  const [autoFetchError, setAutoFetchError] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const branchButtonRef = useRef<HTMLButtonElement>(null);
  // Read from timers and event handlers, which would otherwise see stale state.
  const remoteOpRef = useRef<RemoteOp | null>(null);
  const lastAutoFetch = useRef<number | null>(null);
  const latest = useRef({ status, branches });
  latest.current = { status, branches };
  // Ignore results that arrive after the tab was closed.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.status(root);
      if (mounted.current) setStatus(s);
    } catch (e) {
      if (mounted.current) onError(errorMessage(e));
    }
  }, [root, onError]);

  const refreshHistory = useCallback(async () => {
    try {
      const [l, b] = await Promise.all([api.log(root), api.branches(root)]);
      if (mounted.current) {
        setLog(l);
        setBranches(b);
      }
    } catch (e) {
      if (mounted.current) onError(errorMessage(e));
    }
  }, [root, onError]);

  const refreshAll = useCallback(() => {
    refreshStatus();
    refreshHistory();
  }, [refreshStatus, refreshHistory]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Every tab listens, but only for its own repository, so background tabs stay current.
  useEffect(() => {
    const unlisten = listen<RepoChanged>("repo-changed", ({ payload }) => {
      if (payload.root !== root) return;
      if (payload.worktree) refreshStatus();
      if (payload.refs) refreshHistory();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [root, refreshStatus, refreshHistory]);

  // Progress of this tab's fetch or pull ("Receiving objects: 45% (450/1000)").
  useEffect(() => {
    const unlisten = listen<GitProgress>("git-progress", ({ payload }) => {
      if (payload.root === root && remoteOpRef.current && !remoteOpRef.current.background) setProgress(payload.text);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [root]);

  // Success messages fade after a while; warnings stay until replaced or dismissed.
  useEffect(() => {
    if (notice?.kind !== "info") return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Runs one fetch or pull at a time; resolves to null when another one is still running. */
  const runRemote = useCallback(
    async <T,>(op: RemoteOp, action: () => Promise<T>): Promise<T | null> => {
      if (remoteOpRef.current) {
        // E.g. an automatic fetch started while the dialog was open.
        if (!op.background) setNotice({ kind: "warning", text: `${remoteOpRef.current.label} Try again when it's done.` });
        return null;
      }
      remoteOpRef.current = op;
      setRemoteOp(op);
      setProgress(null);
      if (!op.background) setNotice(null);
      try {
        return await action();
      } finally {
        remoteOpRef.current = null;
        if (mounted.current) {
          setRemoteOp(null);
          setProgress(null);
          refreshAll();
        }
      }
    },
    [refreshAll],
  );

  const fetchNow = useCallback(
    async (options: FetchOptions) => {
      setDialog(null);
      const label = options.remote ? `Fetching ${options.remote}…` : "Fetching all remotes…";
      try {
        const result = await runRemote({ label, background: false }, () => api.fetch(root, options));
        if (result && mounted.current) {
          setNotice({ kind: "info", text: fetchSummary(result, options.remote) });
          setAutoFetchError(null);
          onClearError();
        }
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  const pullNow = useCallback(
    async (options: PullOptions, source: string) => {
      setDialog(null);
      const branch = latest.current.status?.branch ?? "HEAD";
      try {
        const result = await runRemote({ label: `Pulling ${source}…`, background: false }, () => api.pull(root, options));
        if (!result || !mounted.current) return;
        setNotice(pullSummary(result, source, branch));
        onClearError();
        // Conflicts are resolved in the changes view.
        if (result.conflicts > 0) setView("changes");
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  // Fetch in the background when the last fetch (by grit, the command line or another tool)
  // or the last attempt is older than the interval. Failures are shown quietly on the button.
  const autoFetch = useCallback(async () => {
    const { status: st, branches: br } = latest.current;
    const now = Date.now() / 1000;
    if (!autoFetchMinutes || !st || !br || br.remotes.length === 0 || remoteOpRef.current) return;
    if (!autoFetchDue(st.lastFetch, lastAutoFetch.current, autoFetchMinutes, now)) return;
    lastAutoFetch.current = now;
    try {
      const result = await runRemote({ label: "Fetching…", background: true }, () =>
        api.fetch(root, { remote: null, prune: false, tags: false, background: true }),
      );
      if (result && mounted.current) setAutoFetchError(null);
    } catch (e) {
      if (mounted.current) setAutoFetchError(errorMessage(e));
    }
  }, [root, autoFetchMinutes, runRemote]);

  const loaded = status !== null && branches !== null;
  useEffect(() => {
    if (!loaded || !autoFetchMinutes) return;
    autoFetch();
    const timer = setInterval(autoFetch, 60_000);
    return () => clearInterval(timer);
  }, [loaded, autoFetchMinutes, autoFetch]);

  const canFetch = !!branches && branches.remotes.length > 0 && !remoteOp;
  const pull = branches && status ? pullSources(branches, status) : null;
  const canPull = !!status?.branch && !!pull && pull.sources.length > 0 && !status.operation && !remoteOp;

  // Shortcuts of the visible tab: Ctrl/Cmd+B switches branches, Ctrl/Cmd+Shift+F fetches,
  // Ctrl/Cmd+Shift+L pulls.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "b" && !e.shiftKey) setSwitcherOpen(true);
      else if (key === "f" && e.shiftKey && canFetch) setDialog("fetch");
      else if (key === "l" && e.shiftKey && canPull) setDialog("pull");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canFetch, canPull]);

  // Popovers and dialogs left open in a tab that is switched away from would reappear unexpectedly.
  useEffect(() => {
    if (!active) {
      setSwitcherOpen(false);
      setDialog(null);
    }
  }, [active]);

  async function runOperation(action: (repo: string) => Promise<void>) {
    setOperationBusy(true);
    try {
      await action(root);
      setNotice(null);
      onClearError();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      if (mounted.current) {
        setOperationBusy(false);
        refreshAll();
      }
    }
  }

  const closeDialog = useCallback(() => setDialog(null), []);

  const closeSwitcher = useCallback((refocus: boolean) => {
    setSwitcherOpen(false);
    if (refocus) branchButtonRef.current?.focus();
  }, []);

  async function switchBranch(target: SwitchTarget) {
    if (switching) return;
    setSwitcherOpen(false);
    setSwitching(true);
    try {
      await switchTo(root, target);
      onClearError();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      if (mounted.current) {
        setSwitching(false);
        refreshAll();
      }
    }
  }

  const changeCount = status ? new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path)).size : 0;

  return (
    <div className="repo-tab" id={tabPanelId(root)} role="tabpanel" aria-label={repo.name} hidden={!active}>
      <div className="repo-bar">
        {status && (
          <div className="branch-switcher-anchor">
            <button
              ref={branchButtonRef}
              className="branch-pill"
              aria-haspopup="dialog"
              aria-expanded={switcherOpen}
              disabled={switching}
              title="Switch branch (Ctrl/Cmd+B)"
              onClick={() => setSwitcherOpen(!switcherOpen)}
            >
              <span className="branch-pill-name">{switching ? "Switching…" : (status.branch ?? "detached HEAD")}</span>
              {!switching && status.ahead > 0 && <span className="ab">↑{status.ahead}</span>}
              {!switching && status.behind > 0 && <span className="ab">↓{status.behind}</span>}
              <span className="branch-pill-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {switcherOpen && branches && (
              <BranchSwitcher
                branches={branches}
                onSwitch={switchBranch}
                onClose={closeSwitcher}
                ignoreRef={branchButtonRef}
              />
            )}
          </div>
        )}
        <RemoteStatus op={remoteOp} progress={progress} notice={notice} onDismiss={() => setNotice(null)} />
        {!remoteOp && !notice && (
          <span className="repo-path mono selectable" title={root}>
            {root}
          </span>
        )}
        <div className="spacer" />
        <button
          className="small remote-button"
          disabled={!canFetch}
          onClick={() => setDialog("fetch")}
          title={fetchTitle(branches, status, autoFetchError)}
        >
          Fetch
          {autoFetchError && (
            <span className="remote-warning" aria-label="automatic fetch failed">
              !
            </span>
          )}
        </button>
        <button
          className="small remote-button"
          disabled={!canPull}
          onClick={() => setDialog("pull")}
          title={pullTitle(status, pull?.sources.length ?? 0)}
        >
          Pull
          {status && status.behind > 0 && <span className="count accent">{status.behind}</span>}
        </button>
        <button className="small" onClick={refreshAll} title="Refresh">
          ⟳ Refresh
        </button>
      </div>
      {status?.operation && (
        <OperationBanner
          operation={status.operation}
          conflicts={status.conflicted.length}
          busy={operationBusy || !!remoteOp}
          onAbort={() => runOperation(api.abortOperation)}
          onContinue={() => runOperation(api.continueOperation)}
          onSkip={() => runOperation(api.skipOperation)}
        />
      )}
      {dialog === "fetch" && branches && (
        <FetchDialog
          remotes={branches.remotes}
          defaultRemote={defaultFetchRemote(status, branches.remotes)}
          onFetch={fetchNow}
          onClose={closeDialog}
        />
      )}
      {dialog === "pull" && status?.branch && branches && pull && (
        <PullDialog
          branch={status.branch}
          status={status}
          remotes={branches.remotes}
          sources={pull.sources}
          preferred={pull.preferred}
          onPull={pullNow}
          onClose={closeDialog}
        />
      )}
      <Split direction="horizontal" initial={240} min={160} storageKey="sidebar">
        <Sidebar view={view} onView={setView} changeCount={changeCount} branches={branches} onSwitch={switchBranch} />
        <main className="main">
          {view === "changes" ? (
            <ChangesView repo={root} status={status} onChanged={refreshAll} onError={onError} />
          ) : (
            <HistoryView repo={root} log={log} onError={onError} />
          )}
        </main>
      </Split>
    </div>
  );
}

interface RemoteStatusProps {
  op: RemoteOp | null;
  progress: string | null;
  notice: { text: string; kind: NoticeKind } | null;
  onDismiss: () => void;
}

/** The running fetch or pull with git's progress, or the message about the last one. */
function RemoteStatus({ op, progress, notice, onDismiss }: RemoteStatusProps) {
  if (op) {
    return (
      <span className="remote-status" role="status">
        <span className="spinner" aria-hidden="true" />
        <span className="remote-status-text">
          {op.label}
          {progress && <span className="remote-progress mono"> {progress}</span>}
        </span>
      </span>
    );
  }
  if (!notice) return null;
  return (
    <span className={`remote-status notice-${notice.kind}`} role="status">
      <span className="remote-status-text selectable" title={notice.text}>
        {notice.text}
      </span>
      <button className="notice-dismiss" aria-label="Dismiss message" title="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </span>
  );
}

function fetchTitle(branches: Branches | null, status: Status | null, autoFetchError: string | null): string {
  if (branches && branches.remotes.length === 0) return "This repository has no remotes";
  const lines = ["Fetch from a remote (Ctrl/Cmd+Shift+F)"];
  if (status?.lastFetch) lines.push(`Last fetched ${relativeTime(status.lastFetch)}`);
  if (autoFetchError) lines.push(`Automatic fetch failed:\n${autoFetchError}`);
  return lines.join("\n");
}

function pullTitle(status: Status | null, sources: number): string {
  if (!status) return "Pull";
  if (!status.branch) return "Switch to a branch to pull";
  if (status.operation) return "Finish or abort the operation in progress first";
  if (sources === 0) return "There are no remote branches to pull from";
  const behind = status.behind > 0 ? `\n${status.branch} is ${status.behind} behind ${status.upstream}` : "";
  return `Pull into ${status.branch} (Ctrl/Cmd+Shift+L)${behind}`;
}

/** Id of a tab's panel, for aria-controls on its tab button. */
export function tabPanelId(root: string): string {
  return `repo-panel-${root.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
