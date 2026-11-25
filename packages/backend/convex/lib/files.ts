/**
 * Files in a project (spec #9, ADR 0010): which kinds the room keeps, how big
 * each may be, what a pinned comment may point at, and how canvas shapes are
 * checked and merged.
 */
import { v, type Infer } from "convex/values";
import { marked } from "marked";
import { roomError } from "./errors";

export const vFileFormat = v.union(
  v.literal("markdown"),
  v.literal("html"),
  v.literal("pdf"),
  v.literal("image"),
  v.literal("canvas"),
);
export type FileFormat = Infer<typeof vFileFormat>;

const KB = 1024;
const MB = 1024 * KB;

/** Docs and HTML pages are text rows, kept well under Convex's 1 MiB document limit. */
export const MAX_TEXT_BYTES = 512 * KB;
/** Stored bytes. Upload URLs take any size; these keep storage and viewers sane. */
export const MAX_UPLOAD_BYTES = { pdf: 50 * MB, image: 20 * MB } as const;
/** One canvas shape, a whole canvas (half of a query's 16 MiB read limit), and one save. */
export const MAX_ELEMENT_BYTES = 256 * KB;
export const MAX_CANVAS_BYTES = 8 * MB;
export const MAX_ELEMENTS_PER_SAVE = 500;
export const MAX_COMMENT_BYTES = 8 * KB;
export const MAX_QUOTE_CHARS = 500;
export const MAX_QUOTE_CONTEXT_CHARS = 64;

const IMAGE_TYPES: Record<string, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
};

export function formatOf(name: string): FileFormat {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "excalidraw") return "canvas";
  if (ext === "pdf") return "pdf";
  if (ext in IMAGE_TYPES) return "image";
  throw roomError(
    "invalid",
    "That kind of file can't be kept in a project. Use a doc (.md), an HTML page (.html), a canvas (.excalidraw), a PDF, or a PNG, JPEG, GIF or WebP image.",
  );
}

/** The content types an upload under `name` may have. */
export function typesFor(name: string): string[] {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "pdf") return ["application/pdf"];
  return IMAGE_TYPES[ext] ?? [];
}

export function sizeLabel(bytes: number): string {
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / KB)} KB`;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// --- Pinned comments ---------------------------------------------------------

const vFraction = v.number();

/** Where a pinned comment points. Positions on pages and images are fractions of the width and height. */
export const vPin = v.union(
  v.object({ kind: v.literal("file") }),
  v.object({ kind: v.literal("page"), page: v.number(), x: vFraction, y: vFraction }),
  v.object({ kind: v.literal("spot"), x: vFraction, y: vFraction }),
  v.object({
    kind: v.literal("text"),
    quote: v.string(),
    prefix: v.optional(v.string()),
    suffix: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("point"), x: v.number(), y: v.number(), elementId: v.optional(v.string()) }),
);
export type Pin = Infer<typeof vPin>;

const PIN_FILE: Record<Exclude<Pin["kind"], "file">, { format: FileFormat; label: string }> = {
  page: { format: "pdf", label: "a PDF" },
  spot: { format: "image", label: "an image" },
  text: { format: "markdown", label: "a doc" },
  point: { format: "canvas", label: "a canvas" },
};

function fraction(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw roomError("invalid", `The pin's ${name} must be a fraction between 0 and 1.`);
  }
}

/** Checks a pin against its file. `docText` is the doc's Markdown, for text pins. */
export function checkPin(pin: Pin, format: FileFormat, docText: string | undefined): void {
  if (pin.kind === "file") return;
  const fits = PIN_FILE[pin.kind];
  if (fits.format !== format) {
    throw roomError("invalid", `A ${pin.kind} pin goes only on ${fits.label}.`);
  }
  switch (pin.kind) {
    case "page":
      if (!Number.isInteger(pin.page) || pin.page < 1) {
        throw roomError("invalid", "A page must be a whole number from 1.");
      }
      fraction("x", pin.x);
      fraction("y", pin.y);
      return;
    case "spot":
      fraction("x", pin.x);
      fraction("y", pin.y);
      return;
    case "point":
      if (!Number.isFinite(pin.x) || !Number.isFinite(pin.y)) {
        throw roomError("invalid", "A canvas point needs numbers for x and y.");
      }
      return;
    case "text": {
      const quote = pin.quote.trim();
      if (!quote) throw roomError("invalid", "Quote the passage the comment is about.");
      if (quote.length > MAX_QUOTE_CHARS) {
        throw roomError("invalid", `A quote can be at most ${MAX_QUOTE_CHARS} characters.`);
      }
      if ((pin.prefix?.length ?? 0) > MAX_QUOTE_CONTEXT_CHARS || (pin.suffix?.length ?? 0) > MAX_QUOTE_CONTEXT_CHARS) {
        throw roomError("invalid", `A quote's prefix and suffix can be at most ${MAX_QUOTE_CONTEXT_CHARS} characters.`);
      }
      if (!comparable(visibleText(docText ?? "")).includes(comparable(quote))) {
        throw roomError("invalid", "That quote isn't in the doc. Quote the words as they read, without Markdown.");
      }
      return;
    }
  }
}

