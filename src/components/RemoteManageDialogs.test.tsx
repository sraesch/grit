import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { prefs } from "../remote";
import { AddRemoteDialog, EditRemoteDialog, RemoveRemoteDialog } from "./RemoteManageDialogs";

const origin = { name: "origin", url: "git@example.com:ada/demo.git" };

describe("AddRemoteDialog", () => {
  it("adds a remote, fetches it by default and remembers that choice", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<AddRemoteDialog onAdd={onAdd} onClose={vi.fn()} />);
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), " upstream ");
    await userEvent.type(screen.getByLabelText("URL"), "https://example.com/team/demo.git");
    expect(screen.getByLabelText("Fetch it right away")).toBeChecked();
    await userEvent.click(screen.getByLabelText("Fetch it right away"));
    await userEvent.click(add);

    expect(onAdd).toHaveBeenCalledWith("upstream", "https://example.com/team/demo.git", false);
    expect(prefs.addRemote()).toEqual({ fetch: false });
  });

  it("shows why adding failed and stays open", async () => {
    const onAdd = vi.fn().mockRejectedValue("error: remote origin already exists.");
    const onClose = vi.fn();
    render(<AddRemoteDialog onAdd={onAdd} onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("Name"), "origin");
    await userEvent.type(screen.getByLabelText("URL"), "/srv/demo.git{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });
});

describe("EditRemoteDialog", () => {
  it("edits the URL, starting from the current one", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditRemoteDialog remote={origin} field="url" onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Edit URL of origin" })).toBeInTheDocument();
    const input = screen.getByLabelText("URL");
    expect(input).toHaveValue(origin.url);
    // Nothing changed yet.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "https://example.com/ada/demo.git{Enter}");
    expect(onSave).toHaveBeenCalledWith(origin, "https://example.com/ada/demo.git");
  });

  it("renames a remote", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditRemoteDialog remote={origin} field="name" onSave={onSave} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "github");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onSave).toHaveBeenCalledWith(origin, "github");
  });
});

describe("RemoveRemoteDialog", () => {
  it("names the local branches that lose their upstream", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(
      <RemoveRemoteDialog remote={origin} trackingBranches={["main", "feature"]} onRemove={onRemove} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("main, feature track a branch of it");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith(origin);
  });

  it("has no warning without tracking branches", () => {
    render(<RemoveRemoteDialog remote={origin} trackingBranches={[]} onRemove={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
