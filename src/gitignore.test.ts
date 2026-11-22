import { describe, expect, it } from "vitest";
import { escapePattern, ignoreOptions } from "./gitignore";

describe("escapePattern", () => {
  it("leaves plain names alone", () => {
    expect(escapePattern("build.log")).toBe("build.log");
    expect(escapePattern("ünïcödé file")).toBe("ünïcödé file");
  });

  it("escapes glob characters, backslashes, comments, negations and trailing spaces", () => {
    expect(escapePattern("a*b?[c].txt")).toBe("a\\*b\\?\\[c].txt");
    expect(escapePattern("back\\slash")).toBe("back\\\\slash");
    expect(escapePattern("#notes")).toBe("\\#notes");
    expect(escapePattern("!important")).toBe("\\!important");
    expect(escapePattern("a#b!c")).toBe("a#b!c");
    expect(escapePattern("name  ")).toBe("name\\ \\ ");
  });
});

describe("ignoreOptions", () => {
  it("offers the file, its name and its extension", () => {
    expect(ignoreOptions({ kind: "file", path: "logs/debug.log" })).toEqual([
      { label: "Only this file", pattern: "/logs/debug.log" },
      { label: "All files named debug.log", pattern: "debug.log" },
      { label: "All files with extension .log", pattern: "*.log" },
    ]);
  });

  it("uses the last extension and skips names without one", () => {
    expect(ignoreOptions({ kind: "file", path: "a.tar.gz" }).map((o) => o.pattern)).toEqual([
      "/a.tar.gz",
      "a.tar.gz",
      "*.gz",
    ]);
    expect(ignoreOptions({ kind: "file", path: "dir/.env" }).map((o) => o.pattern)).toEqual(["/dir/.env", ".env"]);
    expect(ignoreOptions({ kind: "file", path: "Makefile" })).toHaveLength(2);
    expect(ignoreOptions({ kind: "file", path: "odd." })).toHaveLength(2);
  });

  it("offers the folder and every folder with its name", () => {
    expect(ignoreOptions({ kind: "folder", path: "src/gen/" })).toEqual([
      { label: "Only this folder", pattern: "/src/gen/" },
      { label: "All folders named gen", pattern: "gen/" },
    ]);
    expect(ignoreOptions({ kind: "folder", path: "out/" }).map((o) => o.pattern)).toEqual(["/out/", "out/"]);
  });

  it("escapes every path segment", () => {
    expect(ignoreOptions({ kind: "file", path: "[x]/#y.txt" })[0].pattern).toBe("/\\[x]/\\#y.txt");
  });
});