/** The few entities Markdown text commonly carries, and numeric ones. */
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[name.toLowerCase()] ?? whole;
  });
}

type Tok = {
  type: string;
  text?: string;
  tokens?: Tok[];
  items?: Tok[];
  header?: { tokens: Tok[] }[];
  rows?: { tokens: Tok[] }[][];
};

function tokenText(token: Tok): string {
  switch (token.type) {
    // Raw HTML isn't shown (the editor's schema drops it), and an image shows no text:
    // its alt text isn't on the page, so the editor's selection doesn't include it.
    case "html":
    case "image":
    case "space":
    case "hr":
    case "checkbox":
      return "";
    // Code shows its text literally: `&amp;` in code reads as five characters, not "&".
    case "code":
    case "codespan":
      return token.text ?? "";
    case "escape":
      return decodeEntities(token.text ?? "");
    case "br":
      return "\n";
    case "list":
      return (token.items ?? []).map(tokenText).join("\n");
    case "table": {
      const cells = (row: { tokens: Tok[] }[]) => row.map((cell) => cell.tokens.map(tokenText).join("")).join(" ");
      return [cells(token.header ?? []), ...(token.rows ?? []).map(cells)].join("\n");
    }
  }
  if (token.tokens) {
    // A list item or quote holds blocks (paragraphs, nested lists), which the editor's selection
    // text separates with a space, as in `textBetween(from, to, " ")`. Inline children join directly.
    const holdsBlocks = token.type === "list_item" || token.type === "blockquote";
    return token.tokens.map(tokenText).join(holdsBlocks ? " " : "");
  }
  return decodeEntities(token.text ?? "");
}

/**
 * The text a doc shows: what the editor displays, parsed from its Markdown. Markers,
 * link targets and raw HTML are gone; literal punctuation, such as an underscore in
 * inline code or an escaped asterisk, stays. Quotes in comments are checked against it.
 */
export function visibleText(markdown: string): string {
  return (marked.lexer(markdown, { gfm: true }) as unknown as Tok[]).map(tokenText).join("\n");
}

/** Spacing and case don't matter when matching a quote. */
export function comparable(text: string): string {
  return comparableIndexed(text).text;
}

/**
 * `comparable`, with the index in `text` that each output character came from, so the
 * editor can map a match back to the doc. Case is folded one character at a time, so a
 * passage folds the same alone as inside its doc: lowercasing a whole string turns a
 * word-final Σ into ς but a lone Σ into σ, so ς is read as σ throughout. A character that
 * folds to two (İ becomes i and a combining dot) gives each of them its own index entry.
 */
export function comparableIndexed(text: string): { text: string; source: number[] } {
  let out = "";
  const source: number[] = [];
  let at = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (out && !out.endsWith(" ")) {
        out += " ";
        source.push(at);
      }
    } else {
      const folded = ch.toLowerCase().replaceAll("ς", "σ");
      out += folded;
      for (let i = 0; i < folded.length; i++) source.push(at);
    }
    at += ch.length;
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    source.pop();
  }
  return { text: out, source };
}

// --- Canvas shapes -----------------------------------------------------------

/** Shape types a canvas keeps. Embedded pages and images are refused (spec #9). */
const ELEMENT_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "frame",
  "selection",
]);

export type CanvasElement = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  link?: string | null;
  [key: string]: unknown;
};

