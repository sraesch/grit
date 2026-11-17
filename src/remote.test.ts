import { describe, expect, it } from "vitest";
import { Branch, Branches, Operation, PullResult, PushResult } from "./api";
import {
  autoFetchDue,
  defaultFetchRemote,
  defaultPushTarget,
  fetchSummary,
  operationTitle,
  parseTrack,
  prefs,
  pullSources,
  pullSummary,
  pushSummary,
  splitRemoteBranch,
} from "./remote";
import { makeStatus } from "./test/tauri";

const remote = (name: string, url = `/srv/${name}.git`) => ({ name, url });
const branch = (name: string): Branch => ({ name, sha: "a", current: false, upstream: null, track: null });

describe("splitRemoteBranch", () => {
  it("splits at the remote, preferring the longest matching name", () => {
    const remotes = [remote("origin"), remote("team"), remote("team/ui")];
    expect(splitRemoteBranch("origin/feature/x", remotes)).toEqual({ remote: "origin", branch: "feature/x" });
    expect(splitRemoteBranch("team/ui/main", remotes)).toEqual({ remote: "team/ui", branch: "main" });
    expect(splitRemoteBranch("team/main", remotes)).toEqual({ remote: "team", branch: "main" });
  });

  it("returns null for unknown remotes and bare remote names", () => {
    expect(splitRemoteBranch("upstream/main", [remote("origin")])).toBeNull();
    expect(splitRemoteBranch("origin/", [remote("origin")])).toBeNull();
    expect(splitRemoteBranch("origin", [remote("origin")])).toBeNull();
  });
});

describe("defaultFetchRemote", () => {
  const remotes = [remote("fork"), remote("origin"), remote("upstream")];

  it("prefers the remote of the current branch's upstream", () => {
    expect(defaultFetchRemote(makeStatus({ upstream: "upstream/main" }), remotes)).toBe("upstream");
  });

  it("falls back to origin, then the first remote", () => {
    expect(defaultFetchRemote(makeStatus(), remotes)).toBe("origin");
    expect(defaultFetchRemote(null, [remote("fork"), remote("mirror")])).toBe("fork");
    expect(defaultFetchRemote(null, [])).toBeNull();
  });
});

describe("pullSources", () => {
  const branches = (remoteNames: string[]): Branches => ({
    local: [],
    remote: remoteNames.map(branch),
    tags: [],
    remotes: [remote("origin"), remote("upstream")],
  });

  it("preselects the upstream and lists it first", () => {
    const result = pullSources(
      branches(["origin/dev", "origin/main", "upstream/main"]),
      makeStatus({ branch: "main", upstream: "upstream/main" }),
    );
    expect(result).toEqual({ preferred: "upstream/main", sources: ["upstream/main", "origin/dev", "origin/main"] });
  });

  it("falls back to the branch of the same name on the default remote", () => {
    const result = pullSources(branches(["origin/dev", "upstream/feature", "origin/feature"]), makeStatus({ branch: "feature" }));
    expect(result.preferred).toBe("origin/feature");
    expect(result.sources[0]).toBe("origin/feature");
  });

  it("preselects nothing without a match or a branch", () => {
    expect(pullSources(branches(["origin/dev"]), makeStatus({ branch: "local-only" })).preferred).toBeNull();
    expect(pullSources(branches(["origin/dev"]), makeStatus({ branch: null })).preferred).toBeNull();
  });
});

describe("fetchSummary", () => {
  const empty = { newBranches: [], updatedBranches: [], deletedBranches: [], newTags: [] };

  it("counts what changed", () => {
    expect(
      fetchSummary(
        { newBranches: ["origin/a"], updatedBranches: ["origin/b", "origin/c"], deletedBranches: ["origin/d"], newTags: ["v1", "v2"] },
        "origin",
      ),
    ).toBe("Fetched origin: 1 new branch, 2 updated, 1 pruned, 2 new tags");
    expect(fetchSummary({ ...empty, newBranches: ["a", "b"], newTags: ["v1"] }, null)).toBe(
      "Fetched all remotes: 2 new branches, 1 new tag",
    );
  });

  it("says when nothing changed", () => {
    expect(fetchSummary(empty, "origin")).toBe("Fetched origin: everything is up to date");
  });
});

describe("pullSummary", () => {
  const result = (partial: Partial<PullResult>): PullResult => ({
    outcome: "fast-forward",
    incoming: 0,
    rebased: 0,
    conflicts: 0,
    ...partial,
  });

  it("describes successful pulls", () => {
    expect(pullSummary(result({ outcome: "up-to-date" }), "origin/main", "main")).toEqual({
      kind: "info",
      text: "main is already up to date with origin/main",
    });
    expect(pullSummary(result({ incoming: 1 }), "origin/main", "main").text).toBe("Pulled 1 commit from origin/main into main");
    expect(pullSummary(result({ outcome: "merge", incoming: 3 }), "origin/main", "main").text).toBe(
      "Merged 3 commits from origin/main into main",
    );
    expect(pullSummary(result({ outcome: "rebase", incoming: 2, rebased: 1 }), "origin/main", "main").text).toBe(
      "Rebased 1 commit of main onto origin/main (2 new)",
    );
  });

  it("warns about conflicts", () => {
    const conflicts = pullSummary(result({ outcome: "conflicts", conflicts: 2 }), "origin/main", "main");
    expect(conflicts.kind).toBe("warning");
    expect(conflicts.text).toContain("stopped with conflicts in 2 files");
    const stash = pullSummary(result({ outcome: "stash-conflicts", conflicts: 1 }), "origin/main", "main");
    expect(stash.kind).toBe("warning");
    expect(stash.text).toContain("kept in the stash");
  });
});

