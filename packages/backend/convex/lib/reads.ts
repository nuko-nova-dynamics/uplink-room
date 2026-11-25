/**
 * Unread state (spec #63): what each member has read in each channel and direct message, and how
 * loud each one is for them.
 *
 * Counts are exact and cheap to read. Every message gets the next `seq` in its channel and the
 * channel keeps its last one (`lastSeq`) and how many were ever deleted (`deletedTotal`, one row
 * each in `deletions`). A member's read row keeps how many of those deletions are at or below their
 * read point (`deletedThrough`), and the same two counters for the messages addressed to them
 * (one row each in `mentions`). So:
 *
 *   unread   = lastSeq − readSeq − (deletedTotal − deletedThrough)
 *   mentions = mentionTotal − mentionsThrough
 *
 * Reading those takes the channel row and one read row, whatever the channel's size. Marking read
 * up to the newest message just copies the totals. Marking read part of the way counts the
 * deletion and mention rows it passes, at most `RANGE_LIMIT` of each per step; a longer stretch goes
 * on in a scheduled step, and every step leaves the counts exact for where it stopped. All of it
 * stays inside Convex's per-function limits (32,000 documents scanned, 16,000 written, 4,096 index
 * ranges read, 16 MiB; docs.convex.dev, Limits).
 *
 * A member has no read row until they need one, and until then reads as having read what was
 * posted before they joined the team (`baselineSeq`), a membership-time baseline. Nobody gets a row
 * when a channel is made: the whole team joined before anything was posted in it, so its baseline is
 * 0 and costs nothing to read (#69). A new team member does get a row in each channel, at the same
 * baseline, SWEEP_BATCH channels per step (`startTeamMember`), because in a channel with history
 * the baseline's deletion count can be long to work out on every read.
 *
 * A message that can reach the whole team (@everyone) can't leave every member's counts in one
 * transaction, so deleting it, or editing @everyone out of it, starts a sweep (`messageSweeps`): the
 * message is gone at once, and the mention, alert and read rows of whoever it reached are updated
 * SWEEP_BATCH at a time, the first step in the same mutation and the rest scheduled. While a sweep
 * runs, `readSummary` counts as if every step had run, so counts stay exact throughout: a deletion is
 * in `deletedTotal` and `deletions` at once, a read row records the `deletedTotal` it has caught up
 * with (`deletionSync`), and a mention row the sweep will drop is left out of the count already.
 */
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { hasMemberList, isDirect } from "./channels";

export type NotifyLevel = "all" | "mentions" | "none";

/** The most deletion or mention rows one step of a partial markRead counts. */
export const RANGE_LIMIT = 4000;
let rangeLimit = RANGE_LIMIT;

/** Tests use a small step to see a partial markRead go on in scheduled steps; `undefined` restores it. */
export function setReadRangeLimitForTests(limit: number | undefined): void {
  rangeLimit = limit ?? RANGE_LIMIT;
}

/** How many mention rows, alerts, read rows or channels one step of a sweep or a new member's rows reaches. */
export const SWEEP_BATCH = 100;

/** A direct message tells you about every message; a channel, private or not, only about mentions and replies. */
export function defaultLevel(channel: Doc<"channels">): NotifyLevel {
  return isDirect(channel) ? "all" : "mentions";
}

export async function readRow(ctx: QueryCtx, channelId: Id<"channels">, memberId: Id<"members">) {
  return await ctx.db
    .query("channelReads")
    .withIndex("by_channel_member", (q) => q.eq("channelId", channelId).eq("memberId", memberId))
    .unique();
}

/**
 * Where a member with no read row has read up to: everything posted before they joined the team,
 * so nothing in a channel made after they joined. A line the room wrote (a pin) has no seq and is
 * skipped; a message from before unread counts existed has none either, and means nothing after
 * the member joined is counted from before it. `joined` saves reading the member again.
 */