/** Checks one shape from a caller and returns it as it will be stored. */
export function cleanElement(raw: unknown): { element: CanvasElement; data: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw roomError("invalid", "Each canvas shape must be an object.");
  }
  const element = { ...(raw as Record<string, unknown>) } as CanvasElement;
  if (typeof element.id !== "string" || !element.id || element.id.length > 64) {
    throw roomError("invalid", "Each canvas shape needs an `id` of at most 64 characters.");
  }
  if (typeof element.type !== "string") throw roomError("invalid", "Each canvas shape needs a `type`.");
  if (element.type === "embeddable" || element.type === "iframe") {
    throw roomError("invalid", "A canvas can't hold embeddable web pages.");
  }
  if (element.type === "image") {
    throw roomError("invalid", "A canvas can't hold images yet. Upload the image to the project instead.");
  }
  if (!ELEMENT_TYPES.has(element.type)) {
    throw roomError("invalid", `A canvas can't hold shapes of type "${element.type}".`);
  }
  if (!Number.isInteger(element.version) || !Number.isInteger(element.versionNonce)) {
    throw roomError("invalid", "Each canvas shape needs whole-number `version` and `versionNonce`.");
  }
  if (element.link !== undefined && element.link !== null) {
    element.link = typeof element.link === "string" && /^(https?:|mailto:)/i.test(element.link.trim()) ? element.link : null;
  }
  const data = JSON.stringify(element);
  if (byteLength(data) > MAX_ELEMENT_BYTES) {
    throw roomError("invalid", `A canvas shape can be at most ${sizeLabel(MAX_ELEMENT_BYTES)}.`);
  }
  return { element, data };
}

/** Excalidraw's own rule: the higher version wins; on a tie, the lower versionNonce. */
export function isNewer(incoming: { version: number; versionNonce: number }, stored: { version: number; versionNonce: number }) {
  return incoming.version > stored.version || (incoming.version === stored.version && incoming.versionNonce < stored.versionNonce);
}

/** The elements of an `.excalidraw` file's JSON, or an empty canvas for empty content. */
export function excalidrawElements(content: string): unknown[] {
  if (!content.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw roomError("invalid", "That isn't an Excalidraw file: it isn't JSON.");
  }
  const elements = (parsed as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) throw roomError("invalid", "That isn't an Excalidraw file: it has no `elements`.");
  return elements;
}

export const vShape = v.object({
  type: v.union(v.literal("rectangle"), v.literal("ellipse"), v.literal("diamond"), v.literal("text"), v.literal("arrow")),
  x: v.number(),
  y: v.number(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  /** Text inside a shape. */
  label: v.optional(v.string()),
  /** The text of a text shape. */
  text: v.optional(v.string()),
  /** Stroke colour, such as "#4f6fb3". */
  color: v.optional(v.string()),
  /** Fill colour. */
  fill: v.optional(v.string()),
});
export type Shape = Infer<typeof vShape>;

const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;

function randomInt(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 20; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function base(type: string, x: number, y: number, width: number, height: number, color?: string, fill?: string): CanvasElement {
  return {
    id: randomId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: color ?? "#1e1e1e",
    backgroundColor: fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" || type === "diamond" ? { type: 3 } : null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function textElement(text: string, x: number, y: number, color?: string, containerId?: string): CanvasElement {
  const lines = text.split("\n");
  // A rough size; the app measures text again when it loads the shape (`restoreElements`).
  // Generous, so text isn't clipped before the app measures it; extra width on left-aligned text is harmless.
  const width = Math.max(...lines.map((l) => l.length)) * FONT_SIZE * 0.65;
  const height = lines.length * FONT_SIZE * LINE_HEIGHT;
  return {
    ...base("text", x, y, width, height, color),
    text,
    originalText: text,
    fontSize: FONT_SIZE,
    fontFamily: 5,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId: containerId ?? null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

/** Turns an agent's simple shape descriptions into Excalidraw shapes. */
export function drawShapes(shapes: Shape[]): CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const shape of shapes) {
    if (shape.type === "text") {
      const text = shape.text ?? shape.label;
      if (!text) throw roomError("invalid", "A text shape needs `text`.");
      out.push(textElement(text, shape.x, shape.y, shape.color));
      continue;
    }
    const width = shape.width ?? (shape.type === "arrow" ? 120 : 160);
    const height = shape.height ?? (shape.type === "arrow" ? 0 : 80);
    if (shape.type === "arrow") {
      out.push({
        ...base("arrow", shape.x, shape.y, Math.abs(width), Math.abs(height), shape.color),
        points: [
          [0, 0],
          [width, height],
        ],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      });
      continue;
    }
    const box = base(shape.type, shape.x, shape.y, width, height, shape.color, shape.fill);
    out.push(box);
    if (shape.label) {
      const label = textElement(shape.label, shape.x + width / 2, shape.y + height / 2, shape.color, box.id);
      label.x = shape.x + (width - (label.width as number)) / 2;
      label.y = shape.y + (height - (label.height as number)) / 2;
      box.boundElements = [{ type: "text", id: label.id }];
      out.push(label);
    }
  }
  return out;
}
