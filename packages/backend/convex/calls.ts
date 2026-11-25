/**
 * Calls in channels (spec #5, ADR 0007 and ADR 0008).
 *
 * A channel has at most one live call. `calls.join` starts it or joins it and
 * returns a LiveKit token for that call alone. Presence comes from join,
 * leave and a heartbeat, plus LiveKit's webhooks when they're configured. The
 * call ends when its last person leaves. Transcripts, call notes and proposed
 * tasks are written by whoever was in the call, usually the Notetaker.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { accountableId, hasScope, type Actor } from "./lib/actor";
import {
  callAccess,
  canSee,
  canSeeId,
  channelAccess,
  hasMemberList,
  memberCanSee,
  whereLabel,
} from "./lib/channels";
import { roomError } from "./lib/errors";
import {
  joinToken,
  liveKitConfig,
  liveKitIdentity,
  liveKitRooms,
  parseIdentity,
  requireLiveKit,
  roomName,
  TOKEN_TTL_SECONDS,
} from "./lib/livekit";
import { audit, inTeam, maybeView, memberView, teamMember } from "./lib/members";
import { effectiveVoice, limitOf } from "./lib/callQuality";
import { insertNotes } from "./messages";
import { roomMutation, roomQuery } from "./lib/room";

/** The app and agents call `calls.heartbeat` every 20 seconds; a participant quiet for this long is dropped. */
export const PRESENCE_WINDOW_MS = 60 * 1000;
/** Transcripts are deleted this long after the call ends (ADR 0008). */
export const TRANSCRIPT_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LINES_PER_CALL = 100;
const MAX_LINE_CHARS = 4000;
const MAX_NOTES_CHARS = 20_000;

// ---------- helpers ----------

async function liveCall(ctx: QueryCtx, channelId: Id<"channels">): Promise<Doc<"calls"> | null> {
  const calls = await ctx.db
    .query("calls")
    .withIndex("by_channel", (q) => q.eq("channelId", channelId))
    .order("desc")
    .take(5);
  return calls.find((c) => c.endedAt === undefined) ?? null;
}

type Participation = Doc<"callParticipations">;

async function participationsOf(ctx: QueryCtx, callId: Id<"calls">): Promise<Participation[]> {
  return await ctx.db
    .query("callParticipations")
    .withIndex("by_call", (q) => q.eq("callId", callId))
    .collect();
}

async function participationsOfMember(ctx: QueryCtx, callId: Id<"calls">, memberId: Id<"members">) {
  return await ctx.db
    .query("callParticipations")
    .withIndex("by_call_member", (q) => q.eq("callId", callId).eq("memberId", memberId))
    .collect();
}

const isLive = (p: Participation) => p.leftAt === undefined;

/** The call, checked to be in a channel the actor can see (lib/channels.ts). */
async function callInTeam(ctx: QueryCtx, actor: Actor, callId: Id<"calls">): Promise<Doc<"calls">> {
  return (await callAccess(ctx, actor, callId)).call;
}

/** One of the actor's own joins. Nobody else can leave, keep alive or update it. */
async function ownParticipation(ctx: QueryCtx, actor: Actor, participationId: Id<"callParticipations">) {
  const participation = await ctx.db.get(participationId);
  if (!participation) throw roomError("not_found", "That join was not found.");
  const call = await callInTeam(ctx, actor, participation.callId);
  if (participation.memberId !== actor.member._id) throw roomError("forbidden", "That join is not yours.");
  return { participation, call };
}

/** Whether the actor has a live join in the call right now. */
async function isInNow(ctx: QueryCtx, actor: Actor, call: Doc<"calls">): Promise<boolean> {
  return (await participationsOfMember(ctx, call._id, actor.member._id)).some(isLive);
}

/** Only someone who has been in the call may write its transcript, notes and proposals. */
async function requireWasIn(ctx: QueryCtx, actor: Actor, call: Doc<"calls">) {
  if ((await participationsOfMember(ctx, call._id, actor.member._id)).length === 0) {
    throw roomError("forbidden", "Only someone who was in the call can do this.");
  }
}

async function scheduleCheck(ctx: MutationCtx, participationId: Id<"callParticipations">, at: number) {
  const checkId = await ctx.scheduler.runAt(at, internal.calls.checkParticipation, { participationId });
  await ctx.db.patch(participationId, { checkId });
}

async function cancelCheck(ctx: MutationCtx, participation: Participation) {
  if (!participation.checkId) return;
  const job = await ctx.db.system.get(participation.checkId);
  if (job?.state.kind === "pending") await ctx.scheduler.cancel(participation.checkId);
}

/** Ends a call: every live join is dropped and pending invites are cleared. */
async function endCall(ctx: MutationCtx, call: Doc<"calls">) {
  const now = Date.now();
  for (const p of await participationsOf(ctx, call._id)) {
    if (!isLive(p)) continue;
    await cancelCheck(ctx, p);
    await ctx.db.patch(p._id, { leftAt: now, checkId: undefined });
  }
  const invites = await ctx.db
    .query("callInvites")
    .withIndex("by_call", (q) => q.eq("callId", call._id))
    .collect();
  for (const invite of invites) {
    if (invite.status === "pending") await ctx.db.patch(invite._id, { status: "cleared" });
  }
  await ctx.db.patch(call._id, { endedAt: now });
}

/** Ends one join, and the call when no person has a live join left in it. */
async function drop(ctx: MutationCtx, participation: Participation) {
  if (!isLive(participation)) return;
  await cancelCheck(ctx, participation);
  await ctx.db.patch(participation._id, { leftAt: Date.now(), checkId: undefined });
  const call = await ctx.db.get(participation.callId);
  if (!call || call.endedAt !== undefined) return;
  const people = (await participationsOf(ctx, call._id)).filter(
    (p) => p._id !== participation._id && isLive(p) && p.kind === "person",
  );
  if (people.length === 0) await endCall(ctx, call);
}

/**
 * Who is in the call: one entry per member with a live join. A member on two
 * devices shows once, with their devices' media together: the camera or a
 * screen if any device has it on, muted only if every device is muted.
 */
