import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch, Branches, Operation, Remote, Status } from "../api";
import { file, makeStatus } from "../test/tauri";
import { OperationBanner } from "./OperationBanner";
import { Dialog, FetchDialog, PullDialog, PushDialog } from "./RemoteDialogs";

const remotes: Remote[] = [
  { name: "origin", url: "git@example.com:ada/demo.git" },
  { name: "upstream", url: "https://example.com/team/demo.git" },
];

describe("Dialog", () => {
  it("can't be closed or submitted while busy, and shows its error and status", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <Dialog
        id="demo"
        title="Demo"
        submitLabel="Go"
        canSubmit
        onSubmit={onSubmit}
        onClose={onClose}
        busy
        error="It failed"
        status={<p>Working…</p>}
      >
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("It failed");
    expect(screen.getByText("Working…")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

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

describe("PushDialog", () => {
  const b = (name: string, partial: Partial<Branch> = {}): Branch => ({
    name,
    sha: "a",
    current: false,
    upstream: null,
    track: null,
    ...partial,
  });
  const branches: Branches = {
    local: [
      b("main", { current: true, upstream: "origin/main", track: "[ahead 2]" }),
      b("behind", { upstream: "origin/behind", track: "[ahead 1, behind 3]" }),
      b("feature"),
    ],
    remote: [b("origin/main"), b("origin/behind"), b("origin/dev"), b("upstream/main")],
    tags: [],
    remotes,
  };

  function setup(props: Partial<Parameters<typeof PushDialog>[0]> = {}) {
    const onPush = vi.fn();
    const onClose = vi.fn();
    render(
      <PushDialog branches={branches} status={makeStatus()} branch="main" onPush={onPush} onClose={onClose} {...props} />,
    );
    return { onPush, onClose };
  }

  const remoteBranch = () => screen.getByLabelText("Remote branch");

  it("pushes the current branch to its upstream on Enter", async () => {
    const { onPush } = setup();
    expect(screen.getByLabelText("Branch")).toHaveFocus();
    expect(screen.getByLabelText("Remote")).toHaveDisplayValue("origin");
    expect(remoteBranch()).toHaveValue("main");
    expect(remoteBranch()).toHaveAccessibleDescription("Pushes 2 commits to origin/main.");
    // Already tracked, so there is nothing to set up.
    expect(screen.queryByLabelText(/set as upstream/)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();

    await userEvent.keyboard("{Enter}");
    expect(onPush).toHaveBeenCalledWith({
      branch: "main",
      remote: "origin",
      remoteBranch: "main",
      setUpstream: false,
      tags: false,
      force: false,
    });
  });

  it("pushes a new branch and tracks it by default", async () => {
    const { onPush } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Branch"), "feature");
    expect(remoteBranch()).toHaveValue("feature");
    expect(remoteBranch()).toHaveAccessibleDescription("Creates the branch origin/feature.");
    expect(screen.getByLabelText("Track origin/feature (set as upstream)")).toBeChecked();

    await userEvent.selectOptions(screen.getByLabelText("Remote"), "upstream");
    await userEvent.clear(remoteBranch());
    await userEvent.type(remoteBranch(), "team/feature");
    await userEvent.click(screen.getByLabelText("Push all tags"));
    await userEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(onPush).toHaveBeenCalledWith({
      branch: "feature",
      remote: "upstream",
      remoteBranch: "team/feature",
      setUpstream: true,
      tags: true,
      force: false,
    });
    // Tags are remembered, force never is.
    expect(JSON.parse(localStorage.getItem("pushOptions")!)).toEqual({ tags: true });
  });

  it("warns when the push would be rejected and explains a force push", async () => {
    const { onPush } = setup({ branch: "behind" });
    expect(screen.getByRole("note")).toHaveTextContent(
      "origin/behind has 3 commits that behind doesn't have, so the push will be rejected.",
    );

    await userEvent.click(screen.getByLabelText("Force push"));
    expect(screen.getByRole("note")).toHaveTextContent("Replaces origin/behind with behind");
    expect(screen.getByRole("note")).toHaveTextContent("refused if origin/behind has commits you haven't pulled");
    await userEvent.click(screen.getByRole("button", { name: "Force Push" }));
    expect(onPush).toHaveBeenCalledWith(expect.objectContaining({ branch: "behind", force: true }));
  });

  it("starts from a given target with force checked", () => {
    setup({ target: { remote: "upstream", remoteBranch: "main" }, force: true });
    expect(screen.getByLabelText("Remote")).toHaveDisplayValue("upstream");
    expect(screen.getByLabelText("Force push")).toBeChecked();
    expect(screen.getByRole("button", { name: "Force Push" })).toHaveClass("danger");
    // Pushing elsewhere than the upstream doesn't change the upstream unless asked to.
    expect(screen.getByLabelText("Track upstream/main (set as upstream)")).not.toBeChecked();
    expect(remoteBranch()).toHaveAccessibleDescription("upstream/main is not the upstream of main (origin/main).");
  });

  it("refuses remote branch names git can't take", async () => {
    setup();
    for (const name of ["two words", "a:b", "-x"]) {
      await userEvent.clear(remoteBranch());
      await userEvent.type(remoteBranch(), name);
      expect(remoteBranch()).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    }
    await userEvent.clear(remoteBranch());
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    expect(remoteBranch()).toHaveAccessibleDescription("Enter the name of the branch on the remote.");
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

  it("commits or aborts a squash merge, which can't be skipped", async () => {
    const { onContinue, onAbort } = setup(op({ kind: "squash" }), 0);
    expect(screen.getByRole("status")).toHaveTextContent("Squash merge in progress");
    expect(screen.getByRole("status")).toHaveTextContent("The merged changes are staged.");
    expect(screen.queryByRole("button", { name: "Skip commit" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Commit squash" }));
    await userEvent.click(screen.getByRole("button", { name: "Abort squash merge" }));
    expect(onContinue).toHaveBeenCalled();
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
