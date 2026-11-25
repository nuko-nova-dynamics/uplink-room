/**
 * Writing a chat message (spec #63): the channel's next seq, a thread's counts and faces, and who
 * the message is addressed to (mention counts and banners). messages.post and the room's own
 * posts (call notes, and an agent's answers over A2A, ADR 0024) share it.
 */
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { directMemberIds, directRunIds, isDirect, memberCanSee } from "./channels";
import { isLiveRun, runPerson } from "./runLabels";
import { addMention, levelOf, markReadUpTo, type NotifyLevel } from "./reads";

/**
 * At most this many replies are read to count a parent that has no stored count yet (one from
 * before counts were kept) when a reply is posted to it or deleted from it. Past it the count is
 * left to messages.backfillReplyMeta, which counts every parent exactly.
 */
export const EXACT_COUNT_LIMIT = 1000;

/**
 * Counts a parent's replies exactly, reading at most EXACT_COUNT_LIMIT of them: the count, the
 * newest reply's seq and time, or null when there are more (the backfill counts those).
 */
export async function countReplies(ctx: QueryCtx, parentId: Id<"messages">) {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_reply", (q) => q.eq("replyTo", parentId))
    .take(EXACT_COUNT_LIMIT + 1);
  if (rows.length > EXACT_COUNT_LIMIT) return null;
  let lastReplySeq: number | undefined;
  for (const r of rows) if (r.seq !== undefined && (lastReplySeq === undefined || r.seq > lastReplySeq)) lastReplySeq = r.seq;
  return { replyCount: rows.length, lastReplySeq, lastReplyAt: rows.at(-1)?._creationTime };
}

/** How many of a thread's newest replies are read to find who replied lately, when it isn't kept. */
export const REPLIERS_SCAN = 20;

/** The authors of a thread's newest replies, up to three, newest first, read from its replies. */
export async function scanRepliers(ctx: QueryCtx, parentId: Id<"messages">, scan = REPLIERS_SCAN): Promise<Id<"members">[]> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_reply", (q) => q.eq("replyTo", parentId))
    .order("desc")
    .take(scan);
  const ids: Id<"members">[] = [];
  for (const r of recent) if (r.deletedAt === undefined && !ids.includes(r.authorId) && ids.length < 3) ids.push(r.authorId);
  return ids;
}

/** Gives a new message the channel's next seq. */
export async function nextSeq(ctx: MutationCtx, channelId: Id<"channels">, at: number): Promise<number> {
  const channel = (await ctx.db.get(channelId))!;
  const seq = (channel.lastSeq ?? 0) + 1;
  await ctx.db.patch(channelId, { lastSeq: seq, lastMessageAt: at });
  return seq;
}

/**
 * A reply was posted to `parent`: its count, newest reply and faces. A parent with no stored count
 * is counted once (bounded); `counted` is that count from before the reply went in, when the caller
 * read it first.
 */
export async function noteReply(
  ctx: MutationCtx,
  parent: Doc<"messages">,
  authorId: Id<"members">,
  seq: number,
  at: number,
  counted?: { replyCount: number } | null,
) {
  const known = parent.replyCount ?? counted?.replyCount;
  // Too many to count here: the newest reply is still kept, so the thread is found; the count
  // waits for the backfill rather than becoming a wrong number.
  await ctx.db.patch(parent._id, {
    lastReplyAt: at,
    lastReplySeq: seq,
    replyRevision: (parent.replyRevision ?? 0) + 1,
    ...(known !== undefined ? { replyCount: known + 1 } : {}),
    // This reply is in the scan already, newest: a thread not kept yet starts from its replies.
    repliers:
      parent.repliers === undefined
        ? await scanRepliers(ctx, parent._id)
        : [authorId, ...parent.repliers.filter((id) => id !== authorId)].slice(0, 3),
  });
}

/**
 * Whether `memberId` wrote `message` themselves. A run's message is stored under its driver (ADR
 * 0029 D2), but the driver didn't write it: it is unread for them, can mention and reach them, and
 * can be delivered to an agent driving the run. Who answers for it, and who may edit or delete it,
 * still go by its author.
 */
