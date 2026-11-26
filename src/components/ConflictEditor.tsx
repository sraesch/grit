import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { ReactNode, useEffect, useRef, useState } from "react";
import { api, ConflictFile, errorMessage, FileChange } from "../api";
import {
  ConflictChoice,
  ConflictLayout,
  ConflictSides,
  layoutConflict,
  mapLine,
  STALE_CONFLICT,
  takeText,
  TextRange,
} from "../conflict";
import {
  choiceSpec,
  conflictRegions,
  currentSpec,
  keepSpec,
  lineAnchors,
  regionAt,
  regionsField,
  Resolution,
  resolutionLabel,
  resolutionsOf,
} from "../conflictRegions";
import { plural } from "../remote";
import { ContextMenu } from "./ContextMenu";
import { PaneTitle } from "./DiffView";

/**
 * What the editor's documents call back into. It is kept apart from the component, so that a
 * document put aside as a draft keeps working when another instance picks it up.
 */
interface Bridge {
  onSelect: (index: number) => void;
  onChange: (state: EditorState) => void;
  resultLabel: (resolution: Resolution) => string;
}

/** The unsaved result of a conflicted file, with its undo history. */
export interface ConflictDraft {
  /** What the draft was started from; a draft of another state of the conflict is dropped. */
  token: string;
  state: EditorState;
  bridge: Bridge;
}

interface ConflictEditorProps {
  repo: string;
  /** The conflicted file to resolve. */
  file: FileChange;
  sides: ConflictSides;
  /** Controls for the header of the pane, e.g. taking a side for the whole file. */
  actions?: ReactNode;
  /** Unsaved results by path, kept by the parent so that they survive showing another file. */
  drafts: Map<string, ConflictDraft>;
  /** The result was saved and the file staged. */
  onSaved: () => void;
  /** The file can't be shown here, with the reason (a deleted side, a binary file, …). */
  onUnavailable: (reason: string) => void;
  onError: (message: string) => void;
}

interface Loaded {
  path: string;
  conflict: ConflictFile;
  layout: ConflictLayout;
}

interface Views {
  ours: EditorView;
  result: EditorView;
  theirs: EditorView;
}

/** Holds the language of the file, which is loaded after the editors are shown. */
const language = new Compartment();

/** The app's colors and code font; the conflict tints and syntax colors are in App.css. */
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", color: "var(--text)", backgroundColor: "var(--bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "18px", overflow: "auto" },
  ".cm-content": { padding: "0 0 18px" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-alt)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
});

const shared: Extension = [lineNumbers(), theme, syntaxHighlighting(classHighlighter), language.of([])];

/** The document of one side: read-only, with its conflicts set off. */
function sideState(doc: string, ranges: TextRange[], label: string, bridge: Bridge): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      shared,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ "aria-label": label }),
      conflictRegions({
        regions: ranges.map((range) => ({ ...range, resolution: "side" })),
        label: (index) => `Conflict ${index + 1}`,
        onSelect: (index) => bridge.onSelect(index),
      }),
    ],
  });
}

/** The document of the result, which can be edited freely and remembers how each conflict was resolved. */
function resultState(layout: ConflictLayout, bridge: Bridge): EditorState {
  return EditorState.create({
    doc: layout.result,
    extensions: [
      shared,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ "aria-label": "Result" }),
      conflictRegions({
        regions: layout.conflicts.map((conflict) => ({ ...conflict.result, resolution: "unresolved" })),
        label: (index, region) => `Conflict ${index + 1} · ${bridge.resultLabel(region.resolution)}`,
        onSelect: (index) => bridge.onSelect(index),
      }),
      EditorView.updateListener.of((update) => {
        if (update.transactions.some((tr) => tr.docChanged || tr.effects.length > 0)) bridge.onChange(update.state);
        // The toolbar follows the cursor into a conflict.
        if (update.selectionSet) {
          const index = regionAt(update.state, update.state.selection.main.head);
          if (index >= 0) bridge.onSelect(index);
        }
      }),
    ],
  });
}

