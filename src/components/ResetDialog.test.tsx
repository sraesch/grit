import { invoke } from "@tauri-apps/api/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { file, makeCommit, makeStatus, mockBackend } from "../test/tauri";
import { ResetDialog } from "./ResetDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const entry = makeCommit("abcdef123456", "Older commit");

describe("ResetDialog", () => {
  beforeEach(() => localStorage.clear());

  it("previews the dropped commits, warns about pushed ones, and remembers soft and mixed", async () => {
    mockBackend(invokeMock, { get_reset_preview: () => ({ dropped: 3, droppedPushed: 1, added: 0 }) });
    const onReset = vi.fn();
    const { unmount } = render(
      <ResetDialog repo="/r" entry={entry} branch="main" status={makeStatus()} onReset={onReset} onClose={() => {}} />,
    );
    expect(await screen.findByText(/3 commits will no longer be on main\./)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("1 commit that was already pushed will be dropped from main");
    expect(screen.getByRole("radio", { name: /Mixed/ })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: /Soft/ }));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenLastCalledWith("soft");
    unmount();

    render(
      <ResetDialog repo="/r" entry={entry} branch="main" status={makeStatus()} onReset={onReset} onClose={() => {}} />,
    );
    expect(screen.getByRole("radio", { name: /Soft/ })).toBeChecked();
  });

  it("marks a hard reset as destructive, warns about local changes, and never remembers it", async () => {
    mockBackend(invokeMock, { get_reset_preview: () => ({ dropped: 1, droppedPushed: 0, added: 0 }) });
    const onReset = vi.fn();
    const status = makeStatus({ unstaged: [file("a.txt")] });
    const { unmount } = render(
      <ResetDialog repo="/r" entry={entry} branch={null} status={status} onReset={onReset} onClose={() => {}} />,
    );
    expect(await screen.findByText(/1 commit will no longer be on HEAD\./)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /Hard/ }));
    expect(screen.getByRole("note")).toHaveTextContent("can't be recovered");
    const submit = screen.getByRole("button", { name: "Reset Hard" });
    expect(submit).toHaveClass("danger");
    await userEvent.click(submit);
    expect(onReset).toHaveBeenLastCalledWith("hard");
    unmount();

    render(<ResetDialog repo="/r" entry={entry} branch="main" status={status} onReset={onReset} onClose={() => {}} />);
    expect(screen.getByRole("radio", { name: /Mixed/ })).toBeChecked();
  });
});
