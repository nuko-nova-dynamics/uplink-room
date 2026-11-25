/**
 * Chat that can replace Discord (spec #63): editing, deleting, reactions, mentions of people and
 * @everyone, pins, unread counts and scrollback, driven through the Room API.
 */
import { expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { FANOUT_BATCH } from "../convex/messages";
import { ensureRead, readSummary, setReadRangeLimitForTests } from "../convex/lib/reads";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, linkMachine, newRoom, newTeam, type Person, present, settleScheduled } from "./setup";

/** Julio (admin), Ana and Ben, and #general. */
async function team() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  return { t, teamId, julio, julioId, ana, ben, general: general!.channelId };
}

async function say(person: Person, teamId: Id<"teams">, channelId: Id<"channels">, body: string, extra = {}) {
  return person.as.mutation(api.messages.post, { teamId, channelId, body, ...extra });
}

async function get(person: Person, teamId: Id<"teams">, messageId: Id<"messages">) {
  return present(await person.as.query(api.messages.get, { teamId, messageId }));
}

async function counts(person: Person, teamId: Id<"teams">, channelId: Id<"channels">) {
  const row = (await person.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)!;
  return { unread: row.unread, mentions: row.mentions };
}

test("editing changes the body and marks it edited; only its author can edit, and an admin can delete but not edit", async () => {
  const { teamId, julio, ana, ben, general } = await team();
  const messageId = await say(ana, teamId, general, "Deploy is at 5");

  await ana.as.mutation(api.messages.edit, { teamId, messageId, body: "Deploy is at 6" });
  const edited = await get(ben, teamId, messageId);
  expect(edited).toMatchObject({ body: "Deploy is at 6" });
  expect(edited.editedAt).toEqual(expect.any(Number));

  await expect(ben.as.mutation(api.messages.edit, { teamId, messageId, body: "nope" })).rejects.toThrow(/Only its author/);
  await expect(julio.as.mutation(api.messages.edit, { teamId, messageId, body: "nope" })).rejects.toThrow(/Only its author/);
  await expect(ben.as.mutation(api.messages.delete, { teamId, messageId })).rejects.toThrow(/Only its author/);

  await julio.as.mutation(api.messages.delete, { teamId, messageId });
  expect(await ana.as.query(api.messages.get, { teamId, messageId })).toBeNull();
});

test("an agent edits and deletes its own messages, and the person who added it can delete them", async () => {
  const { t, teamId, ana, general } = await team();
  const { key } = await addAgent(t, teamId, ana, "Deploy bot", ["room.read", "messages.post"]);
  const posted = await callAsAgent(t, key, "messages.post", { channelId: general, body: "Deploying 0.4.2" });
  const messageId = posted.result as Id<"messages">;
  expect(await callAsAgent(t, key, "messages.edit", { messageId, body: "Deployed 0.4.2" })).toMatchObject({ ok: true });
  expect(await get(ana, teamId, messageId)).toMatchObject({ body: "Deployed 0.4.2", editedAt: expect.any(Number) });
  await ana.as.mutation(api.messages.delete, { teamId, messageId });
  const again = await callAsAgent(t, key, "messages.post", { channelId: general, body: "Rolled back" });
  expect(await callAsAgent(t, key, "messages.delete", { messageId: again.result })).toMatchObject({ ok: true });
});

test("deleting a message with replies leaves a deleted line and its replies; without replies it is gone", async () => {
  const { teamId, ana, ben, general } = await team();
  const parent = await say(ana, teamId, general, "Who has the staging keys?");
  await ben.as.mutation(api.messages.react, { teamId, messageId: parent, emoji: "👀" });
  const reply = await say(ben, teamId, general, "I do", { replyTo: parent });

  await ana.as.mutation(api.messages.delete, { teamId, messageId: parent });
  const page = await ben.as.query(api.messages.list, { teamId, channelId: general, cursor: null });
  expect(Array.isArray(page)).toBe(false);
  const placeholder = (page as { page: { messageId: string }[] }).page.find((m) => m.messageId === parent);
  expect(placeholder).toMatchObject({ body: "", deletedAt: expect.any(Number), reactions: [], attachments: [], replyCount: 1 });
  expect(await ben.as.query(api.messages.replies, { teamId, messageId: parent })).toMatchObject([{ messageId: reply, body: "I do" }]);
  await expect(ben.as.mutation(api.messages.edit, { teamId, messageId: parent, body: "x" })).rejects.toThrow(/was deleted/);

  // The last reply goes, and the deleted line with it.
  await ben.as.mutation(api.messages.delete, { teamId, messageId: reply });
  expect(await ana.as.query(api.messages.get, { teamId, messageId: parent })).toBeNull();
});

test("a reaction toggles and counts per emoji with who reacted; a 21st emoji and a non-emoji are refused", async () => {
  const { t, teamId, julio, ana, ben, general } = await team();
  const messageId = await say(ana, teamId, general, "Ship it?");
  await julio.as.mutation(api.messages.react, { teamId, messageId, emoji: "👍" });
  await ben.as.mutation(api.messages.react, { teamId, messageId, emoji: "👍" });
  await ben.as.mutation(api.messages.react, { teamId, messageId, emoji: "👍" });
  await ben.as.mutation(api.messages.react, { teamId, messageId, emoji: "👩‍💻" });

  expect((await get(ben, teamId, messageId)).reactions).toEqual([
    { emoji: "👍", count: 2, mine: true, names: ["Julio", "Ben"] },
    { emoji: "👩‍💻", count: 1, mine: true, names: ["Ben"] },
  ]);
  await ben.as.mutation(api.messages.unreact, { teamId, messageId, emoji: "👍" });
  await ben.as.mutation(api.messages.unreact, { teamId, messageId, emoji: "👩‍💻" });
  expect((await get(ben, teamId, messageId)).reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["Julio"] }]);

  for (const emoji of ["x", "ok", "👍👍", "<b>", ""]) {
    await expect(ana.as.mutation(api.messages.react, { teamId, messageId, emoji })).rejects.toThrow(/one emoji/);
  }
  const many = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "😘", "🥰", "😗", "😙", "🥲", "🙂"];
  for (const emoji of many) await ana.as.mutation(api.messages.react, { teamId, messageId, emoji });
  expect((await get(ana, teamId, messageId)).reactions).toHaveLength(20);
  await expect(ana.as.mutation(api.messages.react, { teamId, messageId, emoji: "🤗" })).rejects.toThrow(/at most 20/);
  // An emoji already there still takes another reaction.
  await ben.as.mutation(api.messages.react, { teamId, messageId, emoji: "😀" });

  const { key } = await addAgent(t, teamId, ana, "Deploy bot", ["room.read", "messages.post"]);
  expect(await callAsAgent(t, key, "messages.react", { messageId, emoji: "✅" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/at most 20/) } });
  expect(await callAsAgent(t, key, "messages.react", { messageId, emoji: "👍" })).toMatchObject({ ok: true });
});

