import { beforeEach, describe, expect, it } from "vitest";
import { RepoInfo } from "./api";
import { nextActive, readOpenTabs, saveOpenTabs, tabLabels } from "./tabs";

const repo = (root: string): RepoInfo => ({ root, gitDir: `${root}/.git`, name: root.split("/").pop()! });

describe("open tabs storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the tabs and the active one", () => {
    saveOpenTabs(["/a", "/b"], "/b");
    expect(readOpenTabs()).toEqual({ roots: ["/a", "/b"], active: "/b" });
    saveOpenTabs([], null);
    expect(readOpenTabs()).toEqual({ roots: [], active: null });
  });

  it("takes over the single repository remembered by older versions", () => {
    localStorage.setItem("lastRepo", "/old");
    expect(readOpenTabs()).toEqual({ roots: ["/old"], active: "/old" });
    saveOpenTabs(["/old"], "/old");
    expect(localStorage.getItem("lastRepo")).toBeNull();
  });

  it("ignores broken data", () => {
    localStorage.setItem("openRepos", "{oops");
    expect(readOpenTabs()).toEqual({ roots: [], active: null });
    localStorage.setItem("openRepos", JSON.stringify(["/a", 3, null]));
    expect(readOpenTabs().roots).toEqual(["/a"]);
  });
});

describe("tabLabels", () => {
  it("uses the name, adding the parent folder only for duplicates", () => {
    const labels = tabLabels([repo("/work/app"), repo("/home/me/app"), repo("/work/grit")]);
    expect([...labels.values()]).toEqual(["work/app", "me/app", "grit"]);
  });

  it("handles Windows paths", () => {
    const labels = tabLabels([
      { root: "C:\\code\\app", gitDir: "", name: "app" },
      { root: "D:\\src\\app", gitDir: "", name: "app" },
    ]);
    expect([...labels.values()]).toEqual(["code/app", "src/app"]);
  });
});

describe("nextActive", () => {
  const roots = ["/a", "/b", "/c"];

  it("keeps the active tab when another one closes", () => {
    expect(nextActive(roots, "/a", "/c")).toBe("/c");
  });

  it("moves to the right neighbor, or the left one at the end", () => {
    expect(nextActive(roots, "/b", "/b")).toBe("/c");
    expect(nextActive(roots, "/c", "/c")).toBe("/b");
    expect(nextActive(["/a"], "/a", "/a")).toBeNull();
  });
});
