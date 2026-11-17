import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Branch, Branches } from "../api";
import { BranchSwitcher } from "./BranchSwitcher";

const branch = (name: string, partial: Partial<Branch> = {}): Branch => ({
  name,
  sha: "a",
  current: false,
  upstream: null,
  track: null,
  ...partial,
});

const branches: Branches = {
  local: [branch("main", { current: true }), branch("develop", { track: "[ahead 3]" }), branch("feature/login")],
  remote: [branch("origin/main"), branch("origin/release")],
  tags: [],
  remotes: [{ name: "origin", url: "git@example.com:demo.git" }],
};

function setup() {
  const onSwitch = vi.fn();
  const onClose = vi.fn();
  const outside = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={outside}>outside</button>
      <BranchSwitcher branches={branches} onSwitch={onSwitch} onClose={onClose} />
    </>,
  );
  return { onSwitch, onClose };
}

const active = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

describe("BranchSwitcher", () => {
  it("lists branches grouped, marks the current one and focuses the filter", () => {
    setup();
    expect(screen.getByRole("combobox", { name: "Branch name" })).toHaveFocus();
    expect(screen.getByText("Branches")).toBeInTheDocument();
    expect(screen.getByText("Remote branches")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /main/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /develop/ })).toHaveTextContent("↑3");
    expect(screen.getByRole("option", { name: /origin\/release/ })).toHaveTextContent("creates release");
    // The current branch is skipped: the first branch to switch to is active.
    expect(active()).toHaveTextContent("develop");
  });

  it("moves with the arrow keys, skipping the current branch, and switches on Enter", async () => {
    const { onSwitch } = setup();
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toHaveTextContent("feature/login");
    // Wraps around from the last option, skipping the current branch.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(active()).toHaveTextContent("develop");
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(onSwitch).toHaveBeenCalledWith({ kind: "remote", name: "origin/release", localName: "release" });
  });

  it("filters as you type and creates a branch from the text", async () => {
    const { onSwitch } = setup();
    await userEvent.type(screen.getByRole("combobox"), "fix login");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("New branch")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(onSwitch).toHaveBeenCalledWith({ kind: "create", name: "fix-login" });
  });

  it("switches on click but not to the current branch", async () => {
    const { onSwitch } = setup();
    await userEvent.click(screen.getByRole("option", { name: /main/ }));
    expect(onSwitch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("option", { name: /feature\/login/ }));
    expect(onSwitch).toHaveBeenCalledWith({ kind: "local", name: "feature/login" });
  });

  it("closes on Escape with focus restored, and on outside clicks without", async () => {
    const { onClose } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(onClose).toHaveBeenLastCalledWith(false);
  });
});
