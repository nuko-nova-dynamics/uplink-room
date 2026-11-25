/**
 * Chat (spec #3, and spec #63 for what replaces Discord): posting, replies, editing, deleting,
 * reactions, mentions of people and @everyone, attachments, pins, link previews, scrollback,
 * search, and the messages addressed to you that banners come from.
 *
 * Every function here reaches a channel through lib/channels.ts, directly or through `inTeam`:
 * someone who can't see a direct message or private channel gets `not_found` for anything in it
 * (ADR 0015, ADR 0016).
 */
import { v, type ObjectType } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAdmin, type Actor } from "./lib/actor";
import { checkDecider, decideProposal, mayDecide, proposalMessageDeleted } from "./lib/a2a/conversations";
import { resolveAddressedRuns, resolveMentions, routeMessage } from "./lib/router";
import { directWarnings, requireAcknowledged } from "./lib/runWarnings";
import {
  attachmentsOf,
  attachmentView,
  grantUrl,
  LINK_TTL_MS,
  checkAttachment,
  dropAttachments,
  keepAttachments,
  vNewAttachment,
  type CheckedAttachment,
} from "./lib/attachments";
import {
  canSee,
  channelAccess,
  directMemberIds,
  hasMemberList,
  isDirect,
  kindOf,
  memberCanSee,
  messageAccess,
} from "./lib/channels";
import { roomError } from "./lib/errors";
import { linkPreviewsOn, previewLinks, previewViews, requestPreviews } from "./lib/linkPreview";
import { inTeam, memberView, type MemberView } from "./lib/members";
import {
  isSingleEmoji,
  MAX_ATTACHMENTS,
  MAX_DISTINCT_REACTIONS,
  mentionTokens,
  plainPreview,
  REACTION_NAMES,
} from "./lib/messages";
import { runNamer, runNamesIn, type RunNamer } from "./lib/runLabels";
import {
  addMention,
  forgetEveryone,
  forgetMessage,
  levelOf,
  markReadUpTo,
  readSummary,
  removeMention,
  sweepStep,
} from "./lib/reads";
import { roomMutation, roomQuery } from "./lib/room";
import { IDEMPOTENCY_DOC, once, vIdempotencyKey } from "./lib/idempotency";
import { setTyping } from "./lib/typing";
import { sha256 } from "./lib/crypto";
import {
  address,
  alertOnce,
  countReplies,
  nextSeq,
  noteReply,
  reach,
  replyAuthor,
  scanRepliers,
  scheduleAll,
  wroteIt,
  EXACT_COUNT_LIMIT,
  FANOUT_BATCH,
} from "./lib/chat";

export { EXACT_COUNT_LIMIT, FANOUT_BATCH };

/** At most this many pinned messages per channel. */
export const MAX_PINS = 50;
/** Alerts (messages.addressed) are kept this long. */
export const ALERTS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const EVERYONE = /(^|[^\w@])@everyone\b/i;

// ---------- views ----------

/** Who is reading, with caches for one query. */
type Viewer = {
  actor: Actor;
  previewsOn: boolean;
  names: Map<string, string>;
  restricted: Map<string, boolean>;
  /** Each author looked up once per query: a long thread has a few authors and many replies. */
  members: Map<string, ReturnType<typeof memberView>>;
  /** Names runs, such as Claude Code (Julio), reading the team's live runs once per query. */
  runName: RunNamer;
};

async function viewerFor(ctx: QueryCtx, actor: Actor): Promise<Viewer> {
  return {
    actor,
    previewsOn: await linkPreviewsOn(ctx, actor.teamId),
    names: new Map(),
    restricted: new Map(),
    members: new Map(),
    runName: runNamer(ctx),
  };
}

/** The runs a message is addressed to, each with its name now (an ended run's harness and last driver). */
async function addressedViews(ctx: QueryCtx, viewer: Viewer, m: Doc<"messages">) {
  const out: { runId: Id<"runs">; label: string }[] = [];
  for (const runId of m.addressedRuns ?? []) {
    const run = await ctx.db.get(runId);
    out.push({ runId, label: run ? await viewer.runName(run) : "A run that was deleted" });
  }
  return out;
}

/** A message's delivery records, read only for a message that has some. */
async function deliveryViews(ctx: QueryCtx, viewer: Viewer, m: Doc<"messages">) {
  if (!m.deliveryCount) return [];
  const rows = await ctx.db
    .query("agentDeliveries")
    .withIndex("by_message", (q) => q.eq("messageId", m._id))
    .take(20);
  return Promise.all(
    rows.map(async (d) => ({
      to: await memberOf(ctx, viewer, d.memberId),
      via: d.via,
      status: d.status,
      ...(d.reason ? { reason: d.reason } : {}),
      at: d.at,
      ...(d.settledAt !== undefined ? { settledAt: d.settledAt } : {}),
    })),
  );
}

function memberOf(ctx: QueryCtx, viewer: Viewer, memberId: Id<"members">) {
  let view = viewer.members.get(memberId);
  if (!view) viewer.members.set(memberId, (view = memberView(ctx, memberId)));
  return view;
}

/** Whether a channel keeps its attachments behind short-lived links: a direct message or private channel. */
async function restrictedChannel(ctx: QueryCtx, viewer: Viewer, channelId: Id<"channels">): Promise<boolean> {
  const known = viewer.restricted.get(channelId);
  if (known !== undefined) return known;
  const channel = await ctx.db.get(channelId);
  const restricted = !channel || hasMemberList(channel);
  viewer.restricted.set(channelId, restricted);
  return restricted;
}

async function nameOf(ctx: QueryCtx, viewer: Viewer, memberId: Id<"members">): Promise<string> {
  const known = viewer.names.get(memberId);
  if (known !== undefined) return known;
  const member = await ctx.db.get(memberId);
  const name = member?.name ?? "Former member";
  viewer.names.set(memberId, name);
  return name;
}

async function reactionViews(ctx: QueryCtx, viewer: Viewer, m: Doc<"messages">) {
  return Promise.all(
    (m.reactions ?? []).map(async (r) => ({
      emoji: r.emoji,
      count: r.memberIds.length,
      mine: r.memberIds.includes(viewer.actor.member._id),
      names: await Promise.all(r.memberIds.slice(0, REACTION_NAMES).map((id) => nameOf(ctx, viewer, id))),
    })),
  );
}

function mentionedOf(m: Doc<"messages">): Id<"members">[] {
  return m.mentionedMembers ?? m.mentionedAgents ?? [];
}

/**
 * The message a thread hangs off. Threads are one level, so a reply addressed to a reply, or to the
 * channel's row for a reply also sent there (echoOf), goes to that reply's thread. An app from before
 * Also send shows that row as the reply itself and answers it by the reply's id.
 */
async function threadRoot(ctx: QueryCtx, message: Doc<"messages">): Promise<Doc<"messages">> {
  const shown = message.echoOf ? ((await ctx.db.get(message.echoOf)) ?? message) : message;
  const root = shown.replyTo ? await ctx.db.get(shown.replyTo) : null;
  return root ?? shown;
}

/** The same when showing a thread kept from before `repliers` was: few, as a channel page shows many. */
const REPLIERS_SHOW_SCAN = 6;

/** Who replied lately, for faces on the thread's row: kept on the parent, else a short read of its newest replies. */
async function repliersOf(ctx: QueryCtx, viewer: Viewer, parent: Doc<"messages">) {
  const ids = parent.repliers ?? (await scanRepliers(ctx, parent._id, REPLIERS_SHOW_SCAN));
  return Promise.all(ids.map((id) => memberOf(ctx, viewer, id)));
}

/** A message as the app shows it. A reply also sent to the channel shows there as that reply, with its thread named. */
async function messageView(ctx: QueryCtx, viewer: Viewer, m: Doc<"messages">) {
  if (m.echoOf === undefined) return baseView(ctx, viewer, m);
  const reply = await ctx.db.get(m.echoOf);
  if (!reply || reply.deletedAt !== undefined) return { ...(await baseView(ctx, viewer, m)), deletedAt: m._creationTime };
  const parent = reply.replyTo ? await ctx.db.get(reply.replyTo) : null;
  return {
    ...(await baseView(ctx, viewer, reply)),
    threadOf: parent
      ? {
          messageId: parent._id,
          author: await memberOf(ctx, viewer, parent.authorId),
          excerpt: parent.deletedAt !== undefined ? "" : parent.body.replace(/\s+/g, " ").slice(0, 140),
        }
      : undefined,
  };
}

