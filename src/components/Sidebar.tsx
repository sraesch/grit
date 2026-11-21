import { MouseEvent, useCallback, useState } from "react";
import { Branch, Branches } from "../api";
import { SwitchTarget, targetForRemote } from "../branches";
import { formatTrack } from "../util";
import { ContextMenu } from "./ContextMenu";

export type View = "changes" | "history";

interface SidebarProps {
  view: View;
  onView: (v: View) => void;
  changeCount: number;
  branches: Branches | null;
  onSwitch: (target: SwitchTarget) => void;
  /** Asks to delete a local branch; the owner confirms. */
  onDelete: (branch: Branch) => void;
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

export function Sidebar({ view, onView, changeCount, branches, onSwitch, onDelete }: SidebarProps) {
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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
        </div>
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
