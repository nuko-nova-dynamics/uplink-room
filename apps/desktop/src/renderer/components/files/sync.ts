/**
 * The file viewers' decisions that don't need a DOM, kept here so they can be
 * unit-tested: which canvas shapes from the room to merge, which occurrence of a
 * repeated passage a comment means, whether the rich editor kept a doc's
 * Markdown, and which doc comments are still attached while the source is edited.
 */
import { marked, type Token } from "marked";
import { comparable, visibleText } from "@uplink-room/backend/files";

// --- Canvases ----------------------------------------------------------------

export type ShapeVersion = { version: number; versionNonce: number };

/**
 * The shapes from the room this viewer should merge: ones it hasn't seen, newer
 * ones, and ones at the same version with a different nonce. The last kind is
 * another editor's edit that won a tie in the room (the lower nonce wins, in the
 * room and in Excalidraw's `reconcileElements`), which this viewer must adopt.
 */
export function freshRemote<E extends { id: string } & ShapeVersion>(known: ReadonlyMap<string, ShapeVersion>, remote: E[]): E[] {
  return remote.filter((e) => {
    const k = known.get(e.id);
    return !k || e.version > k.version || (e.version === k.version && e.versionNonce !== k.versionNonce);
  });
}

// --- Doc comments ------------------------------------------------------------

/**
 * Where in `text` (already normalized with `comparable`) a quoted passage sits.
 * Of several occurrences, the one whose surroundings match the comment's prefix
 * and suffix best wins; on a tie, the first. -1 when the passage isn't there.
 */
