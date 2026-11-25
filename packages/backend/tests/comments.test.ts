import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { QUOTE_CASES } from "./quoteCases";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam, upload } from "./setup";

async function projectIn() {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  const pdfId = await admin.as.mutation(api.files.addUpload, {
    teamId,
    projectId,
    name: "brief.pdf",
    ...(await upload(t, admin, teamId, "bytes", "application/pdf")),
  });
  const docId = await admin.as.mutation(api.files.save, {
    teamId,
    projectId,
    name: "design.md",
    content: "# Save slots\n\nThe **save slot** format is [described here](https://example.com) and\nkept small.",
  });
  return { t, teamId, admin, projectId, pdfId, docId };
}

test("a comment pinned to a PDF page lists its page and position", async () => {
  const { teamId, admin, pdfId } = await projectIn();

  const commentId = await admin.as.mutation(api.comments.add, {
    teamId,
    fileId: pdfId,
    body: "This table is out of date",
    pin: { kind: "page", page: 4, x: 0.25, y: 0.6 },
  });

  expect(await admin.as.query(api.comments.list, { teamId, fileId: pdfId })).toMatchObject([
    {
      commentId,
      body: "This table is out of date",
      pin: { kind: "page", page: 4, x: 0.25, y: 0.6 },
      author: { name: "Julio", kind: "person" },
      replies: [],
    },
  ]);
});

test("a pin must fit its file: positions are fractions, and each kind of pin goes on its kind of file", async () => {
  const { teamId, admin, pdfId, docId } = await projectIn();
  const add = (fileId: Id<"files">, pin: any) => admin.as.mutation(api.comments.add, { teamId, fileId, body: "Hm", pin });

  await expect(add(pdfId, { kind: "page", page: 1, x: 1.5, y: 0.5 })).rejects.toThrow(/between 0 and 1/);
  await expect(add(pdfId, { kind: "page", page: 0, x: 0.5, y: 0.5 })).rejects.toThrow(/whole number from 1/);
  await expect(add(docId, { kind: "page", page: 1, x: 0.5, y: 0.5 })).rejects.toThrow(/only on a PDF/);
  await expect(add(pdfId, { kind: "text", quote: "save slot" })).rejects.toThrow(/only on a doc/);
  await expect(add(pdfId, { kind: "point", x: 10, y: 20 })).rejects.toThrow(/only on a canvas/);
  // A comment on the whole file fits any file.
  await expect(add(pdfId, { kind: "file" })).resolves.toBeTruthy();
});

