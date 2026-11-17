import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor, within } from "@testing-library/react";
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
});
