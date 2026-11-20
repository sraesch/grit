import { beforeEach, describe, expect, it } from "vitest";
import { Branch, Branches, MergeResult } from "./api";
import { mergeBlocked, mergePrefs, mergePreview, mergeSummary, mergeTargets } from "./merge";
import { makeStatus } from "./test/tauri";

const branch = (name: string, partial: Partial<Branch> = {}): Branch => ({
  name,
  sha: "a",
  current: false,
  upstream: null,
  track: null,
  ...partial,
});

function makeBranches(local: string[], current: string, remote: string[] = [], previous: string | null = null): Branches {
  return {
    local: local.map((name) => branch(name, { current: name === current })),
    remote: remote.map((name) => branch(name)),
    tags: [branch("v1")],
    remotes: [{ name: "origin", url: "" }],
    previous,
  };
}

describe("mergeTargets", () => {
  it("prefers the branch checked out before, then the base branch, then the upstream", () => {
    const status = makeStatus({ branch: "develop", upstream: "origin/develop" });
    const remote = ["origin/develop", "origin/feature"];
    const all = ["develop", "main", "feature"];
    expect(mergeTargets(makeBranches(all, "develop", remote, "feature"), status)).toEqual({
      local: ["main", "feature"],
      remote,
      tags: ["v1"],
      preferred: "feature",
    });
    expect(mergeTargets(makeBranches(all, "develop", remote), status).preferred).toBe("main");
    // The previous branch must still be one of the targets.
    expect(mergeTargets(makeBranches(["develop", "feature"], "develop", remote, "develop"), status).preferred).toBe(
      "origin/develop",
    );
    expect(mergeTargets(makeBranches(["develop", "feature"], "develop"), makeStatus({ branch: "develop" })).preferred).toBe(
      "feature",
    );
  });
});

describe("mergePreview", () => {
  const d = (ahead: number, behind: number) => ({ ahead, behind });

  it("describes what each mode does", () => {
    expect(mergePreview(d(1, 0), "main", "feature", "ff")).toBe(
      "main already contains everything on feature. There is nothing to merge.",
    );
    expect(mergePreview(d(0, 2), "main", "feature", "ff")).toBe("Moves main forward to feature (2 commits).");
    expect(mergePreview(d(0, 1), "main", "feature", "ff-only")).toBe("Moves main forward to feature (1 commit).");
    expect(mergePreview(d(0, 2), "main", "feature", "no-ff")).toBe(
      "Creates a merge commit on main that brings in 2 commits from feature.",
    );
    expect(mergePreview(d(3, 2), "main", "feature", "ff")).toBe(
      "Creates a merge commit on main that brings in 2 commits from feature.",
    );
    expect(mergePreview(d(3, 2), "main", "feature", "squash")).toBe(
      "Stages the changes of 2 commits from feature on main, for you to review and commit as one.",
    );
    expect(mergePreview(d(1, 2), "main", "feature", "ff-only")).toBe(
      "main has 1 commit feature doesn't, so it can't fast-forward. Choose another option to merge.",
    );
  });

  it("blocks only a fast-forward-only merge of diverged branches", () => {
    expect(mergeBlocked(d(1, 2), "ff-only")).toBe(true);
    expect(mergeBlocked(d(0, 2), "ff-only")).toBe(false);
    expect(mergeBlocked(d(1, 0), "ff-only")).toBe(false);
    expect(mergeBlocked(d(1, 2), "ff")).toBe(false);
  });
});

describe("mergeSummary", () => {
  const result = (partial: Partial<MergeResult>): MergeResult => ({ outcome: "merge", incoming: 2, conflicts: 0, ...partial });

  it("summarizes each outcome", () => {
    const text = (r: Partial<MergeResult>) => mergeSummary(result(r), "feature", "main");
    expect(text({ outcome: "up-to-date", incoming: 0 })).toEqual({
      kind: "info",
      text: "main already contains everything on feature",
    });
    expect(text({ outcome: "fast-forward", incoming: 1 }).text).toBe("Moved main forward to feature (1 commit)");
    expect(text({})).toEqual({ kind: "info", text: "Merged feature into main (2 commits)" });
    expect(text({ outcome: "squash" }).text).toBe(
      "Staged the changes of 2 commits from feature. Review and commit them in Local changes.",
    );
    expect(text({ outcome: "conflicts", conflicts: 3 })).toEqual({
      kind: "warning",
      text: "Merging feature into main stopped with conflicts in 3 files. Resolve them in Local changes.",
    });
    expect(text({ outcome: "conflicts" }).text).toBe("Merging feature into main stopped. Commit or abort it from the banner.");
    expect(text({ outcome: "stash-conflicts", conflicts: 1 }).text).toMatch(
      /^Merged feature into main, but your local changes conflict with it in 1 file\./,
    );
  });
});

describe("mergePrefs", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to fast-forward with stashing and ignores unknown modes", () => {
    expect(mergePrefs()).toEqual({ mode: "ff", autostash: true });
    localStorage.setItem("mergeOptions", JSON.stringify({ mode: "squash", autostash: false }));
    expect(mergePrefs()).toEqual({ mode: "squash", autostash: false });
    localStorage.setItem("mergeOptions", JSON.stringify({ mode: "octopus", autostash: false }));
    expect(mergePrefs()).toEqual({ mode: "ff", autostash: false });
  });
});
