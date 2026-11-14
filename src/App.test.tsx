import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { RepoChanged } from "./api";
import { file, makeStatus, mockBackend } from "./test/tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const openMock = vi.mocked(open);

let emitRepoChanged: (payload: RepoChanged) => void = () => {};

function backend(statusFn = () => makeStatus({ unstaged: [file("a.txt")] })) {
  mockBackend(invokeMock, {
    open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
    get_status: statusFn,
    get_log: () => [],
    get_branches: () => ({ local: [], remote: [], tags: [] }),
  });
}

describe("App", () => {
  beforeEach(() => {
    listenMock.mockImplementation(async (_event, handler) => {
      emitRepoChanged = (payload) => (handler as (e: { payload: RepoChanged }) => void)({ payload });
      return () => {};
    });
    backend();
  });

  it("shows the welcome screen without a repository", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "grit" })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("opens a repository chosen in the dialog and remembers it", async () => {
    openMock.mockResolvedValue("/work/demo");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open repository…" }));

    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(localStorage.getItem("lastRepo")).toBe("/work/demo");
  });

  it("reopens the last repository on start", async () => {
    localStorage.setItem("lastRepo", "/work/demo");
    render(<App />);
    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/work/demo" });
  });

  it("refreshes the status when the watcher reports changes", async () => {
    localStorage.setItem("lastRepo", "/work/demo");
    let files = [file("a.txt")];
    backend(() => makeStatus({ unstaged: files }));
    render(<App />);
    expect(await screen.findByText("a.txt")).toBeInTheDocument();

    files = [file("a.txt"), file("b.txt")];
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    act(() => emitRepoChanged({ worktree: true, refs: false }));
    expect(await screen.findByText("b.txt")).toBeInTheDocument();
  });

  it("shows backend errors and lets the user dismiss them", async () => {
    mockBackend(invokeMock, {
      open_repo: () => {
        throw "/tmp is not inside a git repository";
      },
    });
    openMock.mockResolvedValue("/tmp");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open repository…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("/tmp is not inside a git repository");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
