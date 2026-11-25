import "./controls.css";
import "./files.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Textarea } from "@ui-sdk/react/textarea";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { visibleText } from "@uplink-room/backend/files";
import { Tip } from "../Tip";
import type { Pin, ViewerPins } from "./pins";
import { DOC_EXTENSIONS, findQuote, richKeeps, selectionText } from "./docText";
import {
  draftStore,
  foundInSource,
  foundReporter,
  keepsMarkdown,
  saveQueue,
  type Draft,
  type SaveResult,
} from "./sync";

/**
 * A doc: Markdown edited in place with Tiptap (ADR 0010). It saves on a pause in
 * typing, naming the version it started from; a save from an older version is
 * refused, and the person chooses whose version to keep. Comment highlights are
 * editor decorations, so they never change the Markdown.
 *
 * HTML inside the Markdown is parsed by the editor's schema, which keeps only
 * known nodes, so it never runs. When the editor can't keep a file's text, the
 * file opens as Markdown source instead, so a save never drops part of it.
 */
export type { SaveResult } from "./sync";

type Anchor = {
  id: string;
  n: number | null;
  quote: string;
  prefix?: string | undefined;
  suffix?: string | undefined;
};

const commentsKey = new PluginKey<{ anchors: Anchor[]; selected: string | null }>(
  "uplink-comments",
);
const CONTEXT = 32;

function commentsExtension(onClick: (id: string) => void, onFound: (ids: string[]) => void) {
  return Extension.create({
    name: "uplinkComments",
    addProseMirrorPlugins() {
      const decorate = (doc: PMNode, anchors: Anchor[], selected: string | null) => {
        const decorations: Decoration[] = [];
        const found: string[] = [];
        for (const a of anchors) {
          const range = findQuote(doc, a);
          if (!range) continue;
          found.push(a.id);
          const active = a.id === selected || a.id === "draft";
          decorations.push(
            Decoration.inline(range.from, range.to, {
              class: `quote-mark${active ? " active" : ""}`,
              "data-comment": a.id,
            }),
          );
          if (a.n !== null) {
            const badge = document.createElement("sup");
            badge.className = `quote-badge${active ? " active" : ""}`;
            badge.textContent = String(a.n);
            badge.dataset["comment"] = a.id;
            decorations.push(
              Decoration.widget(range.to, badge, { side: 1, key: `${a.id}-${a.n}-${active}` }),
            );
          }
        }
        return { set: DecorationSet.create(doc, decorations), found };
      };
      return [
        new Plugin({
          key: commentsKey,
          state: {
            init: () => ({ anchors: [] as Anchor[], selected: null as string | null }),
            apply: (tr, value) => tr.getMeta(commentsKey) ?? value,
          },
          props: {
            decorations(state) {
              const { anchors, selected } = commentsKey.getState(state)!;
              return decorate(state.doc, anchors, selected).set;
            },
            handleClick(_view, _pos, event) {
              const id = (event.target as HTMLElement).closest<HTMLElement>("[data-comment]")
                ?.dataset["comment"];
              if (id && id !== "draft") onClick(id);
              return false;
            },
          },
          view: () => ({
            update(view) {
              const { anchors, selected } = commentsKey.getState(view.state)!;
              // The reporter drops repeats, and drops these while the source is showing.
              onFound(decorate(view.state.doc, anchors, selected).found);
            },
          }),
        }),
      ];
    },
  });
}

/**
 * Unsaved edits are kept on this computer until they're saved, so closing the doc,
 * switching files or quitting before the autosave never loses them (see `draftStore`).
 */
const drafts = draftStore({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
});

/** Which comments a doc shows as attached, by its text: shared by the editor and the source. */
function foundIn(doc: PMNode, anchors: Omit<Anchor, "n">[]): string[] {
  return anchors.filter((a) => findQuote(doc, a)).map((a) => a.id);
}