async function baseView(ctx: QueryCtx, viewer: Viewer, m: Doc<"messages">) {
  const me = viewer.actor.member._id;
  const mentioned = mentionedOf(m);
  const deleted = m.deletedAt !== undefined;
  const attachments = deleted ? [] : await attachmentsOf(ctx, m);
  return {
    messageId: m._id,
    channelId: m.channelId,
    /** Its place in the channel, for the "new" divider; absent on messages from before unread counts. */
    seq: m.seq,
    author: await memberOf(ctx, viewer, m.authorId),
    format: m.format,
    body: m.body,
    replyTo: m.replyTo,
    // Kept on the parent; one from before counts were kept shows none until the backfill counts it.
    replyCount: m.replyCount ?? 0,
    lastReplyAt: m.lastReplyAt,
    /**
     * The newest reply's place in the channel (replies share the channel's seqs): past your read
     * point (channels.list readSeq), the thread has a reply you haven't read.
     */
    lastReplySeq: m.lastReplySeq,
    /** Up to three people or agents who replied most lately, newest first, for faces on the thread's row. */
    repliers: (m.replyCount ?? 0) > 0 ? await repliersOf(ctx, viewer, m) : [],
    mentionedTasks: m.mentionedTasks,
    mentionedRuns: m.mentionedRuns,
    /**
     * The live runs it is addressed to (`<@run:runId>` in the body, or addressedRuns), each with its
     * name now, such as Claude Code (Julio). Unlike mentionedRuns, a link chip, these are runs it is for.
     */
    addressedRuns: deleted ? [] : await addressedViews(ctx, viewer, m),
    /** Posted by a live run as itself: the run and the name it had then. author is its driver then, who answers for it. */
    asRun: m.asRun,
    /**
     * Agents it reached that the room can't follow (slice 14 of #139): sent to a routine webhook
     * (sending, sent, or failed with the reason), or waiting for an agent that checks in on its own
     * schedule (waiting, then seen once it read the place).
     */
    deliveries: deleted ? [] : await deliveryViews(ctx, viewer, m),
    /** The runs it was sent to over A2A (ADR 0024): the app shows their chip on the agent's answer, not here. */
    a2aRuns: m.a2aRuns ?? [],
    /** Posted by the room for an agent over A2A: its run, and a thread proposal waiting for Yes or No. */
    a2a: m.a2a
      ? {
          runId: m.a2a.runId,
          proposal: m.a2a.proposal
            ? {
                title: m.a2a.proposal.title,
                status: m.a2a.proposal.status,
                expiresAt: m.a2a.proposal.expiresAt,
                triggerMessageId: m.a2a.proposal.triggerMessageId,
                decidedBy: m.a2a.proposal.decidedBy ? await memberOf(ctx, viewer, m.a2a.proposal.decidedBy) : undefined,
                decidedAt: m.a2a.proposal.decidedAt,
                /** Canceled: why no thread opened (the run stopped, or a message was deleted). */
                reason: m.a2a.proposal.reason,
                /** Whether you may answer it (messages.answerProposal). */
                canDecide: m.a2a.proposal.status === "pending" && (await mayDecide(ctx, viewer.actor, m)),
              }
            : undefined,
        }
      : undefined,
    mentionedAgents: m.mentionedAgents ?? [],
    mentionedMembers: mentioned,
    mentionsEveryone: m.mentionsEveryone === true,
    /**
     * You are named in it, or it is for @everyone, and someone else wrote it: a message never
     * addresses its own author, as its counts and banners don't (`address`). A run you drive that
     * names you did write to you.
     */
    mentionsMe: !deleted && !wroteIt(m, me) && (mentioned.includes(me) || m.mentionsEveryone === true),
    reactions: deleted ? [] : await reactionViews(ctx, viewer, m),
    attachments: await Promise.all(
      attachments.map(async (a) => attachmentView(ctx, a, await restrictedChannel(ctx, viewer, m.channelId))),
    ),
    previews:
      deleted || m.previewsHidden || !viewer.previewsOn ? [] : await previewViews(ctx, m.previewUrls ?? []),
    previewsHidden: m.previewsHidden === true,
    pinned:
      m.pinnedAt !== undefined && m.pinnedBy
        ? { at: m.pinnedAt, by: await memberOf(ctx, viewer, m.pinnedBy) }
        : undefined,
    /** A line the room wrote, such as "Ana pinned a message", shown centered. */
    system: m.system,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    postedAt: m._creationTime,
    /** On a thread reply shown in the channel too (Also send to #channel): the thread's first message. */
    threadOf: undefined as { messageId: Id<"messages">; author: MemberView; excerpt: string } | undefined,
  };
}

export type MessageView = Awaited<ReturnType<typeof messageView>>;

// ---------- writing helpers ----------

async function checkAll(ctx: QueryCtx, actor: Actor, items: { uploadId: Id<"uploads">; storageId: Id<"_storage">; name: string }[]) {
  const checked: CheckedAttachment[] = [];
  for (const item of items) checked.push(await checkAttachment(ctx, actor, item));
  return checked;
}

/**
 * One step of a channel's fan-out: FANOUT_BATCH members reached by @everyone (the team in a team
 * channel, the members of a private channel), then everyone who set the channel to all and can
 * still see it (someone who left a private channel keeps their read row). Each step schedules the next. Each @everyone step checks the message still
 * says @everyone, since its author may have edited it out since the post or the step before. Scheduled mutations run exactly once
 * (docs.convex.dev, Scheduled Functions), and mentions and alerts are kept once per member and
 * message anyway, so a step that reaches someone twice adds nothing.
 */
export const fanOut = internalMutation({
  args: { messageId: v.id("messages"), phase: v.union(v.literal("everyone"), v.literal("all")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { messageId, phase, cursor }) => {
    const message = await ctx.db.get(messageId);
    if (!message || message.deletedAt !== undefined) return null;
    const channel = await ctx.db.get(message.channelId);
    if (!channel) return null;
    if (phase === "everyone") {
      // Edited away while this step waited: no more @everyone, but members set to all still hear of it.
      if (message.mentionsEveryone !== true) {
        await scheduleAll(ctx, channel, message);
        return null;
      }
      // A private channel's @everyone reaches only its members (ADR 0016).
      const page = hasMemberList(channel)
        ? await ctx.db
            .query("channelMembers")
            .withIndex("by_channel_member", (q) => q.eq("channelId", channel._id))
            .paginate({ numItems: FANOUT_BATCH, cursor })
        : await ctx.db
            .query("members")
            .withIndex("by_team", (q) => q.eq("teamId", channel.teamId))
            .paginate({ numItems: FANOUT_BATCH, cursor });
      for (const row of page.page) {
        const member = "memberId" in row ? await ctx.db.get(row.memberId) : row;
        if (!member || member.removedAt !== undefined || member._id === message.authorId) continue;
        await reach(ctx, channel, message, member._id, "everyone");
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.messages.fanOut, { messageId, phase, cursor: page.continueCursor });
      } else {
        await scheduleAll(ctx, channel, message);
      }
      return null;
    }
    const page = await ctx.db
      .query("channelReads")
      .withIndex("by_channel_notify", (q) => q.eq("channelId", channel._id).eq("notify", "all"))
      .paginate({ numItems: FANOUT_BATCH, cursor });
    for (const row of page.page) {
      if (wroteIt(message, row.memberId) || !(await memberCanSee(ctx, channel, row.memberId))) continue;
      await alertOnce(ctx, channel, message, row.memberId, "all");
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.messages.fanOut, { messageId, phase, cursor: page.continueCursor });
    }
    return null;
  },
});

