import { describe, expect, it } from "vitest";
import { CUSTOM_MERGE_TOOL, isMergeToolError, mergeToolChoices } from "./mergeTools";

describe("mergeToolChoices", () => {
  it("starts with git's configuration and ends with a custom command", () => {
    const choices = mergeToolChoices("");
    expect(choices[0]).toEqual({ value: "", label: "As configured in git" });
    expect(choices[choices.length - 1]).toEqual({ value: CUSTOM_MERGE_TOOL, label: "Custom command" });
    expect(choices).toContainEqual({ value: "opendiff", label: "FileMerge (opendiff)" });
    // Tools that draw in a terminal can't be opened from grit.
    expect(choices.map((c) => c.value)).not.toContain("vimdiff");
  });

  it("keeps a stored tool that isn't in the list", () => {
    expect(mergeToolChoices("mytool")).toContainEqual({ value: "mytool", label: "mytool" });
    expect(mergeToolChoices("meld").filter((c) => c.value === "meld")).toHaveLength(1);
    expect(mergeToolChoices(CUSTOM_MERGE_TOOL).filter((c) => c.value === CUSTOM_MERGE_TOOL)).toHaveLength(1);
  });
});

describe("isMergeToolError", () => {
  it("tells merge tool errors from the others", () => {
    expect(isMergeToolError("The merge tool /x does not exist")).toBe(true);
    expect(isMergeToolError("Enter the command that opens your merge tool, or choose another merge tool")).toBe(true);
    expect(isMergeToolError("The folder /missing does not exist")).toBe(false);
  });
});
