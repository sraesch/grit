import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogoLockup, LogoTile } from "./Logo";

describe("LogoTile", () => {
  it("is an image with an accessible name when labelled", () => {
    render(<LogoTile size={32} label="grit" />);
    const img = screen.getByRole("img", { name: "grit" });
    expect(img).toHaveAttribute("width", "32");
    // Tile, stem, branch, root commit and head commit.
    expect(img.querySelectorAll("rect, path, circle")).toHaveLength(5);
  });

  it("is hidden from assistive technology when decorative", () => {
    const { container } = render(<LogoTile size={32} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("takes its colors from theme classes", () => {
    const { container } = render(<LogoTile size={32} />);
    for (const cls of ["logo-bg", "logo-line", "logo-commit", "logo-head"]) {
      expect(container.querySelector(`.${cls}`)).not.toBeNull();
    }
  });
});

describe("LogoLockup", () => {
  it("renders the wordmark as a heading with the name grit", () => {
    render(<LogoLockup size={48} as="h1" />);
    expect(screen.getByRole("heading", { name: "grit" })).toHaveStyle({ fontSize: "48px" });
  });
});
