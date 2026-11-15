import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../api";
import { mockBackend } from "../test/tauri";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);

let stored: Settings;

function setup() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<SettingsDialog onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

const field = () => screen.getByLabelText("Repositories folder");

describe("SettingsDialog", () => {
  beforeEach(() => {
    stored = { reposDir: "/home/ada/code" };
    mockBackend(invokeMock, {
      get_settings: () => stored,
      set_settings: ({ settings }) => {
        const s = settings as Settings;
        if (s.reposDir === "/missing") throw "The folder /missing does not exist";
        stored = { reposDir: s.reposDir?.replace(/^~/, "/home/ada") ?? null };
        return stored;
      },
    });
  });

  it("shows the stored folder and focuses it", async () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    expect(field()).toHaveFocus();
    expect(field()).toHaveAccessibleDescription(/Opening a repository starts here/);
  });

  it("saves the typed folder as the backend normalized it", async () => {
    const { onSaved, onClose } = setup();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    await userEvent.clear(field());
    await userEvent.type(field(), "~/projects{Enter}");

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("set_settings", { settings: { reposDir: "~/projects" } });
    expect(onSaved).toHaveBeenCalledWith({ reposDir: "/home/ada/projects" });
  });

  it("stores an empty field as no folder", async () => {
    setup();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    await userEvent.clear(field());
    expect(field()).toHaveAttribute("placeholder", "Your home folder");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored).toEqual({ reposDir: null }));
  });

  it("picks the folder with the native dialog, starting at the current one", async () => {
    openMock.mockResolvedValue("/data/repos");
    setup();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    await userEvent.click(screen.getByRole("button", { name: "Browse…" }));

    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/home/ada/code" }));
    expect(field()).toHaveValue("/data/repos");
  });

  it("keeps the dialog open and explains invalid folders", async () => {
    const { onClose } = setup();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    await userEvent.clear(field());
    await userEvent.type(field(), "/missing{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("The folder /missing does not exist");
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(onClose).not.toHaveBeenCalled();
    expect(stored).toEqual({ reposDir: "/home/ada/code" });

    // Editing clears the message.
    await userEvent.type(field(), "x");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes without saving on Cancel and Escape", async () => {
    const { onClose } = setup();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    await userEvent.type(field(), "/other");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(invokeMock).not.toHaveBeenCalledWith("set_settings", expect.anything());
  });
});
