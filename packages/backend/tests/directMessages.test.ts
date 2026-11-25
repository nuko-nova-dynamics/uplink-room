/**
 * Direct messages (spec #63, ADR 0015): a channel only its members can see. Someone outside it
 * gets `not_found` for anything in it, never its content.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, linkMachine, newRoom, newTeam, settleScheduled, upload } from "./setup";

const LIVEKIT = { LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" };
beforeEach(() => {
  for (const [key, value] of Object.entries(LIVEKIT)) process.env[key] = value;
});
afterEach(() => {
  for (const key of Object.keys(LIVEKIT)) delete process.env[key];
});

/** Julio (admin), Ana and Ben; Julio and Ana talk in a direct message. */
async function dm() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const channelId = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  return { t, teamId, julio, ana, ben, channelId };
}

test("a direct message is found again for the same members, and listed only for them, newest first", async () => {
  const { t, teamId, julio, ana, ben, channelId } = await dm();
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  expect((await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [julioId, ana.memberId] })).channelId).toBe(channelId);
  const group = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [julioId, ben.memberId] })).channelId;
  expect(group).not.toBe(channelId);
  await julio.as.mutation(api.messages.post, { teamId, channelId, body: "lunch?" });

  const listed = await ana.as.query(api.channels.list, { teamId });
  expect(listed.filter((c) => c.kind === "direct").map((c) => [c.channelId, c.name])).toEqual([
    [channelId, "Julio"],
    [group, "Julio, Ben"],
  ]);
  expect(listed.find((c) => c.channelId === channelId)).toMatchObject({ unread: 1, notify: "all", members: [{ name: "Julio" }, { name: "Ana" }] });
  expect((await ben.as.query(api.channels.list, { teamId })).some((c) => c.channelId === channelId)).toBe(false);

  await expect(julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [] })).rejects.toThrow(/at least one other/);
  const many = [];
  for (const name of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"]) many.push((await addTeammate(t, teamId, julio, name)).memberId);
  await expect(julio.as.mutation(api.channels.openDirect, { teamId, memberIds: many })).rejects.toThrow(/at most 10/);
});

test("someone outside a direct message gets not_found for its messages, replies, calls, pins and attachments", async () => {
  const { t, teamId, julio, ana, ben, channelId } = await dm();
  const up = await upload(t, julio, teamId, "png bytes", "image/png");
  const messageId = await julio.as.mutation(api.messages.post, {
    teamId,
    channelId,
    body: "the secret plan",
    attachments: [{ ...up, name: "plan.png" }],
  });
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "ok", replyTo: messageId });
  await ana.as.mutation(api.messages.pin, { teamId, messageId });
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId });
  const projectId = await julio.as.mutation(api.projects.create, { teamId, name: "Reef", repos: [] });

  const denied = [
    () => ben.as.query(api.messages.list, { teamId, channelId, cursor: null }),
    () => ben.as.query(api.messages.list, { teamId, channelId }),
    () => ben.as.query(api.messages.replies, { teamId, messageId }),
    () => ben.as.query(api.channels.pins, { teamId, channelId }),
    () => ben.as.query(api.calls.list, { teamId, channelId }),
    () => ben.as.query(api.calls.get, { teamId, callId }),
    () => ben.as.query(api.calls.transcript, { teamId, callId }),
    () => ben.as.mutation(api.calls.join, { teamId, channelId }),
    () => ben.as.mutation(api.messages.post, { teamId, channelId, body: "let me in" }),
    () => ben.as.mutation(api.messages.react, { teamId, messageId, emoji: "👀" }),
    () => ben.as.mutation(api.messages.pin, { teamId, messageId }),
    () => ben.as.mutation(api.channels.markRead, { teamId, channelId }),
    () => ben.as.mutation(api.files.saveAttachment, { teamId, messageId, attachmentIndex: 0, projectId }),
    () => ben.as.query(api.browsers.list, { teamId, channelId }),
    () => ben.as.query(api.savedLogins.list, { teamId, channelId }),
  ];
  for (const attempt of denied) await expect(attempt()).rejects.toThrow(/Not found in this team/);
  expect(await ben.as.query(api.calls.live, { teamId })).toEqual([]);
  // A lookup by id answers null, the same as for a message that doesn't exist.
  expect(await ben.as.query(api.messages.get, { teamId, messageId })).toBeNull();
  expect(await ben.as.query(api.messages.around, { teamId, messageId })).toBeNull();
  // Members see it all.
  expect(await ana.as.query(api.messages.get, { teamId, messageId })).toMatchObject({
    body: "the secret plan",
    // No lasting link in a direct message: members ask for a short-lived one (messages.attachmentLink).
    attachments: [{ name: "plan.png", kind: "image", restricted: true, url: null, downloadUrl: null }],
  });
  expect(await ana.as.query(api.calls.live, { teamId })).toMatchObject([{ callId, channelId }]);
  // A call in it can only invite its members.
  await expect(julio.as.mutation(api.calls.invite, { teamId, callId, memberId: ben.memberId })).rejects.toThrow(/isn't in this direct message/);
  await expect(julio.as.mutation(api.messages.post, { teamId, channelId, body: "hi", mentionedMembers: [ben.memberId] })).rejects.toThrow(
    /isn't in this direct message/,
  );
});

