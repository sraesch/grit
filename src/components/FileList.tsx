import { FileChange } from "../api";
import { splitPath } from "../util";

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
}

export function FileList({ files, selectedPath, onSelect, onActivate, actionLabel, onAction }: FileListProps) {
  return (
    <ul className="file-list">
      {files.map((f) => {
        const { dir, name } = splitPath(f.path);
        return (
          <li
            key={f.path}
            className={f.path === selectedPath ? "selected" : undefined}
            onClick={() => onSelect(f)}
            onDoubleClick={() => onActivate?.(f)}
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          >
            <StatusBadge status={f.status} />
            <span className="file-name">{name}</span>
            <span className="file-dir">{dir}</span>
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
          </li>
        );
      })}
    </ul>
  );
}