test("a person mention is stored and counts in their mentions; mentionedAgents still works", async () => {
  const { t, teamId, julio, ana, ben, general } = await team();
  const anaId = ana.memberId;
  const messageId = await say(julio, teamId, general, `<@${anaId}> can you look at the deploy?`);
  const view = await get(ana, teamId, messageId);
  expect(view).toMatchObject({ mentionedMembers: [anaId], mentionsMe: true });
  expect((await get(ben, teamId, messageId)).mentionsMe).toBe(false);
  expect(await counts(ana, teamId, general)).toEqual({ unread: 1, mentions: 1 });
  expect(await counts(ben, teamId, general)).toEqual({ unread: 1, mentions: 0 });

  // An agent mentions a person by id; the older mentionedAgents field still names agents.
  const { key } = await addAgent(t, teamId, julio, "Deploy bot", ["room.read", "messages.post"]);
  const botId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Deploy bot")!.memberId;
  await callAsAgent(t, key, "messages.post", { channelId: general, body: "Deploy failed", mentionedMembers: [ben.memberId] });
  expect(await counts(ben, teamId, general)).toEqual({ unread: 2, mentions: 1 });
  const legacy = await say(ana, teamId, general, "bot, retry", { mentionedAgents: [botId] });
  expect(await get(ana, teamId, legacy)).toMatchObject({ mentionedAgents: [botId], mentionedMembers: [botId] });

  // Editing works mentions out again from the body.
  await julio.as.mutation(api.messages.edit, { teamId, messageId, body: `<@${ben.memberId}> can you look at the deploy?` });
  expect(await counts(ana, teamId, general)).toMatchObject({ mentions: 0 });
  expect(await counts(ben, teamId, general)).toMatchObject({ mentions: 2 });
});

test("@everyone counts as a mention for everyone in the channel except those set to none, starts no run, and is refused for an agent key", async () => {
  const { t, teamId, julio, ana, ben, general } = await team();
  await ben.as.mutation(api.channels.setNotify, { teamId, channelId: general, level: "none" });
  const { key } = await addAgent(t, teamId, julio, "Deploy bot", ["room.read", "messages.post", "runs.start"]);

  const messageId = await say(julio, teamId, general, "@everyone release at 5", { mentionEveryone: true });
  await settleScheduled(t);
  expect(await get(ana, teamId, messageId)).toMatchObject({ mentionsEveryone: true, mentionsMe: true, mentionedRuns: [] });
  // Its author isn't addressed by it, so it isn't marked as a message for them.
  expect(await get(julio, teamId, messageId)).toMatchObject({ mentionsEveryone: true, mentionsMe: false });
  expect(await counts(ana, teamId, general)).toEqual({ unread: 1, mentions: 1 });
  expect(await counts(ben, teamId, general)).toEqual({ unread: 1, mentions: 0 });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 0, mentions: 0 });
  expect(await ana.as.query(api.messages.addressed, { teamId })).toMatchObject([{ messageId, reason: "everyone" }]);
  expect(await ben.as.query(api.messages.addressed, { teamId })).toEqual([]);

  const refused = await callAsAgent(t, key, "messages.post", { channelId: general, body: "@everyone", mentionEveryone: true });
  expect(refused).toMatchObject({ status: 403, error: { code: "forbidden" } });
});

test("pinning posts a line and lists pins newest first; a 51st pin is refused; only the pinner or an admin unpins; deleting unpins", async () => {
  const { teamId, julio, ana, ben, general } = await team();
  const first = await say(ana, teamId, general, "Staging password is in 1Password");
  const second = await say(ana, teamId, general, "Release notes: v0.4");
  await ana.as.mutation(api.messages.pin, { teamId, messageId: first });
  await ben.as.mutation(api.messages.pin, { teamId, messageId: second });

  const pins = await julio.as.query(api.channels.pins, { teamId, channelId: general });
  expect(pins.map((p) => [p.messageId, p.pinned?.by.name])).toEqual([
    [second, "Ben"],
    [first, "Ana"],
  ]);
  const page = (await julio.as.query(api.messages.list, { teamId, channelId: general, cursor: null })) as {
    page: { system?: { kind: string; messageId: string }; author: { name: string } }[];
  };
  expect(page.page.filter((m) => m.system).map((m) => [m.author.name, m.system!.messageId])).toEqual([
    ["Ben", second],
    ["Ana", first],
  ]);
  // System lines don't count as unread.
  expect(await counts(julio, teamId, general)).toMatchObject({ unread: 2 });

  await expect(ana.as.mutation(api.messages.unpin, { teamId, messageId: second })).rejects.toThrow(/Only whoever pinned/);
  await julio.as.mutation(api.messages.unpin, { teamId, messageId: second });
  await ana.as.mutation(api.messages.delete, { teamId, messageId: first });
  expect(await julio.as.query(api.channels.pins, { teamId, channelId: general })).toEqual([]);

  for (let i = 0; i < 50; i++) {
    const id = await say(ana, teamId, general, `note ${i}`);
    await ana.as.mutation(api.messages.pin, { teamId, messageId: id });
  }
  const extra = await say(ana, teamId, general, "one too many");
  await expect(ana.as.mutation(api.messages.pin, { teamId, messageId: extra })).rejects.toThrow(/at most 50/);
});

