import { describe, expect, it } from "vitest";
import { Branch, Branches, ConflictKind } from "./api";
import {
  conflictKindLabel,
  conflictMenu,
  ConflictMenuItem,
  conflictSides,
  ConflictSides,
  GENERIC_SIDES,
  removedBy,
  resolveTitle,
  sideKeeps,
} from "./conflict";
import { conflictFile, makeOperation, makeStatus } from "./test/tauri";

const branch = (name: string, sha: string, upstream: string | null = null): Branch => ({
  name,
  sha,
  current: false,
  upstream,
  track: null,
});

const branches: Branches = {
  local: [branch("main", "aaaaaaa", "origin/main"), branch("feature", "bbbbbbb"), branch("backup", "bbbbbbb")],
  remote: [branch("origin/main", "ccccccc"), branch("origin/feature", "bbbbbbb")],
  tags: [branch("v1", "ddddddd")],
  remotes: [],
};

/** A full SHA that starts with `prefix`, as the backend reports commits. */
const sha = (prefix: string) => prefix.padEnd(40, "0");

const sides: ConflictSides = {
  ours: { name: "main", detail: "current branch" },
  theirs: { name: "feature", detail: "being merged" },
};

describe("conflictSides", () => {
  it("names the current branch and the branch being merged", () => {
    const status = makeStatus({
      operation: makeOperation("merge", { commit: sha("bbbbbbb"), message: "Merge branch 'backup' into main" }),
    });
    // The name the merge was started with wins over other branches at the same commit.
    expect(conflictSides(status, branches)).toEqual({
      ours: { name: "main", detail: "current branch" },
      theirs: { name: "backup", detail: "being merged" },
    });

    const renamed = makeStatus({ operation: makeOperation("merge", { commit: sha("bbbbbbb"), message: "Sync" }) });
    expect(conflictSides(renamed, branches).theirs.name).toBe("feature");
  });

  it("names the upstream for a pull", () => {
    const status = makeStatus({
      upstream: "origin/main",
      operation: makeOperation("merge", {
        commit: sha("ccccccc"),
        message: "Merge branch 'main' of example.com:repo",
      }),
    });
    expect(conflictSides(status, branches).theirs).toEqual({ name: "origin/main", detail: "being merged" });
  });

  it("falls back to the short commit when no branch points at it", () => {
    const status = makeStatus({
      operation: makeOperation("merge", { commit: sha("eeeeeee"), message: "Merge branch 'feature'" }),
    });
    expect(conflictSides(status, branches).theirs).toEqual({ name: "eeeeeee", detail: "being merged" });
    // Without loaded branches, too.
    expect(conflictSides(status, null).theirs.name).toBe("eeeeeee");
  });

  it("finds the squashed branch in the prepared message", () => {
    const message = `Squashed commit of the following:\n\ncommit ${sha("bbbbbbb")}\nAuthor: Ada\n\n    Feature`;
    const status = makeStatus({ operation: makeOperation("squash", { message }) });
    expect(conflictSides(status, branches).theirs).toEqual({ name: "feature", detail: "being squashed" });

    const unknown = makeStatus({ operation: makeOperation("squash", { message: "Squashed" }) });
    expect(conflictSides(unknown, branches).theirs).toEqual({ name: "incoming", detail: "changes being squashed" });
  });

  it("turns the sides around for a rebase", () => {
    const status = makeStatus({
      branch: null,
      operation: makeOperation("rebase", { head: "feature", onto: sha("aaaaaaa"), commit: sha("1234567") }),
    });
    expect(conflictSides(status, branches)).toEqual({
      ours: { name: "main", detail: "new base of feature" },
      theirs: { name: "feature", detail: "commit 1234567 being replayed" },
    });

    const ontoCommit = makeStatus({
      branch: null,
      operation: makeOperation("rebase", { onto: sha("9999999"), commit: sha("1234567") }),
    });
    expect(conflictSides(ontoCommit, branches)).toEqual({
      ours: { name: "9999999", detail: "new base" },
      theirs: { name: "1234567", detail: "commit 1234567 being replayed" },
    });
  });

  it("prefers the upstream of the rebased branch as the name of the new base", () => {
    const tracked: Branches = {
      ...branches,
      local: [branch("main", "ccccccc"), branch("feature", "bbbbbbb", "origin/main")],
    };
    const status = makeStatus({
      branch: null,
      operation: makeOperation("rebase", { head: "feature", onto: sha("ccccccc") }),
    });
    expect(conflictSides(status, tracked).ours.name).toBe("origin/main");
  });

  it("names the commit of a cherry-pick and of a revert", () => {
    const pick = makeStatus({ operation: makeOperation("cherry-pick", { commit: sha("1234567") }) });
    expect(conflictSides(pick, branches).theirs).toEqual({ name: "1234567", detail: "commit being cherry-picked" });

    const revert = makeStatus({ operation: makeOperation("revert", { commit: sha("1234567") }) });
    expect(conflictSides(revert, branches).theirs).toEqual({ name: "the revert", detail: "undoing 1234567" });
  });

  it("stays general without an operation", () => {
    // E.g. after applying a stash.
    expect(conflictSides(makeStatus(), branches)).toEqual({
      ours: { name: "main", detail: "current branch" },
      theirs: { name: "incoming", detail: "changes being applied" },
    });
    expect(conflictSides(makeStatus({ branch: null }), branches).ours).toEqual({
      name: "HEAD",
      detail: "checked-out commit",
    });
    expect(conflictSides(null, branches)).toBe(GENERIC_SIDES);
  });
});

