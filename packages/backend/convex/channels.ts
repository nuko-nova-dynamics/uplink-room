import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Actor } from "./lib/actor";
import {
  canSeeId,
  channelAccess,
  directMemberIds,
  directRunIds,
  hasMemberList,
  isDirect,
  isPrivate,
  kindOf,
  MAX_DIRECT_MEMBERS,
  memberCanSee,
  memberIdsOf,
  memberKeyOf,
  messageAccess,
  MIN_DIRECT_MEMBERS,
} from "./lib/channels";
import { roomError } from "./lib/errors";
import { isLiveRun, outputWarning, runNamer, runPerson, seesRun } from "./lib/runLabels";
import { directWarnings } from "./lib/runWarnings";
import { filesReach } from "./lib/runDelivery";
import { audit, memberView, teamMember, viewOf } from "./lib/members";
import { ensureRead, markReadUpTo, markUnreadFrom, readRow, readSummary, removeMention, startMembership, startTeamMember, teamSweeps } from "./lib/reads";
import { roomMutation, roomQuery } from "./lib/room";
import { setTyping, TYPING_FRESH_MS, TYPING_KEEP_MS } from "./lib/typing";
import { pinsOf } from "./messages";
import { revokeBrowserAccess } from "./browsers";
import { removeFromChannelCalls } from "./calls";
import { releaseChannelTerminals } from "./terminals";
import { releaseChannelThreads } from "./threads";
import { releaseChannelSpaces } from "./spaces";
import { bindingForRun, detachChannelRuns } from "./lib/a2a/runs";
import { effectiveVoice, LIMIT_LABEL, limitOf, vCallQuality, VOICE, voiceAllowed, type CallQualityLimit } from "./lib/callQuality";

const vLevel = v.union(v.literal("all"), v.literal("mentions"), v.literal("none"));

async function channelRow(
  ctx: QueryCtx,
  actor: Actor,
  c: Doc<"channels">,
  sweeps: Map<string, Doc<"messageSweeps">[]>,
  limit: CallQualityLimit,
) {
  const counts = await readSummary(ctx, c, actor.member._id, { sweeps, joined: actor.member._creationTime });
  const chosen = c.callQuality ?? "standard";
  const common = {
    channelId: c._id,
    projectId: c.projectId,
    lastMessageAt: c.lastMessageAt,
    unread: counts.unread,
    mentions: counts.mentions,
    notify: counts.notify,
    /** Where you had read up to, and the newest seq: the "new" divider goes after `readSeq`. */
    readSeq: counts.readSeq,
    lastSeq: counts.lastSeq,
    /** The voice quality its calls use: the one chosen, capped by the team's limit (issue #87). */
    callQuality: effectiveVoice(chosen, limit),
    /** The one chosen with channels.setCallQuality. Above `callQuality` only while the team's limit is lower. */
    callQualityChosen: chosen,
  };
  if (isPrivate(c)) {
    const members = await Promise.all((await memberIdsOf(ctx, c)).map((id) => memberView(ctx, id)));
    return { ...common, kind: "private" as const, name: c.name, members, createdBy: c.createdBy };
  }
  if (!isDirect(c)) return { ...common, kind: "channel" as const, name: c.name, members: undefined };
  const members = await Promise.all((await directMemberIds(ctx, c)).map((id) => memberView(ctx, id)));
  const others = members.filter((m) => m.memberId !== actor.member._id);
  const name = runNamer(ctx);
  const runs = [];
  for (const runId of await directRunIds(ctx, c)) {
    const run = await ctx.db.get(runId);
    // A closed run (ADR 0044) is there only for its person and their agents.
    if (!run || !(await seesRun(ctx, run, actor))) continue;
    const label = await name(run);
    // Whose output the run is, when people outside the direct message see it (ADR 0039, amended 2026-11-05).
    // How a file sent here reaches it (ADR 0043): the composer says so when it isn't with the message.
    runs.push({ runId, label, files: await filesReach(ctx, run), ...(await outputWarning(ctx, run, c, label)) });
  }
  return {
    ...common,
    kind: "direct" as const,
    /** A direct message has no name of its own: this is its runs' names, then its other members'. */
    name: [...runs.map((r) => r.label), ...others.map((m) => m.name)].join(", ") || "Just you",
    members,
    /**
     * The runs in it (ADR 0026), each with its name now. Their people are among its members. A run
     * whose output people outside it can see has `warning`, which the app shows by the composer, and
     * `seenBy`: team (a team run) or outside (a run from another private place).
     */
    runs,
  };
}

