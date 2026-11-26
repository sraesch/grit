import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  Annotation,
  ChangeDesc,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { ConflictChoice, ConflictSides, TextRange } from "./conflict";

/**
 * How a conflict stands in the result: not decided yet, taken from the sides, or typed by hand.
 * In the panes that show a side, which can't be edited, it is always "side".
 */
export type Resolution = "unresolved" | ConflictChoice | "edited" | "side";

/** A conflict's place in a document of the conflict editor, kept up to date while the text changes. */
export interface Region extends TextRange {
  resolution: Resolution;
}

const setResolution = StateEffect.define<{ index: number; resolution: Resolution }>();
const setCurrent = StateEffect.define<number>();
/** Marks the transaction that puts a choice in place, as opposed to the user typing there. */
const choice = Annotation.define<boolean>();

/** Text put at the start of a region belongs to it; at its end only when the region is empty. */
function mapRegion(region: Region, changes: ChangeDesc): Region {
  const from = changes.mapPos(region.from, -1);
  const to = Math.max(from, changes.mapPos(region.to, region.from === region.to ? 1 : -1));
  return from === region.from && to === region.to ? region : { ...region, from, to };
}

/** Whether a change touches the text of a region. */
function touches(region: Region, tr: Transaction): boolean {
  let touched = false;
  tr.changes.iterChangedRanges((from, to) => {
    if (region.from === region.to) touched ||= from <= region.from && to >= region.from;
    else if (from === to) touched ||= from >= region.from && from < region.to;
    else touched ||= from < region.to && to > region.from;
  });
  return touched;
}

/** The conflicts of a document, in order. */
export const regionsField = StateField.define<readonly Region[]>({
  create: () => [],
  update(regions, tr) {
    let next = regions;
    if (tr.docChanged) {
      // Undo and redo bring the resolution back themselves, with the effects stored in the history.
      const typed = !tr.annotation(choice) && !tr.isUserEvent("undo") && !tr.isUserEvent("redo");
      next = regions.map((region) => {
        const mapped = mapRegion(region, tr.changes);
        const edited = typed && region.resolution !== "edited" && region.resolution !== "side" && touches(region, tr);
        return edited ? { ...mapped, resolution: "edited" } : mapped;
      });
    }
    for (const effect of tr.effects) {
      if (!effect.is(setResolution)) continue;
      const { index, resolution } = effect.value;
      next = next.map((region, i) => (i === index ? { ...region, resolution } : region));
    }
    return next;
  },
});

/** The conflict the toolbar acts on, which is set off from the others. */
const currentField = StateField.define<number>({
  create: () => 0,
  update: (current, tr) => tr.effects.reduce((value, effect) => (effect.is(setCurrent) ? effect.value : value), current),
});

/** Undoing a change also brings back what the conflicts were resolved with before it. */
const restoreResolutions = invertedEffects.of((tr) => {
  const before = tr.startState.field(regionsField);
  const after = tr.state.field(regionsField);
  const effects: StateEffect<unknown>[] = [];
  before.forEach((region, index) => {
    if (region.resolution !== after[index]?.resolution) {
      effects.push(setResolution.of({ index, resolution: region.resolution }));
    }
  });
  return effects;
});

export interface RegionsConfig {
  regions: Region[];
  /** The text of the line above a conflict, e.g. "Conflict 2 · unresolved". */
  label: (index: number, region: Region) => string;
  /** The line above a conflict was clicked. */
  onSelect: (index: number) => void;
}

/** The line above a conflict. It also keeps a conflict visible whose text is empty. */
class HeaderWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly label: string,
    readonly className: string,
    readonly onSelect: (index: number) => void,
  ) {
    super();
  }

  eq(other: HeaderWidget) {
    return other.index === this.index && other.label === this.label && other.className === this.className;
  }

  toDOM() {
    const header = document.createElement("div");
    header.className = `cm-conflict-header ${this.className}`;
    header.textContent = this.label;
    header.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.onSelect(this.index);
    });
    return header;
  }

  ignoreEvent() {
    return true;
  }
}