export async function baselineSeq(ctx: QueryCtx, channel: Doc<"channels">, memberId: Id<"members">, joined?: number) {
  const since = joined ?? (await ctx.db.get(memberId))?._creationTime ?? 0;
  if (channel._creationTime > since) return 0;
  for await (const m of ctx.db
    .query("messages")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id).gt("_creationTime", since))) {
    if (m.system) continue;
    return m.seq === undefined ? 0 : m.seq - 1;
  }
  return channel.lastSeq ?? 0;
}

/** How many deletions have a seq in (from, to]. Bounded by `limit`; the rows come back in seq order. */
async function deletionsIn(ctx: QueryCtx, channelId: Id<"channels">, from: number, to: number, limit: number) {
  return await ctx.db
    .query("deletions")
    .withIndex("by_channel_seq", (q) => q.eq("channelId", channelId).gt("seq", from).lte("seq", to))
    .take(limit);
}

/**
 * How many of the channel's deletions have a seq at or below `seq`, for a read row starting there.
 * `channel` must be current. A baseline is 0 in a channel made after the member joined, and recent
 * for a new member, so the deletions after it are the few to count.
 */
async function deletionsAtOrBelow(ctx: QueryCtx, channel: Doc<"channels">, seq: number) {
  if (seq <= 0) return 0;
  const after = await ctx.db
    .query("deletions")
    .withIndex("by_channel_seq", (q) => q.eq("channelId", channel._id).gt("seq", seq))
    .take(RANGE_LIMIT + 1);
  if (after.length <= RANGE_LIMIT) return Math.max(0, (channel.deletedTotal ?? 0) - after.length);
  return (await deletionsIn(ctx, channel._id, 0, seq, RANGE_LIMIT)).length;
}

async function mentionsIn(
  ctx: QueryCtx,
  channelId: Id<"channels">,
  memberId: Id<"members">,
  from: number,
  to: number,
  limit: number,
) {
  return await ctx.db
    .query("mentions")
    .withIndex("by_member_channel_seq", (q) =>
      q.eq("memberId", memberId).eq("channelId", channelId).gt("seq", from).lte("seq", to),
    )
    .take(limit);
}

// ---------- sweeps ----------

/** A query reads at most this many running sweeps per channel, or per team for a list; a mutation reads them all. */
const SWEEPS_READ = 200;

async function sweepsIn(ctx: QueryCtx, channelId: Id<"channels">, all: boolean) {
  const sweeps = ctx.db.query("messageSweeps").withIndex("by_channel", (q) => q.eq("channelId", channelId));
  return all ? await sweeps.collect() : await sweeps.take(SWEEPS_READ);
}

/**
 * A team's running sweeps by channel, read once for a list of channels, so a channel nothing is
 * happening in costs its list one index range (its read row), as before sweeps.
 */
export async function teamSweeps(ctx: QueryCtx, teamId: Id<"teams">): Promise<Map<string, Doc<"messageSweeps">[]>> {
  const out = new Map<string, Doc<"messageSweeps">[]>();
  for (const sweep of await ctx.db
    .query("messageSweeps")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .take(SWEEPS_READ)) {
    out.set(sweep.channelId, [...(out.get(sweep.channelId) ?? []), sweep]);
  }
  return out;
}

/**
 * Deletions still being swept that a read row hasn't taken in: numbered past the `deletedTotal` it
 * caught up with, at or below its read point. A sweep that passed the row without changing it found
 * it below the deletion, and the row can only get past it by marking read, which catches up.
 */
function untaken(sweeps: Doc<"messageSweeps">[], row: Pick<Doc<"channelReads">, "readSeq" | "deletionSync">) {
  const synced = row.deletionSync ?? 0;
  return sweeps.filter((s) => s.deletion !== undefined && s.deletion > synced && s.seq !== undefined && s.seq <= row.readSeq)
    .length;
}

/** Whom a swept message still addresses: nobody once it is deleted, else whom it names and whom it answers. */
async function stillAddressed(ctx: QueryCtx, sweep: Doc<"messageSweeps">): Promise<Set<string>> {
  if (sweep.kind === "deleted") return new Set();
  const message = await ctx.db.get(sweep.messageId);
  if (!message || message.deletedAt !== undefined) return new Set();
  const out = new Set<string>(message.mentionedMembers ?? message.mentionedAgents ?? []);
  const parent = message.replyTo ? await ctx.db.get(message.replyTo) : null;
  // A reply to a run's message isn't one to its driver (ADR 0029 D19), as `replyAuthor` has it.
  if (parent && !parent.asRun) out.add(parent.authorId);
  return out;
}

