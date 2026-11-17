import { useEffect, useState } from "react";
import { api, Divergence, errorMessage, RebaseOptions, Status } from "../api";
import { rebasePreview, RebaseTargets, rewritesPushedCommits } from "../rebase";
import { prefs, RebasePrefs } from "../remote";
import { Dialog } from "./RemoteDialogs";

interface RebaseDialogProps {
  repo: string;
  /** The current branch, which is rebased. */
  branch: string;
  status: Status;
  targets: RebaseTargets;
  onRebase: (options: RebaseOptions) => void;
  onClose: () => void;
}

type Preview = { state: "loading" } | { state: "ready"; divergence: Divergence } | { state: "error"; message: string };

/** Choose the branch or tag to rebase the current branch onto, with a preview of what happens. */
export function RebaseDialog({ repo, branch, status, targets, onRebase, onClose }: RebaseDialogProps) {
  const [onto, setOnto] = useState(targets.preferred ?? "");
  const [options, setOptions] = useState<RebasePrefs>(prefs.rebase);
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  const dirty = status.staged.length + status.unstaged.filter((f) => f.status !== "?").length > 0;

  useEffect(() => {
    if (!onto) return;
    let current = true;
    setPreview({ state: "loading" });
    api.divergence(repo, onto).then(
      (divergence) => current && setPreview({ state: "ready", divergence }),
      (e) => current && setPreview({ state: "error", message: errorMessage(e) }),
    );
    return () => {
      current = false;
    };
  }, [repo, onto]);

  function submit() {
    if (!onto) return;
    prefs.saveRebase(options);
    onRebase({ onto, ...options });
  }

  let hint: string;
  if (!onto) hint = "There are no other branches or tags to rebase onto.";
  else if (preview.state === "loading") hint = "Comparing…";
  else if (preview.state === "error") hint = preview.message;
  else hint = rebasePreview(preview.divergence, branch, onto);

  const groups: [string, string[]][] = [
    ["Branches", targets.local],
    ["Remote branches", targets.remote],
    ["Tags", targets.tags],
  ];

  return (
    <Dialog id="rebase" title="Rebase" submitLabel="Rebase" canSubmit={!!onto} onSubmit={submit} onClose={onClose}>
      <p className="settings-hint">
        Rebase <strong className="mono">{branch}</strong>
      </p>
      <label className="settings-label" htmlFor="rebase-onto">
        Onto
      </label>
      <div className="settings-row">
        <select id="rebase-onto" value={onto} onChange={(e) => setOnto(e.target.value)} aria-describedby="rebase-hint">
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
      <p id="rebase-hint" className="settings-hint">
        {hint}
      </p>
      <div className="dialog-options">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.autostash}
            onChange={(e) => setOptions({ ...options, autostash: e.target.checked })}
          />
          Stash and reapply local changes
        </label>
      </div>
      {preview.state === "ready" && rewritesPushedCommits(preview.divergence, status) && (
        <p className="settings-hint warning-text" role="note">
          Some of these commits are already on {status.upstream}. Rebasing rewrites them, so you'll have to force-push
          the branch afterwards.
        </p>
      )}
      {dirty && !options.autostash && (
        <p className="settings-hint warning-text" role="note">
          You have uncommitted changes. A rebase won't start until they are stashed or committed.
        </p>
      )}
    </Dialog>
  );
}
