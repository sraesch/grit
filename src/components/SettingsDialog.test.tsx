import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../api";
import { mockBackend, NO_MERGE_TOOL } from "../test/tauri";
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
    stored = { reposDir: "/home/ada/code", autoFetchMinutes: 10, ...NO_MERGE_TOOL };
    mockBackend(invokeMock, {
      get_settings: () => stored,
      set_settings: ({ settings }) => {
        const s = settings as Settings;
        if (s.reposDir === "/missing") throw "The folder /missing does not exist";
        if (s.mergeToolPath === "/nowhere/meld") throw "The merge tool /nowhere/meld does not exist";
        stored = { ...s, reposDir: s.reposDir?.replace(/^~/, "/home/ada") ?? null };
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
    expect(invokeMock).toHaveBeenCalledWith("set_settings", {
      settings: { reposDir: "~/projects", autoFetchMinutes: 10, ...NO_MERGE_TOOL },
    });
    expect(onSaved).toHaveBeenCalledWith({ reposDir: "/home/ada/projects", autoFetchMinutes: 10, ...NO_MERGE_TOOL });
  });

  it("stores an empty field as no folder", async () => {
    setup();
    await waitFor(() => expect(field()).toHaveValue("/home/ada/code"));
    await userEvent.clear(field());
    expect(field()).toHaveAttribute("placeholder", "Your home folder");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored).toEqual({ reposDir: null, autoFetchMinutes: 10, ...NO_MERGE_TOOL }));
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
    expect(stored).toEqual({ reposDir: "/home/ada/code", autoFetchMinutes: 10, ...NO_MERGE_TOOL });

    // Editing clears the message.
    await userEvent.type(field(), "x");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves how often to fetch automatically", async () => {
    stored = { reposDir: null, autoFetchMinutes: 45, ...NO_MERGE_TOOL };
    const { onSaved } = setup();
    const select = screen.getByLabelText("Fetch automatically");
    // A value set outside the usual choices is kept and shown.
    await waitFor(() => expect(select).toHaveDisplayValue("Every 45 minutes"));
    expect(select).toHaveAccessibleDescription(/never ask for passwords/);

    await userEvent.selectOptions(select, "Never");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ reposDir: null, autoFetchMinutes: 0, ...NO_MERGE_TOOL }));
  });

  it("follows git's merge tool until one is chosen", async () => {
    setup();
    const select = screen.getByLabelText("Merge tool");
    await waitFor(() => expect(select).toHaveDisplayValue("As configured in git"));
    expect(select).toHaveAccessibleDescription(/merge.guitool, else merge.tool/);
    expect(screen.queryByLabelText("Program")).toBeNull();
    expect(screen.queryByLabelText("Command")).toBeNull();
  });

  it("saves a named merge tool with the program picked in the native dialog", async () => {
    openMock.mockResolvedValue("/opt/meld/bin/meld");
    const { onSaved } = setup();
    const select = screen.getByLabelText("Merge tool");
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, "Meld");
    expect(screen.getByLabelText("Program")).toHaveAttribute("placeholder", "Found on the PATH");
    expect(screen.queryByLabelText("Command")).toBeNull();

    const browse = screen.getAllByRole("button", { name: "Browse…" });
    await userEvent.click(browse[browse.length - 1]);
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: false }));
    expect(screen.getByLabelText("Program")).toHaveValue("/opt/meld/bin/meld");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ mergeTool: "meld", mergeToolPath: "/opt/meld/bin/meld", mergeToolCommand: null }),
      ),
    );
  });

  it("saves a custom merge command", async () => {
    const { onSaved } = setup();
    const select = screen.getByLabelText("Merge tool");
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, "Custom command");
    const command = screen.getByLabelText("Command");
    expect(command).toHaveAccessibleDescription(/must wait until the tool is closed/);
    expect(screen.queryByLabelText("Program")).toBeNull();
    // userEvent treats "[" and "{" specially; this command has neither.
    await userEvent.type(command, ' bcomp "$LOCAL" "$REMOTE" "$BASE" "$MERGED" ');
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({
          mergeTool: "custom",
          mergeToolPath: null,
          mergeToolCommand: 'bcomp "$LOCAL" "$REMOTE" "$BASE" "$MERGED"',
        }),
      ),
    );
  });

  it("shows a stored tool git's list doesn't have, and merge tool errors next to it", async () => {
    stored = { ...stored, mergeTool: "mytool", mergeToolPath: "/nowhere/meld" };
    const { onClose } = setup();
    const select = screen.getByLabelText("Merge tool");
    await waitFor(() => expect(select).toHaveDisplayValue("mytool"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The merge tool /nowhere/meld does not exist");
    expect(screen.getByLabelText("Program")).toHaveAttribute("aria-invalid", "true");
    expect(field()).not.toHaveAttribute("aria-invalid");
    expect(onClose).not.toHaveBeenCalled();
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