/** Unread mentions of a member that running sweeps will drop: already out of their count. */
async function sweptMentions(ctx: QueryCtx, sweeps: Doc<"messageSweeps">[], row: Doc<"channelReads">) {
  const byMessage = new Map<string, Doc<"messageSweeps">[]>();
  for (const s of sweeps) byMessage.set(s.messageId, [...(byMessage.get(s.messageId) ?? []), s]);
  let out = 0;
  for (const [, forMessage] of byMessage) {
    const mention = await ctx.db
      .query("mentions")
      .withIndex("by_message_member", (q) => q.eq("messageId", forMessage[0]!.messageId).eq("memberId", row.memberId))
      .first();
    // One at or below the read point is in neither counter.
    if (!mention || mention.seq <= row.readSeq) continue;
    for (const sweep of forMessage) {
      if (!(await stillAddressed(ctx, sweep)).has(row.memberId)) {
        out++;
        break;
      }
    }
  }
  return out;
}

// ---------- counts ----------

/**
 * A member's counts in a channel. A list of channels passes what it already read: the team's
 * running sweeps (`teamSweeps`) and when the member joined.
 */
export async function readSummary(
  ctx: QueryCtx,
  channel: Doc<"channels">,
  memberId: Id<"members">,
  known: { sweeps?: Map<string, Doc<"messageSweeps">[]>; joined?: number } = {},
) {
  const row = await readRow(ctx, channel._id, memberId);
  const lastSeq = channel.lastSeq ?? 0;
  const deletedTotal = channel.deletedTotal ?? 0;
  let readSeq: number;
  let deletedThrough: number;
  let mentions = 0;
  if (row) {
    const sweeps = known.sweeps ? (known.sweeps.get(channel._id) ?? []) : await sweepsIn(ctx, channel._id, false);
    readSeq = row.readSeq;
    deletedThrough = (row.deletedThrough ?? 0) + untaken(sweeps, row);
    mentions = (row.mentionTotal ?? 0) - (row.mentionsThrough ?? 0) - (sweeps.length ? await sweptMentions(ctx, sweeps, row) : 0);
  } else {
    readSeq = await baselineSeq(ctx, channel, memberId, known.joined);
    deletedThrough = await deletionsAtOrBelow(ctx, channel, readSeq);
  }
  return {
    readSeq,
    lastSeq,
    unread: Math.max(0, lastSeq - readSeq - (deletedTotal - deletedThrough)),
    mentions: Math.max(0, mentions),
    notify: row?.notify ?? defaultLevel(channel),
    notifySet: row?.notify !== undefined,
  };
}

/** A new member's read row: read up to the channel's last message, with its deletions behind them. */
export async function startMembership(ctx: MutationCtx, channel: Doc<"channels">, memberId: Id<"members">) {
  if (await readRow(ctx, channel._id, memberId)) return;
  await ctx.db.insert("channelReads", {
    teamId: channel.teamId,
    channelId: channel._id,
    memberId,
    readSeq: channel.lastSeq ?? 0,
    deletedThrough: channel.deletedTotal ?? 0,
    deletionSync: channel.deletedTotal ?? 0,
    mentionTotal: 0,
    mentionsThrough: 0,
  });
}

/**
 * Read rows in every team channel (private channels wait until they are added) for someone who just joined the team, at their membership-time
 * baseline: what the channels hold so far counts as read. SWEEP_BATCH channels a step, the first
 * here and the rest scheduled; a channel not reached yet reads from the same baseline meanwhile.
 */
export async function startTeamMember(
  ctx: MutationCtx,
  teamId: Id<"teams">,
  memberId: Id<"members">,
  cursor: string | null = null,
) {
  const page = await ctx.db
    .query("channels")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .paginate({ numItems: SWEEP_BATCH, cursor });
  for (const c of page.page) if (!hasMemberList(c) && c.archivedAt === undefined) await ensureRead(ctx, c, memberId);
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.channels.continueJoin, { teamId, memberId, cursor: page.continueCursor });
  }
}