describe("sideKeeps", () => {
  it("tells which side still has the file", () => {
    const table: [ConflictKind, boolean, boolean][] = [
      ["both-modified", true, true],
      ["both-added", true, true],
      ["both-deleted", false, false],
      ["deleted-by-us", false, true],
      ["deleted-by-them", true, false],
      ["added-by-us", true, false],
      ["added-by-them", false, true],
    ];
    for (const [kind, ours, theirs] of table) {
      expect([kind, sideKeeps(kind, "ours"), sideKeeps(kind, "theirs")]).toEqual([kind, ours, theirs]);
    }
    // Without a known kind nothing is announced as deleted.
    expect(sideKeeps(undefined, "theirs")).toBe(true);
  });

  it("lists the files a side removes", () => {
    const files = [conflictFile("a.txt"), conflictFile("b.txt", "deleted-by-them"), conflictFile("c.txt", "added-by-us")];
    expect(removedBy(files, "theirs").map((f) => f.path)).toEqual(["b.txt", "c.txt"]);
    expect(removedBy(files, "ours")).toEqual([]);
  });
});

describe("conflict texts", () => {
  it("describes what the sides did", () => {
    expect(conflictKindLabel("both-modified", sides)).toBe("Changed on both sides");
    expect(conflictKindLabel("deleted-by-us", sides)).toBe("Deleted in main, changed in feature");
    expect(conflictKindLabel("deleted-by-them", sides)).toBe("Changed in main, deleted in feature");
    expect(conflictKindLabel("added-by-them", sides)).toBe("Only in feature");
    expect(conflictKindLabel(undefined, sides)).toBe("Changed on both sides");
  });

  it("says who a side is and when taking it deletes the file", () => {
    expect(resolveTitle(conflictFile("a.txt"), "ours", sides)).toBe("Resolve with the version of main (current branch)");
    expect(resolveTitle(conflictFile("a.txt", "deleted-by-them"), "theirs", sides)).toBe(
      "feature (being merged) has no such file: resolving deletes it",
    );
  });
});

describe("conflictMenu", () => {
  const labels = (entries: ReturnType<typeof conflictMenu>) =>
    entries.map((e) => (e === "separator" ? "-" : e.label));

  it("names the sides for a file", () => {
    const entries = conflictMenu({ kind: "file", file: conflictFile("a.txt", "deleted-by-us") }, { sides });
    expect(labels(entries)).toEqual(["Use main (current branch)", "Use feature (being merged)", "-", "Mark Resolved"]);
    const items = entries.filter((e): e is ConflictMenuItem => e !== "separator");
    expect(items.map((i) => i.action)).toEqual(["use-ours", "use-theirs", "mark-resolved"]);
    expect(items[0].title).toBe("main (current branch) has no such file: resolving deletes it");
    expect(items.every((i) => i.blocked === null)).toBe(true);
  });

  it("asks before taking a side for a folder", () => {
    const files = [conflictFile("src/a.txt"), conflictFile("src/b.txt")];
    const entries = conflictMenu({ kind: "folder", path: "src", files }, { sides });
    expect(labels(entries)).toEqual(["Use main for Folder…", "Use feature for Folder…", "-", "Mark Folder Resolved"]);
    expect(entries[0]).toMatchObject({ title: "2 files" });
  });
});
