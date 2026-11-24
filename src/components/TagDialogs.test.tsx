import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Branch, Remote } from "../api";
import { CreateTagDialog, DeleteRemoteTagDialog, DeleteTagDialog } from "./TagDialogs";

const remotes: Remote[] = [
  { name: "backup", url: "/srv/backup.git" },
  { name: "origin", url: "git@example.com:demo.git" },
];
const tag: Branch = { name: "v1.0", sha: "abc1234", current: false, upstream: null, track: null };

describe("CreateTagDialog", () => {
  beforeEach(() => localStorage.clear());

  it("creates a lightweight tag without pushing by default", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateTagDialog startLabel="abc1234 Fix" remotes={remotes} onCreate={onCreate} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Name"), "v1.0");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenLastCalledWith("v1.0", null, null);
  });

  it("annotates with a message, pushes to the chosen remote and remembers it", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <CreateTagDialog startLabel="abc1234 Fix" remotes={remotes} onCreate={onCreate} onClose={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText("Name"), "v2.0");
    // Enter in the message adds a line rather than submitting.
    await userEvent.type(screen.getByLabelText("Message"), "Release 2{Enter}Notes");
    expect(onCreate).not.toHaveBeenCalled();
    const remote = screen.getByRole("combobox", { name: "Remote" });
    expect(remote).toHaveValue("origin");
    expect(remote).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Push to" }));
    await userEvent.selectOptions(remote, "backup");
    await userEvent.click(screen.getByRole("button", { name: "Create and Push" }));
    expect(onCreate).toHaveBeenLastCalledWith("v2.0", "Release 2\nNotes", "backup");
    unmount();

    render(<CreateTagDialog startLabel="abc1234" remotes={remotes} onCreate={onCreate} onClose={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Push to" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Remote" })).toHaveValue("backup");
  });

  it("offers no push without remotes, and shows why creating failed", async () => {
    const onCreate = vi.fn().mockRejectedValue("fatal: tag 'v1.0' already exists");
    render(<CreateTagDialog startLabel="abc1234" remotes={[]} onCreate={onCreate} onClose={() => {}} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "v1.0{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  });
});

describe("DeleteTagDialog", () => {
  it("confirms deleting the local tag", async () => {
    const onDelete = vi.fn();
    render(<DeleteTagDialog tag={tag} onDelete={onDelete} onClose={() => {}} />);
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(tag);
  });
});

describe("DeleteRemoteTagDialog", () => {
  it("asks which remote, preferring origin, and warns it can't be undone", async () => {
    const onDelete = vi.fn();
    render(<DeleteRemoteTagDialog tag={tag} remotes={remotes} onDelete={onDelete} onClose={() => {}} />);
    expect(screen.getByLabelText("Remote")).toHaveValue("origin");
    expect(screen.getByRole("note")).toHaveTextContent("can't undo");
    await userEvent.selectOptions(screen.getByLabelText("Remote"), "backup");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(tag, "backup");
  });
});