/** The member's read row, made (at their baseline) if they have none yet. */
export async function ensureRead(ctx: MutationCtx, channel: Doc<"channels">, memberId: Id<"members">) {
  const row = await readRow(ctx, channel._id, memberId);
  if (row) return row;
  // The caller's copy can be from before this mutation posted or deleted in the channel.
  const fresh = (await ctx.db.get(channel._id))!;
  const readSeq = await baselineSeq(ctx, fresh, memberId);
  const id = await ctx.db.insert("channelReads", {
    teamId: fresh.teamId,
    channelId: fresh._id,
    memberId,
    readSeq,
    deletedThrough: await deletionsAtOrBelow(ctx, fresh, readSeq),
    deletionSync: fresh.deletedTotal ?? 0,
    mentionTotal: 0,
    mentionsThrough: 0,
  });
  return (await ctx.db.get(id))!;
}

/**
 * Marks read up to `seq`. Read state only moves forward. Returns where it got to: a partial mark
 * across more than `RANGE_LIMIT` deletions or mentions stops at an exact point and goes on in a
 * scheduled step. Either way the row catches up with every deletion still being swept.
 */
export async function markReadUpTo(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  memberId: Id<"members">,
  seq: number,
): Promise<number> {
  const row = await ensureRead(ctx, channel, memberId);
  const fresh = (await ctx.db.get(channel._id))!;
  const lastSeq = fresh.lastSeq ?? 0;
  const deletedTotal = fresh.deletedTotal ?? 0;
  if (seq <= row.readSeq) return row.readSeq;
  if (seq >= lastSeq) {
    await ctx.db.patch(row._id, {
      readSeq: seq,
      readAt: Date.now(),
      deletedThrough: deletedTotal,
      deletionSync: deletedTotal,
      mentionsThrough: row.mentionTotal ?? 0,
    });
    return seq;
  }
  const behind = untaken(await sweepsIn(ctx, channel._id, true), row);
  const limit = rangeLimit;
  const deleted = await deletionsIn(ctx, channel._id, row.readSeq, seq, limit + 1);
  const mentioned = await mentionsIn(ctx, channel._id, memberId, row.readSeq, seq, limit + 1);
  let to = seq;
  if (deleted.length > limit) to = Math.min(to, deleted[limit - 1]!.seq);
  if (mentioned.length > limit) to = Math.min(to, mentioned[limit - 1]!.seq);
  await ctx.db.patch(row._id, {
    readSeq: to,
    readAt: Date.now(),
    deletedThrough: (row.deletedThrough ?? 0) + behind + deleted.filter((d) => d.seq <= to).length,
    deletionSync: deletedTotal,
    mentionsThrough: (row.mentionsThrough ?? 0) + mentioned.filter((m) => m.seq <= to).length,
  });
  if (to < seq) {
    await ctx.scheduler.runAfter(0, internal.channels.continueRead, {
      channelId: channel._id,
      memberId,
      seq,
      generation: row.readGeneration ?? 0,
    });
  }
  return to;
}

/**
 * Mark unread: moves the read point back to just before `seq`, so that message and everything after
 * it count as unread again, with the counts exact for the new point. It takes back the deletions and
 * mentions it passes, at most `RANGE_LIMIT` of each; a longer stretch returns null and changes nothing.
 * Mentions already marked seen (channels.markSeen) stay seen.
 */
