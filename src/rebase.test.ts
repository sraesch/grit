import { describe, expect, it } from "vitest";
import { Branch, Branches, RebaseResult } from "./api";
import { hasRebaseTargets, rebasePreview, rebaseSummary, rebaseTargets, rewritesPushedCommits } from "./rebase";
import { makeStatus } from "./test/tauri";

const branch = (name: string, partial: Partial<Branch> = {}): Branch => ({
  name,
  sha: "a",
  current: false,
  upstream: null,
  track: null,
  ...partial,
});

function makeBranches(local: string[], current: string, remote: string[] = [], tags: string[] = []): Branches {
  return {
    local: local.map((name) => branch(name, { current: name === current })),
    remote: remote.map((name) => branch(name)),
    tags: tags.map((name) => branch(name)),
    remotes: [{ name: "origin", url: "" }],
  };
}

describe("rebaseTargets", () => {
  it("lists everything but the current branch and prefers the base branch for a feature branch", () => {
    const branches = makeBranches(["feature", "main", "develop"], "feature", ["origin/feature", "origin/main"], ["v1"]);
    const status = makeStatus({ branch: "feature", upstream: "origin/feature" });
    expect(rebaseTargets(branches, status)).toEqual({
      local: ["main", "develop"],
      remote: ["origin/feature", "origin/main"],
      tags: ["v1"],
      preferred: "develop",
    });
  });

  it("prefers the upstream for a base branch", () => {
    const branches = makeBranches(["main", "develop"], "develop", ["origin/develop", "origin/main"]);
    const status = makeStatus({ branch: "develop", upstream: "origin/develop" });
    expect(rebaseTargets(branches, status).preferred).toBe("origin/develop");
    // Without an upstream, another base branch is next.
    expect(rebaseTargets(branches, makeStatus({ branch: "develop" })).preferred).toBe("main");
  });

  it("falls back to the upstream, then whatever there is", () => {
    const status = makeStatus({ branch: "feature", upstream: "origin/feature" });
    expect(rebaseTargets(makeBranches(["feature", "other"], "feature", ["origin/feature"]), status).preferred).toBe(
      "origin/feature",
    );
    const alone = makeBranches(["feature", "other"], "feature");
    expect(rebaseTargets(alone, makeStatus({ branch: "feature" })).preferred).toBe("other");
    const tagsOnly = makeBranches(["feature"], "feature", [], ["v1"]);
    expect(rebaseTargets(tagsOnly, makeStatus({ branch: "feature" })).preferred).toBe("v1");
  });

  it("has no targets in a repository with a single branch", () => {
    const targets = rebaseTargets(makeBranches(["main"], "main"), makeStatus());
    expect(targets.preferred).toBeNull();
    expect(hasRebaseTargets(targets)).toBe(false);
  });
});

describe("rebasePreview", () => {
  it("says what the rebase will do", () => {
    expect(rebasePreview({ ahead: 2, behind: 1 }, "feature", "main")).toBe(
      "Replays 2 commits of feature on top of main, which has 1 commit feature doesn't.",
    );
    expect(rebasePreview({ ahead: 0, behind: 3 }, "feature", "main")).toBe(
      "feature has no commits of its own, so it moves to main (3 commits ahead).",
    );
    expect(rebasePreview({ ahead: 2, behind: 0 }, "feature", "main")).toBe(
      "feature already contains everything on main. There is nothing to rebase.",
    );
  });
});

describe("rewritesPushedCommits", () => {
  it("warns when commits to replay are already on the upstream", () => {
    const pushed = makeStatus({ branch: "feature", upstream: "origin/feature", ahead: 1 });
    expect(rewritesPushedCommits({ ahead: 3, behind: 2 }, pushed)).toBe(true);
    // Only unpushed commits are replayed.
    expect(rewritesPushedCommits({ ahead: 1, behind: 2 }, pushed)).toBe(false);
    // Nothing is replayed when the branch is up to date.
    expect(rewritesPushedCommits({ ahead: 3, behind: 0 }, pushed)).toBe(false);
    expect(rewritesPushedCommits({ ahead: 3, behind: 2 }, makeStatus({ branch: "feature" }))).toBe(false);
  });
});

describe("rebaseSummary", () => {
  const result = (partial: Partial<RebaseResult>): RebaseResult => ({
    outcome: "rebase",
    incoming: 0,
    rebased: 0,
    conflicts: 0,
    ...partial,
  });
  const text = (r: Partial<RebaseResult>) => rebaseSummary(result(r), "main", "feature");

  it("reports successful rebases", () => {
    expect(text({ outcome: "up-to-date" })).toEqual({ kind: "info", text: "feature already contains everything on main" });
    expect(text({ outcome: "fast-forward", incoming: 1 }).text).toBe("Moved feature forward to main (1 commit)");
    expect(text({ rebased: 2, incoming: 3 }).text).toBe("Rebased 2 commits of feature onto main (3 new)");
    expect(text({ rebased: 0, incoming: 3 }).text).toBe("feature now matches main: its commits were already there");
  });

  it("warns when the rebase stopped", () => {
    expect(text({ outcome: "conflicts", conflicts: 2 })).toEqual({
      kind: "warning",
      text: "Rebasing feature onto main stopped with conflicts in 2 files. Resolve them in Local changes.",
    });
    expect(text({ outcome: "conflicts" }).text).toBe("Rebasing feature onto main stopped. Continue or abort it from the banner.");
    expect(text({ outcome: "stash-conflicts", conflicts: 1 }).text).toMatch(/conflict with it in 1 file\. .*kept in the stash/);
  });
});
