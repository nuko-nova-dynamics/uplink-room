/**
 * Threads at scale (spec #63, Codex review of #99): a parent keeps its reply count and newest
 * reply, so a thread is never read whole to count it, and messages.unreadThreads finds threads
 * with replies past your read point whatever the app has loaded.
 */
import { expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { EXACT_COUNT_LIMIT } from "../convex/messages";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, newLimitedRoom, newRoom, newTeam, type Person, present, type Room, settleScheduled } from "./setup";

async function team(t: Room) {
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  return { teamId, julio, ana, general: general!.channelId };
}

const say = (p: Person, teamId: Id<"teams">, channelId: Id<"channels">, body: string, extra = {}) =>
  p.as.mutation(api.messages.post, { teamId, channelId, body, ...extra });
const view = async (p: Person, teamId: Id<"teams">, messageId: Id<"messages">) =>
  present(await p.as.query(api.messages.get, { teamId, messageId }));

/**
 * Adds `n` replies to a thread straight into the tables, as that many posts would leave them:
 * each with the channel's next seq, and the parent's count and newest reply kept.
 */
async function bulkReplies(t: Room, parentId: Id<"messages">, authors: Id<"members">[], n: number) {
  await t.run(async (ctx) => {
    const parent = (await ctx.db.get(parentId))!;
    const channel = (await ctx.db.get(parent.channelId))!;
    let seq = channel.lastSeq ?? 0;
    for (let i = 0; i < n; i++) {
      seq++;
      await ctx.db.insert("messages", {
        teamId: parent.teamId,
        channelId: parent.channelId,
        authorId: authors[i % authors.length]!,
        format: "markdown",
        body: `reply ${i}`,
        replyTo: parentId,
        mentionedTasks: [],
        mentionedRuns: [],
        seq,
      });
    }
    await ctx.db.patch(channel._id, { lastSeq: seq, lastMessageAt: Date.now() });
    await ctx.db.patch(parentId, { replyCount: (parent.replyCount ?? 0) + n, lastReplySeq: seq, lastReplyAt: Date.now() });
  });
}

/**
 * Adds `n` replies the way threads from before stored counts are: replies with seqs, and nothing
 * kept on the parent. Inserted in chunks, so no one transaction writes too much.
 */
async function legacyReplies(t: Room, parentId: Id<"messages">, authors: Id<"members">[], n: number) {
  for (let done = 0; done < n; done += 5000) {
    await t.run(async (ctx) => {
      const parent = (await ctx.db.get(parentId))!;
      const channel = (await ctx.db.get(parent.channelId))!;
      let seq = channel.lastSeq ?? 0;
      for (let i = done; i < Math.min(n, done + 5000); i++) {
        seq++;
        await ctx.db.insert("messages", {
          teamId: parent.teamId,
          channelId: parent.channelId,
          authorId: authors[i % authors.length]!,
          format: "markdown",
          body: `old reply ${i}`,
          replyTo: parentId,
          mentionedTasks: [],
          mentionedRuns: [],
          seq,
        });
      }
      await ctx.db.patch(channel._id, { lastSeq: seq });
    });
  }
}

const stored = (t: Room, id: Id<"messages">) => t.run(async (ctx) => (await ctx.db.get(id))!);

