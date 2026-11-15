import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

  it("starts the Open dialog in the repositories folder from the settings", async () => {
    mockBackend(invokeMock, { get_settings: () => ({ reposDir: "/home/ada/code" }) });
    openMock.mockResolvedValue(null);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open repository…" }));
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/home/ada/code" }));
  });

  it("opens the settings from the toolbar and with Ctrl+,", async () => {
    mockBackend(invokeMock, { get_settings: () => ({ reposDir: null }) });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();

    await userEvent.keyboard("{Control>},{/Control}");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
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

  it("opens and closes the About dialog", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByRole("dialog", { name: "About grit" })).toHaveTextContent(`Version ${__APP_VERSION__}`);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About" })).toHaveFocus();
  });

  describe("switching branches", () => {
    let current = "main";
    const branchList = () => ({
      local: ["main", "develop"].map((name) => ({ name, sha: "a", current: name === current, upstream: null, track: null })),
      remote: [{ name: "origin/release", sha: "b", current: false, upstream: null, track: null }],
      tags: [],
    });

    beforeEach(() => {
      current = "main";
      localStorage.setItem("lastRepo", "/work/demo");
      mockBackend(invokeMock, {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
        get_status: () => makeStatus({ branch: current }),
        get_log: () => [],
        get_branches: branchList,
        checkout_branch: ({ branch }) => {
          current = branch as string;
        },
        checkout_remote_branch: () => {
          current = "release";
        },
        create_branch: ({ name }) => {
          current = name as string;
        },
      });
    });

    it("switches from the branch button and refreshes", async () => {
      render(<App />);
      const button = await screen.findByRole("button", { name: /^main/ });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_branches", { repo: "/work/demo" }));
      await userEvent.click(button);
      await userEvent.click(within(screen.getByRole("dialog", { name: "Switch branch" })).getByText("develop"));

      expect(invokeMock).toHaveBeenCalledWith("checkout_branch", { repo: "/work/demo", branch: "develop" });
      expect(await screen.findByRole("button", { name: /^develop/ })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens with Ctrl+B, tracks remote branches and creates new ones", async () => {
      render(<App />);
      await screen.findByRole("button", { name: /^main/ });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_branches", { repo: "/work/demo" }));

      await userEvent.keyboard("{Control>}b{/Control}");
      await userEvent.keyboard("release{Enter}");
      expect(invokeMock).toHaveBeenCalledWith("checkout_remote_branch", { repo: "/work/demo", branch: "origin/release" });
      expect(await screen.findByRole("button", { name: /^release/ })).toBeInTheDocument();

      await userEvent.keyboard("{Control>}b{/Control}");
      await userEvent.keyboard("hotfix{Enter}");
      expect(invokeMock).toHaveBeenCalledWith("create_branch", { repo: "/work/demo", name: "hotfix" });
      expect(await screen.findByRole("button", { name: /^hotfix/ })).toBeInTheDocument();
    });

    it("shows why git refused to switch", async () => {
      mockBackend(invokeMock, {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
        get_status: () => makeStatus({ branch: "main" }),
        get_log: () => [],
        get_branches: branchList,
        checkout_branch: () => {
          throw "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt";
        },
      });
      render(<App />);
      await screen.findByRole("button", { name: /^main/ });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_branches", { repo: "/work/demo" }));
      await userEvent.keyboard("{Control>}b{/Control}develop{Enter}");

      expect(await screen.findByRole("alert")).toHaveTextContent("would be overwritten by checkout");
      expect(screen.getByRole("button", { name: /^main/ })).toBeEnabled();
    });
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
