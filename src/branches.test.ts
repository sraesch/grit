import { describe, expect, it } from "vitest";
import { Branch, Branches, LogEntry } from "./api";
import { localNameOf, switchOptions, targetForCommit, targetForRemote, toBranchName } from "./branches";
import { makeCommit } from "./test/tauri";

const branch = (name: string, partial: Partial<Branch> = {}): Branch => ({
  name,
  sha: "a",
  current: false,
  upstream: null,
  track: null,
  ...partial,
});

const branches: Branches = {
  local: [
    branch("main", { current: true, upstream: "origin/main", track: "[behind 2]" }),
    branch("feature/login"),
    branch("renamed", { upstream: "origin/old-name" }),
  ],
  remote: [
    branch("origin/main"),
    branch("origin/feature/login"),
    branch("origin/old-name"),
    branch("origin/release/1.0"),
    branch("upstream/docs"),
  ],
  tags: [],
  remotes: [{ name: "origin", url: "git@example.com:demo.git" }],
};

describe("localNameOf", () => {
  it("drops the remote name", () => {
    expect(localNameOf("origin/feature/x")).toBe("feature/x");
    expect(localNameOf("plain")).toBe("plain");
  });
});

describe("toBranchName", () => {
  it("trims and turns spaces into dashes", () => {
    expect(toBranchName("  fix  the login bug ")).toBe("fix-the-login-bug");
  });
});

describe("targetForRemote", () => {
  it("prefers the local branch tracking it, then one with the same name", () => {
    expect(targetForRemote(branches, branch("origin/old-name"))).toEqual({ kind: "local", name: "renamed" });
    expect(targetForRemote(branches, branch("origin/feature/login"))).toEqual({ kind: "local", name: "feature/login" });
  });

  it("creates a tracking branch otherwise", () => {
    expect(targetForRemote(branches, branch("upstream/docs"))).toEqual({
      kind: "remote",
      name: "upstream/docs",
      localName: "docs",
    });
  });
});

describe("switchOptions", () => {
  const names = (filter: string) => switchOptions(branches, filter).map((o) => `${o.kind}:${o.name}`);

  it("lists local branches, then remote branches without a local branch", () => {
    expect(names("")).toEqual([
      "local:main",
      "local:feature/login",
      "local:renamed",
      "remote:origin/release/1.0",
      "remote:upstream/docs",
    ]);
    expect(switchOptions(branches, "")[0]).toMatchObject({ current: true, track: "[behind 2]" });
  });

  it("filters case-insensitively and offers to create a new branch", () => {
    expect(names("LOGIN")).toEqual(["local:feature/login", "create:LOGIN"]);
    expect(names("new idea")).toEqual(["create:new-idea"]);
  });

  it("does not offer names that already exist locally or on a remote", () => {
    expect(names("main")).toEqual(["local:main"]);
    expect(names("release/1.0")).toEqual(["remote:origin/release/1.0"]);
    expect(names("origin/release/1.0")).toEqual(["remote:origin/release/1.0"]);
  });
});

describe("targetForCommit", () => {
  const remote = (name: string) => ({ name, kind: "remote" as const, current: false });
  const at = (...refs: LogEntry["refs"]) => makeCommit("abc", "x", { refs });

  it("prefers a local branch pointing at the commit", () => {
    const entry = at(remote("origin/feature"), { name: "feature", kind: "local", current: false });
    expect(targetForCommit(entry, branches)).toEqual({ kind: "local", name: "feature" });
  });

  it("checks out the branch of a remote branch at the commit, creating it if needed", () => {
    // A local branch tracks it, under another name.
    expect(targetForCommit(at(remote("origin/old-name")), branches)).toEqual({ kind: "local", name: "renamed" });
    // No local branch yet.
    expect(targetForCommit(at(remote("origin/new-work")), branches)).toEqual({
      kind: "remote",
      name: "origin/new-work",
      localName: "new-work",
    });
    // Of several remote branches, one with a local branch wins.
    const both = at(remote("origin/new-work"), remote("origin/feature/login"));
    expect(targetForCommit(both, branches)).toEqual({ kind: "local", name: "feature/login" });
  });

  it("checks out other commits detached, even with tags on them", () => {
    expect(targetForCommit(at({ name: "v1.0", kind: "tag", current: false }), branches)).toEqual({
      kind: "commit",
      name: "abc",
    });
    expect(targetForCommit(at(), branches)).toEqual({ kind: "commit", name: "abc" });
    // Before the branches are loaded, remote branches can't be matched.
    expect(targetForCommit(at(remote("origin/new-work")), null)).toEqual({ kind: "commit", name: "abc" });
  });

  it("does nothing for what is checked out already", () => {
    expect(targetForCommit(at({ name: "main", kind: "local", current: true }), branches)).toBeNull();
    expect(targetForCommit(at({ name: "HEAD", kind: "head", current: true }), branches)).toBeNull();
    // origin/main may be ahead, but its branch main is the current one.
    expect(targetForCommit(at(remote("origin/main")), branches)).toBeNull();
  });
});