async function membersInCall(ctx: QueryCtx, participations: Participation[]) {
  const byMember = new Map<string, Participation[]>();
  for (const p of participations.filter(isLive)) byMember.set(p.memberId, [...(byMember.get(p.memberId) ?? []), p]);
  const firstJoin = (joins: Participation[]) => Math.min(...joins.map((p) => p.joinedAt));
  const ordered = [...byMember.values()].sort((a, b) => firstJoin(a) - firstJoin(b));
  return Promise.all(
    ordered.map(async (joins) => ({
      ...(await memberView(ctx, joins[0]!.memberId)),
      takesNotes: joins.some((p) => p.takesNotes),
      muted: joins.every((p) => p.muted),
      camera: joins.some((p) => p.camera),
      screen: joins.some((p) => p.screen),
      joinedAt: firstJoin(joins),
    })),
  );
}

async function proposalView(ctx: QueryCtx, p: Doc<"taskProposals">) {
  return {
    proposalId: p._id,
    title: p.title,
    description: p.description,
    owner: await maybeView(ctx, p.ownerId),
    proposedBy: await memberView(ctx, p.proposedBy),
    status: p.status,
    taskId: p.taskId,
    answeredBy: await maybeView(ctx, p.answeredBy),
  };
}

/**
 * The pending proposed tasks that need `forMember` (the Inbox's "Needs you"): theirs as suggested
 * owner, or, with no owner suggested, from a call they were in. With `team`, every pending one. Only
 * proposals from channels the actor can see, newest call first.
 */
export async function proposalsNeeding(
  ctx: QueryCtx,
  actor: Actor,
  forMember: Id<"members">,
  team: boolean,
) {
  const pending = await ctx.db
    .query("taskProposals")
    .withIndex("by_team_status", (q) => q.eq("teamId", actor.teamId).eq("status", "pending"))
    .collect();
  // Each proposal is read at the same time as the others: the Inbox runs this, and Convex adds up the
  // time a query waits on reads (inbox.get).
  const rows = await Promise.all(
    pending.map(async (p) => {
      const channel = await ctx.db.get(p.channelId);
      if (!channel || !(await canSee(ctx, actor, channel))) return null;
      // An agent reading its person's Inbox shows only what that person may see too.
      if (forMember !== actor.member._id && !(await memberCanSee(ctx, channel, forMember))) return null;
      if (!team) {
        const theirs = p.ownerId
          ? p.ownerId === forMember
          : (await participationsOfMember(ctx, p.callId, forMember)).length > 0;
        if (!theirs) return null;
      }
      // Accepting goes to the channel's project, unless it was archived: then accepting asks where.
      const [call, project, view] = await Promise.all([
        ctx.db.get(p.callId),
        channel.projectId ? ctx.db.get(channel.projectId) : null,
        proposalView(ctx, p),
      ]);
      return {
        ...view,
        callId: p.callId,
        channelId: p.channelId,
        /** Where the call was, as people say it: "#general" or "this direct message". */
        where: whereLabel(channel),
        /** The channel's project, where accepting puts the task; absent means accepting asks where. */
        channelProjectId: project && project.archivedAt === undefined ? project._id : undefined,
        callStartedAt: call?.startedAt ?? p._creationTime,
      };
    }),
  );
  return rows.filter((row) => row !== null).sort((a, b) => b.callStartedAt - a.callStartedAt);
}

async function callView(ctx: QueryCtx, call: Doc<"calls">, withProposals: boolean) {
  const participations = await participationsOf(ctx, call._id);
  const everyone: Id<"members">[] = [];
  for (const p of [...participations].sort((a, b) => a.joinedAt - b.joinedAt)) {
    if (!everyone.includes(p.memberId)) everyone.push(p.memberId);
  }
  const proposals = withProposals
    ? await ctx.db
        .query("taskProposals")
        .withIndex("by_call", (q) => q.eq("callId", call._id))
        .collect()
    : [];
  return {
    callId: call._id,
    channelId: call.channelId,
    startedBy: await memberView(ctx, call.startedBy),
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    participants: await membersInCall(ctx, participations),
    everyone: await Promise.all(everyone.map((id) => memberView(ctx, id))),
    notesMessageId: call.notesMessageId,
    /** Whether any line was written, so the transcript can be opened even if no notes were posted. */
    hasTranscript:
      (await ctx.db
        .query("transcriptLines")
        .withIndex("by_call_at", (q) => q.eq("callId", call._id))
        .first()) !== null,
    transcriptKeptUntil: call.endedAt !== undefined ? call.endedAt + TRANSCRIPT_KEPT_MS : undefined,
    proposals: await Promise.all(proposals.map((p) => proposalView(ctx, p))),
  };
}

// ---------- joining and leaving ----------

export const { person: join, agent: joinAgent } = roomMutation({
  name: "calls.join",
  description:
    "Join the call in a channel, starting it if there is none. Pass callId to join only that call: if it has ended you get a conflict error and no new call starts (agents answering an invite should pass it). Each join is its own participation (one per device): use the returned participationId for calls.leave, calls.heartbeat (every 20 seconds) and calls.updateMedia. Returns the LiveKit URL, a token for this join alone (valid 10 minutes for the first connection), and callQuality, the voice quality to publish a microphone with (channels.list describes each; channels.setCallQuality changes it). The join counts at once: people see you in the call right away (calls.live, and the app, which follows it live), and you stay listed until calls.leave, or until 60 seconds pass without calls.heartbeat, whether or not you connect to LiveKit. Connect with url and token only to hear or speak; keep the token to yourself.",
  scope: "calls.join",
  args: { channelId: v.id("channels"), callId: v.optional(v.id("calls")) },
  handler: async (ctx, actor, args) => {
    const config = requireLiveKit();
    const channel = await channelAccess(ctx, actor, args.channelId);
    if (channel.archivedAt !== undefined) throw roomError("invalid", "This channel is archived.");
    const now = Date.now();
    let call = await liveCall(ctx, channel._id);
    if (args.callId !== undefined && call?._id !== args.callId) {
      throw roomError("conflict", "That call has ended.");
    }
    if (!call) {
      const callId = await ctx.db.insert("calls", {
        teamId: actor.teamId,
        channelId: channel._id,
        startedBy: actor.member._id,
        startedAt: now,
      });
      call = (await ctx.db.get(callId))!;
    }
    const participationId = await ctx.db.insert("callParticipations", {
      callId: call._id,
      memberId: actor.member._id,
      kind: actor.member.kind,
      takesNotes: actor.kind === "agent" && hasScope(actor, "calls.notes"),
      joinedAt: now,
      lastSeenAt: now,
      muted: false,
      camera: false,
      screen: false,
    });
    await scheduleCheck(ctx, participationId, now + PRESENCE_WINDOW_MS);
    const invites = await ctx.db
      .query("callInvites")
      .withIndex("by_member_status", (q) => q.eq("memberId", actor.member._id).eq("status", "pending"))
      .collect();
    for (const invite of invites) {
      if (invite.callId === call._id) await ctx.db.patch(invite._id, { status: "joined" });
    }
    return {
      callId: call._id,
      participationId,
      url: config.url,
      token: await joinToken(config, call._id, actor.member._id, participationId, actor.member.kind),
      /** The voice quality to publish a microphone with (issue #87): the channel's, capped by the team's limit. */
      callQuality: effectiveVoice(channel.callQuality ?? "standard", limitOf(await ctx.db.get(actor.teamId))),
    };
  },
});

