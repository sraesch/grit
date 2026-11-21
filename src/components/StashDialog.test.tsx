import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { file, makeStash, makeStatus } from "../test/tauri";
import { DropStashDialog, StashDialog } from "./StashDialog";

describe("StashDialog", () => {
  beforeEach(() => localStorage.clear());

  it("stashes with a message and remembers the options", async () => {
    const onStash = vi.fn();
    const status = makeStatus({ unstaged: [file("a.txt"), file("new.txt", "?")] });
    const { unmount } = render(<StashDialog status={status} onStash={onStash} onClose={() => {}} />);
    expect(screen.getByText(/Stashes 2 changed files on main/)).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "half-done login");
    await userEvent.click(screen.getByRole("checkbox", { name: "Keep staged changes" }));
    await userEvent.keyboard("{Enter}");
    expect(onStash).toHaveBeenCalledWith({ message: "half-done login", includeUntracked: true, keepIndex: true });

    unmount();
    render(<StashDialog status={status} onStash={onStash} onClose={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Keep staged changes" })).toBeChecked();
  });

  it("can't stash only untracked files without including them", async () => {
    const status = makeStatus({ unstaged: [file("new.txt", "?")] });
    render(<StashDialog status={status} onStash={() => {}} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Include untracked files (1)" }));
    expect(screen.getByRole("button", { name: "Stash" })).toBeDisabled();
    expect(screen.getByText(/Only untracked files changed/)).toBeInTheDocument();
  });
});

describe("DropStashDialog", () => {
  it("confirms before deleting", async () => {
    const onDrop = vi.fn();
    const stash = makeStash("s1", "experiment");
    render(<DropStashDialog stash={stash} onDrop={onDrop} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Delete Stash" })).toHaveTextContent("experiment");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDrop).toHaveBeenCalledWith(stash);
  });
});
