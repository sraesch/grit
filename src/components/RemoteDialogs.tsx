import { FormEvent, KeyboardEvent, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Branches, FetchOptions, PullOptions, PushOptions, Remote, Status } from "../api";
import {
  ALL_REMOTES,
  defaultPushTarget,
  FetchPrefs,
  parseTrack,
  prefs,
  PullPrefs,
  PushPrefs,
  PushTarget,
  splitRemoteBranch,
} from "../remote";

interface DialogProps {
  id: string;
  title: string;
  submitLabel: string;
  /** Marks the submit button as destructive, e.g. for a force push. */
  danger?: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** Modal form shared by the fetch, pull and push dialogs: Enter submits, Escape and Cancel close. */
function Dialog({ id, title, submitLabel, danger, canSubmit, onSubmit, onClose, children }: DialogProps) {
  const formRef = useRef<HTMLFormElement>(null);

  // Start on the first field, so the keyboard works right away.
  useLayoutEffect(() => {
    formRef.current?.querySelector<HTMLElement>("select, input")?.focus();
  }, []);

  // Escape closes; focus returns to whatever opened the dialog.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit();
  }

  // Enter confirms from any field. Forms only do that by themselves from text inputs, and
  // these dialogs have selects and checkboxes; focused buttons keep their own Enter.
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter" || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (canSubmit) onSubmit();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        ref={formRef}
        className="modal remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        noValidate
      >
        <header className="modal-header">
          <h2 id={`${id}-title`}>{title}</h2>
        </header>
        <div className="settings-body">{children}</div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={danger ? "primary danger" : "primary"} disabled={!canSubmit}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}

interface FetchDialogProps {
  remotes: Remote[];
  /** The remote to preselect. */
  defaultRemote: string | null;
  onFetch: (options: FetchOptions) => void;
  onClose: () => void;
}

/** Choose what to fetch: one remote or all, with pruning and tags. */
export function FetchDialog({ remotes, defaultRemote, onFetch, onClose }: FetchDialogProps) {
  const [remote, setRemote] = useState(defaultRemote ?? remotes[0]?.name ?? ALL_REMOTES);
  const [options, setOptions] = useState<FetchPrefs>(prefs.fetch);
  const url = remotes.find((r) => r.name === remote)?.url;

  function submit() {
    prefs.saveFetch(options);
    onFetch({ remote: remote === ALL_REMOTES ? null : remote, ...options, background: false });
  }

  return (
    <Dialog id="fetch" title="Fetch" submitLabel="Fetch" canSubmit={remotes.length > 0} onSubmit={submit} onClose={onClose}>
      <label className="settings-label" htmlFor="fetch-remote">
        Remote
      </label>
      <div className="settings-row">
        <select id="fetch-remote" value={remote} onChange={(e) => setRemote(e.target.value)} aria-describedby="fetch-url">
          {remotes.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
          {remotes.length > 1 && <option value={ALL_REMOTES}>All remotes</option>}
        </select>
      </div>
      <p id="fetch-url" className="settings-hint mono selectable">
        {url ?? remotes.map((r) => r.name).join(", ")}
      </p>
      <div className="dialog-options">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.prune}
            onChange={(e) => setOptions({ ...options, prune: e.target.checked })}
          />
          Prune remote branches that no longer exist on the remote
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.tags}
            onChange={(e) => setOptions({ ...options, tags: e.target.checked })}
          />
          Fetch all tags
        </label>
      </div>
    </Dialog>
  );
}

interface PullDialogProps {
  /** The current branch, which is pulled into. */
  branch: string;
  status: Status;
  remotes: Remote[];
  /** Remote branches to pull from, preselected one first. */
  sources: string[];
  preferred: string | null;
  onPull: (options: PullOptions, source: string) => void;
  onClose: () => void;
}

/** Choose the remote branch to pull into the current branch, and whether to merge or rebase. */
export function PullDialog({ branch, status, remotes, sources, preferred, onPull, onClose }: PullDialogProps) {
  const [source, setSource] = useState(preferred ?? sources[0] ?? "");
  const [options, setOptions] = useState<PullPrefs>(prefs.pull);
  const target = splitRemoteBranch(source, remotes);
  const dirty = status.staged.length + status.unstaged.filter((f) => f.status !== "?").length > 0;

  function submit() {
    if (!target) return;
    prefs.savePull(options);
    onPull({ ...target, ...options }, source);
  }

  let hint: string;
  if (source && source === status.upstream) {
    // "2 behind and 1 ahead of origin/main", "2 behind origin/main", "1 ahead of origin/main"
    const ab = [status.behind && `${status.behind} behind`, status.ahead && `${status.ahead} ahead of`]
      .filter(Boolean)
      .join(" and ");
    hint = ab
      ? `${branch} is ${ab} ${source} as of the last fetch. Pulling fetches first.`
      : `${branch} was up to date with ${source} at the last fetch. Pulling fetches first.`;
  } else if (source) {
    hint = status.upstream
      ? `${source} is not the upstream of ${branch} (${status.upstream}).`
      : `${branch} has no upstream branch.`;
  } else {
    hint = "There are no remote branches. Fetch first.";
  }

  return (
    <Dialog id="pull" title="Pull" submitLabel="Pull" canSubmit={!!target} onSubmit={submit} onClose={onClose}>
      <label className="settings-label" htmlFor="pull-source">
        Pull from
      </label>
      <div className="settings-row">
        <select id="pull-source" value={source} onChange={(e) => setSource(e.target.value)} aria-describedby="pull-hint">
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <p className="settings-hint">
        into <strong className="mono">{branch}</strong>
      </p>
      <p id="pull-hint" className="settings-hint">
        {hint}
      </p>
      <div className="dialog-options">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.rebase}
            onChange={(e) => setOptions({ ...options, rebase: e.target.checked })}
          />
          Rebase instead of merge
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.autostash}
            onChange={(e) => setOptions({ ...options, autostash: e.target.checked })}
          />
          Stash and reapply local changes
        </label>
      </div>
      {dirty && !options.autostash && (
        <p className="settings-hint warning-text" role="note">
          You have uncommitted changes.{" "}
          {options.rebase
            ? "A rebase won't start until they are stashed or committed."
            : "The pull stops if it would overwrite them."}
        </p>
      )}
    </Dialog>
  );
}

