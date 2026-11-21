import { describe, expect, it } from "vitest";
import { Stash } from "./api";
import { stashableCounts, stashApplySummary } from "./stash";
import { file, makeStatus } from "./test/tauri";

const stash: Stash = { index: 0, sha: "abc", message: "wip", branch: "main", time: 0, untracked: false };

describe("stashableCounts", () => {
  it("counts each tracked file once and untracked files separately", () => {
    const status = makeStatus({
      staged: [file("a.txt"), file("b.txt", "A")],
      unstaged: [file("a.txt"), file("c.txt", "D"), file("new.txt", "?")],
    });
    expect(stashableCounts(status)).toEqual({ tracked: 3, untracked: 1 });
  });
});

describe("stashApplySummary", () => {
  it("says what happened", () => {
    expect(stashApplySummary({ outcome: "applied", conflicts: 0 }, stash, false)).toEqual({
      kind: "info",
      text: "Applied stash \u201cwip\u201d.",
    });
    expect(stashApplySummary({ outcome: "applied", conflicts: 0 }, stash, true).text).toBe(
      "Applied and deleted stash \u201cwip\u201d.",
    );
  });

  it("warns about conflicts and that the stash was kept", () => {
    const summary = stashApplySummary({ outcome: "conflicts", conflicts: 2 }, stash, true);
    expect(summary.kind).toBe("warning");
    expect(summary.text).toContain("conflicts in 2 files");
    expect(summary.text).toContain("the stash was kept");
  });
});