test("unread and mention counts move with new messages, reset with markRead, and stay right across many messages", async () => {
  const { teamId, julio, julioId, ana, general } = await team();
  const ids: Id<"messages">[] = [];
  for (let i = 1; i <= 150; i++) {
    ids.push(await say(ana, teamId, general, i % 50 === 0 ? `<@${julioId}> check ${i}` : `message ${i}`));
  }
  expect(await counts(julio, teamId, general)).toEqual({ unread: 150, mentions: 3 });
  // Ana posted them all, so she has read them.
  expect(await counts(ana, teamId, general)).toEqual({ unread: 0, mentions: 0 });

  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[99]! });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 50, mentions: 1 });
  // Read state never moves back.
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[9]! });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 50, mentions: 1 });

  // A deleted unread message no longer counts.
  await ana.as.mutation(api.messages.delete, { teamId, messageId: ids[149]! });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 49, mentions: 0 });

  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 0, mentions: 0 });
  await say(ana, teamId, general, "one more");
  expect(await counts(julio, teamId, general)).toEqual({ unread: 1, mentions: 0 });
  // Posting reads the channel up to your own message.
  await say(julio, teamId, general, "caught up");
  expect(await counts(julio, teamId, general)).toEqual({ unread: 0, mentions: 0 });
});

test("someone who joins later starts with what was posted before them read", async () => {
  const { t, teamId, julio, ana, general } = await team();
  await say(ana, teamId, general, "before Cleo");
  const cleo = await addTeammate(t, teamId, julio, "Cleo");
  expect(await counts(cleo, teamId, general)).toEqual({ unread: 0, mentions: 0 });
  await say(ana, teamId, general, "after Cleo");
  expect(await counts(cleo, teamId, general)).toEqual({ unread: 1, mentions: 0 });
});

test("messages.list pages back to the first message, and messages.around returns the page around a message", async () => {
  const { teamId, julio, ana, general } = await team();
  const ids: Id<"messages">[] = [];
  for (let i = 1; i <= 120; i++) ids.push(await say(ana, teamId, general, `m${i}`));
  const reply = await say(julio, teamId, general, "reply to m60", { replyTo: ids[59]! });

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 10; pages++) {
    const result = (await julio.as.query(api.messages.list, { teamId, channelId: general, cursor, limit: 50 })) as {
      page: { body: string }[];
      continueCursor: string;
      isDone: boolean;
    };
    seen.push(...result.page.map((m) => m.body));
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(seen).toHaveLength(120);
  expect(seen[0]).toBe("m120");
  expect(seen.at(-1)).toBe("m1");

  // Older callers, without a cursor, still get the newest messages oldest first.
  const legacy = await julio.as.query(api.messages.list, { teamId, channelId: general, limit: 3 });
  expect((legacy as { body: string }[]).map((m) => m.body)).toEqual(["m118", "m119", "m120"]);

  const around = present(await julio.as.query(api.messages.around, { teamId, messageId: ids[59]!, limit: 5 }));
  expect(around.messages.map((m) => m.body)).toEqual(["m55", "m56", "m57", "m58", "m59", "m60", "m61", "m62", "m63", "m64", "m65"]);
  expect(around).toMatchObject({ anchorId: ids[59], targetId: ids[59], hasOlder: true, hasNewer: true });
  const atStart = present(await julio.as.query(api.messages.around, { teamId, messageId: ids[1]!, limit: 5 }));
  expect(atStart).toMatchObject({ hasOlder: false, hasNewer: true });
  expect(atStart.messages[0]!.body).toBe("m1");
  // A reply opens around the message it answers.
  expect(await julio.as.query(api.messages.around, { teamId, messageId: reply, limit: 1 })).toMatchObject({
    anchorId: ids[59],
    targetId: reply,
  });
});

test("unread and mention counts stay exact past hundreds of deletions and mentions", async () => {
  const { t, teamId, julio, julioId, ana, ben, general } = await team();
  const ids: Id<"messages">[] = [];
  for (let i = 1; i <= 250; i++) ids.push(await say(ana, teamId, general, `<@${julioId}> item ${i}`));
  // Ben read the first 100 before the deletions.
  await ben.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[99]! });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 250, mentions: 250 });

  for (const id of ids.slice(0, 220)) await ana.as.mutation(api.messages.delete, { teamId, messageId: id });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 30, mentions: 30 });
  expect(await counts(ben, teamId, general)).toEqual({ unread: 30, mentions: 0 });

  // Part of the way, then all of it.
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[239]! });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 10, mentions: 10 });
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 0, mentions: 0 });
  expect(t).toBeTruthy();
});

test("a partial markRead across more rows than one step counts goes on in scheduled steps and ends exact", async () => {
  const { t, teamId, julio, julioId, ana, general } = await team();
  const ids: Id<"messages">[] = [];
  for (let i = 1; i <= 40; i++) ids.push(await say(ana, teamId, general, i % 2 ? `<@${julioId}> odd ${i}` : `even ${i}`));
  for (const id of ids.slice(1, 30).filter((_, i) => i % 2 === 0)) await ana.as.mutation(api.messages.delete, { teamId, messageId: id });
  const before = await counts(julio, teamId, general);
  setReadRangeLimitForTests(4);
  try {
    const { readSeq } = await julio.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[34]! });
    expect(readSeq).toBeLessThan(35);
    await settleScheduled(t);
  } finally {
    setReadRangeLimitForTests(undefined);
  }
  // Messages 36 to 40 are left: 36, 38 and 40 are plain, 37 and 39 mention Julio.
  expect(before).toEqual({ unread: 25, mentions: 20 });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 5, mentions: 2 });
});