interface PushDialogProps {
  branches: Branches;
  status: Status | null;
  /** The local branch to preselect, usually the current one. */
  branch: string;
  /** Where to push it; defaults to the branch's upstream. */
  target?: PushTarget;
  /** Start with force push checked, e.g. after a rejected push. */
  force?: boolean;
  onPush: (options: PushOptions) => void;
  onClose: () => void;
}

/** Choose a local branch and the remote branch to push it to, with tags, tracking and force. */
export function PushDialog({ branches, status, branch: initialBranch, target, force: initialForce = false, onPush, onClose }: PushDialogProps) {
  const [branch, setBranch] = useState(initialBranch);
  const initialTarget = target ?? defaultPushTarget(initialBranch, branches, status);
  const [remote, setRemote] = useState(initialTarget?.remote ?? branches.remotes[0]?.name ?? "");
  const [remoteBranch, setRemoteBranch] = useState(initialTarget?.remoteBranch ?? initialBranch);
  const [options, setOptions] = useState<PushPrefs>(prefs.push);
  const [force, setForce] = useState(initialForce);

  const local = branches.local.find((b) => b.name === branch);
  const name = remoteBranch.trim();
  const full = `${remote}/${name}`;
  const exists = branches.remote.some((b) => b.name === full);
  const isUpstream = !!local?.upstream && local.upstream === full;
  // Tracking is offered when it would change something; a branch without upstream gets it by default.
  const [setUpstream, setSetUpstream] = useState(!local?.upstream);
  const valid = !!remote && !!name && !name.startsWith("-") && !/[\s:]/.test(name);
  const remoteBranches = branches.remote
    .map((b) => splitRemoteBranch(b.name, branches.remotes))
    .filter((b) => b?.remote === remote)
    .map((b) => b!.branch);

  function chooseBranch(next: string) {
    setBranch(next);
    const t = defaultPushTarget(next, branches, status);
    if (t) {
      setRemote(t.remote);
      setRemoteBranch(t.remoteBranch);
    }
    setSetUpstream(!branches.local.find((b) => b.name === next)?.upstream);
  }

  function submit() {
    if (!valid) return;
    prefs.savePush(options);
    onPush({ branch, remote, remoteBranch: name, setUpstream: setUpstream && !isUpstream, tags: options.tags, force });
  }

  let hint: string;
  let behind = 0;
  if (!name) {
    hint = "Enter the name of the branch on the remote.";
  } else if (!exists) {
    hint = `Creates the branch ${full}.`;
  } else if (isUpstream) {
    const track = parseTrack(local.track);
    behind = track.behind;
    hint = track.ahead
      ? `Pushes ${track.ahead} ${track.ahead === 1 ? "commit" : "commits"} to ${full}.`
      : `${full} was up to date with ${branch} at the last fetch.`;
  } else {
    hint = local?.upstream ? `${full} is not the upstream of ${branch} (${local.upstream}).` : `Pushes to ${full}.`;
  }

  return (
    <Dialog
      id="push"
      title="Push"
      submitLabel={force ? "Force Push" : "Push"}
      danger={force}
      canSubmit={valid}
      onSubmit={submit}
      onClose={onClose}
    >
      <label className="settings-label" htmlFor="push-branch">
        Branch
      </label>
      <div className="settings-row">
        <select id="push-branch" value={branch} onChange={(e) => chooseBranch(e.target.value)}>
          {branches.local.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <span className="settings-label push-to-label" id="push-to">
        To
      </span>
      <div className="settings-row push-target" role="group" aria-labelledby="push-to">
        <select aria-label="Remote" value={remote} onChange={(e) => setRemote(e.target.value)}>
          {branches.remotes.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <span aria-hidden="true">/</span>
        <input
          aria-label="Remote branch"
          aria-describedby="push-hint"
          aria-invalid={!!name && !valid}
          list="push-remote-branches"
          value={remoteBranch}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setRemoteBranch(e.target.value)}
        />
        <datalist id="push-remote-branches">
          {remoteBranches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </div>
      <p id="push-hint" className="settings-hint">
        {hint}
      </p>
      <div className="dialog-options">
        <label className="checkbox">
          <input type="checkbox" checked={options.tags} onChange={(e) => setOptions({ tags: e.target.checked })} />
          Push all tags
        </label>
        {!isUpstream && (
          <label className="checkbox">
            <input type="checkbox" checked={setUpstream} onChange={(e) => setSetUpstream(e.target.checked)} />
            Track {name ? full : "the remote branch"} (set as upstream)
          </label>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Force push
        </label>
      </div>
      {force && exists && (
        <p className="settings-hint warning-text" role="note">
          Replaces {full} with {branch}: commits on {full} that {branch} doesn't have are removed from it. To protect
          other people's work, the push is refused if {full} has commits you haven't pulled.
        </p>
      )}
      {!force && behind > 0 && (
        <p className="settings-hint warning-text" role="note">
          {full} has {behind} {behind === 1 ? "commit" : "commits"} that {branch} doesn't have, so the push will be
          rejected. Pull first, or force push to overwrite {behind === 1 ? "it" : "them"}.
        </p>
      )}
    </Dialog>
  );
}