/** "cm-conflict-unresolved" until a conflict is decided, "cm-conflict-resolved" after, "cm-conflict-side" in a side's pane. */
function regionClass(region: Region, current: boolean): string {
  const state = region.resolution === "side" || region.resolution === "unresolved" ? region.resolution : "resolved";
  return `cm-conflict-${state}${current ? " cm-conflict-current" : ""}`;
}

function decorations(config: RegionsConfig): Extension {
  return EditorView.decorations.compute([regionsField, currentField], (state) => {
    const current = state.field(currentField);
    const ranges = state.field(regionsField).flatMap((region, index) => {
      const className = regionClass(region, index === current);
      const first = state.doc.lineAt(region.from);
      const header = Decoration.widget({
        widget: new HeaderWidget(index, config.label(index, region), className, config.onSelect),
        block: true,
        side: -1,
      });
      const lines = [header.range(first.from)];
      if (region.to > region.from) {
        const last = state.doc.lineAt(region.to - 1).number;
        const line = Decoration.line({ class: `cm-conflict-line ${className}` });
        for (let n = first.number; n <= last; n++) lines.push(line.range(state.doc.line(n).from));
      }
      return lines;
    });
    return Decoration.set(ranges, true);
  });
}

/** Tracks the conflicts of a document and sets them off: a line above each, and a tint on its lines. */
export function conflictRegions(config: RegionsConfig): Extension {
  return [regionsField.init(() => config.regions), currentField, restoreResolutions, decorations(config)];
}

/** Puts the text of a choice in the place of a conflict. */
export function choiceSpec(state: EditorState, index: number, resolution: ConflictChoice, text: string): TransactionSpec {
  const region = state.field(regionsField)[index];
  return {
    changes: { from: region.from, to: region.to, insert: text },
    effects: setResolution.of({ index, resolution }),
    // An undo step of its own, not joined with what is typed right before or after it.
    annotations: [choice.of(true), Transaction.userEvent.of("input.conflict"), isolateHistory.of("full")],
  };
}

/** Accepts the text that is in the place of a conflict now as its resolution. */
export function keepSpec(index: number): TransactionSpec {
  return { effects: setResolution.of({ index, resolution: "edited" }), annotations: isolateHistory.of("full") };
}

/** Sets a conflict off as the one the toolbar acts on. */
export function currentSpec(index: number): TransactionSpec {
  return { effects: setCurrent.of(index) };
}

/** What a conflict is resolved with, in words: the name of a side, both in order, "edited" or "unresolved". */
export function resolutionLabel(resolution: Resolution, sides: ConflictSides): string {
  const { ours, theirs } = sides;
  switch (resolution) {
    case "ours":
      return ours.name;
    case "theirs":
      return theirs.name;
    case "ours-theirs":
      return `${ours.name}, then ${theirs.name}`;
    case "theirs-ours":
      return `${theirs.name}, then ${ours.name}`;
    case "edited":
      return "edited";
    default:
      return "unresolved";
  }
}

export function resolutionsOf(state: EditorState): Resolution[] {
  return state.field(regionsField).map((region) => region.resolution);
}

/** The conflict the position is in, or at an end of; -1 outside of all. */
export function regionAt(state: EditorState, pos: number): number {
  return state.field(regionsField).findIndex((region) => pos >= region.from && pos <= region.to);
}

/**
 * The lines (0-based) at which the conflicts of a document start and end, framed by 0 and the
 * number of lines: the fixed points `mapLine` scrolls two panes together with.
 */
export function lineAnchors(state: EditorState): number[] {
  const line = (pos: number) => state.doc.lineAt(pos).number - 1;
  return [0, ...state.field(regionsField).flatMap((region) => [line(region.from), line(region.to)]), state.doc.lines];
}
