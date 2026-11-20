import { useEffect, useState } from "react";
import { api, Divergence, errorMessage, MergeMode, MergeOptions, Status } from "../api";
import { MERGE_MODES, mergeBlocked, mergePrefs, mergePreview } from "../merge";
import { RebaseTargets } from "../rebase";
import { MergePrefs, prefs } from "../remote";
import { Dialog } from "./RemoteDialogs";

interface MergeDialogProps {
  repo: string;
  /** The current branch, which is merged into. */
  branch: string;
  status: Status;
  targets: RebaseTargets;
  onMerge: (options: MergeOptions) => void;
  onClose: () => void;
}

type Preview = { state: "loading" } | { state: "ready"; divergence: Divergence } | { state: "error"; message: string };

/** Choose the branch or tag to merge into the current branch and how, with a preview of what happens. */
export function MergeDialog({ repo, branch, status, targets, onMerge, onClose }: MergeDialogProps) {
  const [source, setSource] = useState(targets.preferred ?? "");
  const [options, setOptions] = useState<MergePrefs>(mergePrefs);
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  const dirty = status.staged.length + status.unstaged.filter((f) => f.status !== "?").length > 0;
  const squash = options.mode === "squash";
  const blocked = preview.state === "ready" && mergeBlocked(preview.divergence, options.mode);

  useEffect(() => {
    if (!source) return;
    let current = true;
    setPreview({ state: "loading" });
    api.divergence(repo, source).then(
      (divergence) => current && setPreview({ state: "ready", divergence }),
      (e) => current && setPreview({ state: "error", message: errorMessage(e) }),
    );
    return () => {
      current = false;
    };
  }, [repo, source]);

  function submit() {
    if (!source || blocked) return;
    prefs.saveMerge(options);
    onMerge({ source, mode: options.mode, autostash: options.autostash && !squash });
  }

  let hint: string;
  if (!source) hint = "There are no other branches or tags to merge.";
  else if (preview.state === "loading") hint = "Comparing…";
  else if (preview.state === "error") hint = preview.message;
  else hint = mergePreview(preview.divergence, branch, source, options.mode);

  const groups: [string, string[]][] = [
    ["Branches", targets.local],
    ["Remote branches", targets.remote],
    ["Tags", targets.tags],
  ];

  return (
    <Dialog
      id="merge"
      title="Merge"
      submitLabel={squash ? "Squash" : "Merge"}
      canSubmit={!!source && !blocked}
      onSubmit={submit}
      onClose={onClose}
    >
      <p className="settings-hint">
        Merge into <strong className="mono">{branch}</strong>
      </p>
      <label className="settings-label" htmlFor="merge-source">
        Branch
      </label>
      <div className="settings-row">
        <select
          id="merge-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-describedby="merge-hint"
        >
          {groups
            .filter(([, names]) => names.length > 0)
            .map(([label, names]) => (
              <optgroup key={label} label={label}>
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </div>
      <label className="settings-label" htmlFor="merge-mode">
        Options
      </label>
      <div className="settings-row">
        <select
          id="merge-mode"
          value={options.mode}
          onChange={(e) => setOptions({ ...options, mode: e.target.value as MergeMode })}
          aria-describedby="merge-hint"
        >
          {MERGE_MODES.map(({ mode, label }) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p id="merge-hint" className={blocked ? "settings-hint warning-text" : "settings-hint"}>
        {hint}
      </p>
      <div className="dialog-options">
        <label
          className="checkbox"
          title={squash ? "A squash merge leaves the changes uncommitted, so they can't be reapplied afterwards" : undefined}
        >
          <input
            type="checkbox"
            checked={options.autostash && !squash}
            disabled={squash}
            onChange={(e) => setOptions({ ...options, autostash: e.target.checked })}
          />
          Stash and reapply local changes
        </label>
      </div>
      {dirty && (squash || !options.autostash) && (
        <p className="settings-hint warning-text" role="note">
          You have uncommitted changes. git stops the merge if it would overwrite them; stash or commit them first to be
          safe.
        </p>
      )}
    </Dialog>
  );
}
