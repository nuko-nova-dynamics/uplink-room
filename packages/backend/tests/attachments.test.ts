/**
 * Message attachments (spec #63): the upload flow of project files (spec #9), the same kinds and
 * limits for images and PDFs, other files only as downloads, and bytes shared with a project copy.
 */
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam, type Person, type Room, present } from "./setup";

const MB = 1024 * 1024;

afterEach(() => vi.useRealTimers());

async function team() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  return { t, teamId, julio, ana, general: general!.channelId };
}

/** Asks messages.attachUrl for an upload, then stores bytes as the POST to it would. */
async function attach(t: Room, person: Person, teamId: Id<"teams">, bytes: number | string, type: string, name: string) {
  const { uploadId } = await person.as.mutation(api.messages.attachUrl, { teamId });
  const body = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([body], { type })));
  return { uploadId, storageId, name };
}

async function stored(t: Room) {
  return await t.run(async (ctx) => ctx.db.system.query("_storage").collect());
}

test("an image and a PDF come back with URLs to show them; any other file is only a download", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const messageId = await julio.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: "",
    attachments: [
      await attach(t, julio, teamId, "png bytes", "image/png", "shot.png"),
      await attach(t, julio, teamId, "%PDF-1.7", "application/pdf", "brief.pdf"),
      await attach(t, julio, teamId, "<script>alert(1)</script>", "text/html", "build log.html"),
    ],
  });
  const message = present(await ana.as.query(api.messages.get, { teamId, messageId }));
  expect(message.attachments).toMatchObject([
    { index: 0, name: "shot.png", kind: "image", contentType: "image/png", size: 9, url: expect.stringMatching(/^https:\/\//) },
    { index: 1, name: "brief.pdf", kind: "pdf", contentType: "application/pdf", url: expect.stringMatching(/^https:\/\//) },
    { index: 2, name: "build log.html", kind: "file", url: null },
  ]);

  const download = await t.fetch(new URL(message.attachments[2]!.downloadUrl!, "http://x").pathname);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  expect(download.headers.get("content-disposition")).toBe(`attachment; filename="build log.html"; filename*=UTF-8''build%20log.html`);
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await download.text()).toBe("<script>alert(1)</script>");
  const pdf = await t.fetch(new URL(message.attachments[1]!.downloadUrl!, "http://x").pathname);
  expect(pdf.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect((await t.fetch("/attachments/0000000000000000000000000000000000000000000000000000000000000000/x")).status).toBe(404);

  // Ten at most.
  const eleven = [];
  for (let i = 0; i < 11; i++) eleven.push(await attach(t, julio, teamId, "x", "text/plain", `note${i}.txt`));
  await expect(julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "logs", attachments: eleven })).rejects.toThrow(
    /at most 10 attachments/,
  );
});

test("a file over the limit, an SVG, and a .png that is a PDF are refused, and unkept uploads are deleted within the hour", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, general } = await team();
  const post = (attachment: Awaited<ReturnType<typeof attach>>) =>
    julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "see", attachments: [attachment] });

  await expect(post(await attach(t, julio, teamId, 20 * MB + 1, "image/png", "big.png"))).rejects.toThrow(/Images can be at most 20 MB/);
  await expect(post(await attach(t, julio, teamId, 50 * MB + 1, "application/zip", "big.zip"))).rejects.toThrow(/Files can be at most 50 MB/);
  await expect(post(await attach(t, julio, teamId, "<svg/>", "image/svg+xml", "logo.svg"))).rejects.toThrow(/SVG images can't be attached/);
  await expect(post(await attach(t, julio, teamId, "%PDF-1.7", "application/pdf", "photo.png"))).rejects.toThrow(/isn't a PNG image/);
  await post(await attach(t, julio, teamId, "fine", "image/png", "ok.png"));
  expect(await stored(t)).toHaveLength(5);

  vi.setSystemTime(new Date("2026-11-03T13:01:00Z"));
  await t.mutation(internal.files.sweepUploads, {});
  // Only the kept attachment's bytes are left.
  expect(await stored(t)).toHaveLength(1);
});

test("deleting a message deletes its attachments' bytes; a copy saved into a project stays", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const projectId = await julio.as.mutation(api.projects.create, { teamId, name: "Reef", repos: [] });
  const messageId = await ana.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: "the mockups",
    attachments: [await attach(t, ana, teamId, "png", "image/png", "mock.png"), await attach(t, ana, teamId, "log", "text/plain", "run.log")],
  });
  await expect(
    julio.as.mutation(api.files.saveAttachment, { teamId, messageId, attachmentIndex: 1, projectId }),
  ).rejects.toThrow(/Only images and PDFs/);
  const fileId = await julio.as.mutation(api.files.saveAttachment, { teamId, messageId, attachmentIndex: 0, projectId, name: "mockup.png" });
  await expect(
    julio.as.mutation(api.files.saveAttachment, { teamId, messageId, attachmentIndex: 0, projectId, name: "mockup.png" }),
  ).rejects.toThrow(/already has a file named/);
  expect(await stored(t)).toHaveLength(2);

  await ana.as.mutation(api.messages.delete, { teamId, messageId });
  // The log's bytes are gone; the image's stay for the project file.
  expect(await stored(t)).toHaveLength(1);
  expect(await julio.as.query(api.files.get, { teamId, fileId })).toMatchObject({ name: "mockup.png", format: "image", url: expect.any(String) });

  await julio.as.mutation(api.files.delete, { teamId, fileId });
  expect(await stored(t)).toHaveLength(0);
});

test("editing adds and removes attachments, and an agent attaches through the Room API", async () => {
  const { t, teamId, ana, general } = await team();
  const messageId = await ana.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: "two shots",
    attachments: [await attach(t, ana, teamId, "a", "image/png", "a.png"), await attach(t, ana, teamId, "b", "image/png", "b.png")],
  });
  await ana.as.mutation(api.messages.edit, {
    teamId,
    messageId,
    body: "two shots, fixed",
    removeAttachments: [0],
    addAttachments: [await attach(t, ana, teamId, "c", "image/gif", "c.gif")],
  });
  const message = present(await ana.as.query(api.messages.get, { teamId, messageId }));
  expect(message.attachments.map((a) => [a.index, a.name])).toEqual([
    [0, "b.png"],
    [1, "c.gif"],
  ]);
  expect(await stored(t)).toHaveLength(2);

  const { key } = await addAgent(t, teamId, ana, "Reporter", ["room.read", "messages.post"]);
  const url = await callAsAgent(t, key, "messages.attachUrl");
  expect(url.result).toMatchObject({ uploadUrl: expect.stringMatching(/^https:\/\//), uploadId: expect.any(String) });
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["report"], { type: "text/plain" })));
  const posted = await callAsAgent(t, key, "messages.post", {
    channelId: general,
    body: "Nightly report",
    attachments: [{ uploadId: url.result.uploadId, storageId, name: "report.txt" }],
  });
  expect(posted).toMatchObject({ ok: true });
  expect(present(await ana.as.query(api.messages.get, { teamId, messageId: posted.result })).attachments).toMatchObject([{ name: "report.txt", kind: "file" }]);
});
