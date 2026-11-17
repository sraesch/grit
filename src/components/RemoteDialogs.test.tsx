import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Operation, Remote, Status } from "../api";
import { file, makeStatus } from "../test/tauri";
import { OperationBanner } from "./OperationBanner";
import { FetchDialog, PullDialog } from "./RemoteDialogs";

const remotes: Remote[] = [
  { name: "origin", url: "git@example.com:ada/demo.git" },
  { name: "upstream", url: "https://example.com/team/demo.git" },
];

describe("FetchDialog", () => {
  function setup(defaultRemote: string | null = "origin", list = remotes) {
    const onFetch = vi.fn();
    const onClose = vi.fn();
    render(<FetchDialog remotes={list} defaultRemote={defaultRemote} onFetch={onFetch} onClose={onClose} />);
    return { onFetch, onClose };
  }

  it("fetches the preselected remote with the default options on Enter", async () => {
    const { onFetch } = setup();
    const select = screen.getByLabelText("Remote");
    expect(select).toHaveFocus();
    expect(select).toHaveDisplayValue("origin");
    expect(select).toHaveAccessibleDescription("git@example.com:ada/demo.git");

    await userEvent.keyboard("{Enter}");
    expect(onFetch).toHaveBeenCalledWith({ remote: "origin", prune: true, tags: false, background: false });
  });

  it("fetches all remotes with the chosen options and remembers them", async () => {
    const { onFetch } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Remote"), "All remotes");
    await userEvent.click(screen.getByLabelText(/Prune remote branches/));
    await userEvent.click(screen.getByLabelText("Fetch all tags"));
    await userEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(onFetch).toHaveBeenCalledWith({ remote: null, prune: false, tags: true, background: false });
    expect(JSON.parse(localStorage.getItem("fetchOptions")!)).toEqual({ prune: false, tags: true });
  });

  it("offers All remotes only when there are several", () => {
    setup("origin", [remotes[0]]);
    expect(screen.queryByRole("option", { name: "All remotes" })).toBeNull();
  });

  it("closes on Cancel and Escape without fetching", async () => {
    const { onFetch, onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onFetch).not.toHaveBeenCalled();
  });
});

describe("PullDialog", () => {
  function setup(status: Partial<Status> = {}, sources = ["origin/main", "origin/dev", "upstream/main"], preferred: string | null = "origin/main") {
    const onPull = vi.fn();
    const onClose = vi.fn();
    render(
      <PullDialog
        branch="main"
        status={makeStatus({ upstream: "origin/main", ...status })}
        remotes={remotes}
        sources={sources}
        preferred={preferred}
        onPull={onPull}
        onClose={onClose}
      />,
    );
    return { onPull, onClose };
  }

  it("pulls the upstream with a merge and stashing by default", async () => {
    const { onPull } = setup({ behind: 2, ahead: 1 });
    expect(screen.getByRole("dialog", { name: "Pull" })).toHaveTextContent("into main");
    expect(screen.getByLabelText("Pull from")).toHaveAccessibleDescription(
      "main is 2 behind and 1 ahead of origin/main as of the last fetch. Pulling fetches first.",
    );
    await userEvent.keyboard("{Enter}");
    expect(onPull).toHaveBeenCalledWith(
      { remote: "origin", branch: "main", rebase: false, autostash: true },
      "origin/main",
    );
  });

  it("pulls another branch with a rebase and remembers the choice", async () => {
    const { onPull } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Pull from"), "upstream/main");
    expect(screen.getByLabelText("Pull from")).toHaveAccessibleDescription("upstream/main is not the upstream of main (origin/main).");
    await userEvent.click(screen.getByLabelText("Rebase instead of merge"));
    await userEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(onPull).toHaveBeenCalledWith(
      { remote: "upstream", branch: "main", rebase: true, autostash: true },
      "upstream/main",
    );
    expect(JSON.parse(localStorage.getItem("pullOptions")!)).toEqual({ rebase: true, autostash: true });
  });

  it("warns about uncommitted changes when not stashing", async () => {
    setup({ unstaged: [file("a.txt")] });
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(screen.getByLabelText("Stash and reapply local changes"));
    expect(screen.getByRole("note")).toHaveTextContent("stops if it would overwrite them");
    await userEvent.click(screen.getByLabelText("Rebase instead of merge"));
    expect(screen.getByRole("note")).toHaveTextContent("won't start until they are stashed or committed");
  });

  it("ignores untracked files for that warning", async () => {
    setup({ unstaged: [file("new.txt", "?")] });
    await userEvent.click(screen.getByLabelText("Stash and reapply local changes"));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("can't pull without remote branches", () => {
    setup({ upstream: null }, [], null);
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.getByText("There are no remote branches. Fetch first.")).toBeInTheDocument();
  });
});

describe("OperationBanner", () => {
  const op = (partial: Partial<Operation>): Operation => ({
    kind: "merge",
    head: null,
    step: null,
    total: null,
    message: null,
    ...partial,
  });

  function setup(operation: Operation, conflicts: number) {
    const handlers = { onAbort: vi.fn(), onContinue: vi.fn(), onSkip: vi.fn() };
    render(<OperationBanner operation={operation} conflicts={conflicts} busy={false} {...handlers} />);
    return handlers;
  }

  it("explains a merge with conflicts and offers to abort it", async () => {
    const { onAbort } = setup(op({}), 2);
    expect(screen.getByRole("status")).toHaveTextContent("Merge in progress");
    expect(screen.getByRole("status")).toHaveTextContent("Resolve the conflicts in 2 files");
    expect(screen.getByRole("button", { name: "Commit merge" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Skip commit" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Abort merge" }));
    expect(onAbort).toHaveBeenCalled();
  });

  it("continues or skips a rebase once the conflicts are resolved", async () => {
    const { onContinue, onSkip } = setup(op({ kind: "rebase", head: "main", step: 1, total: 2 }), 0);
    expect(screen.getByRole("status")).toHaveTextContent("Rebasing main (commit 1 of 2)");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip commit" }));
    expect(onContinue).toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Abort rebase" })).toBeEnabled();
  });
});