test("a removed team member loses their direct messages", async () => {
  const { teamId, julio, ana, channelId } = await dm();
  await julio.as.mutation(api.messages.post, { teamId, channelId, body: "before you go" });
  await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
  // Julio is left alone in it, and Ana, out of the team, can't read it.
  const rows = await julio.as.query(api.channels.list, { teamId });
  expect(rows.find((c) => c.channelId === channelId)).toMatchObject({ name: "Just you" });
  await expect(ana.as.query(api.messages.list, { teamId, channelId, cursor: null })).rejects.toThrow();
});

test("an agent key reads and posts only in the direct messages its agent is in", async () => {
  const { t, teamId, julio, channelId } = await dm();
  const { key } = await addAgent(t, teamId, julio, "Deploy bot", ["room.read", "messages.post"]);
  const botId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Deploy bot")!.memberId;
  expect(await callAsAgent(t, key, "messages.list", { channelId, cursor: null })).toMatchObject({ status: 404, error: { code: "not_found" } });
  const listed = await callAsAgent(t, key, "channels.list");
  expect((listed.result as { channelId: string }[]).some((c) => c.channelId === channelId)).toBe(false);

  const withBot = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [botId] })).channelId;
  await julio.as.mutation(api.messages.post, { teamId, channelId: withBot, body: "deploy 0.4.2 please" });
  const read = await callAsAgent(t, key, "messages.list", { channelId: withBot, cursor: null });
  expect(read.result.page).toMatchObject([{ body: "deploy 0.4.2 please" }]);
  expect(await callAsAgent(t, key, "messages.post", { channelId: withBot, body: "on it" })).toMatchObject({ ok: true });
  expect(await callAsAgent(t, key, "messages.addressed", {})).toMatchObject({ result: [{ reason: "direct", preview: "deploy 0.4.2 please" }] });
});

test("messages addressed to you follow each channel's level", async () => {
  const { t, teamId, julio, ana, ben, channelId } = await dm();
  const [general] = (await julio.as.query(api.channels.list, { teamId })).filter((c) => c.kind === "channel");
  const g = general!.channelId as Id<"channels">;
  const anaMessage = await ana.as.mutation(api.messages.post, { teamId, channelId: g, body: "status?" });

  await julio.as.mutation(api.messages.post, { teamId, channelId, body: "in the DM" });
  await julio.as.mutation(api.messages.post, { teamId, channelId: g, body: "plain chatter" });
  await julio.as.mutation(api.messages.post, { teamId, channelId: g, body: "fine", replyTo: anaMessage });
  await ben.as.mutation(api.messages.post, { teamId, channelId: g, body: `<@${ana.memberId}> look` });
  const first = await ana.as.query(api.messages.addressed, { teamId });
  expect(first.map((a) => [a.reason, a.preview, a.channel.label])).toEqual([
    ["mention", "@Ana look", "#general"],
    ["reply", "fine", "#general"],
    ["direct", "in the DM", "Julio"],
  ]);

  // All in #general, nothing from the direct message.
  await ana.as.mutation(api.channels.setNotify, { teamId, channelId: g, level: "all" });
  await ana.as.mutation(api.channels.setNotify, { teamId, channelId, level: "none" });
  // Like the app: only alerts that reached Ana after the newest one already seen.
  const after = first[0]!.seq;
  await julio.as.mutation(api.messages.post, { teamId, channelId, body: "muted DM" });
  await ben.as.mutation(api.messages.post, { teamId, channelId: g, body: "loud channel" });
  await settleScheduled(t);
  expect((await ana.as.query(api.messages.addressed, { teamId, after })).map((a) => [a.reason, a.preview])).toEqual([["all", "loud channel"]]);
  const rows = await ana.as.query(api.channels.list, { teamId });
  expect(rows.find((c) => c.channelId === channelId)).toMatchObject({ notify: "none", unread: 2 });
  expect(t).toBeTruthy();
});

