import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
