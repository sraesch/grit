import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { file, makeStatus, mockBackend } from "../test/tauri";
import { ChangesView } from "./ChangesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const status = makeStatus({
  unstaged: [file("src/edit.ts"), file("fresh.txt", "?")],
  staged: [file("ready.rs", "A")],
});

function setup(props: Partial<Parameters<typeof ChangesView>[0]> = {}) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  render(<ChangesView repo="/repo" status={status} onChanged={onChanged} onError={onError} {...props} />);
  return { onChanged, onError };
}

describe("ChangesView", () => {
  beforeEach(() => {
    mockBackend(invokeMock, {
      get_working_diff: ({ path }) => `@@ -1 +1 @@\n-old ${path}\n+new ${path}\n`,
      stage: () => undefined,
      stage_all: () => undefined,
      unstage: () => undefined,
      unstage_all: () => undefined,
      commit: () => undefined,
      discard: () => undefined,
      add_to_gitignore: () => undefined,
    });
  });

  it("offers the prepared message of a merge and commits it with nothing staged", async () => {
    const merging = makeStatus({
      operation: { kind: "merge", head: null, step: null, total: null, message: "Merge branch 'main' of origin" },
    });
    const { onChanged } = setup({ status: merging });
    const editor = screen.getByRole("textbox", { name: "Commit message" });
    expect(editor).toHaveValue("Merge branch 'main' of origin");

    // Clearing the message sticks; it isn't offered again on the next refresh.
    await userEvent.clear(editor);
    expect(editor).toHaveValue("");
    await userEvent.type(editor, "Merge upstream changes");
    await userEvent.click(screen.getByRole("button", { name: "Commit merge" }));
    expect(invokeMock).toHaveBeenCalledWith("commit", { repo: "/repo", message: "Merge upstream changes", amend: false });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers the prepared message of a squash merge and commits the staged changes", async () => {
    const squashing = makeStatus({
      staged: [file("a.txt")],
      operation: { kind: "squash", head: null, step: null, total: null, message: "Squashed commit of the following:" },
    });
    setup({ status: squashing });
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("Squashed commit of the following:");
    await userEvent.click(screen.getByRole("button", { name: "Commit 1 file" }));
    expect(invokeMock).toHaveBeenCalledWith("commit", {
      repo: "/repo",
      message: "Squashed commit of the following:",
      amend: false,
    });
  });

  it("doesn't commit in the middle of a rebase", async () => {
    const rebasing = makeStatus({
      staged: [file("a.txt")],
      operation: { kind: "rebase", head: "main", step: 1, total: 2, message: null },
    });
    setup({ status: rebasing });
    await userEvent.type(screen.getByRole("textbox", { name: "Commit message" }), "Oops");
    const button = screen.getByRole("button", { name: /^Commit/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("Continue"));
  });

  it("keeps a typed message when a merge starts", async () => {
    const { rerender } = render(<ChangesView repo="/repo" status={status} onChanged={vi.fn()} onError={vi.fn()} />);
    const editor = screen.getByRole("textbox", { name: "Commit message" });
    await userEvent.type(editor, "Mine");
    const merging = makeStatus({
      ...status,
      operation: { kind: "merge", head: null, step: null, total: null, message: "Merge branch 'main'" },
    });
    rerender(<ChangesView repo="/repo" status={merging} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(editor).toHaveValue("Mine");
  });

  it("lists unstaged and staged files with counts", () => {
    setup();
    expect(screen.getByText("Unstaged changes").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Staged changes").parentElement).toHaveTextContent("1");
    expect(screen.getByText("edit.ts")).toBeInTheDocument();
    expect(screen.getByText("ready.rs")).toBeInTheDocument();
  });

  it("loads the diff for the selected file", async () => {
    setup();
    await userEvent.click(screen.getByText("fresh.txt"));
    expect(await screen.findByText("new fresh.txt")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("get_working_diff", {
      repo: "/repo",
      path: "fresh.txt",
      staged: false,
      untracked: true,
    });
  });

  it("stages a file on double-click and refreshes", async () => {
    const { onChanged } = setup();
    await userEvent.dblClick(screen.getByText("edit.ts"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("stage", { repo: "/repo", paths: ["src/edit.ts"] });
  });

  it("unstages both paths of a rename", async () => {
    setup({ status: makeStatus({ staged: [file("new.rs", "R", "old.rs")] }) });
    await userEvent.click(screen.getByRole("button", { name: "Unstage" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("unstage", { repo: "/repo", paths: ["old.rs", "new.rs"] }),
    );
  });

  it("stages and unstages the files listed in a folder", async () => {
    const { onChanged } = setup({
      status: makeStatus({
        unstaged: [file("src/a.ts"), file("src/lib/b.ts"), file("top.txt")],
        conflicted: [file("src/c.ts", "U")],
        staged: [file("lib/x.rs", "A"), file("lib/y.rs", "R", "lib/old.rs")],
      }),
    });
    const unstagedSrc = screen.getAllByText("src")[1].closest("li")!;
    await userEvent.click(within(unstagedSrc).getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("stage", {
      repo: "/repo",
      paths: ["src/lib/b.ts", "src/a.ts"],
    });
    expect(unstagedSrc).toHaveAttribute("aria-expanded", "true");

    const lib = screen.getAllByText("lib").pop()!.closest("li")!;
    await userEvent.click(within(lib).getByRole("button", { name: "Unstage" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenCalledWith("unstage", {
      repo: "/repo",
      paths: ["lib/x.rs", "lib/old.rs", "lib/y.rs"],
    });
  });

  it("stages and unstages everything", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await userEvent.click(screen.getByRole("button", { name: "Unstage all" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("unstage_all", { repo: "/repo" }));
    expect(invokeMock).toHaveBeenCalledWith("stage_all", { repo: "/repo" });
  });

  it("only enables commit with a message and staged files", async () => {
    setup({ status: makeStatus({ unstaged: [file("a.txt")] }) });
    const button = screen.getByRole("button", { name: /^Commit/ });
    await userEvent.type(screen.getByPlaceholderText("Commit message"), "message");
    expect(button).toBeDisabled();

    // Amending is allowed without staged changes.
    await userEvent.click(screen.getByLabelText("Amend last commit"));
    expect(screen.getByRole("button", { name: /^Amend/ })).toBeEnabled();
  });

  it("commits with Ctrl+Enter and clears the message", async () => {
    const { onChanged } = setup();
    const textarea = screen.getByPlaceholderText("Commit message");
    await userEvent.type(textarea, "Add feature{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit", { repo: "/repo", message: "Add feature", amend: false }),
    );
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("previews the message as markdown and returns to editing", async () => {
    setup();
    await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByText("Nothing to preview")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    const textarea = screen.getByRole("textbox", { name: "Commit message" });
    expect(textarea).toHaveFocus();
    await userEvent.type(textarea, "Add feature{Enter}{Enter}- one{Enter}- **two**");

    await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull();
    const preview = screen.getByRole("tabpanel");
    expect(within(preview).getByText("Add feature")).toHaveClass("commit-summary");
    expect(within(preview).getAllByRole("listitem")).toHaveLength(2);
    expect(within(preview).getByText("two").tagName).toBe("STRONG");

    // The message survives switching back.
    await userEvent.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("Add feature\n\n- one\n- **two**");
  });

  it("commits with Ctrl+Enter from the preview and returns to the editor", async () => {
    setup();
    await userEvent.type(screen.getByRole("textbox", { name: "Commit message" }), "Add feature");
    await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
    screen.getByRole("tabpanel").focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit", { repo: "/repo", message: "Add feature", amend: false }),
    );
    expect(await screen.findByRole("textbox", { name: "Commit message" })).toHaveValue("");
  });

  it("blocks committing while conflicts exist", async () => {
    setup({ status: makeStatus({ staged: [file("a.txt")], conflicted: [file("c.txt", "U")] }) });
    await userEvent.type(screen.getByPlaceholderText("Commit message"), "merge");
    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
  });

  it("reports backend errors", async () => {
    mockBackend(invokeMock, {
      stage: () => {
        throw "fatal: pathspec did not match";
      },
    });
    const { onError, onChanged } = setup();
    await userEvent.dblClick(screen.getByText("edit.ts"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("fatal: pathspec did not match"));
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("discards a file's changes after confirming", async () => {
    const { onChanged } = setup();
    const row = screen.getByText("edit.ts").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Discard" }));
    const dialog = screen.getByRole("dialog", { name: "Discard Changes" });
    expect(dialog).toHaveTextContent("Discard the unstaged changes to this file?");
    expect(dialog).toHaveTextContent("src/edit.ts");
    expect(dialog).toHaveTextContent("Staged changes are kept.");
    expect(invokeMock).not.toHaveBeenCalledWith("discard", expect.anything());

    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("discard", { repo: "/repo", tracked: ["src/edit.ts"], untracked: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes an untracked file from its context menu", async () => {
    setup();
    fireEvent.contextMenu(screen.getByText("fresh.txt"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete File…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete File" });
    expect(dialog).toHaveTextContent("Delete this untracked file?");
    expect(dialog).not.toHaveTextContent("Staged changes");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("discard", { repo: "/repo", tracked: [], untracked: ["fresh.txt"] }),
    );
  });

  it("does nothing when the discard is cancelled", async () => {
    const { onChanged } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("discard", expect.anything());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("discards everything unstaged, but no conflicts", async () => {
    setup({
      status: makeStatus({
        unstaged: [file("a.txt"), file("b.txt", "D"), file("new.txt", "?")],
        conflicted: [file("c.txt", "U")],
      }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    const dialog = screen.getByRole("dialog", { name: "Discard Changes" });
    expect(dialog).toHaveTextContent("Discard the unstaged changes to 2 files and delete 1 untracked file?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("discard", {
        repo: "/repo",
        tracked: ["a.txt", "b.txt"],
        untracked: ["new.txt"],
      }),
    );
  });

  it("discards a folder from its row and context menu", async () => {
    setup({ status: makeStatus({ unstaged: [file("src/a.ts"), file("src/b.ts", "?"), file("top.txt")] }) });
    const src = screen.getByText("src").closest("li")!;
    await userEvent.click(within(src).getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("src/a.ts");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.contextMenu(src);
    await userEvent.click(screen.getByRole("menuitem", { name: "Discard Folder…" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("discard", {
        repo: "/repo",
        tracked: ["src/a.ts"],
        untracked: ["src/b.ts"],
      }),
    );
  });

  it("lists only the first files of a large discard", async () => {
    setup({ status: makeStatus({ unstaged: Array.from({ length: 13 }, (_, i) => file(`f${i}.txt`)) }) });
    await userEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    const items = within(screen.getByRole("dialog")).getAllByRole("listitem");
    expect(items).toHaveLength(11);
    expect(items[10]).toHaveTextContent("and 3 more");
  });

  it("stages and unstages from the context menu", async () => {
    setup();
    fireEvent.contextMenu(screen.getByText("edit.ts"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Stage" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage", { repo: "/repo", paths: ["src/edit.ts"] }));

    fireEvent.contextMenu(screen.getByText("ready.rs"));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Unstage"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Unstage" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("unstage", { repo: "/repo", paths: ["ready.rs"] }));
  });
  it("ignores an untracked file by its extension", async () => {
    const { onChanged } = setup({ status: makeStatus({ unstaged: [file("logs/debug.log", "?"), file("a.ts")] }) });
    fireEvent.contextMenu(screen.getByText("debug.log"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Ignore…" }));
    const dialog = screen.getByRole("dialog", { name: "Ignore File" });
    const pattern = within(dialog).getByRole("textbox", { name: "Pattern" });
    expect(pattern).toHaveValue("/logs/debug.log");
    expect(within(dialog).getByRole("radio", { name: /Only this file/ })).toBeChecked();

    await userEvent.click(within(dialog).getByRole("radio", { name: /All files with extension \.log/ }));
    expect(pattern).toHaveValue("*.log");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("add_to_gitignore", { repo: "/repo", pattern: "*.log" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a folder of untracked files with an edited pattern", async () => {
    setup({ status: makeStatus({ unstaged: [file("gen/a.js", "?"), file("gen/b.js", "?")] }) });
    fireEvent.contextMenu(screen.getByText("gen"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Ignore Folder…" }));
    const dialog = screen.getByRole("dialog", { name: "Ignore Folder" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /All folders named gen/ }));
    const pattern = within(dialog).getByRole("textbox", { name: "Pattern" });
    expect(pattern).toHaveValue("gen/");
    await userEvent.clear(pattern);
    expect(within(dialog).getByRole("button", { name: "Ignore" })).toBeDisabled();
    await userEvent.type(pattern, "gen/*.js{Enter}");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("add_to_gitignore", { repo: "/repo", pattern: "gen/*.js" }),
    );
  });

  it("offers ignoring only for untracked files and folders", () => {
    setup({ status: makeStatus({ unstaged: [file("src/a.ts"), file("src/new.ts", "?")] }) });
    fireEvent.contextMenu(screen.getByText("a.ts"));
    expect(screen.queryByRole("menuitem", { name: "Ignore…" })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.contextMenu(screen.getByText("src"));
    expect(screen.queryByRole("menuitem", { name: "Ignore Folder…" })).toBeNull();
  });
});
