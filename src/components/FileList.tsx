import { ReactNode, useMemo, useState } from "react";
import { FileChange } from "../api";
import { buildFileTree, filesIn, TreeNode } from "../fileTree";
import { Chevron } from "./Chevron";

const INDENT = 14;

const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  T: "Type changed",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflict",
  "?": "Untracked",
};

/** `title` replaces the status name in the tooltip, e.g. to say what kind of conflict it is. */
export function StatusBadge({ status, title }: { status: string; title?: string }) {
  const letter = status === "?" ? "+" : status;
  return (
    <span
      className={`status-badge status-${status === "?" ? "untracked" : status}`}
      title={title ?? STATUS_LABEL[status]}
    >
      {letter}
    </span>
  );
}

/** A button shown on hovered rows, e.g. "Stage". */
export interface RowAction {
  label: string;
  /** Marks a destructive action. */
  danger?: boolean;
  onFile: (file: FileChange) => void;
  /** Runs the action on every file in a folder; without it, folder rows don't show the action. */
  onFolder?: (files: FileChange[]) => void;
  /** Tooltip on a file row. */
  fileTitle?: (file: FileChange) => string | undefined;
  /** Tooltip on a folder row, instead of "<label> 3 files in <folder>". */
  folderTitle?: (files: FileChange[], path: string) => string;
}

/** What a row's context menu is about: one file, or every file in a folder. */
export type RowTarget = { kind: "file"; file: FileChange } | { kind: "folder"; path: string; files: FileChange[] };

interface FileListProps {
  files: FileChange[];
  selectedPath: string | null;
  onSelect: (file: FileChange) => void;
  onActivate?: (file: FileChange) => void;
  actions?: RowAction[];
  /** Right-click on a row, at viewport coordinates. */
  onContextMenu?: (target: RowTarget, x: number, y: number) => void;
  /** Tooltip of a file's status badge, instead of the status name. */
  badgeTitle?: (file: FileChange) => string | undefined;
}

export function FileList({
  files,
  selectedPath,
  onSelect,
  onActivate,
  actions = [],
  onContextMenu,
  badgeTitle,
}: FileListProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const rows: ReactNode[] = [];
  const addRows = (nodes: TreeNode[], depth: number) => {
    const indent = { paddingLeft: 10 + depth * INDENT } as const;
    for (const node of nodes) {
      if (node.kind === "dir") {
        const open = !collapsed.has(node.path);
        rows.push(
          <li
            key={node.path}
            className="dir-row"
            style={indent}
            aria-expanded={open}
            onClick={() => toggle(node.path)}
            onContextMenu={
              onContextMenu &&
              ((e) => {
                e.preventDefault();
                onContextMenu({ kind: "folder", path: node.path, files: filesIn(node) }, e.clientX, e.clientY);
              })
            }
            title={node.path}
          >
            <Chevron open={open} />
            <span className="file-name">{node.name}</span>
            {!open && <span className="dir-count">{node.fileCount}</span>}
            {actions.map(
              ({ label, danger, onFolder, folderTitle }) =>
                onFolder && (
                  <button
                    key={label}
                    className={danger ? "row-action danger" : "row-action"}
                    title={
                      folderTitle?.(filesIn(node), node.path) ??
                      `${label} ${node.fileCount} file${node.fileCount === 1 ? "" : "s"} in ${node.path}`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onFolder(filesIn(node));
                    }}
                  >
                    {label}
                  </button>
                ),
            )}
          </li>,
        );
        if (open) addRows(node.children, depth + 1);
      } else {
        const f = node.file;
        rows.push(
          <li
            key={f.path}
            className={f.path === selectedPath ? "selected" : undefined}
            style={indent}
            onClick={() => onSelect(f)}
            onDoubleClick={() => onActivate?.(f)}
            onContextMenu={
              onContextMenu &&
              ((e) => {
                e.preventDefault();
                onContextMenu({ kind: "file", file: f }, e.clientX, e.clientY);
              })
            }
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          >
            <span className="chevron-spacer" />
            <StatusBadge status={f.status} title={badgeTitle?.(f)} />
            <span className="file-name">{node.name}</span>
            {actions.map(({ label, danger, onFile, fileTitle }) => (
              <button
                key={label}
                className={danger ? "row-action danger" : "row-action"}
                title={fileTitle?.(f)}
                onClick={(e) => {
                  e.stopPropagation();
                  onFile(f);
                }}
                // Keep a quick double-click on the button from also activating the row.
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {label}
              </button>
            ))}
          </li>,
        );
      }
    }
  };
  addRows(tree, 0);

  return <ul className="file-list">{rows}</ul>;
}