/** Scrolls the panes so that each shows the conflict at its top. */
function showConflict(views: Views, index: number) {
  for (const view of Object.values(views)) {
    const region = view.state.field(regionsField)[index];
    if (region) view.dispatch({ effects: EditorView.scrollIntoView(region.from, { y: "start", yMargin: 36 }) });
  }
}

/**
 * Keeps the panes at the same place of the file while one of them is scrolled. Their lines differ
 * inside the conflicts, so a line is carried over by its position between the conflicts around it.
 */
function syncScrolling(views: EditorView[]): () => void {
  // Where this function scrolled a pane to. The scroll event that follows is its own doing and
  // must not carry the pane's position back to the others.
  const moved = new Map<EditorView, number>();
  const stop = views.map((source) => {
    const onScroll = () => {
      const top = source.scrollDOM.scrollTop;
      const expected = moved.get(source);
      moved.delete(source);
      if (expected !== undefined && Math.abs(top - expected) <= 1) return;

      const block = source.lineBlockAtHeight(top);
      const line = source.state.doc.lineAt(block.from).number - 1;
      const within = block.height > 0 ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0;
      const from = lineAnchors(source.state);
      for (const target of views) {
        if (target === source) continue;
        const scroller = target.scrollDOM;
        const mapped = mapLine(from, lineAnchors(target.state), line + within);
        const index = Math.min(Math.floor(mapped), target.state.doc.lines - 1);
        const targetBlock = target.lineBlockAt(target.state.doc.line(index + 1).from);
        const wanted = targetBlock.top + (mapped - index) * targetBlock.height;
        const next = Math.round(Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, wanted)));
        if (Math.abs(scroller.scrollTop - next) > 1) {
          moved.set(target, next);
          scroller.scrollTop = next;
        }
        scroller.scrollLeft = source.scrollDOM.scrollLeft;
      }
    };
    source.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => source.scrollDOM.removeEventListener("scroll", onScroll);
  });
  return () => stop.forEach((off) => off());
}

/**
 * Resolves a conflicted text file one conflict at a time: our version, the result and their
 * version side by side. Each conflict takes the text of one side or of both, or is edited by
 * hand in the result, which is then saved and staged.
 */