export const { person: list, agent: listAgent } = roomQuery({
  name: "channels.list",
  description:
    "List the team's channels that aren't archived, with the project each belongs to, and the private channels you are in (kind: 'private', with their members and createdBy), oldest first; then the direct messages you are in (kind: 'direct', with their members and the live runs in them, each named such as Claude Code (Julio) and, when people outside the direct message can see its output, with a warning to show whoever writes there and seenBy (team, or outside for a run from another private place), newest activity first; a direct message's name is its runs' names, then its other members'). Private channels you aren't in are never listed, for admins either. Each has your unread count, how many unread messages mention you or reply to you, your notification level, readSeq and lastSeq (the \"new\" divider goes after readSeq), and the voice quality of its calls: callQuality is what calls use (standard: Opus mono 48 kbps; high: mono 96 kbps; music: stereo 128 kbps with noise suppression and auto gain off), callQualityChosen what channels.setCallQuality set, which the team's limit (teams.settings) can cap.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    const team = channels.filter((c) => c.archivedAt === undefined && !hasMemberList(c));
    // Direct messages and private channels come from the actor's own memberships, never from the
    // team's list: one they aren't in is never read here.
    const memberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_member", (q) => q.eq("memberId", actor.member._id))
      .collect();
    const direct: Doc<"channels">[] = [];
    for (const row of memberships) {
      const channel = await ctx.db.get(row.channelId);
      if (!channel || channel.teamId !== actor.teamId || channel.archivedAt !== undefined) continue;
      if (isPrivate(channel)) team.push(channel);
      else direct.push(channel);
    }
    // An agent key limited to some channels (ADR 0049) lists only those.
    const limited = (c: Doc<"channels">) => !actor.channelIds || actor.channelIds.has(c._id);
    team.splice(0, team.length, ...team.filter(limited));
    direct.splice(0, direct.length, ...direct.filter(limited));
    team.sort((a, b) => a._creationTime - b._creationTime);
    direct.sort((a, b) => (b.lastMessageAt ?? b._creationTime) - (a.lastMessageAt ?? a._creationTime));
    const sweeps = await teamSweeps(ctx, actor.teamId);
    const limit = limitOf(await ctx.db.get(actor.teamId));
    return Promise.all([...team, ...direct].map((c) => channelRow(ctx, actor, c, sweeps, limit)));
  },
});

/** The most characters in a channel's name. */
export const MAX_CHANNEL_NAME = 80;
/** The most members one call adds (channels.createPrivate, channels.addMembers). */
export const MAX_ADD = 100;

