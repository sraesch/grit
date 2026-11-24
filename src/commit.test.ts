import { describe, expect, it } from "vitest";
import { Branches } from "./api";
import { CommitMenuItem, commitMenu } from "./commit";
import { makeCommit } from "./test/tauri";

const branches: Branches = {
  local: [{ name: "main", sha: "c2", current: true, upstream: "origin/main", track: null }],
  remote: [
    { name: "origin/main", sha: "c2", current: false, upstream: null, track: null },
    { name: "origin/feature", sha: "c1", current: false, upstream: null, track: null },
  ],
  tags: [],
  remotes: [{ name: "origin", url: "https://example.com/repo.git" }],
};

function item(items: ReturnType<typeof commitMenu>, action: string): CommitMenuItem {
  const found = items.find((i): i is CommitMenuItem => i !== "separator" && i.action === action);
  if (!found) throw new Error(`no ${action} item`);
  return found;
}

describe("commitMenu", () => {
  it("checks out what double-clicking would", () => {
    const head = makeCommit("c2", "Head", { refs: [{ name: "main", kind: "local", current: true }] });
    expect(item(commitMenu(head, { branches, busy: null }), "checkout")).toMatchObject({
      label: "Check Out",
      blocked: "Already checked out",
    });

    const remote = makeCommit("c1", "Feature", { refs: [{ name: "origin/feature", kind: "remote", current: false }] });
    expect(item(commitMenu(remote, { branches, busy: null }), "checkout")).toMatchObject({
      label: "Check Out feature",
      blocked: null,
      title: "Create feature tracking origin/feature and switch to it",
    });

    const plain = makeCommit("c0", "Old");
    expect(item(commitMenu(plain, { branches, busy: null }), "checkout")).toMatchObject({
      label: "Check Out",
      blocked: null,
      title: expect.stringContaining("detached HEAD"),
    });
  });

  it("blocks changes while busy, but not copying", () => {
    const items = commitMenu(makeCommit("c0", "Old"), { branches, busy: "Wait" });
    expect(item(items, "checkout").blocked).toBe("Wait");
    expect(item(items, "create-branch").blocked).toBe("Wait");
    expect(item(items, "copy-sha").blocked).toBeNull();
    expect(item(items, "copy-message").blocked).toBeNull();
  });
});