/** The next step of a sweep that takes a deleted message, or an edited-out @everyone, out of counts (lib/reads.ts). */
export const sweep = internalMutation({
  args: {
    sweepId: v.id("messageSweeps"),
    phase: v.union(v.literal("mentions"), v.literal("alerts"), v.literal("reads")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { sweepId, phase, cursor }) => {
    await sweepStep(ctx, sweepId, { phase, cursor });
    return null;
  },
});

// ---------- posting ----------

const POST_ARGS = {
  channelId: v.id("channels"),
  body: v.string(),
  format: v.optional(v.union(v.literal("markdown"), v.literal("html"))),
  replyTo: v.optional(v.id("messages")),
  mentionedTasks: v.optional(v.array(v.id("tasks"))),
  mentionedRuns: v.optional(v.array(v.id("runs"))),
  mentionedMembers: v.optional(v.array(v.id("members"))),
  mentionedAgents: v.optional(v.array(v.id("members"))),
  mentionEveryone: v.optional(v.boolean()),
  addressedRuns: v.optional(v.array(v.id("runs"))),
  attachments: v.optional(v.array(vNewAttachment)),
  /** With replyTo: show the reply in the channel's list too, as Slack's Also send to #channel. */
  alsoInChannel: v.optional(v.boolean()),
  /**
   * The sender was shown the warning of a direct message opened with a run whose output people
   * outside it can see (`requireAcknowledged`, ADR 0039, amended 2026-11-05). Needed once per sender there.
   */
  acknowledgeWarning: v.optional(v.boolean()),
};

type PostArgs = ObjectType<typeof POST_ARGS>;

/**
 * Posts a message as `actor`: `messages.post`, and a run posting as itself (`bridge:runSay` and
 * `joined.say`, ADR 0026, ADR 0032), which passes `asRun` and acts as the run's driver, so the run
 * can't post where its driver can't (ADR 0016). A run's post doesn't move its driver's read place
 * or typing state: the driver didn't write it.
 */
export async function postMessage(ctx: MutationCtx, actor: Actor, args: PostArgs, asRun?: { runId: Id<"runs">; label: string }): Promise<Id<"messages">> {
  const channel = await channelAccess(ctx, actor, args.channelId);
  if (args.alsoInChannel && !args.replyTo) throw roomError("invalid", "alsoInChannel is for a reply (replyTo).");
  if (channel.archivedAt !== undefined) throw roomError("invalid", "This channel is archived.");
  // A direct message opened with a run whose output people outside it can see says so before it
  // reaches the run: in its history, and to a sender who hasn't acknowledged it (ADR 0039, amended 2026-11-05).
  // A run posting as itself is that output, so it isn't asked.
  const warnings = await directWarnings(ctx, channel);
  if (!asRun) await requireAcknowledged(ctx, actor, channel, warnings, args.acknowledgeWarning);
  const uploads = args.attachments ?? [];
  if (!args.body.trim() && uploads.length === 0) throw roomError("invalid", "A message needs a body or an attachment.");
  if (uploads.length > MAX_ATTACHMENTS) throw roomError("invalid", `A message can have at most ${MAX_ATTACHMENTS} attachments.`);
  if (args.mentionEveryone && actor.kind === "agent") {
    throw roomError("forbidden", "Agents can't mention @everyone, so an agent can't page the whole team.");
  }
  let parent: Doc<"messages"> | undefined;
  let replyTarget: Doc<"messages"> | undefined;
  if (args.replyTo) {
    replyTarget = (await messageAccess(ctx, actor, args.replyTo)).message;
    parent = await threadRoot(ctx, replyTarget);
    if (parent.channelId !== channel._id) {
      throw roomError("invalid", "A reply must be in the same channel as its message.");
    }
    if (parent.deletedAt !== undefined || parent.system) throw roomError("invalid", "That message can't be replied to.");
  }
  for (const taskId of args.mentionedTasks ?? []) await inTeam(ctx, actor, taskId);
  for (const runId of args.mentionedRuns ?? []) await inTeam(ctx, actor, runId);
  const passed = [...(args.mentionedMembers ?? []), ...(args.mentionedAgents ?? [])];
  const mentioned = await resolveMentions(ctx, actor, channel, args.body, passed);
  const addressedRuns = await resolveAddressedRuns(ctx, actor, channel, args.body, args.addressedRuns ?? []);
  const checked = await checkAll(ctx, actor, uploads);
  const format = args.format ?? "markdown";
  // A parent with no stored count is counted once, before this reply goes in (bounded).
  const counted = parent && parent.replyCount === undefined ? await countReplies(ctx, parent._id) : undefined;

  const now = Date.now();
  const seq = await nextSeq(ctx, channel._id, now);
  const mentionedIds = mentioned.map((m) => m._id);
  const agentIds = mentioned.filter((m) => m.kind === "agent").map((m) => m._id);
  const links = previewLinks(args.body, format);
  const messageId = await ctx.db.insert("messages", {
    teamId: actor.teamId,
    channelId: channel._id,
    authorId: actor.member._id,
    ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
    format,
    body: args.body,
    ...(parent ? { replyTo: parent._id } : {}),
    mentionedTasks: args.mentionedTasks ?? [],
    mentionedRuns: args.mentionedRuns ?? [],
    ...(agentIds.length ? { mentionedAgents: agentIds } : {}),
    ...(mentionedIds.length ? { mentionedMembers: mentionedIds } : {}),
    ...(args.mentionEveryone ? { mentionsEveryone: true } : {}),
    ...(addressedRuns.length ? { addressedRuns } : {}),
    ...(asRun ? { asRun } : {}),
    seq,
    ...(checked.length ? { attachmentCount: checked.length } : {}),
    ...(links.length ? { previewUrls: links } : {}),
  });
  if (parent && args.alsoInChannel) {
    const echoId = await ctx.db.insert("messages", {
      teamId: actor.teamId,
      channelId: channel._id,
      authorId: actor.member._id,
      format,
      body: "",
      mentionedTasks: [],
      mentionedRuns: [],
      echoOf: messageId,
    });
    await ctx.db.patch(messageId, { echoId });
  }
  const message = (await ctx.db.get(messageId))!;
  await keepAttachments(ctx, message, checked, 0);
  if (parent) await noteReply(ctx, parent, actor.member._id, seq, now, counted);
  // Posting in a channel means you've read it up to your own message, and you're done typing.
  if (!asRun) {
    await markReadUpTo(ctx, channel, actor.member._id, seq);
    await setTyping(ctx, channel, actor.member._id, null);
  }
  // A reply to a run's message is for the run, not a reply to its driver (ADR 0029 D19).
  await address(ctx, channel, message, mentionedIds, replyAuthor(parent, replyTarget));
  if (links.length) await requestPreviews(ctx, actor.teamId, links);

  // To the A2A agents and live runs it is for (lib/router.ts).
  const agents = mentioned.filter((m) => m.kind === "agent");
  const { a2aRuns: sent } = await routeMessage(ctx, actor, channel, message, parent, { agents, replyTarget });
  if (sent.length) {
    await ctx.db.patch(messageId, { mentionedRuns: [...(args.mentionedRuns ?? []), ...sent], a2aRuns: sent });
  }
  return messageId;
}

export const { person: post, agent: postAgent } = roomMutation({
  name: "messages.post",
  description:
    "Post a message in a channel or direct message. Markdown renders inline; HTML renders in a sandboxed frame. Pass replyTo to reply to a message. Mention people and agents with <@memberId> in the body, or list them in mentionedMembers (mentionedAgents is an older name for the same list, still accepted). Address a live run (runs.live), such as Claude Code (Julio) working in someone's terminal, with <@run:RUNID> in the body or its runId in addressedRuns: the message is for that run, and messages.get lists it in addressedRuns with the run's name. A run token for a run that isn't live, or that you can't message here, stays text; a passed one is refused. In a direct message or private channel, a run can be addressed only when its driver is a member. The run gets the message in its inbox (runs.inbox), labelled with you and the person accountable for you; it also gets every reply under a message it posted, and every message in a direct message opened with it, whose output may be visible to the whole team (channels.openDirect and channels.list give such a run a warning). Your first post in such a direct message is refused with warning_required, naming the run and what its output shows to whom; show that to whoever is writing, and send it again with acknowledgeWarning: true. After that, your posts there go without it. Messaging a run needs only this scope. A run whose driver let only themselves and their agents message it (runs.setHears), or with 50 messages already waiting, doesn't get it, and a line in the place says so. Addressing a run, or replying to its message, doesn't mention its driver. Talking to an agent with an A2A endpoint is a conversation (ADR 0024): mentioning it at a channel's top level, mentioning it in a thread, or writing in a direct message it is in (every A2A agent in a direct message gets each message), sends it the message in that place's conversation, and a reply in a thread that hangs off the agent's message, or that it opened, goes to it without a mention. The message goes to the agent's open task if it has one, or starts a new task in the same A2A context, and carries what was said in the place since the agent last heard from it. The run it went to is listed in mentionedRuns and a2aRuns. The agent answers in the same place, as a message from its member that names the run in a2a.runId; while it works it shows in channels.whoIsTyping. An agent posting needs the runs.start scope to send work. mentionEveryone: true (@everyone) counts as a mention for everyone in the channel except those who set it to none; it starts no runs, and agent keys can't use it. Attach up to 10 files uploaded through messages.attachUrl. Links get previews, fetched by the room. mentionedTasks and mentionedRuns link the message to tasks and runs: the app shows each as a chip under it that opens the task or run, so post a task's result with its taskId (and the runId that did it).",
  scope: "messages.post",
  args: { ...POST_ARGS, idempotencyKey: vIdempotencyKey },
  argDocs: { idempotencyKey: IDEMPOTENCY_DOC },
  handler: (ctx, actor, { idempotencyKey, ...args }) =>
    once(ctx, actor, "messages.post", idempotencyKey, args, () => postMessage(ctx, actor, args)),
});

export const { person: answerProposal, agent: answerProposalAgent } = roomMutation({
  name: "messages.answerProposal",
  description:
    "Answer an agent's proposal to move its work to a thread of its own: a message from the agent whose a2a.proposal is pending (ADR 0024). The answer goes to the agent as its conversation's next message, so an agent key needs the runs.start scope too, and the agent must take work from you. open: true opens the thread under the message that started the work, and the agent goes on there in the same conversation; open: false keeps it where it is. Nobody answering within 30 seconds counts as Yes. Whoever wrote the message it would open under, the run's driver or starter, or an admin can answer. Returns open and, when it opened, threadRootId.",
  scope: "messages.post",
  args: { messageId: v.id("messages"), open: v.boolean() },
  handler: async (ctx, actor, args) => {
    const { message } = await messageAccess(ctx, actor, args.messageId);
    const proposal = message.a2a?.proposal;
    if (!proposal) throw roomError("invalid", "That message isn't an agent's thread proposal.");
    if (proposal.status !== "pending") {
      throw roomError("conflict", proposal.status === "accepted" ? "The thread is already open." : "It was already answered: the agent answers where it is.");
    }
    if (!(await mayDecide(ctx, actor, message))) {
      throw roomError("forbidden", "Only whoever wrote the message it would open under, the run's driver or an admin can answer.");
    }
    // The answer goes to the agent as its conversation's next message: A2A work, checked as runs.reply checks it.
    await checkDecider(ctx, actor, message);
    await decideProposal(ctx, message, args.open, { memberId: actor.member._id, name: actor.member.name });
    return { open: args.open, ...(args.open ? { threadRootId: proposal.triggerMessageId } : {}) };
  },
});

export const { person: attachUrl, agent: attachUrlAgent } = roomMutation({
  name: "messages.attachUrl",
  description:
    "A URL to upload a message attachment to, valid for one hour, and its uploadId. POST the bytes with their Content-Type; the response is { storageId }. Then pass { uploadId, storageId, name } in messages.post or messages.edit attachments. Images (PNG, JPEG, GIF, WebP) up to 20 MB and PDFs up to 50 MB show in the app, and their Content-Type must match the name's extension; SVG is refused. Any other file, up to 50 MB, is only ever offered as a download. Uploads no message keeps are deleted within the hour.",
  scope: "messages.post",
  args: {},
  agentAudit: false,
  handler: async (ctx, actor) => {
    const uploadId = await ctx.db.insert("uploads", { teamId: actor.teamId, uploaderId: actor.member._id });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId };
  },
});

