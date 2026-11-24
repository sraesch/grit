import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCommit } from "../test/tauri";
import { PickDialog } from "./CommitOpDialog";

describe("PickDialog", () => {
  beforeEach(() => localStorage.clear());

  it("names the commit and branch, and remembers whether to commit", async () => {
    const onPick = vi.fn();
    const entry = makeCommit("abcdef123456", "Fix the build", { parents: ["p1"] });
    const { unmount } = render(
      <PickDialog kind="cherry-pick" entry={entry} parents={[]} branch="main" onPick={onPick} onClose={() => {}} />,
    );
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.queryByLabelText("Mainline")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Only apply the changes, don't commit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
    expect(onPick).toHaveBeenLastCalledWith({ commit: "abcdef123456", noCommit: true, mainline: null });
    unmount();

    render(<PickDialog kind="cherry-pick" entry={entry} parents={[]} branch={null} onPick={onPick} onClose={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Only apply the changes, don't commit" })).toBeChecked();
    expect(screen.getByText(/the detached HEAD/)).toBeInTheDocument();
  });

  it("asks for the mainline of a merge commit", async () => {
    const onPick = vi.fn();
    const entry = makeCommit("m1", "Merge feature", { parents: ["p1", "p2"] });
    const parents = [
      { sha: "p1aaaaaa", subject: "On main" },
      { sha: "p2bbbbbb", subject: null },
    ];
    render(<PickDialog kind="cherry-pick" entry={entry} parents={parents} branch="main" onPick={onPick} onClose={() => {}} />);
    const select = screen.getByLabelText("Mainline");
    expect(screen.getByRole("option", { name: "Parent 1: p1aaaaa On main" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "Parent 2: p2bbbbb");
    await userEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
    expect(onPick).toHaveBeenLastCalledWith({ commit: "m1", noCommit: false, mainline: 2 });
  });

  it("reverts with its own remembered option", async () => {
    const onPick = vi.fn();
    const entry = makeCommit("abcdef123456", "Add the thing", { parents: ["p1"] });
    render(<PickDialog kind="revert" entry={entry} parents={[]} branch="main" onPick={onPick} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Revert Commit" })).toBeInTheDocument();
    expect(screen.getByText(/that undoes the changes of/)).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: "Only apply the changes, don't commit" });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onPick).toHaveBeenLastCalledWith({ commit: "abcdef123456", noCommit: true, mainline: null });
    expect(JSON.parse(localStorage.getItem("cherryPickOptions") ?? "null")).toBeNull();
  });
});
