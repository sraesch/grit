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
  remotes: [
    { name: "origin", url: "git@example.com:demo.git" },
    { name: "backup", url: "/srv/backup.git" },
  ],
};

/** A remote branch row, found by its full name in the tooltip. */
const remoteBranch = (name: string) => screen.getByTitle(new RegExp(`^${name}\\s`));

const stashes = [makeStash("s1", "half-done login"), makeStash("s2", "experiment", { index: 1 })];

function setup(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = {
    onView: vi.fn(),
    onSwitch: vi.fn(),
    onDelete: vi.fn(),
    onSelectStash: vi.fn(),
    onApplyStash: vi.fn(),
    onDropStash: vi.fn(),
    onAddRemote: vi.fn(),
    onFetchRemote: vi.fn(),
    onEditRemote: vi.fn(),
    onRemoveRemote: vi.fn(),
    onMerge: vi.fn(),
    onCopyName: vi.fn(),
    onDeleteRemoteBranch: vi.fn(),
  };
  render(
    <Sidebar
      view="changes"
      changeCount={3}
      branches={branches}
      stashes={stashes}
      selectedStash={null}
      applyBlocked={null}
      mergeBlocked={null}
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
    await userEvent.dblClick(remoteBranch("origin/main"));
    expect(onSwitch).not.toHaveBeenCalled();
    // A local branch with the same name exists: switch to it instead of creating another.
    await userEvent.dblClick(remoteBranch("origin/feature"));
    expect(onSwitch).toHaveBeenLastCalledWith({ kind: "local", name: "feature" });
    await userEvent.dblClick(remoteBranch("origin/new-work"));
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

  it("has no context menu for tags", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Tags/ }));
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("v1.0") });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("checks out, merges, copies and deletes a remote branch from its context menu", async () => {
    const { onSwitch, onMerge, onCopyName, onDeleteRemoteBranch } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Remotes/ }));
    const choose = async (item: string) => {
      await userEvent.pointer({ keys: "[MouseRight]", target: remoteBranch("origin/new-work") });
      const menu = screen.getByRole("menu", { name: "Remote branch origin/new-work" });
      await userEvent.click(within(menu).getByRole("menuitem", { name: item }));
    };
    await choose("Checkout");
    expect(onSwitch).toHaveBeenCalledWith({ kind: "remote", name: "origin/new-work", localName: "new-work" });
    await choose("Merge into main…");
    expect(onMerge).toHaveBeenCalledWith("origin/new-work");
    await choose("Copy Name");
    expect(onCopyName).toHaveBeenCalledWith("origin/new-work");
    await choose("Delete Remote Branch…");
    expect(onDeleteRemoteBranch).toHaveBeenCalledWith(branches.remote[2]);
  });

  it("doesn't check out the remote branch the current branch tracks, or merge when that's blocked", async () => {
    setup({ mergeBlocked: "Finish or abort the current operation first" });
    await userEvent.click(screen.getByRole("button", { name: /Remotes/ }));
    await userEvent.pointer({ keys: "[MouseRight]", target: remoteBranch("origin/main") });
    expect(screen.getByRole("menuitem", { name: "Checkout" })).toBeDisabled();
    const merge = screen.getByRole("menuitem", { name: "Merge into main…" });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("title", "Finish or abort the current operation first");
    expect(screen.getByRole("menuitem", { name: "Delete Remote Branch…" })).toBeEnabled();
  });

  it("lists remote branches under their remote, by their short name", async () => {
    setup();
    const group = screen.getByRole("button", { name: /Remotes/ });
    expect(group).toHaveTextContent("2");
    await userEvent.click(group);

    const origin = screen.getByRole("list", { name: "Branches on origin" });
    expect(within(origin).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["main", "feature", "new-work"]);
    expect(screen.getByRole("list", { name: "Branches on backup" })).toHaveTextContent("No branches fetched");
    const originRow = screen.getByRole("button", { name: "origin" });
    expect(originRow).toHaveAttribute("title", "git@example.com:demo.git");

    await userEvent.click(originRow);
    expect(originRow).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Branches on origin" })).not.toBeInTheDocument();
  });

  it("nests branches in collapsible folders by their path", async () => {
    const { onSwitch } = setup({
      branches: {
        ...branches,
        local: [
          ...branches.local,
          { name: "ftr/gitignore", sha: "d", current: false, upstream: null, track: null },
          { name: "ftr/ui/menu", sha: "e", current: false, upstream: null, track: null },
        ],
        remote: [...branches.remote, { name: "origin/ftr/gitignore", sha: "d", current: false, upstream: null, track: null }],
      },
    });
    const ftr = screen.getByRole("list", { name: "Branches in ftr" });
    expect(within(ftr).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["ui1menu", "menu", "gitignore"]);
    expect(screen.getByRole("button", { name: "ftr" })).toHaveAttribute("title", "ftr/");
    const folderIcon = () => screen.getByRole("button", { name: "ftr" }).querySelector(".folder-icon");
    expect(folderIcon()).toHaveAttribute("data-open", "true");

    await userEvent.dblClick(within(ftr).getByText("gitignore"));
    expect(onSwitch).toHaveBeenCalledWith({ kind: "local", name: "ftr/gitignore" });

    await userEvent.click(screen.getByRole("button", { name: "ftr" }));
    expect(screen.queryByRole("list", { name: "Branches in ftr" })).not.toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(folderIcon()).toHaveAttribute("data-open", "false");

    // Remote branches are nested by their name on the remote.
    await userEvent.click(screen.getByRole("button", { name: /Remotes/ }));
    const origin = screen.getByRole("list", { name: "Branches on origin" });
    const remoteFtr = within(origin).getByRole("list", { name: "Branches in ftr" });
    expect(within(remoteFtr).getByText("gitignore").closest("li")).toHaveAttribute("title", expect.stringMatching(/^origin\/ftr\/gitignore\n/));
  });

  it("fetches, edits, renames and removes a remote from its context menu", async () => {
    const { onFetchRemote, onEditRemote, onRemoveRemote, onAddRemote } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Remotes/ }));
    const origin = branches.remotes[0];
    const choose = async (item: string) => {
      await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "origin" }) });
      await userEvent.click(within(screen.getByRole("menu", { name: "Remote origin" })).getByRole("menuitem", { name: item }));
    };
    await choose("Fetch");
    expect(onFetchRemote).toHaveBeenCalledWith(origin);
    await choose("Edit URL…");
    expect(onEditRemote).toHaveBeenLastCalledWith(origin, "url");
    await choose("Rename…");
    expect(onEditRemote).toHaveBeenLastCalledWith(origin, "name");
    await choose("Remove…");
    expect(onRemoveRemote).toHaveBeenCalledWith(origin);
    await choose("Add Remote…");
    expect(onAddRemote).toHaveBeenCalledTimes(1);
  });

  it("adds a remote from the group's + button and its context menu", async () => {
    const { onAddRemote } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Add Remote…" }));
    expect(onAddRemote).toHaveBeenCalledTimes(1);
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Remotes/ }) });
    await userEvent.click(within(screen.getByRole("menu", { name: "Remotes" })).getByRole("menuitem", { name: "Add Remote…" }));
    expect(onAddRemote).toHaveBeenCalledTimes(2);
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