export async function markUnreadFrom(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  memberId: Id<"members">,
  seq: number,
): Promise<number | null> {
  const row = await ensureRead(ctx, channel, memberId);
  const to = Math.max(0, seq - 1);
  if (to >= row.readSeq) {
    // Already unread from there, but a partial markRead may still be stepping toward it: stop that,
    // and leave the read point where it is.
    await ctx.db.patch(row._id, { readGeneration: (row.readGeneration ?? 0) + 1 });
    return row.readSeq;
  }
  const fresh = (await ctx.db.get(channel._id))!;
  // Deletions still being swept at or below the old read point count as passed until now.
  const behind = untaken(await sweepsIn(ctx, channel._id, true), row);
  const deleted = await deletionsIn(ctx, channel._id, to, row.readSeq, rangeLimit + 1);
  const mentioned = await mentionsIn(ctx, channel._id, memberId, to, row.readSeq, rangeLimit + 1);
  if (deleted.length > rangeLimit || mentioned.length > rangeLimit) return null;
  await ctx.db.patch(row._id, {
    readSeq: to,
    readAt: Date.now(),
    deletedThrough: Math.max(0, (row.deletedThrough ?? 0) + behind - deleted.length),
    deletionSync: fresh.deletedTotal ?? 0,
    mentionsThrough: Math.max(0, (row.mentionsThrough ?? 0) - mentioned.length),
    // A partial markRead still stepping forward stops at its next step (continueRead).
    readGeneration: (row.readGeneration ?? 0) + 1,
  });
  return to;
}

/** Records that a message is addressed to the member. Doing it twice for one message does nothing. */
export async function addMention(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  memberId: Id<"members">,
  message: Pick<Doc<"messages">, "_id" | "seq">,
) {
  if (message.seq === undefined) return;
  const seen = await ctx.db
    .query("mentions")
    .withIndex("by_message_member", (q) => q.eq("messageId", message._id).eq("memberId", memberId))
    .first();
  if (seen) return;
  const row = await ensureRead(ctx, channel, memberId);
  await ctx.db.insert("mentions", { channelId: channel._id, memberId, messageId: message._id, seq: message.seq });
  await ctx.db.patch(row._id, {
    mentionTotal: (row.mentionTotal ?? 0) + 1,
    mentionsThrough: (row.mentionsThrough ?? 0) + (message.seq <= row.readSeq ? 1 : 0),
  });
}

async function dropMention(ctx: MutationCtx, mention: Doc<"mentions">) {
  await ctx.db.delete(mention._id);
  const row = await readRow(ctx, mention.channelId, mention.memberId);
  if (!row) return;
  await ctx.db.patch(row._id, {
    mentionTotal: Math.max(0, (row.mentionTotal ?? 0) - 1),
    mentionsThrough: Math.max(0, (row.mentionsThrough ?? 0) - (mention.seq <= row.readSeq ? 1 : 0)),
  });
}

/** The message no longer addresses this member (an edit took the mention out). */
export async function removeMention(ctx: MutationCtx, messageId: Id<"messages">, memberId: Id<"members">) {
  const mention = await ctx.db
    .query("mentions")
    .withIndex("by_message_member", (q) => q.eq("messageId", messageId).eq("memberId", memberId))
    .first();
  if (mention) await dropMention(ctx, mention);
}

/**
 * Takes a deleted message out of every count: its mentions, its alerts, and unread for whoever
 * hadn't read it. The deletion counts at once; the rows of whoever it reached change in a sweep.
 */
export async function forgetMessage(ctx: MutationCtx, channelId: Id<"channels">, message: Pick<Doc<"messages">, "_id" | "seq">) {
  const channel = await ctx.db.get(channelId);
  if (!channel) return;
  const seq = message.seq;
  let counted: { seq: number; deletion: number } | undefined;
  if (seq !== undefined) {
    const recorded = await ctx.db
      .query("deletions")
      .withIndex("by_channel_seq", (q) => q.eq("channelId", channelId).eq("seq", seq))
      .first();
    if (!recorded) {
      const deletion = (channel.deletedTotal ?? 0) + 1;
      await ctx.db.insert("deletions", { channelId, seq });
      await ctx.db.patch(channelId, { deletedTotal: deletion });
      counted = { seq, deletion };
    }
  }
  const sweepId = await ctx.db.insert("messageSweeps", {
    teamId: channel.teamId,
    channelId,
    messageId: message._id,
    kind: "deleted",
    ...counted,
  });
  await sweepStep(ctx, sweepId, { phase: "mentions", cursor: null });
}