export const { person: leave, agent: leaveAgent } = roomMutation({
  name: "calls.leave",
  description:
    "Leave a call: ends the join you name (calls.join's participationId) and no other. Leaving a join that already ended does nothing. The call ends when its last person leaves.",
  scope: "calls.join",
  args: { participationId: v.id("callParticipations") },
  handler: async (ctx, actor, args) => {
    const { participation } = await ownParticipation(ctx, actor, args.participationId);
    await drop(ctx, participation);
    return null;
  },
});

export const { person: heartbeat, agent: heartbeatAgent } = roomMutation({
  name: "calls.heartbeat",
  description:
    "Keep a join alive. Call it every 20 seconds; a join quiet for 60 seconds is dropped. Fails with a conflict once the join has ended.",
  scope: "calls.join",
  agentAudit: false,
  args: { participationId: v.id("callParticipations") },
  handler: async (ctx, actor, args) => {
    const { participation, call } = await ownParticipation(ctx, actor, args.participationId);
    if (!isLive(participation) || call.endedAt !== undefined) {
      throw roomError("conflict", "You're not in this call any more. Join it again.");
    }
    await ctx.db.patch(participation._id, { lastSeenAt: Date.now() });
    return null;
  },
});

export const { person: updateMedia, agent: updateMediaAgent } = roomMutation({
  name: "calls.updateMedia",
  description: "Say whether a join is muted, on camera or sharing a screen, for people outside the call.",
  scope: "calls.join",
  agentAudit: false,
  args: {
    participationId: v.id("callParticipations"),
    muted: v.optional(v.boolean()),
    camera: v.optional(v.boolean()),
    screen: v.optional(v.boolean()),
  },
  handler: async (ctx, actor, args) => {
    const { participation } = await ownParticipation(ctx, actor, args.participationId);
    if (!isLive(participation)) throw roomError("conflict", "You're not in this call.");
    const patch: Partial<Participation> = { lastSeenAt: Date.now() };
    if (args.muted !== undefined) patch.muted = args.muted;
    if (args.camera !== undefined) patch.camera = actor.kind === "person" && args.camera;
    if (args.screen !== undefined) patch.screen = actor.kind === "person" && args.screen;
    await ctx.db.patch(participation._id, patch);
    return null;
  },
});

/** How long after a join ended its token may still be good: the token's life, with a minute for clocks. */
export const REVOKE_WINDOW_MS = (TOKEN_TTL_SECONDS + 60) * 1000;
/** How many of a member's joins one step looks at. */
export const REVOKE_BATCH = 50;
/** LiveKit tries per join before giving up: about four hours of backoff. */
export const REVOKE_MAX_TRIES = 30;
/** The wait before try `tries + 1`: 30 seconds, doubling, at most 10 minutes. Longer than one try takes. */
export function revokeBackoffMs(tries: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, tries - 1), 10 * 60_000);
}

/**
 * Takes members out of every call they are in, when they leave the team (members.remove) and so
 * lose its direct messages and private channels. Each live join ends here. Every identity that may
 * still hold a good token goes to LiveKit to be disconnected and refused:
 * - the live joins;
 * - every join they had in a call that hasn't ended, however long ago it ended here: a join this
 *   side dropped when its heartbeat stopped can still hold its media connection, and LiveKit
 *   refreshes the token of a live connection;
 * - the joins that ended within a token's life, in calls that ended too (one that left a few
 *   minutes ago could rejoin with its token).
 * A step looks at REVOKE_BATCH of the member's joins and schedules the next, through all of them,
 * so none is skipped however many joins one call holds. They can't get a new token: calls.join
 * needs a current member who can see the channel.
 */
export async function removeFromCalls(ctx: MutationCtx, memberIds: Id<"members">[]) {
  const cutoff = Date.now() - REVOKE_WINDOW_MS;
  for (const memberId of memberIds) await revokeStep(ctx, memberId, "live", null, cutoff);
}

/** `active` and `recent` were the second and third steps before they became one (`all`); a step queued then starts `all` over. */
type RevokePhase = "live" | "all" | "active" | "recent";

async function revokeStep(ctx: MutationCtx, memberId: Id<"members">, phase: RevokePhase, cursor: string | null, cutoff: number) {
  const queued: Id<"callRevocations">[] = [];
  const queue = async (p: Participation) => {
    const id = await queueRevocation(ctx, p);
    if (id) queued.push(id);
  };
  const next = (phase: RevokePhase, cursor: string | null) =>
    ctx.scheduler.runAfter(0, internal.calls.revokeJoins, { memberId, phase, cursor, cutoff });
  if (phase === "live") {
    // Dropping a join sets its leftAt, so it leaves this range: each step takes the first ones.
    const live = await ctx.db
      .query("callParticipations")
      .withIndex("by_member_left", (q) => q.eq("memberId", memberId).eq("leftAt", undefined))
      .take(REVOKE_BATCH);
    for (const p of live) {
      await drop(ctx, p);
      await queue(p);
    }
    if (live.length === REVOKE_BATCH) {
      await next("live", null);
      return await attempt(ctx, queued);
    }
    phase = "all";
    cursor = null;
  }
  if (phase !== "all") cursor = null;
  // Every join of theirs, in pages: those in a call that hasn't ended, and those that ended lately.
  const page = await ctx.db
    .query("callParticipations")
    .withIndex("by_member_left", (q) => q.eq("memberId", memberId))
    .paginate({ numItems: REVOKE_BATCH, cursor });
  for (const p of page.page) {
    const call = await ctx.db.get(p.callId);
    if (!call) continue;
    if (call.endedAt === undefined || (p.leftAt !== undefined && p.leftAt >= cutoff)) await queue(p);
  }
  if (!page.isDone) await next("all", page.continueCursor);
  await attempt(ctx, queued);
}