test("a pin line before anything else doesn't make history before someone joined count as unread", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const first = await say(ana, teamId, general, "before Dana");
  await say(ana, teamId, general, "also before Dana");
  // Dana is a member from before read rows were made when membership begins: she has none.
  const dana = await t.run(async (ctx) => ctx.db.insert("members", { teamId, kind: "person", name: "Dana", role: "member" }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await julio.as.mutation(api.messages.pin, { teamId, messageId: first });
  const unreadOf = () =>
    t.run(async (ctx) => {
      const channel = (await ctx.db.get(general))!;
      return (await readSummary(ctx, channel, dana)).unread;
    });
  expect(await unreadOf()).toBe(0);
  await say(ana, teamId, general, "after Dana");
  expect(await unreadOf()).toBe(1);
});

test("@everyone in a channel bigger than one fan-out step reaches everyone, after the post commits", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const extra = await t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i < FANOUT_BATCH + 30; i++) {
      ids.push(await ctx.db.insert("members", { teamId, kind: "person", name: `Member ${i}`, role: "member" }));
    }
    return ids;
  });
  const messageId = await say(julio, teamId, general, "@everyone all hands at 3", { mentionEveryone: true });
  await settleScheduled(t);
  const reached = await t.run(async (ctx) => {
    const channel = (await ctx.db.get(general))!;
    const mentions = await ctx.db.query("mentions").withIndex("by_message_member", (q) => q.eq("messageId", messageId)).collect();
    const alerts = await ctx.db.query("messageAlerts").withIndex("by_message_member", (q) => q.eq("messageId", messageId)).collect();
    const sample = await Promise.all([extra[0]!, extra.at(-1)!].map((id) => readSummary(ctx, channel, id)));
    const steps = (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.includes("fanOut")).length;
    return { mentions: mentions.length, alerts: alerts.length, sample: sample.map((s) => s.mentions), steps };
  });
  // The extra members, Ana and Ben; not Julio, who wrote it.
  expect(reached).toMatchObject({ mentions: FANOUT_BATCH + 32, alerts: FANOUT_BATCH + 32, sample: [1, 1] });
  expect(reached.steps).toBeGreaterThanOrEqual(2);
  expect(await counts(ana, teamId, general)).toEqual({ unread: 1, mentions: 1 });
});

test("an @everyone alert a later fan-out step delivers comes after a direct message that reached the member first", async () => {
  const { t, teamId, julio, ana, general } = await team();
  await t.run(async (ctx) => {
    for (let i = 0; i < FANOUT_BATCH + 30; i++) {
      await ctx.db.insert("members", { teamId, kind: "person", name: `Member ${i}`, role: "member" });
    }
  });
  // Cleo joins last, so @everyone reaches her in its second step.
  const cleo = await addTeammate(t, teamId, julio, "Cleo");
  await say(julio, teamId, general, "@everyone all hands at 3", { mentionEveryone: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.finishInProgressScheduledFunctions();
  expect(await cleo.as.query(api.messages.addressed, { teamId })).toEqual([]);

  // Between the steps, Ana writes to Cleo directly: that alert reaches her first.
  const dm = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [cleo.memberId] })).channelId;
  await say(ana, teamId, dm, "quick one before the all hands");
  const [direct] = await cleo.as.query(api.messages.addressed, { teamId });
  await settleScheduled(t);

  // Newest first by delivery: the @everyone, though posted earlier, reached her last.
  const list = await cleo.as.query(api.messages.addressed, { teamId });
  expect(list.map((a) => a.reason)).toEqual(["everyone", "direct"]);
  expect(list[0]!.seq).toBeGreaterThan(direct!.seq);
  expect(list[0]!.at).toBeGreaterThanOrEqual(direct!.at);
  // So the app, which has seen the direct message, still finds the @everyone after it.
  expect((await cleo.as.query(api.messages.addressed, { teamId, after: direct!.seq })).map((a) => a.reason)).toEqual(["everyone"]);
});

test("a reply seen in its thread stops counting as a mention without marking the channel's unseen messages read", async () => {
  const { teamId, julio, ana, general } = await team();
  const parent = await say(ana, teamId, general, "Can someone check the deploy?");
  await ana.as.mutation(api.channels.markRead, { teamId, channelId: general });
  // Julio answers in the thread, mentioning Ana, after two messages Ana hasn't seen.
  await say(julio, teamId, general, "unrelated one");
  await say(julio, teamId, general, "unrelated two");
  const reply = await say(julio, teamId, general, `<@${ana.memberId}> done`, { replyTo: parent });
  expect(await counts(ana, teamId, general)).toEqual({ unread: 3, mentions: 1 });

  await ana.as.mutation(api.channels.markSeen, { teamId, channelId: general, messageIds: [reply] });
  // The mention is gone; the two messages she hasn't seen, and the reply, stay unread.
  expect(await counts(ana, teamId, general)).toEqual({ unread: 3, mentions: 0 });
  // Reading the channel later leaves the count at zero, not below.
  await ana.as.mutation(api.channels.markRead, { teamId, channelId: general });
  expect(await counts(ana, teamId, general)).toEqual({ unread: 0, mentions: 0 });
});

test("with after, addressed returns what reached you since, oldest first, a page at a time, so a backlog bigger than a page is all there", async () => {
  const { teamId, julio, ana, general } = await team();
  const [seen] = await ana.as.query(api.messages.addressed, { teamId });
  expect(seen).toBeUndefined();
  // Ana was away while 120 mentions came in.
  const posted = [];
  for (let i = 0; i < 120; i++) posted.push(await say(julio, teamId, general, `<@${ana.memberId}> item ${i}`));
  const drained: string[] = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const batch = await ana.as.query(api.messages.addressed, { teamId, after, limit: 50 });
    if (batch.length === 0) break;
    expect(batch.length).toBeLessThanOrEqual(50);
    // Oldest first within each page.
    expect(batch.map((a) => a.seq)).toEqual([...batch.map((a) => a.seq)].sort((x, y) => x - y));
    drained.push(...batch.map((a) => a.messageId));
    after = batch.at(-1)!.seq;
  }
  expect(drained).toEqual(posted);
  // Without after it is still the newest, newest first.
  expect((await ana.as.query(api.messages.addressed, { teamId, limit: 2 })).map((a) => a.messageId)).toEqual([posted[119], posted[118]]);
});

