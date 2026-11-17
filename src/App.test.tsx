import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { FetchResult, GitProgress, RepoChanged, Settings, Status } from "./api";
import { file, makeStatus, mockBackend } from "./test/tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const openMock = vi.mocked(open);

let emitRepoChanged: (payload: RepoChanged) => void = () => {};
let emitProgress: (payload: GitProgress) => void = () => {};

function backend(statusFn = () => makeStatus({ unstaged: [file("a.txt")] })) {
  mockBackend(invokeMock, {
    open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
    get_status: statusFn,
    get_log: () => [],
    get_branches: () => ({ local: [], remote: [], tags: [], remotes: [] }),
  });
}

describe("App", () => {
  beforeEach(() => {
    // Every open tab subscribes; an event reaches all current subscribers, like Tauri's.
    const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => handlers.get(event)?.forEach((h) => h({ payload }));
    emitRepoChanged = (payload) => emit("repo-changed", payload);
    emitProgress = (payload) => emit("git-progress", payload);
    listenMock.mockImplementation(async (event, handler) => {
      const h = handler as (e: { payload: unknown }) => void;
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(h);
      return () => handlers.get(event)!.delete(h);
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
        get_branches: () => ({ local: [], remote: [], tags: [], remotes: [] }),
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
      await waitFor(() => expect(listenMock.mock.calls.filter(([e]) => e === "repo-changed")).toHaveLength(2));
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
      remotes: [{ name: "origin", url: "/srv/demo.git" }],
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

  describe("fetch and pull", () => {
    const now = () => Math.floor(Date.now() / 1000);
    let status: Status;
    let settings: Settings | null;
    let handlers: Record<string, (args: Record<string, unknown>) => unknown>;

    const branchList = () => ({
      local: [{ name: "main", sha: "a", current: true, upstream: "origin/main", track: "[behind 2]" }],
      remote: [
        { name: "origin/main", sha: "b", current: false, upstream: null, track: null },
        { name: "origin/dev", sha: "c", current: false, upstream: null, track: null },
      ],
      tags: [],
      remotes: [{ name: "origin", url: "git@example.com:ada/demo.git" }],
    });

    beforeEach(() => {
      localStorage.setItem("lastRepo", "/work/demo");
      status = makeStatus({ upstream: "origin/main", behind: 2, lastFetch: now() });
      settings = null;
      handlers = {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
        get_status: () => status,
        get_log: () => [],
        get_branches: branchList,
        get_settings: () => {
          if (!settings) throw "no settings";
          return settings;
        },
      };
      mockBackend(invokeMock, handlers);
    });

    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const pullButton = () => screen.getByRole("button", { name: /^Pull/ });

    async function ready() {
      render(<App />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled());
    }

    it("fetches the chosen remote, showing progress and then what changed", async () => {
      const result = deferred<FetchResult>();
      mockBackend(invokeMock, { ...handlers, fetch: () => result.promise });
      await ready();

      await userEvent.click(screen.getByRole("button", { name: "Fetch" }));
      const dialog = screen.getByRole("dialog", { name: "Fetch" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Fetch" }));
      expect(invokeMock).toHaveBeenCalledWith("fetch", {
        repo: "/work/demo",
        remote: "origin",
        prune: true,
        tags: false,
        background: false,
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(await screen.findByText("Fetching origin…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();

      act(() => emitProgress({ root: "/work/other", text: "Receiving objects: 99%" }));
      act(() => emitProgress({ root: "/work/demo", text: "Receiving objects:  45% (45/100)" }));
      expect(screen.getByText(/Receiving objects: 45% \(45\/100\)/)).toBeInTheDocument();
      expect(screen.queryByText(/99%/)).toBeNull();

      await act(async () =>
        result.resolve({ newBranches: ["origin/x"], updatedBranches: ["origin/main"], deletedBranches: [], newTags: [] }),
      );
      expect(await screen.findByText("Fetched origin: 1 new branch, 1 updated")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
      expect(screen.queryByText(/Fetched origin/)).toBeNull();
    });

    it("shows why a fetch failed", async () => {
      mockBackend(invokeMock, {
        ...handlers,
        fetch: () => {
          throw "fatal: Could not read from remote repository.";
        },
      });
      await ready();
      await userEvent.keyboard("{Control>}{Shift>}F{/Shift}{/Control}");
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not read from remote repository");
    });

    it("pulls the upstream and reports the result", async () => {
      mockBackend(invokeMock, {
        ...handlers,
        pull: () => {
          status = makeStatus({ upstream: "origin/main", lastFetch: now() });
          return { outcome: "fast-forward", incoming: 2, rebased: 0, conflicts: 0 };
        },
      });
      await ready();
      expect(pullButton()).toHaveTextContent("Pull2");

      await userEvent.keyboard("{Control>}{Shift>}L{/Shift}{/Control}");
      const dialog = screen.getByRole("dialog", { name: "Pull" });
      expect(within(dialog).getByLabelText("Pull from")).toHaveDisplayValue("origin/main");
      await userEvent.click(within(dialog).getByRole("button", { name: "Pull" }));

      expect(invokeMock).toHaveBeenCalledWith("pull", {
        repo: "/work/demo",
        remote: "origin",
        branch: "main",
        rebase: false,
        autostash: true,
      });
      expect(await screen.findByText("Pulled 2 commits from origin/main into main")).toBeInTheDocument();
      await waitFor(() => expect(pullButton()).toHaveTextContent(/^Pull$/));
    });

    it("leads to the conflicts when a pull stops, and aborts the merge on request", async () => {
      const merging = () =>
        makeStatus({
          upstream: "origin/main",
          behind: 1,
          ahead: 1,
          conflicted: [file("shared.txt", "U")],
          operation: { kind: "merge", head: null, step: null, total: null, message: "Merge branch 'main' of example.com" },
        });
      mockBackend(invokeMock, {
        ...handlers,
        pull: () => {
          status = merging();
          return { outcome: "conflicts", incoming: 1, rebased: 0, conflicts: 1 };
        },
        abort_operation: () => {
          status = makeStatus({ upstream: "origin/main", behind: 1, ahead: 1 });
        },
      });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "All commits" }));
      await userEvent.click(pullButton());
      await userEvent.click(within(screen.getByRole("dialog", { name: "Pull" })).getByRole("button", { name: "Pull" }));

      expect(await screen.findByText(/stopped with conflicts in 1 file/)).toBeInTheDocument();
      const banner = await screen.findByText("Merge in progress");
      expect(banner.closest("[role=status]")).toHaveTextContent("Resolve the conflicts in 1 file");
      // Back in Local changes, with the merge message ready to commit once resolved.
      expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("Merge branch 'main' of example.com");
      expect(screen.getByText("shared.txt")).toBeInTheDocument();
      expect(pullButton()).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Abort merge" }));
      expect(invokeMock).toHaveBeenCalledWith("abort_operation", { repo: "/work/demo" });
      await waitFor(() => expect(screen.queryByText("Merge in progress")).toBeNull());
    });

    it("fetches in the background when the last fetch is older than the interval", async () => {
      settings = { reposDir: null, autoFetchMinutes: 10 };
      status = makeStatus({ upstream: "origin/main", lastFetch: now() - 3600 });
      mockBackend(invokeMock, {
        ...handlers,
        fetch: () => {
          throw "ssh: Could not resolve hostname example.com";
        },
      });
      render(<App />);

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("fetch", {
          repo: "/work/demo",
          remote: null,
          prune: false,
          tags: false,
          background: true,
        }),
      );
      // A failed automatic fetch is reported quietly on the button, not as an error.
      const button = await screen.findByRole("button", { name: /^Fetch/ });
      await waitFor(() => expect(within(button).getByLabelText("automatic fetch failed")).toBeInTheDocument());
      expect(button).toHaveAttribute("title", expect.stringContaining("Could not resolve hostname"));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("doesn't fetch in the background when the last fetch is recent or it is turned off", async () => {
      settings = { reposDir: null, autoFetchMinutes: 10 };
      const { unmount } = render(<App />);
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_settings"));
      await screen.findByRole("button", { name: "Fetch" });
      unmount();

      settings = { reposDir: null, autoFetchMinutes: 0 };
      status = makeStatus({ lastFetch: null });
      render(<App />);
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_settings"));
      await screen.findByRole("button", { name: "Fetch" });
      expect(invokeMock).not.toHaveBeenCalledWith("fetch", expect.anything());
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
