import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTrack, LANE_COLORS, laneColor, relativeTime, splitPath } from "./util";

describe("relativeTime", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const ago = (seconds: number) => now.getTime() / 1000 - seconds;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [0, "just now"],
    [30, "30 seconds ago"],
    [60, "1 minute ago"],
    [5 * 60, "5 minutes ago"],
    [3600, "1 hour ago"],
    [2 * 86400, "2 days ago"],
    [14 * 86400, "2 weeks ago"],
    [90 * 86400, "3 months ago"],
    [800 * 86400, "2 years ago"],
  ])("formats %i seconds ago as %s", (seconds, expected) => {
    expect(relativeTime(ago(seconds))).toBe(expected);
  });
});

describe("splitPath", () => {
  it("splits directory and file name", () => {
    expect(splitPath("src/components/App.tsx")).toEqual({ dir: "src/components/", name: "App.tsx" });
  });
  it("handles files at the root", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("formatTrack", () => {
  it.each([
    ["[ahead 2]", "↑2"],
    ["[behind 3]", "↓3"],
    ["[ahead 1, behind 4]", "↑1 ↓4"],
    ["[gone]", "gone"],
    ["", ""],
  ])("formats %s", (input, expected) => {
    expect(formatTrack(input)).toBe(expected);
  });
});

describe("laneColor", () => {
  it("cycles through the palette", () => {
    expect(laneColor(0)).toBe(LANE_COLORS[0]);
    expect(laneColor(LANE_COLORS.length + 1)).toBe(LANE_COLORS[1]);
  });
});
