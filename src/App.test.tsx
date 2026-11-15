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
    // Every open tab subscribes; an event reaches all current subscribers, like Tauri's.
    const handlers = new Set<(e: { payload: RepoChanged }) => void>();
    emitRepoChanged = (payload) => handlers.forEach((h) => h({ payload }));
    listenMock.mockImplementation(async (_event, handler) => {
      const h = handler as (e: { payload: RepoChanged }) => void;
      handlers.add(h);
      return () => handlers.delete(h);
    });
    backend();
  });

  it("shows the welcome screen without a repository", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "grit" })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("opens a repository chosen in the dialog and remembers it", async () => {
    openMock.mockResolvedValue("/work/demo");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open repository…" }));

    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("openRepos")).toBe(JSON.stringify(["/work/demo"])));
    expect(localStorage.getItem("activeRepo")).toBe("/work/demo");
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
    act(() => emitRepoChanged({ root: "/work/demo", worktree: true, refs: false }));
    expect(await screen.findByText("b.txt")).toBeInTheDocument();
  });

  describe("tabs", () => {
    const nameOf = (path: string) => path.split("/").pop()!;
    let closed: string[];

    beforeEach(() => {
      closed = [];
      mockBackend(invokeMock, {
        open_repo: ({ path }) => {
          if (path === "/gone/old") throw "/gone/old is not inside a git repository";
          // Opening from a subfolder resolves to the repository root.
          const root = (path as string).replace(/\/src$/, "");
          return { root, gitDir: `${root}/.git`, name: nameOf(root) };
        },
        close_repo: ({ root }) => {
          closed.push(root as string);
        },
        get_settings: () => ({ reposDir: null }),
        get_status: ({ repo }) => makeStatus({ unstaged: [file(`${nameOf(repo as string)}.txt`)] }),
        get_log: () => [],
        get_branches: () => ({ local: [], remote: [], tags: [] }),
      });
    });

    const strip = () => screen.getByRole("tablist", { name: "Open repositories" });
    const tab = (name: string) => within(strip()).getByRole("tab", { name });
    const tabNames = () => within(strip()).queryAllByRole("tab").map((t) => t.textContent);
    // Hidden panels have no computed accessible name, so match the label attribute directly.
    const panel = (name: string) =>
      screen.getAllByRole("tabpanel", { hidden: true }).find((p) => p.getAttribute("aria-label") === name)!;

    async function openViaDialog(path: string) {
      openMock.mockResolvedValueOnce(path);
      await userEvent.click(screen.getByRole("button", { name: "Open repository" }));
    }

    it("opens repositories side by side and switches between them", async () => {
      render(<App />);
      await openViaDialog("/work/alpha");
      expect(await screen.findByText("alpha.txt")).toBeVisible();
      await openViaDialog("/work/beta");
      expect(await screen.findByText("beta.txt")).toBeVisible();

      expect(tab("beta")).toHaveAttribute("aria-selected", "true");
      expect(panel("alpha")).not.toBeVisible();
      await userEvent.click(tab("alpha"));
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("alpha.txt")).toBeVisible();
      expect(screen.getByText("beta.txt")).not.toBeVisible();
      expect(localStorage.getItem("openRepos")).toBe(JSON.stringify(["/work/alpha", "/work/beta"]));
      expect(localStorage.getItem("activeRepo")).toBe("/work/alpha");
    });

    it("shows the existing tab when a repository is opened again", async () => {
      render(<App />);
      await openViaDialog("/work/alpha");
      await openViaDialog("/work/beta");
      await screen.findByText("beta.txt");
      await openViaDialog("/work/alpha/src");
      await waitFor(() => expect(tab("alpha")).toHaveAttribute("aria-selected", "true"));
      expect(tabNames()).toHaveLength(2);
    });

    it("keeps each tab's state while switching", async () => {
      render(<App />);
      await openViaDialog("/work/alpha");
      await screen.findByText("alpha.txt");
      await userEvent.type(within(panel("alpha")).getByRole("textbox", { name: "Commit message" }), "Half-written");
      await openViaDialog("/work/beta");
      await screen.findByText("beta.txt");
      await userEvent.click(tab("alpha"));
      expect(within(panel("alpha")).getByRole("textbox", { name: "Commit message" })).toHaveValue("Half-written");
    });

    it("closes tabs, showing the neighbor and finally the welcome screen", async () => {
      render(<App />);
      for (const name of ["alpha", "beta", "gamma"]) await openViaDialog(`/work/${name}`);
      await screen.findByText("gamma.txt");
      await userEvent.click(tab("beta"));

      await userEvent.click(screen.getByRole("button", { name: "Close beta" }));
      expect(tabNames()).not.toContain("beta");
      expect(tab("gamma")).toHaveAttribute("aria-selected", "true");
      expect(closed).toEqual(["/work/beta"]);

      await userEvent.click(screen.getByRole("button", { name: "Close gamma" }));
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
      await userEvent.click(screen.getByRole("button", { name: "Close alpha" }));
      expect(await screen.findByRole("button", { name: "Open repository…" })).toBeInTheDocument();
      expect(localStorage.getItem("openRepos")).toBe("[]");
    });

    it("closes and cycles tabs from the keyboard", async () => {
      render(<App />);
      for (const name of ["alpha", "beta", "gamma"]) await openViaDialog(`/work/${name}`);
      await screen.findByText("gamma.txt");

      await userEvent.keyboard("{Control>}{Tab}{/Control}");
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
      await userEvent.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
      expect(tab("gamma")).toHaveAttribute("aria-selected", "true");
      await userEvent.keyboard("{Control>}w{/Control}");
      expect(tabNames()).toEqual(["alpha", "beta"]);
      expect(tab("beta")).toHaveAttribute("aria-selected", "true");
    });

    it("tells repositories with the same name apart", async () => {
      render(<App />);
      await openViaDialog("/work/app");
      await openViaDialog("/personal/app");
      await waitFor(() => expect(tabNames()).toEqual(["work/app", "personal/app"]));
    });

    it("reopens the tabs of the last session and reports missing repositories", async () => {
      localStorage.setItem("openRepos", JSON.stringify(["/work/alpha", "/gone/old", "/work/beta"]));
      localStorage.setItem("activeRepo", "/work/alpha");
      render(<App />);

      await waitFor(() => expect(tabNames()).toEqual(["alpha", "beta"]));
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not reopen:");
      expect(screen.getByRole("alert")).toHaveTextContent("/gone/old");
      await waitFor(() => expect(localStorage.getItem("openRepos")).toBe(JSON.stringify(["/work/alpha", "/work/beta"])));
    });

    it("refreshes only the tab whose repository changed", async () => {
      localStorage.setItem("openRepos", JSON.stringify(["/work/alpha", "/work/beta"]));
      render(<App />);
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      await screen.findByText("alpha.txt");
      await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
      invokeMock.mockClear();

      act(() => emitRepoChanged({ root: "/work/beta", worktree: true, refs: false }));
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_status", { repo: "/work/beta" }));
      expect(invokeMock).not.toHaveBeenCalledWith("get_status", { repo: "/work/alpha" });
    });
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
