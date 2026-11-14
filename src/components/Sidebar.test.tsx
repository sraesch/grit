import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branches } from "../api";
import { Sidebar } from "./Sidebar";

const branches: Branches = {
  local: [
    { name: "main", sha: "a", current: true, upstream: "origin/main", track: "[ahead 1]" },
    { name: "feature", sha: "b", current: false, upstream: null, track: null },
  ],
  remote: [{ name: "origin/main", sha: "a", current: false, upstream: null, track: null }],
  tags: [{ name: "v1.0", sha: "a", current: false, upstream: null, track: null }],
};

function setup() {
  const onView = vi.fn();
  const onCheckout = vi.fn();
  render(<Sidebar view="changes" onView={onView} changeCount={3} branches={branches} onCheckout={onCheckout} />);
  return { onView, onCheckout };
}

describe("Sidebar", () => {
  it("switches views and shows the change count", async () => {
    const { onView } = setup();
    expect(screen.getByRole("button", { name: /Local changes/ })).toHaveTextContent("3");
    await userEvent.click(screen.getByRole("button", { name: "All commits" }));
    expect(onView).toHaveBeenCalledWith("history");
  });

  it("marks the current branch and shows tracking info", () => {
    setup();
    const main = screen.getByText("main").closest("li")!;
    expect(main).toHaveClass("current");
    expect(main).toHaveTextContent("↑1");
  });

  it("checks out other branches on double-click only", async () => {
    const { onCheckout } = setup();
    await userEvent.dblClick(screen.getByText("main"));
    expect(onCheckout).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByText("feature"));
    expect(onCheckout).toHaveBeenCalledWith("feature");
  });

  it("collapses remotes and tags by default", async () => {
    setup();
    expect(screen.queryByText("v1.0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Tags/ }));
    expect(screen.getByText("v1.0")).toBeInTheDocument();
  });
});