// ---------- editing and deleting ----------

async function editable(ctx: QueryCtx, actor: Actor, messageId: Id<"messages">) {
  const { message, channel } = await messageAccess(ctx, actor, messageId);
  if (message.system) throw roomError("invalid", "A line the room wrote can't be edited.");
  if (message.deletedAt !== undefined) throw roomError("invalid", "That message was deleted.");
  return { message, channel };
}

export const { person: edit, agent: editAgent } = roomMutation({
  name: "messages.edit",
  description:
    "Change a message you posted: its body, and optionally its attachments (addAttachments from messages.attachUrl, removeAttachments by index). Only its author can edit it, admins included. The message then shows as edited. Mentions are worked out again from the new body's <@memberId> tokens plus mentionedMembers, and addressed runs from its <@run:RUNID> tokens plus addressedRuns; a new mention counts for the person's mention count but sends no banner, and a newly mentioned agent or newly addressed run gets nothing. @everyone can be removed by an edit but not added.",
  scope: "messages.post",
  args: {
    messageId: v.id("messages"),
    body: v.string(),
    mentionedMembers: v.optional(v.array(v.id("members"))),
    addressedRuns: v.optional(v.array(v.id("runs"))),
    addAttachments: v.optional(v.array(vNewAttachment)),
    removeAttachments: v.optional(v.array(v.number())),
  },
  handler: async (ctx, actor, args) => {
    const { message, channel } = await editable(ctx, actor, args.messageId);
    if (message.authorId !== actor.member._id) throw roomError("forbidden", "Only its author can edit a message.");
    const current = await attachmentsOf(ctx, message);
    const remove = new Set(args.removeAttachments ?? []);
    for (const index of remove) {
      if (!current.some((a) => a.position === index)) throw roomError("invalid", `This message has no attachment ${index}.`);
    }
    const kept = current.filter((a) => !remove.has(a.position));
    const added = await checkAll(ctx, actor, args.addAttachments ?? []);
    if (kept.length + added.length > MAX_ATTACHMENTS) {
      throw roomError("invalid", `A message can have at most ${MAX_ATTACHMENTS} attachments.`);
    }
    if (!args.body.trim() && kept.length + added.length === 0) {
      throw roomError("invalid", "A message needs a body or an attachment. To take it back, delete it.");
    }
    const mentioned = await resolveMentions(ctx, actor, channel, args.body, args.mentionedMembers ?? []);
    const addressedRuns = await resolveAddressedRuns(ctx, actor, channel, args.body, args.addressedRuns ?? [], message.addressedRuns);
    const before = new Set<string>(mentionedOf(message));
    const after = new Set<string>(mentioned.map((m) => m._id));
    const everyone = message.mentionsEveryone === true && EVERYONE.test(args.body);

    await dropAttachments(ctx, current.filter((a) => remove.has(a.position)));
    for (const [i, row] of kept.entries()) if (row.position !== i) await ctx.db.patch(row._id, { position: i });
    await keepAttachments(ctx, message, added, kept.length);

    const links = previewLinks(args.body, message.format);
    await ctx.db.patch(message._id, {
      body: args.body,
      editedAt: Date.now(),
      mentionedMembers: mentioned.map((m) => m._id),
      mentionedAgents: mentioned.filter((m) => m.kind === "agent").map((m) => m._id),
      mentionsEveryone: everyone ? true : undefined,
      addressedRuns: addressedRuns.length ? addressedRuns : undefined,
      attachmentCount: kept.length + added.length,
      previewUrls: links.length ? links : undefined,
    });
    if (links.length) await requestPreviews(ctx, actor.teamId, links);

    if (message.seq !== undefined) {
      const counted = { _id: message._id, seq: message.seq };
      for (const id of after) {
        if (!before.has(id) && id !== message.authorId) await addMention(ctx, channel, id as Id<"members">, counted);
      }
      // Whoever it no longer addresses loses it from their count. A reply still addresses the author
      // of its message, and @everyone still addresses everyone whose level lets it count (#70).
      if (message.mentionsEveryone === true && !everyone) {
        // @everyone taken out: it can have reached the whole team, so this goes in steps (#69).
        await forgetEveryone(ctx, channel, message._id);
      } else {
        // Not a run's driver: a reply to the run isn't one to them (ADR 0029 D19).
        const parentAuthor = replyAuthor(message.replyTo ? ((await ctx.db.get(message.replyTo)) ?? undefined) : undefined);
        for (const id of before) {
          if (after.has(id) || id === parentAuthor) continue;
          const memberId = id as Id<"members">;
          if (everyone && (await levelOf(ctx, channel, memberId)) !== "none") continue;
          await removeMention(ctx, message._id, memberId);
        }
      }
    }
    return null;
  },
});

/** The author, the person accountable for an agent author, or an admin. */
async function mayDelete(ctx: QueryCtx, actor: Actor, message: Doc<"messages">): Promise<boolean> {
  if (actor.role === "admin" || message.authorId === actor.member._id) return true;
  if (actor.kind !== "person") return false;
  const author = await ctx.db.get(message.authorId);
  if (author?.kind !== "agent" || !author.agentId) return false;
  const agent = await ctx.db.get(author.agentId);
  return agent?.addedBy === actor.member._id;
}

/**
 * Takes a message out: its attachments (and their bytes, unless a project file shares them),
 * alerts, reactions, pin and counts. With replies it stays as a "message deleted" line; without,
 * it goes, and so does a deleted parent left with no replies. Either way it is gone at once; the
 * alerts and counts of an @everyone that reached the whole team follow in steps (lib/reads.ts).
 */
async function removeMessage(ctx: MutationCtx, message: Doc<"messages">, by: Id<"members">) {
  // A reply also shown in the channel leaves the channel with it.
  if (message.echoId) await ctx.db.delete(message.echoId);
  await dropAttachments(ctx, await attachmentsOf(ctx, message));
  await forgetMessage(ctx, message.channelId, message);
  const reply = await ctx.db
    .query("messages")
    .withIndex("by_reply", (q) => q.eq("replyTo", message._id))
    .first();
  if (reply) {
    await ctx.db.patch(message._id, {
      body: "",
      deletedAt: message.deletedAt ?? Date.now(),
      deletedBy: message.deletedBy ?? by,
      reactions: [],
      mentionedMembers: [],
      mentionedAgents: [],
      mentionedTasks: [],
      mentionedRuns: [],
      mentionsEveryone: undefined,
      attachmentCount: 0,
      previewUrls: undefined,
      pinnedAt: undefined,
      pinnedBy: undefined,
    });
    return;
  }
  await ctx.db.delete(message._id);
  if (message.replyTo) {
    const parent = await ctx.db.get(message.replyTo);
    if (!parent) return;
    // The parent's count and newest reply, without the one just deleted. A parent with no stored
    // count is counted once now (bounded); past the bound the count waits for the backfill.
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_reply", (q) => q.eq("replyTo", parent._id))
      .order("desc")
      .first();
    const count = !newest
      ? 0
      : parent.replyCount !== undefined
        ? Math.max(0, parent.replyCount - 1)
        : (await countReplies(ctx, parent._id))?.replyCount;
    await ctx.db.patch(parent._id, {
      ...(count !== undefined ? { replyCount: count } : {}),
      lastReplySeq: newest?.seq,
      lastReplyAt: newest?._creationTime,
      replyRevision: (parent.replyRevision ?? 0) + 1,
      repliers: await scanRepliers(ctx, parent._id),
    });
    if (parent.deletedAt !== undefined) await removeMessage(ctx, (await ctx.db.get(parent._id))!, by);
  }
}