/** A channel's name as typed, without a leading # and in lower case. */
function channelName(raw: string): string {
  const name = raw.trim().replace(/^#/, "").trim().toLowerCase();
  if (!name) throw roomError("invalid", "A channel needs a name.");
  if (name.length > MAX_CHANNEL_NAME) throw roomError("invalid", `A channel's name can be at most ${MAX_CHANNEL_NAME} characters.`);
  return name;
}

export const { person: create, agent: createAgent } = roomMutation({
  name: "channels.create",
  description:
    "Create a team channel that belongs to no project, such as #general or #random: everyone in the team can see it. For one only some people can see, use channels.createPrivate; a channel can't be made private later.",
  scope: "work.manage",
  args: { name: v.string() },
  handler: async (ctx, actor, args) => {
    const name = channelName(args.name);
    // No read rows: the whole team joined before anything in it, so it starts unread from its first message (lib/reads.ts).
    return await ctx.db.insert("channels", { teamId: actor.teamId, name });
  },
});

export const { person: openDirect, agent: openDirectAgent } = roomMutation({
  name: "channels.openDirect",
  description:
    "Open a direct message with one or more team members, people or agents, and live runs (runs.live), such as Claude Code (Julio): 2 to 10 members and runs, you included. Only its members can see it, list it and join its calls; a run's person (its driver, or the person who added an agent driver) joins it as a member, so they see what is said to their run, and so does an agent driving it, so it reads its run's messages and can answer. If one with exactly these members and runs exists, you get that one. Returns its channelId (post in it with messages.post) and warnings: each run in it whose output people outside it can see, with runId, label, warning and seenBy (team, or outside for a run from another private place); empty when there is none. An A2A agent in it gets each message as a run, and each run in it gets every message in its inbox (runs.inbox). Each run it is opened with hears every message there, though what a run hears shows in its terminal or thread: for a team run the whole team can see that, so what is said there doesn't stay private. Such a direct message says so in its first line, and warnings here and channels.list give each such run its warning, such as \"Claude Code (Ana)'s output is visible to the whole team, so what you send here won't stay private.\" Show it to whoever writes there: each sender's first messages.post there is refused with warning_required, naming the run, until they send it with acknowledgeWarning: true. Any other run addressed there hears it only when everyone who can see its output is in it; otherwise the message fails as visible_outside. Messaging a run needs only the messages.post scope.",
  scope: "messages.post",
  args: { memberIds: v.array(v.id("members")), runIds: v.optional(v.array(v.id("runs"))) },
  argDocs: { runIds: "Live runs to message, from runs.live. Each run's person joins as a member too" },
  handler: async (ctx, actor, args) => openDirectChannel(ctx, actor, args.memberIds, args.runIds ?? []),
});

/**
 * Finds or opens the direct message with these members and runs, as channels.openDirect does: the
 * actor is always in it. Also opens a person's Link conversation (members.setLink, ADR 0049).
 */
export async function openDirectChannel(
  ctx: MutationCtx,
  actor: Actor,
  memberIds: Id<"members">[],
  runIdsIn: Id<"runs">[],
) {
  const runIds = [...new Set(runIdsIn)];
  const people: Id<"members">[] = [];
  const closed: Doc<"runs">[] = [];
  for (const runId of runIds) {
    const run = await ctx.db.get(runId);
    if (!run || run.teamId !== actor.teamId || !(await seesRun(ctx, run, actor))) throw roomError("not_found", "Not found in this team.");
    if (!(await isLiveRun(ctx, run))) throw roomError("invalid", "That run isn't live, so it can't be messaged. runs.live lists the runs that are.");
    // A run from a direct message or private channel is acted on only by its members (ADR 0016).
    if (run.directChannelId && !(await canSeeId(ctx, actor, run.directChannelId))) {
      throw roomError("forbidden", "That run came from a private conversation you aren't in, so only its members can message it.");
    }
    const person = await runPerson(ctx, run);
    if (!person || person.removedAt !== undefined) throw roomError("invalid", "Nobody in the team answers for that run, so it can't be messaged.");
    if (run.closed === true) closed.push(run);
    // An agent driving the run joins too: it reads what the run is sent (runs.inbox) and answers there.
    if (run.driverId && run.driverId !== person._id) people.push(run.driverId);
    people.push(person._id);
  }
  const ids = [...new Set<Id<"members">>([actor.member._id, ...memberIds, ...people])];
  // A closed run (ADR 0044) is in a direct message only with its person and their agents: every
  // member, named or added for another run, must be one of them.
  for (const run of closed) {
    for (const id of ids) {
      const member = await ctx.db.get(id);
      const agent = member?.kind === "agent" && member.agentId ? await ctx.db.get(member.agentId) : null;
      const accountable = agent ? ((await ctx.db.get(agent.addedBy)) ?? undefined) : undefined;
      if (!member || !(await seesRun(ctx, run, { member, accountable }))) {
        throw roomError("invalid", "That run is closed, so only you and your agents can message it: open it first (uplink open, or runs.setOpen).");
      }
    }
  }
  if (ids.length + runIds.length < MIN_DIRECT_MEMBERS) throw roomError("invalid", "Name at least one other member or run to message.");
  if (ids.length + runIds.length > MAX_DIRECT_MEMBERS) {
    throw roomError("invalid", `A direct message has at most ${MAX_DIRECT_MEMBERS} members and runs. Use a channel for more.`);
  }
  for (const id of ids) await teamMember(ctx, actor, id);
  const memberKey = memberKeyOf([...ids, ...runIds.map((id) => `run:${id}`)]);
  const existing = await ctx.db
    .query("channels")
    .withIndex("by_team_member_key", (q) => q.eq("teamId", actor.teamId).eq("memberKey", memberKey))
    .first();
  // One from before the warning gets its line now, once (ADR 0039, amended 2026-11-05).
  if (existing && existing.archivedAt === undefined) return { channelId: existing._id, warnings: await directWarnings(ctx, existing) };
  const now = Date.now();
  const channelId = await ctx.db.insert("channels", {
    teamId: actor.teamId,
    name: "",
    kind: "direct",
    memberKey,
    lastSeq: 0,
    lastMessageAt: now,
  });
  for (const memberId of ids) {
    await ctx.db.insert("channelMembers", { teamId: actor.teamId, channelId, memberId, addedAt: now });
  }
  for (const runId of runIds) {
    await ctx.db.insert("channelRuns", { teamId: actor.teamId, channelId, runId, addedBy: actor.member._id, addedAt: now });
  }
  const channel = (await ctx.db.get(channelId))!;
  for (const memberId of ids) await startMembership(ctx, channel, memberId);
  // Its first lines say whose output each run is, before anyone sends it anything (ADR 0039, amended 2026-11-05).
  return { channelId, warnings: await directWarnings(ctx, channel) };
}

// ---------- private channels (ADR 0016) ----------

/** The other members to add: each a current team member, at most MAX_ADD, without repeats. */
async function membersToAdd(ctx: QueryCtx, actor: Actor, memberIds: Id<"members">[]) {
  const ids = [...new Set(memberIds)];
  if (ids.length > MAX_ADD) throw roomError("invalid", `Add at most ${MAX_ADD} members at a time.`);
  const members: Doc<"members">[] = [];
  for (const id of ids) members.push(await teamMember(ctx, actor, id));
  return members;
}

/** A private channel the actor is in, to change its members. */
async function privateChannel(ctx: QueryCtx, actor: Actor, channelId: Id<"channels">) {
  const channel = await channelAccess(ctx, actor, channelId);
  if (isDirect(channel)) {
    throw roomError("invalid", "A direct message keeps the members it started with. Start another one with the people you want.");
  }
  if (!isPrivate(channel)) {
    throw roomError("invalid", "Everyone in the team is in a team channel. Create a private channel for a smaller group.");
  }
  if (channel.archivedAt !== undefined) throw roomError("invalid", "This channel is archived.");
  return channel;
}

/**
 * Read rows for members who just joined a private channel: it counts as read for them up to now,
 * and new messages count from there, as when a direct message opens. The one place a private
 * channel starts its members, so a change to how read rows start (lib/reads.ts) is one edit here.
 * `channel` must be current.
 */
async function startMembers(ctx: MutationCtx, channel: Doc<"channels">, memberIds: Id<"members">[]) {
  for (const memberId of memberIds) {
    // Someone added back still has the read row from before they left. It starts again from now,
    // as a new member's does (nothing from their time away is unread, no old mention counts), and
    // keeps their notification level.
    if (await readRow(ctx, channel._id, memberId)) {
      await markReadUpTo(ctx, channel, memberId, (await ctx.db.get(channel._id))!.lastSeq ?? 0);
    } else {
      await startMembership(ctx, channel, memberId);
    }
  }
}

/** Archives a private channel nobody is left in, so it leaves every list and its calls can't start. */
export async function archiveIfEmpty(ctx: MutationCtx, channelId: Id<"channels">) {
  const channel = await ctx.db.get(channelId);
  if (!channel || !isPrivate(channel) || channel.archivedAt !== undefined) return;
  const left = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", channelId))
    .first();
  if (!left) await ctx.db.patch(channelId, { archivedAt: Date.now() });
}

/**
 * Takes a member out of a private channel: they can't see it from now on, they are taken out of
 * its calls (LiveKit disconnects and refuses their joins, calls.ts) and its shared browsers, and
 * an empty channel is archived.
 */
async function removeFromChannel(ctx: MutationCtx, actor: Actor, channel: Doc<"channels">, memberId: Id<"members">) {
  const row = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", channel._id).eq("memberId", memberId))
    .unique();
  if (row) await ctx.db.delete(row._id);
  await removeFromChannelCalls(ctx, channel._id, [memberId]);
  await revokeBrowserAccess(ctx, actor, { memberIds: [memberId], channelId: channel._id });
  // Work started there: terminals and Spaces they drive go back to someone in the channel, and an
  // agent's runs from there stop, so nothing queued or replied reaches it any more.
  await releaseChannelTerminals(ctx, actor, channel._id, memberId);
  await releaseChannelThreads(ctx, actor, channel._id, memberId);
  await releaseChannelSpaces(ctx, actor, channel._id, memberId);
  const member = await ctx.db.get(memberId);
  if (member?.kind === "agent") await detachChannelRuns(ctx, channel._id, member, actor.member._id);
  await archiveIfEmpty(ctx, channel._id);
}

export const { person: createPrivate, agent: createPrivateAgent } = roomMutation({
  name: "channels.createPrivate",
  description: `Create a private channel. Only its members, people or agents, can see it, find it in search or lists, read it, post, react, pin, get alerts from it, start or join its calls, open its shared browsers, or see its attachments and link previews; everyone else gets not_found, team admins included, and runs and tasks started there show the team no text. You are its first member; memberIds adds others (team members, at most ${MAX_ADD}). Any member can add more (channels.addMembers) and leave (channels.leave); you, and admins who are members, can remove members (channels.removeMember). It stays private, belongs to no project, and no channel can be made private or public later. Returns its channelId.`,
  scope: "work.manage",
  args: { name: v.string(), memberIds: v.optional(v.array(v.id("members"))) },
  handler: async (ctx, actor, args) => {
    const name = channelName(args.name);
    const others = (await membersToAdd(ctx, actor, args.memberIds ?? [])).filter((m) => m._id !== actor.member._id);
    const now = Date.now();
    const channelId = await ctx.db.insert("channels", {
      teamId: actor.teamId,
      name,
      kind: "private",
      createdBy: actor.member._id,
      lastSeq: 0,
    });
    await ctx.db.insert("channelMembers", { teamId: actor.teamId, channelId, memberId: actor.member._id, addedAt: now });
    for (const member of others) {
      await ctx.db.insert("channelMembers", {
        teamId: actor.teamId,
        channelId,
        memberId: member._id,
        addedAt: now,
        addedBy: actor.member._id,
      });
    }
    await startMembers(ctx, (await ctx.db.get(channelId))!, [actor.member._id, ...others.map((m) => m._id)]);
    // The activity log shows this only to the channel's members (activity.list).
    await audit(ctx, actor, "channel.private_created", channelId, { channelId, memberIds: others.map((m) => m._id) });
    return channelId;
  },
});

export const { person: addMembers, agent: addMembersAgent } = roomMutation({
  name: "channels.addMembers",
  description: `Add team members, people or agents, to a private channel you are in (at most ${MAX_ADD} at a time). From then on they see all of it, its history included, and it starts out read for them up to now. Someone already in it is skipped. Returns the ids added. A direct message keeps the members it started with, and a team channel already has the whole team.`,
  scope: "work.manage",
  args: { channelId: v.id("channels"), memberIds: v.array(v.id("members")) },
  handler: async (ctx, actor, args) => {
    const channel = await privateChannel(ctx, actor, args.channelId);
    const members = await membersToAdd(ctx, actor, args.memberIds);
    if (members.length === 0) throw roomError("invalid", "Name at least one member to add.");
    const added: Id<"members">[] = [];
    const now = Date.now();
    for (const member of members) {
      if (await memberCanSee(ctx, channel, member._id)) continue;
      await ctx.db.insert("channelMembers", {
        teamId: actor.teamId,
        channelId: channel._id,
        memberId: member._id,
        addedAt: now,
        addedBy: actor.member._id,
      });
      added.push(member._id);
    }
    await startMembers(ctx, channel, added);
    if (added.length) await audit(ctx, actor, "channel.members_added", channel._id, { channelId: channel._id, memberIds: added });
    return { added };
  },
});

export const { person: removeMember, agent: removeMemberAgent } = roomMutation({
  name: "channels.removeMember",
  description:
    "Remove a member from a private channel you are in. Its creator, and admins who are members, can remove anyone; anyone can remove themselves, as channels.leave does. They lose it at once: its messages, pins, attachments, calls (they are taken out of a live one, and LiveKit refuses their joins), shared browsers, and the texts of runs and tasks started there. A private channel nobody is left in is archived.",
  scope: "work.manage",
  args: { channelId: v.id("channels"), memberId: v.id("members") },
  handler: async (ctx, actor, args) => {
    const channel = await privateChannel(ctx, actor, args.channelId);
    if (args.memberId !== actor.member._id && actor.member._id !== channel.createdBy && actor.role !== "admin") {
      throw roomError("forbidden", "Only whoever created this channel, or an admin in it, can remove its members. Anyone can leave it.");
    }
    if (!(await memberCanSee(ctx, channel, args.memberId))) throw roomError("invalid", "They aren't in this channel.");
    await removeFromChannel(ctx, actor, channel, args.memberId);
    await audit(ctx, actor, "channel.member_removed", channel._id, { channelId: channel._id, memberId: args.memberId });
    return null;
  },
});

export const { person: leave, agent: leaveAgent } = roomMutation({
  name: "channels.leave",
  description:
    "Leave a private channel. You lose it at once, as if removed (channels.removeMember): only someone still in it can add you back. A private channel nobody is left in is archived. Team channels and direct messages can't be left.",
  scope: "messages.post",
  args: { channelId: v.id("channels") },
  handler: async (ctx, actor, args) => {
    const channel = await privateChannel(ctx, actor, args.channelId);
    await removeFromChannel(ctx, actor, channel, actor.member._id);
    await audit(ctx, actor, "channel.left", channel._id, { channelId: channel._id });
    return null;
  },
});

export const { person: members, agent: membersAgent } = roomQuery({
  name: "channels.members",
  description:
    "Who is in a channel you can see. For a private channel or a direct message: its members, in the order they were added, each with when and by whom (addedBy is absent for a private channel's creator and in direct messages). For a team channel: everyone in the team. creatorId is a private channel's creator; canRemove says whether you can remove others (its creator, or an admin in it).",
  scope: "room.read",
  args: { channelId: v.id("channels") },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    if (!hasMemberList(channel)) {
      const team = await ctx.db
        .query("members")
        .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
        .collect();
      return {
        kind: kindOf(channel),
        members: await Promise.all(
          team.filter((m) => m.removedAt === undefined).map(async (m) => ({ ...(await viewOf(ctx, m)), addedAt: undefined, addedBy: undefined })),
        ),
        creatorId: undefined,
        canRemove: false,
      };
    }
    const rows = await ctx.db
      .query("channelMembers")
      .withIndex("by_channel_member", (q) => q.eq("channelId", channel._id))
      .collect();
    rows.sort((a, b) => a.addedAt - b.addedAt);
    return {
      kind: kindOf(channel),
      members: await Promise.all(
        rows.map(async (r) => ({
          ...(await memberView(ctx, r.memberId)),
          addedAt: r.addedAt as number | undefined,
          addedBy: r.addedBy ? await memberView(ctx, r.addedBy) : undefined,
        })),
      ),
      creatorId: channel.createdBy,
      canRemove: isPrivate(channel) && (actor.member._id === channel.createdBy || actor.role === "admin"),
    };
  },
});

