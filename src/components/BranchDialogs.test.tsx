import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateBranchDialog } from "./BranchDialogs";

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
