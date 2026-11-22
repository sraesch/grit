import { render, screen, within } from "@testing-library/react";
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
});
