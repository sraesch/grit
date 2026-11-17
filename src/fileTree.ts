import { FileChange } from "./api";

export interface DirNode {
  kind: "dir";
  /** Full path of the folder, with a trailing slash ("src/components/"). */
  path: string;
  /** Displayed name; chains of single-child folders are joined ("src/components"). */
  name: string;
  children: TreeNode[];
  /** Number of files below this folder. */
  fileCount: number;
}

export interface FileNode {
  kind: "file";
  name: string;
  file: FileChange;
}

export type TreeNode = DirNode | FileNode;

/**
 * Builds a folder tree from a flat list of changed files. Folders come before files and both are
 * sorted by name; a folder whose only child is another folder is merged with it, so deep paths
 * like `src/main/java/…` take a single row.
 */
export function buildFileTree(files: FileChange[]): TreeNode[] {
  const root: DirNode = {
    kind: "dir",
    path: "",
    name: "",
    children: [],
    fileCount: 0,
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    dir.fileCount++;
    for (const part of parts.slice(0, -1)) {
      const path = `${dir.path}${part}/`;
      let next = dir.children.find((c): c is DirNode => c.kind === "dir" && c.path === path);
      if (!next) {
        next = { kind: "dir", path, name: part, children: [], fileCount: 0 };
        dir.children.push(next);
      }
      next.fileCount++;
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts[parts.length - 1], file });
  }

  return finish(root.children);
}

function finish(nodes: TreeNode[]): TreeNode[] {
  const result = nodes.map((node) => {
    if (node.kind === "file") return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0].kind === "dir") {
      const only = dir.children[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: finish(dir.children) };
  });
  return result.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** All files below a folder, in tree order. */
export function filesIn(dir: DirNode): FileChange[] {
  return dir.children.flatMap((c) => (c.kind === "file" ? [c.file] : filesIn(c)));
}
