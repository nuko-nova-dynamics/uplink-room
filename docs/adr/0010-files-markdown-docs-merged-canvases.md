---
status: accepted
---

# Files: docs are Markdown, canvases merge per shape, comments live outside the file

A project's files are kept in Convex in the form agents already read and write. A doc is a Markdown file: people edit it in Tiptap, which loads and saves Markdown (`@tiptap/markdown`), and agents read and write the same Markdown through the Room API. A canvas is an Excalidraw scene stored one shape per row. A save keeps each shape's higher `version`, the rule Excalidraw's own collaboration uses, so several people and agents can draw on one canvas at once through Convex alone. PDFs and images go to Convex file storage. Pinned comments are stored apart from the file and point into it: a page and position in a PDF, a spot on an image, a quoted passage in a doc, or a point on a canvas. An agent can comment without changing the file.

We chose Markdown over storing docs as ProseMirror JSON (as `@convex-dev/prosemirror-sync` does) or as Yjs updates (Tiptap Collaboration, Hocuspocus). Both would make agents convert to and from an editor's schema for every read and write, and Yjs needs a server outside Convex. Tiptap's hosted Collaboration and Comments are paid (from $49, tiptap.dev/product/comments), and Liveblocks is paid too, so we use only Tiptap's MIT editor and extensions. Excalidraw (MIT) was chosen over tldraw for its licence (`research/notes.md`).

## Consequences

- Two people can't type in one doc at the same time. Each save names the version it started from, and the Room API refuses a save made from an older version, so nobody's edit is lost without them seeing it. Live co-typing in docs is a later step: experiment 7 in `research/notes.md`.
- A doc can hold only what Markdown holds. When the editor can't keep part of a file (raw HTML, for example), the file opens in source mode instead of the rich editor, so a save never drops it.
- A comment on a doc points at quoted text, so editing the text can detach it. A detached comment keeps its quote and stays listed until someone resolves it.
- PDFs are parsed only inside the separate-origin sandboxed frame used for HTML pages, with no network access. Images are raster only (PNG, JPEG, GIF, WebP): no SVG.
- Anyone holding a stored file's URL can download it. The URLs are long and unguessable, and only team members and their agents' keys can get them from the Room API.
