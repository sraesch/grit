import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branches } from "../api";
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

function setup() {
  const onView = vi.fn();
  const onSwitch = vi.fn();
  const onDelete = vi.fn();
  render(
    <Sidebar view="changes" onView={onView} changeCount={3} branches={branches} onSwitch={onSwitch} onDelete={onDelete} />,
  );
  return { onView, onSwitch, onDelete };
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

  it("collapses remotes and tags by default", async () => {
    setup();
    expect(screen.queryByText("v1.0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Tags/ }));
    expect(screen.getByText("v1.0")).toBeInTheDocument();
  });
});