export const { person: markRead, agent: markReadAgent } = roomMutation({
  name: "channels.markRead",
  description:
    "Mark a channel or direct message read: up to its newest message, or up to and including the message upTo. Read state only moves forward, and follows you to every computer. Returns your readSeq.",
  scope: "room.read",
  agentAudit: false,
  args: { channelId: v.id("channels"), upTo: v.optional(v.id("messages")) },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    let seq = channel.lastSeq ?? 0;
    if (args.upTo) {
      const { message } = await messageAccess(ctx, actor, args.upTo);
      if (message.channelId !== channel._id) throw roomError("invalid", "That message is in another channel.");
      if (message.seq === undefined) return { readSeq: (await ensureRead(ctx, channel, actor.member._id)).readSeq };
      seq = message.seq;
    }
    return { readSeq: await markReadUpTo(ctx, channel, actor.member._id, seq) };
  },
});

export const { person: markUnread, agent: markUnreadAgent } = roomMutation({
  name: "channels.markUnread",
  description:
    "Mark a channel or direct message unread from one message on: that message and everything after it count as unread again, as in Discord's Mark unread. Mentions you already saw stay seen. Returns your readSeq. A message further back than a few thousand deletions or mentions is refused.",
  scope: "room.read",
  agentAudit: false,
  args: { channelId: v.id("channels"), from: v.id("messages") },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    const { message } = await messageAccess(ctx, actor, args.from);
    if (message.channelId !== channel._id) throw roomError("invalid", "That message is in another channel.");
    if (message.seq === undefined) throw roomError("invalid", "That message is from before unread counts, so it can't be marked unread.");
    const readSeq = await markUnreadFrom(ctx, channel, actor.member._id, message.seq);
    if (readSeq === null) throw roomError("invalid", "That message is too far back to mark unread from. Pick a newer one.");
    return { readSeq };
  },
});

