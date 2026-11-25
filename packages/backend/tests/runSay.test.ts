/**
 * A run in a bridge terminal posts as itself (ADR 0026, ADR 0029 D2 and D5, slice 5 of #139):
 * `uplink-bridge say --in <place>` and `uplink-bridge reply <messageId>` reach `bridge:runSay` with
 * the bridge's token, so the agent never holds a key. The message is stored under the run's driver
 * with `asRun`, and the run can't post where its driver can't (ADR 0016).
 */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeSays, linkMachine, newRoom, newTeam, present, type Room } from "./setup";

/** Julio's Claude Code run in a terminal on his machine, live; Ana is a teammate; #general. */
async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const run = await t.run(async (ctx) => ctx.db.get(runId as Id<"runs">));
  const terminalId = run!.terminalId!;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude", access: "suggest" });
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  return { t, teamId, julio, julioId, ana, general: general!.channelId, machineId, token, runId: runId as Id<"runs">, terminalId };
}

test("a run replies to a message under it, posted as its driver with the run's name", async () => {
  const { t, teamId, julioId, ana, general, token, runId, terminalId } = await room();
  const question = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> is the model free?` });

  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, replyTo: question, text: "Yes, releasing it now." });
  expect(said).toEqual({ messageId: expect.any(String), label: "Claude Code (Julio)", place: "a thread in #general" });
  const message = present(await ana.as.query(api.messages.get, { teamId, messageId: said.messageId as Id<"messages"> }));
  expect(message).toMatchObject({ body: "Yes, releasing it now.", replyTo: question, asRun: { runId, label: "Claude Code (Julio)" } });
  expect(message.author).toMatchObject({ memberId: julioId, name: "Julio" });
});

test("a run says something in a place it names, by channel name", async () => {
  const { t, teamId, ana, general, token, terminalId } = await room();
  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "Build is green." });
  expect(said).toMatchObject({ label: "Claude Code (Julio)", place: "#general" });
  const message = present(await ana.as.query(api.messages.get, { teamId, messageId: said.messageId as Id<"messages"> }));
  expect(message).toMatchObject({ channelId: general, body: "Build is green." });
  expect(message.replyTo).toBeUndefined();
});

test("a run needs a place or a message to answer (D5), and can't post where its driver can't", async () => {
  const { t, teamId, ana, token, terminalId } = await room();
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, text: "hello" })).rejects.toThrow(/--in/);
  // Ana's private channel, which Julio isn't in, reads as missing.
  const secret = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "ana-only" });
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#ana-only", text: "hi" })).rejects.toThrow(/No channel/);
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: secret, text: "hi" })).rejects.toThrow(/not found|Not found/);
  const hidden = await ana.as.mutation(api.messages.post, { teamId, channelId: secret, body: "private" });
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, replyTo: hidden, text: "hi" })).rejects.toThrow(/not found|Not found/);
});

test("only the bridge running the terminal can post for its run, and only while the run is live", async () => {
  const { t, teamId, julio, token, terminalId } = await room();
  const other = await linkMachine(t, teamId, julio, "build-box");
  await expect(t.mutation(api.bridge.runSay, { token: other.token, terminalRef: terminalId, in: "#general", text: "hi" })).rejects.toThrow(/no live run/);
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, exitCode: 0, reason: "exited" });
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "hi" })).rejects.toThrow(/no live run/);
});

test("a run's message that names another run reaches it, labelled with the run that sent it", async () => {
  const { t, teamId, julio, julioId, token, terminalId, machineId } = await room();
  await bridgeSays(t, token, { type: "bridge_features", features: ["run_messages"] });
  const { runId: codex } = await julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId });
  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: `<@run:${codex}> the model is yours now` });

  const inbox = await julio.as.query(api.runs.inbox, { teamId, runId: codex as Id<"runs"> });
  expect(inbox.messages).toMatchObject([
    { messageId: said.messageId, from: { member: { memberId: julioId }, run: { label: "Claude Code (Julio)" } }, fromDriver: true },
  ]);
  // Codex's session, claiming its messages, reads who sent this one.
  const codexTerminal = (await t.run(async (ctx) => ctx.db.get(codex as Id<"runs">)))!.terminalId!;
  const { deliveries } = await t.mutation(api.bridge.claimRunMessages, { token, terminalRef: codexTerminal, how: "mid_task", reserve: 0 });
  expect(deliveries).toMatchObject([{ messageId: said.messageId, from: { name: "Julio", run: "Claude Code (Julio)" }, text: "@Codex (Julio) the model is yours now" }]);
});

/** An upload for the run in `terminalId`, from `bridge:runAttachUrl`, with bytes stored as the bridge's POST would. */
async function runUpload(t: Room, token: string, terminalId: string, body: string, type: string, name: string) {
  const { uploadUrl, uploadId } = await t.mutation(api.bridge.runAttachUrl, { token, terminalRef: terminalId });
  expect(uploadUrl).toMatch(/^https?:\/\//);
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([body], { type })));
  return { uploadId, storageId, name };
}

test("a run sends files with its message (ADR 0047), and another run it names gets them", async () => {
  const { t, teamId, julio, ana, token, terminalId, machineId } = await room();
  await bridgeSays(t, token, { type: "bridge_features", features: ["run_messages", "run_message_files"] });
  const { runId: codex } = await julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId });
  const said = await t.mutation(api.bridge.runSay, {
    token,
    terminalRef: terminalId,
    in: "#general",
    text: `<@run:${codex}> here's the render and its log`,
    attachments: [
      await runUpload(t, token, terminalId, "png bytes", "image/png", "render.png"),
      await runUpload(t, token, terminalId, "frame 1 ok", "text/plain", "render.log"),
    ],
  });
  const message = present(await ana.as.query(api.messages.get, { teamId, messageId: said.messageId as Id<"messages"> }));
  expect(message.attachments).toMatchObject([
    { name: "render.png", kind: "image", contentType: "image/png" },
    { name: "render.log", kind: "file" },
  ]);

  const codexTerminal = (await t.run(async (ctx) => ctx.db.get(codex as Id<"runs">)))!.terminalId!;
  const { deliveries } = await t.mutation(api.bridge.claimRunMessages, { token, terminalRef: codexTerminal, how: "mid_task", reserve: 0 });
  expect(deliveries).toMatchObject([
    { messageId: said.messageId, attachments: 2, files: [{ name: "render.png", kind: "image", mimeType: "image/png" }, { name: "render.log", kind: "file" }] },
  ]);
});

