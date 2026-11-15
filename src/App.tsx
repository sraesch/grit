import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Branches, errorMessage, LogEntry, RepoChanged, RepoInfo, Status } from "./api";
import { switchTo, SwitchTarget } from "./branches";
import { AboutDialog } from "./components/AboutDialog";
import { BranchSwitcher } from "./components/BranchSwitcher";
import { ChangesView } from "./components/ChangesView";
import { HistoryView } from "./components/HistoryView";
import { LogoLockup, LogoTile } from "./components/Logo";
import { Sidebar, View } from "./components/Sidebar";
import { Split } from "./components/Split";
import "@fontsource/nunito-sans/latin-900.css";
import "./App.css";

const LAST_REPO_KEY = "lastRepo";

function readLastRepo(): string | null {
  try {
    return localStorage.getItem(LAST_REPO_KEY);
  } catch {
    return null;
  }
}

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [view, setView] = useState<View>("changes");
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const branchButtonRef = useRef<HTMLButtonElement>(null);
  const repoRef = useRef<string | null>(null);

  const onError = useCallback((message: string) => setError(message), []);
  const closeAbout = useCallback(() => setAboutOpen(false), []);
  const closeSwitcher = useCallback((refocus: boolean) => {
    setSwitcherOpen(false);
    if (refocus) branchButtonRef.current?.focus();
  }, []);

  const refreshStatus = useCallback(async () => {
    const root = repoRef.current;
    if (!root) return;
    try {
      const s = await api.status(root);
      if (repoRef.current === root) setStatus(s);
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [onError]);

  const refreshHistory = useCallback(async () => {
    const root = repoRef.current;
    if (!root) return;
    try {
      const [l, b] = await Promise.all([api.log(root), api.branches(root)]);
      if (repoRef.current === root) {
        setLog(l);
        setBranches(b);
      }
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [onError]);

  const refreshAll = useCallback(() => {
    refreshStatus();
    refreshHistory();
  }, [refreshStatus, refreshHistory]);

  const openRepo = useCallback(
    async (path: string) => {
      try {
        const info = await api.openRepo(path);
        repoRef.current = info.root;
        setRepo(info);
        setStatus(null);
        setLog(null);
        setBranches(null);
        setError(null);
        try {
          localStorage.setItem(LAST_REPO_KEY, info.root);
        } catch {
          /* not remembered */
        }
        refreshAll();
      } catch (e) {
        onError(errorMessage(e));
      }
    },
    [refreshAll, onError],
  );

  async function chooseRepo() {
    const selected = await open({ directory: true, multiple: false, title: "Open repository" });
    if (typeof selected === "string") openRepo(selected);
  }

  useEffect(() => {
    const last = readLastRepo();
    if (last) openRepo(last);
  }, [openRepo]);

  useEffect(() => {
    const unlisten = listen<RepoChanged>("repo-changed", ({ payload }) => {
      if (payload.worktree) refreshStatus();
      if (payload.refs) refreshHistory();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshStatus, refreshHistory]);

  // Ctrl/Cmd+B opens the branch switcher.
  useEffect(() => {
    if (!repo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repo]);

  async function switchBranch(target: SwitchTarget) {
    if (!repo || switching) return;
    setSwitcherOpen(false);
    setSwitching(true);
    try {
      await switchTo(repo.root, target);
      setError(null);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setSwitching(false);
      refreshAll();
    }
  }

  const changeCount = status ? new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path)).size : 0;

  return (
    <div className="app">
      <header className="toolbar">
        <LogoTile size={22} label="grit" />
        <button onClick={chooseRepo}>Open…</button>
        {repo && (
          <>
            <div className="repo-title" title={repo.root}>
              <strong>{repo.name}</strong>
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
            </div>
          </>
        )}
        <div className="spacer" />
        {repo && (
          <button onClick={refreshAll} title="Refresh">
            ⟳ Refresh
          </button>
        )}
        <button onClick={() => setAboutOpen(true)} title="About grit">
          About
        </button>
      </header>

      {error && (
        <div className="error-bar" role="alert">
          <pre>{error}</pre>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {repo ? (
        <Split direction="horizontal" initial={240} min={160} storageKey="sidebar">
          <Sidebar view={view} onView={setView} changeCount={changeCount} branches={branches} onSwitch={switchBranch} />
          <main className="main">
            {view === "changes" ? (
              <ChangesView repo={repo.root} status={status} onChanged={refreshAll} onError={onError} />
            ) : (
              <HistoryView repo={repo.root} log={log} onError={onError} />
            )}
          </main>
        </Split>
      ) : (
        <div className="welcome">
          <LogoLockup size={56} as="h1" />
          <p>Open a local repository to see its changes and history.</p>
          <button className="primary" onClick={chooseRepo}>
            Open repository…
          </button>
        </div>
      )}

      {aboutOpen && <AboutDialog onClose={closeAbout} />}
    </div>
  );
}

export default App;
