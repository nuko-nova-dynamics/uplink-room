/**
 * Private channels (issue #64, ADR 0016): a team channel with a member list. Only its members,
 * people or agents, see anything in it; everyone else, team admins included, gets `not_found`.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, linkMachine, newRoom, newTeam, settleScheduled, upload } from "./setup";

const LIVEKIT = { LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" };
beforeEach(() => {
  for (const [key, value] of Object.entries(LIVEKIT)) process.env[key] = value;
});
afterEach(() => {
  for (const key of Object.keys(LIVEKIT)) delete process.env[key];
});

type Page = { page: { body: string; mentionedMembers: string[] }[] };
/** messages.list with a cursor: the newest page. */
const newest = (result: unknown) => (result as Page).page;

/** Julio is the team's admin and stays outside; Ana creates #launch with Ben; Cy is a plain teammate outside it. */
async function launch() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const cy = await addTeammate(t, teamId, julio, "Cy");
  const channelId = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "#Launch", memberIds: [ben.memberId] });
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  return { t, teamId, julio, julioId, ana, ben, cy, channelId };
}

test("a private channel is listed only for its members, with its members and creator, beside the team's channels", async () => {
  const { teamId, julio, ana, ben, cy, channelId } = await launch();
  const listed = await ben.as.query(api.channels.list, { teamId });
  expect(listed.map((c) => [c.kind, c.name])).toEqual([
    ["channel", "general"],
    ["private", "launch"],
  ]);
  const row = listed.find((c) => c.channelId === channelId)!;
  expect(row).toMatchObject({ kind: "private", notify: "mentions", unread: 0, members: [{ name: "Ana" }, { name: "Ben" }] });
  expect(row.kind === "private" && row.createdBy).toBe(ana.memberId);
  for (const outside of [julio, cy]) {
    expect((await outside.as.query(api.channels.list, { teamId })).some((c) => c.channelId === channelId)).toBe(false);
  }
  expect(await ana.as.query(api.channels.members, { teamId, channelId })).toMatchObject({
    kind: "private",
    creatorId: ana.memberId,
    canRemove: true,
    members: [{ name: "Ana" }, { name: "Ben", addedBy: { name: "Ana" } }],
  });
  expect((await ana.as.query(api.channels.members, { teamId, channelId })).members[0]!.addedBy).toBeUndefined();
  expect(await ben.as.query(api.channels.members, { teamId, channelId })).toMatchObject({ canRemove: false });
  await expect(ana.as.mutation(api.channels.createPrivate, { teamId, name: "  #  " })).rejects.toThrow(/needs a name/);
});

test("someone outside a private channel, a team admin included, gets not_found for everything in it", async () => {
  const { t, teamId, julio, ana, ben, cy, channelId } = await launch();
  const up = await upload(t, ana, teamId, "png bytes", "image/png");
  const messageId = await ana.as.mutation(api.messages.post, {
    teamId,
    channelId,
    body: "the launch date is the 14th https://example.com/plan",
    attachments: [{ ...up, name: "plan.png" }],
  });
  await ben.as.mutation(api.messages.post, { teamId, channelId, body: "ok", replyTo: messageId });
  await ben.as.mutation(api.messages.pin, { teamId, messageId });
  const { callId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
  const projectId = await julio.as.mutation(api.projects.create, { teamId, name: "Reef", repos: [] });

  for (const outside of [julio, cy]) {
    const denied = [
      () => outside.as.query(api.messages.list, { teamId, channelId, cursor: null }),
      () => outside.as.query(api.messages.list, { teamId, channelId }),
      () => outside.as.query(api.messages.replies, { teamId, messageId }),
      () => outside.as.query(api.channels.pins, { teamId, channelId }),
      () => outside.as.query(api.channels.members, { teamId, channelId }),
      () => outside.as.query(api.calls.list, { teamId, channelId }),
      () => outside.as.query(api.calls.get, { teamId, callId }),
      () => outside.as.query(api.calls.transcript, { teamId, callId }),
      () => outside.as.query(api.browsers.list, { teamId, channelId }),
      () => outside.as.query(api.savedLogins.list, { teamId, channelId }),
      () => outside.as.query(api.messages.search, { teamId, query: "launch", channelId }),
      () => outside.as.mutation(api.calls.join, { teamId, channelId }),
      () => outside.as.mutation(api.messages.post, { teamId, channelId, body: "let me in" }),
      () => outside.as.mutation(api.messages.react, { teamId, messageId, emoji: "👀" }),
      () => outside.as.mutation(api.messages.unreact, { teamId, messageId, emoji: "👀" }),
      () => outside.as.mutation(api.messages.pin, { teamId, messageId }),
      () => outside.as.mutation(api.messages.unpin, { teamId, messageId }),
      () => outside.as.mutation(api.messages.delete, { teamId, messageId }),
      () => outside.as.mutation(api.messages.hidePreview, { teamId, messageId }),
      () => outside.as.mutation(api.channels.markRead, { teamId, channelId }),
      () => outside.as.mutation(api.channels.markSeen, { teamId, channelId, messageIds: [messageId] }),
      () => outside.as.mutation(api.channels.setNotify, { teamId, channelId, level: "all" }),
      () => outside.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [cy.memberId] }),
      () => outside.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ben.memberId }),
      () => outside.as.mutation(api.channels.leave, { teamId, channelId }),
      () => outside.as.mutation(api.files.saveAttachment, { teamId, messageId, attachmentIndex: 0, projectId }),
      () => outside.as.mutation(api.browsers.start, { teamId, channelId }),
    ];
    for (const attempt of denied) await expect(attempt()).rejects.toThrow(/Not found in this team/);
    expect(await outside.as.query(api.messages.get, { teamId, messageId })).toBeNull();
    expect(await outside.as.query(api.messages.around, { teamId, messageId })).toBeNull();
    expect(await outside.as.query(api.calls.live, { teamId })).toEqual([]);
    // Search across everything finds nothing in it, though it is the only match.
    expect(await outside.as.query(api.messages.search, { teamId, query: "launch" })).toMatchObject({ results: [], isDone: true });
  }
  // Members see all of it: the attachment, the pin, the call, the search result.
  expect(await ben.as.query(api.messages.get, { teamId, messageId })).toMatchObject({
    body: "the launch date is the 14th https://example.com/plan",
    attachments: [{ name: "plan.png", restricted: true, url: null, downloadUrl: null }],
    pinned: { by: { name: "Ben" } },
  });
  expect(await ben.as.query(api.calls.live, { teamId })).toMatchObject([{ callId, channelId }]);
  expect((await ben.as.query(api.messages.search, { teamId, query: "launch" })).results).toMatchObject([
    { messageId, channel: { channelId, kind: "private", name: "launch" } },
  ]);
  // A member can't pull someone outside into a call or a mention without adding them first.
  await expect(ana.as.mutation(api.calls.invite, { teamId, callId, memberId: cy.memberId })).rejects.toThrow(/isn't in #launch/);
  await expect(ana.as.mutation(api.messages.post, { teamId, channelId, body: "hi", mentionedMembers: [cy.memberId] })).rejects.toThrow(
    /isn't in #launch/,
  );
});