describe("autoFetchDue", () => {
  const now = 1_000_000;

  it("is due when nothing was fetched or tried within the interval", () => {
    expect(autoFetchDue(null, null, 10, now)).toBe(true);
    expect(autoFetchDue(now - 600, null, 10, now)).toBe(true);
    expect(autoFetchDue(now - 599, null, 10, now)).toBe(false);
    // A failed attempt also waits for the interval, so an offline machine isn't retried every minute.
    expect(autoFetchDue(now - 3600, now - 60, 10, now)).toBe(false);
  });

  it("is never due when turned off", () => {
    expect(autoFetchDue(null, null, 0, now)).toBe(false);
  });
});

describe("operationTitle", () => {
  const op = (partial: Partial<Operation>): Operation => ({
    kind: "merge",
    head: null,
    step: null,
    total: null,
    message: null,
    ...partial,
  });

  it("names the operation and the rebase progress", () => {
    expect(operationTitle(op({}))).toBe("Merge in progress");
    expect(operationTitle(op({ kind: "rebase", head: "main", step: 2, total: 3 }))).toBe("Rebasing main (commit 2 of 3)");
    expect(operationTitle(op({ kind: "rebase" }))).toBe("Rebasing");
    expect(operationTitle(op({ kind: "cherry-pick" }))).toBe("Cherry-pick in progress");
  });
});

describe("defaultPushTarget", () => {
  const branches: Branches = {
    local: [
      { ...branch("main"), upstream: "upstream/main" },
      { ...branch("team/x"), upstream: "team/ui/x" },
      branch("feature"),
    ],
    remote: [],
    tags: [],
    remotes: [remote("origin"), remote("upstream"), remote("team/ui")],
  };

  it("pushes to the upstream", () => {
    expect(defaultPushTarget("main", branches, null)).toEqual({ remote: "upstream", remoteBranch: "main" });
    expect(defaultPushTarget("team/x", branches, null)).toEqual({ remote: "team/ui", remoteBranch: "x" });
  });

  it("otherwise pushes to the same name on the default remote", () => {
    expect(defaultPushTarget("feature", branches, null)).toEqual({ remote: "origin", remoteBranch: "feature" });
    expect(defaultPushTarget("feature", { ...branches, remotes: [] }, null)).toBeNull();
  });
});

describe("parseTrack", () => {
  it("reads ahead, behind and gone", () => {
    expect(parseTrack("[ahead 3, behind 12]")).toEqual({ ahead: 3, behind: 12, gone: false });
    expect(parseTrack("[behind 1]")).toEqual({ ahead: 0, behind: 1, gone: false });
    expect(parseTrack("[gone]")).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(parseTrack(null)).toEqual({ ahead: 0, behind: 0, gone: false });
  });
});

describe("pushSummary", () => {
  const result = (partial: Partial<PushResult>): PushResult => ({
    outcome: "pushed",
    commits: 0,
    newTags: [],
    rejectedTags: [],
    ...partial,
  });
  const summary = (partial: Partial<PushResult>) => pushSummary(result(partial), "main", "origin/main");

  it("describes successful pushes", () => {
    expect(summary({ commits: 1 })).toEqual({ kind: "info", text: "Pushed 1 commit from main to origin/main" });
    expect(summary({ outcome: "up-to-date" }).text).toBe("origin/main is already up to date with main");
    expect(summary({ outcome: "new-branch", commits: 3, newTags: ["v1", "v2"] }).text).toBe(
      "Pushed main to the new branch origin/main, with 2 new tags",
    );
    expect(summary({ outcome: "forced", commits: 2 }).text).toBe("Force pushed main to origin/main");
  });

  it("warns about rejected pushes and tags", () => {
    expect(summary({ outcome: "rejected" })).toEqual({
      kind: "warning",
      text: "Push rejected: origin/main has commits that main doesn't have. Pull them first, or force push to overwrite them.",
    });
    expect(summary({ outcome: "stale" }).text).toMatch(/^Force push refused: origin\/main has commits you haven't pulled/);
    expect(summary({ commits: 1, newTags: ["v2"], rejectedTags: ["v1"] })).toEqual({
      kind: "warning",
      text: "Pushed 1 commit from main to origin/main, with 1 new tag. The remote already has a different tag v1, which was not pushed",
    });
    expect(summary({ outcome: "up-to-date", rejectedTags: ["a", "b"] }).text).toMatch(/different tags a, b, which were not pushed$/);
  });
});

describe("prefs", () => {
  it("remembers the dialog options and ignores broken values", () => {
    expect(prefs.pull()).toEqual({ rebase: false, autostash: true });
    prefs.savePull({ rebase: true, autostash: false });
    expect(prefs.pull()).toEqual({ rebase: true, autostash: false });

    localStorage.setItem("fetchOptions", JSON.stringify({ prune: "yes", tags: true }));
    expect(prefs.fetch()).toEqual({ prune: true, tags: true });
    localStorage.setItem("fetchOptions", "{broken");
    expect(prefs.fetch()).toEqual({ prune: true, tags: false });

    expect(prefs.push()).toEqual({ tags: false });
    prefs.savePush({ tags: true });
    expect(prefs.push()).toEqual({ tags: true });
  });
});