/** How long after someone's last keystroke "is typing" still shows, in the app (by its own clock). */
export const TYPING_SHOWN_MS = 6000;

export const { person: typing, agent: typingAgent } = roomMutation({
  name: "channels.typing",
  description: `Say that you're writing in a channel or direct message (or in a thread, with replyTo), so others see "Ana is typing". Call it again every few seconds while you write; it shows for ${TYPING_SHOWN_MS / 1000} seconds after the last call. Posting a message ends it, and so does stop: true.`,
  scope: "messages.post",
  agentAudit: false,
  args: { channelId: v.id("channels"), replyTo: v.optional(v.id("messages")), stop: v.optional(v.boolean()) },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    if (args.replyTo) {
      const { message } = await messageAccess(ctx, actor, args.replyTo);
      if (message.channelId !== channel._id) throw roomError("invalid", "That message is in another channel.");
    }
    await setTyping(ctx, channel, actor.member._id, args.stop ? null : { replyTo: args.replyTo });
    return null;
  },
});

export const { person: whoIsTyping, agent: whoIsTypingAgent } = roomQuery({
  name: "channels.whoIsTyping",
  description: `Who else is writing in a channel or direct message: each with when they last typed (at, ms) and the thread they're answering (replyTo), if any. Only who typed in the last ${TYPING_FRESH_MS / 1000} seconds; show someone while their at is under ${TYPING_SHOWN_MS / 1000} seconds old. An agent working on a message sent to it over A2A (ADR 0024) is listed with working: true for as long as it works, whatever its at says.`,
  scope: "room.read",
  args: { channelId: v.id("channels") },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    // Who typed in the last few seconds. Convex doesn't re-run a subscribed query as time passes
    // (docs.convex.dev, Best Practices, Date.now() in queries), so the app also drops a row once it is
    // that old by its own clock; this keeps one that's long gone from ever coming back as new.
    const fresh = Date.now() - TYPING_FRESH_MS;
    // The channel's rows, few since stale ones are pruned: an agent's working row can be older than
    // TYPING_FRESH_MS and still shows, until its run stops working.
    const rows = await ctx.db
      .query("typing")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .order("desc")
      .take(40);
    const others = rows.filter((r) => r.memberId !== actor.member._id && (r.at > fresh || r.runId !== undefined)).slice(0, 20);
    return Promise.all(
      others.map(async (r) => ({
        member: await memberView(ctx, r.memberId),
        at: r.at,
        ...(r.replyTo ? { replyTo: r.replyTo } : {}),
        ...(r.runId ? { working: true } : {}),
      })),
    );
  },
});

