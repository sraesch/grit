import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictFile } from "../api";
import { ConflictSides } from "../conflict";
import { conflictFile, mockBackend } from "../test/tauri";
import { ConflictDraft, ConflictEditor } from "./ConflictEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const sides: ConflictSides = {
  ours: { name: "main", detail: "current branch" },
  theirs: { name: "feature", detail: "being merged" },
};

const conflict: ConflictFile = {
  token: "t1",
  markers: true,
  segments: [
    { kind: "common", text: "one\n" },
    { kind: "conflict", ours: "TWO\n", base: "two\n", theirs: "2\n" },
    { kind: "common", text: "three\n" },
    { kind: "conflict", ours: "", base: null, theirs: "four\n" },
    { kind: "common", text: "five\n" },
  ],
};

function setup(props: Partial<Parameters<typeof ConflictEditor>[0]> = {}) {
  const handlers = { onSaved: vi.fn(), onUnavailable: vi.fn(), onError: vi.fn() };
  const drafts = new Map<string, ConflictDraft>();
  const view = render(
    <ConflictEditor repo="/repo" file={conflictFile("src/app.ts")} sides={sides} drafts={drafts} {...handlers} {...props} />,
  );
  return { ...handlers, drafts, ...view };
}

/** The text of one of the three documents, by the name of its pane. */
const paneText = (name: string) => screen.getByRole("textbox", { name }).textContent;
const toolbar = () => within(screen.getByRole("toolbar", { name: "Conflict" }));
const saveButton = () => screen.getByRole("button", { name: "Save and mark resolved" });