/**
 * @everyone was edited out of a message: whoever it reached that it no longer names or answers
 * loses it from their count, in a sweep.
 */
export async function forgetEveryone(ctx: MutationCtx, channel: Doc<"channels">, messageId: Id<"messages">) {
  const sweepId = await ctx.db.insert("messageSweeps", { teamId: channel.teamId, channelId: channel._id, messageId, kind: "everyone" });
  await sweepStep(ctx, sweepId, { phase: "mentions", cursor: null });
}

export type SweepPhase = "mentions" | "alerts" | "reads";

/**
 * One step of a sweep, SWEEP_BATCH rows: the message's mentions (each member's count with them),
 * then for a deletion its alerts, then the read rows already past it, which take the deletion into
 * `deletedThrough`. It schedules the next step, or deletes the sweep after the last. Scheduled
 * mutations run exactly once (docs.convex.dev, Scheduled Functions), and every row it changes is
 * changed once: a dropped mention is gone, and a read row that caught up is skipped.
 */
export async function sweepStep(
  ctx: MutationCtx,
  sweepId: Id<"messageSweeps">,
  state: { phase: SweepPhase; cursor: string | null },
) {
  const sweep = await ctx.db.get(sweepId);
  if (!sweep) return;
  let { phase, cursor } = state;
  let budget = SWEEP_BATCH;
  const later = () => ctx.scheduler.runAfter(0, internal.messages.sweep, { sweepId, phase, cursor });

  if (phase === "mentions") {
    if (sweep.kind === "everyone") {
      // Mentions it keeps stay in the range, so this one pages through it.
      const keep = await stillAddressed(ctx, sweep);
      const page = await ctx.db
        .query("mentions")
        .withIndex("by_message_member", (q) => q.eq("messageId", sweep.messageId))
        .paginate({ numItems: budget, cursor });
      for (const m of page.page) if (!keep.has(m.memberId)) await dropMention(ctx, m);
      if (!page.isDone) {
        cursor = page.continueCursor;
        return await later();
      }
      // An edit changes only mentions; its alerts and unread stay.
      await ctx.db.delete(sweepId);
      return;
    }
    // Every one goes, so each step takes the first ones left.
    const page = await ctx.db
      .query("mentions")
      .withIndex("by_message_member", (q) => q.eq("messageId", sweep.messageId))
      .take(budget);
    for (const m of page) await dropMention(ctx, m);
    budget -= page.length;
    if (budget === 0) return await later();
    phase = "alerts";
  }

  if (phase === "alerts") {
    const alerts = await ctx.db
      .query("messageAlerts")
      .withIndex("by_message_member", (q) => q.eq("messageId", sweep.messageId))
      .take(budget);
    for (const alert of alerts) await ctx.db.delete(alert._id);
    budget -= alerts.length;
    if (budget === 0) return await later();
    phase = "reads";
    cursor = null;
  }

  const channel = await ctx.db.get(sweep.channelId);
  if (sweep.seq !== undefined && sweep.deletion !== undefined && channel) {
    const deletedTotal = channel.deletedTotal ?? 0;
    const sweeps = await sweepsIn(ctx, channel._id, true);
    const page = await ctx.db
      .query("channelReads")
      .withIndex("by_channel_read", (q) => q.eq("channelId", channel._id).gte("readSeq", sweep.seq!))
      .paginate({ numItems: budget, cursor });
    for (const row of page.page) {
      if ((row.deletionSync ?? 0) >= sweep.deletion) continue;
      await ctx.db.patch(row._id, {
        deletedThrough: (row.deletedThrough ?? 0) + untaken(sweeps, row),
        deletionSync: deletedTotal,
      });
    }
    if (!page.isDone) {
      cursor = page.continueCursor;
      return await later();
    }
  }
  await ctx.db.delete(sweepId);
}

/** The member's level in a channel. */
export async function levelOf(ctx: QueryCtx, channel: Doc<"channels">, memberId: Id<"members">): Promise<NotifyLevel> {
  return (await readRow(ctx, channel._id, memberId))?.notify ?? defaultLevel(channel);
}
