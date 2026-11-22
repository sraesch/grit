import { useState } from "react";
import { IgnoreTarget, ignoreOptions } from "../gitignore";
import { Dialog } from "./RemoteDialogs";

interface IgnoreDialogProps {
  target: IgnoreTarget;
  onIgnore: (pattern: string) => void;
  onClose: () => void;
}

/** Chooses how widely to ignore an untracked file or folder, and adds the pattern to the root .gitignore. */
export function IgnoreDialog({ target, onIgnore, onClose }: IgnoreDialogProps) {
  const options = ignoreOptions(target);
  const [pattern, setPattern] = useState(options[0].pattern);
  const valid = pattern.trim().length > 0;

  return (
    <Dialog
      id="ignore"
      title={target.kind === "folder" ? "Ignore Folder" : "Ignore File"}
      submitLabel="Ignore"
      canSubmit={valid}
      onSubmit={() => onIgnore(pattern)}
      onClose={onClose}
    >
      <p className="settings-hint">
        Add a pattern to <span className="mono">.gitignore</span> in the repository root for{" "}
        <strong className="mono">{target.path}</strong>
      </p>
      <div className="dialog-options" role="radiogroup" aria-label="What to ignore">
        {options.map((o) => (
          <label key={o.pattern} className="checkbox">
            <input
              type="radio"
              name="ignore-scope"
              checked={pattern === o.pattern}
              onChange={() => setPattern(o.pattern)}
            />
            {o.label}
            <span className="mono ignore-pattern">{o.pattern}</span>
          </label>
        ))}
      </div>
      <label className="settings-label ignore-pattern-label" htmlFor="ignore-pattern">
        Pattern
      </label>
      <div className="settings-row">
        <input
          id="ignore-pattern"
          className="mono"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          aria-invalid={!valid}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </Dialog>
  );
}
