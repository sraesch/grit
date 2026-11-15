import { openUrl } from "@tauri-apps/plugin-opener";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommitMessage, splitCommitMessage } from "./Markdown";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const MESSAGE = `Add **search** to the history

Filters commits as you type:

- matches the \`subject\` and the author
- ~~case sensitive~~ ignores case

See https://example.com/docs for details.
<script>alert(1)</script>`;

describe("splitCommitMessage", () => {
  it("splits off the first line and trims the body", () => {
    expect(splitCommitMessage("\nSubject\n\n  Body line\n\n")).toEqual({ summary: "Subject", body: "Body line" });
    expect(splitCommitMessage("Only a subject")).toEqual({ summary: "Only a subject", body: "" });
    expect(splitCommitMessage("")).toEqual({ summary: "", body: "" });
  });
});

describe("CommitMessage", () => {
  it("keeps the summary plain and renders the body as markdown", () => {
    const { container } = render(<CommitMessage message={MESSAGE} />);

    // Like on git hosts, markdown in the subject line is not rendered.
    expect(container.querySelector(".commit-summary")).toHaveTextContent("Add **search** to the history");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("subject").tagName).toBe("CODE");
    expect(screen.getByText("case sensitive").tagName).toBe("DEL");
    expect(container.querySelector("script")).toBeNull();
  });

  it("opens links, including bare URLs, in the system browser", async () => {
    render(<CommitMessage message={MESSAGE} />);
    await userEvent.click(screen.getByRole("link", { name: "https://example.com/docs" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("shows the body verbatim when markdown is off", () => {
    const { container } = render(<CommitMessage message={MESSAGE} markdown={false} />);
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(container.querySelector("pre.commit-body")).toHaveTextContent("- matches the `subject` and the author");
  });
});
