import { useState } from "react";
import { Branch, Branches } from "../api";
import { formatTrack } from "../util";

export type View = "changes" | "history";

interface SidebarProps {
  view: View;
  onView: (v: View) => void;
  changeCount: number;
  branches: Branches | null;
  onCheckout: (branch: string) => void;
}

function BranchGroup({
  title,
  items,
  onActivate,
  defaultOpen = true,
}: {
  title: string;
  items: Branch[];
  onActivate?: (b: Branch) => void;
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
              title={[b.name, b.upstream && `→ ${b.upstream}`, b.track].filter(Boolean).join("  ")}
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

export function Sidebar({ view, onView, changeCount, branches, onCheckout }: SidebarProps) {
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
            onActivate={(b) => !b.current && onCheckout(b.name)}
          />
          <BranchGroup title="Remotes" items={branches.remote} defaultOpen={false} />
          <BranchGroup title="Tags" items={branches.tags} defaultOpen={false} />
        </div>
      )}
    </nav>
  );
}
