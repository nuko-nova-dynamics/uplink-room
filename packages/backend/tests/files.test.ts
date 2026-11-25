import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam, upload, type Room } from "./setup";

const MB = 1024 * 1024;

afterEach(() => vi.useRealTimers());

async function storedFiles(t: Room) {
  return await t.run(async (ctx) => ctx.db.system.query("_storage").collect());
}

async function projectIn(t: Room) {
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  return { teamId, admin, projectId };
}

test("an uploaded PDF is kept with its size and type, and can be downloaded", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const { uploadUrl } = await admin.as.mutation(api.files.uploadUrl, { teamId });
  expect(uploadUrl).toMatch(/^https:\/\//);
  const up = await upload(t, admin, teamId, "%PDF-1.7 brief", "application/pdf");

  const fileId = await admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "brief.pdf", ...up });

  expect(await admin.as.query(api.files.get, { teamId, fileId })).toMatchObject({
    name: "brief.pdf",
    format: "pdf",
    size: 14,
    contentType: "application/pdf",
    url: expect.stringMatching(/^https:\/\//),
  });
  expect(await admin.as.query(api.files.list, { teamId, projectId })).toMatchObject([
    { name: "brief.pdf", format: "pdf", size: 14, openComments: 0 },
  ]);
});

test("a file that is too large, an SVG, or a PDF whose type is an image is refused, and its bytes are deleted within the hour", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);

  const huge = await upload(t, admin, teamId, 50 * MB + 1, "application/pdf");
  await expect(
    admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "huge.pdf", ...huge }),
  ).rejects.toThrow(/at most 50 MB/);

  const svg = await upload(t, admin, teamId, "<svg/>", "image/svg+xml");
  await expect(
    admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "logo.svg", ...svg }),
  ).rejects.toThrow(/can't be kept/);

  const png = await upload(t, admin, teamId, "png bytes", "image/png");
  await expect(
    admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "brief.pdf", ...png }),
  ).rejects.toThrow(/isn't a PDF/);
  expect(await admin.as.query(api.files.list, { teamId, projectId })).toEqual([]);

  // A kept upload and a fresh one waiting for files.addUpload are left alone.
  const kept = await upload(t, admin, teamId, "%PDF", "application/pdf");
  await admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "kept.pdf", ...kept });
  vi.setSystemTime(new Date("2026-11-02T13:00:01Z"));
  const waiting = await upload(t, admin, teamId, "%PDF", "application/pdf");
  expect(await t.mutation(internal.files.sweepUploads, {})).toEqual({ deleted: 3 });
  expect((await storedFiles(t)).map((f) => f._id).sort()).toEqual([kept.storageId, waiting.storageId].sort());
});

test("replacing an uploaded file deletes its old bytes, and deleting a file deletes the rest", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const first = await upload(t, admin, teamId, "first", "image/png");
  const fileId = await admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "shot.png", ...first });
  const second = await upload(t, admin, teamId, "second", "image/png");

  expect(await admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "shot.png", ...second })).toBe(fileId);
  expect((await storedFiles(t)).map((f) => f._id)).toEqual([second.storageId]);

  await admin.as.mutation(api.comments.add, { teamId, fileId, body: "Crop this", pin: { kind: "spot", x: 0.5, y: 0.5 } });
  await admin.as.mutation(api.files.delete, { teamId, fileId });

  expect(await storedFiles(t)).toEqual([]);
  expect(await admin.as.query(api.files.list, { teamId, projectId })).toEqual([]);
  await expect(admin.as.query(api.comments.list, { teamId, fileId })).rejects.toThrow(/No such file/);
});

test("an upload id works only in the team that issued its upload URL, and only once", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const mara = await addTeammate(t, teamId, admin, "Mara");
  const kept = await upload(t, mara, teamId, "%PDF a", "application/pdf");
  const fileId = await mara.as.mutation(api.files.addUpload, { teamId, projectId, name: "brief.pdf", ...kept });

  // Mara is removed from team A and starts team B, with A's storage id in hand.
  await admin.as.mutation(api.members.remove, { teamId, memberId: mara.memberId });
  const teamB = await mara.as.mutation(api.teams.create, { name: "Elsewhere" });
  const projectB = await mara.as.mutation(api.projects.create, { teamId: teamB, name: "Copy", repos: [] });
  const { uploadId: ticketB } = await mara.as.mutation(api.files.uploadUrl, { teamId: teamB });
  await expect(
    mara.as.mutation(api.files.addUpload, { teamId: teamB, projectId: projectB, name: "stolen.pdf", uploadId: ticketB, storageId: kept.storageId }),
  ).rejects.toThrow(/already kept/);

  // Inside team A, one upload can't become two files either.
  const { uploadId: again } = await admin.as.mutation(api.files.uploadUrl, { teamId });
  await expect(
    admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "copy.pdf", uploadId: again, storageId: kept.storageId }),
  ).rejects.toThrow(/already kept/);
  expect((await storedFiles(t)).map((f) => f._id)).toEqual([kept.storageId]);
  expect(await admin.as.query(api.files.get, { teamId, fileId })).toMatchObject({ url: expect.any(String) });
});

