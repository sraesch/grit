import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitDetails } from "../api";
import { file, makeCommit, mockBackend } from "../test/tauri";
import { HistoryView } from "./HistoryView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

// jsdom has no layout: give elements a size so the virtualizer renders rows.
const SIZES = { clientHeight: 600, clientWidth: 800, offsetHeight: 600, offsetWidth: 800 };
const originals = Object.fromEntries(
  Object.keys(SIZES).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]),
);
beforeAll(() => {
  for (const [key, value] of Object.entries(SIZES)) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
});

const log = [
  makeCommit("c3", "Merge feature", {
    parents: ["c2", "f1"],
    refs: [
      { name: "main", kind: "local", current: true },
      { name: "v1.0", kind: "tag", current: false },
    ],
  }),
  makeCommit("c2", "Second commit", { parents: ["c1"] }),
  makeCommit("c1", "Initial commit"),
];

function details(sha: string): CommitDetails {
  return {
    sha,
    parents: [],
    author: "Ada",
    authorEmail: "ada@example.com",
    authorTime: 1_700_000_000,
    committer: "Ada",
    committerEmail: "ada@example.com",
    committerTime: 1_700_000_000,
    message: `Subject of ${sha}\n\nLonger body of ${sha}`,
    files: [file(`${sha}.txt`, "A"), file("shared.rs")],
  };
}