/** Typing rows quiet for a minute, deleted in batches (crons.ts): drafts abandoned without a stop. */
export const pruneTyping = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("typing")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - TYPING_KEEP_MS))
      .take(500);
    let deleted = 0;
    for (const r of stale) {
      // An agent still working on its run keeps its row (ADR 0024); one whose run stopped, or isn't followed, loses it.
      if (r.runId) {
        const run = await ctx.db.get(r.runId);
        const binding = run ? await bindingForRun(ctx, run._id) : null;
        if (run && binding?.following && (run.state === "working" || run.state === "unknown")) continue;
      }
      await ctx.db.delete(r._id);
      deleted++;
    }
    return deleted;
  },
});

/** At most this many messages per channels.markSeen. */
export const MAX_SEEN = 50;

export const { person: markSeen, agent: markSeenAgent } = roomMutation({
  name: "channels.markSeen",
  description: `Mark messages you saw outside a channel's own list, such as replies read in their thread, as seen without moving where the channel is read up to: the ones that mention you (or @everyone, or reply to you) stop counting in your mention count. They stay unread until channels.markRead passes them, so messages you haven't seen aren't marked read with them. At most ${MAX_SEEN} at a time.`,
  scope: "room.read",
  agentAudit: false,
  args: { channelId: v.id("channels"), messageIds: v.array(v.id("messages")) },
  handler: async (ctx, actor, args) => {
    if (args.messageIds.length > MAX_SEEN) throw roomError("invalid", `At most ${MAX_SEEN} messages at a time.`);
    const channel = await channelAccess(ctx, actor, args.channelId);
    for (const messageId of args.messageIds) {
      const message = await ctx.db.get(messageId);
      if (message?.channelId === channel._id) await removeMention(ctx, messageId, actor.member._id);
    }
    return null;
  },
});