export function ConflictEditor({
  repo,
  file,
  sides,
  actions,
  drafts,
  onSaved,
  onUnavailable,
  onError,
}: ConflictEditorProps) {
  const path = file.path;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  /** The conflict the toolbar acts on. */
  const [current, setCurrent] = useState(0);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [showBase, setShowBase] = useState(false);
  const [bothMenu, setBothMenu] = useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);
  /** The conflict changed under the editor: saving was refused until it is loaded again. */
  const [stale, setStale] = useState(false);
  const oursHost = useRef<HTMLDivElement>(null);
  const resultHost = useRef<HTMLDivElement>(null);
  const theirsHost = useRef<HTMLDivElement>(null);
  const views = useRef<Views | null>(null);
  /** Set when the result was saved or is loaded anew, so that it isn't put aside as a draft. */
  const discard = useRef(false);
  // Read by effects and editor callbacks that outlive a render.
  const latest = useRef({ onUnavailable, sides });
  latest.current = { onUnavailable, sides };

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setResolutions([]);
    setStale(false);
    api
      .conflictFile(repo, path)
      .then((conflict) => {
        if (!cancelled) setLoaded({ path, conflict, layout: layoutConflict(conflict.segments) });
      })
      .catch((e) => {
        if (!cancelled) latest.current.onUnavailable(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repo, path, reloads]);

  // The three editors live as long as the file is shown; the result is put aside as a draft after that.
  useEffect(() => {
    if (!loaded || !oursHost.current || !resultHost.current || !theirsHost.current) return;
    const { conflict, layout } = loaded;
    const draft = drafts.get(loaded.path);
    const kept = draft?.token === conflict.token ? draft : null;
    const bridge: Bridge = kept?.bridge ?? { onSelect: () => {}, onChange: () => {}, resultLabel: () => "" };
    bridge.onSelect = setCurrent;
    bridge.onChange = (state) => setResolutions(resolutionsOf(state));
    bridge.resultLabel = (resolution) => resolutionLabel(resolution, latest.current.sides);
    const state = kept?.state ?? resultState(layout, bridge);
    const { ours, theirs } = latest.current.sides;
    const oursRanges = layout.conflicts.map((c) => c.ours);
    const theirsRanges = layout.conflicts.map((c) => c.theirs);
    const all: Views = {
      ours: new EditorView({
        parent: oursHost.current,
        state: sideState(layout.ours, oursRanges, `Ours: ${ours.name}`, bridge),
      }),
      result: new EditorView({ parent: resultHost.current, state }),
      theirs: new EditorView({
        parent: theirsHost.current,
        state: sideState(layout.theirs, theirsRanges, `Theirs: ${theirs.name}`, bridge),
      }),
    };
    views.current = all;
    discard.current = false;

    const initial = resolutionsOf(state);
    const first = Math.max(0, initial.indexOf("unresolved"));
    setResolutions(initial);
    setCurrent(first);
    const frame = requestAnimationFrame(() => showConflict(all, first));
    const stopSync = syncScrolling(Object.values(all));

    let disposed = false;
    LanguageDescription.matchFilename(languages, loaded.path)
      ?.load()
      .then((support) => {
        if (disposed) return;
        for (const view of Object.values(all)) view.dispatch({ effects: language.reconfigure(support) });
      })
      // Without its language the file is shown as plain text.
      .catch(() => {});

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      stopSync();
      if (!discard.current) drafts.set(loaded.path, { token: conflict.token, state: all.result.state, bridge });
      for (const view of Object.values(all)) view.destroy();
      views.current = null;
    };
  }, [loaded, drafts]);

  // Set the current conflict off in all three panes.
  useEffect(() => {
    if (!views.current) return;
    for (const view of Object.values(views.current)) view.dispatch(currentSpec(current));
  }, [current, loaded]);

  const conflicts = loaded?.layout.conflicts ?? [];
  const conflict = conflicts[current];
  // Until the result's document reported its conflicts, none of them counts as resolved.
  const unresolved =
    resolutions.length === conflicts.length ? resolutions.filter((r) => r === "unresolved").length : conflicts.length;
  const { ours, theirs } = sides;

  function goTo(index: number) {
    setCurrent(index);
    if (views.current) showConflict(views.current, index);
  }

  function take(choice: ConflictChoice) {
    const view = views.current?.result;
    if (!view || !conflict) return;
    const text = takeText({ ours: conflict.oursText, theirs: conflict.theirsText }, choice);
    view.dispatch(choiceSpec(view.state, current, choice, text));
  }

  function reload() {
    discard.current = true;
    drafts.delete(path);
    setReloads((n) => n + 1);
  }

  async function save() {
    const view = views.current?.result;
    if (!view || !loaded) return;
    setSaving(true);
    try {
      await api.saveConflictFile(repo, path, loaded.conflict.token, view.state.doc.toString());
      discard.current = true;
      drafts.delete(path);
      onSaved();
    } catch (e) {
      const message = errorMessage(e);
      if (message.startsWith(STALE_CONFLICT)) setStale(true);
      else onError(message);
    } finally {
      setSaving(false);
    }
  }

  const remaining =
    conflicts.length === 0
      ? "Both sides merge without conflicting lines"
      : unresolved > 0
        ? `${plural(unresolved, "conflict")} left to resolve`
        : "All conflicts resolved";

  return (
    <div className="conflict-editor">
      <PaneTitle title={path} actions={actions} />
      {!loaded ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {!loaded.conflict.markers && (
            <p className="conflict-note" role="note">
              This file has no conflict markers left: it was already edited by hand. Saving here replaces that;
              “Mark resolved” on the file keeps it as it is.
            </p>
          )}
          {stale && (
            <p className="conflict-note" role="alert">
              The conflict changed since it was opened, so nothing was saved.
              <button className="small" onClick={reload}>
                Reload
              </button>
            </p>
          )}
          <div className="conflict-toolbar" role="toolbar" aria-label="Conflict">
            {conflict ? (
              <>
                <span className="conflict-position">
                  Conflict {current + 1} of {conflicts.length}
                </span>
                <button
                  className="small"
                  aria-label="Previous conflict"
                  title="Previous conflict"
                  disabled={conflicts.length < 2}
                  onClick={() => goTo((current + conflicts.length - 1) % conflicts.length)}
                >
                  ‹
                </button>
                <button
                  className="small"
                  aria-label="Next conflict"
                  title="Next conflict"
                  disabled={conflicts.length < 2}
                  onClick={() => goTo((current + 1) % conflicts.length)}
                >
                  ›
                </button>
                <span className="conflict-resolution">{resolutionLabel(resolutions[current] ?? "unresolved", sides)}</span>
                <span className="spacer" />
                <button className="small" title={`Resolve this conflict with the lines of ${ours.name}`} onClick={() => take("ours")}>
                  Take {ours.name}
                </button>
                <button
                  className="small"
                  title={`Resolve this conflict with the lines of ${theirs.name}`}
                  onClick={() => take("theirs")}
                >
                  Take {theirs.name}
                </button>
                <button
                  className="small"
                  aria-haspopup="menu"
                  title="Resolve this conflict with the lines of both sides, one after the other"
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    setBothMenu({ x: box.left, y: box.bottom + 2 });
                  }}
                >
                  Take both…
                </button>
                <button
                  className="small"
                  disabled={resolutions[current] !== "unresolved"}
                  title="Resolve this conflict with the lines that are in the result now, as edited by hand"
                  onClick={() => views.current?.result.dispatch(keepSpec(current))}
                >
                  Keep as edited
                </button>
                <button
                  className="small"
                  aria-pressed={showBase}
                  title="Show what both sides started from in this conflict"
                  onClick={() => setShowBase(!showBase)}
                >
                  Show base
                </button>
              </>
            ) : (
              <span className="conflict-position">No conflicting lines</span>
            )}
          </div>
          <div className="conflict-columns">
            <section className="conflict-column" aria-label={`Ours: ${ours.name}`}>
              <header title={`Ours: ${ours.name} (${ours.detail})`}>
                <strong>{ours.name}</strong> {ours.detail}
              </header>
              <div className="conflict-pane" ref={oursHost} />
            </section>
            <section className="conflict-column" aria-label="Result">
              <header title="The file as it will be saved">
                <strong>Result</strong>
              </header>
              <div className="conflict-pane" ref={resultHost} />
            </section>
            <section className="conflict-column" aria-label={`Theirs: ${theirs.name}`}>
              <header title={`Theirs: ${theirs.name} (${theirs.detail})`}>
                <strong>{theirs.name}</strong> {theirs.detail}
              </header>
              <div className="conflict-pane" ref={theirsHost} />
            </section>
          </div>
          {showBase && conflict && (
            <section className="conflict-base" aria-label="Base">
              <header>
                <strong>Base</strong> what both sides started from in conflict {current + 1}
              </header>
              {conflict.base === null ? (
                <p className="empty small">The sides have no common base here: both added these lines.</p>
              ) : conflict.base === "" ? (
                <p className="empty small">Nothing: both sides added lines here.</p>
              ) : (
                <pre className="selectable">{conflict.base}</pre>
              )}
            </section>
          )}
          <footer className="conflict-footer">
            <span role="status">{remaining}</span>
            <button
              className="primary"
              disabled={unresolved > 0 || saving || stale}
              title={
                unresolved > 0
                  ? `Resolve the remaining ${plural(unresolved, "conflict")} first`
                  : "Save the result to the file and stage it as resolved"
              }
              onClick={save}
            >
              Save and mark resolved
            </button>
          </footer>
        </>
      )}
      {bothMenu && (
        <ContextMenu
          x={bothMenu.x}
          y={bothMenu.y}
          label="Take both"
          items={[
            { label: `${ours.name}, then ${theirs.name}`, onSelect: () => take("ours-theirs") },
            { label: `${theirs.name}, then ${ours.name}`, onSelect: () => take("theirs-ours") },
          ]}
          onClose={() => setBothMenu(null)}
        />
      )}
    </div>
  );
}
