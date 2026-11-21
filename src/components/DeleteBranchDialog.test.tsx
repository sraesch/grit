import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch } from "../api";
import { DeleteBranchDialog } from "./DeleteBranchDialog";

const feature: Branch = { name: "feature", sha: "abc1234", current: false, upstream: "origin/feature", track: null };

function setup(props: Partial<Parameters<typeof DeleteBranchDialog>[0]> = {}) {
  const onDelete = vi.fn();
  render(
    <DeleteBranchDialog
      branch={feature}
      remoteBranch="origin/feature"
      withRemote={false}
      unmerged={false}
      onDelete={onDelete}
      onClose={() => {}}
      {...props}
    />,
  );
  return onDelete;
}

describe("DeleteBranchDialog", () => {
  it("keeps the remote branch unless asked to delete it too", async () => {
    const onDelete = setup();
    const checkbox = screen.getByRole("checkbox", { name: /Also delete the remote branch origin\/feature/ });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenLastCalledWith(feature, false, false);

    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenLastCalledWith(feature, false, true);
  });

  it("offers no remote branch when there is none", () => {
    setup({ remoteBranch: null, withRemote: true });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("asks again for unmerged commits, keeping the remote choice", async () => {
    const onDelete = setup({ unmerged: true, withRemote: true });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("note")).toHaveTextContent("feature or origin/feature has commits that aren't merged");
    await userEvent.click(screen.getByRole("button", { name: "Delete Anyway" }));
    expect(onDelete).toHaveBeenCalledWith(feature, true, true);
  });
});
