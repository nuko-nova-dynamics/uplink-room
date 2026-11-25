/**
 * Chat in a team too big for one transaction (#69): deleting an @everyone message, editing
 * @everyone out of one, making a channel and joining a team with many channels.
 *
 * Convex refuses a transaction that reads more than 4,096 index ranges (docs.convex.dev, Limits),
 * which the old code passed in a team of about 4,000. convex-test resolves every query by scanning
 * its whole table, so a team that size takes minutes here; these tests keep Convex's other limits
 * and lower that one to 800, so a team of 900 is past it, while one step (100 members) stays inside
 * it. A fan-out step that makes each member's read row on the way reads about 1,000, so the test
 * that needs one uses 1,100 and a team of 1,200.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { markReadUpTo, readSummary, SWEEP_BATCH } from "../convex/lib/reads";
import schema from "../convex/schema";
import { addTeammate, modules, newTeam, present, settleScheduled, type Room } from "./setup";

const EXTRA = 900;
/** Each test runs a few seconds here; slower runners get room. */
const SLOW = { timeout: 120_000 };

function bigRoom(databaseQueries = 800): Room {
  return convexTest({ schema, modules, transactionLimits: { databaseQueries } }) as Room;
}

/** Julio (admin) and Ana, #general, and `n` more members, each with a read row in #general as joining leaves them. */
async function bigTeam(n = EXTRA, databaseQueries?: number) {
  const t = bigRoom(databaseQueries);
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const extra = await t.run(async (ctx) => {
    const channel = (await ctx.db.get(general!.channelId))!;
    const ids: Id<"members">[] = [];
    for (let i = 0; i < n; i++) {
      const memberId = await ctx.db.insert("members", { teamId, kind: "person", name: `Member ${i}`, role: "member" });
      await ctx.db.insert("channelReads", {
        teamId,
        channelId: channel._id,
        memberId,
        readSeq: channel.lastSeq ?? 0,
        deletedThrough: channel.deletedTotal ?? 0,
        mentionTotal: 0,
        mentionsThrough: 0,
      });
      ids.push(memberId);
    }
    return ids;
  });
  return { t, teamId, julio, ana, general: general!.channelId, extra };
}

/** Counts for these members, a hundred per transaction. */
async function countsOf(t: Room, channelId: Id<"channels">, memberIds: Id<"members">[]) {
  const out: { unread: number; mentions: number }[] = [];
  for (let i = 0; i < memberIds.length; i += 100) {
    out.push(
      ...(await t.run(async (ctx) => {
        const channel = (await ctx.db.get(channelId))!;
        const chunk = [];
        for (const id of memberIds.slice(i, i + 100)) {
          const { unread, mentions } = await readSummary(ctx, channel, id);
          chunk.push({ unread, mentions });
        }
        return chunk;
      })),
    );
  }
  return out;
}

/** Runs the scheduled steps due now, one each, without the next ones they schedule. */
async function oneStep(t: Room) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.finishInProgressScheduledFunctions();
}

const sweeps = (t: Room) => t.run(async (ctx) => ctx.db.query("messageSweeps").collect());

/** Spread through the order a sweep reaches them in (by member id), so some are reached late. */
function spread(ids: Id<"members">[], n = 8) {
  const sorted = [...ids].sort();
  return Array.from({ length: n }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]!);
}

