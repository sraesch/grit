import { KeyboardEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Branches } from "../api";
import { SwitchOption, switchOptions, SwitchTarget, targetOf } from "../branches";
import { formatTrack } from "../util";

interface BranchSwitcherProps {
  branches: Branches;
  onSwitch: (target: SwitchTarget) => void;
  /** `refocus` is true when closed from the keyboard, so focus can return to the opener. */
  onClose: (refocus: boolean) => void;
  /** Clicks here don't count as outside clicks (the button that toggles the popover). */
  ignoreRef?: RefObject<HTMLElement | null>;
}

const HEADINGS: Record<SwitchOption["kind"], string> = {
  local: "Branches",
  remote: "Remote branches",
  create: "New branch",
};

/** Popover to filter branches and switch to one, or create a branch from the typed name. */
export function BranchSwitcher({ branches, onSwitch, onClose, ignoreRef }: BranchSwitcherProps) {
  const [filter, setFilter] = useState("");
  const options = useMemo(() => switchOptions(branches, filter), [branches, filter]);
  const selectable = (o: SwitchOption | undefined) => !!o && !o.current;
  const firstSelectable = options.findIndex(selectable);
  const [active, setActive] = useState(firstSelectable);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Typing changes the options: start again at the best match.
  useEffect(() => setActive(firstSelectable), [filter, firstSelectable]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  // Close when clicking anywhere outside the popover.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !ignoreRef?.current?.contains(target)) onClose(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, ignoreRef]);

  function move(step: 1 | -1) {
    if (firstSelectable < 0) return;
    let i = active;
    do {
      i = (i + step + options.length) % options.length;
    } while (!selectable(options[i]));
    setActive(i);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectable(options[active])) onSwitch(targetOf(options[active]));
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    }
  }

  return (
    <div ref={rootRef} className="branch-switcher" role="dialog" aria-label="Switch branch">
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="branch-switcher-list"
        aria-activedescendant={active >= 0 ? `branch-option-${active}` : undefined}
        aria-label="Branch name"
        placeholder="Switch to or create a branch…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
      <ul ref={listRef} id="branch-switcher-list" role="listbox" aria-label="Branches">
        {options.map((o, i) => (
          <OptionRow
            key={`${o.kind}:${o.name}`}
            option={o}
            index={i}
            heading={i === 0 || options[i - 1].kind !== o.kind ? HEADINGS[o.kind] : null}
            active={i === active}
            onHover={() => selectable(o) && setActive(i)}
            onPick={() => selectable(o) && onSwitch(targetOf(o))}
          />
        ))}
        {options.length === 0 && <li className="switcher-empty">No branches</li>}
      </ul>
      <div className="switcher-hint">↑↓ to choose · Enter to switch · Esc to close</div>
    </div>
  );
}

interface OptionRowProps {
  option: SwitchOption;
  index: number;
  heading: string | null;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}

function OptionRow({ option, index, heading, active, onHover, onPick }: OptionRowProps) {
  const classes = ["switcher-option", active && "active", option.current && "current"].filter(Boolean).join(" ");
  return (
    <>
      {heading && (
        <li role="presentation" className="switcher-heading">
          {heading}
        </li>
      )}
      <li
        id={`branch-option-${index}`}
        data-index={index}
        role="option"
        aria-selected={active}
        aria-disabled={option.current || undefined}
        className={classes}
        onMouseMove={onHover}
        // Keep focus in the input so typing continues to filter.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
      >
        {option.kind === "create" ? (
          <span className="branch-name">
            Create <strong>{option.name}</strong>
          </span>
        ) : (
          <span className="branch-name">{option.name}</span>
        )}
        {option.current && <span className="switcher-note">current</span>}
        {option.kind === "local" && option.track && <span className="track">{formatTrack(option.track)}</span>}
        {option.kind === "remote" && <span className="switcher-note">creates {option.localName}</span>}
        {option.kind === "create" && <span className="switcher-note">from HEAD</span>}
      </li>
    </>
  );
}
