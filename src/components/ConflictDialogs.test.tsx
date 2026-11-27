import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConflictSides } from "../conflict";
import { conflictFile } from "../test/tauri";
import { MergeToolDialog, ResolveSideDialog } from "./ConflictDialogs";

const sides: ConflictSides = {
  ours: { name: "main", detail: "current branch" },
  theirs: { name: "feature", detail: "being merged" },
};

describe("ResolveSideDialog", () => {
  it("names the side and the files, and resolves on confirmation", async () => {
    const files = [conflictFile("src/a.ts"), conflictFile("src/gone.ts", "deleted-by-them")];
    const onResolve = vi.fn();
    render(<ResolveSideDialog files={files} side="theirs" sides={sides} onResolve={onResolve} onClose={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "Resolve Conflicts" });
    expect(dialog).toHaveTextContent("Resolve 2 conflicted files with feature (being merged)?");
    const items = within(dialog).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["src/a.ts", "src/gone.ts (deleted)"]);
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "The changes of main to these files are left out, along with anything edited in them by hand. " +
        "1 file that feature doesn't have will be deleted.",
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Use feature" }));
    expect(onResolve).toHaveBeenCalledWith(files, "theirs");
  });

  it("lists only the first files of a large folder", () => {
    const files = Array.from({ length: 13 }, (_, i) => conflictFile(`f${i}.txt`));
    render(<ResolveSideDialog files={files} side="ours" sides={sides} onResolve={() => {}} onClose={() => {}} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(11);
    expect(items[10]).toHaveTextContent("and 3 more");
    expect(screen.getByRole("note")).not.toHaveTextContent("deleted");
  });

  it("closes without resolving", async () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    render(
      <ResolveSideDialog
        files={[conflictFile("a.ts")]}
        side="ours"
        sides={sides}
        onResolve={onResolve}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe("MergeToolDialog", () => {
  it("explains how to choose a merge tool and closes", async () => {
    const onClose = vi.fn();
    render(<MergeToolDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "No Merge Tool Configured" });
    expect(dialog).toHaveTextContent("git config --global merge.tool meld");
    expect(dialog).toHaveTextContent("git mergetool --tool-help");
    expect(dialog).toHaveTextContent("merge.guitool");

    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens the settings to choose a merge tool there", async () => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(<MergeToolDialog onOpenSettings={onOpenSettings} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "No Merge Tool Configured" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open Settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
