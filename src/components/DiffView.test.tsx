import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MAX_LINES } from "../diff";
import { DiffView } from "./DiffView";

describe("DiffView", () => {
  it("prompts for a selection when there is no diff", () => {
    render(<DiffView diff={null} />);
    expect(screen.getByText("Select a file to see its changes")).toBeInTheDocument();
  });

  it("shows errors", () => {
    render(<DiffView diff={null} error="fatal: bad revision" />);
    expect(screen.getByText("fatal: bad revision")).toBeInTheDocument();
  });

  it("renders added and removed lines with styling", () => {
    const { container } = render(
      <DiffView diff={"@@ -1,2 +1,2 @@\n same\n-before\n+after\n"} title="a.txt" />,
    );
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("before").closest(".diff-line")).toHaveClass("diff-del");
    expect(screen.getByText("after").closest(".diff-line")).toHaveClass("diff-add");
    expect(container.querySelectorAll(".diff-line")).toHaveLength(4);
  });

  it("shows a remark above the diff of the titled file", () => {
    const { rerender } = render(<DiffView diff={"@@ -1 +1 @@\n-a\n+b\n"} title="a.bin" note="Shown as a diff" />);
    expect(screen.getByRole("note")).toHaveTextContent("Shown as a diff");
    rerender(<DiffView diff={"@@ -1 +1 @@\n-a\n+b\n"} title="a.bin" note={null} />);
    expect(screen.queryByRole("note")).toBeNull();
    // Without a file there is nothing to remark on.
    rerender(<DiffView diff={null} note="Shown as a diff" />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("labels binary files", () => {
    render(<DiffView diff={"diff --git a/x b/x\nBinary files a/x and b/x differ\n"} />);
    expect(screen.getByText("Binary file")).toBeInTheDocument();
  });

  it("says when there are no textual changes", () => {
    render(<DiffView diff={""} />);
    expect(screen.getByText("No textual changes")).toBeInTheDocument();
  });
  it("shows the hunk actions on each hunk header", async () => {
    const stage = vi.fn();
    const discard = vi.fn();
    const diff = "@@ -1 +1 @@ first\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n";
    const { container } = render(
      <DiffView
        diff={diff}
        hunkActions={[
          { label: "Stage hunk", onClick: stage },
          { label: "Discard hunk", danger: true, onClick: discard },
        ]}
      />,
    );
    const headers = container.querySelectorAll(".diff-hunk");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent("@@ -1 +1 @@ first");
    await userEvent.click(within(headers[1] as HTMLElement).getByRole("button", { name: "Stage hunk" }));
    expect(stage).toHaveBeenCalledWith({ index: 1, header: "@@ -9 +9 @@" });
    const discardButton = within(headers[0] as HTMLElement).getByRole("button", { name: "Discard hunk" });
    expect(discardButton).toHaveClass("danger");
    await userEvent.click(discardButton);
    expect(discard).toHaveBeenCalledWith({ index: 0, header: "@@ -1 +1 @@ first" });
  });

  it("disables the hunk actions on request", () => {
    const actions = [{ label: "Stage hunk", onClick: () => {} }];
    render(<DiffView diff={"@@ -1 +1 @@\n-a\n+b\n"} hunkActions={actions} hunkActionsDisabled />);
    expect(screen.getByRole("button", { name: "Stage hunk" })).toBeDisabled();
  });

  it("leaves the hunk actions out of truncated diffs and renames", () => {
    const actions = [{ label: "Stage hunk", onClick: () => {} }];
    const big = "@@ -1 +1," + MAX_LINES + " @@\n" + Array.from({ length: MAX_LINES }, (_, i) => `+${i}`).join("\n");
    const { unmount } = render(<DiffView diff={big} hunkActions={actions} />);
    expect(screen.getByText(/Diff truncated/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stage hunk" })).toBeNull();
    unmount();

    const renamed = "diff --git a/a b/b\nrename from a\nrename to b\n@@ -1 +1 @@\n-x\n+y\n";
    render(<DiffView diff={renamed} hunkActions={actions} />);
    expect(screen.queryByRole("button", { name: "Stage hunk" })).toBeNull();
  });
  describe("line selection", () => {
    // Line indexes: 0 hunk, 1 ctx, 2 del, 3 add, 4 add, 5 ctx, 6 hunk, 7 del, 8 add.
    const diff = "@@ -1,3 +1,4 @@\n keep\n-old\n+new 1\n+new 2\n tail\n@@ -9 +10 @@\n-x\n+y\n";
    const row = (text: string) => screen.getByText(text).closest(".diff-line") as HTMLElement;
    const gutter = (text: string) => row(text).querySelector(".gutter") as HTMLElement;

    function setup(onStage = vi.fn(), props: Partial<Parameters<typeof DiffView>[0]> = {}) {
      const result = render(
        <DiffView
          diff={diff}
          title="f.txt"
          lineActions={[
            { label: "Stage", onClick: onStage },
            { label: "Discard", danger: true, onClick: () => {} },
          ]}
          {...props}
        />,
      );
      return { onStage, ...result };
    }

    it("selects a changed line with a click and clears it with a second one", async () => {
      setup();
      expect(screen.queryByRole("button", { name: /^Stage/ })).toBeNull();
      fireEvent.mouseDown(gutter("new 1"));
      expect(row("new 1")).toHaveClass("selected");
      expect(screen.getByRole("button", { name: "Stage 1 line" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Discard 1 line" })).toHaveClass("danger");

      fireEvent.mouseDown(gutter("new 1"));
      expect(row("new 1")).not.toHaveClass("selected");
      expect(screen.queryByRole("button", { name: /^Stage/ })).toBeNull();

      // Context lines can't be selected.
      fireEvent.mouseDown(gutter("keep"));
      expect(row("keep")).not.toHaveClass("selected");
      // Clicking the code selects too.
      await userEvent.click(screen.getByText("old"));
      expect(row("old")).toHaveClass("selected");
    });

    it("extends with Shift+click across hunks and toggles with Ctrl/Cmd+click", async () => {
      const { onStage } = setup();
      fireEvent.mouseDown(gutter("old"));
      fireEvent.mouseDown(gutter("y"), { shiftKey: true });
      expect(["old", "new 1", "new 2", "x", "y"].every((t) => row(t).classList.contains("selected"))).toBe(true);
      expect(row("tail")).not.toHaveClass("selected");

      fireEvent.mouseDown(gutter("new 2"), { ctrlKey: true });
      fireEvent.mouseDown(gutter("x"), { metaKey: true });
      expect(row("new 2")).not.toHaveClass("selected");
      await userEvent.click(screen.getByRole("button", { name: "Stage 3 lines" }));
      expect(onStage).toHaveBeenCalledWith([
        { index: 0, header: "@@ -1,3 +1,4 @@", lines: [1, 2] },
        { index: 1, header: "@@ -9 +10 @@", lines: [1] },
      ]);
    });

    it("selects by dragging over the lines", () => {
      setup();
      fireEvent.mouseDown(gutter("new 2"));
      fireEvent.mouseEnter(row("tail"));
      fireEvent.mouseEnter(row("x"));
      fireEvent.mouseUp(window);
      fireEvent.mouseEnter(row("y"));
      expect(screen.getByRole("button", { name: "Stage 2 lines" })).toBeInTheDocument();
      expect(row("new 2")).toHaveClass("selected");
      expect(row("x")).toHaveClass("selected");
      expect(row("y")).not.toHaveClass("selected");
    });

    it("clears the selection on Escape and when the diff changes", () => {
      const { rerender } = setup();
      fireEvent.mouseDown(gutter("old"));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(row("old")).not.toHaveClass("selected");

      fireEvent.mouseDown(gutter("old"));
      const actions = [{ label: "Stage", onClick: () => {} }];
      rerender(<DiffView diff={diff + " more\n"} title="f.txt" lineActions={actions} />);
      expect(row("old")).not.toHaveClass("selected");
    });

    it("keeps the selection when the same diff is loaded again", () => {
      const actions = [{ label: "Stage", onClick: () => {} }];
      const { rerender } = render(<DiffView diff={diff} title="f.txt" lineActions={actions} />);
      fireEvent.mouseDown(gutter("old"));
      rerender(<DiffView diff={`${diff}`} title="f.txt" lineActions={actions} />);
      expect(row("old")).toHaveClass("selected");
    });

    it("disables the line actions on request and offers none without them", () => {
      setup(vi.fn(), { hunkActionsDisabled: true });
      fireEvent.mouseDown(gutter("old"));
      expect(screen.getByRole("button", { name: "Stage 1 line" })).toBeDisabled();
    });

    it("can't select lines without line actions", () => {
      render(<DiffView diff={diff} title="f.txt" />);
      fireEvent.mouseDown(gutter("old"));
      expect(row("old")).not.toHaveClass("selected");
    });
  });
});