test("@everyone in a private channel reaches only its members; a mention of someone outside stays text", async () => {
  const { t, teamId, julio, julioId, ana, ben, cy, channelId } = await launch();
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "@everyone launch at noon", mentionEveryone: true });
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: `<@${julioId}> can't see this` });
  await settleScheduled(t);

  expect((await ben.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)).toMatchObject({ unread: 2, mentions: 1 });
  expect(await ben.as.query(api.messages.addressed, { teamId })).toMatchObject([{ reason: "everyone", preview: "@everyone launch at noon", channel: { kind: "private", label: "#launch" } }]);
  for (const outside of [julio, cy]) expect(await outside.as.query(api.messages.addressed, { teamId })).toEqual([]);
  const last = newest(await ana.as.query(api.messages.list, { teamId, channelId, cursor: null }))[0]!;
  expect(last.mentionedMembers).toEqual([]);
});

test("any member can add teammates and agents, who see its history from then on, read up to now", async () => {
  const { t, teamId, julio, ana, ben, cy, channelId } = await launch();
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "before Cy came" });
  const bot = await addAgent(t, teamId, julio, "Deploy bot", ["room.read", "messages.post", "work.manage"]);
  const botId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Deploy bot")!.memberId;

  // Ben isn't its creator, and can still add people.
  expect(await ben.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [cy.memberId, ben.memberId, botId] })).toEqual({
    added: [cy.memberId, botId],
  });
  expect((await cy.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)).toMatchObject({ unread: 0 });
  expect(newest(await cy.as.query(api.messages.list, { teamId, channelId, cursor: null })).map((m) => m.body)).toEqual(["before Cy came"]);
  expect((await callAsAgent(t, bot.key, "messages.list", { channelId, cursor: null })).result.page).toMatchObject([{ body: "before Cy came" }]);
  // New messages count for the new member.
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: `<@${cy.memberId}> welcome` });
  expect((await cy.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)).toMatchObject({ unread: 1, mentions: 1 });
  expect((await cy.as.query(api.channels.members, { teamId, channelId })).members.find((m) => m.name === "Cy")).toMatchObject({ addedBy: { name: "Ben" } });

  // Direct messages and team channels keep their members.
  const dm = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [ben.memberId] })).channelId;
  await expect(ana.as.mutation(api.channels.addMembers, { teamId, channelId: dm, memberIds: [cy.memberId] })).rejects.toThrow(/keeps the members/);
  const general = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.name === "general")!.channelId;
  await expect(ana.as.mutation(api.channels.addMembers, { teamId, channelId: general, memberIds: [cy.memberId] })).rejects.toThrow(
    /Everyone in the team/,
  );
  await expect(ana.as.mutation(api.channels.leave, { teamId, channelId: general })).rejects.toThrow(/Everyone in the team/);
  await expect(ana.as.mutation(api.channels.leave, { teamId, channelId: dm })).rejects.toThrow(/keeps the members/);
});

