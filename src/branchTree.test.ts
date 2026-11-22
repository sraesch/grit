import { describe, expect, it } from "vitest";
import { BranchTreeNode, buildBranchTree } from "./branchTree";

function shape(nodes: BranchTreeNode<string>[]): unknown[] {
  return nodes.map((n) => (n.kind === "leaf" ? n.name : { [`${n.name} (${n.count})`]: shape(n.children) }));
}

describe("buildBranchTree", () => {
  it("nests branches by their path, folders first and sorted, branches in the given order", () => {
    const tree = buildBranchTree(["main", "ftr/gitignore", "develop", "fix/crash", "ftr/ui/menu", "ftr/blame"], (n) => n);
    expect(shape(tree)).toEqual([
      { "fix (1)": ["crash"] },
      { "ftr (3)": [{ "ui (1)": ["menu"] }, "gitignore", "blame"] },
      "main",
      "develop",
    ]);
  });

  it("gives folders their full path and keeps the items", () => {
    const tree = buildBranchTree([{ id: 1, name: "a/b/c" }], (b) => b.name);
    const a = tree[0];
    if (a.kind !== "folder") throw new Error("expected a folder");
    const b = a.children[0];
    if (b.kind !== "folder") throw new Error("expected a folder");
    expect(b.path).toBe("a/b");
    expect(b.children[0]).toEqual({ kind: "leaf", name: "c", item: { id: 1, name: "a/b/c" } });
  });

  it("ignores empty segments", () => {
    expect(shape(buildBranchTree(["a//b", "c/"], (n) => n))).toEqual([{ "a (1)": ["b"] }, "c"]);
  });
});

