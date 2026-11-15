import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Branches, errorMessage, LogEntry, RepoChanged, RepoInfo, Status } from "../api";
import { switchTo, SwitchTarget } from "../branches";
import { BranchSwitcher } from "./BranchSwitcher";
import { ChangesView } from "./ChangesView";
import { HistoryView } from "./HistoryView";
import { Sidebar, View } from "./Sidebar";
import { Split } from "./Split";

interface RepoTabProps {
  repo: RepoInfo;
  /** Only the active tab is shown and reacts to keyboard shortcuts; the others keep their state. */
  active: boolean;
  onError: (message: string) => void;
  /** Clears a previous error, e.g. after a successful branch switch. */
  onClearError: () => void;
}

/** One open repository: its branch bar, sidebar and changes/history views. */
export function RepoTab({ repo, active, onError, onClearError }: RepoTabProps) {
  const root = repo.root;
  const [view, setView] = useState<View>("changes");
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const branchButtonRef = useRef<HTMLButtonElement>(null);
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

  // Ctrl/Cmd+B opens the branch switcher of the visible tab.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // A popover left open in a tab that is switched away from would reappear unexpectedly.
  useEffect(() => {
    if (!active) setSwitcherOpen(false);
  }, [active]);

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
        <span className="repo-path mono selectable" title={root}>
          {root}
        </span>
        <div className="spacer" />
        <button className="small" onClick={refreshAll} title="Refresh">
          ⟳ Refresh
        </button>
      </div>
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

/** Id of a tab's panel, for aria-controls on its tab button. */
export function tabPanelId(root: string): string {
  return `repo-panel-${root.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