export default function DocViewer({
  fileId,
  content,
  version,
  updatedBy,
  onSave,
  pins,
  selected,
  draft,
  onPlace,
  onSelect,
  onFound,
}: Omit<ViewerPins, "placing"> & {
  fileId: string;
  content: string;
  version: number;
  updatedBy: string;
  onSave: (content: string, baseVersion: number) => Promise<SaveResult>;
  onFound: (ids: string[]) => void;
}) {
  const current = useRef(content);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const [cantKeep, setCantKeep] = useState(false);
  const [source, setSource] = useState(content);
  const [bubble, setBubble] = useState<{ top: number; left: number } | null>(null);
  const [sourceSelection, setSourceSelection] = useState<{ quote: string } | null>(null);
  const [restorable, setRestorable] = useState<Draft | null>(() => {
    const stored = drafts.read(fileId);
    if (stored && stored.content === content) drafts.settle(fileId, stored.rev, content);
    return stored && stored.content !== content ? stored : null;
  });
  /** The revision of the draft this viewer last kept; a save clears only that one. */
  const draftRev = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A pending check of whether the rich editor can keep the source being edited. */
  const recheck = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onSelect, onFound });
  handlers.current = { onSelect, onFound };
  const reporter = useMemo(() => foundReporter((ids) => handlers.current.onFound(ids)), []);
  const editorRef = useRef<Editor | null>(null);

  const comments = useMemo(
    () =>
      commentsExtension(
        (id) => handlers.current.onSelect(id),
        (ids) => reporter.found("rich", ids),
      ),
    [reporter],
  );

  /**
   * The one way text gets into the doc: on open, a remote update, a restored draft, loading
   * someone else's version, and switching back to rich text. The editor takes the text, and
   * if its Markdown wouldn't keep the file's structure (raw HTML, for example), the doc
   * switches to source so a rich edit can never save a transformed copy over it. Returns
   * whether the rich editor can keep the text.
   */
  function showContent(text: string, e: Editor | null = editorRef.current): boolean {
    clearTimeout(recheck.current);
    current.current = text;
    setSource(text);
    if (!e) return false;
    e.commands.setContent(text, { contentType: "markdown", emitUpdate: false });
    const keeps = keepsMarkdown(text, e.getMarkdown());
    setCantKeep(!keeps);
    if (!keeps) setMode("source");
    return keeps;
  }

  /**
   * One save at a time (see saveQueue): the autosave, the save on leaving the doc and "save
   * mine over it" all go through it, so edits made during a slow save go out after it, against
   * the version it returned, instead of racing it into a conflict nobody caused.
   */
  const [queue] = useState(() =>
    saveQueue({
      base: version,
      send: (text, base) => onSaveRef.current(text, base),
      latest: () => ({ content: current.current, rev: draftRev.current }),
      onBusy: setSaving,
      onResult: ({ result, content: sent, rev, more }) => {
        if ("version" in result) {
          // Clears this save's draft, or one with the text it saved; newer edits keep theirs.
          drafts.settle(fileId, rev, sent);
          // Clean only when no other save follows and the doc holds what was saved.
          if (!more && current.current === sent) {
            setDirty(false);
            dirtyRef.current = false;
          }
          setConflict(null);
        } else {
          setConflict(result.conflict);
        }
      },
    }),
  );

  const save = () => {
    clearTimeout(timer.current);
    // Nothing to save when the doc holds what was last saved (an edit undone during a save).
    if (!dirtyRef.current) return;
    queue.request(current.current, draftRev.current);
  };

  const changed = (text: string) => {
    current.current = text;
    setDirty(true);
    dirtyRef.current = true;
    draftRev.current = drafts.write(fileId, { content: text, base: queue.base() });
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 1000);
  };

  const editor = useEditor(
    {
      extensions: [...DOC_EXTENSIONS, comments],
      content,
      contentType: "markdown",
      editorProps: { attributes: { class: "md doc-prose", "aria-label": "Doc" } },
      onCreate: ({ editor: e }) => {
        editorRef.current = e;
        showContent(content, e);
      },
      onUpdate: ({ editor: e }) => changed(e.getMarkdown()),
      onSelectionUpdate: ({ editor: e }) => placeBubble(e),
      onBlur: () => setTimeout(() => setBubble(null), 150),
    },
    [queue],
  );

  function placeBubble(e: Editor) {
    const { from, to, empty } = e.state.selection;
    const box = wrap.current?.getBoundingClientRect();
    if (empty || !box || !selectionText(e.state.doc, from, to).trim()) return setBubble(null);
    const end = e.view.coordsAtPos(to);
    setBubble({
      top: end.bottom - box.top + (wrap.current?.scrollTop ?? 0) + 6,
      left: end.left - box.left,
    });
  }

  // Someone else saved: take their version unless there are unsaved edits here.
  useEffect(() => {
    if (saving || version === queue.base()) return;
    if (dirty) {
      setConflict(`${updatedBy} saved a newer version while you were editing.`);
      return;
    }
    queue.setBase(version);
    // An agent may have written Markdown the editor can't keep: showContent switches to source.
    showContent(content, editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, content, saving, dirty, editor, updatedBy]);

  // Edits restored from this computer that have since been saved (by the viewer that made them)
  // need no offer.
  useEffect(() => {
    if (restorable && restorable.content === content) {
      drafts.settle(fileId, restorable.rev, content);
      setRestorable(null);
    }
  }, [restorable, content, fileId]);

  // Only the view that shows the text reports attached comments (see foundReporter). This runs
  // before the effects below, so a report from the hidden view is dropped.
  useEffect(() => {
    reporter.setMode(mode);
  }, [reporter, mode]);

  // In source mode the editor isn't showing the text, so attached comments come from the source.
  useEffect(() => {
    if (mode !== "source") return;
    const anchors = pins.flatMap((p) =>
      p.pin.kind === "text" ? [{ id: p.commentId, quote: p.pin.quote }] : [],
    );
    reporter.found("source", foundInSource(source, anchors));
  }, [reporter, mode, source, pins]);

  // Back in rich text, the editor reports what it shows now.
  useEffect(() => {
    if (mode !== "rich" || !editor) return;
    const anchors = pins.flatMap((p) =>
      p.pin.kind === "text"
        ? [{ id: p.commentId, quote: p.pin.quote, prefix: p.pin.prefix, suffix: p.pin.suffix }]
        : [],
    );
    reporter.found("rich", foundIn(editor.state.doc, anchors));
  }, [reporter, mode, editor, pins]);

  // Comment anchors, as decorations.
  useEffect(() => {
    if (!editor) return;
    const anchors: Anchor[] = pins.flatMap((p) =>
      p.pin.kind === "text"
        ? [
            {
              id: p.commentId,
              n: p.n,
              quote: p.pin.quote,
              prefix: p.pin.prefix,
              suffix: p.pin.suffix,
            },
          ]
        : [],
    );
    if (draft?.kind === "text")
      anchors.push({
        id: "draft",
        n: null,
        quote: draft.quote,
        prefix: draft.prefix,
        suffix: draft.suffix,
      });
    editor.view.dispatch(editor.state.tr.setMeta(commentsKey, { anchors, selected }));
  }, [editor, pins, selected, draft]);

  // Scroll a selected comment's passage into view.
  useEffect(() => {
    if (!selected || !wrap.current) return;
    wrap.current
      .querySelector(`[data-comment="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected]);

  // Leaving the doc (another file, closing the tab) saves pending edits now instead of dropping
  // the autosave. If that save fails, the draft stays on this computer and is offered next time.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(recheck.current);
      // Joins the queue, behind a save that is still out; its result settles only its own draft.
      if (dirtyRef.current) queue.request(current.current, draftRev.current);
    },
    [queue],
  );

  const commentOnSelection = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const doc = editor.state.doc;
    const quote = selectionText(doc, from, to).trim();
    if (!quote) return;
    const pin: Pin = {
      kind: "text",
      quote: quote.slice(0, 500),
      prefix: selectionText(doc, Math.max(0, from - 200), from).slice(-CONTEXT),
      suffix: selectionText(doc, to, Math.min(doc.content.size, to + 200)).slice(0, CONTEXT),
    };
    setBubble(null);
    onPlace(pin);
  };

  const status = conflict ? null : saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";

  return (
    <div className="doc-viewer">
      <div className="viewer-tools">
        {/* Rich text stays focusable while the editor can't keep the file, so its hint says why. */}
        <ToggleGroup
          className="seg surface-seg"
          aria-label="Editing mode"
          value={[mode]}
          deselectable={false}
          onValueChange={(next) => {
            if (next[0] === "rich" && mode !== "rich") {
              if (showContent(current.current)) setMode("rich");
            } else if (next[0] === "source" && mode !== "source") {
              setSource(current.current);
              setMode("source");
            }
          }}
        >
          <Tip label={cantKeep ? "The rich editor can't keep everything in this file" : undefined}>
            <Toggle value="rich" disabled={cantKeep}>
              <span className="surface-label">Rich text</span>
            </Toggle>
          </Tip>
          <Toggle value="source">
            <span className="surface-label">Markdown</span>
          </Toggle>
        </ToggleGroup>
        <span className="grow" />
        {status ? <span className="muted save-state">{status}</span> : null}
      </div>
      {cantKeep ? (
        <div className="viewer-note">
          This file has Markdown the rich editor can't keep, such as raw HTML, so it is edited as
          source. Saving here keeps all of it.
        </div>
      ) : null}
      {restorable ? (
        <div className="viewer-note" role="alert">
          <span className="grow">
            This doc has edits from earlier on this computer that weren't saved.
          </span>
          <button
            className="btn"
            type="button"
            onClick={() => {
              drafts.settle(fileId, restorable.rev);
              setRestorable(null);
            }}
          >
            Discard them
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              setRestorable(null);
              queue.setBase(restorable.base);
              showContent(restorable.content);
              changed(restorable.content);
            }}
          >
            Restore them
          </button>
        </div>
      ) : null}
      {conflict ? (
        <div className="viewer-note conflict" role="alert">
          <span className="grow">{conflict} Your edits aren't saved.</span>
          <button
            className="btn"
            type="button"
            onClick={() => {
              clearTimeout(timer.current);
              queue.cancelWaiting();
              queue.setBase(version);
              showContent(content);
              setDirty(false);
              dirtyRef.current = false;
              drafts.settle(fileId, draftRev.current);
              setConflict(null);
            }}
          >
            Load their version
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              queue.setBase(version);
              save();
            }}
          >
            Save mine over it
          </button>
        </div>
      ) : null}
      <div className="doc-scroll" ref={wrap}>
        {mode === "rich" ? (
          <>
            <EditorContent editor={editor} className="doc-page" />
            {bubble ? (
              <button
                type="button"
                className="btn quote-bubble"
                style={{ top: bubble.top, left: bubble.left }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={commentOnSelection}
              >
                Comment
              </button>
            ) : null}
          </>
        ) : (
          <div className="doc-page">
            <Textarea
              className="textarea doc-source"
              aria-label="Markdown source"
              value={source}
              spellCheck={false}
              onValueChange={(text) => {
                setSource(text);
                changed(text);
                // Once the Markdown the editor can't keep is gone, rich text is offered again (and
                // the other way round). Switching still runs the editor's own check.
                clearTimeout(recheck.current);
                recheck.current = setTimeout(() => setCantKeep(!richKeeps(text)), 400);
              }}
              // UI SDK's Textarea types leave out onSelect; the capture phase gets the same event.
              onSelectCapture={(event) => {
                const el = event.currentTarget;
                const text = el.value.slice(el.selectionStart, el.selectionEnd);
                setBubble(null);
                if (text.trim()) {
                  const plain = visibleText(text).trim();
                  if (plain) {
                    setSourceSelection({ quote: plain.slice(0, 500) });
                    return;
                  }
                }
                setSourceSelection(null);
              }}
            />
            {sourceSelection ? (
              <button
                className="btn"
                type="button"
                onClick={() => onPlace({ kind: "text", quote: sourceSelection.quote })}
              >
                Comment on the selected text
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
