import { history, redo, undo } from "@codemirror/commands";
import { EditorState, TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { ConflictSegment } from "./api";
import { layoutConflict, takeText } from "./conflict";
import {
  choiceSpec,
  conflictRegions,
  keepSpec,
  lineAnchors,
  regionAt,
  regionsField,
  resolutionLabel,
  resolutionsOf,
} from "./conflictRegions";

const segments: ConflictSegment[] = [
  { kind: "common", text: "one\n" },
  { kind: "conflict", ours: "TWO\nand more\n", base: "two\n", theirs: "2\n" },
  { kind: "common", text: "three\n" },
  { kind: "conflict", ours: "", base: null, theirs: "four\n" },
  { kind: "common", text: "five\n" },
];
const layout = layoutConflict(segments);

/** The state of the result pane: "one / two / three / five", with an empty second conflict before "five". */
function resultState(): EditorState {
  return EditorState.create({
    doc: layout.result,
    extensions: [
      history(),
      conflictRegions({
        regions: layout.conflicts.map((c) => ({ ...c.result, resolution: "unresolved" })),
        label: (index) => `Conflict ${index + 1}`,
        onSelect: () => {},
      }),
    ],
  });
}

const apply = (state: EditorState, ...specs: TransactionSpec[]) =>
  specs.reduce((current, spec) => current.update(spec).state, state);

/** The text in the place of each conflict. */
const texts = (state: EditorState) => state.field(regionsField).map((r) => state.sliceDoc(r.from, r.to));

/** Runs an editor command (undo, redo) on a state without a view. */
function run(command: typeof undo, state: EditorState): EditorState {
  let next = state;
  command({ state, dispatch: (tr) => (next = tr.state) });
  return next;
}

/** Types `text` at `pos`, as the user would. */
const type = (pos: number, text: string): TransactionSpec => ({
  changes: { from: pos, insert: text },
  userEvent: "input.type",
});

describe("conflictRegions", () => {
  it("starts with every conflict unresolved, showing its base", () => {
    const state = resultState();
    expect(resolutionsOf(state)).toEqual(["unresolved", "unresolved"]);
    expect(texts(state)).toEqual(["two\n", ""]);
  });

  it("puts a choice in the place of a conflict", () => {
    const [first, second] = layout.conflicts;
    let state = apply(resultState(), choiceSpec(resultState(), 0, "ours", first.oursText));
    expect(state.doc.toString()).toBe("one\nTWO\nand more\nthree\nfive\n");
    expect(resolutionsOf(state)).toEqual(["ours", "unresolved"]);
    expect(texts(state)).toEqual(["TWO\nand more\n", ""]);

    // The empty conflict further down moved with the text, and takes its side where it is.
    state = apply(state, choiceSpec(state, 1, "theirs", second.theirsText));
    expect(state.doc.toString()).toBe("one\nTWO\nand more\nthree\nfour\nfive\n");
    expect(texts(state)).toEqual(["TWO\nand more\n", "four\n"]);
    expect(resolutionsOf(state)).toEqual(["ours", "theirs"]);
  });

  it("lets a conflict be decided again, also with an empty side", () => {
    const [first, second] = layout.conflicts;
    let state = resultState();
    state = apply(state, choiceSpec(state, 0, "theirs", first.theirsText));
    state = apply(state, choiceSpec(state, 0, "ours-theirs", takeText({ ours: first.oursText, theirs: first.theirsText }, "ours-theirs")));
    expect(texts(state)[0]).toBe("TWO\nand more\n2\n");
    expect(resolutionsOf(state)[0]).toBe("ours-theirs");

    state = apply(state, choiceSpec(state, 1, "theirs", second.theirsText));
    state = apply(state, choiceSpec(state, 1, "ours", second.oursText));
    expect(texts(state)[1]).toBe("");
    expect(resolutionsOf(state)[1]).toBe("ours");
    state = apply(state, choiceSpec(state, 1, "theirs", second.theirsText));
    expect(texts(state)[1]).toBe("four\n");
    expect(state.doc.toString()).toBe("one\nTWO\nand more\n2\nthree\nfour\nfive\n");
  });

  it("marks a conflict as edited when the user types in it", () => {
    const start = resultState();
    const first = start.field(regionsField)[0];

    // In the middle of its text, and at its very start.
    for (const pos of [first.from + 1, first.from]) {
      const state = apply(start, type(pos, "x"));
      expect(resolutionsOf(state)).toEqual(["edited", "unresolved"]);
      expect(texts(state)[0]).toHaveLength(5);
    }
    // Deleting part of it counts too.
    const deleted = apply(start, { changes: { from: first.from, to: first.from + 2 }, userEvent: "delete" });
    expect(resolutionsOf(deleted)[0]).toBe("edited");
    expect(texts(deleted)[0]).toBe("o\n");

    // Typing where an empty conflict is fills it.
    const second = start.field(regionsField)[1];
    const filled = apply(start, type(second.from, "by hand\n"));
    expect(resolutionsOf(filled)).toEqual(["unresolved", "edited"]);
    expect(texts(filled)[1]).toBe("by hand\n");
  });

  it("leaves conflicts alone when the text around them is edited", () => {
    const start = resultState();
    const first = start.field(regionsField)[0];

    // Before the conflict, right after it, and at the end of the document.
    const before = apply(start, type(0, "zero\n"));
    expect(resolutionsOf(before)).toEqual(["unresolved", "unresolved"]);
    expect(texts(before)).toEqual(["two\n", ""]);
    expect(before.field(regionsField)[0].from).toBe(first.from + 5);

    const after = apply(start, type(first.to, "x"));
    expect(resolutionsOf(after)).toEqual(["unresolved", "unresolved"]);
    expect(texts(after)[0]).toBe("two\n");

    const end = apply(start, type(start.doc.length, "tail\n"));
    expect(resolutionsOf(end)).toEqual(["unresolved", "unresolved"]);
    expect(texts(end)).toEqual(["two\n", ""]);
  });

  it("keeps a resolved conflict's choice until it is typed in", () => {
    let state = resultState();
    state = apply(state, choiceSpec(state, 0, "ours", layout.conflicts[0].oursText));
    state = apply(state, type(state.field(regionsField)[0].from + 3, "!"));
    expect(resolutionsOf(state)[0]).toBe("edited");
    expect(texts(state)[0]).toBe("TWO!\nand more\n");
  });

  it("accepts the text of a conflict as it is", () => {
    const state = apply(resultState(), keepSpec(1));
    expect(resolutionsOf(state)).toEqual(["unresolved", "edited"]);
    expect(state.doc.toString()).toBe(layout.result);
  });

  it("undoes and redoes the resolution with the text", () => {
    let state = resultState();
    state = apply(state, choiceSpec(state, 0, "ours", layout.conflicts[0].oursText));
    state = apply(state, choiceSpec(state, 1, "theirs", layout.conflicts[1].theirsText));
    state = apply(state, type(state.field(regionsField)[1].from, "x"));
    expect(resolutionsOf(state)).toEqual(["ours", "edited"]);

    state = run(undo, state);
    expect(resolutionsOf(state)).toEqual(["ours", "theirs"]);
    expect(texts(state)).toEqual(["TWO\nand more\n", "four\n"]);

    state = run(undo, state);
    expect(resolutionsOf(state)).toEqual(["ours", "unresolved"]);
    expect(texts(state)).toEqual(["TWO\nand more\n", ""]);

    state = run(undo, state);
    expect(resolutionsOf(state)).toEqual(["unresolved", "unresolved"]);
    expect(state.doc.toString()).toBe(layout.result);
    expect(texts(state)).toEqual(["two\n", ""]);

    state = run(redo, run(redo, state));
    expect(resolutionsOf(state)).toEqual(["ours", "theirs"]);
    expect(texts(state)).toEqual(["TWO\nand more\n", "four\n"]);

    // Accepting a conflict as it is can be undone as well.
    state = run(undo, apply(resultState(), keepSpec(0)));
    expect(resolutionsOf(state)).toEqual(["unresolved", "unresolved"]);
  });

  it("says what a conflict is resolved with", () => {
    const sides = {
      ours: { name: "main", detail: "current branch" },
      theirs: { name: "feature", detail: "being merged" },
    };
    expect(resolutionLabel("unresolved", sides)).toBe("unresolved");
    expect(resolutionLabel("ours", sides)).toBe("main");
    expect(resolutionLabel("theirs", sides)).toBe("feature");
    expect(resolutionLabel("ours-theirs", sides)).toBe("main, then feature");
    expect(resolutionLabel("theirs-ours", sides)).toBe("feature, then main");
    expect(resolutionLabel("edited", sides)).toBe("edited");
  });

  it("finds the conflict at a position and the lines the conflicts span", () => {
    const state = resultState();
    const [first, second] = state.field(regionsField);
    expect(regionAt(state, 0)).toBe(-1);
    expect(regionAt(state, first.from)).toBe(0);
    expect(regionAt(state, first.to)).toBe(0);
    expect(regionAt(state, second.from)).toBe(1);
    expect(regionAt(state, state.doc.length)).toBe(-1);

    // "one / two / three / five" plus the empty last line: the second conflict is empty, before "five".
    expect(lineAnchors(state)).toEqual([0, 1, 2, 3, 3, 5]);
    const resolved = apply(state, choiceSpec(state, 0, "ours", layout.conflicts[0].oursText));
    expect(lineAnchors(resolved)).toEqual([0, 1, 3, 4, 4, 6]);
  });
});