export const { person: setNotify, agent: setNotifyAgent } = roomMutation({
  name: "channels.setNotify",
  description:
    "Choose what a channel or direct message tells you about (banners in the app, and messages.addressed): 'all' messages, only 'mentions' (mentions of you, @everyone and replies to you), or 'none'. Defaults: all for direct messages, mentions for channels. With 'none', @everyone doesn't count as a mention for you.",
  scope: "messages.post",
  args: { channelId: v.id("channels"), level: vLevel },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    const row = await ensureRead(ctx, channel, actor.member._id);
    await ctx.db.patch(row._id, { notify: args.level });
    return null;
  },
});

export const { person: setCallQuality, agent: setCallQualityAgent } = roomMutation({
  name: "channels.setCallQuality",
  description:
    "Choose the voice quality of a channel's or direct message's calls: 'standard' (Opus mono 48 kbps, for talking; the default), 'high' (mono 96 kbps) or 'music' (Opus stereo 128 kbps, with noise suppression, Krisp and auto gain off and echo cancellation on). It applies to everyone in the call at once: each app republishes its microphone. In a team channel only admins can change it; in a private channel or a direct message, any member can. A choice above the team's limit (teams.settings) is refused.",
  scope: "work.manage",
  args: { channelId: v.id("channels"), quality: vCallQuality },
  handler: async (ctx, actor, args) => {
    const channel = await channelAccess(ctx, actor, args.channelId);
    if (channel.archivedAt !== undefined) throw roomError("invalid", "This channel is archived.");
    if (!hasMemberList(channel) && actor.role !== "admin") {
      throw roomError("forbidden", "Only admins can change a team channel's call quality.");
    }
    const limit = limitOf(await ctx.db.get(actor.teamId));
    if (!voiceAllowed(args.quality, limit)) {
      throw roomError(
        "forbidden",
        `${VOICE[args.quality].label} is above your team's limit (${LIMIT_LABEL[limit]}). An admin can change the limit in Settings, Calls.`,
      );
    }
    if ((channel.callQuality ?? "standard") === args.quality) return null;
    await ctx.db.patch(channel._id, { callQuality: args.quality });
    // The activity log shows a private channel's entries only to its members (activity.list).
    await audit(ctx, actor, "channel.call_quality", channel._id, { channelId: channel._id, quality: args.quality });
    return null;
  },
});

