import { describe, expect, it } from "vitest";
import { Branches } from "./api";
import { CommitMenuItem, commitMenu, pickSummary, resetPreviewText, resetPushedWarning } from "./commit";
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

const base = { branches, branch: "main", headSha: "c2", operationBlocked: null };

function item(items: ReturnType<typeof commitMenu>, action: string): CommitMenuItem {
  const found = items.find((i): i is CommitMenuItem => i !== "separator" && i.action === action);
  if (!found) throw new Error(`no ${action} item`);
  return found;
}

describe("commitMenu", () => {
  it("checks out what double-clicking would", () => {
    const head = makeCommit("c2", "Head", { refs: [{ name: "main", kind: "local", current: true }] });
    expect(item(commitMenu(head, { ...base, busy: null }), "checkout")).toMatchObject({
      label: "Check Out",
      blocked: "Already checked out",
    });

    const remote = makeCommit("c1", "Feature", { refs: [{ name: "origin/feature", kind: "remote", current: false }] });
    expect(item(commitMenu(remote, { ...base, busy: null }), "checkout")).toMatchObject({
      label: "Check Out feature",
      blocked: null,
      title: "Create feature tracking origin/feature and switch to it",
    });

    const plain = makeCommit("c0", "Old");
    expect(item(commitMenu(plain, { ...base, busy: null }), "checkout")).toMatchObject({
      label: "Check Out",
      blocked: null,
      title: expect.stringContaining("detached HEAD"),
    });
  });

  it("blocks changes while busy, but not copying", () => {
    const items = commitMenu(makeCommit("c0", "Old"), { ...base, busy: "Wait" });
    expect(item(items, "checkout").blocked).toBe("Wait");
    expect(item(items, "create-branch").blocked).toBe("Wait");
    expect(item(items, "cherry-pick").blocked).toBe("Wait");
    expect(item(items, "create-tag").blocked).toBe("Wait");
    expect(item(items, "copy-sha").blocked).toBeNull();
    expect(item(items, "copy-message").blocked).toBeNull();
  });
});

describe("cherry-pick", () => {
  const ctx = { ...base, busy: null };

  it("is offered for other commits unless an operation is in progress", () => {
    const head = makeCommit("c2", "Head", { refs: [{ name: "main", kind: "local", current: true }] });
    expect(item(commitMenu(head, ctx), "cherry-pick").blocked).toBe("This commit is checked out");
    const other = makeCommit("c0", "Other");
    expect(item(commitMenu(other, ctx), "cherry-pick").blocked).toBeNull();
    expect(item(commitMenu(other, { ...ctx, operationBlocked: "Finish the merge" }), "cherry-pick").blocked).toBe(
      "Finish the merge",
    );
  });

  it("summarizes the outcome", () => {
    expect(pickSummary("cherry-pick", { outcome: "committed", conflicts: 0 }, "abc1234", "main")).toEqual({
      kind: "info",
      text: "Cherry-picked abc1234 onto main.",
    });
    expect(pickSummary("cherry-pick", { outcome: "conflicts", conflicts: 2 }, "abc1234", "main").text).toContain(
      "conflicts in 2 files",
    );
    expect(
      pickSummary("cherry-pick", { outcome: "conflicts-no-commit", conflicts: 1 }, "abc1234", "main").text,
    ).toContain("then commit");
  });
});

describe("revert", () => {
  const ctx = { ...base, busy: null };

  it("is offered for any commit, HEAD too", () => {
    const head = makeCommit("c2", "Head", { refs: [{ name: "main", kind: "local", current: true }] });
    expect(item(commitMenu(head, ctx), "revert").blocked).toBeNull();
    expect(item(commitMenu(head, { ...ctx, operationBlocked: "Busy" }), "revert").blocked).toBe("Busy");
  });

  it("summarizes the outcome", () => {
    expect(pickSummary("revert", { outcome: "committed", conflicts: 0 }, "abc1234", "main").text).toBe(
      "Reverted abc1234 on main.",
    );
    expect(pickSummary("revert", { outcome: "conflicts", conflicts: 1 }, "abc1234", "main").text).toMatch(
      /^Reverting abc1234 stopped with conflicts in 1 file\./,
    );
  });
});

describe("reset", () => {
  const ctx = { ...base, busy: null };

  it("names the branch it moves", () => {
    expect(item(commitMenu(makeCommit("c0", "Old"), ctx), "reset")).toMatchObject({
      label: "Reset main to Here…",
      blocked: null,
    });
    expect(item(commitMenu(makeCommit("c0", "Old"), { ...ctx, branch: null }), "reset").label).toBe(
      "Reset HEAD to Here…",
    );
    const head = makeCommit("c2", "Head", { refs: [{ name: "main", kind: "local", current: true }] });
    expect(item(commitMenu(head, ctx), "reset").blocked).toBe("This commit is checked out");
  });

  it("describes what the branch loses and gains", () => {
    expect(resetPreviewText({ dropped: 2, droppedPushed: 0, added: 0 }, "main")).toBe(
      "2 commits will no longer be on main.",
    );
    expect(resetPreviewText({ dropped: 0, droppedPushed: 0, added: 1 }, "main")).toBe("main moves forward by 1 commit.");
    expect(resetPreviewText({ dropped: 1, droppedPushed: 0, added: 3 }, "main")).toBe(
      "1 commit will no longer be on main, and 3 commits it doesn't contain yet will be.",
    );
    expect(resetPushedWarning({ dropped: 2, droppedPushed: 0, added: 0 }, "main")).toBeNull();
    expect(resetPushedWarning({ dropped: 2, droppedPushed: 2, added: 0 }, "main")).toMatch(
      /^2 commits that were already pushed/,
    );
  });
});
