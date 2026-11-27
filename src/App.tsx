import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, RepoInfo, Settings } from "./api";
import { AboutDialog } from "./components/AboutDialog";
import { CloneDialog } from "./components/CloneDialog";
import { ContextMenu, MenuItem } from "./components/ContextMenu";
import { InitRepoDialog } from "./components/InitRepoDialog";
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
  // "New repository…", or the offer to initialize a folder Open… chose that isn't a repository.
  const [newRepo, setNewRepo] = useState<{ folder?: string } | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  // The tab bar's "+" menu, below the button.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // The active tab puts its fetch, pull and push buttons here.
  const [repoActions, setRepoActions] = useState<HTMLDivElement | null>(null);
  const restoreStarted = useRef(false);

  const onError = useCallback((message: string) => setError(message), []);
  const clearError = useCallback(() => setError(null), []);
  const closeAbout = useCallback(() => setAboutOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeNewRepo = useCallback(() => setNewRepo(null), []);
  const closeClone = useCallback(() => setCloneOpen(false), []);
  const closeAddMenu = useCallback(() => setAddMenu(null), []);

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
    if (typeof selected !== "string") return;
    // Offer to initialize a folder that isn't a repository. If that can't be checked, opening reports why.
    if (await api.isRepository(selected).catch(() => true)) openRepo(selected);
    else setNewRepo({ folder: selected });
  }, [openRepo]);

  const onRepoCreated = useCallback((info: RepoInfo) => openRepo(info.root), [openRepo]);

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

  // "Settings…", "Open…", "Clone…" and "New Repository…" in the macOS app menu.
  useEffect(() => {
    const unlisten = [
      listen("open-settings", () => setSettingsOpen(true)),
      listen("open-repository", () => chooseRepo()),
      listen("clone-repository", () => setCloneOpen(true)),
      listen("new-repository", () => setNewRepo({})),
    ];
    return () => {
      unlisten.forEach((u) => u.then((fn) => fn()));
    };
  }, [chooseRepo]);

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
  const addItems: MenuItem[] = [
    { label: "Open Repository…", onSelect: chooseRepo },
    { label: "Clone Repository…", onSelect: () => setCloneOpen(true) },
    { label: "New Repository…", onSelect: () => setNewRepo({}) },
  ];

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
        <button
          className="repo-tab-add"
          aria-label="Open, clone or create a repository"
          aria-haspopup="menu"
          aria-expanded={!!addMenu}
          title="Open, clone or create a repository"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setAddMenu({ x: rect.left, y: rect.bottom });
          }}
        >
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
          onOpenSettings={openSettings}
        />
      ))}
      {tabs.length === 0 && !restoring && (
        <div className="welcome">
          <LogoLockup size={56} as="h1" />
          <p>Open a local repository to see its changes and history, clone one, or create a new one.</p>
          <div className="welcome-actions">
            <button className="primary" onClick={chooseRepo}>
              Open repository…
            </button>
            <button onClick={() => setCloneOpen(true)}>Clone repository…</button>
            <button onClick={() => setNewRepo({})}>New repository…</button>
          </div>
        </div>
      )}

      {addMenu && (
        <ContextMenu x={addMenu.x} y={addMenu.y} label="Repositories" items={addItems} onClose={closeAddMenu} />
      )}
      {cloneOpen && <CloneDialog onCloned={onRepoCreated} onClose={closeClone} />}
      {newRepo && <InitRepoDialog folder={newRepo.folder} onCreated={onRepoCreated} onClose={closeNewRepo} />}

      {aboutOpen && <AboutDialog onClose={closeAbout} />}
      {settingsOpen && <SettingsDialog onClose={closeSettings} onSaved={setSettings} />}
    </div>
  );
}

export default App;
