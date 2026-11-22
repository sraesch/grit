import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { FetchResult, GitProgress, RepoChanged, Settings, Stash, StashOptions, Status } from "./api";
import { file, makeCommit, makeStash, makeStatus, mockBackend } from "./test/tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const openMock = vi.mocked(open);

let emitRepoChanged: (payload: RepoChanged) => void = () => {};
let emitProgress: (payload: GitProgress) => void = () => {};
let emitOpenSettings: () => void = () => {};
let emitMenu: (event: string) => void = () => {};

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
    emitOpenSettings = () => emit("open-settings", null);
    emitMenu = (event) => emit(event, null);
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
    // The toolbar keeps its place, with nothing to fetch, pull or push.
    for (const name of ["Fetch", "Pull", "Push"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
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

  it("offers to initialize a folder that isn't a repository", async () => {
    const initRepo = vi.fn(({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "fresh" }));
    mockBackend(invokeMock, {
      get_settings: () => ({ reposDir: null }),
      is_repository: () => false,
      default_branch_name: () => "trunk",
      init_repo: initRepo,
      open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "fresh" }),
      get_status: () => makeStatus(),
      get_log: () => [],
      get_branches: () => ({ local: [], remote: [], tags: [], remotes: [] }),
    });
    openMock.mockResolvedValue("/work/fresh");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open repository…" }));

    const dialog = await screen.findByRole("dialog", { name: "Initialize Repository" });
    expect(within(dialog).getByText(/isn't a git repository yet/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Folder")).toHaveValue("/work/fresh");
    await waitFor(() => expect(within(dialog).getByLabelText("Initial branch")).toHaveValue("trunk"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Initialize" }));

    expect(initRepo).toHaveBeenCalledWith({ path: "/work/fresh", branch: "trunk" });
    expect(await screen.findByRole("tab", { name: "fresh" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a new repository in the repositories folder", async () => {
    mockBackend(invokeMock, {
      get_settings: () => ({ reposDir: "/home/ada/code" }),
      default_branch_name: () => "main",
      init_repo: () => {
        throw "/home/ada/code/ is already a git repository";
      },
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "New repository…" }));

    const dialog = await screen.findByRole("dialog", { name: "New Repository" });
    const folder = within(dialog).getByLabelText("Folder");
    await waitFor(() => expect(folder).toHaveValue("/home/ada/code/"));
    await waitFor(() => expect(within(dialog).getByLabelText("Initial branch")).toHaveValue("main"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    // Errors stay in the dialog, so the folder can be corrected.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already a git repository");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("opens the New Repository dialog from the menu", async () => {
    mockBackend(invokeMock, {
      get_settings: () => ({ reposDir: "/home/ada/code" }),
      default_branch_name: () => "main",
    });
    render(<App />);
    await screen.findByRole("heading", { name: "grit" });
    await act(async () => emitMenu("new-repository"));
    expect(await screen.findByRole("dialog", { name: "New Repository" })).toBeInTheDocument();
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

  it("opens the settings from the app menu", async () => {
    mockBackend(invokeMock, { get_settings: () => ({ reposDir: null }) });
    render(<App />);
    await waitFor(() => expect(listenMock).toHaveBeenCalledWith("open-settings", expect.any(Function)));
    act(() => emitOpenSettings());
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
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
      await userEvent.click(screen.getByRole("button", { name: "Open or create a repository" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Open Repository…" }));
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

    it("shows the active tab's fetch, pull and push in the toolbar", async () => {
      mockBackend(invokeMock, {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: nameOf(path as string) }),
        get_settings: () => ({ reposDir: null }),
        get_status: ({ repo }) =>
          makeStatus({ upstream: "origin/main", ...(repo === "/work/alpha" ? { ahead: 3 } : { behind: 4 }) }),
        get_log: () => [],
        get_branches: () => ({
          local: [{ name: "main", sha: "a", current: true, upstream: "origin/main", track: null }],
          remote: [{ name: "origin/main", sha: "b", current: false, upstream: null, track: null }],
          tags: [],
          remotes: [{ name: "origin", url: "/srv/repo.git" }],
        }),
      });
      render(<App />);
      await openViaDialog("/work/alpha");
      await openViaDialog("/work/beta");
      const toolbarButton = (name: RegExp) => within(screen.getByRole("banner")).getByRole("button", { name });

      // Only the active tab's buttons are there, with its counts.
      await waitFor(() => expect(toolbarButton(/^Pull/)).toHaveTextContent("Pull4"));
      expect(toolbarButton(/^Push/)).toHaveTextContent(/^Push$/);
      await userEvent.click(tab("alpha"));
      await waitFor(() => expect(toolbarButton(/^Push/)).toHaveTextContent("Push3"));
      expect(toolbarButton(/^Pull/)).toHaveTextContent(/^Pull$/);
      expect(within(screen.getByRole("banner")).getAllByRole("button", { name: /^Fetch/ })).toHaveLength(1);

      await userEvent.click(toolbarButton(/^Push/));
      expect(screen.getByRole("dialog", { name: "Push" })).toBeInTheDocument();
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

    it("deletes a branch from the sidebar, asking again when it has unmerged commits", async () => {
      let branchNames = ["main", "develop"];
      mockBackend(invokeMock, {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
        get_status: () => makeStatus({ branch: "main" }),
        get_log: () => [],
        get_branches: () => ({ ...branchList(), local: branchList().local.filter((b) => branchNames.includes(b.name)) }),
        delete_branch: ({ force }) => {
          if (!force) return "not-merged";
          branchNames = ["main"];
          return "deleted";
        },
      });
      render(<App />);
      await userEvent.pointer({ keys: "[MouseRight]", target: await screen.findByText("develop") });
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete Branch…" }));

      await userEvent.click(within(screen.getByRole("dialog", { name: "Delete Branch" })).getByRole("button", { name: "Delete" }));
      expect(invokeMock).toHaveBeenCalledWith("delete_branch", {
        repo: "/work/demo",
        name: "develop",
        force: false,
        deleteRemote: false,
      });

      // git kept the branch: deleting it anyway has to be confirmed.
      const again = await screen.findByRole("dialog", { name: "Delete Branch" });
      expect(within(again).getByRole("note")).toHaveTextContent("aren't merged");
      expect(screen.getByText("develop", { selector: ".branch-group .branch-name" })).toBeInTheDocument();
      await userEvent.click(within(again).getByRole("button", { name: "Delete Anyway" }));

      expect(invokeMock).toHaveBeenCalledWith("delete_branch", {
        repo: "/work/demo",
        name: "develop",
        force: true,
        deleteRemote: false,
      });
      expect(await screen.findByRole("status")).toHaveTextContent("Deleted branch develop (was a).");
      await waitFor(() => expect(screen.queryByText("develop")).not.toBeInTheDocument());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("deletes the remote branch along when asked", async () => {
      let deleted = false;
      const feature = { name: "feature", sha: "b", current: false, upstream: "origin/feature", track: null };
      mockBackend(invokeMock, {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
        get_status: () => makeStatus({ branch: "main" }),
        get_log: () => [],
        get_branches: () => ({
          local: [
            { name: "main", sha: "a", current: true, upstream: null, track: null },
            ...(deleted ? [] : [feature]),
          ],
          remote: deleted ? [] : [{ name: "origin/feature", sha: "b", current: false, upstream: null, track: null }],
          tags: [],
          remotes: [{ name: "origin", url: "/srv/demo.git" }],
        }),
        delete_branch: () => {
          deleted = true;
          return "deleted";
        },
      });
      render(<App />);
      await userEvent.pointer({ keys: "[MouseRight]", target: await screen.findByText("feature") });
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete Branch…" }));
      const dialog = screen.getByRole("dialog", { name: "Delete Branch" });
      await userEvent.click(within(dialog).getByRole("checkbox", { name: /origin\/feature/ }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      expect(invokeMock).toHaveBeenCalledWith("delete_branch", {
        repo: "/work/demo",
        name: "feature",
        force: false,
        deleteRemote: true,
      });
      expect(await screen.findByRole("status")).toHaveTextContent("Deleted branch feature and origin/feature (was b).");
    });

    it("stashes local changes, shows the stash and pops it", async () => {
      let stashes: Stash[] = [];
      let changes = [file("a.txt")];
      mockBackend(invokeMock, {
        open_repo: ({ path }) => ({ root: path, gitDir: `${path}/.git`, name: "demo" }),
        get_status: () => makeStatus({ branch: "main", unstaged: changes }),
        get_log: () => [],
        get_branches: branchList,
        get_stashes: () => stashes,
        stash: ({ options }) => {
          stashes = [makeStash("s1", (options as StashOptions).message)];
          changes = [];
          return stashes[0];
        },
        get_commit_details: ({ sha }) => ({ ...makeCommit(sha as string, "x"), files: [file("a.txt")], message: "" }),
        get_commit_file_diff: () => "@@ -1 +1 @@\n-old\n+stashed\n",
        apply_stash: () => {
          stashes = [];
          changes = [file("a.txt")];
          return { outcome: "applied", conflicts: 0 };
        },
      });
      render(<App />);
      await screen.findByRole("button", { name: /^main/ });
      await waitFor(() => expect(screen.getByRole("button", { name: "Stash" })).toBeEnabled());

      await userEvent.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
      await userEvent.type(within(screen.getByRole("dialog", { name: "Stash" })).getByRole("textbox"), "wip{Enter}");
      expect(invokeMock).toHaveBeenCalledWith("stash", {
        repo: "/work/demo",
        options: expect.objectContaining({ message: "wip" }),
      });
      expect(await screen.findByRole("status")).toHaveTextContent("Stashed local changes as \u201cwip\u201d.");

      // Nothing left to stash; the stash is in the sidebar and shows its changes.
      await waitFor(() => expect(screen.getByRole("button", { name: "Stash" })).toBeDisabled());
      await userEvent.click(await screen.findByText("wip", { selector: ".branch-group .branch-name" }));
      expect(await screen.findByText("stashed")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Pop" }));
      expect(invokeMock).toHaveBeenCalledWith("apply_stash", { repo: "/work/demo", sha: "s1", pop: true });
      expect(await screen.findByRole("status")).toHaveTextContent("Applied and deleted stash \u201cwip\u201d.");
      // Back in the changes view, with the changes restored.
      await waitFor(() => expect(screen.queryByRole("button", { name: "Pop" })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: /Local changes/ })).toHaveClass("active");
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

  describe("fetch, pull and push", () => {
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

    const pushButton = () => screen.getByRole("button", { name: /^Push/ });

    it("pushes the current branch to its upstream and reports the result", async () => {
      status = makeStatus({ upstream: "origin/main", ahead: 1, lastFetch: now() });
      mockBackend(invokeMock, {
        ...handlers,
        push: () => {
          status = makeStatus({ upstream: "origin/main", lastFetch: now() });
          return { outcome: "pushed", commits: 1, newTags: [], rejectedTags: [] };
        },
      });
      await ready();
      expect(pushButton()).toHaveTextContent("Push1");

      await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
      const dialog = screen.getByRole("dialog", { name: "Push" });
      expect(within(dialog).getByLabelText("Branch")).toHaveDisplayValue("main");
      await userEvent.click(within(dialog).getByRole("button", { name: "Push" }));

      expect(invokeMock).toHaveBeenCalledWith("push", {
        repo: "/work/demo",
        branch: "main",
        remote: "origin",
        remoteBranch: "main",
        setUpstream: false,
        tags: false,
        force: false,
      });
      expect(await screen.findByText("Pushed 1 commit from main to origin/main")).toBeInTheDocument();
      await waitFor(() => expect(pushButton()).toHaveTextContent(/^Push$/));
    });

    it("offers to pull or force push when a push is rejected", async () => {
      mockBackend(invokeMock, {
        ...handlers,
        push: ({ force }) =>
          force
            ? { outcome: "forced", commits: 1, newTags: [], rejectedTags: [] }
            : { outcome: "rejected", commits: 0, newTags: [], rejectedTags: [] },
      });
      await ready();
      await userEvent.click(pushButton());
      await userEvent.click(within(screen.getByRole("dialog", { name: "Push" })).getByRole("button", { name: "Push" }));

      expect(await screen.findByText(/^Push rejected: origin\/main has commits/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pull…" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Force Push…" }));

      const dialog = screen.getByRole("dialog", { name: "Push" });
      expect(within(dialog).getByLabelText("Force push")).toBeChecked();
      await userEvent.click(within(dialog).getByRole("button", { name: "Force Push" }));
      expect(invokeMock).toHaveBeenCalledWith("push", expect.objectContaining({ branch: "main", force: true }));
      expect(await screen.findByText("Force pushed main to origin/main")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Force Push…" })).toBeNull();
    });

    it("rebases onto another branch and leads to the conflicts when it stops", async () => {
      mockBackend(invokeMock, {
        ...handlers,
        get_divergence: () => ({ ahead: 1, behind: 3 }),
        rebase: () => {
          status = makeStatus({
            upstream: "origin/main",
            conflicted: [file("shared.txt", "U")],
            operation: { kind: "rebase", head: "main", step: 1, total: 1, message: null },
          });
          return { outcome: "conflicts", incoming: 3, rebased: 1, conflicts: 1 };
        },
        abort_operation: () => {
          status = makeStatus({ upstream: "origin/main" });
        },
      });
      await ready();
      const rebaseButton = screen.getByRole("button", { name: "Rebase" });
      expect(rebaseButton).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "All commits" }));

      await userEvent.keyboard("{Control>}{Shift>}E{/Shift}{/Control}");
      const dialog = screen.getByRole("dialog", { name: "Rebase" });
      // main is a base branch, so it starts on its upstream.
      expect(within(dialog).getByLabelText("Onto")).toHaveDisplayValue("origin/main");
      await userEvent.selectOptions(within(dialog).getByLabelText("Onto"), "origin/dev");
      await waitFor(() => expect(within(dialog).getByLabelText("Onto")).toHaveAccessibleDescription(/^Replays 1 commit of main/));
      await userEvent.click(within(dialog).getByRole("button", { name: "Rebase" }));

      expect(invokeMock).toHaveBeenCalledWith("rebase", { repo: "/work/demo", onto: "origin/dev", autostash: true });
      expect(await screen.findByText(/Rebasing main onto origin\/dev stopped with conflicts in 1 file/)).toBeInTheDocument();
      expect(await screen.findByText("Rebasing main (commit 1 of 1)")).toBeInTheDocument();
      // Back in Local changes to resolve the conflict; no second rebase meanwhile.
      expect(screen.getByText("shared.txt")).toBeInTheDocument();
      expect(rebaseButton).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Abort rebase" }));
      expect(invokeMock).toHaveBeenCalledWith("abort_operation", { repo: "/work/demo" });
      await waitFor(() => expect(screen.queryByText(/Rebasing main \(/)).toBeNull());
      expect(rebaseButton).toBeEnabled();
    });

    it("reports a successful rebase", async () => {
      mockBackend(invokeMock, {
        ...handlers,
        get_divergence: () => ({ ahead: 1, behind: 3 }),
        rebase: () => ({ outcome: "rebase", incoming: 3, rebased: 1, conflicts: 0 }),
      });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Rebase" }));
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByText("Rebased 1 commit of main onto origin/main (3 new)")).toBeInTheDocument();
    });

    it("merges a branch and leads to the conflicts when it stops", async () => {
      mockBackend(invokeMock, {
        ...handlers,
        get_branches: () => {
          const list = branchList();
          const feature = { name: "feature", sha: "d", current: false, upstream: null, track: null };
          return { ...list, local: [...list.local, feature], previous: "feature" };
        },
        get_divergence: () => ({ ahead: 1, behind: 2 }),
        merge: () => {
          status = makeStatus({
            upstream: "origin/main",
            conflicted: [file("shared.txt", "U")],
            operation: { kind: "merge", head: null, step: null, total: null, message: "Merge branch 'feature'" },
          });
          return { outcome: "conflicts", incoming: 2, conflicts: 1 };
        },
        abort_operation: () => {
          status = makeStatus({ upstream: "origin/main" });
        },
      });
      await ready();
      const mergeButton = screen.getByRole("button", { name: "Merge" });
      await waitFor(() => expect(mergeButton).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "All commits" }));

      await userEvent.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
      const dialog = screen.getByRole("dialog", { name: "Merge" });
      // It starts on the branch checked out before.
      expect(within(dialog).getByLabelText("Branch")).toHaveDisplayValue("feature");
      await waitFor(() => expect(within(dialog).getByLabelText("Branch")).toHaveAccessibleDescription(/^Creates a merge commit on main/));
      await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));

      expect(invokeMock).toHaveBeenCalledWith("merge", { repo: "/work/demo", source: "feature", mode: "ff", autostash: true });
      expect(await screen.findByText(/Merging feature into main stopped with conflicts in 1 file/)).toBeInTheDocument();
      expect(await screen.findByText("Merge in progress")).toBeInTheDocument();
      // Back in Local changes, with the merge message ready to commit once resolved.
      expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("Merge branch 'feature'");
      expect(mergeButton).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Abort merge" }));
      expect(invokeMock).toHaveBeenCalledWith("abort_operation", { repo: "/work/demo" });
      await waitFor(() => expect(screen.queryByText("Merge in progress")).toBeNull());
      expect(mergeButton).toBeEnabled();
    });

    it("reports a merge and shows git's reason when it is refused", async () => {
      let refuse = false;
      mockBackend(invokeMock, {
        ...handlers,
        get_divergence: () => ({ ahead: 0, behind: 3 }),
        merge: () => {
          if (refuse) throw "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt";
          return { outcome: "fast-forward", incoming: 3, conflicts: 0 };
        },
      });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Merge" }));
      // main is a base branch without a previous branch: it starts on the other base branch or the upstream.
      expect(within(screen.getByRole("dialog", { name: "Merge" })).getByLabelText("Branch")).toHaveDisplayValue("origin/main");
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByText("Moved main forward to origin/main (3 commits)")).toBeInTheDocument();

      refuse = true;
      await userEvent.click(screen.getByRole("button", { name: "Merge" }));
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByText(/would be overwritten by merge/)).toBeInTheDocument();
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