test("an upload URL's id is good only for its own member and for bytes stored after it", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const early = await t.run(async (ctx) => ctx.storage.store(new Blob(["%PDF early"], { type: "application/pdf" })));
  const { uploadId } = await ana.as.mutation(api.files.uploadUrl, { teamId });

  await expect(
    ana.as.mutation(api.files.addUpload, { teamId, projectId, name: "early.pdf", uploadId, storageId: early }),
  ).rejects.toThrow(/stored before/);
  const mine = await t.run(async (ctx) => ctx.storage.store(new Blob(["%PDF mine"], { type: "application/pdf" })));
  await expect(
    admin.as.mutation(api.files.addUpload, { teamId, projectId, name: "mine.pdf", uploadId, storageId: mine }),
  ).rejects.toThrow(/someone else's upload/);
  await expect(ana.as.mutation(api.files.addUpload, { teamId, projectId, name: "mine.pdf", uploadId, storageId: mine })).resolves.toBeTruthy();
  // An upload id is used up once its bytes are kept.
  const more = await t.run(async (ctx) => ctx.storage.store(new Blob(["%PDF more"], { type: "application/pdf" })));
  await expect(
    ana.as.mutation(api.files.addUpload, { teamId, projectId, name: "more.pdf", uploadId, storageId: more }),
  ).rejects.toThrow(/No such upload/);
});

test("a doc edit from an old version is refused, and one from the current version saves", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "plan.md", content: "# Plan" });
  const read = await admin.as.query(api.files.get, { teamId, fileId });
  const version = "version" in read ? read.version : undefined;

  expect(await ana.as.mutation(api.files.edit, { teamId, fileId, content: "# Plan\n\nAna's part", baseVersion: version! })).toEqual({
    version: version! + 1,
  });
  await expect(
    admin.as.mutation(api.files.edit, { teamId, fileId, content: "# Plan\n\nMine", baseVersion: version! }),
  ).rejects.toThrow(/Ana changed this file/);
  expect(await admin.as.query(api.files.get, { teamId, fileId })).toMatchObject({
    content: "# Plan\n\nAna's part",
    version: version! + 1,
  });
});

test("an agent reads and writes a doc as Markdown and uploads a file over HTTP", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const { key } = await addAgent(t, teamId, admin, "Scribe", ["room.read", "work.manage"]);
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "notes.md", content: "Draft" });

  const read = await callAsAgent(t, key, "files.get", { fileId });
  expect(read.result).toMatchObject({ content: "Draft", version: 1 });
  const edited = await callAsAgent(t, key, "files.edit", { fileId, content: "Draft, reviewed", baseVersion: 1 });
  expect(edited).toMatchObject({ ok: true, result: { version: 2 } });
  const stale = await callAsAgent(t, key, "files.edit", { fileId, content: "Lost", baseVersion: 1 });
  expect(stale).toMatchObject({ status: 409, error: { code: "conflict" } });

  const { result } = await callAsAgent(t, key, "files.uploadUrl", {});
  expect(result.uploadUrl).toMatch(/^https:\/\//);
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["render"], { type: "image/webp" })));
  const added = await callAsAgent(t, key, "files.addUpload", { projectId, name: "render.webp", uploadId: result.uploadId, storageId });
  expect(added.ok).toBe(true);
  expect(await admin.as.query(api.files.list, { teamId, projectId })).toMatchObject([
    { name: "notes.md", updatedBy: { name: "Scribe", kind: "agent" } },
    { name: "render.webp", format: "image", updatedBy: { name: "Scribe", addedBy: { name: "Julio" } } },
  ]);
});

test("an agent key without the manage-work scope can read files but not change them", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const { key } = await addAgent(t, teamId, admin, "Reader");
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "notes.md", content: "Draft" });

  expect((await callAsAgent(t, key, "files.get", { fileId })).ok).toBe(true);
  expect(await callAsAgent(t, key, "files.edit", { fileId, content: "x", baseVersion: 1 })).toMatchObject({ status: 403 });
  expect(await callAsAgent(t, key, "files.delete", { fileId })).toMatchObject({ status: 403 });
});

test("another team's files are never found", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "plan.md", content: "Secret" });
  const other = await newTeam(t, "Mara");

  await expect(other.admin.as.query(api.files.get, { teamId: other.teamId, fileId })).rejects.toThrow(/No such file/);
  await expect(
    other.admin.as.mutation(api.comments.add, { teamId: other.teamId, fileId, body: "Hi", pin: { kind: "file" } }),
  ).rejects.toThrow(/No such file/);
});

test("creating a file refuses a name the project already has, instead of replacing that file", async () => {
  const t = newRoom();
  const { teamId, admin, projectId } = await projectIn(t);
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "notes.md", content: "Months of notes" });

  for (const name of ["notes.md", "  notes.md "]) {
    await expect(
      admin.as.mutation(api.files.save, { teamId, projectId, name, content: "# notes\n", onlyIfNew: true }),
    ).rejects.toThrow(/already has a file named notes.md/);
  }
  expect(await admin.as.query(api.files.get, { teamId, fileId })).toMatchObject({ content: "Months of notes", version: 1 });
  // Without the flag, saving by name still replaces, as agents rely on.
  await admin.as.mutation(api.files.save, { teamId, projectId, name: "notes.md", content: "Replaced" });
  expect(await admin.as.query(api.files.get, { teamId, fileId })).toMatchObject({ content: "Replaced", version: 2 });
});