/** One more step of removeFromCalls for a member with many joins. */
export const revokeJoins = internalMutation({
  args: {
    memberId: v.id("members"),
    phase: v.union(v.literal("live"), v.literal("all"), v.literal("active"), v.literal("recent")),
    cursor: v.union(v.string(), v.null()),
    cutoff: v.number(),
  },
  handler: async (ctx, { memberId, phase, cursor, cutoff }) => {
    await revokeStep(ctx, memberId, phase, cursor, cutoff);
    return null;
  },
});

/**
 * Takes members out of one channel's calls, when they leave a private channel or are removed from
 * it (ADR 0016), the same way removeFromCalls does for the whole team: the channel's live call is
 * the only one that hasn't ended (a channel has at most one), so every join they had in it ends
 * and goes to LiveKit to be disconnected and refused, and so do their joins in the channel's
 * ended calls that ended within a token's life. Their pending invites to its call are cleared.
 * Each step looks at REVOKE_BATCH joins and schedules the next, so no join is skipped however many
 * there are. Only joins from before they were added back count: while they are out they can't
 * join (calls.join needs someone who can see the channel), so a join made after they came back is
 * new and valid, and a step still running from the removal leaves it alone.
 */
export async function removeFromChannelCalls(ctx: MutationCtx, channelId: Id<"channels">, memberIds: Id<"members">[]) {
  const cutoff = Date.now() - REVOKE_WINDOW_MS;
  const call = await liveCall(ctx, channelId);
  for (const memberId of memberIds) {
    if (call) {
      for (const invite of await ctx.db
        .query("callInvites")
        .withIndex("by_member_status", (q) => q.eq("memberId", memberId).eq("status", "pending"))
        .collect()) {
        if (invite.callId === call._id) await ctx.db.patch(invite._id, { status: "cleared" });
      }
    }
    await channelRevokeStep(ctx, { channelId, memberId, callId: call?._id ?? null, phase: call ? "live" : "recent", cursor: null, cutoff });
  }
}

type ChannelRevoke = {
  channelId: Id<"channels">;
  memberId: Id<"members">;
  callId: Id<"calls"> | null;
  phase: "live" | "recent";
  cursor: string | null;
  cutoff: number;
};

async function channelRevokeStep(ctx: MutationCtx, step: ChannelRevoke) {
  // Back in the channel since: their joins from after that are new ones, not the removed member's.
  const back = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", step.channelId).eq("memberId", step.memberId))
    .unique();
  const before = (p: Participation) => back === null || p._creationTime < back._creationTime;
  const queued: Id<"callRevocations">[] = [];
  const queue = async (p: Participation) => {
    const id = await queueRevocation(ctx, p);
    if (id) queued.push(id);
  };
  const next = (phase: "live" | "recent", cursor: string | null) =>
    ctx.scheduler.runAfter(0, internal.calls.revokeChannelJoins, { ...step, phase, cursor });
  let { phase, cursor } = step;
  if (phase === "live" && step.callId) {
    // Every join they had in the live call, in pages: the index holds the call and member only, so
    // ending a join doesn't move it under the cursor.
    const callId = step.callId;
    const page = await ctx.db
      .query("callParticipations")
      .withIndex("by_call_member", (q) => q.eq("callId", callId).eq("memberId", step.memberId))
      .paginate({ numItems: REVOKE_BATCH, cursor });
    for (const p of page.page) {
      if (!before(p)) continue;
      await drop(ctx, p);
      await queue(p);
    }
    if (!page.isDone) {
      await next("live", page.continueCursor);
      return await attempt(ctx, queued);
    }
    phase = "recent";
    cursor = null;
  }
  // Joins that ended lately, in any of this channel's calls (the live one's included), in pages.
  const page = await ctx.db
    .query("callParticipations")
    .withIndex("by_member_left", (q) => q.eq("memberId", step.memberId).gte("leftAt", step.cutoff))
    .paginate({ numItems: REVOKE_BATCH, cursor });
  for (const p of page.page) {
    if (before(p) && (await ctx.db.get(p.callId))?.channelId === step.channelId) await queue(p);
  }
  if (!page.isDone) await next("recent", page.continueCursor);
  await attempt(ctx, queued);
}

/** One more step of removeFromChannelCalls, for a member with many joins. */
export const revokeChannelJoins = internalMutation({
  args: {
    channelId: v.id("channels"),
    memberId: v.id("members"),
    callId: v.union(v.id("calls"), v.null()),
    phase: v.union(v.literal("live"), v.literal("recent")),
    cursor: v.union(v.string(), v.null()),
    cutoff: v.number(),
  },
  handler: async (ctx, step) => {
    await channelRevokeStep(ctx, step);
    return null;
  },
});

/** A pending revocation for one join's identity, once: the same identity is never queued twice. */
async function queueRevocation(ctx: MutationCtx, p: Participation): Promise<Id<"callRevocations"> | null> {
  if (!liveKitConfig()) return null;
  const identity = liveKitIdentity(p.memberId, p._id);
  const had = await ctx.db
    .query("callRevocations")
    .withIndex("by_identity", (q) => q.eq("identity", identity))
    .first();
  if (had) return null;
  return await ctx.db.insert("callRevocations", {
    memberId: p.memberId,
    callId: p.callId,
    identity,
    state: "pending",
    tries: 0,
    nextAt: Date.now(),
  });
}

async function attempt(ctx: MutationCtx, ids: Id<"callRevocations">[]) {
  if (ids.length) await ctx.scheduler.runAfter(0, internal.calls.attemptRevocations, { ids });
}

/**
 * Starts a LiveKit try for each pending revocation that is due, and schedules itself again for
 * the earliest one still pending. Convex doesn't retry a scheduled action (docs.convex.dev,
 * Scheduled Functions: error handling), and runs a scheduled mutation exactly once, so the retries
 * hang on this mutation: it leases each try by moving nextAt ahead by the backoff before the action
 * runs. A try that fails, or an action that never reports back, is tried again when that comes.
 */