export function wroteIt(message: Pick<Doc<"messages">, "authorId" | "asRun">, memberId: Id<"members">): boolean {
  return message.authorId === memberId && message.asRun === undefined;
}

export const ALERT_ORDER = ["mention", "reply", "everyone", "direct", "all"] as const;
export type AlertReason = (typeof ALERT_ORDER)[number];

/** Whether a member at `level` gets a banner for a message addressed to them for `reason`. */
function alertsAt(level: NotifyLevel, reason: AlertReason): boolean {
  if (level === "none") return false;
  if (level === "mentions") return reason === "mention" || reason === "reply" || reason === "everyone";
  return true;
}

/** How many members one fan-out step reaches (@everyone, and channels set to all). */
export const FANOUT_BATCH = 100;

/**
 * An alert for one member about one message, once: a later step that reaches them again adds none.
 * It is stamped with when it was written and the member's next alert seq, not the message's time:
 * an @everyone step can reach someone after newer messages did, and the app orders banners by
 * delivery. The seq comes from one row per member, so mutations alerting the same member
 * serialize and each alert gets a higher seq than any committed before it.
 */
export async function alertOnce(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  memberId: Id<"members">,
  reason: AlertReason,
) {
  const had = await ctx.db
    .query("messageAlerts")
    .withIndex("by_message_member", (q) => q.eq("messageId", message._id).eq("memberId", memberId))
    .first();
  if (had) return;
  const counter = await ctx.db
    .query("alertSeqs")
    .withIndex("by_member", (q) => q.eq("memberId", memberId))
    .unique();
  const seq = (counter?.seq ?? 0) + 1;
  if (counter) await ctx.db.patch(counter._id, { seq });
  else await ctx.db.insert("alertSeqs", { memberId, seq });
  await ctx.db.insert("messageAlerts", {
    teamId: channel.teamId,
    memberId,
    channelId: channel._id,
    messageId: message._id,
    reason,
    at: Date.now(),
    seq,
  });
}

/** Counts a message as addressed to a member, and alerts them if their level asks for it. */
export async function reach(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  memberId: Id<"members">,
  reason: AlertReason,
) {
  // Never someone outside a direct message or private channel, such as the author of a message
  // being replied to who has since left: they'd find it counted when they come back (ADR 0016).
  if (!(await memberCanSee(ctx, channel, memberId))) return;
  const level = await levelOf(ctx, channel, memberId);
  // @everyone doesn't reach someone who set the channel to nothing (story 12b).
  if (reason === "mention" || reason === "reply" || (reason === "everyone" && level !== "none")) {
    await addMention(ctx, channel, memberId, message);
  }
  if (alertsAt(level, reason)) await alertOnce(ctx, channel, message, memberId, reason);
}

/**
 * After a post: mention counts for whoever it is addressed to, and an alert (for banners) for each
 * member whose level asks for one. The author gets neither. The people it names, the author of the
 * message it replies to and a direct message's members (at most 10) are reached at once. @everyone
 * in a team channel (the whole team) or a private channel (its members only), and channels set to
 * all, go out in scheduled steps of FANOUT_BATCH members after the post has committed (`fanOut`).
 */
export async function address(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  mentioned: Id<"members">[],
  parentAuthor: Id<"members"> | undefined,
) {
  const reasons = new Map<Id<"members">, AlertReason>();
  const give = (memberId: Id<"members">, reason: AlertReason) => {
    // A run can still reach its driver, under whom its message is stored (`wroteIt`).
    if (wroteIt(message, memberId)) return;
    const had = reasons.get(memberId);
    if (!had || ALERT_ORDER.indexOf(reason) < ALERT_ORDER.indexOf(had)) reasons.set(memberId, reason);
  };
  for (const id of mentioned) give(id, "mention");
  if (parentAuthor) give(parentAuthor, "reply");
  if (isDirect(channel)) {
    const direct = await directMemberIds(ctx, channel);
    // A live run's person is in a direct message for their run: a message there is to the run, and
    // doesn't banner them unless it names them (ADR 0029 D19).
    const forRuns = message.mentionsEveryone ? new Set<Id<"members">>() : await runPeopleIn(ctx, channel);
    for (const id of direct) if (!forRuns.has(id)) give(id, message.mentionsEveryone ? "everyone" : "direct");
  }
  for (const [memberId, reason] of reasons) await reach(ctx, channel, message, memberId, reason);
  if (isDirect(channel)) return;
  if (message.mentionsEveryone) {
    await ctx.scheduler.runAfter(0, internal.messages.fanOut, { messageId: message._id, phase: "everyone", cursor: null });
  } else {
    await scheduleAll(ctx, channel, message);
  }
}

