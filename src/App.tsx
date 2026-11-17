import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, RepoInfo, Settings } from "./api";
import { AboutDialog } from "./components/AboutDialog";
import { LogoLockup, LogoTile } from "./components/Logo";
import { RepoTab, tabPanelId } from "./components/RepoTab";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  AboutIcon,
  FetchIcon,
  PullIcon,
  PushIcon,
  SettingsIcon,
  ToolbarButton,
  ToolbarDivider,
} from "./components/Toolbar";
import { nextActive, readOpenTabs, saveOpenTabs, tabLabels } from "./tabs";
import "@fontsource/nunito-sans/latin-900.css";
import "./App.css";

function App() {
  const [tabs, setTabs] = useState<RepoInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // Until the tabs from the last session are reopened, saving would overwrite them with nothing.
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  // The active tab puts its fetch, pull and push buttons here.
  const [repoActions, setRepoActions] = useState<HTMLDivElement | null>(null);
  const restoreStarted = useRef(false);

  const onError = useCallback((message: string) => setError(message), []);
  const clearError = useCallback(() => setError(null), []);
  const closeAbout = useCallback(() => setAboutOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /** Adds a tab for the repository at `path`, or shows its tab if it is already open. */
  const addTab = useCallback((info: RepoInfo) => {
    setTabs((prev) => (prev.some((t) => t.root === info.root) ? prev : [...prev, info]));
  }, []);

  const openRepo = useCallback(
    async (path: string) => {
      try {
        const info = await api.openRepo(path);
        addTab(info);
        setActive(info.root);
        setError(null);
      } catch (e) {
        onError(errorMessage(e));
      }
    },
    [addTab, onError],
  );

  const chooseRepo = useCallback(async () => {
    // Start in the repositories folder from the settings; without one the dialog picks its own default.
    const settings = await api.getSettings().catch(() => null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open repository",
      defaultPath: settings?.reposDir ?? undefined,
    });
    if (typeof selected === "string") openRepo(selected);
  }, [openRepo]);

  const closeTab = useCallback(
    (root: string) => {
      setTabs((prev) => prev.filter((t) => t.root !== root));
      setActive((current) => nextActive(tabs.map((t) => t.root), root, current));
      api.closeRepo(root).catch(() => {});
    },
    [tabs],
  );

  // Reopen the tabs of the last session, in order. Repositories that were moved or deleted
  // are skipped and reported.
  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    const saved = readOpenTabs();
    (async () => {
      const failed: string[] = [];
      const opened: string[] = [];
      for (const root of saved.roots) {
        try {
          const info = await api.openRepo(root);
          addTab(info);
          opened.push(info.root);
        } catch (e) {
          failed.push(`${root}: ${errorMessage(e)}`);
        }
      }
      setActive(saved.active && opened.includes(saved.active) ? saved.active : (opened[opened.length - 1] ?? null));
      if (failed.length) onError(`Could not reopen:\n${failed.join("\n")}`);
      setRestoring(false);
    })();
  }, [addTab, onError]);

  useEffect(() => {
    if (!restoring) saveOpenTabs(tabs.map((t) => t.root), active);
  }, [tabs, active, restoring]);

  // The tabs need the settings (automatic fetching) once a repository is open. Without them,
  // nothing is fetched automatically.
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (!hasTabs || settings) return;
    let cancelled = false;
    api
      .getSettings()
      .then((s) => !cancelled && setSettings(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasTabs, settings]);

  // "Settings…" in the macOS app menu.
  useEffect(() => {
    const unlisten = listen("open-settings", () => setSettingsOpen(true));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // App-wide shortcuts: settings, opening, closing and cycling through tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const cycle = (step: number) => {
        if (tabs.length < 2) return;
        const i = tabs.findIndex((t) => t.root === active);
        setActive(tabs[(i + step + tabs.length) % tabs.length].root);
      };
      if (key === "," && !e.shiftKey) setSettingsOpen(true);
      else if ((key === "o" || key === "t") && !e.shiftKey) chooseRepo();
      else if (key === "w" && !e.shiftKey && active) closeTab(active);
      else if ((key === "tab" && !e.shiftKey) || (key === "pagedown" && !e.shiftKey)) cycle(1);
      else if ((key === "tab" && e.shiftKey) || (key === "pageup" && !e.shiftKey)) cycle(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, active, chooseRepo, closeTab]);

  const labels = tabLabels(tabs);

  return (
    <div className="app">
      <header className="toolbar">
        <LogoTile size={22} label="grit" />
        <div className="toolbar-group" ref={setRepoActions}>
          {/* Without a repository there is nothing to fetch, pull or push. */}
          {tabs.length === 0 && (
            <>
              <ToolbarButton icon={<FetchIcon />} label="Fetch" disabled onClick={() => {}} />
              <ToolbarDivider />
              <ToolbarButton icon={<PullIcon />} label="Pull" disabled onClick={() => {}} />
              <ToolbarDivider />
              <ToolbarButton icon={<PushIcon />} label="Push" disabled onClick={() => {}} />
            </>
          )}
        </div>
        <div className="spacer" />
        <div className="toolbar-group">
          <ToolbarButton
            icon={<SettingsIcon />}
            label="Settings"
            title="Settings (Ctrl/Cmd+,)"
            onClick={() => setSettingsOpen(true)}
          />
          <ToolbarButton icon={<AboutIcon />} label="About" title="About grit" onClick={() => setAboutOpen(true)} />
        </div>
      </header>
      <nav className="tab-bar" aria-label="Repositories">
        <div className="repo-tabs" role="tablist" aria-label="Open repositories">
          {tabs.map((t) => {
            const selected = t.root === active;
            const label = labels.get(t.root) ?? t.name;
            return (
              <div
                key={t.root}
                className={`repo-tab-item${selected ? " selected" : ""}`}
                title={t.root}
                // Middle-click closes, as in browsers.
                onAuxClick={(e) => e.button === 1 && closeTab(t.root)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              >
                <button
                  className="repo-tab-close"
                  aria-label={`Close ${label}`}
                  title="Close (Ctrl/Cmd+W)"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => closeTab(t.root)}
                >
                  ×
                </button>
                <button
                  role="tab"
                  aria-selected={selected}
                  aria-controls={tabPanelId(t.root)}
                  tabIndex={selected ? 0 : -1}
                  className="repo-tab-label"
                  onClick={() => setActive(t.root)}
                >
                  {label}
                </button>
              </div>
            );
          })}
        </div>
        <button className="repo-tab-add" onClick={chooseRepo} aria-label="Open repository" title="Open repository (Ctrl/Cmd+O)">
          +
        </button>
      </nav>

      {error && (
        <div className="error-bar" role="alert">
          <pre>{error}</pre>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {tabs.map((t) => (
        <RepoTab
          key={t.root}
          repo={t}
          active={t.root === active}
          actionsSlot={repoActions}
          autoFetchMinutes={settings?.autoFetchMinutes ?? null}
          onError={onError}
          onClearError={clearError}
        />
      ))}
      {tabs.length === 0 && !restoring && (
        <div className="welcome">
          <LogoLockup size={56} as="h1" />
          <p>Open a local repository to see its changes and history.</p>
          <button className="primary" onClick={chooseRepo}>
            Open repository…
          </button>
        </div>
      )}

      {aboutOpen && <AboutDialog onClose={closeAbout} />}
      {settingsOpen && <SettingsDialog onClose={closeSettings} onSaved={setSettings} />}
    </div>
  );
}

export default App;