test("@everyone edited away between fan-out steps reaches no one after that, and members set to all still get their alert", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const extra = await t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i < FANOUT_BATCH + 30; i++) {
      ids.push(await ctx.db.insert("members", { teamId, kind: "person", name: `Member ${i}`, role: "member" }));
    }
    // The last one, in the second step, set #general to all.
    const row = await ensureRead(ctx, (await ctx.db.get(general))!, ids.at(-1)!);
    await ctx.db.patch(row._id, { notify: "all" });
    return ids;
  });
  const messageId = await say(julio, teamId, general, "@everyone all hands at 3", { mentionEveryone: true });
  const addressed = () =>
    t.run(async (ctx) => ({
      mentions: (await ctx.db.query("mentions").withIndex("by_message_member", (q) => q.eq("messageId", messageId)).collect()).length,
      alerts: await ctx.db.query("messageAlerts").withIndex("by_message_member", (q) => q.eq("messageId", messageId)).collect(),
    }));

  // Only the first step runs before the edit.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.finishInProgressScheduledFunctions();
  expect((await addressed()).mentions).toBeGreaterThan(0);
  await julio.as.mutation(api.messages.edit, { teamId, messageId, body: "all hands at 3" });
  await settleScheduled(t);

  const after = await addressed();
  expect(after.mentions).toBe(0);
  const secondStep = new Set<string>(extra.slice(FANOUT_BATCH - 3));
  expect(after.alerts.filter((a) => secondStep.has(a.memberId)).map((a) => [a.memberId, a.reason])).toEqual([[extra.at(-1), "all"]]);
  expect(await counts(ana, teamId, general)).toEqual({ unread: 1, mentions: 0 });
});

test("a name edited out of a message that keeps @everyone stops counting for a member set to none, and @everyone keeps counting for the rest (#70)", async () => {
  const { t, teamId, julio, ana, ben, general } = await team();
  await ben.as.mutation(api.channels.setNotify, { teamId, channelId: general, level: "none" });
  const messageId = await say(julio, teamId, general, `@everyone <@${ben.memberId}> <@${ana.memberId}> release at 5`, { mentionEveryone: true });
  await settleScheduled(t);
  expect(await counts(ben, teamId, general)).toEqual({ unread: 1, mentions: 1 });
  expect(await counts(ana, teamId, general)).toEqual({ unread: 1, mentions: 1 });

  await julio.as.mutation(api.messages.edit, { teamId, messageId, body: "@everyone release at 5" });
  // Ben's mention came only from his name; @everyone doesn't count for him. Ana is still in @everyone.
  expect(await counts(ben, teamId, general)).toEqual({ unread: 1, mentions: 0 });
  expect(await counts(ana, teamId, general)).toEqual({ unread: 1, mentions: 1 });
  expect(await get(ana, teamId, messageId)).toMatchObject({ mentionsEveryone: true, mentionsMe: true });
});

test("a message's view says where its newest reply sits, so the app can show a thread with a reply you haven't read", async () => {
  const { teamId, ana, ben, general } = await team();
  const parent = await say(ana, teamId, general, "Who has the release notes?");
  expect((await get(ben, teamId, parent)).lastReplySeq).toBeUndefined();
  await say(ben, teamId, general, "I do", { replyTo: parent });
  const last = await say(ana, teamId, general, "Thanks", { replyTo: parent });
  const view = await get(ben, teamId, parent);
  expect(view).toMatchObject({ replyCount: 2, lastReplySeq: (await get(ben, teamId, last)).seq });
  // Ben read up to his own reply; Ana's came after it, so it's past his read point.
  const row = (await ben.as.query(api.channels.list, { teamId })).find((c) => c.channelId === general)!;
  expect(view.lastReplySeq!).toBeGreaterThan(row.readSeq);
});

test("mark unread moves the read point back to just before a message, with exact counts, and never marks a seen mention unseen", async () => {
  const { teamId, julio, julioId, ana, general } = await team();
  await say(ana, teamId, general, "one");
  const two = await say(ana, teamId, general, `two, <@${julioId}>`);
  const three = await say(ana, teamId, general, "three");
  await say(ana, teamId, general, "four");
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 0, mentions: 0 });

  // From "two": two, three and four are unread again, and the mention in two counts again.
  const { readSeq } = await julio.as.mutation(api.channels.markUnread, { teamId, channelId: general, from: two });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 3, mentions: 1 });
  expect(readSeq).toBe((await get(julio, teamId, two)).seq! - 1);

  // A deleted message in the stretch doesn't count; reading again clears everything.
  await ana.as.mutation(api.messages.delete, { teamId, messageId: three });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 2, mentions: 1 });
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 0, mentions: 0 });

  // A mention seen in its thread (markSeen) stays seen after marking unread.
  await julio.as.mutation(api.channels.markSeen, { teamId, channelId: general, messageIds: [two] });
  await julio.as.mutation(api.channels.markUnread, { teamId, channelId: general, from: two });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 2, mentions: 0 });

  // Marking unread from a message you haven't read yet changes nothing.
  await julio.as.mutation(api.channels.markUnread, { teamId, channelId: general, from: two });
  expect(await counts(julio, teamId, general)).toEqual({ unread: 2, mentions: 0 });
});