// `delete` is a reserved word, so the person function is exported under it by alias.
const deleteFns = roomMutation({
  name: "messages.delete",
  description:
    "Delete a message: yours, one your agent posted, or (admins) anyone's. A message with replies stays as a \"message deleted\" line so the replies keep their place; one without replies is removed. Its attachments' stored bytes are deleted either way (a copy saved into a project's files stays), and so are its reactions, pin and link previews. Deleting an agent's pending thread proposal, or the message it would open its thread under, cancels the proposal: no thread opens, and the agent is told to answer where it is.",
  scope: "messages.post",
  args: { messageId: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const { message } = await messageAccess(ctx, actor, args.messageId);
    if (message.deletedAt !== undefined) return null;
    if (!(await mayDelete(ctx, actor, message))) {
      throw roomError("forbidden", "Only its author, the person who added the agent that posted it, or an admin can delete a message.");
    }
    // An agent's thread proposal, or the message its thread would open under: no thread opens (ADR 0024).
    await proposalMessageDeleted(ctx, message);
    await removeMessage(ctx, message, actor.member._id);
    return null;
  },
});
const remove = deleteFns.person;
export const deleteAgent = deleteFns.agent;
export { remove as delete };

// ---------- reactions ----------

async function reactable(ctx: QueryCtx, actor: Actor, messageId: Id<"messages">, emoji: string) {
  if (!isSingleEmoji(emoji)) throw roomError("invalid", "A reaction is one emoji, such as 👍 or ✅.");
  const { message } = await editable(ctx, actor, messageId);
  return message;
}

export const { person: react, agent: reactAgent } = roomMutation({
  name: "messages.react",
  description:
    "React to a message with one emoji (any Unicode emoji, such as 👀 when you start on something and ✅ when it's done). Reacting again with the same emoji does nothing. A message can have at most 20 different emoji.",
  scope: "messages.post",
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, actor, args) => {
    const message = await reactable(ctx, actor, args.messageId, args.emoji);
    const reactions = message.reactions ?? [];
    const me = actor.member._id;
    const existing = reactions.find((r) => r.emoji === args.emoji);
    if (existing?.memberIds.includes(me)) return null;
    if (!existing && reactions.length >= MAX_DISTINCT_REACTIONS) {
      throw roomError("invalid", `A message can have at most ${MAX_DISTINCT_REACTIONS} different emoji. React with one it has.`);
    }
    const next = existing
      ? reactions.map((r) => (r.emoji === args.emoji ? { ...r, memberIds: [...r.memberIds, me] } : r))
      : [...reactions, { emoji: args.emoji, memberIds: [me] }];
    await ctx.db.patch(message._id, { reactions: next });
    return null;
  },
});

export const { person: unreact, agent: unreactAgent } = roomMutation({
  name: "messages.unreact",
  description: "Take back your reaction with this emoji. Does nothing if you hadn't reacted with it.",
  scope: "messages.post",
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, actor, args) => {
    const message = await reactable(ctx, actor, args.messageId, args.emoji);
    const me = actor.member._id;
    const next = (message.reactions ?? [])
      .map((r) => (r.emoji === args.emoji ? { ...r, memberIds: r.memberIds.filter((id) => id !== me) } : r))
      .filter((r) => r.memberIds.length > 0);
    await ctx.db.patch(message._id, { reactions: next });
    return null;
  },
});

// ---------- pins ----------

export const { person: pin, agent: pinAgent } = roomMutation({
  name: "messages.pin",
  description:
    "Pin a message in its channel or direct message, so it is in channels.pins. Anyone who can see the channel can pin; a channel can have at most 50 pins. Pinning posts a line in the channel saying who pinned a message. Pinning a pinned message does nothing.",
  scope: "messages.post",
  args: { messageId: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const { message, channel } = await editable(ctx, actor, args.messageId);
    if (message.pinnedAt !== undefined) return null;
    const pins = await ctx.db
      .query("messages")
      .withIndex("by_channel_pinned", (q) => q.eq("channelId", channel._id).gt("pinnedAt", 0))
      .take(MAX_PINS);
    if (pins.length >= MAX_PINS) {
      throw roomError("invalid", `A channel can have at most ${MAX_PINS} pinned messages. Unpin one first.`);
    }
    const now = Date.now();
    await ctx.db.patch(message._id, { pinnedAt: now, pinnedBy: actor.member._id });
    await ctx.db.insert("messages", {
      teamId: actor.teamId,
      channelId: channel._id,
      authorId: actor.member._id,
      ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
      format: "markdown",
      body: "",
      mentionedTasks: [],
      mentionedRuns: [],
      system: { kind: "pinned", messageId: message._id },
    });
    await ctx.db.patch(channel._id, { lastMessageAt: now });
    return null;
  },
});

export const { person: unpin, agent: unpinAgent } = roomMutation({
  name: "messages.unpin",
  description: "Unpin a message. Only whoever pinned it, or an admin, can unpin it.",
  scope: "messages.post",
  args: { messageId: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const { message } = await messageAccess(ctx, actor, args.messageId);
    if (message.pinnedAt === undefined) return null;
    if (message.pinnedBy !== actor.member._id) {
      try {
        requireAdmin(actor);
      } catch {
        throw roomError("forbidden", "Only whoever pinned this message, or an admin, can unpin it.");
      }
    }
    await ctx.db.patch(message._id, { pinnedAt: undefined, pinnedBy: undefined });
    return null;
  },
});

// ---------- link previews ----------

export const { person: hidePreview, agent: hidePreviewAgent } = roomMutation({
  name: "messages.hidePreview",
  description: "Remove the link previews from a message you posted. Only its author can.",
  scope: "messages.post",
  args: { messageId: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const { message } = await editable(ctx, actor, args.messageId);
    if (message.authorId !== actor.member._id) {
      throw roomError("forbidden", "Only its author can remove a message's link previews.");
    }
    await ctx.db.patch(message._id, { previewsHidden: true });
    return null;
  },
});

// ---------- reading ----------

/** A message the actor can see, or null: missing and hidden look the same (lib/channels.ts). */
async function visibleMessage(ctx: QueryCtx, actor: Actor, messageId: Id<"messages">) {
  const message = await ctx.db.get(messageId);
  if (!message || message.teamId !== actor.teamId) return null;
  const channel = await ctx.db.get(message.channelId);
  return channel && (await canSee(ctx, actor, channel)) ? message : null;
}

const topLevel = (ctx: QueryCtx, channelId: Id<"channels">) =>
  ctx.db.query("messages").withIndex("by_channel_top", (q) => q.eq("channelId", channelId).eq("replyTo", undefined));

export const { person: list, agent: listAgent } = roomQuery({
  name: "messages.list",
  description:
    "Page through a channel's messages, newest first, without replies (see messages.replies). Pass cursor: null for the newest page and then each page's continueCursor, until isDone; limit is the page size (default 50, at most 200). Returns { page, continueCursor, isDone }. Without cursor (older callers), it returns the last limit messages (default 100) as a list, oldest first.",
  scope: "room.read",
  args: {
    channelId: v.id("channels"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    /** Convex's usePaginatedQuery (the desktop app) passes this instead of cursor and limit. */
    paginationOpts: v.optional(paginationOptsValidator),
  },
  argDocs: { paginationOpts: { hidden: true } },
  handler: async (ctx, actor, args) => {
    await channelAccess(ctx, actor, args.channelId);
    const viewer = await viewerFor(ctx, actor);
    if (args.paginationOpts || args.cursor !== undefined) {
      const opts = args.paginationOpts
        ? { ...args.paginationOpts, numItems: Math.min(Math.max(args.paginationOpts.numItems, 1), 200) }
        : { numItems: Math.min(Math.max(args.limit ?? 50, 1), 200), cursor: args.cursor ?? null };
      const result = await topLevel(ctx, args.channelId).order("desc").paginate(opts);
      return { ...result, page: await Promise.all(result.page.map((m) => messageView(ctx, viewer, m))) };
    }
    const recent = await topLevel(ctx, args.channelId)
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 100, 1), 200));
    return Promise.all(recent.reverse().map((m) => messageView(ctx, viewer, m)));
  },
});