test("an @everyone message in a team bigger than one sweep step is deleted at once, with exact counts while the steps run and after", SLOW, async () => {
  const { t, teamId, julio, ana, general, extra } = await bigTeam();
  const everyone = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "@everyone all hands at 3", mentionEveryone: true });
  await settleScheduled(t);
  const agenda = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "agenda in the doc" });
  // Half the team reads past it, so the sweep has more read rows to bring up to date than one step does.
  const readers = extra.filter((_, i) => i % 2 === 0);
  const others = extra.filter((_, i) => i % 2 === 1);
  const agendaSeq = present(await julio.as.query(api.messages.get, { teamId, messageId: agenda })).seq!;
  for (let i = 0; i < readers.length; i += 50) {
    await t.run(async (ctx) => {
      const channel = (await ctx.db.get(general))!;
      for (const id of readers.slice(i, i + 50)) await markReadUpTo(ctx, channel, id, agendaSeq);
    });
  }
  await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "see you there" });
  expect(await countsOf(t, general, spread(readers))).toEqual(spread(readers).map(() => ({ unread: 1, mentions: 0 })));
  expect(await countsOf(t, general, spread(others))).toEqual(spread(others).map(() => ({ unread: 3, mentions: 1 })));

  await julio.as.mutation(api.messages.delete, { teamId, messageId: everyone });

  // Gone at once, while its rows are still being swept.
  expect(await ana.as.query(api.messages.get, { teamId, messageId: everyone })).toBeNull();
  expect(await sweeps(t)).toHaveLength(1);
  const sample = [...spread(readers), ...spread(others)];
  const expected = [...spread(readers).map(() => ({ unread: 1, mentions: 0 })), ...spread(others).map(() => ({ unread: 2, mentions: 0 }))];
  let steps = 0;
  while ((await sweeps(t)).length > 0) {
    expect(await countsOf(t, general, sample)).toEqual(expected);
    const anas = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.channelId === general)!;
    expect({ unread: anas.unread, mentions: anas.mentions }).toEqual({ unread: 2, mentions: 0 });
    await oneStep(t);
    steps++;
    if (steps > 100) throw new Error("the sweep didn't end");
  }
  // At least one step per hundred mention rows, alerts and read rows.
  expect(steps).toBeGreaterThanOrEqual(Math.ceil((EXTRA + 1) / SWEEP_BATCH));

  // Exact for everyone afterwards, and nothing of the message left.
  expect(await countsOf(t, general, readers)).toEqual(readers.map(() => ({ unread: 1, mentions: 0 })));
  expect(await countsOf(t, general, others)).toEqual(others.map(() => ({ unread: 2, mentions: 0 })));
  const left = await t.run(async (ctx) => ({
    mentions: (await ctx.db.query("mentions").withIndex("by_message_member", (q) => q.eq("messageId", everyone)).collect()).length,
    alerts: (await ctx.db.query("messageAlerts").withIndex("by_message_member", (q) => q.eq("messageId", everyone)).take(1)).length,
  }));
  expect(left).toEqual({ mentions: 0, alerts: 0 });
});

test("editing @everyone out in a team bigger than one sweep step leaves only the members it still names, with exact counts throughout", SLOW, async () => {
  const { t, teamId, julio, ana, general, extra } = await bigTeam();
  const named = extra[0]!;
  const messageId = await julio.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: `@everyone <@${named}> standup moved to 10`,
    mentionEveryone: true,
  });
  await settleScheduled(t);
  const rest = extra.slice(1);
  expect(await countsOf(t, general, [named, ...spread(rest)])).toEqual([named, ...spread(rest)].map(() => ({ unread: 1, mentions: 1 })));

  await julio.as.mutation(api.messages.edit, { teamId, messageId, body: `<@${named}> standup moved to 10` });

  expect(present(await ana.as.query(api.messages.get, { teamId, messageId }))).toMatchObject({ mentionsEveryone: false, mentionsMe: false });
  expect(await sweeps(t)).toHaveLength(1);
  let steps = 0;
  while ((await sweeps(t)).length > 0) {
    expect(await countsOf(t, general, [named, ...spread(rest)])).toEqual([
      { unread: 1, mentions: 1 },
      ...spread(rest).map(() => ({ unread: 1, mentions: 0 })),
    ]);
    await oneStep(t);
    steps++;
    if (steps > 100) throw new Error("the sweep didn't end");
  }
  expect(steps).toBeGreaterThanOrEqual(Math.ceil(EXTRA / SWEEP_BATCH));
  expect(await countsOf(t, general, rest)).toEqual(rest.map(() => ({ unread: 1, mentions: 0 })));
  const anas = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.channelId === general)!;
  expect({ unread: anas.unread, mentions: anas.mentions }).toEqual({ unread: 1, mentions: 0 });
  const mentioned = await t.run(async (ctx) =>
    (await ctx.db.query("mentions").withIndex("by_message_member", (q) => q.eq("messageId", messageId)).collect()).map((m) => m.memberId),
  );
  expect(mentioned).toEqual([named]);
});

