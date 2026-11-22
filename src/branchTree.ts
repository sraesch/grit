export interface BranchFolder<T> {
  kind: "folder";
  /** Full path of the folder, e.g. "ftr/ui". */
  path: string;
  /** Last segment of the path, e.g. "ui". */
  name: string;
  children: BranchTreeNode<T>[];
  /** Number of branches below this folder. */
  count: number;
}

export interface BranchLeaf<T> {
  kind: "leaf";
  /** Last segment of the branch name, e.g. "gitignore" for "ftr/gitignore". */
  name: string;
  item: T;
}

export type BranchTreeNode<T> = BranchFolder<T> | BranchLeaf<T>;

/**
 * Nests branches by the slash-separated segments of their names: "ftr/gitignore" becomes the
 * branch "gitignore" in the folder "ftr". Folders come first, sorted by name; branches keep the
 * order they were given in.
 */
export function buildBranchTree<T>(items: T[], nameOf: (item: T) => string): BranchTreeNode<T>[] {
  const root: BranchFolder<T> = { kind: "folder", path: "", name: "", children: [], count: 0 };
  for (const item of items) {
    // Empty segments ("a//b", a trailing slash) don't make folders.
    const parts = nameOf(item).split("/").filter(Boolean);
    if (parts.length === 0) parts.push(nameOf(item));
    let folder = root;
    folder.count++;
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let next = folder.children.find((c): c is BranchFolder<T> => c.kind === "folder" && c.name === part);
      if (!next) {
        next = { kind: "folder", path, name: part, children: [], count: 0 };
        folder.children.push(next);
      }
      next.count++;
      folder = next;
    }
    folder.children.push({ kind: "leaf", name: parts[parts.length - 1], item });
  }
  return sortTree(root.children);
}

function sortTree<T>(nodes: BranchTreeNode<T>[]): BranchTreeNode<T>[] {
  const folders = nodes
    .filter((n): n is BranchFolder<T> => n.kind === "folder")
    .map((f) => ({ ...f, children: sortTree(f.children) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...nodes.filter((n) => n.kind === "leaf")];
}