describe("HistoryView", () => {
  beforeEach(() => {
    mockBackend(invokeMock, {
      get_commit_details: ({ sha }) => details(sha as string),
      get_commit_file_diff: ({ sha, path }) => `@@ -0,0 +1 @@\n+${sha}:${path}\n`,
    });
  });

  it("lists commits with their refs", async () => {
    render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    expect(await screen.findByText("Merge feature")).toBeInTheDocument();
    expect(screen.getByText("Initial commit")).toBeInTheDocument();
    expect(screen.getByText("main")).toHaveClass("ref-local", "ref-current");
    expect(screen.getByText(/v1\.0/)).toHaveClass("ref-tag");
  });

  it("selects HEAD and shows its details, files and first file diff", async () => {
    render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    expect(await screen.findByText("Subject of c3")).toBeInTheDocument();
    expect(screen.getByText("Longer body of c3")).toBeInTheDocument();
    expect(within(document.querySelector(".file-list")! as HTMLElement).getByText("c3.txt")).toBeInTheDocument();
    expect(await screen.findByText("c3:c3.txt")).toBeInTheDocument();
  });

  it("loads another commit on click and another file diff on file click", async () => {
    render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    await userEvent.click(await screen.findByText("Second commit"));
    expect(await screen.findByText("Subject of c2")).toBeInTheDocument();

    await userEvent.click(within(document.querySelector(".file-list")! as HTMLElement).getByText("shared.rs"));
    expect(await screen.findByText("c2:shared.rs")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("get_commit_file_diff", {
      repo: "/repo",
      sha: "c2",
      path: "shared.rs",
      origPath: null,
    });
  });

  it("moves the selection with the arrow keys", async () => {
    render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    await screen.findByText("Subject of c3");
    const list = document.querySelector(".history-scroll")!;

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(await screen.findByText("Subject of c2")).toBeInTheDocument();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(await screen.findByText("Subject of c1")).toBeInTheDocument();
    // Stays on the last commit.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(await screen.findByText("Subject of c2")).toBeInTheDocument();
  });

  it("renders the commit body as markdown and remembers the plain-text choice", async () => {
    mockBackend(invokeMock, {
      get_commit_details: ({ sha }) => ({ ...details(sha as string), message: "Subject\n\n- **bold** item" }),
      get_commit_file_diff: () => "",
    });
    const { unmount } = render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    expect(await screen.findByText("bold")).toHaveProperty("tagName", "STRONG");
    const toggle = screen.getByRole("button", { name: "Markdown" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    expect(screen.getByText("- **bold** item")).toHaveClass("commit-body");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    unmount();
    render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    expect(await screen.findByText("- **bold** item")).toHaveClass("commit-body");
  });

  it("hides the markdown toggle for commits without a body", async () => {
    mockBackend(invokeMock, {
      get_commit_details: ({ sha }) => ({ ...details(sha as string), message: "Just a subject\n" }),
      get_commit_file_diff: () => "",
    });
    render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
    expect(await screen.findByText("Just a subject")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Markdown" })).toBeNull();
  });

  describe("image files", () => {
    const bytes = (text: string) => new TextEncoder().encode(text).buffer;

    beforeEach(() => {
      let next = 0;
      // jsdom has no object URLs.
      URL.createObjectURL = vi.fn(() => `blob:image-${next++}`);
      URL.revokeObjectURL = vi.fn();
    });

    function withFiles(files: ReturnType<typeof file>[], parents = ["p1"]) {
      mockBackend(invokeMock, {
        get_commit_details: ({ sha }) => ({ ...details(sha as string), parents, files }),
        get_commit_file_diff: () => "diff --git a/x b/x\nBinary files a/x and b/x differ\n",
        get_file_at_revision: ({ rev, path }) => bytes(`${rev}:${path}`),
      });
    }

    it("shows a modified image before and after the commit", async () => {
      withFiles([file("logo.png")]);
      render(<HistoryView repo="/repo" log={log} onError={() => {}} />);

      const before = await screen.findByRole("img", { name: "Before: logo.png" });
      const after = screen.getByRole("img", { name: "After: logo.png" });
      expect(before).toHaveAttribute("src", expect.stringMatching(/^blob:/));
      expect(after.getAttribute("src")).not.toBe(before.getAttribute("src"));
      expect(invokeMock).toHaveBeenCalledWith("get_file_at_revision", { repo: "/repo", rev: "p1", path: "logo.png" });
      expect(invokeMock).toHaveBeenCalledWith("get_file_at_revision", { repo: "/repo", rev: "c3", path: "logo.png" });
      expect(screen.getAllByText("11 B")).toHaveLength(2);
    });

    it("reads a renamed image from its old path and shows added and deleted images alone", async () => {
      withFiles([file("new.png", "R", "old.png"), file("added.svg", "A"), file("gone.gif", "D")]);
      render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
      await screen.findByRole("img", { name: "Before: old.png" });
      expect(screen.getByRole("img", { name: "After: new.png" })).toBeInTheDocument();
      expect(invokeMock).toHaveBeenCalledWith("get_file_at_revision", { repo: "/repo", rev: "p1", path: "old.png" });

      await userEvent.click(screen.getByText("added.svg"));
      expect(await screen.findByRole("img", { name: "Added: added.svg" })).toBeInTheDocument();
      expect(screen.queryByText("Before")).toBeNull();

      await userEvent.click(screen.getByText("gone.gif"));
      expect(await screen.findByRole("img", { name: "Deleted: gone.gif" })).toBeInTheDocument();
      expect(screen.queryByText("After")).toBeNull();
    });

    it("shows images of a root commit as added", async () => {
      withFiles([file("logo.png", "A")], []);
      render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
      expect(await screen.findByRole("img", { name: "Added: logo.png" })).toBeInTheDocument();
    });

    it("switches between the image and the diff", async () => {
      withFiles([file("logo.png")]);
      render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
      await screen.findByRole("img", { name: "After: logo.png" });

      await userEvent.click(screen.getByRole("button", { name: "Show diff" }));
      expect(await screen.findByText("Binary file")).toBeInTheDocument();
      expect(screen.queryByRole("img")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Show image" }));
      expect(await screen.findByRole("img", { name: "After: logo.png" })).toBeInTheDocument();
    });

    it("reports images that cannot be loaded", async () => {
      mockBackend(invokeMock, {
        get_commit_details: ({ sha }) => ({ ...details(sha as string), files: [file("huge.png", "A")] }),
        get_commit_file_diff: () => "",
        get_file_at_revision: () => {
          throw "File is too large to preview (30.0 MB, limit 25 MB)";
        },
      });
      render(<HistoryView repo="/repo" log={log} onError={() => {}} />);
      expect(await screen.findByText("File is too large to preview (30.0 MB, limit 25 MB)")).toBeInTheDocument();
    });
  });

  it("reports when details cannot be loaded", async () => {
    mockBackend(invokeMock, {
      get_commit_details: () => {
        throw "bad object";
      },
    });
    const onError = vi.fn();
    render(<HistoryView repo="/repo" log={log} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("bad object"));
  });

  it("shows an empty state for repositories without commits", () => {
    render(<HistoryView repo="/repo" log={[]} onError={() => {}} />);
    expect(screen.getByText("No commits yet")).toBeInTheDocument();
  });
});