test("a run may send files with no text, and only uploads of its own driver", async () => {
  const { t, teamId, ana, token, terminalId } = await room();
  const said = await t.mutation(api.bridge.runSay, {
    token,
    terminalRef: terminalId,
    in: "#general",
    text: "",
    attachments: [await runUpload(t, token, terminalId, "%PDF-1.7", "application/pdf", "spec.pdf")],
  });
  expect(present(await ana.as.query(api.messages.get, { teamId, messageId: said.messageId as Id<"messages"> })).attachments).toMatchObject([
    { name: "spec.pdf", kind: "pdf" },
  ]);
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: " " })).rejects.toThrow(/text or a file/);

  // Ana's upload isn't the run's driver's, and an image whose bytes aren't one is refused, as messages.post refuses them.
  const { uploadId } = await ana.as.mutation(api.messages.attachUrl, { teamId });
  const anas = { uploadId, storageId: await t.run(async (ctx) => ctx.storage.store(new Blob(["x"], { type: "text/plain" }))), name: "a.txt" };
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "hi", attachments: [anas] })).rejects.toThrow(/someone else's upload/);
  const fake = await runUpload(t, token, terminalId, "not a png", "text/plain", "shot.png");
  await expect(t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "hi", attachments: [fake] })).rejects.toThrow(/isn't a PNG image/);
});