export const { person: around, agent: aroundAgent } = roomQuery({
  name: "messages.around",
  description:
    "The messages around one message, oldest first, to open a channel at it: up to limit (default 25, at most 50) before and after it, with hasOlder and hasNewer. For a reply, the page is around the message it replies to (anchorId), and targetId is the reply. Null when there is no such message you can see, such as one deleted since you were sent to it.",
  scope: "room.read",
  args: { messageId: v.id("messages"), limit: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    const found = await visibleMessage(ctx, actor, args.messageId);
    if (!found) return null;
    const message = found;
    const anchor = (message.replyTo ? await ctx.db.get(message.replyTo) : null) ?? message;
    const n = Math.min(Math.max(args.limit ?? 25, 1), 50);
    const before = await ctx.db
      .query("messages")
      .withIndex("by_channel_top", (q) =>
        q.eq("channelId", anchor.channelId).eq("replyTo", undefined).lt("_creationTime", anchor._creationTime),
      )
      .order("desc")
      .take(n + 1);
    const after = await ctx.db
      .query("messages")
      .withIndex("by_channel_top", (q) =>
        q.eq("channelId", anchor.channelId).eq("replyTo", undefined).gt("_creationTime", anchor._creationTime),
      )
      .order("asc")
      .take(n + 1);
    const viewer = await viewerFor(ctx, actor);
    const rows = [...before.slice(0, n).reverse(), anchor, ...after.slice(0, n)];
    return {
      messages: await Promise.all(rows.map((m) => messageView(ctx, viewer, m))),
      anchorId: anchor._id,
      targetId: message._id,
      hasOlder: before.length > n,
      hasNewer: after.length > n,
    };
  },
});

export const { person: replies, agent: repliesAgent } = roomQuery({
  name: "messages.replies",
  description: "List the replies to a message, oldest first.",
  scope: "room.read",
  args: { messageId: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const root = await threadRoot(ctx, (await messageAccess(ctx, actor, args.messageId)).message);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_reply", (q) => q.eq("replyTo", root._id))
      .collect();
    const viewer = await viewerFor(ctx, actor);
    return Promise.all(rows.map((m) => messageView(ctx, viewer, m)));
  },
});

/** At most this many of a thread's newest replies are looked at to count what's new in it. */
export const NEW_REPLY_SCAN = 200;
/** The count of new replies a thread reports stops here (the app shows "99+"). */
export const NEW_REPLY_CAP = 99;

export const { person: unreadThreads, agent: unreadThreadsAgent } = roomQuery({
  name: "messages.unreadThreads",
  description:
    "The threads in a channel or direct message with replies you haven't read, newest reply first: each parent message (with replyCount and lastReplySeq), and newReplies, how many of its replies past your read point (channels.list readSeq) someone else wrote (a run you drive counts as someone else), counted from the newest and stopping at 99 (moreNew: true past that), and firstNewSeq, the seq of its oldest reply past your read point (absent when the count stopped short of it): a read point moved past it would mark that reply read unseen. It doesn't depend on which messages you have loaded. Pass cursor null and then each continueCursor until isDone; limit is the page size (default 10, at most 25). Threads last replied to before replies were counted on their parent aren't listed.",
  scope: "room.read",
  args: { channelId: v.id("channels"), cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    const me = actor.member._id;
    const { readSeq } = await readSummary(ctx, channel, me);
    // Paged by hand on lastReplySeq (one per thread), not with paginate(): a subscribed query keeps
    // a paginate() page's end between runs, and this range moves with your read point, which made
    // the kept end "a cursor from a different query" once you read on.
    const numItems = Math.min(Math.max(args.limit ?? 10, 1), 25);
    const before = args.cursor ? Number(args.cursor) : undefined;
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_channel_last_reply", (q) => {
        const after = q.eq("channelId", channel._id).gt("lastReplySeq", readSeq);
        return before !== undefined && Number.isFinite(before) ? after.lt("lastReplySeq", before) : after;
      })
      .order("desc")
      .take(numItems + 1);
    const page = rows.slice(0, numItems);
    const viewer = await viewerFor(ctx, actor);
    const threads = [];
    for (const parent of page) {
      // From the newest reply back to your read point, bounded: a long thread is never read whole.
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_reply", (q) => q.eq("replyTo", parent._id))
        .order("desc")
        .take(NEW_REPLY_SCAN);
      let fresh = 0;
      let firstNewSeq: number | undefined;
      let reachedRead = false;
      for (const r of recent) {
        // A reply without a seq is from before unread counts, older than every one with a seq:
        // it and everything before it count as read, like a reply at or before your read point.
        if (r.seq === undefined || r.seq <= readSeq) {
          reachedRead = true;
          break;
        }
        firstNewSeq = r.seq;
        if (!wroteIt(r, me)) fresh++;
      }
      if (fresh === 0) continue;
      // Known only when the look back reached your read point (or the thread's first reply).
      const complete = reachedRead || recent.length < NEW_REPLY_SCAN;
      threads.push({
        message: await messageView(ctx, viewer, parent),
        newReplies: Math.min(fresh, NEW_REPLY_CAP),
        moreNew: fresh > NEW_REPLY_CAP,
        ...(complete && firstNewSeq !== undefined ? { firstNewSeq } : {}),
      });
    }
    const isDone = rows.length <= numItems;
    return { page: threads, continueCursor: isDone ? "" : String(page.at(-1)!.lastReplySeq), isDone };
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "messages.get",
  description:
    "One message, with its reactions, attachments, previews and pin. Null when there is no such message you can see: deleted, or in a direct message or private channel you aren't in (the same answer either way).",
  scope: "room.read",
  args: { messageId: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const message = await visibleMessage(ctx, actor, args.messageId);
    return message ? messageView(ctx, await viewerFor(ctx, actor), message) : null;
  },
});

/** Search reads at most this many of the best matches, under Convex's 1024 per search query. */
const SEARCH_SCAN = 1000;
/**
 * Newest first reads every match it orders, on every page, so it orders fewer: the 200 best. At
 * 20 KiB a message that's 4 MiB, well inside a query's 16 MiB of reads.
 */
