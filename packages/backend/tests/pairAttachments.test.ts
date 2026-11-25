/**
 * Files in Pairs (ADR 0048): a Pair message carries images and files as a chat message does, its
 * people and runs reach them only through short-lived links while they are still in it, and each
 * upload counts only for the author and Pair it was issued for.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { addAgent, callAsAgent, newRoom, newTeam, signIn, signInFromCli, type Person, type Room } from "./setup";

let clerk: FakeClerk;

beforeEach(async () => {
  clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function join(t: Room, signInToken: string, args: { teamId?: Id<"teams"> } = {}) {
  const joined = await callAsAgent(t, signInToken, "joined.start", { harness: "claude-code", sessionRef: `session-${Math.random()}`, hearing: "mid_task", ...args });
  if (!joined.ok) throw new Error(`joined.start: ${joined.error?.message}`);
  return joined.result as { token: string; label: string; runId?: string };
}

/**
 * Julio (in Nuko Nova) and Pepe (in no team), each in the app and each with a joined run, in one
 * Pair: Julio's run in his team, Pepe's in none.
 */
async function paired() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await signIn(t, "Pepe");
  const julioSignIn = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
  const pepeSignIn = await signInFromCli(t, clerk, { subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" }, "pepe-laptop");
  const julioRun = await join(t, julioSignIn, { teamId });
  const pepeRun = await join(t, pepeSignIn);
  const made = await callAsAgent(t, julioRun.token, "joined.pairCode", {});
  const joined = await callAsAgent(t, pepeRun.token, "joined.pairJoin", { code: made.result.code });
  if (!joined.ok) throw new Error(`joined.pairJoin: ${joined.error?.message}`);
  return { t, teamId, julio, pepe, julioRun, pepeRun, pairId: joined.result.pairId as string };
}

/** Asks pairs.attachUrl for an upload, then stores bytes as the POST to it would. */
async function attach(t: Room, person: Person, pairId: string, bytes: string, type: string, name: string) {
  const { uploadId } = await person.as.mutation(api.pairs.attachUrl, { pairId });
  return { uploadId, storageId: await store(t, bytes, type), name };
}

/** Asks joined.attachUrl for a run's upload, then stores bytes as the POST to it would. */
async function attachAsRun(t: Room, token: string, bytes: string, type: string, name: string) {
  const target = await callAsAgent(t, token, "joined.attachUrl", {});
  if (!target.ok) throw new Error(`joined.attachUrl: ${target.error?.message}`);
  return { uploadId: target.result.uploadId as string, storageId: await store(t, bytes, type), name };
}

async function store(t: Room, bytes: string, type: string) {
  return await t.run(async (ctx) => ctx.storage.store(new Blob([bytes], { type })));
}

/** Fetches a link the room gave, by its path on this deployment. */
const open = (t: Room, url: string) => t.fetch(new URL(url, "http://x").pathname);

test("a person sends an image and a file from the app; the Pair's people and runs reach them through short-lived links until they leave", async () => {
  const p = await paired();
  const { messageId } = await p.julio.as.mutation(api.pairs.post, {
    pairId: p.pairId,
    text: "",
    attachments: [
      await attach(p.t, p.julio, p.pairId, "png bytes", "image/png", "crash.png"),
      await attach(p.t, p.julio, p.pairId, "<script>alert(1)</script>", "text/html", "travel log.html"),
    ],
  });

  // Pepe reads them with no lasting link, as a direct message's files are.
  const { messages } = await p.pepe.as.query(api.pairs.messages, { pairId: p.pairId });
  expect(messages.at(-1)).toMatchObject({
    messageId,
    body: "",
    attachments: [
      { index: 0, name: "crash.png", kind: "image", contentType: "image/png", size: 9, restricted: true, url: null, downloadUrl: null },
      { index: 1, name: "travel log.html", kind: "file", restricted: true, url: null, downloadUrl: null },
    ],
  });
  const image = await p.pepe.as.mutation(api.pairs.attachmentLink, { messageId, attachmentIndex: 0 });
  const shown = await open(p.t, image.url);
  expect(shown.status).toBe(200);
  expect(shown.headers.get("content-type")).toBe("image/png");
  expect(shown.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(await shown.text()).toBe("png bytes");
  // Any other file only ever as a download.
  const log = await open(p.t, (await p.pepe.as.mutation(api.pairs.attachmentLink, { messageId, attachmentIndex: 1 })).url);
  expect(log.headers.get("content-type")).toBe("application/octet-stream");
  expect(log.headers.get("content-disposition")).toMatch(/^attachment;/);

  // Pepe's run hears how many came and how to save them, and saves them with joined.download.
  const taken = await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" });
  expect(taken.result.messages).toEqual([expect.objectContaining({ messageId, text: "", attachments: 2, downloadable: true })]);
  const download = await callAsAgent(p.t, p.pepeRun.token, "joined.download", { messageId });
  expect(download.result.files).toEqual([
    expect.objectContaining({ name: "crash.png", kind: "image", size: 9 }),
    expect.objectContaining({ name: "travel log.html", kind: "file" }),
  ]);
  const runLink = download.result.files[0].url as string;
  expect(await (await open(p.t, runLink)).text()).toBe("png bytes");

  // Pepe leaves: his links and his run's stop working, and he can't ask for more. The Pair ends
  // with one person left, who still reads it and its files.
  await p.pepe.as.mutation(api.pairs.leave, { pairId: p.pairId });
  expect((await open(p.t, image.url)).status).toBe(404);
  expect((await open(p.t, runLink)).status).toBe(404);
  await expect(p.pepe.as.mutation(api.pairs.attachmentLink, { messageId, attachmentIndex: 0 })).rejects.toThrow(/aren't in it/);
  expect(await callAsAgent(p.t, p.pepeRun.token, "joined.download", { messageId })).toMatchObject({ status: 404 });
  const julios = await p.julio.as.mutation(api.pairs.attachmentLink, { messageId, attachmentIndex: 0 });
  expect(await (await open(p.t, julios.url)).text()).toBe("png bytes");

  // A link lasts ten minutes.
  vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
  expect((await open(p.t, julios.url)).status).toBe(404);
});

test("a Pair message keeps only uploads issued to its author for that Pair, in the kinds and number a message takes", async () => {
  const p = await paired();
  const post = (person: Person, attachments: unknown[], pairId = p.pairId) =>
    person.as.mutation(api.pairs.post, { pairId, text: "see", attachments: attachments as never });

  const julios = await attach(p.t, p.julio, p.pairId, "png", "image/png", "a.png");
  await expect(post(p.pepe, [julios])).rejects.toThrow(/issued to someone else/);
  // One for this Pair doesn't go into another of Julio's.
  const other = await p.julio.as.mutation(api.pairs.create, {});
  await expect(post(p.julio, [julios], other.pairId)).rejects.toThrow(/issued to someone else/);
  // A team's upload isn't a Pair's.
  const { uploadId: teamUpload } = await p.julio.as.mutation(api.messages.attachUrl, { teamId: p.teamId });
  await expect(post(p.julio, [{ ...julios, uploadId: teamUpload }])).rejects.toThrow();
  await expect(post(p.julio, [julios, julios])).rejects.toThrow(/attached twice/);
  await expect(post(p.julio, [await attach(p.t, p.julio, p.pairId, "<svg/>", "image/svg+xml", "logo.svg")])).rejects.toThrow(/SVG/);
  await expect(post(p.julio, [await attach(p.t, p.julio, p.pairId, "%PDF-1.7", "application/pdf", "shot.png")])).rejects.toThrow(/isn't a PNG image/);
  const eleven = [];
  for (let i = 0; i < 11; i++) eleven.push(await attach(p.t, p.julio, p.pairId, "x", "text/plain", `note${i}.txt`));
  await expect(post(p.julio, eleven)).rejects.toThrow(/at most 10 attachments/);
  await expect(p.julio.as.mutation(api.pairs.post, { pairId: p.pairId, text: " " })).rejects.toThrow(/needs text or a file/);

  // Kept once, the upload is spent.
  await post(p.julio, [julios]);
  await expect(post(p.julio, [julios])).rejects.toThrow(/No such upload/);
});

test("runs send files in their Pair: a run in no team with a Pair upload, a run in a team with its driver's", async () => {
  const p = await paired();
  const fromPepe = await attachAsRun(p.t, p.pepeRun.token, "pepe png", "image/png", "pepe.png");
  // Julio's run can't send an upload issued to Pepe's.
  expect(await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "x", attachments: [fromPepe] })).toMatchObject({ status: 403 });
  // Nor send a Pair upload in a team place.
  expect(await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "#general", text: "x", attachments: [fromPepe] })).toMatchObject({ status: 400 });
  expect(await callAsAgent(p.t, p.pepeRun.token, "joined.say", { in: "pair", text: "", attachments: [fromPepe] })).toMatchObject({ status: 200 });

  const fromJulio = await attachAsRun(p.t, p.julioRun.token, "%PDF-1.7", "application/pdf", "brief.pdf");
  const said = await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "the brief", attachments: [fromJulio] });
  expect(said).toMatchObject({ status: 200 });

  const { messages } = await p.pepe.as.query(api.pairs.messages, { pairId: p.pairId });
  expect(messages.map((m) => [m.from.name, m.attachments?.map((a) => a.name)])).toEqual([
    ["Claude Code (Pepe)", ["pepe.png"]],
    ["Claude Code (Julio)", ["brief.pdf"]],
  ]);
  const taken = await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" });
  expect(taken.result.messages).toEqual([expect.objectContaining({ messageId: said.result.messageId, attachments: 1, downloadable: true })]);
});