test("only the creator, or an admin who is a member, can remove members; whoever is removed loses it at once", async () => {
  const { t, teamId, julio, julioId, ana, ben, cy, channelId } = await launch();
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [cy.memberId] });
  await expect(ben.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: cy.memberId })).rejects.toThrow(/Only whoever created/);
  // Julio is an admin, but not in it: he can't even find it.
  await expect(julio.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: cy.memberId })).rejects.toThrow(/Not found/);
  // Once in it, an admin can remove members.
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [julioId] });
  await julio.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: cy.memberId });
  await ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: julioId });

  await ben.as.mutation(api.channels.setNotify, { teamId, channelId, level: "all" });
  await ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ben.memberId });
  for (const gone of [cy, ben, julio]) {
    await expect(gone.as.query(api.messages.list, { teamId, channelId, cursor: null })).rejects.toThrow(/Not found/);
    expect((await gone.as.query(api.channels.list, { teamId })).some((c) => c.channelId === channelId)).toBe(false);
  }
  // Ben had it set to all messages: nothing reaches him from it now, @everyone included.
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "@everyone still here?", mentionEveryone: true });
  await settleScheduled(t);
  expect(await ben.as.query(api.messages.addressed, { teamId })).toEqual([]);
  expect((await ana.as.query(api.channels.members, { teamId, channelId })).members.map((m) => m.name)).toEqual(["Ana"]);
  await expect(ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ben.memberId })).rejects.toThrow(/aren't in this channel/);
});

test("a member can leave; the last one out archives it, and only someone still in it can add them back", async () => {
  const { teamId, ana, ben, channelId } = await launch();
  await ben.as.mutation(api.channels.leave, { teamId, channelId });
  await expect(ben.as.query(api.messages.list, { teamId, channelId, cursor: null })).rejects.toThrow(/Not found/);
  await expect(ben.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [ben.memberId] })).rejects.toThrow(/Not found/);
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [ben.memberId] });
  expect((await ben.as.query(api.channels.list, { teamId })).some((c) => c.channelId === channelId)).toBe(true);

  await ben.as.mutation(api.channels.leave, { teamId, channelId });
  // Anyone can take themselves out with removeMember too, the creator included.
  await ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ana.memberId });
  await expect(ana.as.query(api.messages.list, { teamId, channelId, cursor: null })).rejects.toThrow(/Not found/);
  const channel = await ana.as.query(api.channels.list, { teamId });
  expect(channel.some((c) => c.channelId === channelId)).toBe(false);
});

test("removing someone from the team takes them out of every private channel; one left empty is archived", async () => {
  const { t, teamId, julio, ana, ben, channelId } = await launch();
  const solo = await ben.as.mutation(api.channels.createPrivate, { teamId, name: "ben-notes" });
  await julio.as.mutation(api.members.remove, { teamId, memberId: ben.memberId });
  expect((await ana.as.query(api.channels.members, { teamId, channelId })).members.map((m) => m.name)).toEqual(["Ana"]);
  await expect(ben.as.query(api.messages.list, { teamId, channelId, cursor: null })).rejects.toThrow();
  expect(await t.run(async (ctx) => (await ctx.db.get(solo))?.archivedAt)).toEqual(expect.any(Number));
});

test("an agent key reads nothing in a private channel its agent isn't in, and the default scopes can't add members", async () => {
  const { t, teamId, julio, ana, channelId } = await launch();
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "launch secrets" });
  const { key } = await addAgent(t, teamId, julio, "Scout", ["room.read", "messages.post"]);
  const scoutId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Scout")!.memberId;

  expect(await callAsAgent(t, key, "messages.list", { channelId, cursor: null })).toMatchObject({ status: 404, error: { code: "not_found" } });
  expect(await callAsAgent(t, key, "messages.post", { channelId, body: "hi" })).toMatchObject({ status: 404 });
  expect((await callAsAgent(t, key, "channels.list")).result.some((c: { channelId: string }) => c.channelId === channelId)).toBe(false);
  expect((await callAsAgent(t, key, "messages.search", { query: "launch" })).result.results).toEqual([]);

  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [scoutId] });
  expect((await callAsAgent(t, key, "messages.list", { channelId, cursor: null })).result.page).toMatchObject([{ body: "launch secrets" }]);
  // Adding members needs work.manage; leaving needs only messages.post.
  expect(await callAsAgent(t, key, "channels.addMembers", { channelId, memberIds: [scoutId] })).toMatchObject({ status: 403 });
  expect(await callAsAgent(t, key, "channels.leave", { channelId })).toMatchObject({ ok: true });
  expect(await callAsAgent(t, key, "messages.list", { channelId, cursor: null })).toMatchObject({ status: 404 });
  // Agents can't use @everyone here either.
  const writer = await addAgent(t, teamId, ana, "Writer", ["room.read", "messages.post", "work.manage"]);
  const made = await callAsAgent(t, writer.key, "channels.createPrivate", { name: "agents-only" });
  expect(made).toMatchObject({ ok: true });
  expect(await callAsAgent(t, writer.key, "messages.post", { channelId: made.result, body: "@everyone", mentionEveryone: true })).toMatchObject({
    status: 403,
  });
});