const NEWEST_SCAN = 200;
const LINK = /https?:\/\/[^\s<>"')\]]+/i;

export const { person: search, agent: searchAgent } = roomQuery({
  name: "messages.search",
  description:
    "Search message text across every channel, private channel and direct message you can see, best match first (Convex full-text search: whole words, and the last word also matches as a prefix; no typo tolerance; up to 16 words). Narrow it with channelId, authorId (a member), from and to (ms timestamps), and has: 'attachment' or 'link'. sort: 'newest' lists the 200 best matches newest first instead. Messages in direct messages and private channels you aren't in (admins included), and deleted messages, are never returned. It looks through the 1000 best matches at most (Convex scans at most 1024 per search). Returns { results, cursor, isDone }; pass cursor back for more.",
  scope: "room.read",
  args: {
    query: v.string(),
    channelId: v.optional(v.id("channels")),
    authorId: v.optional(v.id("members")),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    has: v.optional(v.union(v.literal("attachment"), v.literal("link"))),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    /** "newest": the 200 best matches newest first, instead of best match first. */
    sort: v.optional(v.union(v.literal("relevance"), v.literal("newest"))),
  },
  handler: async (ctx, actor, args) => {
    const text = args.query.trim().slice(0, 200);
    if (!text) throw roomError("invalid", "Search for at least one word.");
    if (args.channelId) await channelAccess(ctx, actor, args.channelId);
    const pageSize = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const offset = args.cursor ? Number.parseInt(args.cursor, 10) || 0 : 0;
    const seen = new Map<string, boolean>();
    const visible = async (channelId: Id<"channels">) => {
      if (!seen.has(channelId)) {
        const channel = await ctx.db.get(channelId);
        seen.set(channelId, !!channel && (await canSee(ctx, actor, channel)));
      }
      return seen.get(channelId)!;
    };
    const fits = async (m: Doc<"messages">) => {
      if (m.deletedAt !== undefined || m.system) return false;
      if (args.from !== undefined && m._creationTime < args.from) return false;
      if (args.to !== undefined && m._creationTime > args.to) return false;
      if (args.has === "attachment" && !m.attachmentCount) return false;
      if (args.has === "link" && !LINK.test(m.body)) return false;
      return visible(m.channelId);
    };
    const searched = () =>
      ctx.db.query("messages").withSearchIndex("search_body", (q) => {
        const base = q.search("body", text).eq("teamId", actor.teamId);
        const inChannel = args.channelId ? base.eq("channelId", args.channelId) : base;
        return args.authorId ? inChannel.eq("authorId", args.authorId) : inChannel;
      });
    const viewOf = async (found: Doc<"messages">[]) => {
      const viewer = await viewerFor(ctx, actor);
      return Promise.all(
        found.map(async (m) => {
          const channel = (await ctx.db.get(m.channelId))!;
          return { ...(await messageView(ctx, viewer, m)), channel: { channelId: channel._id, kind: kindOf(channel), name: channel.name } };
        }),
      );
    };
    if (args.sort === "newest") {
      // Newest first: the best matches it looks through (NEWEST_SCAN), sorted by time, then paged.
      const fitting: Doc<"messages">[] = [];
      for (const m of await searched().take(NEWEST_SCAN)) if (await fits(m)) fitting.push(m);
      fitting.sort((a, b) => b._creationTime - a._creationTime);
      const page = fitting.slice(offset, offset + pageSize);
      const isDone = offset + pageSize >= fitting.length;
      return { results: await viewOf(page), cursor: isDone ? null : String(offset + pageSize), isDone };
    }
    // A search index filters only by equality, so the rest (including direct-message access) is
    // checked here, reading further into the ranked matches until a page is full.
    const found: Doc<"messages">[] = [];
    let consumed = offset;
    let exhausted = false;
    let want = offset + pageSize * 3;
    while (found.length < pageSize && !exhausted) {
      const take = Math.min(want, SEARCH_SCAN);
      const batch = await ctx.db
        .query("messages")
        .withSearchIndex("search_body", (q) => {
          const base = q.search("body", text).eq("teamId", actor.teamId);
          const inChannel = args.channelId ? base.eq("channelId", args.channelId) : base;
          return args.authorId ? inChannel.eq("authorId", args.authorId) : inChannel;
        })
        .take(take);
      for (const m of batch.slice(consumed)) {
        consumed++;
        if (await fits(m)) found.push(m);
        if (found.length >= pageSize) break;
      }
      exhausted = batch.length < take || take >= SEARCH_SCAN;
      want = take * 2;
    }
    const isDone = exhausted && found.length < pageSize ? true : consumed >= SEARCH_SCAN;
    const viewer = await viewerFor(ctx, actor);
    return {
      results: await Promise.all(
        found.map(async (m) => {
          const channel = (await ctx.db.get(m.channelId))!;
          return {
            ...(await messageView(ctx, viewer, m)),
            channel: { channelId: channel._id, kind: kindOf(channel), name: channel.name },
          };
        }),
      ),
      cursor: isDone ? null : String(consumed),
      isDone,
    };
  },
});

export const { person: addressed, agent: addressedAgent } = roomQuery({
  name: "messages.addressed",
  description:
    "Messages addressed to you: in your direct messages, mentioning you (or @everyone, which in a private channel reaches only its members), replying to your messages, and in channels you set to all (channels.setNotify), following each channel's level. Only channels you can still see: none from a private channel you left. A message a live run posted as itself has asRun with the run's name; author is its driver. Each has a seq, the order they reached you in, which only grows. Without after, the newest ones, newest first. With after (a seq you have handled), the ones that reached you since, oldest first, a page of at most limit: pass the last one's seq as the next after until a page comes back empty, and nothing is skipped however many arrived while you were away. since (ms, compared with at) also works, newest first, but alerts written at the same moment can be missed. An @everyone in a large channel can reach you after newer messages did, so order by seq, not by the message's time. The desktop app's banners come from this; an agent can watch it (RoomClient.watch) to see what is asked of it. Kept for 7 days.",
  scope: "room.read",
  args: { after: v.optional(v.number()), since: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const me = actor.member._id;
    const alerts =
      args.after !== undefined
        ? // Oldest first after the cursor. It looks a little further than one page, past alerts it
          // can't show (a message deleted since), so a page isn't empty while newer ones wait.
          // `gt` skips alerts without a seq: undefined sorts before every number (docs.convex.dev, Data Types).
          await ctx.db
            .query("messageAlerts")
            .withIndex("by_member_seq", (q) => q.eq("memberId", me).gt("seq", args.after!))
            .order("asc")
            .take(limit * 4)
        : args.since !== undefined
          ? await ctx.db
              .query("messageAlerts")
              .withIndex("by_member_at", (q) => q.eq("memberId", me).gt("at", args.since!))
              .order("desc")
              .take(limit)
          : await ctx.db
              .query("messageAlerts")
              .withIndex("by_member_seq", (q) => q.eq("memberId", me).gt("seq", 0))
              .order("desc")
              .take(limit);
    const viewer = await viewerFor(ctx, actor);
    const out = [];
    for (const alert of alerts) {
      if (out.length === limit) break;
      const message = await ctx.db.get(alert.messageId);
      const channel = await ctx.db.get(alert.channelId);
      if (!message || !channel || message.deletedAt !== undefined || !(await canSee(ctx, actor, channel))) continue;
      const names = new Map<string, string>();
      for (const id of mentionTokens(message.body)) {
        const memberId = ctx.db.normalizeId("members", id);
        if (memberId) names.set(id, await nameOf(ctx, viewer, memberId));
      }
      await runNamesIn(ctx, actor.teamId, message.body, viewer.runName, names);
      const direct = isDirect(channel);
      const others = direct
        ? (await Promise.all((await directMemberIds(ctx, channel)).filter((id) => id !== actor.member._id).map((id) => nameOf(ctx, viewer, id))))
        : [];
      out.push({
        messageId: message._id,
        channelId: channel._id,
        channel: {
          kind: kindOf(channel),
          /** `#name` (a private channel's too), or the other members' names for a direct message. */
          label: direct ? others.join(", ") || "Direct message" : `#${channel.name}`,
        },
        author: await memberView(ctx, message.authorId),
        /** Posted by a live run as itself: its banner names the run. author is its driver, who answers for it. */
        asRun: message.asRun,
        reason: alert.reason,
        preview:
          plainPreview(message.body, message.format, (id) => names.get(id)) ||
          (message.attachmentCount ? `${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"}` : ""),
        replyTo: message.replyTo,
        /** When it reached you, and its place in the order it did (0 on alerts from before seqs). */
        at: alert.at,
        seq: alert.seq ?? 0,
      });
    }
    return out;
  },
});

/** How many messages one backfill run looks at, and how many replies it may read counting them. */
export const BACKFILL_PAGE = 50;
export const BACKFILL_REPLY_BUDGET = 4000;

const vBackfillParent = v.object({
  parentId: v.id("messages"),
  /** The parent's replyRevision when its count started: a reply posted or deleted since restarts it. */
  revision: v.optional(v.number()),
  replyCursor: v.union(v.string(), v.null()),
  count: v.number(),
  lastReplySeq: v.optional(v.number()),
  lastReplyAt: v.optional(v.number()),
});

/**
 * One-time migration: sets an exact `replyCount` and `lastReplySeq` (and `lastReplyAt`) on every
 * message with replies, so threads from before parents kept them show their count and are found by
 * messages.unreadThreads. Run it once per deployment after deploying:
 *
 *   npx convex run messages:backfillReplyMeta '{}'            (add --prod for production)
 *
 * It's bounded and resumable: each run reads at most BACKFILL_PAGE messages and
 * BACKFILL_REPLY_BUDGET replies, then schedules the next run from where it stopped, part way
 * through a page or a long thread included, until it logs "backfillReplyMeta done". Each parent is
 * counted exactly, page by page of its replies; one a reply is posted to or deleted from between
 * runs (its replyRevision moved) is counted again from the start, so a stale count never
 * overwrites the one that post or delete set. Running it again is safe: it only writes what's
 * wrong. Messages with no replies and no stored fields are left as they are.
 */
export const backfillReplyMeta = internalMutation({
  args: {
    /** Where in the messages table the current page starts (null: the beginning). */
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Messages of that page already handled, when a run stopped part way through it. */
    done: v.optional(v.array(v.id("messages"))),
    /** The parent being counted when a run stopped part way through its replies. */
    current: v.optional(vBackfillParent),
    pageSize: v.optional(v.number()),
    replyBudget: v.optional(v.number()),
    /** Running totals, for the final log line. */
    seen: v.optional(v.number()),
    fixed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = Math.min(Math.max(args.pageSize ?? BACKFILL_PAGE, 1), 200);
    let budget = Math.min(Math.max(args.replyBudget ?? BACKFILL_REPLY_BUDGET, 1), 8000);
    const pageCursor = args.cursor ?? null;
    const done = new Set<string>(args.done ?? []);
    let seen = args.seen ?? 0;
    let fixed = args.fixed ?? 0;
    const page = await ctx.db.query("messages").paginate({ numItems: pageSize, cursor: pageCursor });
    for (const m of page.page) {
      if (done.has(m._id)) continue;
      if (m.replyTo !== undefined || m.system) {
        done.add(m._id);
        continue;
      }
      const fresh = () => ({
        parentId: m._id,
        revision: m.replyRevision,
        replyCursor: null as string | null,
        count: 0,
        lastReplySeq: undefined as number | undefined,
        lastReplyAt: undefined as number | undefined,
      });
      // Carried on from an earlier run only while no reply was posted or deleted since: otherwise
      // its count is stale (and a post or delete may have set the count exactly), so count again.
      const state = args.current?.parentId === m._id && args.current.revision === m.replyRevision ? { ...args.current } : fresh();
      for (;;) {
        if (budget <= 0) {
          // Out of replies to read for this run: carry on from this parent, in this page.
          await ctx.scheduler.runAfter(0, internal.messages.backfillReplyMeta, {
            cursor: pageCursor,
            done: [...done] as Id<"messages">[],
            current: state,
            pageSize,
            ...(args.replyBudget !== undefined ? { replyBudget: args.replyBudget } : {}),
            seen,
            fixed,
          });
          return { status: "continuing" };
        }
        const replies = await ctx.db
          .query("messages")
          .withIndex("by_reply", (q) => q.eq("replyTo", m._id))
          .paginate({ numItems: Math.min(budget, 1000), cursor: state.replyCursor });
        budget -= Math.max(1, replies.page.length);
        state.count += replies.page.length;
        for (const r of replies.page) {
          if (r.seq !== undefined && (state.lastReplySeq === undefined || r.seq > state.lastReplySeq)) state.lastReplySeq = r.seq;
          if (state.lastReplyAt === undefined || r._creationTime > state.lastReplyAt) state.lastReplyAt = r._creationTime;
        }
        if (replies.isDone) break;
        state.replyCursor = replies.continueCursor;
      }
      seen++;
      const untouched = state.count === 0 && m.replyCount === undefined && m.lastReplySeq === undefined;
      if (!untouched && (m.replyCount !== state.count || m.lastReplySeq !== state.lastReplySeq)) {
        await ctx.db.patch(m._id, {
          replyCount: state.count,
          lastReplySeq: state.lastReplySeq,
          ...(state.count > 0 ? { lastReplyAt: state.lastReplyAt } : {}),
        });
        fixed++;
      }
      done.add(m._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.messages.backfillReplyMeta, {
        cursor: page.continueCursor,
        pageSize,
        ...(args.replyBudget !== undefined ? { replyBudget: args.replyBudget } : {}),
        seen,
        fixed,
      });
      return { status: "continuing" };
    }
    console.log(`backfillReplyMeta done: ${seen} messages looked at, ${fixed} fixed`);
    return { status: "done", seen, fixed };
  },
});

/** Deletes alerts older than 7 days, a batch at a time (crons.ts). */
export const pruneAlerts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("messageAlerts")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - ALERTS_KEPT_MS))
      .take(500);
    for (const alert of old) await ctx.db.delete(alert._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.messages.pruneAlerts, {});
    return null;
  },
});