export const attemptRevocations = internalMutation({
  args: { ids: v.array(v.id("callRevocations")) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    const due: { id: Id<"callRevocations">; callId: Id<"calls">; identity: string }[] = [];
    const pending: Id<"callRevocations">[] = [];
    let next = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (!row || row.state !== "pending") continue;
      if (row.nextAt > now) {
        pending.push(id);
        next = Math.min(next, row.nextAt);
        continue;
      }
      if (row.tries >= REVOKE_MAX_TRIES) {
        await ctx.db.patch(id, { state: "gaveUp" });
        console.error(`LiveKit never confirmed removing ${row.identity} after ${row.tries} tries: ${row.lastError ?? "no answer"}`);
        continue;
      }
      const tries = row.tries + 1;
      const nextAt = now + revokeBackoffMs(tries);
      await ctx.db.patch(id, { tries, nextAt });
      due.push({ id, callId: row.callId, identity: row.identity });
      pending.push(id);
      next = Math.min(next, nextAt);
    }
    if (due.length) await ctx.scheduler.runAfter(0, internal.calls.removeFromLiveKit, { joins: due });
    if (pending.length) await ctx.scheduler.runAt(next, internal.calls.attemptRevocations, { ids: pending });
    return null;
  },
});

/**
 * One try at each join: disconnect it and refuse its tokens issued before now (a fresh
 * revokeTokenTs each try, as LiveKit wants it within 60 seconds of its clock). Reports each
 * outcome; a try that throws is reported as one to do again.
 */
export const removeFromLiveKit = internalAction({
  args: { joins: v.array(v.object({ id: v.id("callRevocations"), callId: v.id("calls"), identity: v.string() })) },
  handler: async (ctx, { joins }) => {
    const config = liveKitConfig();
    if (!config) return null;
    const rooms = liveKitRooms(config);
    const results: { id: Id<"callRevocations">; outcome: "removed" | "absent" | "retry"; error?: string }[] = [];
    for (const join of joins) {
      try {
        results.push({ id: join.id, outcome: await rooms.removeParticipant(roomName(join.callId), join.identity, Date.now()) });
      } catch (error) {
        results.push({ id: join.id, outcome: "retry", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      }
    }
    await ctx.runMutation(internal.calls.recordRevocations, { results });
    return null;
  },
});

/** How long a finished revocation is kept: each finishes within about four hours of the removal (REVOKE_MAX_TRIES). */
export const REVOCATIONS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** How many finished revocations one step of pruneRevocations deletes. */
export const REVOCATIONS_PRUNE_BATCH = 500;

/**
 * Deletes revocations that finished (removed, absent or gaveUp) and were queued more than 7 days
 * ago, a batch at a time; it schedules itself again while there's more (#73). Runs daily (crons.ts).
 * Pending ones stay whatever their age. A removed member can't be removed again, so no identity is
 * queued twice for want of its row.
 */
export const pruneRevocations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - REVOCATIONS_KEPT_MS;
    let budget = REVOCATIONS_PRUNE_BATCH;
    for (const state of ["removed", "absent", "gaveUp"] as const) {
      const done = await ctx.db
        .query("callRevocations")
        .withIndex("by_state", (q) => q.eq("state", state).lt("_creationTime", cutoff))
        .take(budget);
      for (const row of done) await ctx.db.delete(row._id);
      budget -= done.length;
      if (budget === 0) {
        await ctx.scheduler.runAfter(0, internal.calls.pruneRevocations, {});
        return null;
      }
    }
    return null;
  },
});

