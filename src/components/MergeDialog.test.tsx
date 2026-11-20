import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Divergence, Status } from "../api";
import { RebaseTargets } from "../rebase";
import { file, makeStatus, mockBackend } from "../test/tauri";
import { MergeDialog } from "./MergeDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const targets: RebaseTargets = {
  local: ["main", "feature"],
  remote: ["origin/develop", "origin/main"],
  tags: ["v1"],
  preferred: "feature",
};

function setup(status: Partial<Status> = {}, divergence: Record<string, Divergence | string> = {}, t = targets) {
  mockBackend(invokeMock, {
    get_divergence: ({ base }) => {
      const d = divergence[base as string] ?? { ahead: 1, behind: 2 };
      if (typeof d === "string") throw d;
      return d;
    },
  });
  const onMerge = vi.fn();
  const onClose = vi.fn();
  render(
    <MergeDialog
      repo="/work/demo"
      branch="develop"
      status={makeStatus({ branch: "develop", ...status })}
      targets={t}
      onMerge={onMerge}
      onClose={onClose}
    />,
  );
  return { onMerge, onClose };
}

describe("MergeDialog", () => {
  beforeEach(() => localStorage.clear());

  it("previews and merges the preselected branch with the default options on Enter", async () => {
    const { onMerge } = setup();
    const select = screen.getByLabelText("Branch");
    expect(select).toHaveFocus();
    expect(select).toHaveDisplayValue("feature");
    expect(screen.getByLabelText("Options")).toHaveDisplayValue("Fast-forward if possible");
    expect(screen.getByRole("dialog", { name: "Merge" })).toHaveTextContent("Merge into develop");
    await waitFor(() =>
      expect(select).toHaveAccessibleDescription("Creates a merge commit on develop that brings in 2 commits from feature."),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_divergence", { repo: "/work/demo", base: "feature" });

    await userEvent.keyboard("{Enter}");
    expect(onMerge).toHaveBeenCalledWith({ source: "feature", mode: "ff", autostash: true });
  });

  it("groups branches, remote branches and tags", () => {
    setup();
    expect(screen.getByRole("group", { name: "Branches" })).toHaveTextContent("mainfeature");
    expect(screen.getByRole("group", { name: "Remote branches" })).toHaveTextContent("origin/developorigin/main");
    expect(screen.getByRole("group", { name: "Tags" })).toHaveTextContent("v1");
  });

  it("merges with another mode and remembers the options", async () => {
    const { onMerge } = setup({}, { "origin/main": { ahead: 0, behind: 4 } });
    await userEvent.selectOptions(screen.getByLabelText("Branch"), "origin/main");
    await waitFor(() =>
      expect(screen.getByLabelText("Branch")).toHaveAccessibleDescription("Moves develop forward to origin/main (4 commits)."),
    );
    await userEvent.selectOptions(screen.getByLabelText("Options"), "no-ff");
    expect(screen.getByLabelText("Options")).toHaveAccessibleDescription(
      "Creates a merge commit on develop that brings in 4 commits from origin/main.",
    );
    await userEvent.click(screen.getByLabelText("Stash and reapply local changes"));
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onMerge).toHaveBeenCalledWith({ source: "origin/main", mode: "no-ff", autostash: false });
    expect(JSON.parse(localStorage.getItem("mergeOptions")!)).toEqual({ mode: "no-ff", autostash: false });
  });

  it("squashes without stashing and warns about local changes", async () => {
    const { onMerge } = setup({ unstaged: [file("a.txt")] });
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Options"), "squash");
    const stash = screen.getByLabelText("Stash and reapply local changes");
    expect(stash).toBeDisabled();
    expect(stash).not.toBeChecked();
    expect(screen.getByRole("note")).toHaveTextContent("You have uncommitted changes");
    await waitFor(() =>
      expect(screen.getByLabelText("Options")).toHaveAccessibleDescription(
        "Stages the changes of 2 commits from feature on develop, for you to review and commit as one.",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Squash" }));
    expect(onMerge).toHaveBeenCalledWith({ source: "feature", mode: "squash", autostash: false });
    // The stash choice for ordinary merges is kept.
    expect(JSON.parse(localStorage.getItem("mergeOptions")!)).toEqual({ mode: "squash", autostash: true });
  });

  it("can't fast-forward only when the branches diverged", async () => {
    const { onMerge } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Options"), "ff-only");
    await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled());
    expect(screen.getByLabelText("Options")).toHaveAccessibleDescription(
      "develop has 1 commit feature doesn't, so it can't fast-forward. Choose another option to merge.",
    );
    await userEvent.keyboard("{Enter}");
    expect(onMerge).not.toHaveBeenCalled();
  });

  it("shows why the preview failed", async () => {
    setup({}, { feature: "fatal: bad revision" });
    await waitFor(() => expect(screen.getByLabelText("Branch")).toHaveAccessibleDescription("fatal: bad revision"));
  });

  it("can't merge without targets", () => {
    setup({}, {}, { local: [], remote: [], tags: [], preferred: null });
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(screen.getByText("There are no other branches or tags to merge.")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("closes on Cancel and Escape without merging", async () => {
    const { onMerge, onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onMerge).not.toHaveBeenCalled();
  });
});