describe("ConflictEditor", () => {
  beforeEach(() => {
    mockBackend(invokeMock, {
      get_conflict_file: () => conflict,
      save_conflict_file: () => undefined,
    });
  });

  it("shows our version, the result and their version", async () => {
    setup();
    expect(await screen.findByText("Conflict 1 of 2")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("get_conflict_file", { repo: "/repo", path: "src/app.ts" });

    expect(screen.getByRole("region", { name: "Ours: main" })).toHaveTextContent("main current branch");
    expect(screen.getByRole("region", { name: "Theirs: feature" })).toHaveTextContent("feature being merged");
    expect(paneText("Ours: main")).toContain("TWO");
    expect(paneText("Theirs: feature")).toContain("four");
    // Until they are resolved, the result shows what both sides started from.
    expect(paneText("Result")).toContain("two");
    expect(paneText("Result")).not.toContain("TWO");
    expect(paneText("Result")).toContain("Conflict 1 · unresolved");

    expect(screen.getByRole("status")).toHaveTextContent("2 conflicts left to resolve");
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute("title", "Resolve the remaining 2 conflicts first");
  });

  it("resolves each conflict with a side or both, and saves the result", async () => {
    const { onSaved, drafts } = setup();
    await screen.findByText("Conflict 1 of 2");

    await userEvent.click(toolbar().getByRole("button", { name: "Take main" }));
    expect(paneText("Result")).toContain("Conflict 1 · main");
    expect(screen.getByRole("status")).toHaveTextContent("1 conflict left to resolve");

    await userEvent.click(toolbar().getByRole("button", { name: "Next conflict" }));
    expect(screen.getByText("Conflict 2 of 2")).toBeInTheDocument();
    await userEvent.click(toolbar().getByRole("button", { name: "Take both…" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "main, then feature",
      "feature, then main",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "feature, then main" }));
    expect(paneText("Result")).toContain("Conflict 2 · feature, then main");
    expect(screen.getByRole("status")).toHaveTextContent("All conflicts resolved");

    // A conflict can be decided again.
    await userEvent.click(toolbar().getByRole("button", { name: "Previous conflict" }));
    await userEvent.click(toolbar().getByRole("button", { name: "Take feature" }));

    await userEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("save_conflict_file", {
      repo: "/repo",
      path: "src/app.ts",
      token: "t1",
      content: "one\n2\nthree\nfour\nfive\n",
    });
    // A saved result is no draft anymore.
    expect(drafts.size).toBe(0);
  });

  it("accepts a conflict as it is in the result", async () => {
    const { onSaved } = setup();
    await screen.findByText("Conflict 1 of 2");
    const keep = toolbar().getByRole("button", { name: "Keep as edited" });
    await userEvent.click(keep);
    expect(keep).toBeDisabled();
    expect(paneText("Result")).toContain("Conflict 1 · edited");
    await userEvent.click(toolbar().getByRole("button", { name: "Next conflict" }));
    await userEvent.click(toolbar().getByRole("button", { name: "Keep as edited" }));

    await userEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // The first conflict keeps its base, the second stays empty.
    expect(invokeMock).toHaveBeenCalledWith("save_conflict_file", expect.objectContaining({ content: "one\ntwo\nthree\nfive\n" }));
  });

  it("shows the base of the current conflict on request", async () => {
    setup();
    await screen.findByText("Conflict 1 of 2");
    expect(screen.queryByRole("region", { name: "Base" })).toBeNull();

    const toggle = toolbar().getByRole("button", { name: "Show base" });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const base = screen.getByRole("region", { name: "Base" });
    expect(base).toHaveTextContent("what both sides started from in conflict 1");
    expect(base).toHaveTextContent("two");

    await userEvent.click(toolbar().getByRole("button", { name: "Next conflict" }));
    expect(screen.getByRole("region", { name: "Base" })).toHaveTextContent("The sides have no common base here");
  });

  it("keeps an unsaved result as a draft for the next time the file is shown", async () => {
    const { drafts, unmount } = setup();
    await screen.findByText("Conflict 1 of 2");
    await userEvent.click(toolbar().getByRole("button", { name: "Take main" }));
    unmount();
    expect(drafts.get("src/app.ts")?.token).toBe("t1");

    setup({ drafts });
    // It opens on the first conflict that is still unresolved.
    expect(await screen.findByText("Conflict 2 of 2")).toBeInTheDocument();
    expect(paneText("Result")).toContain("Conflict 1 · main");
    expect(screen.getByRole("status")).toHaveTextContent("1 conflict left to resolve");
  });

  it("drops a draft of a conflict that changed in the meantime", async () => {
    const { drafts, unmount } = setup();
    await screen.findByText("Conflict 1 of 2");
    await userEvent.click(toolbar().getByRole("button", { name: "Take main" }));
    unmount();

    mockBackend(invokeMock, { get_conflict_file: () => ({ ...conflict, token: "t2" }) });
    setup({ drafts });
    expect(await screen.findByText("Conflict 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 conflicts left to resolve");
  });

  it("loads the conflict again when it changed before saving", async () => {
    let token = "t1";
    mockBackend(invokeMock, {
      get_conflict_file: () => ({ ...conflict, token }),
      save_conflict_file: () => {
        throw "The conflict changed since it was opened. Reload it and resolve it again.";
      },
    });
    const { onSaved, onError } = setup();
    await screen.findByText("Conflict 1 of 2");
    await userEvent.click(toolbar().getByRole("button", { name: "Keep as edited" }));
    await userEvent.click(toolbar().getByRole("button", { name: "Next conflict" }));
    await userEvent.click(toolbar().getByRole("button", { name: "Keep as edited" }));
    await userEvent.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The conflict changed since it was opened, so nothing was saved.");
    expect(saveButton()).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    token = "t2";
    await userEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 conflicts left to resolve"));
    expect(screen.queryByRole("alert")).toBeNull();
    // Loaded, refused to save, loaded again.
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("reports other errors of saving", async () => {
    mockBackend(invokeMock, {
      get_conflict_file: () => ({ ...conflict, segments: [{ kind: "common", text: "merged\n" }] }),
      save_conflict_file: () => {
        throw "fatal: unable to write new index file";
      },
    });
    const { onError } = setup();
    // Without conflicting lines the merged file can be saved as it is.
    expect(await screen.findByText("No conflicting lines")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Both sides merge without conflicting lines");
    await userEvent.click(saveButton());
    await waitFor(() => expect(onError).toHaveBeenCalledWith("fatal: unable to write new index file"));
  });

  it("warns when the file was already edited by hand", async () => {
    mockBackend(invokeMock, { get_conflict_file: () => ({ ...conflict, markers: false }) });
    setup();
    expect(await screen.findByRole("note")).toHaveTextContent("This file has no conflict markers left");
  });

  it("hands a file it can't show back with the reason", async () => {
    mockBackend(invokeMock, {
      get_conflict_file: () => {
        throw "This file isn't UTF-8 text, so it can't be resolved here.";
      },
    });
    const { onUnavailable } = setup();
    await waitFor(() =>
      expect(onUnavailable).toHaveBeenCalledWith("This file isn't UTF-8 text, so it can't be resolved here."),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows the controls of the whole file in its header", async () => {
    setup({ actions: <button>Use main</button> });
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use main" })).toBeInTheDocument();
    await screen.findByText("Conflict 1 of 2");
  });
});