/**
 * Who a reply notifies as the thread's author: the author of the thread's first message (`parent`),
 * unless the reply is for a run (ADR 0029 D19). It is when the first message is a run's, or when
 * the message it was written under (`replyTarget`) is a run's that its driver, the thread's author,
 * answers for: a reply to the run isn't a reply to its driver.
 */
export function replyAuthor(parent: Doc<"messages"> | undefined, replyTarget?: Doc<"messages"> | undefined): Id<"members"> | undefined {
  if (!parent || parent.asRun) return undefined;
  if (replyTarget?.asRun && replyTarget.authorId === parent.authorId) return undefined;
  return parent.authorId;
}

/** The people of the live runs in a direct message. */
async function runPeopleIn(ctx: QueryCtx, channel: Doc<"channels">): Promise<Set<Id<"members">>> {
  const people = new Set<Id<"members">>();
  for (const runId of await directRunIds(ctx, channel)) {
    const run = await ctx.db.get(runId);
    if (!run || !(await isLiveRun(ctx, run))) continue;
    const person = await runPerson(ctx, run);
    if (person) people.add(person._id);
  }
  return people;
}

/** The "all" step, when someone set the channel to all. */
export async function scheduleAll(ctx: MutationCtx, channel: Doc<"channels">, message: Doc<"messages">) {
  const loud = await ctx.db
    .query("channelReads")
    .withIndex("by_channel_notify", (q) => q.eq("channelId", channel._id).eq("notify", "all"))
    .first();
  if (loud) await ctx.scheduler.runAfter(0, internal.messages.fanOut, { messageId: message._id, phase: "all", cursor: null });
}

/**
 * A message the room posts for a member, such as an agent's answer over A2A (ADR 0024): Markdown,
 * at the channel's next seq, in a thread when `parent` is given, and addressed as a post is (a
 * direct message's members, the author of the message it replies to, the members it names).
 * `extra` holds the fields only the room sets (a2a, and the runs the message addresses).
 */
export async function postAs(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  authorId: Id<"members">,
  body: string,
  opts: {
    parent?: Doc<"messages"> | undefined;
    mentioned?: Id<"members">[];
    mentionedRuns?: Id<"runs">[];
    extra?: Pick<Partial<Doc<"messages">>, "a2a" | "addressedRuns">;
  } = {},
): Promise<Doc<"messages">> {
  const now = Date.now();
  const parent = opts.parent;
  const counted = parent && parent.replyCount === undefined ? await countReplies(ctx, parent._id) : undefined;
  const seq = await nextSeq(ctx, channel._id, now);
  const mentioned = opts.mentioned ?? [];
  const id = await ctx.db.insert("messages", {
    teamId: channel.teamId,
    channelId: channel._id,
    authorId,
    format: "markdown",
    body,
    ...(parent ? { replyTo: parent._id } : {}),
    mentionedTasks: [],
    mentionedRuns: opts.mentionedRuns ?? [],
    ...(mentioned.length ? { mentionedMembers: mentioned } : {}),
    seq,
    ...opts.extra,
  });
  if (parent) await noteReply(ctx, parent, authorId, seq, now, counted);
  await markReadUpTo(ctx, channel, authorId, seq);
  const message = (await ctx.db.get(id))!;
  await address(ctx, channel, message, mentioned, replyAuthor(parent));
  return message;
}