test("the backfill counts every thread exactly, a page and a budget at a time, and fixes a wrong stored count", async () => {
  const t = newLimitedRoom();
  const { teamId, julio, ana, general } = await team(t);
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  const authors = [ana.memberId as Id<"members">, julioId];
  const big = await say(julio, teamId, general, "big thread");
  const mid = await say(ana, teamId, general, "mid thread");
  const quiet = await say(ana, teamId, general, "no replies");
  const wrong = await say(julio, teamId, general, "wrongly counted");
  await legacyReplies(t, big, authors, 3001);
  await legacyReplies(t, mid, authors, 300);
  await legacyReplies(t, wrong, authors, 3);
  await t.run((ctx) => ctx.db.patch(wrong, { replyCount: 200, lastReplySeq: 1 }));
  // Uncounted parents show no count rather than a wrong one.
  expect(await view(julio, teamId, big)).toMatchObject({ replyCount: 0 });
  // A small reply budget, so the long threads are counted across many runs.
  await t.mutation(internal.messages.backfillReplyMeta, { pageSize: 100, replyBudget: 250 });
  await settleScheduled(t);
  const lastOf = async (id: Id<"messages">) =>
    t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_reply", (q) => q.eq("replyTo", id)).order("desc").first())!.seq);
  expect(await stored(t, big)).toMatchObject({ replyCount: 3001, lastReplySeq: await lastOf(big) });
  expect(await stored(t, mid)).toMatchObject({ replyCount: 300, lastReplySeq: await lastOf(mid) });
  expect(await stored(t, wrong)).toMatchObject({ replyCount: 3, lastReplySeq: await lastOf(wrong) });
  // A message without replies is left alone.
  expect((await stored(t, quiet)).replyCount).toBeUndefined();
  expect(await view(julio, teamId, big)).toMatchObject({ replyCount: 3001 });
  // Run again: nothing to fix.
  expect(await t.mutation(internal.messages.backfillReplyMeta, { pageSize: 200, replyBudget: 8000 })).toMatchObject({ status: "continuing" });
  await settleScheduled(t);
  expect(await stored(t, big)).toMatchObject({ replyCount: 3001 });
}, 120_000);

test("a reply deleted between two runs counting one long thread doesn't leave a stale count (#99 review)", async () => {
  vi.useFakeTimers();
  try {
    const t = newRoom();
    const { teamId, julio, ana, general } = await team(t);
    const big = await say(julio, teamId, general, "long old thread");
    // Past what a delete counts on its own (EXACT_COUNT_LIMIT), so nothing on the parent changes but its revision.
    await legacyReplies(t, big, [ana.memberId as Id<"members">], EXACT_COUNT_LIMIT + 100);
    // The first run counts 300 replies and stops part way through the thread.
    await t.mutation(internal.messages.backfillReplyMeta, { pageSize: 200, replyBudget: 300 });
    expect((await stored(t, big)).replyCount).toBeUndefined();
    // Before the next run, one of the replies already counted is deleted.
    const counted = await t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_reply", (q) => q.eq("replyTo", big)).first())!._id);
    await ana.as.mutation(api.messages.delete, { teamId, messageId: counted });
    expect((await stored(t, big)).replyCount).toBeUndefined();
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
    expect(await stored(t, big)).toMatchObject({ replyCount: EXACT_COUNT_LIMIT + 99 });
    // A parent whose count a delete set exactly keeps it too.
    const small = await say(julio, teamId, general, "shorter old thread");
    await legacyReplies(t, small, [ana.memberId as Id<"members">], 700);
    await t.mutation(internal.messages.backfillReplyMeta, { pageSize: 200, replyBudget: 300 });
    const first = await t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_reply", (q) => q.eq("replyTo", small)).first())!._id);
    await ana.as.mutation(api.messages.delete, { teamId, messageId: first });
    expect((await stored(t, small)).replyCount).toBe(699);
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
    expect((await stored(t, small)).replyCount).toBe(699);
  } finally {
    vi.useRealTimers();
  }
}, 120_000);

test("replies from before unread counts (no seq) never count as new in a thread (#99 review)", async () => {
  const t = newRoom();
  const { teamId, julio, ana, general } = await team(t);
  const parent = await say(ana, teamId, general, "old thread");
  // Five replies from before seqs were kept, then Julio reads the channel by posting.
  await t.run(async (ctx) => {
    const p = (await ctx.db.get(parent))!;
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert("messages", { teamId, channelId: general, authorId: ana.memberId as Id<"members">, format: "markdown", body: `unsequenced ${i}`, replyTo: parent, mentionedTasks: [], mentionedRuns: [] });
    }
    await ctx.db.patch(parent, { replyCount: 5, lastReplySeq: p.seq });
  });
  await say(julio, teamId, general, "caught up");
  // One new reply: one new, starting at that reply.
  const reply = await say(ana, teamId, general, "one new reply", { replyTo: parent });
  const threads = await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null });
  expect(threads.page).toHaveLength(1);
  expect(threads.page[0]).toMatchObject({ newReplies: 1, moreNew: false, firstNewSeq: (await view(julio, teamId, reply)).seq });
});

