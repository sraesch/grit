import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { file } from "../test/tauri";
import { FileList } from "./FileList";

describe("FileList", () => {
  const files = [file("src/app.ts"), file("new.txt", "?"), file("b.rs", "R", "a.rs")];

  it("shows files under their folders with a status badge", () => {
    render(<FileList files={files} selectedPath={null} onSelect={() => {}} />);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["src", "Mapp.ts", "Rb.rs", "+new.txt"]);
    const row = screen.getByText("app.ts").closest("li")!;
    expect(row).toHaveAttribute("title", "src/app.ts");
    expect(row.querySelector(".status-badge")).toHaveTextContent("M");
    expect(screen.getByText("new.txt").closest("li")!.querySelector(".status-badge")).toHaveClass("status-untracked");
    expect(screen.getByText("b.rs").closest("li")).toHaveAttribute("title", "a.rs → b.rs");
  });

  it("marks the selected file", () => {
    render(<FileList files={files} selectedPath="new.txt" onSelect={() => {}} />);
    expect(screen.getByText("new.txt").closest("li")).toHaveClass("selected");
    expect(screen.getByText("app.ts").closest("li")).not.toHaveClass("selected");
  });

  it("selects on click and activates on double-click", async () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(<FileList files={files} selectedPath={null} onSelect={onSelect} onActivate={onActivate} />);

    await userEvent.dblClick(screen.getByText("app.ts"));
    expect(onSelect).toHaveBeenCalledWith(files[0]);
    expect(onActivate).toHaveBeenCalledWith(files[0]);
  });

  it("runs the row action without changing the selection", async () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    const actions = [{ label: "Stage", onFile: onAction }];
    render(<FileList files={files} selectedPath={null} onSelect={onSelect} actions={actions} />);

    const row = screen.getByText("new.txt").closest("li")!;
    await userEvent.click(row.querySelector("button")!);
    expect(onAction).toHaveBeenCalledWith(files[1]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("collapses and expands folders", async () => {
    const onSelect = vi.fn();
    render(
      <FileList
        files={[file("src/a.ts"), file("src/lib/b.ts"), file("c.txt")]}
        selectedPath={null}
        onSelect={onSelect}
      />,
    );
    const src = screen.getByText("src").closest("li")!;
    expect(src).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(src);
    expect(src).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("lib")).not.toBeInTheDocument();
    expect(src).toHaveTextContent("2");
    expect(screen.getByText("c.txt")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.click(src);
    expect(screen.getByText("b.ts")).toBeInTheDocument();
  });

  it("keeps folders collapsed when the files change", async () => {
    const { rerender } = render(<FileList files={[file("src/a.ts")]} selectedPath={null} onSelect={() => {}} />);
    await userEvent.click(screen.getByText("src"));
    rerender(<FileList files={[file("src/a.ts"), file("src/b.ts")]} selectedPath={null} onSelect={() => {}} />);
    expect(screen.queryByText("b.ts")).not.toBeInTheDocument();
  });

  it("runs the folder action on every file in the folder without toggling it", async () => {
    const onFolderAction = vi.fn();
    const list = [file("src/a.ts"), file("src/lib/b.ts"), file("c.txt")];
    render(
      <FileList
        files={list}
        selectedPath={null}
        onSelect={() => {}}
        actions={[{ label: "Stage", onFile: () => {}, onFolder: onFolderAction }]}
      />,
    );
    const src = screen.getByText("src").closest("li")!;
    await userEvent.click(src.querySelector("button")!);
    expect(onFolderAction).toHaveBeenCalledWith([list[1], list[0]]);
    expect(src).toHaveAttribute("aria-expanded", "true");
  });

  it("has no folder action unless one is given", () => {
    const actions = [{ label: "Stage", onFile: () => {} }];
    render(<FileList files={files} selectedPath={null} onSelect={() => {}} actions={actions} />);
    expect(screen.getByText("src").closest("li")!.querySelector("button")).toBeNull();
  });

  it("shows several row actions, marking destructive ones", async () => {
    const onDiscard = vi.fn();
    const onActivate = vi.fn();
    render(
      <FileList
        files={files}
        selectedPath={null}
        onSelect={() => {}}
        onActivate={onActivate}
        actions={[
          { label: "Stage", onFile: () => {} },
          { label: "Discard", danger: true, onFile: onDiscard, fileTitle: (f) => `Discard ${f.path}` },
        ]}
      />,
    );
    const row = screen.getByText("new.txt").closest("li")!;
    const buttons = within(row).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Stage", "Discard"]);
    expect(buttons[1]).toHaveClass("row-action", "danger");
    expect(buttons[1]).toHaveAttribute("title", "Discard new.txt");
    await userEvent.dblClick(buttons[1]);
    expect(onDiscard).toHaveBeenCalledWith(files[1]);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("reports right-clicks on files and folders", () => {
    const onContextMenu = vi.fn();
    const list = [file("src/a.ts"), file("src/lib/b.ts"), file("c.txt")];
    render(<FileList files={list} selectedPath={null} onSelect={() => {}} onContextMenu={onContextMenu} />);

    fireEvent.contextMenu(screen.getByText("c.txt"), { clientX: 10, clientY: 20 });
    expect(onContextMenu).toHaveBeenLastCalledWith({ kind: "file", file: list[2] }, 10, 20);

    fireEvent.contextMenu(screen.getByText("src"), { clientX: 5, clientY: 6 });
    expect(onContextMenu).toHaveBeenLastCalledWith({ kind: "folder", path: "src/", files: [list[1], list[0]] }, 5, 6);
  });
});
