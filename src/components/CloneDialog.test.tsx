import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitProgress } from "../api";
import { mockBackend } from "../test/tauri";
import { CloneDialog } from "./CloneDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const openMock = vi.mocked(open);

let emitProgress: (payload: GitProgress) => void = () => {};
let unlisten = vi.fn();

describe("CloneDialog", () => {
  beforeEach(() => {
    vi.mocked(homeDir).mockResolvedValue("/home/ada");
    unlisten = vi.fn();
    listenMock.mockImplementation(async (_event, handler) => {
      emitProgress = (payload) => (handler as (e: { payload: unknown }) => void)({ payload });
      return unlisten;
    });
  });

  function setup(reposDir: string | null, cloneRepo: (args: Record<string, unknown>) => unknown) {
    mockBackend(invokeMock, { get_settings: () => ({ reposDir, autoFetchMinutes: 10 }), clone_repo: cloneRepo });
    const onCloned = vi.fn();
    const onClose = vi.fn();
    render(<CloneDialog onCloned={onCloned} onClose={onClose} />);
    return { onCloned, onClose };
  }

  it("clones into a folder named after the repository in the repositories folder", async () => {
    let finish: (value: unknown) => void = () => {};
    const cloneRepo = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const { onCloned, onClose } = setup("/home/ada/code", cloneRepo);

    expect(screen.getByRole("button", { name: "Clone" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Repository URL"), "git@github.com:ada/grit.git");
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/home/ada/code/grit"));
    await userEvent.type(screen.getByLabelText("Branch"), "develop");
    await userEvent.click(screen.getByRole("button", { name: "Clone" }));

    expect(cloneRepo).toHaveBeenCalledWith({
      url: "git@github.com:ada/grit.git",
      dest: "/home/ada/code/grit",
      branch: "develop",
    });
    // Progress of other operations is ignored.
    act(() => emitProgress({ root: "/elsewhere", text: "Receiving objects:  10%" }));
    act(() => emitProgress({ root: "/home/ada/code/grit", text: "Receiving objects:  45% (450/1000)" }));
    expect(screen.getByRole("status")).toHaveTextContent("Receiving objects: 45% (450/1000)");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    const info = { root: "/home/ada/code/grit", gitDir: "/home/ada/code/grit/.git", name: "grit" };
    await act(async () => finish(info));
    expect(onCloned).toHaveBeenCalledWith(info);
    expect(onClose).toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalled();
  });

  it("falls back to the home folder and keeps a folder that was edited", async () => {
    const cloneRepo = vi.fn(() => {
      throw "fatal: repository 'https://example.com/x.git/' not found";
    });
    const { onCloned } = setup(null, cloneRepo);

    await userEvent.type(screen.getByLabelText("Repository URL"), "https://example.com/x.git");
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/home/ada/x"));
    const folder = screen.getByLabelText("Folder");
    await userEvent.clear(folder);
    await userEvent.type(folder, "/tmp/mine");
    await userEvent.type(screen.getByLabelText("Repository URL"), "y");
    expect(folder).toHaveValue("/tmp/mine");

    await userEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(cloneRepo).toHaveBeenCalledWith({ url: "https://example.com/x.gity", dest: "/tmp/mine", branch: null });
    expect(await screen.findByRole("alert")).toHaveTextContent("not found");
    expect(screen.getByRole("button", { name: "Clone" })).toBeEnabled();
    expect(onCloned).not.toHaveBeenCalled();
  });

  it("puts the clone inside a folder chosen with Browse…", async () => {
    setup("/home/ada/code", vi.fn());
    openMock.mockResolvedValue("/mnt/work");
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://example.com/team/app");
    await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
    expect(screen.getByLabelText("Folder")).toHaveValue("/mnt/work/app");
  });
});
