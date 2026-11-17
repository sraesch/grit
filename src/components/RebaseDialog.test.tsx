import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Divergence, Status } from "../api";
import { RebaseTargets } from "../rebase";
import { file, makeStatus, mockBackend } from "../test/tauri";
import { RebaseDialog } from "./RebaseDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const targets: RebaseTargets = {
  local: ["main", "develop"],
  remote: ["origin/feature", "origin/main"],
  tags: ["v1"],
  preferred: "develop",
};

function setup(status: Partial<Status> = {}, divergence: Record<string, Divergence | string> = {}, t = targets) {
  mockBackend(invokeMock, {
    get_divergence: ({ base }) => {
      const d = divergence[base as string] ?? { ahead: 2, behind: 1 };
      if (typeof d === "string") throw d;
      return d;
    },
  });
  const onRebase = vi.fn();
  const onClose = vi.fn();
  render(
    <RebaseDialog
      repo="/work/demo"
      branch="feature"
      status={makeStatus({ branch: "feature", ...status })}
      targets={t}
      onRebase={onRebase}
      onClose={onClose}
    />,
  );
  return { onRebase, onClose };
}

describe("RebaseDialog", () => {
  it("previews and rebases onto the preselected branch with stashing by default on Enter", async () => {
    const { onRebase } = setup();
    const select = screen.getByLabelText("Onto");
    expect(select).toHaveFocus();
    expect(select).toHaveDisplayValue("develop");
    expect(screen.getByRole("dialog", { name: "Rebase" })).toHaveTextContent("Rebase feature");
    await waitFor(() =>
      expect(select).toHaveAccessibleDescription("Replays 2 commits of feature on top of develop, which has 1 commit feature doesn't."),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_divergence", { repo: "/work/demo", base: "develop" });

    await userEvent.keyboard("{Enter}");
    expect(onRebase).toHaveBeenCalledWith({ onto: "develop", autostash: true });
  });

  it("groups branches, remote branches and tags", () => {
    setup();
    expect(screen.getByRole("group", { name: "Branches" })).toHaveTextContent("maindevelop");
    expect(screen.getByRole("group", { name: "Remote branches" })).toHaveTextContent("origin/featureorigin/main");
    expect(screen.getByRole("group", { name: "Tags" })).toHaveTextContent("v1");
  });

  it("rebases onto another target without stashing and remembers the choice", async () => {
    const { onRebase } = setup({}, { "origin/main": { ahead: 0, behind: 4 } });
    await userEvent.selectOptions(screen.getByLabelText("Onto"), "origin/main");
    await waitFor(() =>
      expect(screen.getByLabelText("Onto")).toHaveAccessibleDescription(
        "feature has no commits of its own, so it moves to origin/main (4 commits ahead).",
      ),
    );
    await userEvent.click(screen.getByLabelText("Stash and reapply local changes"));
    await userEvent.click(screen.getByRole("button", { name: "Rebase" }));
    expect(onRebase).toHaveBeenCalledWith({ onto: "origin/main", autostash: false });
    expect(JSON.parse(localStorage.getItem("rebaseOptions")!)).toEqual({ autostash: false });
  });

  it("shows why the preview failed", async () => {
    setup({}, { develop: "fatal: bad revision" });
    await waitFor(() => expect(screen.getByLabelText("Onto")).toHaveAccessibleDescription("fatal: bad revision"));
  });

  it("warns about uncommitted changes when not stashing", async () => {
    setup({ unstaged: [file("a.txt")] });
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(screen.getByLabelText("Stash and reapply local changes"));
    expect(screen.getByRole("note")).toHaveTextContent("won't start until they are stashed or committed");
  });

  it("warns when pushed commits would be rewritten", async () => {
    setup({ upstream: "origin/feature", ahead: 0 }, { develop: { ahead: 2, behind: 1 } });
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Some of these commits are already on origin/feature. Rebasing rewrites them, so you'll have to force-push",
    );
  });

  it("can't rebase without targets", () => {
    setup({}, {}, { local: [], remote: [], tags: [], preferred: null });
    expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
    expect(screen.getByText("There are no other branches or tags to rebase onto.")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("closes on Cancel and Escape without rebasing", async () => {
    const { onRebase, onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onRebase).not.toHaveBeenCalled();
  });
});
