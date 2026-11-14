import { describe, expect, it } from "vitest";
import { MAX_LINES, parseDiff } from "./diff";

const SAMPLE = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@ header
 keep
-old
+new
 tail
@@ -10,2 +10,3 @@
 ten
+inserted
 eleven
\\ No newline at end of file
`;

describe("parseDiff", () => {
  it("skips file headers and numbers lines per hunk", () => {
    const { lines, binary, truncated } = parseDiff(SAMPLE);
    expect(binary).toBe(false);
    expect(truncated).toBe(false);
    expect(lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "ctx", "hunk", "ctx", "add", "ctx", "meta"]);

    expect(lines[1]).toMatchObject({ text: "keep", oldNo: 1, newNo: 1 });
    expect(lines[2]).toMatchObject({ text: "old", oldNo: 2 });
    expect(lines[2].newNo).toBeUndefined();
    expect(lines[3]).toMatchObject({ text: "new", newNo: 2 });
    expect(lines[4]).toMatchObject({ text: "tail", oldNo: 3, newNo: 3 });

    // Second hunk restarts numbering from its header.
    expect(lines[6]).toMatchObject({ text: "ten", oldNo: 10, newNo: 10 });
    expect(lines[7]).toMatchObject({ text: "inserted", newNo: 11 });
    expect(lines[8]).toMatchObject({ text: "eleven", oldNo: 11, newNo: 12 });
  });

  it("detects binary files", () => {
    const diff = "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n";
    const { lines, binary } = parseDiff(diff);
    expect(binary).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it("returns no lines for an empty diff", () => {
    expect(parseDiff("").lines).toHaveLength(0);
  });

  it("parses untracked-file diffs against /dev/null", () => {
    const diff = "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n";
    const { lines } = parseDiff(diff);
    expect(lines.filter((l) => l.kind === "add").map((l) => [l.text, l.newNo])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("truncates very large diffs", () => {
    const body = Array.from({ length: MAX_LINES + 50 }, (_, i) => `+line ${i}`).join("\n");
    const { lines, truncated } = parseDiff(`@@ -0,0 +1,${MAX_LINES + 50} @@\n${body}\n`);
    expect(truncated).toBe(true);
    expect(lines).toHaveLength(MAX_LINES);
  });
});