test("a task from a private channel's call shows the team no title, and only members act on it or its runs", async () => {
  const { t, teamId, julio, ana, ben, cy, channelId } = await launch();
  const { callId, participationId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
  await ana.as.mutation(api.calls.leave, { teamId, participationId });
  const [proposalId] = await ana.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Ship the launch page", description: "by the 14th" }] });
  await expect(ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: proposalId!, projectId: null, ownerId: cy.memberId })).rejects.toThrow(
    /Cy isn't in #launch/,
  );
  const taskId = await ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: proposalId!, projectId: null, ownerId: ben.memberId });

  for (const outside of [julio, cy]) {
    const seen = await outside.as.query(api.tasks.get, { teamId, taskId });
    expect(seen).toMatchObject({ title: "A task from a private channel", private: true });
    expect(seen.description).toBeUndefined();
    const board = await outside.as.query(api.tasks.board, { teamId });
    expect(JSON.stringify(board)).not.toContain("launch page");
    await expect(outside.as.mutation(api.tasks.update, { teamId, taskId, title: "mine now" })).rejects.toThrow(/Not found/);
    await expect(outside.as.mutation(api.inbox.settle, { teamId, taskId })).rejects.toThrow(/Not found/);
  }
  expect(await ben.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ title: "Ship the launch page", private: false, description: "by the 14th" });
  await expect(ana.as.mutation(api.tasks.update, { teamId, taskId, ownerId: cy.memberId })).rejects.toThrow(/Cy isn't in #launch/);

  // A run on it keeps its texts to the channel, and its terminal's title doesn't quote the task.
  const { machineId, token } = await linkMachine(t, teamId, ben, "ben-mbp");
  const { runId, terminalId } = await ben.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  expect(await bridgeInbox(t, token)).toMatchObject([{ type: "start_terminal", terminalId }]);
  expect(await ben.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).toMatchObject({ title: "A task from a private channel" });
  await expect(julio.as.mutation(api.runs.stop, { teamId, runId })).rejects.toThrow(/Not found/);
  expect(await julio.as.query(api.runs.get, { teamId, runId })).toMatchObject({ private: true });
  const inbox = await julio.as.query(api.inbox.get, { teamId, view: "team" });
  expect(JSON.stringify(inbox)).not.toContain("launch page");
  expect([...inbox.needsYou, ...inbox.working, ...inbox.done].find((r) => r.taskId === taskId)).toMatchObject({
    title: "A task from a private channel",
    private: true,
  });
});

test("the activity log shows what happens in a private channel only to its members", async () => {
  const { t, teamId, julio, ana, ben, channelId } = await launch();
  const bot = await addAgent(t, teamId, ana, "Helper", ["room.read", "messages.post"]);
  const botId = (await ana.as.query(api.teams.members, { teamId })).find((m) => m.name === "Helper")!.memberId;
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [botId] });
  expect(await callAsAgent(t, bot.key, "messages.post", { channelId, body: "posted by the agent" })).toMatchObject({ ok: true });

  const inChannel = (rows: { action: string; target: string; details?: unknown }[]) =>
    rows.filter((r) => r.target === channelId || JSON.stringify(r.details ?? {}).includes(channelId));
  expect(inChannel(await ben.as.query(api.activity.list, { teamId })).map((r) => r.action).sort()).toEqual(
    ["api.messages.post", "channel.members_added", "channel.private_created"].sort(),
  );
  expect(inChannel(await julio.as.query(api.activity.list, { teamId }))).toEqual([]);
});

test("a private channel's notify level defaults to mentions, and someone who joins the team later doesn't get it", async () => {
  const { t, teamId, julio, channelId } = await launch();
  const late = await addTeammate(t, teamId, julio, "Dee");
  expect((await late.as.query(api.channels.list, { teamId })).some((c) => c.channelId === channelId)).toBe(false);
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("channelReads")
      .withIndex("by_channel_member", (q) => q.eq("channelId", channelId as Id<"channels">).eq("memberId", late.memberId))
      .collect(),
  );
  expect(rows).toEqual([]);
});

/** A task accepted from #launch's call, owned by Ben, and a terminal run on it on Ben's machine (open access). */
async function privateTaskRun() {
  const room = await launch();
  const { t, teamId, ana, ben, channelId } = room;
  const { callId, participationId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
  await ana.as.mutation(api.calls.leave, { teamId, participationId });
  const [proposalId] = await ana.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Ship the launch page" }] });
  const taskId = await ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: proposalId!, projectId: null, ownerId: ben.memberId });
  const { machineId, token } = await linkMachine(t, teamId, ben, "ben-mbp");
  await ben.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const { runId, terminalId } = await ben.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId, access: "open" });
  return { ...room, taskId, runId: runId as Id<"runs">, terminalId: terminalId as Id<"terminals">, machineId, token };
}

