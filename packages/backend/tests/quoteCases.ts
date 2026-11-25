/**
 * Quotes a person can select in a doc, shared by the backend's check (comments.test.ts)
 * and the desktop editor's capture (apps/desktop .../files/docText.test.ts), so the two
 * agree on what a doc's text is: hard breaks, nested blocks, code, images, and letters whose
 * lowercase depends on context (Greek final sigma) or is longer than they are (Turkish İ).
 */
export const QUOTE_CASES: { name: string; markdown: string; quote: string }[] = [
  { name: "a hard break and a nested item", markdown: "- First\\\n  second\n  - Child\n", quote: "First second Child" },
  { name: "a two-space hard break", markdown: "Line one  \nLine two\n", quote: "Line one Line two" },
  { name: "two paragraphs in a list item", markdown: "- First paragraph\n\n  Second paragraph\n", quote: "First paragraph Second paragraph" },
  { name: "an entity in inline code", markdown: "Write `a &amp; b` here.\n", quote: "Write a &amp; b here" },
  { name: "text around an image", markdown: "Before the shot.\n\n![Title screen](https://example.com/a.png)\n\nAfter the shot.\n", quote: "Before the shot. After the shot." },
  { name: "a word ending in a capital sigma", markdown: "ΟΣ\n", quote: "ΟΣ" },
  { name: "a final sigma quoted in capitals", markdown: "Ο λόγος.\n", quote: "ΛΌΓΟΣ" },
  { name: "a Turkish dotted capital I", markdown: "İabc\n", quote: "İabc" },
  { name: "text after a Turkish dotted capital I", markdown: "İabc\n", quote: "abc" },
];
