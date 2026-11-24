import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  Branch,
  Branches,
  errorMessage,
  FetchOptions,
  GitProgress,
  LogEntry,
  MergeOptions,
  PickOptions,
  PullOptions,
  PushOptions,
  RebaseOptions,
  Remote,
  RepoChanged,
  RepoInfo,
  Stash,
  StashOptions,
  Status,
} from "../api";
import { switchTo, SwitchTarget, targetForCommit } from "../branches";
import { CommitAction, commitMenu, pickSummary } from "../commit";
import { mergeSummary, mergeTargets } from "../merge";
import { hasRebaseTargets, rebaseSummary, rebaseTargets } from "../rebase";
import {
  autoFetchDue,
  defaultFetchRemote,
  fetchSummary,
  NoticeKind,
  pullSources,
  pullSummary,
  pushSummary,
  prefs,
  PushTarget,
  splitRemoteBranch,
} from "../remote";
import { stashApplySummary, stashName } from "../stash";
import { relativeTime } from "../util";
import { CreateBranchDialog } from "./BranchDialogs";
import { BranchSwitcher } from "./BranchSwitcher";
import { ChangesView } from "./ChangesView";
import { CherryPickDialog } from "./CommitOpDialog";
import { ContextMenu, MenuEntry, SEPARATOR } from "./ContextMenu";
import { DeleteBranchDialog, DeleteRemoteBranchDialog } from "./DeleteBranchDialog";
import { AddRemoteDialog, EditRemoteDialog, RemoveRemoteDialog } from "./RemoteManageDialogs";
import { HistoryView } from "./HistoryView";
import { MergeDialog } from "./MergeDialog";
import { OperationBanner } from "./OperationBanner";
import { RebaseDialog } from "./RebaseDialog";
import { FetchDialog, PullDialog, PushDialog } from "./RemoteDialogs";
import { Sidebar, View } from "./Sidebar";
import { Split } from "./Split";
import { DropStashDialog, StashDialog } from "./StashDialog";
import { StashView } from "./StashView";
import {
  FetchIcon,
  MergeIcon,
  PullIcon,
  PushIcon,
  RebaseIcon,
  StashIcon,
  ToolbarButton,
  ToolbarDivider,
} from "./Toolbar";

interface RepoTabProps {
  repo: RepoInfo;
  /** Only the active tab is shown and reacts to keyboard shortcuts; the others keep their state. */
  active: boolean;
  /** Where the active tab shows its fetch, pull and push buttons: the app's toolbar. */
  actionsSlot: HTMLElement | null;
  /** Fetch in the background this often; 0 or null (settings not loaded) turns it off. */
  autoFetchMinutes: number | null;
  onError: (message: string) => void;
  /** Clears a previous error, e.g. after a successful branch switch. */
  onClearError: () => void;
}

/** A fetch, pull, push, rebase or merge that is running; background fetches don't show progress. */
interface RemoteOp {
  label: string;
  background: boolean;
}

/** A message in the branch bar, optionally with buttons for what to do next. */
interface Notice {
  text: string;
  kind: NoticeKind;
  actions?: { label: string; run: () => void }[];
}

/** How the push dialog starts: the branch and target to preselect, and whether to force. */
interface PushPreset {
  branch: string;
  target?: PushTarget;
  force: boolean;
}

/** How long a success message stays in the branch bar. */
const NOTICE_MS = 8000;

