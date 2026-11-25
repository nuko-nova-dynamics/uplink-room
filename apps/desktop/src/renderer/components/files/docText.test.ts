import { describe, expect, test } from "vitest";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { comparable, visibleText } from "@uplink-room/backend/files";
import { QUOTE_CASES } from "@uplink-room/backend/quoteCases";
import { DOC_EXTENSIONS, findQuote, richKeeps, selectionText } from "./docText";
import { foundInSource } from "./sync";

/** A doc as the editor holds it, parsed from Markdown by Tiptap 3's own Markdown manager. */
function docOf(markdown: string) {
  const schema = getSchema(DOC_EXTENSIONS);
  const manager = new MarkdownManager({ extensions: DOC_EXTENSIONS });
  return schema.nodeFromJSON(manager.parse(markdown));
}

describe.each(QUOTE_CASES)("the editor and the Room API agree on a doc's text: $name", ({ markdown, quote }) => {
  const doc = docOf(markdown);

  test("selecting the whole doc captures the text the Room API checks quotes against", () => {
    expect(comparable(selectionText(doc, 0, doc.content.size))).toBe(comparable(visibleText(markdown)));
  });

  test("the quote is found in the editor, at its own text, and in the Markdown source", () => {
    const range = findQuote(doc, { quote });
    expect(range).not.toBeNull();
    expect(comparable(selectionText(doc, range!.from, range!.to))).toBe(comparable(quote));
    expect(foundInSource(markdown, [{ id: "q", quote }])).toEqual(["q"]);
  });
});

describe("whether the rich editor can show a doc's Markdown", () => {
  test("raw HTML can't be kept, and once it's removed the doc can show as rich text", () => {
    const withHtml = "# Notes\n\n<div align=\"center\">Logo</div>\n\n- [ ] Ship it\n";
    expect(richKeeps(withHtml)).toBe(false);
    expect(richKeeps(withHtml.replace('<div align="center">Logo</div>\n\n', ""))).toBe(true);
  });

  test("the rich editor keeps headings, lists, tasks, tables, links and code", () => {
    const md = [
      "# Title",
      "",
      "Some **bold** and [a link](https://example.com) and `code`.",
      "",
      "- one",
      "- two",
      "",
      "- [x] done",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
    ].join("\n");
    expect(richKeeps(md)).toBe(true);
  });
});
