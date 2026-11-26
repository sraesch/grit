import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictSides } from "../conflict";
import { conflictFile, file, makeStatus, mockBackend } from "../test/tauri";
import { ChangesView } from "./ChangesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const status = makeStatus({
  unstaged: [file("src/edit.ts"), file("fresh.txt", "?")],
  staged: [file("ready.rs", "A")],
});

const sides: ConflictSides = {
  ours: { name: "main", detail: "current branch" },
  theirs: { name: "feature", detail: "being merged" },
};

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
      resolve_conflicts: () => undefined,
      // Unless a test is about the conflict editor, conflicts are shown as their diff.
      get_conflict_file: () => {
        throw "This file isn't UTF-8 text, so it can't be resolved here.";
      },
      save_conflict_file: () => undefined,
      add_to_gitignore: () => undefined,
      apply_selection: () => undefined,
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

  it("takes back the offered merge message when the merge is aborted", () => {
    const merging = makeStatus({
      ...status,
      operation: { kind: "merge", head: null, step: null, total: null, message: "Merge branch 'clash'" },
    });
    const { rerender } = render(<ChangesView repo="/repo" status={merging} onChanged={vi.fn()} onError={vi.fn()} />);
    const editor = screen.getByRole("textbox", { name: "Commit message" });
    expect(editor).toHaveValue("Merge branch 'clash'");
    rerender(<ChangesView repo="/repo" status={status} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(editor).toHaveValue("");

    // A later merge with the same message is offered again.
    rerender(<ChangesView repo="/repo" status={merging} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(editor).toHaveValue("Merge branch 'clash'");
  });

  it("keeps an edited merge message when the merge is aborted", async () => {
    const merging = makeStatus({
      ...status,
      operation: { kind: "merge", head: null, step: null, total: null, message: "Merge branch 'clash'" },
    });
    const { rerender } = render(<ChangesView repo="/repo" status={merging} onChanged={vi.fn()} onError={vi.fn()} />);
    const editor = screen.getByRole("textbox", { name: "Commit message" });
    await userEvent.type(editor, " into main");
    rerender(<ChangesView repo="/repo" status={status} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(editor).toHaveValue("Merge branch 'clash' into main");
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
  it("stages and discards hunks of an unstaged file", async () => {
    const { onChanged } = setup();
    await userEvent.click(screen.getByText("edit.ts"));
    await userEvent.click(await screen.findByRole("button", { name: "Stage hunk" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("apply_selection", {
      repo: "/repo",
      path: "src/edit.ts",
      staged: false,
      untracked: false,
      action: "stage",
      selection: [{ index: 0, header: "@@ -1 +1 @@", lines: null }],
    });

    // Discarding a hunk needs no confirmation.
    await userEvent.click(screen.getByRole("button", { name: "Discard hunk" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenLastCalledWith("apply_selection", expect.objectContaining({ action: "discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unstages hunks of a staged file", async () => {
    setup();
    await userEvent.click(screen.getByText("ready.rs"));
    expect(await screen.findByRole("button", { name: "Unstage hunk" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stage hunk" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Unstage hunk" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "apply_selection",
        expect.objectContaining({ path: "ready.rs", staged: true, action: "unstage" }),
      ),
    );
  });

  it("stages but doesn't discard hunks of an untracked file", async () => {
    setup();
    await userEvent.click(screen.getByText("fresh.txt"));
    await userEvent.click(await screen.findByRole("button", { name: "Stage hunk" }));
    expect(screen.queryByRole("button", { name: "Discard hunk" })).toBeNull();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "apply_selection",
        expect.objectContaining({ path: "fresh.txt", untracked: true, action: "stage" }),
      ),
    );
  });

  it("offers no hunk actions on conflicts", async () => {
    setup({ status: makeStatus({ conflicted: [file("c.txt", "U")] }) });
    await userEvent.click(screen.getByText("c.txt"));
    expect(await screen.findByText("new c.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /hunk/ })).toBeNull();
  });

  it("resolves a conflicted file with one side from its row", async () => {
    const { onChanged } = setup({
      sides,
      status: makeStatus({ conflicted: [conflictFile("c.txt"), conflictFile("gone.txt", "deleted-by-them")] }),
    });
    expect(screen.getByText("ours = main · theirs = feature")).toBeInTheDocument();

    const gone = screen.getByText("gone.txt").closest("li")!;
    expect(gone.querySelector(".status-badge")).toHaveAttribute(
      "title",
      "Conflict: Changed in main, deleted in feature",
    );
    const theirs = within(gone).getByRole("button", { name: "Use theirs" });
    expect(theirs).toHaveAttribute("title", "feature (being merged) has no such file: resolving deletes it");
    await userEvent.click(theirs);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("resolve_conflicts", {
        repo: "/repo",
        paths: ["gone.txt"],
        side: "theirs",
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    const row = screen.getByText("c.txt").closest("li")!;
    const ours = within(row).getByRole("button", { name: "Use ours" });
    expect(ours).toHaveAttribute("title", "Resolve with the version of main (current branch)");
    await userEvent.click(ours);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("resolve_conflicts", { repo: "/repo", paths: ["c.txt"], side: "ours" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before resolving a folder of conflicts with one side", async () => {
    setup({
      sides,
      status: makeStatus({ conflicted: [conflictFile("src/a.ts"), conflictFile("src/lib/b.ts")] }),
    });
    const src = screen.getByText("src").closest("li")!;
    const ours = within(src).getByRole("button", { name: "Use ours" });
    expect(ours).toHaveAttribute("title", "Resolve 2 files in src/ with main (current branch)…");
    await userEvent.click(ours);
    expect(invokeMock).not.toHaveBeenCalledWith("resolve_conflicts", expect.anything());

    const dialog = screen.getByRole("dialog", { name: "Resolve Conflicts" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Use main" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("resolve_conflicts", {
        repo: "/repo",
        paths: ["src/lib/b.ts", "src/a.ts"],
        side: "ours",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the sides in the context menu of a conflict", async () => {
    setup({
      sides,
      status: makeStatus({ conflicted: [conflictFile("src/a.ts"), conflictFile("src/b.ts")] }),
    });
    fireEvent.contextMenu(screen.getByText("a.ts"));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Use main (current branch)",
      "Use feature (being merged)",
      "Mark Resolved",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Use feature (being merged)" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("resolve_conflicts", {
        repo: "/repo",
        paths: ["src/a.ts"],
        side: "theirs",
      }),
    );

    fireEvent.contextMenu(screen.getByText("b.ts"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark Resolved" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage", { repo: "/repo", paths: ["src/b.ts"] }));

    // A folder asks first.
    fireEvent.contextMenu(screen.getByText("src"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Use feature for Folder…" }));
    const dialog = screen.getByRole("dialog", { name: "Resolve Conflicts" });
    expect(within(dialog).getByRole("button", { name: "Use feature" })).toBeInTheDocument();
  });

  it("opens a conflict in the merge tool from its menu and from the header", async () => {
    const onOpenMergeTool = vi.fn();
    const gone = conflictFile("gone.txt", "deleted-by-them");
    const both = conflictFile("both.txt");
    setup({ sides, onOpenMergeTool, status: makeStatus({ conflicted: [both, gone] }) });

    fireEvent.contextMenu(screen.getByText("both.txt"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open in Merge Tool" }));
    expect(onOpenMergeTool).toHaveBeenCalledWith(both);

    await userEvent.click(screen.getByText("both.txt"));
    await userEvent.click(await screen.findByRole("button", { name: "Open in merge tool" }));
    expect(onOpenMergeTool).toHaveBeenCalledTimes(2);

    // A merge tool can't do anything for a file one side deleted.
    fireEvent.contextMenu(screen.getByText("gone.txt"));
    const blocked = screen.getByRole("menuitem", { name: "Open in Merge Tool" });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute("title", expect.stringMatching(/use one of the sides/));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByText("gone.txt"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open in merge tool" })).toBeDisabled());
    expect(onOpenMergeTool).toHaveBeenCalledTimes(2);
  });

  it("opens no second merge tool while one is running", async () => {
    const onOpenMergeTool = vi.fn();
    setup({
      sides,
      onOpenMergeTool,
      toolBusy: "Wait until the running operation is done",
      status: makeStatus({ conflicted: [conflictFile("both.txt")] }),
    });
    await userEvent.click(screen.getByText("both.txt"));
    const button = await screen.findByRole("button", { name: "Open in merge tool" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Wait until the running operation is done");
    // Taking a side is still possible.
    expect(screen.getByRole("button", { name: "Use feature" })).toBeEnabled();
  });

  it("takes a side of the selected conflict from the header, then shows the next conflict", async () => {
    const props = { repo: "/repo", sides, onChanged: () => {}, onError: () => {} };
    const { rerender } = render(
      <ChangesView {...props} status={makeStatus({ conflicted: [conflictFile("a.txt"), conflictFile("b.txt")] })} />,
    );
    await userEvent.click(screen.getByText("a.txt"));
    await userEvent.click(await screen.findByRole("button", { name: "Use feature" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("resolve_conflicts", { repo: "/repo", paths: ["a.txt"], side: "theirs" }),
    );

    rerender(
      <ChangesView {...props} status={makeStatus({ staged: [file("a.txt")], conflicted: [conflictFile("b.txt")] })} />,
    );
    expect(await screen.findByText("new b.txt")).toBeInTheDocument();
    expect(screen.getByText("b.txt", { selector: "li *" }).closest("li")).toHaveClass("selected");

    // Once the last conflict is gone, nothing is selected.
    rerender(<ChangesView {...props} status={makeStatus({ staged: [file("a.txt"), file("b.txt")] })} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use feature" })).toBeNull());
    expect(screen.queryByText("new b.txt")).toBeNull();
  });

  describe("conflict editor", () => {
    const editable = {
      token: "t1",
      markers: true,
      segments: [
        { kind: "common", text: "one\n" },
        { kind: "conflict", ours: "TWO\n", base: "two\n", theirs: "2\n" },
        { kind: "common", text: "three\n" },
      ],
    };
    const backend = () =>
      mockBackend(invokeMock, {
        get_working_diff: ({ path }) => `@@ -1 +1 @@\n-old ${path}\n+new ${path}\n`,
        get_conflict_file: () => editable,
        save_conflict_file: () => undefined,
        resolve_conflicts: () => undefined,
      });

    it("resolves the selected conflict line by line and saves it", async () => {
      backend();
      const { onChanged } = setup({ sides, status: makeStatus({ conflicted: [conflictFile("a.txt")] }) });
      await userEvent.click(screen.getByText("a.txt"));

      const toolbar = within(await screen.findByRole("toolbar", { name: "Conflict" }));
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
      // The editor is shown in place of the diff, which isn't loaded.
      expect(invokeMock).not.toHaveBeenCalledWith("get_working_diff", expect.anything());
      // Taking a side for the whole file is still at hand, in the header.
      expect(screen.getByRole("button", { name: "Use feature" })).toBeInTheDocument();

      await userEvent.click(toolbar.getByRole("button", { name: "Take feature" }));
      await userEvent.click(screen.getByRole("button", { name: "Save and mark resolved" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("save_conflict_file", {
          repo: "/repo",
          path: "a.txt",
          token: "t1",
          content: "one\n2\nthree\n",
        }),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it("shows the diff of a conflict on request", async () => {
      backend();
      setup({ sides, status: makeStatus({ conflicted: [conflictFile("a.txt")] }) });
      await userEvent.click(screen.getByText("a.txt"));
      await screen.findByRole("toolbar", { name: "Conflict" });

      const toggle = screen.getByRole("button", { name: "Show diff" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(toggle);
      expect(await screen.findByText("new a.txt")).toBeInTheDocument();
      expect(screen.queryByRole("toolbar", { name: "Conflict" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Show editor" }));
      expect(await screen.findByRole("toolbar", { name: "Conflict" })).toBeInTheDocument();
      expect(screen.queryByText("new a.txt")).toBeNull();
    });

    it("keeps what was resolved while another file is looked at", async () => {
      backend();
      setup({ sides, status: makeStatus({ conflicted: [conflictFile("a.txt")], unstaged: [file("b.txt")] }) });
      await userEvent.click(screen.getByText("a.txt"));
      const toolbar = within(await screen.findByRole("toolbar", { name: "Conflict" }));
      await userEvent.click(toolbar.getByRole("button", { name: "Take main" }));
      expect(screen.getByRole("status")).toHaveTextContent("All conflicts resolved");

      await userEvent.click(screen.getByText("b.txt"));
      expect(await screen.findByText("new b.txt")).toBeInTheDocument();
      await userEvent.click(screen.getByText("a.txt"));
      await screen.findByRole("toolbar", { name: "Conflict" });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All conflicts resolved"));
      expect(screen.getByRole("textbox", { name: "Result" })).toHaveTextContent("Conflict 1 · main");
    });

    it("shows the diff with the reason when the editor can't show a file", async () => {
      // The default backend of these tests refuses the file as binary.
      setup({ sides, status: makeStatus({ conflicted: [conflictFile("a.bin"), conflictFile("gone.txt", "deleted-by-them")] }) });
      await userEvent.click(screen.getByText("a.bin"));
      expect(await screen.findByRole("note")).toHaveTextContent("This file isn't UTF-8 text");
      expect(await screen.findByText("new a.bin")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show diff" })).toBeNull();
      expect(screen.getByRole("button", { name: "Use main" })).toBeInTheDocument();

      // A file one side deleted has nothing to merge line by line: the editor isn't even asked.
      invokeMock.mockClear();
      await userEvent.click(screen.getByText("gone.txt"));
      expect(await screen.findByText("new gone.txt")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent("One side has no version of this file");
      expect(invokeMock).not.toHaveBeenCalledWith("get_conflict_file", expect.anything());
    });
  });

  it("reports a failed hunk action and refreshes", async () => {
    mockBackend(invokeMock, {
      get_working_diff: () => "@@ -1 +1 @@\n-a\n+b\n",
      apply_selection: () => {
        throw "The file changed since its diff was shown.";
      },
    });
    const { onChanged, onError } = setup();
    await userEvent.click(screen.getByText("edit.ts"));
    await userEvent.click(await screen.findByRole("button", { name: "Stage hunk" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The file changed since its diff was shown."));
    expect(onChanged).toHaveBeenCalled();
  });
  it("stages, discards and unstages selected lines", async () => {
    const { onChanged } = setup();
    await userEvent.click(screen.getByText("edit.ts"));
    const added = (await screen.findByText("new src/edit.ts")).closest(".diff-line")!;
    fireEvent.mouseDown(added.querySelector(".gutter")!);
    await userEvent.click(screen.getByRole("button", { name: "Stage 1 line" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("apply_selection", {
      repo: "/repo",
      path: "src/edit.ts",
      staged: false,
      untracked: false,
      action: "stage",
      selection: [{ index: 0, header: "@@ -1 +1 @@", lines: [1] }],
    });

    fireEvent.mouseDown(screen.getByText("old src/edit.ts").closest(".diff-line")!.querySelector(".gutter")!);
    await userEvent.click(screen.getByRole("button", { name: "Discard 1 line" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith(
        "apply_selection",
        expect.objectContaining({ action: "discard", selection: [{ index: 0, header: "@@ -1 +1 @@", lines: [0] }] }),
      ),
    );

    await userEvent.click(screen.getByText("ready.rs"));
    const staged = (await screen.findByText("new ready.rs")).closest(".diff-line")!;
    fireEvent.mouseDown(staged.querySelector(".gutter")!);
    expect(screen.queryByRole("button", { name: "Discard 1 line" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Unstage 1 line" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith(
        "apply_selection",
        expect.objectContaining({ path: "ready.rs", staged: true, action: "unstage" }),
      ),
    );
  });
});