test("typing shows who is writing, where, until they post or stop, and never yourself", async () => {
  const { t, teamId, julio, ana, ben, general } = await team();
  const parent = await say(ben, teamId, general, "Chart v2 is up");
  await ana.as.mutation(api.channels.typing, { teamId, channelId: general });
  await ben.as.mutation(api.channels.typing, { teamId, channelId: general, replyTo: parent });
  const seen = await julio.as.query(api.channels.whoIsTyping, { teamId, channelId: general });
  expect(seen.map((r) => [r.member.name, r.replyTo ?? null]).sort()).toEqual([
    ["Ana", null],
    ["Ben", parent],
  ]);
  expect((await ana.as.query(api.channels.whoIsTyping, { teamId, channelId: general })).map((r) => r.member.name)).toEqual(["Ben"]);

  // Posting ends Ana's; stop ends Ben's.
  await say(ana, teamId, general, "Looks good");
  await ben.as.mutation(api.channels.typing, { teamId, channelId: general, stop: true });
  expect(await julio.as.query(api.channels.whoIsTyping, { teamId, channelId: general })).toEqual([]);

  // An agent can say it's writing too.
  const { key } = await addAgent(t, teamId, ana, "Hermes", ["room.read", "messages.post"]);
  expect(await callAsAgent(t, key, "channels.typing", { channelId: general })).toMatchObject({ ok: true });
  expect((await julio.as.query(api.channels.whoIsTyping, { teamId, channelId: general })).map((r) => r.member.name)).toEqual(["Hermes"]);
});

test("presence lists when each member last had the app open and whether they were using it", async () => {
  const { teamId, julio, ana } = await team();
  await ana.as.mutation(api.members.heartbeat, { teamId, active: true });
  await julio.as.mutation(api.members.heartbeat, { teamId, active: false });
  const rows = await julio.as.query(api.members.presence, { teamId });
  const members = await julio.as.query(api.teams.members, { teamId });
  const byName = Object.fromEntries(rows.map((r) => [members.find((m) => m.memberId === r.memberId)!.name, r.active]));
  expect(byName).toEqual({ Ana: true, Julio: false });
  expect(rows.every((r) => typeof r.lastSeenAt === "number")).toBe(true);
  // Going idle is written at once, not after the next minute's beat.
  await ana.as.mutation(api.members.heartbeat, { teamId, active: false });
  const after = await julio.as.query(api.members.presence, { teamId });
  expect(after.filter((r) => r.active)).toEqual([]);
});

test("a member sets a custom status on one line, teammates see it in teams.members, and an empty one clears it", async () => {
  const { teamId, julio, ana } = await team();
  const statusOf = async (name: string) => (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === name)!.status;
  await ana.as.mutation(api.members.setStatus, { teamId, text: "  Reviewing\n PRs " });
  expect(await statusOf("Ana")).toBe("Reviewing PRs");
  expect(await statusOf("Julio")).toBeUndefined();
  await expect(ana.as.mutation(api.members.setStatus, { teamId, text: "x".repeat(81) })).rejects.toThrow(/at most 80/);
  expect(await statusOf("Ana")).toBe("Reviewing PRs");
  await ana.as.mutation(api.members.setStatus, { teamId, text: " " });
  expect(await statusOf("Ana")).toBeUndefined();
  await ana.as.mutation(api.members.setStatus, { teamId, text: "Back at 3" });
  await ana.as.mutation(api.members.setStatus, { teamId, text: null });
  expect(await statusOf("Ana")).toBeUndefined();
});

test("a message with replies names who replied lately, newest first, up to three", async () => {
  const { teamId, julio, ana, ben, general } = await team();
  const parent = await say(julio, teamId, general, "Release note draft?");
  for (const [who, body] of [[ana, "On it"], [ben, "Add Bayview"], [ana, "Done"], [julio, "Thanks"]] as const) {
    await say(who, teamId, general, body, { replyTo: parent });
  }
  const view = await get(ben, teamId, parent);
  expect(view.repliers.map((m) => m.name)).toEqual(["Julio", "Ana", "Ben"]);
  expect((await get(ben, teamId, (await say(ben, teamId, general, "no replies")) as Id<"messages">)).repliers).toEqual([]);
});

test("who replied lately is kept on the parent, so showing it reads no replies, and a deleted reply drops out (Codex review)", async () => {
  const { t, teamId, julio, ana, ben, general } = await team();
  const parent = await say(julio, teamId, general, "Release note draft?");
  await say(ana, teamId, general, "On it", { replyTo: parent });
  const last = await say(ben, teamId, general, "Add Bayview", { replyTo: parent });
  // Kept on the parent's row, newest first.
  const anaId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Ana")!.memberId;
  const benId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Ben")!.memberId;
  expect(await t.run(async (ctx) => (await ctx.db.get(parent))!.repliers)).toEqual([benId, anaId]);
  expect((await get(julio, teamId, parent)).repliers.map((m) => m.name)).toEqual(["Ben", "Ana"]);
  await ben.as.mutation(api.messages.delete, { teamId, messageId: last });
  expect((await get(julio, teamId, parent)).repliers.map((m) => m.name)).toEqual(["Ana"]);
  // A thread from before it was kept is read, briefly, and kept from its next reply.
  await t.run(async (ctx) => ctx.db.patch(parent, { repliers: undefined }));
  expect((await get(julio, teamId, parent)).repliers.map((m) => m.name)).toEqual(["Ana"]);
  await say(julio, teamId, general, "Thanks", { replyTo: parent });
  expect((await get(julio, teamId, parent)).repliers.map((m) => m.name)).toEqual(["Julio", "Ana"]);
});

test("a reply also sent to the channel shows in the channel's list as that reply, counts once, and leaves with it", async () => {
  const { teamId, julio, ana, ben, general } = await team();
  const parent = await say(ben, teamId, general, "Chart v2 is up");
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general });
  const reply = await say(ana, teamId, general, "Shipping it with the export", { replyTo: parent, alsoInChannel: true });

  const page = await julio.as.query(api.messages.list, { teamId, channelId: general, paginationOpts: { numItems: 10, cursor: null } });
  const shown = (page as { page: { messageId: string; replyTo?: string; threadOf?: { messageId: string; excerpt: string } }[] }).page;
  expect(shown[0]).toMatchObject({ messageId: reply, replyTo: parent, threadOf: { messageId: parent, excerpt: "Chart v2 is up" } });
  // One message, one unread, though it shows in two places.
  expect(await counts(julio, teamId, general)).toEqual({ unread: 1, mentions: 0 });
  // Edits and reactions are the reply's own, wherever it shows.
  await ana.as.mutation(api.messages.edit, { teamId, messageId: reply, body: "Shipping it Thursday" });
  const again = await julio.as.query(api.messages.list, { teamId, channelId: general, paginationOpts: { numItems: 10, cursor: null } });
  expect((again as { page: { body: string }[] }).page[0]!.body).toBe("Shipping it Thursday");

  await ana.as.mutation(api.messages.delete, { teamId, messageId: reply });
  const after = await julio.as.query(api.messages.list, { teamId, channelId: general, paginationOpts: { numItems: 10, cursor: null } });
  expect((after as { page: { messageId: string }[] }).page.map((m) => m.messageId)).toEqual([parent]);
  await expect(say(ana, teamId, general, "no thread", { alsoInChannel: true })).rejects.toThrow(/for a reply/);
});

