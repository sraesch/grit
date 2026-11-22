import { MouseEvent, useCallback, useState } from "react";
import { Branch, Branches, Remote, Stash } from "../api";
import { SwitchTarget, targetForRemote } from "../branches";
import { groupRemoteBranches } from "../remote";
import { formatTrack, fullDate, relativeTime } from "../util";
import { ContextMenu, MenuItem } from "./ContextMenu";

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
  /** Asks for a new remote. */
  onAddRemote: () => void;
  onFetchRemote: (remote: Remote) => void;
  /** Asks for a remote's new URL, or its new name. */
  onEditRemote: (remote: Remote, field: "url" | "name") => void;
  /** Asks to remove a remote; the owner confirms. */
  onRemoveRemote: (remote: Remote) => void;
  /** Asks to merge a branch, e.g. "origin/feature", into the current branch. */
  onMerge: (name: string) => void;
  /** Why nothing can be merged into the current branch right now; null when it can. */
  mergeBlocked: string | null;
  onCopyName: (name: string) => void;
  /** Asks to delete a remote branch on its remote; the owner confirms. */
  onDeleteRemoteBranch: (branch: Branch) => void;
}

interface RemotesGroupProps {
  branches: Branches;
  onActivate: (b: Branch) => void;
  onAdd: () => void;
  onBranchMenu: (b: Branch, e: MouseEvent) => void;
  /** Right-click on the group's title. */
  onGroupMenu: (e: MouseEvent) => void;
  onRemoteMenu: (remote: Remote, e: MouseEvent) => void;
}

/** The remotes, each with its remote branches; right-click a remote to fetch, edit or remove it. */
function RemotesGroup({ branches, onActivate, onAdd, onBranchMenu, onGroupMenu, onRemoteMenu }: RemotesGroupProps) {
  const [open, setOpen] = useState(false);
  // Remotes are expanded unless collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = groupRemoteBranches(branches.remote, branches.remotes);
  const toggle = (remote: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(remote)) next.add(remote);
      return next;
    });

  return (
    <div className="branch-group">
      <div
        className="group-header"
        onContextMenu={(e) => {
          e.preventDefault();
          onGroupMenu(e);
        }}
      >
        <button className="group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`chevron${open ? " open" : ""}`}>▸</span>
          Remotes
          <span className="count">{groups.length}</span>
        </button>
        <button className="group-add" aria-label="Add Remote…" title="Add Remote…" onClick={onAdd}>
          +
        </button>
      </div>
      {open && (
        <ul>
          {groups.map(({ remote, url, branches: items }) => {
            const expanded = !collapsed.has(remote);
            const known = url !== null ? { name: remote, url } : null;
            return (
              <li key={remote} className="remote-group">
                <button
                  className="remote-row"
                  aria-expanded={expanded}
                  title={url ?? "This remote no longer exists"}
                  onClick={() => toggle(remote)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (known) onRemoteMenu(known, e);
                  }}
                >
                  <span className={`chevron${expanded ? " open" : ""}`} aria-hidden="true">
                    ▸
                  </span>
                  <span className="branch-name">{remote}</span>
                </button>
                {expanded && (
                  <ul aria-label={`Branches on ${remote}`}>
                    {items.length === 0 && <li className="empty-remote">No branches fetched</li>}
                    {items.map(({ branch: b, shortName }) => (
                      <li
                        key={b.name}
                        onDoubleClick={() => onActivate(b)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onBranchMenu(b, e);
                        }}
                        title={`${b.name}\nDouble-click to switch to a local branch tracking this one`}
                      >
                        <span className="branch-name">{shortName}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
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
  onAddRemote,
  onFetchRemote,
  onEditRemote,
  onRemoveRemote,
  onMerge,
  mergeBlocked,
  onCopyName,
  onDeleteRemoteBranch,
}: SidebarProps) {
  const [remoteBranchMenu, setRemoteBranchMenu] = useState<{ branch: Branch; x: number; y: number } | null>(null);
  const closeRemoteBranchMenu = useCallback(() => setRemoteBranchMenu(null), []);
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number } | null>(null);
  // A remote's menu, or with no remote the Remotes group's.
  const [remoteMenu, setRemoteMenu] = useState<{ remote: Remote | null; x: number; y: number } | null>(null);
  const closeRemoteMenu = useCallback(() => setRemoteMenu(null), []);
  const [stashMenu, setStashMenu] = useState<{ stash: Stash; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeStashMenu = useCallback(() => setStashMenu(null), []);

  /** Whether the current branch is the local branch a remote branch would switch to. */
  function checkedOut(b: Branch): boolean {
    if (!branches) return false;
    const target = targetForRemote(branches, b);
    return target.kind === "local" && branches.local.some((l) => l.name === target.name && l.current);
  }

  function remoteBranchMenuItems(b: Branch): MenuItem[] {
    const current = branches?.local.find((l) => l.current)?.name;
    const isCurrent = checkedOut(b);
    return [
      {
        label: "Checkout",
        disabled: isCurrent,
        title: isCurrent ? "The current branch tracks this one" : "Switch to a local branch tracking this one",
        onSelect: () => branches && onSwitch(targetForRemote(branches, b)),
      },
      {
        label: current ? `Merge into ${current}…` : "Merge into Current Branch…",
        disabled: !!mergeBlocked,
        title: mergeBlocked ?? undefined,
        onSelect: () => onMerge(b.name),
      },
      { label: "Copy Name", onSelect: () => onCopyName(b.name) },
      { label: "Delete Remote Branch…", danger: true, onSelect: () => onDeleteRemoteBranch(b) },
    ];
  }

  function remoteMenuItems(remote: Remote | null): MenuItem[] {
    if (!remote) return [{ label: "Add Remote…", onSelect: onAddRemote }];
    return [
      { label: "Fetch", onSelect: () => onFetchRemote(remote) },
      { label: "Edit URL…", onSelect: () => onEditRemote(remote, "url") },
      { label: "Rename…", onSelect: () => onEditRemote(remote, "name") },
      { label: "Remove…", danger: true, onSelect: () => onRemoveRemote(remote) },
      { label: "Add Remote…", onSelect: onAddRemote },
    ];
  }

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
          <RemotesGroup
            branches={branches}
            onActivate={(b) => {
              if (!checkedOut(b)) onSwitch(targetForRemote(branches, b));
            }}
            onBranchMenu={(branch, e) => setRemoteBranchMenu({ branch, x: e.clientX, y: e.clientY })}
            onAdd={onAddRemote}
            onGroupMenu={(e) => setRemoteMenu({ remote: null, x: e.clientX, y: e.clientY })}
            onRemoteMenu={(remote, e) => setRemoteMenu({ remote, x: e.clientX, y: e.clientY })}
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
      {remoteBranchMenu && (
        <ContextMenu
          x={remoteBranchMenu.x}
          y={remoteBranchMenu.y}
          label={`Remote branch ${remoteBranchMenu.branch.name}`}
          items={remoteBranchMenuItems(remoteBranchMenu.branch)}
          onClose={closeRemoteBranchMenu}
        />
      )}
      {remoteMenu && (
        <ContextMenu
          x={remoteMenu.x}
          y={remoteMenu.y}
          label={remoteMenu.remote ? `Remote ${remoteMenu.remote.name}` : "Remotes"}
          items={remoteMenuItems(remoteMenu.remote)}
          onClose={closeRemoteMenu}
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