/** The pinned messages of a channel, newest pin first. Used by channels.pins. */
export async function pinsOf(ctx: QueryCtx, actor: Actor, channelId: Id<"channels">) {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_channel_pinned", (q) => q.eq("channelId", channelId).gt("pinnedAt", 0))
    .order("desc")
    .take(MAX_PINS);
  const viewer = await viewerFor(ctx, actor);
  return Promise.all(rows.map((m) => messageView(ctx, viewer, m)));
}

/** Inserts a message written by the room's own functions (call notes), with its seq, addressed as a post is. */
export async function insertNotes(
  ctx: MutationCtx,
  actor: Actor,
  channel: Doc<"channels">,
  body: string,
): Promise<Id<"messages">> {
  const now = Date.now();
  const seq = await nextSeq(ctx, channel._id, now);
  // Whom the notes name, as messages.post reads them: members who can see the channel.
  const mentioned = await resolveMentions(ctx, actor, channel, body, []);
  const mentionedIds = mentioned.map((m) => m._id);
  const agentIds = mentioned.filter((m) => m.kind === "agent").map((m) => m._id);
  const id = await ctx.db.insert("messages", {
    teamId: actor.teamId,
    channelId: channel._id,
    authorId: actor.member._id,
    ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
    format: "markdown",
    body,
    mentionedTasks: [],
    mentionedRuns: [],
    ...(agentIds.length ? { mentionedAgents: agentIds } : {}),
    ...(mentionedIds.length ? { mentionedMembers: mentionedIds } : {}),
    seq,
  });
  await markReadUpTo(ctx, channel, actor.member._id, seq);
  // Addressed like a post: the people it names, a direct message's members and channels set to
  // all hear of it (banners, messages.addressed). Posting the notes again edits them quietly.
  await address(ctx, channel, (await ctx.db.get(id))!, mentionedIds, undefined);
  return id;
}

/**
 * The attachment a download link names (http.ts), by its token. Never one in a direct message or
 * private channel: those are served only through short-lived grants (messages.attachmentLink).
 */
export const attachmentForDownload = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!row) return null;
    const channel = await ctx.db.get(row.channelId);
    if (!channel || hasMemberList(channel)) return null;
    return { storageId: row.storageId, name: row.name, kind: row.kind, contentType: row.contentType };
  },
});

export const { person: attachmentLink, agent: attachmentLinkAgent } = roomMutation({
  name: "messages.attachmentLink",
  description: `A link to one of a message's attachments (attachmentIndex counts from 0), for you alone, that works for ${LINK_TTL_MS / 60000} minutes and only while you can still see the channel: once you leave a private channel or are removed from it, its links stop working. Attachments in direct messages and private channels have no other link (their url and downloadUrl are null); any attachment can be fetched this way. download: true serves it as a download; otherwise images and PDFs are served to show in place and any other file as a download. Returns { url, expiresAt }.`,
  scope: "room.read",
  agentAudit: false,
  args: { messageId: v.id("messages"), attachmentIndex: v.number(), download: v.optional(v.boolean()) },
  handler: async (ctx, actor, args) => {
    const { message } = await messageAccess(ctx, actor, args.messageId);
    if (message.deletedAt !== undefined) throw roomError("not_found", "Not found in this team.");
    const attachment = (await attachmentsOf(ctx, message)).find((a) => a.position === args.attachmentIndex);
    if (!attachment) throw roomError("not_found", `That message has no attachment ${args.attachmentIndex}.`);
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = Date.now() + LINK_TTL_MS;
    await ctx.db.insert("attachmentGrants", {
      attachmentId: attachment._id,
      memberId: actor.member._id,
      ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
      tokenHash: await sha256(token),
      download: args.download === true || attachment.kind === "file",
      expiresAt,
    });
    return { url: grantUrl(token, attachment.name), expiresAt };
  },
});

/**
 * What a grant link may serve (http.ts), by its token's hash, and whether its member can still see
 * the attachment's channel. The caller compares `expiresAt` with the time itself: a query's result
 * is cached, so a query can't be trusted to notice that time passed.
 */
/**
 * Whether the agent key a link was made with still reaches the channel: not revoked, still holding
 * room.read, and not narrowed to channels without it since (ADR 0049). A person's link has no key.
 */
async function keyStillReaches(
  ctx: QueryCtx,
  member: Doc<"members">,
  agentKeyId: Id<"agentKeys"> | undefined,
  channelId: Id<"channels">,
): Promise<boolean> {
  // An agent's link from before links recorded their key (ADR 0049) can't be checked: it lasted
  // minutes, so it serves nothing now rather than outlive a narrowing.
  if (!agentKeyId) return member.kind !== "agent";
  const key = await ctx.db.get(agentKeyId);
  return (
    !!key &&
    key.revokedAt === undefined &&
    key.scopes.includes("room.read") &&
    (!key.channelIds || key.channelIds.includes(channelId))
  );
}

export const attachmentGrant = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const grant = await ctx.db
      .query("attachmentGrants")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!grant) return null;
    const row = await ctx.db.get(grant.attachmentId);
    const member = await ctx.db.get(grant.memberId);
    const channel = row ? await ctx.db.get(row.channelId) : null;
    const message = row ? await ctx.db.get(row.messageId) : null;
    const allowed =
      !!row &&
      !!member &&
      member.removedAt === undefined &&
      !!channel &&
      channel.teamId === member.teamId &&
      !!message &&
      message.deletedAt === undefined &&
      (await memberCanSee(ctx, channel, member._id)) &&
      (await keyStillReaches(ctx, member, grant.agentKeyId, channel._id));
    if (!allowed || !row) return { allowed: false as const, expiresAt: grant.expiresAt };
    return {
      allowed: true as const,
      expiresAt: grant.expiresAt,
      download: grant.download,
      storageId: row.storageId,
      name: row.name,
      kind: row.kind,
      contentType: row.contentType,
    };
  },
});

/** Deletes expired attachment links, a batch at a time (crons.ts). */
export const pruneAttachmentGrants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("attachmentGrants")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const grant of old) await ctx.db.delete(grant._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.messages.pruneAttachmentGrants, {});
    return null;
  },
});
