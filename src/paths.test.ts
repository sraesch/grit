import { describe, expect, it } from "vitest";
import { joinPath } from "./paths";

describe("joinPath", () => {
  it("uses the folder's separator", () => {
    expect(joinPath("/home/ada/code", "grit")).toBe("/home/ada/code/grit");
    expect(joinPath("C:\\Users\\ada\\code", "grit")).toBe("C:\\Users\\ada\\code\\grit");
  });

  it("doesn't double a trailing separator", () => {
    expect(joinPath("/home/ada/", "grit")).toBe("/home/ada/grit");
    expect(joinPath("C:\\", "grit")).toBe("C:\\grit");
  });
});