test("lowering a machine below Drive leaves a private channel's run with nobody driving when the machine's person isn't in the channel (ADR 0025)", async () => {
  const { t, teamId, ana, ben, cy, channelId } = await launch();
  const { callId, participationId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
  await ana.as.mutation(api.calls.leave, { teamId, participationId });
  const [proposalId] = await ana.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Ship the launch page" }] });
  const taskId = await ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: proposalId!, projectId: null, ownerId: ben.memberId });
  // Cy isn't in #launch; Ben runs the task on Cy's machine while it's open to teammates.
  const { machineId, token } = await linkMachine(t, teamId, cy, "cy-mbp");
  await cy.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const { terminalId } = await ben.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId, access: "open" });

  await cy.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "suggest" });

  expect((await ben.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).driver).toBeUndefined();
  expect((await bridgeInbox(t, token)).filter((m) => m.type === "driver_changed").at(-1)).toEqual({ v: 1, type: "driver_changed", terminalId });
  await expect(ben.as.mutation(api.terminals.input, { teamId, terminalId: terminalId!, data: "ls\r" })).rejects.toThrow(/driver/);
});

/** A task from a call in #launch, so its runs are the channel's (ADR 0016). */
async function launchTask({ teamId, ana, channelId }: Awaited<ReturnType<typeof launch>>, ownerId: Id<"members">) {
  const { callId, participationId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
  await ana.as.mutation(api.calls.leave, { teamId, participationId });
  const [proposalId] = await ana.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Ship the launch page" }] });
  return await ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: proposalId!, projectId: null, ownerId });
}

test("a machine's person leaving a private channel doesn't hand its run back to the teammate below Drive: nobody drives it (ADR 0025)", async () => {
  const room = await launch();
  const { t, teamId, ana, ben, cy, channelId } = room;
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [cy.memberId] });
  const taskId = await launchTask(room, ben.memberId);
  const { machineId, token } = await linkMachine(t, teamId, cy, "cy-mbp");
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  await cy.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const { terminalId } = await ben.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId, access: "open" });
  const thread = await ben.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" });
  await cy.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "suggest" });
  expect((await cy.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).driver?.name).toBe("Cy");

  await cy.as.mutation(api.channels.leave, { teamId, channelId });

  expect((await ben.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).driver).toBeUndefined();
  expect((await ben.as.query(api.threads.get, { teamId, runId: thread.runId })).driver).toBeUndefined();
  const inbox = await bridgeInbox(t, token);
  expect(inbox.filter((m) => m.type === "driver_changed").at(-1)).toEqual({ v: 1, type: "driver_changed", terminalId });
  expect(inbox.filter((m) => m.type === "thread_driver_changed").at(-1)).toEqual({
    v: 1,
    type: "thread_driver_changed",
    threadRef: thread.runId,
    starterId: ben.memberId,
  });
  await expect(ben.as.mutation(api.terminals.input, { teamId, terminalId: terminalId!, data: "ls\r" })).rejects.toThrow(/driver/);
});

test("lowering a machine below Drive takes a private channel's run from the person's own agent too when the person isn't in the channel (ADR 0025)", async () => {
  const room = await launch();
  const { t, teamId, ana, ben, cy, channelId } = room;
  const bot = await addAgent(t, teamId, cy, "Cy's Claude", ["room.read", "runs.start", "terminals.drive"]);
  const botId = (await cy.as.query(api.teams.members, { teamId })).find((m) => m.name === "Cy's Claude")!.memberId;
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [botId] });
  const taskId = await launchTask(room, ben.memberId);
  const { machineId, token } = await linkMachine(t, teamId, cy, "cy-mbp");
  await cy.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const started = await callAsAgent(t, bot.key, "runs.start", { taskId, machineId, harness: "claude-code", access: "open" });
  const terminalId = started.result.terminalId as Id<"terminals">;

  await cy.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "suggest" });

  expect((await ben.as.query(api.terminals.get, { teamId, terminalId })).driver).toBeUndefined();
  expect((await bridgeInbox(t, token)).filter((m) => m.type === "driver_changed").at(-1)).toEqual({ v: 1, type: "driver_changed", terminalId });
  expect(await callAsAgent(t, bot.key, "terminals.input", { terminalId, data: "ls\r" })).toMatchObject({ status: 403 });
  expect(await callAsAgent(t, bot.key, "terminals.takeWheel", { terminalId })).toMatchObject({ status: 403 });
  // Nor does it start another run from #launch there while the machine stays below Drive.
  expect(await callAsAgent(t, bot.key, "runs.start", { taskId, machineId, harness: "claude-code" })).toMatchObject({ status: 403 });
});

test("a run from a private channel shows the team no approved action either (P1)", async () => {
  const { t, teamId, julio, ben, taskId, runId } = await privateTaskRun();
  await t.run(async (ctx) => {
    await ctx.db.patch(runId, { lastAnswer: { by: ben.memberId, answer: "allow", action: "deploy with key K-123", at: Date.now() } });
  });
  const seen = [
    await julio.as.query(api.runs.get, { teamId, runId }),
    await julio.as.query(api.tasks.get, { teamId, taskId }),
    await julio.as.query(api.tasks.board, { teamId }),
    await julio.as.query(api.inbox.get, { teamId, view: "team" }),
  ];
  for (const view of seen) expect(JSON.stringify(view)).not.toContain("K-123");
  expect(await ben.as.query(api.runs.get, { teamId, runId })).toMatchObject({ lastAnswer: { action: "deploy with key K-123" } });
});