export const { person: pins, agent: pinsAgent } = roomQuery({
  name: "channels.pins",
  description: "A channel's or direct message's pinned messages, newest pin first, each with who pinned it and when.",
  scope: "room.read",
  args: { channelId: v.id("channels") },
  handler: async (ctx, actor, args) => {
    await channelAccess(ctx, actor, args.channelId);
    return pinsOf(ctx, actor, args.channelId);
  },
});

/** The rest of a partial markRead that crossed more deletions or mentions than one step counts (lib/reads.ts). */
export const continueRead = internalMutation({
  // `generation`: the read row's readGeneration when the markRead started (absent on steps
  // scheduled before it was kept, which go on as before).
  args: { channelId: v.id("channels"), memberId: v.id("members"), seq: v.number(), generation: v.optional(v.number()) },
  handler: async (ctx, { channelId, memberId, seq, generation }) => {
    const channel = await ctx.db.get(channelId);
    if (!channel) return null;
    // Marked unread since this markRead started: the rest of it would undo that, so it stops.
    if (generation !== undefined && ((await readRow(ctx, channelId, memberId))?.readGeneration ?? 0) !== generation) return null;
    await markReadUpTo(ctx, channel, memberId, seq);
    return null;
  },
});

/** The next channels of a new team member's read rows, for a team with more channels than one step makes (lib/reads.ts). */
export const continueJoin = internalMutation({
  args: { teamId: v.id("teams"), memberId: v.id("members"), cursor: v.string() },
  handler: async (ctx, { teamId, memberId, cursor }) => {
    const member = await ctx.db.get(memberId);
    if (member && member.removedAt === undefined) await startTeamMember(ctx, teamId, memberId, cursor);
    return null;
  },
});
