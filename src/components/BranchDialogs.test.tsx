import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Branch } from "../api";
import { CreateBranchDialog, RenameBranchDialog, UpstreamDialog } from "./BranchDialogs";

const feature: Branch = { name: "feature", sha: "abc1234", current: false, upstream: "origin/feature", track: null };

describe("CreateBranchDialog", () => {
  beforeEach(() => localStorage.clear());

  it("creates the branch with dashes for spaces and remembers whether to check it out", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<CreateBranchDialog startLabel="abc1234 Fix" onCreate={onCreate} onClose={() => {}} />);
    expect(screen.getByText("abc1234 Fix")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Create and Check Out" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Name"), "my fix");
    expect(screen.getByText("my-fix")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Check out the new branch" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenLastCalledWith("my-fix", false);
    unmount();

    render(<CreateBranchDialog startLabel="main" onCreate={onCreate} onClose={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Check out the new branch" })).not.toBeChecked();
  });

  it("shows why creating failed", async () => {
    const onCreate = vi.fn().mockRejectedValue("fatal: a branch named 'main' already exists");
    render(<CreateBranchDialog startLabel="abc1234" onCreate={onCreate} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Name"), "main");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  });
});

describe("RenameBranchDialog", () => {
  it("renames only here unless asked to rename the remote branch too", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const rename = async (withRemote: boolean) => {
      const { unmount } = render(
        <RenameBranchDialog branch={feature} remoteBranch="origin/feature" onRename={onRename} onClose={() => {}} />,
      );
      const submit = screen.getByRole("button", { name: "Rename" });
      expect(submit).toBeDisabled();
      const input = screen.getByLabelText("New name");
      await userEvent.clear(input);
      await userEvent.type(input, "topic");
      if (withRemote) {
        await userEvent.click(screen.getByRole("checkbox", { name: "Also rename the remote branch origin/feature" }));
        expect(screen.getByRole("note")).toHaveTextContent("origin/feature is deleted");
      }
      await userEvent.click(submit);
      unmount();
    };
    await rename(false);
    expect(onRename).toHaveBeenLastCalledWith(feature, "topic", false);
    await rename(true);
    expect(onRename).toHaveBeenLastCalledWith(feature, "topic", true);
  });

  it("offers no remote rename without a remote branch", () => {
    render(<RenameBranchDialog branch={feature} remoteBranch={null} onRename={vi.fn()} onClose={() => {}} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("UpstreamDialog", () => {
  it("starts on the current upstream and sets another one", async () => {
    const onSet = vi.fn().mockResolvedValue(undefined);
    render(
      <UpstreamDialog
        branch={feature}
        remoteBranches={["origin/main", "origin/feature"]}
        onSet={onSet}
        onClose={() => {}}
      />,
    );
    const select = screen.getByLabelText("Remote branch");
    expect(select).toHaveValue("origin/feature");
    expect(screen.getByRole("button", { name: "Set Upstream" })).toBeDisabled();
    await userEvent.selectOptions(select, "origin/main");
    await userEvent.click(screen.getByRole("button", { name: "Set Upstream" }));
    expect(onSet).toHaveBeenCalledWith(feature, "origin/main");
  });

  it("prefers the remote branch of the same name for a branch without upstream", () => {
    const branch = { ...feature, upstream: null };
    render(
      <UpstreamDialog
        branch={branch}
        remoteBranches={["origin/main", "origin/feature"]}
        onSet={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("Remote branch")).toHaveValue("origin/feature");
  });

  it("explains when there is nothing to track", () => {
    render(<UpstreamDialog branch={feature} remoteBranches={[]} onSet={vi.fn()} onClose={() => {}} />);
    expect(screen.getByText(/no remote branches to track/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set Upstream" })).toBeDisabled();
  });
});