test("a terminal on a private channel's run is the channel's alone, and its driver loses the wheel on leaving (P2)", async () => {
  const { t, teamId, julio, ana, ben, terminalId, token } = await privateTaskRun();
  const { key } = await addAgent(t, teamId, julio, "Scout", ["room.read", "terminals.drive"]);
  await ana.as.mutation(api.terminals.takeWheel, { teamId, terminalId });

  const denied = [
    () => julio.as.query(api.terminals.get, { teamId, terminalId }),
    () => julio.as.query(api.terminals.output, { teamId, terminalId }),
    () => julio.as.query(api.terminals.inputLog, { teamId, terminalId, paginationOpts: { numItems: 10, cursor: null } }),
    () => julio.as.query(api.terminals.suggestions, { teamId, terminalId }),
    () => julio.as.query(api.terminals.wheelRequests, { teamId, terminalId }),
    () => julio.as.mutation(api.terminals.watch, { teamId, terminalId }),
    () => julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\n" }),
    () => julio.as.mutation(api.terminals.suggest, { teamId, terminalId, command: "ls" }),
    () => julio.as.mutation(api.terminals.takeWheel, { teamId, terminalId }),
  ];
  for (const attempt of denied) await expect(attempt()).rejects.toThrow(/Not found in this team/);
  expect((await julio.as.query(api.terminals.list, { teamId })).some((x) => x.terminalId === terminalId)).toBe(false);
  expect(await callAsAgent(t, key, "terminals.output", { terminalId })).toMatchObject({ status: 404 });
  expect((await callAsAgent(t, key, "terminals.list")).result.some((x: { terminalId: string }) => x.terminalId === terminalId)).toBe(false);

  // Ana drives it; when she leaves, the wheel goes back to Ben, who started it, and she can't type.
  await ana.as.mutation(api.channels.leave, { teamId, channelId: (await ben.as.query(api.channels.list, { teamId })).find((c) => c.kind === "private")!.channelId });
  expect(await ben.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ driver: { name: "Ben" } });
  expect((await bridgeInbox(t, token)).at(-1)).toMatchObject({ type: "driver_changed", terminalId, driver: { name: "Ben" } });
  await expect(ana.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\n" })).rejects.toThrow(/Not found/);
});

test("a private channel's attachments go only through short-lived links that stop on removal (P3)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, ben, channelId } = await launch();
    const up = await upload(t, ana, teamId, "png bytes", "image/png");
    const messageId = await ana.as.mutation(api.messages.post, { teamId, channelId, body: "plan", attachments: [{ ...up, name: "plan.png" }] });
    expect((await ben.as.query(api.messages.get, { teamId, messageId }))!.attachments[0]).toMatchObject({ restricted: true, url: null, downloadUrl: null });
    // The attachment's own lasting link serves nothing for a private channel.
    const lasting = await t.run(async (ctx) => (await ctx.db.query("attachments").collect())[0]!.token);
    expect((await t.fetch(`/attachments/${lasting}/plan.png`)).status).toBe(404);
    await expect(julio.as.mutation(api.messages.attachmentLink, { teamId, messageId, attachmentIndex: 0 })).rejects.toThrow(/Not found/);

    const path = (url: string) => new URL(url, "http://x").pathname;
    const benLink = await ben.as.mutation(api.messages.attachmentLink, { teamId, messageId, attachmentIndex: 0 });
    const shown = await t.fetch(path(benLink.url));
    expect(shown.status).toBe(200);
    expect(await shown.text()).toBe("png bytes");
    expect(shown.headers.get("content-disposition")).toMatch(/^inline;/);
    const download = await ben.as.mutation(api.messages.attachmentLink, { teamId, messageId, attachmentIndex: 0, download: true });
    expect((await t.fetch(path(download.url))).headers.get("content-disposition")).toMatch(/^attachment;/);

    // Removed: Ben's links stop working at once.
    await ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ben.memberId });
    expect((await t.fetch(path(benLink.url))).status).toBe(404);
    // And Ana's own link stops after ten minutes.
    const anaLink = await ana.as.mutation(api.messages.attachmentLink, { teamId, messageId, attachmentIndex: 0 });
    expect((await t.fetch(path(anaLink.url))).status).toBe(200);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect((await t.fetch(path(anaLink.url))).status).toBe(404);
  } finally {
    vi.useRealTimers();
  }
});

test("filing a private run keeps it private, and never mixes it with a task from elsewhere (P4)", async () => {
  const { t, teamId, julio, ana, channelId } = await launch();
  const unfiled = (direct?: Id<"channels">) =>
    t.run(async (ctx) =>
      ctx.db.insert("runs", { teamId, harness: "a2a", title: "Message from Ana in a private channel", state: "unknown", stateChangedAt: Date.now(), ...(direct ? { directChannelId: direct } : {}) }),
    );
  const privateRun = await unfiled(channelId);
  const taskId = await ana.as.mutation(api.runs.file, { teamId, runId: privateRun, newTask: { title: "Ship the launch page" } });
  expect(await julio.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ title: "A task from a private channel", private: true });
  await expect(julio.as.mutation(api.tasks.update, { teamId, taskId, title: "mine" })).rejects.toThrow(/Not found/);

  const publicTask = await ana.as.mutation(api.tasks.create, { teamId, title: "Public chores" });
  await expect(ana.as.mutation(api.runs.file, { teamId, runId: await unfiled(channelId), taskId: publicTask })).rejects.toThrow(/private conversation/);
  await expect(ana.as.mutation(api.runs.file, { teamId, runId: await unfiled(), taskId })).rejects.toThrow(/private conversation/);
});

