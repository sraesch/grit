import { openUrl } from "@tauri-apps/plugin-opener";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutDialog } from "./AboutDialog";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const CHANGELOG = `<!-- maintainer notes -->

# What's new

## 0.2.0 — 2026-12-01

- Push and pull from the toolbar
- **Faster** history for large repositories

## 0.1.0 — 2026-11-14

- First release, see [the site](https://example.com)
`;

describe("AboutDialog", () => {
  it("shows the logo, the version and the changelog as markdown", () => {
    render(<AboutDialog onClose={() => {}} version="1.2.3" changelog={CHANGELOG} />);

    const dialog = screen.getByRole("dialog", { name: "About grit" });
    expect(dialog).toHaveTextContent("grit");
    expect(screen.getByText("Version 1.2.3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "0.2.0 — 2026-12-01" })).toBeInTheDocument();
    expect(screen.getByText("Faster").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(dialog).not.toHaveTextContent("maintainer notes");
    expect(screen.queryByText("No released versions yet.")).not.toBeInTheDocument();
  });

  it("uses the app version and the app changelog by default", () => {
    render(<AboutDialog onClose={() => {}} />);
    expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What's new" })).toBeInTheDocument();
  });

  it("says so when no version has been released", () => {
    render(<AboutDialog onClose={() => {}} version="0.1.0" changelog={"# What's new\n"} />);
    expect(screen.getByText("No released versions yet.")).toBeInTheDocument();
  });

  it("opens links in the system browser", async () => {
    render(<AboutDialog onClose={() => {}} version="1.0.0" changelog={CHANGELOG} />);
    await userEvent.click(screen.getByRole("link", { name: "the site" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("closes with the button, Escape and a click on the backdrop", async () => {
    const onClose = vi.fn();
    const { container } = render(<AboutDialog onClose={onClose} version="1.0.0" changelog={CHANGELOG} />);

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    await userEvent.click(close);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(3);

    await userEvent.click(screen.getByText("Version 1.0.0"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