test("search can list its matches newest first, and pages them", async () => {
  const { teamId, julio, ana, general } = await team();
  const ids: string[] = [];
  for (const body of ["tide export draft", "unrelated", "tide export final", "tide export shipped"]) ids.push(await say(ana, teamId, general, body));
  const newest = await julio.as.query(api.messages.search, { teamId, query: "tide", sort: "newest", limit: 2 });
  expect(newest.results.map((r) => r.body)).toEqual(["tide export shipped", "tide export final"]);
  expect(newest.isDone).toBe(false);
  const next = await julio.as.query(api.messages.search, { teamId, query: "tide", sort: "newest", limit: 2, cursor: newest.cursor });
  expect(next.results.map((r) => r.body)).toEqual(["tide export draft"]);
  expect(next.isDone).toBe(true);
});

test("a reply addressed to a reply, or to its row in the channel, lands in the original thread (Codex review)", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const parent = await say(julio, teamId, general, "Chart v2 is up");
  const reply = await say(ana, teamId, general, "Shipping it", { replyTo: parent, alsoInChannel: true });
  const echo = (await t.run(async (ctx) => (await ctx.db.get(reply))!.echoId))!;
  // An app from before Also send answers the channel's row by the reply's id; an agent might use the row's own.
  const viaReply = await say(julio, teamId, general, "Thanks", { replyTo: reply });
  const viaEcho = await say(julio, teamId, general, "And thanks again", { replyTo: echo });
  for (const id of [viaReply, viaEcho]) expect((await get(ana, teamId, id)).replyTo).toBe(parent);
  const thread = await ana.as.query(api.messages.replies, { teamId, messageId: parent });
  expect(thread.map((m) => m.body)).toEqual(["Shipping it", "Thanks", "And thanks again"]);
  expect((await get(ana, teamId, parent)).replyCount).toBe(3);
  // Asking for the replies of the reply gives its thread too, not an empty one of its own.
  expect((await ana.as.query(api.messages.replies, { teamId, messageId: reply })).map((m) => m.body)).toEqual(thread.map((m) => m.body));
});

test("a partial markRead still stepping forward stops when the channel is marked unread meanwhile (Codex review)", async () => {
  const { t, teamId, julio, julioId, ana, general } = await team();
  const ids: Id<"messages">[] = [];
  for (let i = 1; i <= 30; i++) ids.push(await say(ana, teamId, general, i % 2 ? `<@${julioId}> odd ${i}` : `even ${i}`));
  setReadRangeLimitForTests(4);
  try {
    // More mentions than one step counts: it stops partway and schedules the rest.
    // Not to the newest (which reads through at once): to the 28th, past more mentions than one step counts.
    const { readSeq } = await julio.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[27]! });
    expect(readSeq).toBeLessThan(28);
    // Before that step runs, Julio marks unread from the third message.
    await julio.as.mutation(api.channels.markUnread, { teamId, channelId: general, from: ids[2]! });
    await settleScheduled(t);
  } finally {
    setReadRangeLimitForTests(undefined);
  }
  const row = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === general)!;
  expect(row.readSeq).toBe((await get(julio, teamId, ids[2]!)).seq! - 1);
  expect(await counts(julio, teamId, general)).toEqual({ unread: 28, mentions: 14 });
});

test("Mark unread from a message the queued read hasn't reached yet still stops that read (Codex review)", async () => {
  const { t, teamId, julio, julioId, ana, general } = await team();
  const ids: Id<"messages">[] = [];
  for (let i = 1; i <= 30; i++) ids.push(await say(ana, teamId, general, i % 2 ? `<@${julioId}> odd ${i}` : `even ${i}`));
  setReadRangeLimitForTests(4);
  let stoppedAt: number;
  try {
    const { readSeq } = await julio.as.mutation(api.channels.markRead, { teamId, channelId: general, upTo: ids[27]! });
    stoppedAt = readSeq;
    // The 26th is past where the first step stopped, so there's nothing to move back.
    expect((await get(julio, teamId, ids[25]!)).seq! - 1).toBeGreaterThanOrEqual(stoppedAt);
    await julio.as.mutation(api.channels.markUnread, { teamId, channelId: general, from: ids[25]! });
    await settleScheduled(t);
  } finally {
    setReadRangeLimitForTests(undefined);
  }
  const row = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === general)!;
  expect(row.readSeq).toBe(stoppedAt);
});

test("presence is per app session: an idle window doesn't hide an active one, and old sessions are bounded (Codex review)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00Z") });
  try {
    const { t, teamId, julio, ana } = await team();
    const anaId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Ana")!.memberId;
    const anaNow = async () => (await julio.as.query(api.members.presence, { teamId })).find((r) => r.memberId === anaId)!;
    await ana.as.mutation(api.members.heartbeat, { teamId, active: true, sessionId: "laptop-session-1" });
    await ana.as.mutation(api.members.heartbeat, { teamId, active: false, sessionId: "desktop-session-2" });
    expect((await anaNow()).active).toBe(true);
    vi.advanceTimersByTime(60_000);
    await ana.as.mutation(api.members.heartbeat, { teamId, active: true, sessionId: "laptop-session-1" });
    await ana.as.mutation(api.members.heartbeat, { teamId, active: false, sessionId: "desktop-session-2" });
    expect((await anaNow()).active).toBe(true);
    // The laptop closes; three minutes later only the idle desktop is still beating.
    vi.advanceTimersByTime(180_000);
    await ana.as.mutation(api.members.heartbeat, { teamId, active: false, sessionId: "desktop-session-2" });
    expect(await anaNow()).toEqual({ memberId: anaId, lastSeenAt: Date.now(), active: false });
    // Many launches leave at most a few sessions behind.
    for (let i = 0; i < 20; i++) await ana.as.mutation(api.members.heartbeat, { teamId, active: false, sessionId: `launch-session-${i}` });
    expect(await t.run(async (ctx) => (await ctx.db.query("presence").collect()).filter((r) => r.memberId === anaId).length)).toBeLessThanOrEqual(8);
    await expect(ana.as.mutation(api.members.heartbeat, { teamId, active: true, sessionId: "x" })).rejects.toThrow(/sessionId/);
  } finally {
    vi.useRealTimers();
  }
});