test("someone added back starts from now: nothing from their time away is unread, and their level stays (M1)", async () => {
  const { t, teamId, ana, ben, channelId } = await launch();
  const question = await ben.as.mutation(api.messages.post, { teamId, channelId, body: "question for later" });
  await ben.as.mutation(api.channels.setNotify, { teamId, channelId, level: "all" });
  await ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ben.memberId });
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "answer", replyTo: question });
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: `<@${ben.memberId}> while you were out` });
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "@everyone", mentionEveryone: true });
  await settleScheduled(t);

  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [ben.memberId] });
  expect((await ben.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)).toMatchObject({ unread: 0, mentions: 0, notify: "all" });
  expect(await ben.as.query(api.messages.addressed, { teamId })).toEqual([]);
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: `<@${ben.memberId}> welcome back` });
  expect((await ben.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)).toMatchObject({ unread: 1, mentions: 1 });
});

test("an agent's entries about a private message stay private after the message is deleted (M3)", async () => {
  const { t, teamId, julio, ana, channelId } = await launch();
  const helper = await addAgent(t, teamId, ana, "Helper", ["room.read", "messages.post"]);
  const helperId = (await ana.as.query(api.teams.members, { teamId })).find((m) => m.name === "Helper")!.memberId;
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [helperId] });
  const posted = await callAsAgent(t, helper.key, "messages.post", { channelId, body: "draft" });
  const messageId = posted.result as string;
  expect(await callAsAgent(t, helper.key, "messages.react", { messageId, emoji: "👀" })).toMatchObject({ ok: true });
  expect(await callAsAgent(t, helper.key, "messages.edit", { messageId, body: "final" })).toMatchObject({ ok: true });
  expect(await callAsAgent(t, helper.key, "messages.delete", { messageId })).toMatchObject({ ok: true });

  const outside = await julio.as.query(api.activity.list, { teamId });
  expect(outside.filter((e) => e.actor.name === "Helper")).toEqual([]);
  const inside = await ana.as.query(api.activity.list, { teamId });
  expect(inside.filter((e) => e.actor.name === "Helper").map((e) => e.action).sort()).toEqual(
    ["api.messages.delete", "api.messages.edit", "api.messages.post", "api.messages.react"],
  );
});

const STUDIO = { spaceRef: "local:studio", name: "studio", os: "linux", kind: "container" };

/** #launch's task, owned by Ben, and a Space on Ben's machine shared for it at open access. */
async function privateSpace() {
  const room = await launch();
  const { t, teamId, ana, ben, channelId } = room;
  const { callId, participationId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
  await ana.as.mutation(api.calls.leave, { teamId, participationId });
  const [proposalId] = await ana.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Check the launch build" }] });
  const taskId = await ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: proposalId!, projectId: null, ownerId: ben.memberId });
  const { machineId, token } = await linkMachine(t, teamId, ben, "ben-mbp");
  await ben.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  await bridgeSays(t, token, { type: "spaces_found", spaces: [STUDIO] });
  const spaceId = (await ben.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "open", taskId })) as Id<"spaces">;
  await bridgeSays(t, token, { type: "space_shared", spaceId, access: "open", gateway: ["http://100.101.102.103:3219"] });
  return { ...room, taskId, machineId, token, spaceId };
}

test("a Space action's result is the private channel's: someone who left gets not_found for it (H1)", async () => {
  const { t, teamId, julio, ana, channelId, token, spaceId } = await privateSpace();
  await ana.as.mutation(api.spaces.takeWheel, { teamId, spaceId });
  const actionId = await ana.as.mutation(api.spaces.act, { teamId, spaceId, action: { kind: "screenshot" } });
  const screenshot = { image: "c2VjcmV0", format: "jpeg", width: 1280, height: 800, screenshotId: "shot-1" };
  await bridgeSays(t, token, { type: "space_action_result", spaceId, actionId, ok: true, screenshot });
  expect(await ana.as.query(api.spaces.action, { teamId, actionId })).toMatchObject({ status: "done", screenshot });

  await ana.as.mutation(api.channels.leave, { teamId, channelId });
  for (const outside of [ana, julio]) {
    await expect(outside.as.query(api.spaces.action, { teamId, actionId })).rejects.toThrow(/Not found in this team/);
  }
});

test("leaving a private channel closes your views of its Spaces, though you don't drive (H3)", async () => {
  const { t, teamId, ana, channelId, token, spaceId } = await privateSpace();
  const viewId = await ana.as.mutation(api.spaces.openView, { teamId, spaceId });
  await ana.as.mutation(api.channels.leave, { teamId, channelId });
  expect((await bridgeInbox(t, token)).filter((m: { type: string }) => m.type === "close_space_view")).toEqual([
    { v: 1, type: "close_space_view", spaceId, viewId },
  ]);
  expect((await t.run((ctx) => ctx.db.get(viewId as Id<"spaceViews">)))!.status).toBe("closed");
});