test("a direct message with a live run adds its person as a member, opens again for the same members and runs, and a run private to it hears every message (ADR 0026, ADR 0039)", async () => {
  const { t, teamId, julio, ana, ben } = await dm();
  const { machineId } = await linkMachine(t, teamId, ana, "ana-mbp");
  const { runId } = await ana.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });

  // Julio messages Ana's run: Ana joins as an ordinary member, so one access check still decides it.
  const channelId = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId;
  // As if started from a task in this direct message: only its members can see the run's terminal.
  await t.run((ctx) => ctx.db.patch(runId as Id<"runs">, { directChannelId: channelId }));
  expect((await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId], runIds: [runId] })).channelId).toBe(channelId);
  const withoutRun = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  expect(withoutRun).not.toBe(channelId);
  const listed = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId);
  expect(listed).toMatchObject({ members: [{ name: "Julio" }, { name: "Ana" }], runs: [{ runId, label: "Claude Code (Ana)" }] });
  // Named by its run first, then the other people in it.
  expect(listed!.name).toBe("Claude Code (Ana), Julio");
  // Your own run alone with you is named by the run, not "Just you".
  const { runId: own } = await julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId: (await linkMachine(t, teamId, julio, "julio-mbp")).machineId });
  const alone = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [own] })).channelId;
  expect((await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === alone)!.name).toBe("Codex (Julio)");

  const first = await julio.as.mutation(api.messages.post, { teamId, channelId, body: "can you hand me the model when you're done?" });
  const second = await julio.as.mutation(api.messages.post, { teamId, channelId, body: "thanks" });
  const inbox = await ana.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox.messages!.map((m) => [m.messageId, m.place, m.status])).toEqual([
    [second, "a direct message", "waiting"],
    [first, "a direct message", "waiting"],
  ]);
  // Julio's own Codex run is a team run: anyone in the team can watch its terminal. The direct
  // message opened with it says so first, and the run still hears it (ADR 0039, amended 2026-11-05).
  const lines = (await julio.as.query(api.messages.list, { teamId, channelId: alone, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(lines.page.map((m) => m.system?.text)).toEqual(["Codex (Julio)'s output is visible to the whole team, so what you send here won't stay private."]);
  const aside = await julio.as.mutation(api.messages.post, { teamId, channelId: alone, body: "note to self: rotate the key", acknowledgeWarning: true });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId: own })).messages).toMatchObject([{ messageId: aside, status: "waiting" }]);
  // A run private to its direct message gets no such line or warning.
  expect((listed as { runs?: unknown[] }).runs).toEqual([{ runId, label: "Claude Code (Ana)", files: "stay" }]);
  // A message to her run doesn't banner Ana (D19); one that names her does.
  expect(await ana.as.query(api.messages.addressed, { teamId })).toEqual([]);
  await julio.as.mutation(api.messages.post, { teamId, channelId, body: `<@${ana.memberId}> are you around?` });
  expect((await ana.as.query(api.messages.addressed, { teamId })).map((a) => a.reason)).toEqual(["mention"]);

  // Ben isn't in it.
  await expect(ben.as.query(api.messages.list, { teamId, channelId })).rejects.toThrow(/Not found/);
  // A run that isn't live can't be messaged.
  await ana.as.mutation(api.runs.stop, { teamId, runId });
  await expect(julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ben.memberId], runIds: [runId] })).rejects.toThrow(/isn't live/);
});

test("a run driven by someone's agent can be in a direct message: the agent and its person join it, and the agent reads what the run is sent", async () => {
  const { t, teamId, julio, ana } = await dm();
  const { machineId } = await linkMachine(t, teamId, ana, "ana-mbp");
  const { key } = await addAgent(t, teamId, ana, "Builder", ["room.read", "messages.post", "runs.start"]);
  const { key: other } = await addAgent(t, teamId, ana, "Scout", ["room.read", "messages.post"]);
  const started = await callAsAgent(t, key, "runs.start", { harness: "codex", machineId });
  expect(started).toMatchObject({ ok: true });
  const runId = started.result.runId;

  const channelId = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId;
  // As if started from a task in this direct message, so it hears what is said there (ADR 0039).
  await t.run((ctx) => ctx.db.patch(runId as Id<"runs">, { directChannelId: channelId }));
  const listed = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId);
  expect(listed).toMatchObject({ members: [{ name: "Julio" }, { name: "Ana" }, { name: "Builder" }], runs: [{ runId, label: "Codex (Builder)" }] });
  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId, body: "what's left?" });
  expect((await ana.as.query(api.runs.inbox, { teamId, runId })).messages!.map((m) => m.messageId)).toEqual([messageId]);
  // The agent driving the run reads the text, and can answer there.
  const forDriver = await callAsAgent(t, key, "runs.inbox", { runId });
  expect(forDriver.result.messages).toEqual([expect.objectContaining({ messageId, text: "what's left?", place: "a direct message" })]);
  expect(await callAsAgent(t, key, "messages.post", { channelId, body: "the invoice tests" })).toMatchObject({ ok: true });
  // Another agent of Ana's isn't in it, so it reads no text.
  expect((await callAsAgent(t, other, "runs.inbox", { runId })).result.messages.map((m: { text?: string }) => m.text)).toEqual([undefined, undefined]);
  expect(await callAsAgent(t, other, "messages.list", { channelId })).toMatchObject({ ok: false, error: { code: "not_found" } });
});
