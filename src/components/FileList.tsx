import { ReactNode, useMemo, useState } from "react";
import { FileChange } from "../api";
import { buildFileTree, filesIn, TreeNode } from "../fileTree";

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

export function StatusBadge({ status }: { status: string }) {
  const letter = status === "?" ? "+" : status;
  return (
    <span className={`status-badge status-${status === "?" ? "untracked" : status}`} title={STATUS_LABEL[status]}>
      {letter}
    </span>
  );
}

interface FileListProps {
  files: FileChange[];
  selectedPath: string | null;
  onSelect: (file: FileChange) => void;
  onActivate?: (file: FileChange) => void;
  actionLabel?: string;
  onAction?: (file: FileChange) => void;
  /** Runs the action on every file in a folder; shown on folder rows with the same label. */
  onFolderAction?: (files: FileChange[]) => void;
}

export function FileList({
  files,
  selectedPath,
  onSelect,
  onActivate,
  actionLabel,
  onAction,
  onFolderAction,
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
            title={node.path}
          >
            <span className={`chevron${open ? " open" : ""}`}>▸</span>
            <span className="file-name">{node.name}</span>
            {!open && <span className="dir-count">{node.fileCount}</span>}
            {onFolderAction && actionLabel && (
              <button
                className="row-action"
                title={`${actionLabel} ${node.fileCount} file${node.fileCount === 1 ? "" : "s"} in ${node.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFolderAction(filesIn(node));
                }}
              >
                {actionLabel}
              </button>
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
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          >
            <span className="chevron-spacer" />
            <StatusBadge status={f.status} />
            <span className="file-name">{node.name}</span>
            {onAction && actionLabel && (
              <button
                className="row-action"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction(f);
                }}
              >
                {actionLabel}
              </button>
            )}
          </li>,
        );
      }
    }
  };
  addRows(tree, 0);

  return <ul className="file-list">{rows}</ul>;
}
