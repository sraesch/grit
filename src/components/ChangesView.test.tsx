import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "@testing-library/react";
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
