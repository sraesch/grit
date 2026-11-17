import { describe, expect, it } from "vitest";
import { file } from "./test/tauri";
import { buildFileTree, filesIn, TreeNode } from "./fileTree";

function shape(nodes: TreeNode[]): unknown[] {
  return nodes.map((n) => (n.kind === "file" ? n.name : { [n.name]: shape(n.children) }));
}

describe("buildFileTree", () => {
  it("nests files in folders, folders first, sorted by name", () => {
    const tree = buildFileTree([file("z.txt"), file("src/b.ts"), file("src/a.ts"), file("docs/x.md"), file("a.txt")]);
    expect(shape(tree)).toEqual([{ docs: ["x.md"] }, { src: ["a.ts", "b.ts"] }, "a.txt", "z.txt"]);
  });

  it("merges chains of single-child folders", () => {
    const tree = buildFileTree([
      file("src/main/java/App.java"),
      file("src/main/java/util/Io.java"),
      file("src/test/T.java"),
    ]);
    expect(shape(tree)).toEqual([
      {
        src: [{ "main/java": [{ util: ["Io.java"] }, "App.java"] }, { test: ["T.java"] }],
      },
    ]);
    const mainJava = (tree[0] as { children: TreeNode[] }).children[0];
    expect(mainJava).toMatchObject({
      kind: "dir",
      path: "src/main/java/",
      fileCount: 2,
    });
  });

  it("counts the files below each folder", () => {
    const [src] = buildFileTree([file("src/a.ts"), file("src/lib/b.ts"), file("src/lib/c.ts")]);
    expect(src).toMatchObject({ path: "src/", fileCount: 3 });
  });

  it("keeps the original file objects", () => {
    const f = file("a/b.rs", "R", "a/old.rs");
    const [dir] = buildFileTree([f]);
    expect(dir.kind === "dir" && dir.children[0]).toMatchObject({
      kind: "file",
      name: "b.rs",
      file: f,
    });
  });
});

describe("filesIn", () => {
  it("collects every file below a folder", () => {
    const [src] = buildFileTree([file("src/b.ts"), file("src/lib/a.ts"), file("c.txt")]);
    expect(src.kind === "dir" && filesIn(src).map((f) => f.path)).toEqual(["src/lib/a.ts", "src/b.ts"]);
  });
});
