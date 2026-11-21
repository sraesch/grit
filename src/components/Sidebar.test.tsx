import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branches } from "../api";
import { makeStash } from "../test/tauri";
import { Sidebar } from "./Sidebar";

const branches: Branches = {
  local: [
    { name: "main", sha: "a", current: true, upstream: "origin/main", track: "[ahead 1]" },
    { name: "feature", sha: "b", current: false, upstream: null, track: null },
  ],
  remote: [
    { name: "origin/main", sha: "a", current: false, upstream: null, track: null },
    { name: "origin/feature", sha: "b", current: false, upstream: null, track: null },
    { name: "origin/new-work", sha: "c", current: false, upstream: null, track: null },
  ],
  tags: [{ name: "v1.0", sha: "a", current: false, upstream: null, track: null }],
  remotes: [{ name: "origin", url: "git@example.com:demo.git" }],
};

const stashes = [makeStash("s1", "half-done login"), makeStash("s2", "experiment", { index: 1 })];

function setup(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = {
    onView: vi.fn(),
    onSwitch: vi.fn(),
    onDelete: vi.fn(),
    onSelectStash: vi.fn(),
    onApplyStash: vi.fn(),
    onDropStash: vi.fn(),
  };
  render(
    <Sidebar
      view="changes"
      changeCount={3}
      branches={branches}
      stashes={stashes}
      selectedStash={null}
      applyBlocked={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("Sidebar", () => {
  it("switches views and shows the change count", async () => {
    const { onView } = setup();
    expect(screen.getByRole("button", { name: /Local changes/ })).toHaveTextContent("3");
    await userEvent.click(screen.getByRole("button", { name: "All commits" }));
    expect(onView).toHaveBeenCalledWith("history");
  });

  it("marks the current branch and shows tracking info", () => {
    setup();
    const main = screen.getByText("main").closest("li")!;
    expect(main).toHaveClass("current");
    expect(main).toHaveTextContent("↑1");
  });

  it("switches to other branches on double-click only", async () => {
    const { onSwitch } = setup();
    await userEvent.dblClick(screen.getByText("main"));
    expect(onSwitch).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByText("feature"));
    expect(onSwitch).toHaveBeenCalledWith({ kind: "local", name: "feature" });
  });

  it("switches to remote branches through their local branch", async () => {
    const { onSwitch } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Remotes/ }));

    // origin/main is tracked by the current branch: nothing to do.
    await userEvent.dblClick(screen.getByText("origin/main"));
    expect(onSwitch).not.toHaveBeenCalled();
    // A local branch with the same name exists: switch to it instead of creating another.
    await userEvent.dblClick(screen.getByText("origin/feature"));
    expect(onSwitch).toHaveBeenLastCalledWith({ kind: "local", name: "feature" });
    await userEvent.dblClick(screen.getByText("origin/new-work"));
    expect(onSwitch).toHaveBeenLastCalledWith({ kind: "remote", name: "origin/new-work", localName: "new-work" });
  });

  it("deletes a local branch from its context menu", async () => {
    const { onDelete } = setup();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("feature") });
    const menu = screen.getByRole("menu", { name: "Branch feature" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete Branch…" }));

    expect(onDelete).toHaveBeenCalledWith(branches.local[1]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("checks out a local branch from its context menu", async () => {
    const { onSwitch } = setup();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("feature") });
    await userEvent.click(screen.getByRole("menuitem", { name: "Checkout" }));

    expect(onSwitch).toHaveBeenCalledWith({ kind: "local", name: "feature" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("doesn't offer to check out or delete the current branch, and closes the menu with Escape", async () => {
    const { onDelete } = setup();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("main") });
    expect(screen.getByRole("menuitem", { name: "Checkout" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete Branch…" })).toBeDisabled();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("has no context menu for remote branches and tags", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Remotes/ }));
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("origin/new-work") });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists stashes, shows one on click and applies, pops or deletes it from its context menu", async () => {
    const { onSelectStash, onApplyStash, onDropStash } = setup();
    expect(screen.getByRole("button", { name: /Stashes/ })).toHaveTextContent("2");
    await userEvent.click(screen.getByText("experiment"));
    expect(onSelectStash).toHaveBeenCalledWith(stashes[1]);

    const openMenu = () => userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("half-done login") });
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Apply Stash" }));
    expect(onApplyStash).toHaveBeenLastCalledWith(stashes[0], false);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Pop Stash" }));
    expect(onApplyStash).toHaveBeenLastCalledWith(stashes[0], true);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete Stash…" }));
    expect(onDropStash).toHaveBeenCalledWith(stashes[0]);
  });

  it("marks the shown stash and disables applying when it can't be applied", async () => {
    setup({ view: "stash", selectedStash: "s2", applyBlocked: "Resolve the conflicts first" });
    expect(screen.getByText("experiment").closest("li")).toHaveClass("selected");
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("experiment") });
    expect(screen.getByRole("menuitem", { name: "Apply Stash" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Pop Stash" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete Stash…" })).toBeEnabled();
  });

  it("hides the stash group without stashes", () => {
    setup({ stashes: [] });
    expect(screen.queryByRole("button", { name: /Stashes/ })).not.toBeInTheDocument();
  });

  it("collapses remotes and tags by default", async () => {
    setup();
    expect(screen.queryByText("v1.0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Tags/ }));
    expect(screen.getByText("v1.0")).toBeInTheDocument();
  });
});