test("the hourly sweep deletes Pair uploads no message kept and keeps a Pair file's bytes", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-14T12:00:00Z") });
  const t = newRoom();
  const julio = await signIn(t, "Julio");
  const pepe = await signIn(t, "Pepe");
  const { pairId } = await julio.as.mutation(api.pairs.create, {});
  const { code } = await julio.as.mutation(api.pairs.code, { pairId });
  await pepe.as.mutation(api.pairs.join, { code });
  await julio.as.mutation(api.pairs.post, { pairId, text: "kept", attachments: [await attach(t, julio, pairId, "png", "image/png", "kept.png")] });
  await attach(t, julio, pairId, "never sent", "text/plain", "draft.txt");

  vi.setSystemTime(new Date("2026-11-14T13:01:00Z"));
  await t.mutation(internal.files.sweepUploads, {});
  const left = await t.run(async (ctx) => ({
    stored: (await ctx.db.system.query("_storage").collect()).length,
    uploads: (await ctx.db.query("pairUploads").collect()).length,
  }));
  expect(left).toEqual({ stored: 1, uploads: 0 });
});

test("an agent's links to a Pair's files stop once it is removed from its team", async () => {
  const p = await paired();
  const ana = await signIn(p.t, "Ana");
  const acmeId = await ana.as.mutation(api.teams.create, { name: "Acme" });
  const icarus = await addAgent(p.t, acmeId, ana, "Icarus", ["room.read", "messages.post", "pairs.join"]);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  expect(await callAsAgent(p.t, icarus.key, "pairs.join", { code })).toMatchObject({ status: 200 });
  const { messageId } = await p.julio.as.mutation(api.pairs.post, {
    pairId: p.pairId,
    text: "",
    attachments: [await attach(p.t, p.julio, p.pairId, "png bytes", "image/png", "crash.png")],
  });
  const link = await callAsAgent(p.t, icarus.key, "pairs.attachmentLink", { messageId, attachmentIndex: 0 });
  expect(await (await open(p.t, link.result.url)).text()).toBe("png bytes");

  const memberId = await p.t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.agentId === icarus.agentId)!._id);
  await ana.as.mutation(api.members.remove, { teamId: acmeId, memberId });
  expect((await open(p.t, link.result.url)).status).toBe(404);
});

