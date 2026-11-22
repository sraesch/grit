import { describe, expect, it } from "vitest";
import { repoNameFromUrl } from "./clone";

describe("repoNameFromUrl", () => {
  it.each([
    ["https://github.com/ada/grit.git", "grit"],
    ["https://github.com/ada/grit", "grit"],
    ["https://github.com/ada/grit/", "grit"],
    ["git@github.com:ada/grit.git", "grit"],
    ["git@host:grit.git", "grit"],
    ["ssh://git@host:2222/srv/grit.git", "grit"],
    ["/srv/git/grit/", "grit"],
    ["/srv/git/grit.git/", "grit"],
    ["C:\\repos\\grit", "grit"],
    ["file:///srv/git/grit.js.git", "grit.js"],
    ["  https://example.com/a/b.git?x=1  ", "b"],
  ])("names %s %s", (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name);
  });

  it.each(["", "   ", "https://", "https://example.com", "https://example.com/", "git@host:"])(
    "names nothing for %j",
    (url) => {
      expect(repoNameFromUrl(url)).toBe("");
    },
  );
});
