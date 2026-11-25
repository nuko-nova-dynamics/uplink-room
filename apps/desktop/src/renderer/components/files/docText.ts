/**
 * A doc's text as the editor holds it, without a DOM: the editor's extensions, the
 * text a selection captures for a comment's quote, and finding a quote again. It
 * must agree with the Room API's `visibleText`, which checks quotes on the server;
 * `docText.test.ts` runs both over the cases in `@uplink-room/backend/quoteCases`.
 */
import { createDocument, getSchema, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { comparable, comparableIndexed } from "@uplink-room/backend/files";
import { keepsMarkdown, pickOccurrence } from "./sync";

export const DOC_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
  Markdown,
  Image.configure({ allowBase64: false }),
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
];

/** Blocks are separated by a space, as `visibleText` does inside lists and quotes. */
const BLOCK_SEPARATOR = " ";

/**
 * Text for nodes that hold none. A hard break is a line break, as `visibleText` reads
 * Markdown's `br`; an image shows no text (its alt text isn't on the page).
 */
function leafText(node: PMNode): string {
  return node.type.name === "hardBreak" ? "\n" : "";
}

/** The text between two positions, as a comment's quote, prefix and suffix are captured. */
export function selectionText(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, BLOCK_SEPARATOR, leafText);
}

/** The doc's text with each character's position (-1 for separators that aren't in the doc). */
function textIndex(doc: PMNode): { text: string; pos: number[] } {
  let text = "";
  const pos: number[] = [];
  doc.descendants((node, at) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i];
        pos.push(at + i);
      }
    } else if (node.isLeaf) {
      for (const ch of leafText(node)) {
        text += ch;
        pos.push(at);
      }
    }
    if (node.isBlock && text && !/\s$/.test(text)) {
      text += BLOCK_SEPARATOR;
      pos.push(-1);
    }
    return true;
  });
  return { text, pos };
}

/** Finds a quote the way the Room API checks it: ignoring case and spacing. */
export function findQuote(
  doc: PMNode,
  anchor: { quote: string; prefix?: string | undefined; suffix?: string | undefined },
): { from: number; to: number } | null {
  const { text, pos } = textIndex(doc);
  // Normalized as the Room API does it, with each normalized character's index into `text`.
  const { text: norm, source } = comparableIndexed(text);
  // Of repeated passages, the one whose prefix and suffix match the comment's.
  const best = pickOccurrence(norm, anchor.quote, anchor.prefix, anchor.suffix);
  if (best < 0) return null;
  /** The first index into `text`, from normalized index `i` in direction `step`, that is in the doc. */
  const valid = (i: number, step: number) => {
    for (let j = i; j >= 0 && j < source.length; j += step) {
      const p = pos[source[j]!];
      if (p !== undefined && p >= 0) return source[j]!;
    }
    return null;
  };
  const first = valid(best, 1);
  const last = valid(best + comparable(anchor.quote).length - 1, -1);
  if (first === null || last === null) return null;
  const from = pos[first]!;
  // The last character may be a surrogate pair, two positions long.
  const to = pos[last]! + String.fromCodePoint(text.codePointAt(last)!).length;
  return to <= from ? null : { from, to };
}

let roundTrip: { schema: Schema; manager: MarkdownManager } | null = null;

/**
 * Whether the rich editor keeps a doc's Markdown, checked without an editor: the same
 * parse into the editor's schema and the same serializer the editor uses.
 */
export function richKeeps(markdown: string): boolean {
  roundTrip ??= {
    schema: getSchema(DOC_EXTENSIONS),
    manager: new MarkdownManager({ extensions: DOC_EXTENSIONS }),
  };
  const doc = createDocument(roundTrip.manager.parse(markdown), roundTrip.schema);
  return keepsMarkdown(markdown, roundTrip.manager.serialize(doc.toJSON()));
}
