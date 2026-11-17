import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { file } from "../test/tauri";
import { FileList } from "./FileList";

describe("FileList", () => {
  const files = [file("src/app.ts"), file("new.txt", "?"), file("b.rs", "R", "a.rs")];

  it("shows files under their folders with a status badge", () => {
    render(<FileList files={files} selectedPath={null} onSelect={() => {}} />);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["▸src", "Mapp.ts", "Rb.rs", "+new.txt"]);
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
    render(<FileList files={files} selectedPath={null} onSelect={onSelect} actionLabel="Stage" onAction={onAction} />);

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
        actionLabel="Stage"
        onAction={() => {}}
        onFolderAction={onFolderAction}
      />,
    );
    const src = screen.getByText("src").closest("li")!;
    await userEvent.click(src.querySelector("button")!);
    expect(onFolderAction).toHaveBeenCalledWith([list[1], list[0]]);
    expect(src).toHaveAttribute("aria-expanded", "true");
  });

  it("has no folder action unless one is given", () => {
    render(<FileList files={files} selectedPath={null} onSelect={() => {}} actionLabel="Stage" onAction={() => {}} />);
    expect(screen.getByText("src").closest("li")!.querySelector("button")).toBeNull();
  });
});
