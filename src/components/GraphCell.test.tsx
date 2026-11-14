import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GraphCell, graphWidth, LANE_WIDTH, MAX_GRAPH_LANES } from "./GraphCell";

describe("GraphCell", () => {
  it("draws straight and curved segments plus the commit dot", () => {
    const { container } = render(
      <GraphCell
        row={{
          col: 0,
          color: 0,
          width: 2,
          segments: [
            { from: 0, to: 0, half: "top", color: 0 },
            { from: 0, to: 1, half: "bottom", color: 1 },
          ],
        }}
        isMerge={false}
        isHead={false}
        width={graphWidth(2)}
      />,
    );
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("d")).toMatch(/V/); // vertical line
    expect(paths[1].getAttribute("d")).toMatch(/C/); // curve into the next lane
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });

  it("adds a ring around HEAD", () => {
    const { container } = render(
      <GraphCell row={{ col: 0, color: 0, width: 1, segments: [] }} isMerge={false} isHead width={graphWidth(1)} />,
    );
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });
});

describe("graphWidth", () => {
  it("grows with lanes up to a maximum", () => {
    expect(graphWidth(0)).toBe(graphWidth(1));
    expect(graphWidth(3)).toBe(3 * LANE_WIDTH + 8);
    expect(graphWidth(100)).toBe(MAX_GRAPH_LANES * LANE_WIDTH + 8);
  });
});