export function pickOccurrence(text: string, quote: string, prefix = "", suffix = ""): number {
  const q = comparable(quote);
  if (!q) return -1;
  const before = comparable(prefix);
  const after = comparable(suffix);
  let best = -1;
  let bestScore = -1;
  for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + 1)) {
    const score =
      (before && text.slice(0, at).trimEnd().endsWith(before) ? 1 : 0) +
      (after && text.slice(at + q.length).trimStart().startsWith(after) ? 1 : 0);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

/** Ids of the quotes whose passage is in the Markdown source, by the text the doc shows. */
export function foundInSource(source: string, anchors: { id: string; quote: string }[]): string[] {
  const text = comparable(visibleText(source));
  return anchors.filter((a) => text.includes(comparable(a.quote))).map((a) => a.id);
}

// --- Markdown round trip -----------------------------------------------------

type Tok = Token & {
  tokens?: Tok[];
  items?: Tok[];
  header?: { tokens: Tok[] }[];
  rows?: { tokens: Tok[] }[][];
  text?: string;
};

/**
 * A doc's structure as a flat list: each element with what makes it itself
 * (heading level, list kind, task state, code language, link target and title,
 * image source), and the text between them. Blank lines, marker style, table
 * padding, escapes and entities don't count, since the editor rewrites those.
 */
function structure(markdown: string): string[] {
  const out: string[] = [];
  let joinText = false;
  const text = (s: string) => {
    if (joinText && out.length && out[out.length - 1]!.startsWith("t:")) out[out.length - 1] += s;
    else out.push(`t:${s}`);
    joinText = true;
  };
  const mark = (s: string) => {
    out.push(s);
    joinText = false;
  };
  const walk = (t: Tok) => {
    switch (t.type) {
      case "space":
      case "checkbox":
        return;
      case "html":
        mark(`html:${t.raw.trim()}`);
        return;
      case "text":
      case "escape":
        if (t.tokens) t.tokens.forEach(walk);
        else text(visibleText(t.raw));
        return;
      case "paragraph":
        joinText = false;
        t.tokens?.forEach(walk);
        joinText = false;
        return;
      case "heading":
        mark(`h${(t as Tok & { depth: number }).depth}`);
        break;
      case "list":
        mark((t as Tok & { ordered: boolean }).ordered ? "ol" : "ul");
        t.items?.forEach(walk);
        mark("/list");
        return;
      case "list_item": {
        const item = t as Tok & { task: boolean; checked?: boolean };
        mark(item.task ? `task:${item.checked === true}` : "li");
        break;
      }
      case "code":
        mark(`code:${(t as Tok & { lang?: string }).lang ?? ""}`);
        text(t.text ?? "");
        mark("/code");
        return;
      case "codespan":
        mark("codespan");
        text(visibleText(t.raw));
        mark("/codespan");
        return;
      case "link": {
        const link = t as Tok & { href: string; title?: string | null };
        mark(`link:${link.href}:${link.title ?? ""}`);
        break;
      }
      case "image": {
        const image = t as Tok & { href: string; title?: string | null };
        mark(`img:${image.href}:${image.title ?? ""}:${t.text ?? ""}`);
        return;
      }
      case "table":
        mark("table");
        for (const row of [t.header ?? [], ...(t.rows ?? [])]) {
          mark("tr");
          for (const cell of row) {
            mark("td");
            cell.tokens.forEach(walk);
          }
        }
        mark("/table");
        return;
      default:
        mark(t.type);
    }
    t.tokens?.forEach(walk);
    mark(`/${t.type}`);
  };
  (marked.lexer(markdown, { gfm: true }) as Tok[]).forEach(walk);
  return out.map((entry) => (entry.startsWith("t:") ? `t:${comparable(entry.slice(2))}` : entry)).filter((e) => e !== "t:");
}

/** True when the editor's Markdown has every element and word of the original. */
export function keepsMarkdown(original: string, edited: string): boolean {
  const a = structure(original);
  const b = structure(edited);
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

// --- Unsaved drafts ----------------------------------------------------------

export type Draft = { content: string; base: number; rev: string };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Unsaved doc edits kept on this computer until a save lands. Each write gets a
 * revision, and a finished save clears the draft only if it still holds the
 * revision or the text that save sent: a later edit with other text, even from a
 * reopened viewer of the same file, keeps its recovery copy. Storage that throws
 * (full, blocked) is ignored.
 */
export function draftStore(storage: DraftStorage) {
  const key = (fileId: string) => `uplink.doc-draft.${fileId}`;
  const read = (fileId: string): Draft | null => {
    try {
      const raw = storage.getItem(key(fileId));
      const draft = raw ? (JSON.parse(raw) as Draft) : null;
      return draft && typeof draft.content === "string" && typeof draft.base === "number" && typeof draft.rev === "string"
        ? draft
        : null;
    } catch {
      return null;
    }
  };
  return {
    read,
    /** Keeps the edits and returns their revision. */
    write(fileId: string, draft: Omit<Draft, "rev">): string {
      const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        storage.setItem(key(fileId), JSON.stringify({ ...draft, rev }));
      } catch {
        // Storage full or blocked: the autosave still runs.
      }
      return rev;
    },
    /**
     * After a save of `savedContent` that sent revision `rev` (or, with no content, a discard):
     * clears the draft if it is still that revision, or if its text is what was saved, as when
     * an edit made during the save was undone. A draft with other text is newer and stays.
     */
    settle(fileId: string, rev: string | null, savedContent?: string): void {
      const draft = read(fileId);
      if (!draft || (draft.rev !== rev && draft.content !== savedContent)) return;
      try {
        storage.removeItem(key(fileId));
      } catch {
        // Nothing to clear.
      }
    },
  };
}

// --- Attached comments -------------------------------------------------------

/**
 * Which doc comments are attached is reported by whichever view shows the text:
 * the rich editor, or the Markdown source. The hidden one may hold older text,
 * so its reports are dropped. A report equal to the last one delivered is dropped
 * too; switching views forgets the last one, so the new view always reports.
 */
export function foundReporter(deliver: (ids: string[]) => void) {
  let mode: "rich" | "source" = "rich";
  let last: string | null = null;
  return {
    setMode(next: "rich" | "source") {
      if (next !== mode) last = null;
      mode = next;
    },
    found(from: "rich" | "source", ids: string[]) {
      if (from !== mode) return;
      const key = [...ids].sort().join(",");
      if (key === last) return;
      last = key;
      deliver(ids);
    },
  };
}

// --- Saving ------------------------------------------------------------------

export type SaveResult = { version: number } | { conflict: string };
/** A finished save. `more` is true when another save follows at once, so the doc isn't clean yet. */
export type SaveOutcome = { result: SaveResult; content: string; rev: string | null; more: boolean };

/**
 * A doc's saves, one at a time. Each save names the version it started from, so
 * two saves in flight would both name the same version and the second would be
 * refused as a conflict nobody caused. Instead, text asked to be saved while a
 * save is out waits (only the latest text, the newest edit wins) and goes out
 * when that save returns, against the version it returned. What goes out then is
 * the doc's text at that moment (`latest`), not the snapshot that was queued: an
 * edit undone during the save sends nothing more. The autosave, the save on leaving
 * the doc and "save mine over it" all go through here. On a conflict the waiting
 * text is dropped: the doc still holds it, and the person chooses.
 */
export function saveQueue(options: {
  base: number;
  send: (content: string, base: number) => Promise<SaveResult>;
  /** The doc's text and draft revision right now. */
  latest: () => { content: string; rev: string | null };
  onResult: (outcome: SaveOutcome) => void;
  onBusy?: (busy: boolean) => void;
}) {
  let base = options.base;
  let inFlight = false;
  let waiting: { content: string; rev: string | null } | null = null;

  const start = (content: string, rev: string | null) => {
    inFlight = true;
    options.onBusy?.(true);
    void options.send(content, base).then(
      (result) => finish(result, content, rev),
      (error: unknown) => finish({ conflict: error instanceof Error ? error.message : String(error) }, content, rev),
    );
  };

  const finish = (result: SaveResult, content: string, rev: string | null) => {
    inFlight = false;
    let next: { content: string; rev: string | null } | null = null;
    if ("version" in result) {
      base = result.version;
      // Send what the doc holds now, unless that's what was just saved.
      if (waiting) {
        const now = options.latest();
        if (now.content !== content) next = now;
      }
    }
    waiting = null;
    options.onResult({ result, content, rev, more: next !== null });
    if (next) start(next.content, next.rev);
    else options.onBusy?.(false);
  };

  return {
    /** Saves `content` (draft revision `rev`) now, or after the save that is out. */
    request(content: string, rev: string | null) {
      if (inFlight) waiting = { content, rev };
      else start(content, rev);
    },
    /** The version the next save starts from. */
    base: () => base,
    /** Starts from another version: someone else's, loaded or overwritten on purpose. */
    setBase(version: number) {
      base = version;
    },
    /** Drops text waiting to be saved, as when the person takes someone else's version. */
    cancelWaiting() {
      waiting = null;
    },
    busy: () => inFlight,
  };
}

// --- Canvas saves ------------------------------------------------------------

/** How a canvas save went: saved, worth retrying (offline), refused as invalid, or refused outright. */
export type CanvasAttempt = { ok: true } | { ok: false; kind: "retry" | "invalid" | "refused"; message: string };
type Shape = Record<string, unknown> & { id: string } & ShapeVersion;

/**
 * Whether `a` replaces `b` in the room's merge: a higher version, or the same version with a
 * lower versionNonce (`isNewer` in packages/backend/convex/lib/files.ts). No `b` means `a` wins.
 */
function wins(a: ShapeVersion, b: ShapeVersion | undefined) {
  return !b || a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
}

/**
 * A canvas's unsaved shapes kept on this computer until the room has them, as doc drafts
 * are, so shapes no save reached before the canvas closed are offered to the room when it
 * next opens. Shapes are kept by id and only a newer version replaces one, so two viewers
 * of the same canvas don't erase each other's copies. Storage that throws (full, blocked)
 * is ignored.
 */
export function canvasStash(storage: DraftStorage, fileId: string) {
  const key = `uplink.canvas-pending.${fileId}`;
  const read = (): Record<string, Shape> => {
    try {
      const raw = storage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const all: Record<string, Shape> = {};
      for (const [id, shape] of Object.entries(parsed as Record<string, Partial<Shape>>)) {
        if (shape && shape.id === id && typeof shape.version === "number" && typeof shape.versionNonce === "number") {
          all[id] = shape as Shape;
        }
      }
      return all;
    } catch {
      return {};
    }
  };
  const write = (all: Record<string, Shape>) => {
    try {
      if (Object.keys(all).length) storage.setItem(key, JSON.stringify(all));
      else storage.removeItem(key);
    } catch {
      // Storage full or blocked: saving to the room still runs.
    }
  };
  return {
    /** The shapes kept here. */
    shapes: (): Shape[] => Object.values(read()),
    /** Keeps shapes not saved yet, unless one that wins the room's merge over it is already kept. */
    keep(shapes: Shape[]) {
      if (shapes.length === 0) return;
      const all = read();
      for (const shape of shapes) {
        if (!wins(all[shape.id] ?? { version: -1, versionNonce: 0 }, shape)) all[shape.id] = shape;
      }
      write(all);
    },
    /** Forgets shapes the room now has (or refused): kept copies these equal or win over. */
    drop(shapes: (ShapeVersion & { id: string })[]) {
      const all = read();
      let changed = false;
      for (const shape of shapes) {
        const kept = all[shape.id];
        if (kept && !wins(kept, shape)) {
          delete all[shape.id];
          changed = true;
        }
      }
      if (changed) write(all);
    },
  };
}

/**
 * A canvas's unsaved shapes, kept until the room has them. A shape counts as saved
 * (`confirmed`) only after `canvas.save` succeeds; until then it stays pending, a
 * failed save is retried with backoff, and leaving the canvas sends what's pending at
 * once. One save is out at a time. A shape too large for the room is refused before
 * sending, and a batch the room refuses as invalid is split until the bad shape is
 * alone, so one shape can never hold the others back. Refused shapes stay on screen,
 * with a message, and their version isn't sent again. With a `stash`, pending shapes are
 * also kept on this computer, and `restore` brings back the ones the room still lacks.
 */
export function canvasSaver(options: {
  save: (batch: Shape[]) => Promise<CanvasAttempt>;
  onRejected: (message: string) => void;
  /** The room's limit for one shape's JSON (`MAX_ELEMENT_BYTES`). */
  maxBytes: number;
  debounceMs?: number;
  batchSize?: number;
  /** Where pending shapes are kept on this computer until the room has them. */
  stash?: ReturnType<typeof canvasStash>;
}) {
  const debounceMs = options.debounceMs ?? 250;
  const batchSize = options.batchSize ?? 400;
  const confirmed = new Map<string, ShapeVersion>();
  const pending = new Map<string, Shape>();
  const refused = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let failures = 0;
  let disposed = false;
  const encoder = new TextEncoder();

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), ms);
  };

  const stash = options.stash;

  const refuse = (shape: Shape, message: string) => {
    pending.delete(shape.id);
    stash?.drop([shape]);
    refused.set(shape.id, shape.version);
    options.onRejected(message);
  };

  /** Sends one batch; an invalid batch is split until the bad shape is alone. */
  async function send(batch: Shape[]): Promise<"ok" | "retry"> {
    const attempt = await options.save(batch);
    if (attempt.ok) {
      for (const shape of batch) {
        confirmed.set(shape.id, { version: shape.version, versionNonce: shape.versionNonce });
        // A newer edit made while this save was out stays pending.
        if (pending.get(shape.id)?.version === shape.version) pending.delete(shape.id);
      }
      stash?.drop(batch);
      return "ok";
    }
    if (attempt.kind === "retry") return "retry";
    if (attempt.kind === "refused") {
      // The room refused the canvas itself (removed, or no access): nothing here can save.
      for (const shape of batch) pending.delete(shape.id);
      stash?.drop(batch);
      options.onRejected(attempt.message);
      return "ok";
    }
    if (batch.length === 1) {
      refuse(batch[0]!, `A shape can't be saved: ${attempt.message}`);
      return "ok";
    }
    const half = Math.ceil(batch.length / 2);
    const first = await send(batch.slice(0, half));
    const second = await send(batch.slice(half));
    return first === "retry" || second === "retry" ? "retry" : "ok";
  }

  async function flush(): Promise<void> {
    clearTimeout(timer);
    if (inFlight || pending.size === 0) return;
    const batch: Shape[] = [];
    for (const shape of pending.values()) {
      if (encoder.encode(JSON.stringify(shape)).length > options.maxBytes) {
        refuse(shape, "A shape is too large to save, so it will be gone when the canvas reopens. Split it into smaller shapes.");
        continue;
      }
      batch.push(shape);
      if (batch.length === batchSize) break;
    }
    if (batch.length === 0) return;
    inFlight = true;
    let outcome: "ok" | "retry";
    try {
      outcome = await send(batch);
    } catch {
      outcome = "retry";
    }
    inFlight = false;
    if (outcome === "retry") {
      failures++;
      // 1 s, 2 s, 4 s, up to 30 s; after leaving the canvas, a few more tries.
      if (!disposed || failures <= 6) schedule(Math.min(30_000, 1000 * 2 ** (failures - 1)));
      return;
    }
    failures = 0;
    if (pending.size > 0) schedule(disposed ? 0 : debounceMs);
  }

  return {
    /** Shapes the room is known to have, as of the last load, merge or save. */
    confirmed: confirmed as ReadonlyMap<string, ShapeVersion>,
    /** Records shapes the room has (the first load, and merged remote shapes). */
    confirm(shapes: Shape[]) {
      for (const shape of shapes) {
        const known = confirmed.get(shape.id);
        if (!known || shape.version >= known.version) {
          confirmed.set(shape.id, { version: shape.version, versionNonce: shape.versionNonce });
        }
      }
    },
    /**
     * The canvas changed: queues every shape newer than what's saved or pending. Excalidraw
     * changes a shape in place while it's drawn, so each queued shape is a copy taken now;
     * holding the live shape would make its next version look already queued.
     */
    changed(shapes: Shape[]) {
      const added: Shape[] = [];
      for (const shape of shapes) {
        const have = pending.get(shape.id)?.version ?? confirmed.get(shape.id)?.version ?? -1;
        if (shape.version <= have || refused.get(shape.id) === shape.version) continue;
        const copy = { ...shape };
        pending.set(shape.id, copy);
        added.push(copy);
      }
      stash?.keep(added);
      if (added.length && !inFlight && !disposed) schedule(debounceMs);
    },
    /**
     * Opening the canvas, after `confirm` with the room's shapes: queues the shapes kept on
     * this computer that are newer than the room's, forgets the rest, and returns the ones
     * queued so the canvas can show them.
     */
    restore(): Shape[] {
      const kept = stash?.shapes() ?? [];
      const newer = kept.filter((shape) => wins(shape, confirmed.get(shape.id)));
      stash?.drop(kept.filter((shape) => !newer.includes(shape)));
      for (const shape of newer) {
        if (wins(shape, pending.get(shape.id))) pending.set(shape.id, shape);
      }
      if (newer.length && !inFlight && !disposed) schedule(debounceMs);
      return newer;
    },
    flush,
    /** Leaving the canvas: send what's pending now. Retries go on a little longer. */
    dispose() {
      disposed = true;
      void flush();
    },
    /**
     * Set up again after `dispose`, as React's StrictMode does on mount in development:
     * changes are saved on a pause again, and pending shapes go out.
     */
    resume() {
      disposed = false;
      if (pending.size > 0 && !inFlight) schedule(debounceMs);
    },
    pendingCount: () => pending.size,
  };
}
