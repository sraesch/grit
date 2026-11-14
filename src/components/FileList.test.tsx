import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { file } from "../test/tauri";
import { FileList } from "./FileList";

describe("FileList", () => {
  const files = [file("src/app.ts"), file("new.txt", "?"), file("b.rs", "R", "a.rs")];

  it("shows name, directory and status badge", () => {
    render(<FileList files={files} selectedPath={null} onSelect={() => {}} />);
    const row = screen.getByText("app.ts").closest("li")!;
    expect(row).toHaveTextContent("src/");
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
});
