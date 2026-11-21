import { invoke } from "@tauri-apps/api/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitDetails } from "../api";
import { file, makeStash, mockBackend } from "../test/tauri";
import { StashView } from "./StashView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const details = (sha: string, files: CommitDetails["files"], parents: string[]): CommitDetails => ({
  sha,
  parents,
  author: "Ada",
  authorEmail: "ada@example.com",
  authorTime: 0,
  committer: "Ada",
  committerEmail: "ada@example.com",
  committerTime: 0,
  message: "On main: wip",
  files,
});

describe("StashView", () => {
  beforeEach(() => {
    mockBackend(invokeMock, {
      get_commit_details: ({ sha }) =>
        sha === "s1^3"
          ? details("u1", [file("new.txt", "A")], [])
          : details("s1", [file("a.txt")], ["base", "i1", "u1"]),
      get_commit_file_diff: ({ sha, path }) => `@@ -0,0 +1 @@\n+${sha}:${path}\n`,
    });
  });

  it("shows tracked changes and untracked files with their diffs", async () => {
    const stash = makeStash("s1", "half-done login", { untracked: true, branch: "feature" });
    render(
      <StashView
        repo="/repo"
        stash={stash}
        applyBlocked={null}
        onApply={() => {}}
        onDrop={() => {}}
        onError={() => {}}
      />,
    );
    expect(screen.getByText("half-done login")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(await screen.findByText("s1:a.txt")).toBeInTheDocument();

    // Untracked files come from the stash's third parent.
    await userEvent.click(screen.getByText("new.txt"));
    expect(await screen.findByText("s1^3:new.txt")).toBeInTheDocument();
    // Marked as untracked, as it was when stashed.
    expect(screen.getByTitle("Untracked")).toBeInTheDocument();
  });

  it("applies, pops and deletes, unless applying is blocked", async () => {
    const stash = makeStash("s1", "wip");
    const onApply = vi.fn();
    const onDrop = vi.fn();
    const { rerender } = render(
      <StashView repo="/repo" stash={stash} applyBlocked={null} onApply={onApply} onDrop={onDrop} onError={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenLastCalledWith(stash, false);
    await userEvent.click(screen.getByRole("button", { name: "Pop" }));
    expect(onApply).toHaveBeenLastCalledWith(stash, true);
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(onDrop).toHaveBeenCalledWith(stash);

    rerender(
      <StashView repo="/repo" stash={stash} applyBlocked="Busy" onApply={onApply} onDrop={onDrop} onError={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pop" })).toBeDisabled();
  });
});