test("a doc comment's quote must be in the doc, even across formatting and links", async () => {
  const { teamId, admin, docId } = await projectIn();
  const add = (quote: string) =>
    admin.as.mutation(api.comments.add, { teamId, fileId: docId, body: "Why?", pin: { kind: "text", quote } });

  await expect(add("The save slot format is described here and kept small")).resolves.toBeTruthy();
  await expect(add("load slot")).rejects.toThrow(/isn't in the doc/);
});

test("an agent comments, replies and resolves over HTTP, and shows as itself", async () => {
  const { t, teamId, admin, docId } = await projectIn();
  const { key } = await addAgent(t, teamId, admin, "Reviewer", ["room.read", "messages.post"]);

  const added = await callAsAgent(t, key, "comments.add", {
    fileId: docId,
    body: "Say how big **small** is.",
    pin: { kind: "text", quote: "kept small", prefix: "and ", suffix: "." },
  });
  expect(added.ok).toBe(true);
  await admin.as.mutation(api.comments.reply, { teamId, commentId: added.result, body: "Under 4 KB." });
  expect((await callAsAgent(t, key, "comments.resolve", { commentId: added.result })).ok).toBe(true);

  expect(await admin.as.query(api.comments.list, { teamId, fileId: docId })).toEqual([]);
  expect(await admin.as.query(api.comments.list, { teamId, fileId: docId, status: "resolved" })).toMatchObject([
    {
      author: { name: "Reviewer", kind: "agent", addedBy: { name: "Julio" } },
      pin: { kind: "text", quote: "kept small", prefix: "and ", suffix: "." },
      resolvedBy: { name: "Reviewer" },
      replies: [{ body: "Under 4 KB.", author: { name: "Julio" } }],
    },
  ]);
});

test("an agent key without the post-messages scope can't comment", async () => {
  const { t, teamId, admin, docId } = await projectIn();
  const { key } = await addAgent(t, teamId, admin, "Reader", ["room.read"]);

  expect(await callAsAgent(t, key, "comments.add", { fileId: docId, body: "Hi", pin: { kind: "file" } })).toMatchObject({
    status: 403,
  });
  expect((await callAsAgent(t, key, "comments.list", { fileId: docId })).ok).toBe(true);
});

test("reopening a resolved comment brings it back to the open list", async () => {
  const { t, teamId, admin, pdfId } = await projectIn();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const commentId = await admin.as.mutation(api.comments.add, { teamId, fileId: pdfId, body: "Fix", pin: { kind: "file" } });

  await ana.as.mutation(api.comments.resolve, { teamId, commentId });
  expect(await admin.as.query(api.files.list, { teamId, projectId: (await admin.as.query(api.files.get, { teamId, fileId: pdfId })).projectId })).toMatchObject([
    { name: "brief.pdf", openComments: 0 },
    { name: "design.md", openComments: 0 },
  ]);
  await admin.as.mutation(api.comments.reopen, { teamId, commentId });

  expect(await admin.as.query(api.comments.list, { teamId, fileId: pdfId })).toMatchObject([{ commentId, body: "Fix" }]);
  expect(await admin.as.query(api.comments.list, { teamId, fileId: pdfId, status: "resolved" })).toEqual([]);
});

test("only a comment's author or an admin can delete it, and replies can't be replied to", async () => {
  const { t, teamId, admin, pdfId } = await projectIn();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const ben = await addTeammate(t, teamId, admin, "Ben");
  const commentId = await ana.as.mutation(api.comments.add, { teamId, fileId: pdfId, body: "Typo", pin: { kind: "page", page: 2, x: 0.1, y: 0.1 } });
  const replyId = await ben.as.mutation(api.comments.reply, { teamId, commentId, body: "Where?" });

  await expect(ana.as.mutation(api.comments.reply, { teamId, commentId: replyId, body: "Here" })).rejects.toThrow(/Reply to the comment/);
  await expect(ben.as.mutation(api.comments.delete, { teamId, commentId })).rejects.toThrow(/Only its author or an admin/);
  await ana.as.mutation(api.comments.delete, { teamId, commentId });

  expect(await admin.as.query(api.comments.list, { teamId, fileId: pdfId, status: "all" })).toEqual([]);
});

test("the person accountable for an agent can delete the agent's comments; other people can't", async () => {
  const { t, teamId, admin, pdfId } = await projectIn();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const ben = await addTeammate(t, teamId, admin, "Ben");
  const { key } = await addAgent(t, teamId, ana, "Reviewer", ["room.read", "messages.post"]);
  const added = await callAsAgent(t, key, "comments.add", { fileId: pdfId, body: "Wrong page", pin: { kind: "page", page: 1, x: 0.5, y: 0.5 } });

  await expect(ben.as.mutation(api.comments.delete, { teamId, commentId: added.result })).rejects.toThrow(/Only its author or an admin/);
  await ana.as.mutation(api.comments.delete, { teamId, commentId: added.result });

  expect(await admin.as.query(api.comments.list, { teamId, fileId: pdfId, status: "all" })).toEqual([]);
});

test("a quote keeps its literal punctuation, such as underscores in code and escaped characters", async () => {
  const { teamId, admin, projectId } = await projectIn();
  const docId = await admin.as.mutation(api.files.save, {
    teamId,
    projectId,
    name: "api.md",
    content: "Call `save_slot()` once. Fields like snake\\_case and 5 \\* 3 are literal; *emphasis* isn't.\n\nTom &amp; Jerry.",
  });
  const add = (quote: string) =>
    admin.as.mutation(api.comments.add, { teamId, fileId: docId, body: "Hm", pin: { kind: "text", quote } });

  await expect(add("Call save_slot() once")).resolves.toBeTruthy();
  await expect(add("snake_case and 5 * 3")).resolves.toBeTruthy();
  await expect(add("emphasis isn't")).resolves.toBeTruthy();
  await expect(add("Tom & Jerry")).resolves.toBeTruthy();
  // The words as written with their Markdown markers aren't what the doc shows.
  await expect(add("Call `save_slot()` once")).rejects.toThrow(/isn't in the doc/);
  await expect(add("saveslot")).rejects.toThrow(/isn't in the doc/);
});

test("code keeps its literal text, entities included, when a quote is checked", async () => {
  const { teamId, admin, projectId } = await projectIn();
  const docId = await admin.as.mutation(api.files.save, {
    teamId,
    projectId,
    name: "escapes.md",
    content: "Write `a &amp; b` in HTML.\n\n```html\n<p>x &lt; y</p>\n```\n",
  });
  const add = (quote: string) =>
    admin.as.mutation(api.comments.add, { teamId, fileId: docId, body: "Hm", pin: { kind: "text", quote } });

  await expect(add("Write a &amp; b in HTML")).resolves.toBeTruthy();
  await expect(add("<p>x &lt; y</p>")).resolves.toBeTruthy();
  await expect(add("Write a & b in HTML")).rejects.toThrow(/isn't in the doc/);
});

test("a quote may span blocks: paragraphs in a list item, and a parent item and its nested one", async () => {
  const { teamId, admin, projectId } = await projectIn();
  const docId = await admin.as.mutation(api.files.save, {
    teamId,
    projectId,
    name: "lists.md",
    content: "- Parent\n  - Child\n\n- First paragraph\n\n  Second paragraph\n\n> Quote one\n>\n> Quote two\n",
  });
  const add = (quote: string) =>
    admin.as.mutation(api.comments.add, { teamId, fileId: docId, body: "Hm", pin: { kind: "text", quote } });

  // The editor's selection text separates blocks with a space (textBetween with " ").
  await expect(add("Parent Child")).resolves.toBeTruthy();
  await expect(add("First paragraph Second paragraph")).resolves.toBeTruthy();
  await expect(add("Quote one Quote two")).resolves.toBeTruthy();
  await expect(add("ParentChild")).rejects.toThrow(/isn't in the doc/);
});

test.each(QUOTE_CASES)("a quote the editor captures is accepted: $name", async ({ markdown, quote }) => {
  const { teamId, admin, projectId } = await projectIn();
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "case.md", content: markdown });
  await expect(
    admin.as.mutation(api.comments.add, { teamId, fileId, body: "Hm", pin: { kind: "text", quote } }),
  ).resolves.toBeTruthy();
});

test("entities are decoded once: an escaped out-of-range entity can't break the check", async () => {
  const { teamId, admin, projectId } = await projectIn();
  const fileId = await admin.as.mutation(api.files.save, {
    teamId,
    projectId,
    name: "odd.md",
    content: "Broken &#x110000; entity. Written out: &amp;#x110000; and &amp;lt;tag&amp;gt;.\n",
  });
  const add = (quote: string) =>
    admin.as.mutation(api.comments.add, { teamId, fileId, body: "Hm", pin: { kind: "text", quote } });
  // An invalid code point reads as U+FFFD, as CommonMark and browsers show it.
  await expect(add("Broken \uFFFD entity")).resolves.toBeTruthy();
  // `&amp;#x110000;` shows as the text "&#x110000;", not a character.
  await expect(add("Written out: &#x110000; and &lt;tag&gt;")).resolves.toBeTruthy();
});