test("a page of 200 threads from before stored counts renders within Convex's limits", async () => {
  const t = newLimitedRoom();
  const { teamId, julio, ana, general } = await team(t);
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  const parents: Id<"messages">[] = [];
  await t.run(async (ctx) => {
    const channel = (await ctx.db.get(general))!;
    let seq = channel.lastSeq ?? 0;
    for (let i = 0; i < 200; i++) {
      seq++;
      parents.push(
        await ctx.db.insert("messages", { teamId, channelId: general, authorId: julioId, format: "markdown", body: `topic ${i}`, mentionedTasks: [], mentionedRuns: [], seq }),
      );
    }
    await ctx.db.patch(general, { lastSeq: seq });
  });
  // 165 replies each: 33,000 in all, more than one function may read (32,000).
  for (const p of parents) await legacyReplies(t, p, [ana.memberId as Id<"members">], 165);
  const page = (await julio.as.query(api.messages.list, { teamId, channelId: general, cursor: null, limit: 200 })) as {
    page: { replyCount: number }[];
  };
  expect(page.page).toHaveLength(200);
  expect(page.page.every((m) => m.replyCount === 0)).toBe(true);
}, 300_000);

test("a reply posted to, or deleted from, a parent with no stored count counts it once, exactly; past the bound it waits for the backfill", async () => {
  const t = newRoom();
  const { teamId, julio, ana, general } = await team(t);
  const parent = await say(ana, teamId, general, "old thread");
  await legacyReplies(t, parent, [ana.memberId as Id<"members">], 5);
  const reply = await say(julio, teamId, general, "a new reply", { replyTo: parent });
  expect(await view(julio, teamId, parent)).toMatchObject({ replyCount: 6, lastReplySeq: (await view(julio, teamId, reply)).seq });
  await julio.as.mutation(api.messages.delete, { teamId, messageId: reply });
  expect(await view(julio, teamId, parent)).toMatchObject({ replyCount: 5 });
  // Deleting from an uncounted parent counts it too.
  const other = await say(ana, teamId, general, "another old thread");
  await legacyReplies(t, other, [ana.memberId as Id<"members">], 4);
  const oldReply = await t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_reply", (q) => q.eq("replyTo", other)).first())!._id);
  await ana.as.mutation(api.messages.delete, { teamId, messageId: oldReply });
  expect(await view(julio, teamId, other)).toMatchObject({ replyCount: 3 });
  // Too many to count in a post: no count is made up, but the newest reply is kept, so the thread
  // is still found as unread; the backfill then counts it.
  const huge = await say(ana, teamId, general, "huge old thread");
  await legacyReplies(t, huge, [ana.memberId as Id<"members">], EXACT_COUNT_LIMIT + 5);
  const late = await say(ana, teamId, general, "one more", { replyTo: huge });
  const hugeNow = await stored(t, huge);
  expect(hugeNow.replyCount).toBeUndefined();
  expect(hugeNow.lastReplySeq).toBe((await view(julio, teamId, late)).seq);
  const threads = await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null });
  expect(threads.page.map((x) => x.message.messageId)).toContain(huge);
  await t.mutation(internal.messages.backfillReplyMeta, {});
  await settleScheduled(t);
  expect(await stored(t, huge)).toMatchObject({ replyCount: EXACT_COUNT_LIMIT + 6 });
}, 120_000);

