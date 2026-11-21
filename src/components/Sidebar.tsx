import { MouseEvent, useCallback, useState } from "react";
import { Branch, Branches, Stash } from "../api";
import { SwitchTarget, targetForRemote } from "../branches";
import { formatTrack, fullDate, relativeTime } from "../util";
import { ContextMenu } from "./ContextMenu";

export type View = "changes" | "history" | "stash";

interface SidebarProps {
  view: View;
  onView: (v: View) => void;
  changeCount: number;
  branches: Branches | null;
  onSwitch: (target: SwitchTarget) => void;
  /** Asks to delete a local branch; the owner confirms. */
  onDelete: (branch: Branch) => void;
  stashes: Stash[] | null;
  /** The stash shown in the stash view. */
  selectedStash: string | null;
  onSelectStash: (stash: Stash) => void;
  /** Why stashes can't be applied right now; null when they can. */
  applyBlocked: string | null;
  onApplyStash: (stash: Stash, pop: boolean) => void;
  /** Asks to delete a stash; the owner confirms. */
  onDropStash: (stash: Stash) => void;
}

interface StashGroupProps {
  stashes: Stash[];
  selected: string | null;
  onSelect: (stash: Stash) => void;
  onMenu: (stash: Stash, e: MouseEvent) => void;
}

/** The stashes, newest first; click one to see its changes, right-click to apply or delete it. */
function StashGroup({ stashes, selected, onSelect, onMenu }: StashGroupProps) {
  const [open, setOpen] = useState(true);
  return (
    <div className="branch-group">
      <button className="group-title" onClick={() => setOpen(!open)}>
        <span className={`chevron${open ? " open" : ""}`}>▸</span>
        Stashes
        <span className="count">{stashes.length}</span>
      </button>
      {open && (
        <ul>
          {stashes.map((s) => (
            <li
              key={s.sha}
              className={s.sha === selected ? "selected" : undefined}
              onClick={() => onSelect(s)}
              onContextMenu={(e) => onMenu(s, e)}
              title={`${s.message}\nstash@{${s.index}}${s.branch ? ` on ${s.branch}` : ""}, ${fullDate(s.time)}`}
            >
              <span className="branch-name">{s.message}</span>
              <span className="stash-time">{relativeTime(s.time)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BranchGroup({
  title,
  items,
  onActivate,
  activateHint,
  onMenu,
  defaultOpen = true,
}: {
  title: string;
  items: Branch[];
  onActivate?: (b: Branch) => void;
  activateHint?: string;
  /** Right-click on a branch. */
  onMenu?: (b: Branch, e: MouseEvent) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="branch-group">
      <button className="group-title" onClick={() => setOpen(!open)}>
        <span className={`chevron${open ? " open" : ""}`}>▸</span>
        {title}
        <span className="count">{items.length}</span>
      </button>
      {open && (
        <ul>
          {items.map((b) => (
            <li
              key={b.name}
              className={b.current ? "current" : undefined}
              onDoubleClick={() => onActivate?.(b)}
              onContextMenu={onMenu && ((e) => onMenu(b, e))}
              title={[
                [b.name, b.upstream && `→ ${b.upstream}`, b.track].filter(Boolean).join("  "),
                !b.current && activateHint,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <span className="branch-name">{b.name}</span>
              {b.track && <span className="track">{formatTrack(b.track)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sidebar({
  view,
  onView,
  changeCount,
  branches,
  onSwitch,
  onDelete,
  stashes,
  selectedStash,
  onSelectStash,
  applyBlocked,
  onApplyStash,
  onDropStash,
}: SidebarProps) {
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number } | null>(null);
  const [stashMenu, setStashMenu] = useState<{ stash: Stash; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeStashMenu = useCallback(() => setStashMenu(null), []);

  return (
    <nav className="sidebar">
      <div className="nav-items">
        <button className={view === "changes" ? "active" : undefined} onClick={() => onView("changes")}>
          Local changes
          {changeCount > 0 && <span className="count accent">{changeCount}</span>}
        </button>
        <button className={view === "history" ? "active" : undefined} onClick={() => onView("history")}>
          All commits
        </button>
      </div>
      {branches && (
        <div className="branch-tree">
          <BranchGroup
            title="Branches"
            items={branches.local}
            onActivate={(b) => !b.current && onSwitch({ kind: "local", name: b.name })}
            activateHint="Double-click to switch to this branch"
            onMenu={(branch, e) => {
              e.preventDefault();
              setMenu({ branch, x: e.clientX, y: e.clientY });
            }}
          />
          <BranchGroup
            title="Remotes"
            items={branches.remote}
            onActivate={(b) => {
              const target = targetForRemote(branches, b);
              const current = target.kind === "local" && branches.local.some((l) => l.name === target.name && l.current);
              if (!current) onSwitch(target);
            }}
            activateHint="Double-click to switch to a local branch tracking this one"
            defaultOpen={false}
          />
          <BranchGroup title="Tags" items={branches.tags} defaultOpen={false} />
          {stashes && stashes.length > 0 && (
            <StashGroup
              stashes={stashes}
              selected={view === "stash" ? selectedStash : null}
              onSelect={onSelectStash}
              onMenu={(stash, e) => {
                e.preventDefault();
                setStashMenu({ stash, x: e.clientX, y: e.clientY });
              }}
            />
          )}
        </div>
      )}
      {stashMenu && (
        <ContextMenu
          x={stashMenu.x}
          y={stashMenu.y}
          label={`Stash ${stashMenu.stash.message}`}
          items={[
            {
              label: "Apply Stash",
              disabled: !!applyBlocked,
              title: applyBlocked ?? undefined,
              onSelect: () => onApplyStash(stashMenu.stash, false),
            },
            {
              label: "Pop Stash",
              disabled: !!applyBlocked,
              title: applyBlocked ?? "Apply the changes and delete the stash",
              onSelect: () => onApplyStash(stashMenu.stash, true),
            },
            { label: "Delete Stash…", danger: true, onSelect: () => onDropStash(stashMenu.stash) },
          ]}
          onClose={closeStashMenu}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Branch ${menu.branch.name}`}
          items={[
            {
              label: "Checkout",
              disabled: menu.branch.current,
              title: menu.branch.current ? "This is the current branch" : undefined,
              onSelect: () => onSwitch({ kind: "local", name: menu.branch.name }),
            },
            {
              label: "Delete Branch…",
              danger: true,
              disabled: menu.branch.current,
              title: menu.branch.current ? "Switch to another branch before deleting this one" : undefined,
              onSelect: () => onDelete(menu.branch),
            },
          ]}
          onClose={closeMenu}
        />
      )}
    </nav>
  );
}