/** One open repository: its branch bar, sidebar and changes/history views. */
export function RepoTab({ repo, active, actionsSlot, autoFetchMinutes, onError, onClearError }: RepoTabProps) {
  const root = repo.root;
  const [view, setView] = useState<View>("changes");
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [stashes, setStashes] = useState<Stash[] | null>(null);
  // The stash shown in the stash view.
  const [selectedStash, setSelectedStash] = useState<string | null>(null);
  // The stash whose deletion is being confirmed.
  const [dropping, setDropping] = useState<Stash | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [dialog, setDialog] = useState<"fetch" | "pull" | "push" | "merge" | "rebase" | "stash" | null>(null);
  // The local branch whose deletion is being confirmed.
  const [deleting, setDeleting] = useState<{ branch: Branch; unmerged: boolean; withRemote: boolean } | null>(null);
  const [pushPreset, setPushPreset] = useState<PushPreset | null>(null);
  // The branch the merge dialog starts on, when chosen in the sidebar.
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  // The remote branch whose deletion on its remote is being confirmed.
  const [deletingRemote, setDeletingRemote] = useState<{ name: string; remote: string; branch: string } | null>(null);
  // Adding a remote, or editing or removing one.
  const [remoteEdit, setRemoteEdit] = useState<
    { kind: "add" } | { kind: "url" | "name" | "remove"; remote: Remote } | null
  >(null);
  // The commit whose context menu is open in the history, and where.
  const [commitMenuAt, setCommitMenuAt] = useState<{ entry: LogEntry; x: number; y: number } | null>(null);
  // Its full message, loaded when the menu opens so "Copy Message" can copy it right away.
  const [commitMenuMessage, setCommitMenuMessage] = useState<string | null>(null);
  // A branch being created at `start`; `label` describes the start in the dialog, `short` in the message after.
  const [creatingBranch, setCreatingBranch] = useState<{ start: string; label: string; short: string } | null>(null);
  // The commit being cherry-picked.
  const [commitOp, setCommitOp] = useState<{ kind: "cherry-pick"; entry: LogEntry } | null>(null);
  const [remoteOp, setRemoteOp] = useState<RemoteOp | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
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
      const [l, b, s] = await Promise.all([api.log(root), api.branches(root), api.stashes(root)]);
      if (mounted.current) {
        setLog(l);
        setBranches(b);
        setStashes(s);
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

  // Progress of this tab's fetch, pull, rebase or merge ("Receiving objects: 45% (450/1000)", "Rebasing (2/5)").
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

  /** Runs one fetch, pull, push, rebase or merge at a time; resolves to null when another one is still running. */
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

  const openPush = useCallback((preset: Partial<PushPreset> = {}) => {
    const { status: st, branches: br } = latest.current;
    const branch = preset.branch ?? st?.branch ?? br?.local[0]?.name;
    if (!branch) return;
    setPushPreset({ force: false, ...preset, branch });
    setDialog("push");
  }, []);

  const pushNow = useCallback(
    async (options: PushOptions) => {
      setDialog(null);
      const target = `${options.remote}/${options.remoteBranch}`;
      const label = `${options.force ? "Force pushing" : "Pushing"} ${options.branch} to ${target}…`;
      try {
        const result = await runRemote({ label, background: false }, () => api.push(root, options));
        if (!result || !mounted.current) return;
        onClearError();
        const summary: Notice = pushSummary(result, options.branch, target);
        if (result.outcome === "rejected" || result.outcome === "stale") {
          const again = { branch: options.branch, target: { remote: options.remote, remoteBranch: options.remoteBranch } };
          summary.actions = [];
          // The pull dialog pulls into the current branch.
          if (options.branch === latest.current.status?.branch) {
            summary.actions.push({ label: "Pull…", run: () => setDialog("pull") });
          }
          if (result.outcome === "rejected") {
            summary.actions.push({ label: "Force Push…", run: () => openPush({ ...again, force: true }) });
          }
        }
        setNotice(summary);
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError, openPush],
  );

  const rebaseNow = useCallback(
    async (options: RebaseOptions) => {
      setDialog(null);
      const branch = latest.current.status?.branch ?? "HEAD";
      try {
        const result = await runRemote({ label: `Rebasing ${branch} onto ${options.onto}…`, background: false }, () =>
          api.rebase(root, options),
        );
        if (!result || !mounted.current) return;
        setNotice(rebaseSummary(result, options.onto, branch));
        onClearError();
        // Conflicts are resolved in the changes view.
        if (result.outcome === "conflicts" || result.outcome === "stash-conflicts") setView("changes");
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  const mergeNow = useCallback(
    async (options: MergeOptions) => {
      setDialog(null);
      setMergeSource(null);
      const branch = latest.current.status?.branch ?? "HEAD";
      const label = `${options.mode === "squash" ? "Squash merging" : "Merging"} ${options.source} into ${branch}…`;
      try {
        const result = await runRemote({ label, background: false }, () => api.merge(root, options));
        if (!result || !mounted.current) return;
        setNotice(mergeSummary(result, options.source, branch));
        onClearError();
        // Conflicts are resolved, and a squash is committed, in the changes view.
        if (result.conflicts > 0 || result.outcome === "squash") setView("changes");
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
  const canPush = !!branches && branches.remotes.length > 0 && branches.local.length > 0 && !remoteOp;
  const merge = branches && status ? mergeTargets(branches, status) : null;
  const canMerge = !!status?.branch && !!merge && hasRebaseTargets(merge) && !status.operation && !remoteOp;
  const rebase = branches && status ? rebaseTargets(branches, status) : null;
  const canRebase = !!status?.branch && !!rebase && hasRebaseTargets(rebase) && !status.operation && !remoteOp;
  const changeCount = status ? new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path)).size : 0;
  const canStash = !!status && changeCount > 0 && status.conflicted.length === 0 && !status.operation && !remoteOp;
  const applyBlocked = stashApplyBlocked(status, !!remoteOp);

  // Shortcuts of the visible tab: Ctrl/Cmd+B switches branches, Ctrl/Cmd+Shift+F fetches,
  // Ctrl/Cmd+Shift+L pulls and Ctrl/Cmd+Shift+P pushes, as in Fork; Ctrl/Cmd+Shift+M merges,
  // Ctrl/Cmd+Shift+E rebases and Ctrl/Cmd+Shift+S stashes.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "b" && !e.shiftKey) setSwitcherOpen(true);
      else if (key === "f" && e.shiftKey && canFetch) setDialog("fetch");
      else if (key === "l" && e.shiftKey && canPull) setDialog("pull");
      else if (key === "p" && e.shiftKey && canPush) openPush();
      else if (key === "m" && e.shiftKey && canMerge) setDialog("merge");
      else if (key === "e" && e.shiftKey && canRebase) setDialog("rebase");
      else if (key === "s" && e.shiftKey && canStash) setDialog("stash");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canFetch, canPull, canPush, canMerge, canRebase, canStash, openPush]);

  // Popovers and dialogs left open in a tab that is switched away from would reappear unexpectedly.
  useEffect(() => {
    if (!active) {
      setSwitcherOpen(false);
      setDialog(null);
      setDeleting(null);
      setDropping(null);
      setRemoteEdit(null);
      setDeletingRemote(null);
      setCommitMenuAt(null);
      setCreatingBranch(null);
      setCommitOp(null);
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

  const closeDialog = useCallback(() => {
    setDialog(null);
    setMergeSource(null);
  }, []);

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

  const closeDelete = useCallback(() => setDeleting(null), []);

  async function deleteBranch(branch: Branch, force: boolean, withRemote: boolean) {
    setDeleting(null);
    try {
      const run = () => api.deleteBranch(root, branch.name, force, withRemote);
      // Deleting the remote branch talks to the remote, like a push: one at a time, with progress.
      const outcome = withRemote
        ? await runRemote({ label: `Deleting ${branch.name} and ${branch.upstream}…`, background: false }, run)
        : await run();
      if (!outcome || !mounted.current) return;
      onClearError();
      // Nothing was deleted; ask again before dropping the unmerged commits.
      if (outcome === "not-merged") setDeleting({ branch, unmerged: true, withRemote });
      else {
        const what = withRemote ? `${branch.name} and ${branch.upstream}` : branch.name;
        // The commit it pointed at brings the branch back if it was deleted by mistake.
        setNotice({ kind: "info", text: `Deleted branch ${what} (was ${branch.sha.slice(0, 7)}).` });
      }
    } catch (e) {
      if (mounted.current) onError(errorMessage(e));
    } finally {
      if (mounted.current) refreshHistory();
    }
  }

  // A stash that was applied and deleted, or deleted elsewhere, leaves the stash view.
  const shownStash = stashes?.find((s) => s.sha === selectedStash) ?? null;
  useEffect(() => {
    if (view === "stash" && stashes && !shownStash) setView("changes");
  }, [view, stashes, shownStash]);

  const stashNow = useCallback(
    async (options: StashOptions) => {
      setDialog(null);
      try {
        const stash = await runRemote({ label: "Stashing local changes…", background: false }, () =>
          api.stash(root, options),
        );
        if (!stash || !mounted.current) return;
        onClearError();
        setNotice({ kind: "info", text: `Stashed local changes as ${stashName(stash)}.` });
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  const applyStash = useCallback(
    async (stash: Stash, pop: boolean) => {
      try {
        const label = `${pop ? "Popping" : "Applying"} stash ${stashName(stash)}…`;
        const result = await runRemote({ label, background: false }, () => api.applyStash(root, stash.sha, pop));
        if (!result || !mounted.current) return;
        onClearError();
        setNotice(stashApplySummary(result, stash, pop));
        // The applied changes, and any conflicts to resolve, are in the changes view.
        if (pop || result.outcome === "conflicts") setView("changes");
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  const dropStash = useCallback(
    async (stash: Stash) => {
      setDropping(null);
      try {
        const label = `Deleting stash ${stashName(stash)}…`;
        const done = await runRemote({ label, background: false }, () => api.dropStash(root, stash.sha).then(() => true));
        if (!done || !mounted.current) return;
        onClearError();
        // `git stash apply <sha>` still brings it back for a while.
        setNotice({ kind: "info", text: `Deleted stash ${stashName(stash)} (was ${stash.sha.slice(0, 7)}).` });
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  const closeDrop = useCallback(() => setDropping(null), []);
  const closeRemoteEdit = useCallback(() => setRemoteEdit(null), []);
  const closeDeleteRemote = useCallback(() => setDeletingRemote(null), []);

  function askDeleteRemoteBranch(b: Branch) {
    const split = splitRemoteBranch(b.name, latest.current.branches?.remotes ?? []);
    if (split) setDeletingRemote({ name: b.name, ...split });
    else onError(`${b.name} doesn't belong to a remote anymore.`);
  }

  async function deleteRemoteBranch() {
    if (!deletingRemote) return;
    const { name, remote, branch } = deletingRemote;
    setDeletingRemote(null);
    try {
      // Talks to the remote, like a push: one at a time, with progress.
      const done = await runRemote({ label: `Deleting ${name}…`, background: false }, async () => {
        await api.deleteRemoteBranch(root, remote, branch);
        return true;
      });
      if (!done || !mounted.current) return;
      onClearError();
      setNotice({ kind: "info", text: `Deleted ${branch} on ${remote}.` });
    } catch (e) {
      if (mounted.current) onError(errorMessage(e));
    }
  }

  /** Copies `text`; `what` names it in the messages, e.g. "the message of abc1234". */
  function copyText(text: string, what = text) {
    navigator.clipboard.writeText(text).then(
      () => mounted.current && setNotice({ kind: "info", text: `Copied ${what}.` }),
      (e) => mounted.current && onError(`Could not copy ${what}: ${errorMessage(e)}`),
    );
  }

  const openCommitMenu = useCallback(
    (entry: LogEntry, x: number, y: number) => {
      setCommitMenuAt({ entry, x, y });
      setCommitMenuMessage(null);
      api.commitDetails(root, entry.sha).then(
        (d) => mounted.current && setCommitMenuMessage(d.message.trimEnd()),
        () => {
          /* "Copy Message" falls back to the subject */
        },
      );
    },
    [root],
  );
  const closeCommitMenu = useCallback(() => setCommitMenuAt(null), []);

  function commitMenuItems(entry: LogEntry): MenuEntry[] {
    const busy = remoteOp
      ? "Wait until the running operation is done"
      : switching
        ? "Wait until the branch switch is done"
        : null;
    const headSha = log?.find((e) => e.refs.some((r) => r.current))?.sha ?? null;
    const operationBlocked = !status
      ? "Loading…"
      : status.operation
        ? "Finish or abort the current operation first"
        : status.conflicted.length > 0
          ? "Resolve the conflicts first"
          : null;
    return commitMenu(entry, { branches, headSha, operationBlocked, busy }).map((item) =>
      item === "separator"
        ? SEPARATOR
        : {
            label: item.label,
            danger: item.danger,
            disabled: item.blocked !== null,
            title: item.blocked ?? item.title,
            onSelect: () => runCommitAction(item.action, entry),
          },
    );
  }

  function runCommitAction(action: CommitAction, entry: LogEntry) {
    const short = entry.sha.slice(0, 7);
    switch (action) {
      case "checkout": {
        const target = targetForCommit(entry, branches);
        if (target) switchBranch(target);
        break;
      }
      case "create-branch":
        setCreatingBranch({ start: entry.sha, label: `${short} ${entry.subject}`, short });
        break;
      case "cherry-pick":
        setCommitOp({ kind: "cherry-pick", entry });
        break;
      case "copy-sha":
        copyText(entry.sha);
        break;
      case "copy-message":
        copyText(commitMenuMessage ?? entry.subject, `the message of ${short}`);
        break;
    }
  }

  const closeCreateBranch = useCallback(() => setCreatingBranch(null), []);
  const closeCommitOp = useCallback(() => setCommitOp(null), []);

  const cherryPickNow = useCallback(
    async (options: PickOptions) => {
      setCommitOp(null);
      const branch = latest.current.status?.branch ?? "HEAD";
      const short = options.commit.slice(0, 7);
      try {
        const result = await runRemote({ label: `Cherry-picking ${short}…`, background: false }, () =>
          api.cherryPick(root, options),
        );
        if (!result || !mounted.current) return;
        setNotice(pickSummary(result, short, branch));
        onClearError();
        // Staged changes and conflicts are in the changes view.
        if (result.outcome !== "committed") setView("changes");
      } catch (e) {
        if (mounted.current) onError(errorMessage(e));
      }
    },
    [root, runRemote, onError, onClearError],
  );

  // The dialog shows errors itself, so this rejects instead of reporting them.
  async function createBranch(name: string, checkout: boolean) {
    if (!creatingBranch) return;
    await api.createBranch(root, name, creatingBranch.start, checkout);
    setCreatingBranch(null);
    onClearError();
    setNotice({
      kind: "info",
      text: checkout ? `Switched to the new branch ${name}.` : `Created branch ${name} at ${creatingBranch.short}.`,
    });
    refreshAll();
  }

  const fetchRemote = useCallback(
    (remote: string) => fetchNow({ ...prefs.fetch(), remote, background: false }),
    [fetchNow],
  );

  // The remote dialogs show errors themselves, so these reject instead of reporting them.
  async function addRemote(name: string, url: string, fetch: boolean) {
    await api.addRemote(root, name, url);
    setRemoteEdit(null);
    refreshAll();
    if (fetch) fetchRemote(name);
    else setNotice({ kind: "info", text: `Added remote ${name}.` });
  }

  async function editRemote(remote: Remote, value: string) {
    if (remoteEdit?.kind === "name") {
      await api.renameRemote(root, remote.name, value);
      setNotice({ kind: "info", text: `Renamed remote ${remote.name} to ${value}.` });
    } else {
      await api.setRemoteUrl(root, remote.name, value);
      setNotice({ kind: "info", text: `${remote.name} now points to ${value}.` });
    }
    setRemoteEdit(null);
    refreshAll();
  }

  async function removeRemote(remote: Remote) {
    await api.removeRemote(root, remote.name);
    setRemoteEdit(null);
    setNotice({ kind: "info", text: `Removed remote ${remote.name}.` });
    refreshAll();
  }

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
        <button className="small" onClick={refreshAll} title="Refresh">
          ⟳ Refresh
        </button>
      </div>
      {active &&
        actionsSlot &&
        createPortal(
          <>
            <ToolbarButton
              icon={<FetchIcon />}
              label="Fetch"
              disabled={!canFetch}
              onClick={() => setDialog("fetch")}
              title={fetchTitle(branches, status, autoFetchError)}
              warning={autoFetchError && "automatic fetch failed"}
            />
            <ToolbarDivider />
            <ToolbarButton
              icon={<PullIcon />}
              label="Pull"
              badge={status?.behind}
              disabled={!canPull}
              onClick={() => setDialog("pull")}
              title={pullTitle(status, pull?.sources.length ?? 0)}
            />
            <ToolbarDivider />
            <ToolbarButton
              icon={<PushIcon />}
              label="Push"
              badge={status?.ahead}
              disabled={!canPush}
              onClick={() => openPush()}
              title={pushTitle(branches, status)}
            />
            <ToolbarDivider />
            <ToolbarButton
              icon={<MergeIcon />}
              label="Merge"
              disabled={!canMerge}
              onClick={() => setDialog("merge")}
              title={mergeTitle(status, !!merge && hasRebaseTargets(merge))}
            />
            <ToolbarButton
              icon={<RebaseIcon />}
              label="Rebase"
              disabled={!canRebase}
              onClick={() => setDialog("rebase")}
              title={rebaseTitle(status, !!rebase && hasRebaseTargets(rebase))}
            />
            <ToolbarDivider />
            <ToolbarButton
              icon={<StashIcon />}
              label="Stash"
              disabled={!canStash}
              onClick={() => setDialog("stash")}
              title={stashTitle(status, changeCount)}
            />
          </>,
          actionsSlot,
        )}
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
      {dialog === "push" && branches && pushPreset && (
        <PushDialog
          branches={branches}
          status={status}
          branch={pushPreset.branch}
          target={pushPreset.target}
          force={pushPreset.force}
          onPush={pushNow}
          onClose={closeDialog}
        />
      )}
      {dialog === "merge" && status?.branch && merge && (
        <MergeDialog
          repo={root}
          branch={status.branch}
          status={status}
          targets={mergeSource ? { ...merge, preferred: mergeSource } : merge}
          onMerge={mergeNow}
          onClose={closeDialog}
        />
      )}
      {dialog === "rebase" && status?.branch && rebase && (
        <RebaseDialog
          repo={root}
          branch={status.branch}
          status={status}
          targets={rebase}
          onRebase={rebaseNow}
          onClose={closeDialog}
        />
      )}
      {deleting && (
        <DeleteBranchDialog
          branch={deleting.branch}
          remoteBranch={
            deleting.branch.upstream && branches?.remote.some((b) => b.name === deleting.branch.upstream)
              ? deleting.branch.upstream
              : null
          }
          withRemote={deleting.withRemote}
          unmerged={deleting.unmerged}
          onDelete={deleteBranch}
          onClose={closeDelete}
        />
      )}
      {dialog === "stash" && status && <StashDialog status={status} onStash={stashNow} onClose={closeDialog} />}
      {remoteEdit?.kind === "add" && <AddRemoteDialog onAdd={addRemote} onClose={closeRemoteEdit} />}
      {(remoteEdit?.kind === "url" || remoteEdit?.kind === "name") && (
        <EditRemoteDialog
          key={`${remoteEdit.kind}:${remoteEdit.remote.name}`}
          remote={remoteEdit.remote}
          field={remoteEdit.kind}
          onSave={editRemote}
          onClose={closeRemoteEdit}
        />
      )}
      {remoteEdit?.kind === "remove" && (
        <RemoveRemoteDialog
          remote={remoteEdit.remote}
          trackingBranches={(branches?.local ?? [])
            .filter((b) => b.upstream && splitRemoteBranch(b.upstream, branches?.remotes ?? [])?.remote === remoteEdit.remote.name)
            .map((b) => b.name)}
          onRemove={removeRemote}
          onClose={closeRemoteEdit}
        />
      )}
      {deletingRemote && (
        <DeleteRemoteBranchDialog
          {...deletingRemote}
          trackedBy={(branches?.local ?? []).filter((b) => b.upstream === deletingRemote.name).map((b) => b.name)}
          onDelete={deleteRemoteBranch}
          onClose={closeDeleteRemote}
        />
      )}
      {dropping && <DropStashDialog stash={dropping} onDrop={dropStash} onClose={closeDrop} />}
      {creatingBranch && (
        <CreateBranchDialog startLabel={creatingBranch.label} onCreate={createBranch} onClose={closeCreateBranch} />
      )}
      {commitOp?.kind === "cherry-pick" && (
        <CherryPickDialog
          entry={commitOp.entry}
          parents={commitOp.entry.parents.map((sha) => ({
            sha,
            subject: log?.find((e) => e.sha === sha)?.subject ?? null,
          }))}
          branch={status?.branch ?? null}
          onPick={cherryPickNow}
          onClose={closeCommitOp}
        />
      )}
      {commitMenuAt && (
        <ContextMenu
          x={commitMenuAt.x}
          y={commitMenuAt.y}
          label={`Commit ${commitMenuAt.entry.sha.slice(0, 7)}`}
          items={commitMenuItems(commitMenuAt.entry)}
          onClose={closeCommitMenu}
        />
      )}
      <Split direction="horizontal" initial={240} min={160} storageKey="sidebar">
        <Sidebar
          view={view}
          onView={setView}
          changeCount={changeCount}
          branches={branches}
          onSwitch={switchBranch}
          onDelete={(branch) => setDeleting({ branch, unmerged: false, withRemote: false })}
          stashes={stashes}
          selectedStash={selectedStash}
          onSelectStash={(stash) => {
            setSelectedStash(stash.sha);
            setView("stash");
          }}
          applyBlocked={applyBlocked}
          onApplyStash={applyStash}
          onDropStash={setDropping}
          onAddRemote={() => setRemoteEdit({ kind: "add" })}
          onFetchRemote={(remote) => fetchRemote(remote.name)}
          onEditRemote={(remote, field) => setRemoteEdit({ kind: field, remote })}
          onRemoveRemote={(remote) => setRemoteEdit({ kind: "remove", remote })}
          onMerge={(name) => {
            setMergeSource(name);
            setDialog("merge");
          }}
          mergeBlocked={
            canMerge
              ? null
              : !status?.branch
                ? "Check out a branch to merge into"
                : status.operation
                  ? "Finish or abort the current operation first"
                  : remoteOp
                    ? "Wait until the running operation is done"
                    : "Nothing can be merged right now"
          }
          onCopyName={(name) => copyText(name)}
          onDeleteRemoteBranch={askDeleteRemoteBranch}
        />
        <main className="main">
          {view === "changes" ? (
            <ChangesView repo={root} status={status} onChanged={refreshAll} onError={onError} />
          ) : view === "stash" ? (
            shownStash && (
              <StashView
                repo={root}
                stash={shownStash}
                applyBlocked={applyBlocked}
                onApply={applyStash}
                onDrop={setDropping}
                onError={onError}
              />
            )
          ) : (
            <HistoryView
              repo={root}
              log={log}
              onError={onError}
              onCheckout={(entry) => {
                const target = targetForCommit(entry, branches);
                if (target) switchBranch(target);
              }}
              onMenu={openCommitMenu}
            />
          )}
        </main>
      </Split>
    </div>
  );
}

interface RemoteStatusProps {
  op: RemoteOp | null;
  progress: string | null;
  notice: Notice | null;
  onDismiss: () => void;
}

/** The running fetch, pull, push, rebase or merge with git's progress, or the message about the last one. */
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
      {notice.actions?.map((a) => (
        <button key={a.label} className="small notice-action" onClick={a.run}>
          {a.label}
        </button>
      ))}
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

function pushTitle(branches: Branches | null, status: Status | null): string {
  if (branches && branches.remotes.length === 0) return "This repository has no remotes";
  if (branches && branches.local.length === 0) return "There are no branches to push yet";
  const ahead = status?.branch && status.ahead > 0 ? `\n${status.branch} is ${status.ahead} ahead of ${status.upstream}` : "";
  return `Push a branch to a remote (Ctrl/Cmd+Shift+P)${ahead}`;
}

function stashTitle(status: Status | null, changeCount: number): string {
  if (!status) return "Stash";
  if (status.operation) return "Finish or abort the operation in progress first";
  if (status.conflicted.length > 0) return "Resolve the conflicts first";
  if (changeCount === 0) return "There are no local changes to stash";
  return "Stash the local changes (Ctrl/Cmd+Shift+S)";
}

/** Why stashes can't be applied right now; null when they can. */
function stashApplyBlocked(status: Status | null, busy: boolean): string | null {
  if (!status) return "Loading…";
  if (status.operation) return "Finish or abort the operation in progress first";
  if (status.conflicted.length > 0) return "Resolve the conflicts first";
  if (busy) return "Wait for the running operation to finish";
  return null;
}

function mergeTitle(status: Status | null, hasTargets: boolean): string {
  if (!status) return "Merge";
  if (!status.branch) return "Switch to a branch to merge into";
  if (status.operation) return "Finish or abort the operation in progress first";
  if (!hasTargets) return "There are no other branches or tags to merge";
  return `Merge another branch into ${status.branch} (Ctrl/Cmd+Shift+M)`;
}

function rebaseTitle(status: Status | null, hasTargets: boolean): string {
  if (!status) return "Rebase";
  if (!status.branch) return "Switch to a branch to rebase";
  if (status.operation) return "Finish or abort the operation in progress first";
  if (!hasTargets) return "There are no other branches or tags to rebase onto";
  return `Rebase ${status.branch} onto another branch (Ctrl/Cmd+Shift+E)`;
}

/** Id of a tab's panel, for aria-controls on its tab button. */
export function tabPanelId(root: string): string {
  return `repo-panel-${root.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