test("a channel or project made in a team bigger than one step makes no read rows, and counts start from its first message", SLOW, async () => {
  const { t, teamId, julio, ana, extra } = await bigTeam(1200, 1100);
  const launch = await julio.as.mutation(api.channels.create, { teamId, name: "launch" });
  const projectId = await julio.as.mutation(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  const reef = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.projectId === projectId)!.channelId;
  const rows = await t.run(async (ctx) => ({
    launch: (await ctx.db.query("channelReads").withIndex("by_channel_member", (q) => q.eq("channelId", launch)).collect()).length,
    reef: (await ctx.db.query("channelReads").withIndex("by_channel_member", (q) => q.eq("channelId", reef)).collect()).length,
  }));
  expect(rows).toEqual({ launch: 0, reef: 0 });

  // The first @everyone in the new channel makes everyone's row on its way.
  await julio.as.mutation(api.messages.post, { teamId, channelId: launch, body: "kickoff notes" });
  await julio.as.mutation(api.messages.post, { teamId, channelId: launch, body: "@everyone kickoff at noon", mentionEveryone: true });
  const named = extra.at(-1)!;
  await julio.as.mutation(api.messages.post, { teamId, channelId: reef, body: "repo is up" });
  await julio.as.mutation(api.messages.post, { teamId, channelId: reef, body: `<@${named}> <@${ana.memberId}> review please` });
  await settleScheduled(t);
  expect(await countsOf(t, launch, extra)).toEqual(extra.map(() => ({ unread: 2, mentions: 1 })));
  expect(await countsOf(t, reef, extra)).toEqual(extra.map((id) => ({ unread: 2, mentions: id === named ? 1 : 0 })));
  for (const channelId of [launch, reef]) {
    const row = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)!;
    expect({ unread: row.unread, mentions: row.mentions }).toEqual({ unread: 2, mentions: 1 });
    const mine = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)!;
    expect({ unread: mine.unread, mentions: mine.mentions }).toEqual({ unread: 0, mentions: 0 });
  }
  // Reading part of the way works from that start too.
  const [first] = (await ana.as.query(api.messages.list, { teamId, channelId: launch, limit: 2 })) as { messageId: Id<"messages"> }[];
  await ana.as.mutation(api.channels.markRead, { teamId, channelId: launch, upTo: first!.messageId });
  const row = (await ana.as.query(api.channels.list, { teamId })).find((c) => c.channelId === launch)!;
  expect({ unread: row.unread, mentions: row.mentions }).toEqual({ unread: 1, mentions: 1 });
});