test("only a terminal with a live run gets an upload URL", async () => {
  const { t, teamId, julio, token, terminalId } = await room();
  const other = await linkMachine(t, teamId, julio, "build-box");
  await expect(t.mutation(api.bridge.runAttachUrl, { token: other.token, terminalRef: terminalId })).rejects.toThrow(/no live run/);
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, exitCode: 0, reason: "exited" });
  await expect(t.mutation(api.bridge.runAttachUrl, { token, terminalRef: terminalId })).rejects.toThrow(/no live run/);
});

test("a run that names its own driver reaches them, though its message is stored under them", async () => {
  const { t, teamId, julio, julioId, token, terminalId } = await room();
  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: `<@${julioId}> the build is green` });
  // Its banner names the run, not Julio as if he had mentioned himself.
  expect(await julio.as.query(api.messages.addressed, { teamId })).toMatchObject([
    { messageId: said.messageId, reason: "mention", asRun: { label: "Claude Code (Julio)" } },
  ]);
  // The app highlights it as a message for him.
  expect(present(await julio.as.query(api.messages.get, { teamId, messageId: said.messageId as Id<"messages"> })).mentionsMe).toBe(true);
});

// A run's message is stored under its driver (ADR 0029 D2), but the driver didn't write it: it is
// unread for them, reaches them, and their own read and mention state isn't moved by it.

/** Runs the fan-out and sweep steps due now. The machine's online check, due later, stays scheduled. */
async function dueSteps(t: Room) {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/** Julio's counts in #general. */
async function counts(julio: Awaited<ReturnType<typeof room>>["julio"], teamId: Id<"teams">, channelId: string) {
  return (await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)!;
}

test("a run's reply in a thread its driver has read up to is an unread reply for the driver", async () => {
  const { t, teamId, julio, ana, general, token, terminalId } = await room();
  const root = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "Who has the model?" });
  // Julio answers, so he has read the channel up to his reply.
  await julio.as.mutation(api.messages.post, { teamId, channelId: general, replyTo: root, body: "My run does." });
  await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, replyTo: root, text: "Releasing it now." });

  const { page } = await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null });
  expect(page).toMatchObject([{ message: { messageId: root }, newReplies: 1 }]);
});

test("a driver who set a channel to all gets a banner for their run's message there", async () => {
  const { t, teamId, julio, general, token, terminalId } = await room();
  await julio.as.mutation(api.channels.setNotify, { teamId, channelId: general, level: "all" });
  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "Build is green." });
  await dueSteps(t);
  expect(await julio.as.query(api.messages.addressed, { teamId })).toMatchObject([{ messageId: said.messageId, reason: "all" }]);
});

test("an edit that takes out a mention of the driver under their run's message takes it out of their count", async () => {
  const { t, teamId, julio, julioId, ana, general, token, terminalId } = await room();
  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "Build is green." });
  const reply = await ana.as.mutation(api.messages.post, { teamId, channelId: general, replyTo: said.messageId as Id<"messages">, body: `<@${julioId}> can you check?` });
  expect((await counts(julio, teamId, general)).mentions).toBe(1);
  // A reply to the run isn't a reply to Julio (D19), so with his name gone it doesn't count for him.
  await ana.as.mutation(api.messages.edit, { teamId, messageId: reply, body: "can you check?" });
  expect((await counts(julio, teamId, general)).mentions).toBe(0);
});

test("@everyone edited out of a reply under a run's message leaves no mention for its driver", async () => {
  const { t, teamId, julio, ana, general, token, terminalId } = await room();
  const said = await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, in: "#general", text: "Build is green." });
  const reply = await ana.as.mutation(api.messages.post, { teamId, channelId: general, replyTo: said.messageId as Id<"messages">, body: "@everyone look", mentionEveryone: true });
  await dueSteps(t);
  expect((await counts(julio, teamId, general)).mentions).toBe(1);
  await ana.as.mutation(api.messages.edit, { teamId, messageId: reply, body: "look" });
  await dueSteps(t);
  expect((await counts(julio, teamId, general)).mentions).toBe(0);
});