/** What LiveKit said about each try. A failed one stays pending; attemptRevocations tries it again. */
export const recordRevocations = internalMutation({
  args: {
    results: v.array(
      v.object({
        id: v.id("callRevocations"),
        outcome: v.union(v.literal("removed"), v.literal("absent"), v.literal("retry")),
        error: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { results }) => {
    for (const { id, outcome, error } of results) {
      const row = await ctx.db.get(id);
      if (!row || row.state !== "pending") continue;
      if (outcome === "retry") {
        console.warn(`LiveKit didn't remove ${row.identity} (try ${row.tries}): ${error ?? "unknown error"}`);
        await ctx.db.patch(id, { lastError: error });
      } else {
        await ctx.db.patch(id, { state: outcome, lastError: undefined });
      }
    }
    return null;
  },
});

/**
 * Drops a join whose heartbeat window passed. If it was heard from since, it
 * checks again at the new window's end. One check is pending per join.
 */
export const checkParticipation = internalMutation({
  args: { participationId: v.id("callParticipations") },
  handler: async (ctx, { participationId }) => {
    const p = await ctx.db.get(participationId);
    if (!p || !isLive(p)) return null;
    if (Date.now() - p.lastSeenAt >= PRESENCE_WINDOW_MS) await drop(ctx, p);
    else await scheduleCheck(ctx, p._id, p.lastSeenAt + PRESENCE_WINDOW_MS);
    return null;
  },
});

/**
 * LiveKit says a participant left (`participant_left` or
 * `participant_connection_aborted`). The identity names one join
 * (`<member>.<participation>`), so only that join ends.
 */
export const liveKitParticipantLeft = internalMutation({
  args: { callId: v.string(), identity: v.string() },
  handler: async (ctx, args) => {
    const parsed = parseIdentity(args.identity);
    const participationId = parsed ? ctx.db.normalizeId("callParticipations", parsed.participationId) : null;
    if (!participationId) return null;
    const participation = await ctx.db.get(participationId);
    if (!participation || participation.callId !== args.callId || participation.memberId !== parsed!.memberId) return null;
    await drop(ctx, participation);
    return null;
  },
});

/** LiveKit closed the call's room (`room_finished`). */
export const liveKitRoomFinished = internalMutation({
  args: { callId: v.string() },
  handler: async (ctx, args) => {
    const callId = ctx.db.normalizeId("calls", args.callId);
    const call = callId ? await ctx.db.get(callId) : null;
    if (call && call.endedAt === undefined) await endCall(ctx, call);
    return null;
  },
});

// ---------- reading calls ----------

export const { person: live, agent: liveAgent } = roomQuery({
  name: "calls.live",
  description: "The team's live calls: each with its channel and who is in it (muted, camera, screen).",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    if (!liveKitConfig()) return [];
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_team_ended", (q) => q.eq("teamId", actor.teamId).eq("endedAt", undefined))
      .collect();
    const visible = [];
    for (const call of calls) if (await canSeeId(ctx, actor, call.channelId)) visible.push(call);
    return Promise.all(
      visible.map(async (call) => {
        const view = await callView(ctx, call, false);
        return { callId: view.callId, channelId: view.channelId, startedAt: view.startedAt, participants: view.participants };
      }),
    );
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "calls.get",
  description:
    "One call: who is in it, everyone who was, its call notes message, when its transcript is deleted, and its proposed tasks.",
  scope: "room.read",
  args: { callId: v.id("calls") },
  handler: async (ctx, actor, args) => callView(ctx, await callInTeam(ctx, actor, args.callId), true),
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "calls.list",
  description: "A channel's calls, newest first, for its timeline.",
  scope: "room.read",
  args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    await channelAccess(ctx, actor, args.channelId);
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    return Promise.all(calls.map((call) => callView(ctx, call, true)));
  },
});

// ---------- invites ----------

export const { person: invite, agent: inviteAgent } = roomMutation({
  name: "calls.invite",
  description: "Ask a team member, such as the Notetaker, to join a call you're in.",
  scope: "calls.join",
  args: { callId: v.id("calls"), memberId: v.id("members") },
  handler: async (ctx, actor, args) => {
    const call = await callInTeam(ctx, actor, args.callId);
    if (call.endedAt !== undefined) throw roomError("invalid", "This call has ended.");
    if (!(await isInNow(ctx, actor, call))) throw roomError("forbidden", "Only someone in the call can ask others to join.");
    const member = await teamMember(ctx, actor, args.memberId);
    const channel = await ctx.db.get(call.channelId);
    if (!channel || !(await memberCanSee(ctx, channel, member._id))) {
      throw roomError("invalid", `${member.name} isn't in ${channel ? whereLabel(channel) : "this channel"}, so they can't join its call.`);
    }
    if ((await participationsOfMember(ctx, call._id, member._id)).some(isLive)) {
      throw roomError("conflict", `${member.name} is already in the call.`);
    }
    const pending = await ctx.db
      .query("callInvites")
      .withIndex("by_member_status", (q) => q.eq("memberId", member._id).eq("status", "pending"))
      .collect();
    const already = pending.find((i) => i.callId === call._id);
    if (already) return already._id;
    return await ctx.db.insert("callInvites", {
      callId: call._id,
      memberId: member._id,
      invitedBy: actor.member._id,
      at: Date.now(),
      status: "pending",
    });
  },
});

export const { person: invitations, agent: invitationsAgent } = roomQuery({
  name: "calls.invitations",
  description:
    "The calls you've been asked to join and haven't yet. Agents can watch this live with the agent key (RoomClient.watch).",
  scope: "calls.join",
  args: {},
  handler: async (ctx, actor) => {
    const pending = await ctx.db
      .query("callInvites")
      .withIndex("by_member_status", (q) => q.eq("memberId", actor.member._id).eq("status", "pending"))
      .collect();
    const out = [];
    for (const invite of pending) {
      const call = await ctx.db.get(invite.callId);
      if (!call || call.endedAt !== undefined || call.teamId !== actor.teamId) continue;
      if (!(await canSeeId(ctx, actor, call.channelId))) continue;
      out.push({
        inviteId: invite._id,
        callId: call._id,
        channelId: call.channelId,
        invitedBy: await memberView(ctx, invite.invitedBy),
        at: invite.at,
      });
    }
    return out;
  },
});

/** How far back `calls.unfinished` looks: invites to calls older than this are left alone. */
export const UNFINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

export const { person: unfinished, agent: unfinishedAgent } = roomQuery({
  name: "calls.unfinished",
  description:
    "Calls you joined when asked (in the last day) that you aren't in any more and that still need you: live calls (ended: false), to join again, and ended calls with a transcript whose notes aren't complete (ended: true): no call notes, or notes but no calls.propose since the call ended. Write the notes and propose the tasks (even none) for those. A Notetaker that takes over from a crashed process uses this; proposal keys make a repeat safe.",
  scope: "calls.join",
  args: {},
  handler: async (ctx, actor) => {
    const joined = await ctx.db
      .query("callInvites")
      .withIndex("by_member_status", (q) =>
        q.eq("memberId", actor.member._id).eq("status", "joined").gte("_creationTime", Date.now() - UNFINISHED_WINDOW_MS),
      )
      .collect();
    const out: { callId: Id<"calls">; channelId: Id<"channels">; ended: boolean }[] = [];
    const seen = new Set<string>();
    for (const invite of joined) {
      if (seen.has(invite.callId)) continue;
      seen.add(invite.callId);
      const call = await ctx.db.get(invite.callId);
      if (!call || call.teamId !== actor.teamId) continue;
      if (!(await canSeeId(ctx, actor, call.channelId))) continue;
      if (call.endedAt === undefined) {
        const mine = await participationsOfMember(ctx, call._id, actor.member._id);
        if (!mine.some(isLive)) out.push({ callId: call._id, channelId: call.channelId, ended: false });
        continue;
      }
      if (call.transcriptDeletedAt !== undefined) continue;
      // Complete: notes, and proposals after them. A call that has proposals but no mark (from before
      // calls.propose set it) counts as complete too: calls.propose writes all of its tasks at once.
      if (call.notesMessageId !== undefined) {
        if (call.proposedAt !== undefined) continue;
        const proposal = await ctx.db
          .query("taskProposals")
          .withIndex("by_call", (q) => q.eq("callId", call._id))
          .first();
        if (proposal) continue;
      }
      const line = await ctx.db
        .query("transcriptLines")
        .withIndex("by_call_at", (q) => q.eq("callId", call._id))
        .first();
      if (line) out.push({ callId: call._id, channelId: call.channelId, ended: true });
    }
    return out;
  },
});

// ---------- transcript, notes and proposed tasks ----------

export const { person: addTranscript, agent: addTranscriptAgent } = roomMutation({
  name: "calls.addTranscript",
  description:
    "Add lines to a call's transcript: who said what, and when (ms). Only someone who was in the call can add, and each speaker must have been in it. Empty lines are skipped. Give each line a key to make a resend safe: a line whose key the call already has is skipped.",
  scope: "calls.notes",
  args: {
    callId: v.id("calls"),
    lines: v.array(
      v.object({ speakerId: v.id("members"), text: v.string(), at: v.number(), key: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, actor, args) => {
    const call = await callInTeam(ctx, actor, args.callId);
    await requireWasIn(ctx, actor, call);
    if (call.transcriptDeletedAt !== undefined) throw roomError("invalid", "This call's transcript was deleted.");
    if (args.lines.length > MAX_LINES_PER_CALL) {
      throw roomError("invalid", `Send at most ${MAX_LINES_PER_CALL} lines per call.`);
    }
    const speakers = new Set((await participationsOf(ctx, call._id)).map((p) => p.memberId as string));
    let added = 0;
    for (const line of args.lines) {
      const text = line.text.trim();
      if (!text) continue;
      if (!speakers.has(line.speakerId)) throw roomError("invalid", "A transcript line's speaker must have been in the call.");
      if (text.length > MAX_LINE_CHARS) throw roomError("invalid", `A transcript line can be at most ${MAX_LINE_CHARS} characters.`);
      if (line.key !== undefined) {
        if (line.key.length > 200) throw roomError("invalid", "A transcript line's key can be at most 200 characters.");
        const seen = await ctx.db
          .query("transcriptLines")
          .withIndex("by_call_key", (q) => q.eq("callId", call._id).eq("key", line.key))
          .first();
        if (seen) continue;
      }
      await ctx.db.insert("transcriptLines", {
        callId: call._id,
        speakerId: line.speakerId,
        text,
        at: line.at,
        addedBy: actor.member._id,
        ...(line.key !== undefined ? { key: line.key } : {}),
      });
      added++;
    }
    return { added };
  },
});

export const { person: transcript, agent: transcriptAgent } = roomQuery({
  name: "calls.transcript",
  description: "A call's transcript, oldest line first, and when it will be deleted (30 days after the call ends).",
  scope: "room.read",
  args: { callId: v.id("calls") },
  handler: async (ctx, actor, args) => {
    const call = await callInTeam(ctx, actor, args.callId);
    const rows = await ctx.db
      .query("transcriptLines")
      .withIndex("by_call_at", (q) => q.eq("callId", call._id))
      .collect();
    const names = new Map<string, Awaited<ReturnType<typeof memberView>>>();
    const lines = [];
    for (const row of rows) {
      if (!names.has(row.speakerId)) names.set(row.speakerId, await memberView(ctx, row.speakerId));
      lines.push({ speaker: names.get(row.speakerId)!, text: row.text, at: row.at });
    }
    return {
      lines,
      deleted: call.transcriptDeletedAt !== undefined,
      keptUntil: call.endedAt !== undefined ? call.endedAt + TRANSCRIPT_KEPT_MS : undefined,
    };
  },
});

export const { person: postNotes, agent: postNotesAgent } = roomMutation({
  name: "calls.postNotes",
  description:
    "Post a call's notes (Markdown) as a message in its channel. Posting again replaces the notes. Only someone who was in the call can post them.",
  scope: "calls.notes",
  args: { callId: v.id("calls"), body: v.string() },
  handler: async (ctx, actor, args) => {
    const call = await callInTeam(ctx, actor, args.callId);
    await requireWasIn(ctx, actor, call);
    const body = args.body.trim();
    if (!body) throw roomError("invalid", "Call notes need a body.");
    if (body.length > MAX_NOTES_CHARS) throw roomError("invalid", `Call notes can be at most ${MAX_NOTES_CHARS} characters.`);
    const existing = call.notesMessageId ? await ctx.db.get(call.notesMessageId) : null;
    if (existing) {
      await ctx.db.patch(existing._id, { body });
      return existing._id;
    }
    const channel = await ctx.db.get(call.channelId);
    if (!channel || channel.archivedAt !== undefined) throw roomError("invalid", "This channel is archived.");
    const messageId = await insertNotes(ctx, actor, channel, body);
    await ctx.db.patch(call._id, { notesMessageId: messageId });
    return messageId;
  },
});

export const { person: propose, agent: proposeAgent } = roomMutation({
  name: "calls.propose",
  description:
    "Propose tasks from a call, each with an optional suggested owner (a person). They become tasks only when a team member accepts them (calls.acceptProposal). Give each a key to make a resend safe: a proposal whose key the call already has isn't added again (its id is returned). After the call ends, call it once you've posted the notes, even with no tasks: that marks the notes complete (calls.unfinished).",
  scope: "calls.notes",
  args: {
    callId: v.id("calls"),
    tasks: v.array(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        ownerId: v.optional(v.id("members")),
        key: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, actor, args) => {
    const call = await callInTeam(ctx, actor, args.callId);
    await requireWasIn(ctx, actor, call);
    if (args.tasks.length > 50) throw roomError("invalid", "Propose at most 50 tasks at a time.");
    const ids: Id<"taskProposals">[] = [];
    for (const task of args.tasks) {
      if (task.key !== undefined) {
        if (task.key.length > 200) throw roomError("invalid", "A proposal's key can be at most 200 characters.");
        const seen = await ctx.db
          .query("taskProposals")
          .withIndex("by_call_key", (q) => q.eq("callId", call._id).eq("key", task.key))
          .first();
        if (seen) {
          ids.push(seen._id);
          continue;
        }
      }
      const title = task.title.trim();
      if (!title) throw roomError("invalid", "A proposed task needs a title.");
      if (task.ownerId) {
        const owner = await teamMember(ctx, actor, task.ownerId);
        if (owner.kind !== "person") throw roomError("invalid", "A task's owner must be a person, not an agent.");
      }
      ids.push(
        await ctx.db.insert("taskProposals", {
          teamId: actor.teamId,
          callId: call._id,
          channelId: call.channelId,
          title,
          ...(task.description?.trim() ? { description: task.description.trim() } : {}),
          ...(task.ownerId ? { ownerId: task.ownerId } : {}),
          proposedBy: actor.member._id,
          status: "pending",
          ...(task.key !== undefined ? { key: task.key } : {}),
        }),
      );
    }
    if (call.endedAt !== undefined && call.proposedAt === undefined) await ctx.db.patch(call._id, { proposedAt: Date.now() });
    return ids;
  },
});

async function pendingProposal(ctx: QueryCtx, actor: Actor, proposalId: Id<"taskProposals">) {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal || proposal.teamId !== actor.teamId) throw roomError("not_found", "Not found in this team.");
  await channelAccess(ctx, actor, proposal.channelId);
  if (proposal.status !== "pending") throw roomError("conflict", `This proposed task was already ${proposal.status}.`);
  return proposal;
}

export const { person: acceptProposal, agent: acceptProposalAgent } = roomMutation({
  name: "calls.acceptProposal",
  description:
    "Accept a proposed task: it becomes a Not started task in the channel's project. In a channel with no project, pass projectId (or null for no project). Optionally change its title or owner (a person) first.",
  scope: "work.manage",
  args: {
    proposalId: v.id("taskProposals"),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    title: v.optional(v.string()),
    ownerId: v.optional(v.id("members")),
  },
  handler: async (ctx, actor, args) => {
    const proposal = await pendingProposal(ctx, actor, args.proposalId);
    const channel = await ctx.db.get(proposal.channelId);
    let projectId: Id<"projects"> | undefined;
    if (args.projectId !== undefined) projectId = args.projectId ?? undefined;
    else if (channel?.projectId) projectId = channel.projectId;
    else throw roomError("invalid", "This channel has no project. Choose which project, or no project (projectId: null).");
    if (projectId) {
      const project = await inTeam(ctx, actor, projectId);
      if (project.archivedAt !== undefined) throw roomError("invalid", "That project is archived.");
    }
    const owner = await teamMember(ctx, actor, args.ownerId ?? proposal.ownerId ?? accountableId(actor));
    if (owner.kind !== "person") throw roomError("invalid", "A task's owner must be a person, not an agent.");
    // A task from a direct message's or private channel's call stays with that channel's members
    // (ADR 0016): the team sees it without its title, and only members can act on it, its owner too.
    const restricted = channel && hasMemberList(channel) ? channel : undefined;
    if (restricted && !(await memberCanSee(ctx, restricted, owner._id))) {
      throw roomError("invalid", `${owner.name} isn't in ${whereLabel(restricted)}, so they can't own a task from its call.`);
    }
    const title = (args.title ?? proposal.title).trim();
    if (!title) throw roomError("invalid", "A task needs a title.");
    const taskId = await ctx.db.insert("tasks", {
      teamId: actor.teamId,
      title,
      ...(proposal.description ? { description: proposal.description } : {}),
      ...(projectId ? { projectId } : {}),
      ownerId: owner._id,
      createdBy: actor.member._id,
      ...(restricted ? { directChannelId: restricted._id } : {}),
    });
    await ctx.db.patch(proposal._id, { status: "accepted", taskId, answeredBy: actor.member._id });
    await audit(ctx, actor, "call.proposal_accepted", proposal._id, { callId: proposal.callId, taskId });
    return taskId;
  },
});

export const { person: dismissProposal, agent: dismissProposalAgent } = roomMutation({
  name: "calls.dismissProposal",
  description: "Dismiss a proposed task, so it never becomes a task.",
  scope: "work.manage",
  args: { proposalId: v.id("taskProposals") },
  handler: async (ctx, actor, args) => {
    const proposal = await pendingProposal(ctx, actor, args.proposalId);
    await ctx.db.patch(proposal._id, { status: "dismissed", answeredBy: actor.member._id });
    await audit(ctx, actor, "call.proposal_dismissed", proposal._id, { callId: proposal.callId });
    return null;
  },
});

// ---------- one process per agent ----------

/** A lease lasts this long unless renewed. Holders renew about every 15 seconds. */
export const LEASE_MS = 45 * 1000;

async function leaseOf(ctx: QueryCtx, actor: Actor) {
  if (actor.kind !== "agent") throw roomError("invalid", "Call leases are for an agent's processes, not people.");
  return await ctx.db
    .query("callLeases")
    .withIndex("by_agent", (q) => q.eq("agentMemberId", actor.member._id))
    .unique();
}

export const { person: claimLease, agent: claimLeaseAgent } = roomMutation({
  name: "calls.claimLease",
  description:
    "Claim or renew the lease that lets one process take calls for this agent, so two copies (a restart overlapping the old process) never both join and write notes. `holder` names the process. Returns held: false while another process holds an unexpired lease. Leases last 45 seconds; renew about every 15.",
  scope: "calls.join",
  agentAudit: false,
  args: { holder: v.string() },
  handler: async (ctx, actor, args) => {
    const holder = args.holder.trim();
    if (!holder || holder.length > 200) throw roomError("invalid", "A lease holder is a name of 1 to 200 characters.");
    const lease = await leaseOf(ctx, actor);
    const now = Date.now();
    if (lease && lease.holder !== holder && lease.expiresAt > now) {
      return { held: false, expiresAt: lease.expiresAt, leaseMs: LEASE_MS };
    }
    const expiresAt = now + LEASE_MS;
    if (lease) await ctx.db.patch(lease._id, { holder, expiresAt });
    else await ctx.db.insert("callLeases", { agentMemberId: actor.member._id, holder, expiresAt });
    // leaseMs: the holder times the lease on its own clock, which may differ from the room's.
    return { held: true, expiresAt, leaseMs: LEASE_MS };
  },
});

export const { person: releaseLease, agent: releaseLeaseAgent } = roomMutation({
  name: "calls.releaseLease",
  description: "Give up this agent's call lease, if this holder has it, so another process can take calls at once.",
  scope: "calls.join",
  args: { holder: v.string() },
  handler: async (ctx, actor, args) => {
    const lease = await leaseOf(ctx, actor);
    if (lease && lease.holder === args.holder.trim()) await ctx.db.delete(lease._id);
    return null;
  },
});

/**
 * Deletes transcripts 30 days after their call ended (ADR 0008), a batch at a
 * time; it schedules itself again while there's more. Runs daily (crons.ts).
 */
export const pruneTranscripts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRANSCRIPT_KEPT_MS;
    const CALLS_PER_BATCH = 100;
    const due = await ctx.db
      .query("calls")
      .withIndex("by_transcript_ended", (q) =>
        q.eq("transcriptDeletedAt", undefined).gt("endedAt", 0).lt("endedAt", cutoff),
      )
      .take(CALLS_PER_BATCH);
    let budget = 2000;
    for (const call of due) {
      const lines = await ctx.db
        .query("transcriptLines")
        .withIndex("by_call_at", (q) => q.eq("callId", call._id))
        .take(budget + 1);
      for (const line of lines.slice(0, budget)) await ctx.db.delete(line._id);
      if (lines.length > budget) {
        // This call has more lines than the batch allows: carry on in the next run.
        await ctx.scheduler.runAfter(0, internal.calls.pruneTranscripts, {});
        return null;
      }
      budget -= lines.length;
      await ctx.db.patch(call._id, { transcriptDeletedAt: Date.now() });
      if (budget <= 0) {
        await ctx.scheduler.runAfter(0, internal.calls.pruneTranscripts, {});
        return null;
      }
    }
    // A full batch of calls may mean more are due: carry on rather than wait a day.
    if (due.length === CALLS_PER_BATCH) await ctx.scheduler.runAfter(0, internal.calls.pruneTranscripts, {});
    return null;
  },
});