test("typing older than a few seconds isn't returned, and stale rows are deleted on the next write and by the cron (Codex review)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, ben, general } = await team();
    await ana.as.mutation(api.channels.typing, { teamId, channelId: general });
    expect((await julio.as.query(api.channels.whoIsTyping, { teamId, channelId: general })).map((r) => r.member.name)).toEqual(["Ana"]);
    // Ana closed the app mid-draft: no stop ever comes.
    vi.advanceTimersByTime(9_000);
    expect(await julio.as.query(api.channels.whoIsTyping, { teamId, channelId: general })).toEqual([]);
    // A minute on, Ben's typing deletes Ana's row.
    vi.advanceTimersByTime(60_000);
    await ben.as.mutation(api.channels.typing, { teamId, channelId: general });
    const left = await t.run(async (ctx) => (await ctx.db.query("typing").collect()).length);
    expect(left).toBe(1);
    // The cron takes what no write in the channel cleared.
    vi.advanceTimersByTime(61_000);
    expect(await t.mutation(internal.channels.pruneTyping, {})).toBe(1);
    expect(await t.run(async (ctx) => (await ctx.db.query("typing").collect()).length)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("a <@run:id> token or addressedRuns addresses a live run by name; mentionedRuns stays a link chip (ADR 0026)", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const { machineId } = await linkMachine(t, teamId, julio, "julio-mbp");
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const { runId: ended } = await julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId });
  await julio.as.mutation(api.runs.stop, { teamId, runId: ended });

  const id = await say(ana, teamId, general, `<@run:${runId}> release the model, I'm taking over. <@run:${ended}> too`);
  const posted = await get(julio, teamId, id);
  expect(posted.addressedRuns).toEqual([{ runId, label: "Claude Code (Julio)" }]);
  expect(posted.mentionedRuns).toEqual([]);
  // Addressing a run doesn't mention its driver.
  expect(posted.mentionsMe).toBe(false);

  await expect(say(ana, teamId, general, "hello", { addressedRuns: [ended] })).rejects.toThrow(/isn't live/);
  const passed = await say(ana, teamId, general, "status?", { addressedRuns: [runId] });
  expect((await get(ana, teamId, passed)).addressedRuns).toEqual([{ runId, label: "Claude Code (Julio)" }]);

  // An edit works the addressed runs out again from the new body.
  await ana.as.mutation(api.messages.edit, { teamId, messageId: id, body: "never mind" });
  expect((await get(ana, teamId, id)).addressedRuns).toEqual([]);
  await ana.as.mutation(api.messages.edit, { teamId, messageId: id, body: `<@run:${runId}> one more thing` });
  expect((await get(ana, teamId, id)).addressedRuns).toEqual([{ runId, label: "Claude Code (Julio)" }]);
  // Once the run ends, an edit that keeps its token keeps it addressed.
  await julio.as.mutation(api.runs.stop, { teamId, runId });
  await ana.as.mutation(api.messages.edit, { teamId, messageId: id, body: `<@run:${runId}> one more thing, fixed a typo` });
  expect((await get(ana, teamId, id)).addressedRuns).toEqual([{ runId, label: "Claude Code (Julio)" }]);
});

test("a banner's preview names an addressed run, and an agent reads the token in the body", async () => {
  const { t, teamId, julio, julioId, ana, general } = await team();
  const { machineId } = await linkMachine(t, teamId, julio, "julio-mbp");
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  await say(ana, teamId, general, `<@${julioId}> I asked <@run:${runId}> to stop`);
  const [alert] = await julio.as.query(api.messages.addressed, { teamId });
  expect(alert!.preview).toBe("@Julio I asked @Claude Code (Julio) to stop");

  const { key } = await addAgent(t, teamId, julio, "Builder", ["room.read", "messages.post"]);
  const sent = await callAsAgent(t, key, "messages.post", { channelId: general, body: `<@run:${runId}> are you done?` });
  expect(sent).toMatchObject({ ok: true });
  const read = await callAsAgent(t, key, "messages.get", { messageId: sent.result });
  expect(read.result).toMatchObject({ body: `<@run:${runId}> are you done?`, addressedRuns: [{ runId, label: "Claude Code (Julio)" }] });
});

test("a message names a run as runs.live does, even when its driver has more than 100 runs since an older live one", async () => {
  const { t, teamId, julio, julioId, ana, general } = await team();
  const { machineId } = await linkMachine(t, teamId, julio, "julio-mbp");
  await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  // A hundred runs Julio drove and finished since.
  await t.run(async (ctx) => {
    for (let i = 0; i < 100; i++) {
      await ctx.db.insert("runs", { teamId, harness: "codex", driverId: julioId, startedBy: julioId, state: "stopped", stateChangedAt: Date.now() });
    }
  });
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });

  const live = await ana.as.query(api.runs.live, { teamId });
  expect(live.find((r) => r.runId === runId)!.label).toBe("Claude Code 2 (Julio)");
  const id = await say(ana, teamId, general, `<@run:${runId}> are you the second one?`);
  expect((await get(ana, teamId, id)).addressedRuns).toEqual([{ runId, label: "Claude Code 2 (Julio)" }]);
});