test("an agent's link to a Pair file stops working once its key is revoked or loses pairs.join", async () => {
  const p = await paired();
  const ana = await signIn(p.t, "Ana");
  const acmeId: Id<"teams"> = await ana.as.mutation(api.teams.create, { name: "Acme" });
  const icarus = await addAgent(p.t, acmeId, ana, "Icarus", ["room.read", "messages.post", "pairs.join"]);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  expect(await callAsAgent(p.t, icarus.key, "pairs.join", { code })).toMatchObject({ status: 200 });
  const { messageId } = await p.julio.as.mutation(api.pairs.post, {
    pairId: p.pairId,
    text: "",
    attachments: [await attach(p.t, p.julio, p.pairId, "png bytes", "image/png", "crash.png")],
  });
  const link = async () => (await callAsAgent(p.t, icarus.key, "pairs.attachmentLink", { messageId, attachmentIndex: 0 })).result.url as string;
  const keyId = (await ana.as.query(api.agents.keys, { teamId: acmeId, agentId: icarus.agentId }))[0]!.keyId;

  const first = await link();
  expect(await (await open(p.t, first)).text()).toBe("png bytes");
  await ana.as.mutation(api.agents.setKeyScopes, { teamId: acmeId, keyId, scopes: ["room.read", "messages.post"] });
  expect((await open(p.t, first)).status).toBe(404);

  await ana.as.mutation(api.agents.setKeyScopes, { teamId: acmeId, keyId, scopes: ["room.read", "messages.post", "pairs.join"] });
  const second = await link();
  expect((await open(p.t, second)).status).toBe(200);
  await ana.as.mutation(api.agents.revokeKey, { teamId: acmeId, keyId });
  expect((await open(p.t, second)).status).toBe(404);
});