test("someone joining a team with more channels than one step gets read rows in steps, each channel read from when they joined", SLOW, async () => {
  const t = bigRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const channels = await t.run(async (ctx) => {
    const ids: Id<"channels">[] = [];
    for (let i = 0; i < EXTRA; i++) ids.push(await ctx.db.insert("channels", { teamId, name: `room-${i}` }));
    return ids;
  });
  const last = channels.at(-1)!;
  const nextToLast = channels.at(-2)!;
  await julio.as.mutation(api.messages.post, { teamId, channelId: last, body: "before Cleo" });
  const old = await julio.as.mutation(api.messages.post, { teamId, channelId: nextToLast, body: "old news" });
  await julio.as.mutation(api.messages.post, { teamId, channelId: nextToLast, body: "also before Cleo" });

  const cleo = await addTeammate(t, teamId, julio, "Cleo");
  const rowsOf = () =>
    t.run(async (ctx) => (await ctx.db.query("channelReads").withIndex("by_member", (q) => q.eq("memberId", cleo.memberId)).collect()) as Doc<"channelReads">[]);
  // The first step's channels have rows; the last ones don't yet.
  const firstStep = await rowsOf();
  expect(firstStep).toHaveLength(SWEEP_BATCH);
  expect(firstStep.some((r) => r.channelId === last || r.channelId === nextToLast)).toBe(false);

  // Meanwhile they read from when Cleo joined: what came after counts, what went before doesn't,
  // and deleting an old message doesn't change that.
  await julio.as.mutation(api.messages.post, { teamId, channelId: last, body: "after Cleo" });
  await julio.as.mutation(api.messages.delete, { teamId, messageId: old });
  const expected = [
    { unread: 1, mentions: 0 },
    { unread: 0, mentions: 0 },
  ];
  let steps = 0;
  while ((await rowsOf()).length < EXTRA + 1) {
    expect([...(await countsOf(t, last, [cleo.memberId])), ...(await countsOf(t, nextToLast, [cleo.memberId]))]).toEqual(expected);
    await oneStep(t);
    steps++;
    if (steps > 100) throw new Error("the rows weren't all made");
  }
  expect(steps).toBeGreaterThanOrEqual(Math.ceil(EXTRA / SWEEP_BATCH) - 1);
  await settleScheduled(t);
  expect([...(await countsOf(t, last, [cleo.memberId])), ...(await countsOf(t, nextToLast, [cleo.memberId]))]).toEqual(expected);
  expect(await countsOf(t, channels[0]!, [cleo.memberId])).toEqual([{ unread: 0, mentions: 0 }]);
  const rows = await rowsOf();
  expect(rows).toHaveLength(EXTRA + 1);
  expect(rows.find((r) => r.channelId === last)!.readSeq).toBe(1);
});

test("channels.list reads one index range for each channel nothing is happening in, with or without a read row, so a member can list hundreds", SLOW, async () => {
  const t = bigRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  // 600 channels made after Julio joined: he has read rows in half (he opened them), none in the rest.
  const rooms = await t.run(async (ctx) => {
    const ids: Id<"channels">[] = [];
    for (let i = 0; i < 600; i++) {
      const channelId = await ctx.db.insert("channels", { teamId, name: `room-${i}` });
      if (i % 2 === 0) {
        await ctx.db.insert("channelReads", { teamId, channelId, memberId: julioId, readSeq: 0, deletedThrough: 0, mentionTotal: 0, mentionsThrough: 0 });
      }
      ids.push(channelId);
    }
    return ids;
  });
  await ana.as.mutation(api.messages.post, { teamId, channelId: rooms[0]!, body: "in a room Julio opened" });
  await ana.as.mutation(api.messages.post, { teamId, channelId: rooms[1]!, body: "in a room he never opened" });
  // A mention makes his row there.
  await ana.as.mutation(api.messages.post, { teamId, channelId: rooms[3]!, body: `<@${julioId}> in another` });

  const list = await julio.as.query(api.channels.list, { teamId });
  expect(list).toHaveLength(601);
  const counts = new Map(list.map((c) => [c.channelId, { unread: c.unread, mentions: c.mentions }]));
  expect(counts.get(rooms[0]!)).toEqual({ unread: 1, mentions: 0 });
  expect(counts.get(rooms[1]!)).toEqual({ unread: 1, mentions: 0 });
  expect(counts.get(rooms[3]!)).toEqual({ unread: 1, mentions: 1 });
  const idle = rooms.filter((_, i) => i !== 0 && i !== 1 && i !== 3);
  expect(idle.every((id) => counts.get(id)!.unread === 0 && counts.get(id)!.mentions === 0)).toBe(true);
});