test("a machine run's title from its bridge stays with the private channel (H2)", async () => {
  const { t, teamId, julio, ben, taskId, machineId, token } = { ...(await privateTaskRun()) };
  const { runId } = await ben.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", prompt: "Rotate key K-123" });
  // T3 Code names a thread by its prompt's first line, and the bridge reports that title.
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: runId }, state: "working", title: "Rotate key K-123" });
  expect(await ben.as.query(api.runs.get, { teamId, runId })).toMatchObject({ title: "Rotate key K-123" });
  expect(await julio.as.query(api.runs.get, { teamId, runId })).toMatchObject({ title: "A run from a private channel", private: true });
  for (const view of [
    await julio.as.query(api.tasks.get, { teamId, taskId }),
    await julio.as.query(api.tasks.board, { teamId }),
    await julio.as.query(api.inbox.get, { teamId, view: "team" }),
  ]) {
    expect(JSON.stringify(view)).not.toContain("K-123");
  }
});

test("audit entries about a private channel's Spaces stay with the channel (M3)", async () => {
  const { t, teamId, julio, ana, ben, spaceId } = await privateSpace();
  const { key } = await addAgent(t, teamId, ana, "Pilot", ["room.read", "spaces.drive"]);
  const pilotId = (await ana.as.query(api.teams.members, { teamId })).find((m) => m.name === "Pilot")!.memberId;
  const channelId = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.kind === "private")!.channelId;
  await ana.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [pilotId] });
  await ben.as.mutation(api.spaces.passWheel, { teamId, spaceId, to: pilotId });
  expect(await callAsAgent(t, key, "spaces.act", { spaceId, action: { kind: "screenshot" } })).toMatchObject({ ok: true });

  const outside = await julio.as.query(api.activity.list, { teamId });
  expect(outside.filter((e) => e.target === spaceId || JSON.stringify(e.details ?? {}).includes(spaceId))).toEqual([]);
  const inside = await ana.as.query(api.activity.list, { teamId });
  expect(inside.map((e) => e.action)).toEqual(expect.arrayContaining(["space.shared", "api.spaces.act"]));
  const stored = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(stored.filter((e) => e.action === "space.shared" || e.action === "api.spaces.act").map((e) => e.channelId)).toEqual([channelId, channelId]);
});

test("a run from a private channel is listed without its titles to the team, and only the channel's members can message it (ADR 0026)", async () => {
  const { t, teamId, julio, ana, ben, cy, channelId, runId } = await privateTaskRun();
  const [general] = (await julio.as.query(api.channels.list, { teamId })).filter((c) => c.kind === "channel");

  const [outside] = await cy.as.query(api.runs.live, { teamId });
  expect(outside).toMatchObject({ runId, label: "Claude Code (Ben)", private: true, title: "A run from a private channel", hearsYou: false });
  expect(outside!.task).toMatchObject({ title: "A task from a private channel" });
  expect(JSON.stringify(outside)).not.toContain("launch page");
  const [inside] = await ana.as.query(api.runs.live, { teamId });
  expect(inside).toMatchObject({ private: false, hearsYou: true, task: { title: "Ship the launch page" } });

  // Someone outside the channel can't address it: a token stays text, a passed run is refused.
  const fromCy = await cy.as.mutation(api.messages.post, { teamId, channelId: general!.channelId, body: `<@run:${runId}> hi` });
  expect((await cy.as.query(api.messages.get, { teamId, messageId: fromCy }))!.addressedRuns).toEqual([]);
  await expect(
    cy.as.mutation(api.messages.post, { teamId, channelId: general!.channelId, body: "hi", addressedRuns: [runId] }),
  ).rejects.toThrow(/private conversation you aren't in/);
  // A member addresses it in a team channel, and in the private channel itself.
  const fromAna = await ana.as.mutation(api.messages.post, { teamId, channelId: general!.channelId, body: `<@run:${runId}> hi` });
  expect((await ana.as.query(api.messages.get, { teamId, messageId: fromAna }))!.addressedRuns).toEqual([{ runId, label: "Claude Code (Ben)" }]);
  const inChannel = await ana.as.mutation(api.messages.post, { teamId, channelId, body: "status?", addressedRuns: [runId] });
  expect((await ana.as.query(api.messages.get, { teamId, messageId: inChannel }))!.addressedRuns).toHaveLength(1);

  // In a private channel, a run whose driver isn't a member can't be addressed: its messages would leave it.
  const { machineId } = await linkMachine(t, teamId, julio, "julio-mbp");
  const { runId: julios } = await julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId });
  const leak = await ben.as.mutation(api.messages.post, { teamId, channelId, body: `<@run:${julios}> look at this` });
  expect((await ben.as.query(api.messages.get, { teamId, messageId: leak }))!.addressedRuns).toEqual([]);
  await expect(ben.as.mutation(api.messages.post, { teamId, channelId, body: "look", addressedRuns: [julios] })).rejects.toThrow(
    /Julio, isn't in #launch/,
  );
});