test("a parent keeps its reply count and newest reply through posts and deletes", async () => {
  const t = newRoom();
  const { teamId, julio, ana, general } = await team(t);
  const parent = await say(ana, teamId, general, "Who has the notes?");
  expect(await view(julio, teamId, parent)).toMatchObject({ replyCount: 0 });
  const first = await say(julio, teamId, general, "I do", { replyTo: parent });
  const second = await say(ana, teamId, general, "Thanks", { replyTo: parent });
  const firstSeq = (await view(julio, teamId, first)).seq!;
  expect(await view(julio, teamId, parent)).toMatchObject({ replyCount: 2, lastReplySeq: (await view(julio, teamId, second)).seq });
  await ana.as.mutation(api.messages.delete, { teamId, messageId: second });
  expect(await view(julio, teamId, parent)).toMatchObject({ replyCount: 1, lastReplySeq: firstSeq });
  await julio.as.mutation(api.messages.delete, { teamId, messageId: first });
  const left = await view(julio, teamId, parent);
  expect(left.replyCount).toBe(0);
  expect(left.lastReplySeq).toBeUndefined();
});

test("a thread of thousands of replies is counted and found within Convex's limits, without reading it whole", async () => {
  const t = newLimitedRoom();
  const { teamId, julio, ana, general } = await team(t);
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  const parent = await say(julio, teamId, general, "Release thread");
  await say(ana, teamId, general, "first", { replyTo: parent });
  await bulkReplies(t, parent, [ana.memberId as Id<"members">, julioId], 3000);
  // The channel's page shows the thread's size and newest reply from the parent alone.
  // With a cursor, messages.list answers a page.
  const page = (await julio.as.query(api.messages.list, { teamId, channelId: general, cursor: null, limit: 50 })) as {
    page: { messageId: Id<"messages">; replyCount: number }[];
  };
  expect(page.page.find((m) => m.messageId === parent)).toMatchObject({ replyCount: 3001 });
  // Julio's read point is his own first post; Ana's 1,501 replies since are new to him, counted from
  // the newest and capped, in a query that stays under the limits.
  const threads = await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null });
  expect(threads.page).toHaveLength(1);
  expect(threads.page[0]).toMatchObject({ message: { messageId: parent }, newReplies: 99, moreNew: true });
  // The look back stopped short of the read point, so where the new replies start isn't known.
  expect(threads.page[0]!.firstNewSeq).toBeUndefined();
  // Opening the thread reads each author once, so even the whole thread fits.
  expect(await julio.as.query(api.messages.replies, { teamId, messageId: parent })).toHaveLength(3001);
});

test("threads with replies past your read point are found and paged whatever is loaded, and reading them clears the list", async () => {
  const t = newRoom();
  const { teamId, julio, ana, general } = await team(t);
  const parents: Id<"messages">[] = [];
  for (let i = 0; i < 13; i++) parents.push(await say(julio, teamId, general, `topic ${i}`));
  // Then a long run of top-level messages, so the threads are far above anything a page shows.
  for (let i = 0; i < 60; i++) await say(julio, teamId, general, `later ${i}`);
  for (const p of parents) await say(ana, teamId, general, "a reply", { replyTo: p });
  const first = await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null, limit: 10 });
  expect(first.page).toHaveLength(10);
  expect(first.page.every((x) => x.newReplies === 1 && !x.moreNew)).toBe(true);
  // Each says where its new replies start: its one reply's seq.
  expect(first.page.every((x) => x.firstNewSeq === x.message.lastReplySeq)).toBe(true);
  // Newest reply first.
  expect(first.page[0]!.message.messageId).toBe(parents[12]);
  expect(first.isDone).toBe(false);
  const rest = await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: first.continueCursor, limit: 10 });
  expect(rest.page.map((x) => x.message.messageId)).toEqual(parents.slice(0, 3).reverse());
  // Ana's own replies aren't news to her.
  expect((await ana.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null })).page).toEqual([]);
  await julio.as.mutation(api.channels.markRead, { teamId, channelId: general });
  expect((await julio.as.query(api.messages.unreadThreads, { teamId, channelId: general, cursor: null })).page).toEqual([]);
});
