import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireAdmin, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { audit, teamMember } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { ALL_SCOPES, SCOPES } from "./lib/scopes";
import { archiveIfEmpty, openDirectChannel } from "./channels";
import { reachOf } from "./lib/deliveries";
import { linkOf, linkReach } from "./lib/link";
import { vRole } from "./schema";
import { revokeBrowserAccess } from "./browsers";
import { removeFromCalls } from "./calls";
import { cancelAdminConnects, disconnectMembersAccounts } from "./github";
import { endLiveSpaces } from "./lib/spaces";
import { endLiveTerminals, stopActiveRuns } from "./machines";

async function adminCount(ctx: MutationCtx, teamId: Id<"teams">): Promise<number> {
  const members = await ctx.db
    .query("members")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .collect();
  return members.filter((m) => m.role === "admin" && m.kind === "person" && m.removedAt === undefined).length;
}

export const { person: me, agent: meAgent } = roomQuery({
  name: "members.me",
  description:
    "Who you are in this team. Call it first. Returns your memberId (the id that <@memberId> mentions, ownerId, driver and author fields use), name, kind ('person' or 'agent') and role, and the team's id and name. For an agent, also its agentId, the person accountable for it (addedBy: an agent can do at most what they can), and this key's name, its scopes (what each allows) and the scopes it lacks: a call that needs one of those fails with forbidden, and only the person who added you can add it. A key limited to some channels also lists channelIds: it sees no other channel.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const team = await ctx.db.get(actor.teamId);
    const base = {
      memberId: actor.member._id,
      name: actor.member.name,
      kind: actor.kind,
      role: actor.role,
      team: { teamId: actor.teamId, name: team?.name ?? "" },
    };
    if (actor.kind === "person" || actor.scopes === "all") return base;
    const key = actor.agentKeyId ? await ctx.db.get(actor.agentKeyId) : null;
    const has = ALL_SCOPES.filter((scope) => actor.scopes !== "all" && actor.scopes.has(scope));
    return {
      ...base,
      agentId: actor.member.agentId,
      addedBy: actor.accountable ? { memberId: actor.accountable._id, name: actor.accountable.name } : undefined,
      key: key ? { keyId: key._id, name: key.name } : undefined,
      scopes: has.map((scope) => ({ scope, allows: SCOPES[scope] })),
      lacksScopes: ALL_SCOPES.filter((scope) => !has.includes(scope)),
      // A key limited to some channels (ADR 0049) sees only these; anywhere else answers not_found.
      ...(key?.channelIds ? { channelIds: key.channelIds } : {}),
    };
  },
});

export const { person: setRole, agent: setRoleAgent } = roomMutation({
  name: "members.setRole",
  description:
    "Make a member an admin or a member. An agent can be an admin only if the person who added it is one.",
  scope: "team.admin",
  args: { memberId: v.id("members"), role: vRole },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const member = await teamMember(ctx, actor, args.memberId);
    if (member.kind === "agent" && args.role === "admin" && member.agentId) {
      const agent = await ctx.db.get(member.agentId);
      const person = agent ? await ctx.db.get(agent.addedBy) : null;
      if (!person || person.role !== "admin") {
        throw roomError(
          "invalid",
          `${member.name} can't be an admin: an agent can't have more than ${person?.name ?? "its person"} can, and ${person?.name ?? "they"} isn't an admin.`,
        );
      }
    }
    if (member.role === "admin" && args.role === "member" && member.kind === "person") {
      if ((await adminCount(ctx, actor.teamId)) <= 1) throw roomError("invalid", "A team needs at least one person who is an admin.");
    }
    await ctx.db.patch(member._id, { role: args.role });
    if (member.role === "admin" && args.role === "member") await cancelAdminConnects(ctx, member._id);
    await audit(ctx, actor, "member.role_changed", member._id, { role: args.role });
    return null;
  },
});

export const { person: remove, agent: removeAgent } = roomMutation({
  name: "members.remove",
  description:
    "Remove a member from the team. Removing a person also stops the agents they added, unlinks the personal machines they linked (team machines they linked stay), and disconnects the personal GitHub accounts they connected (its repos leave the repo pickers; organizations they connected stay).",
  scope: "team.admin",
  args: { memberId: v.id("members") },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const member = await teamMember(ctx, actor, args.memberId);
    if (member.role === "admin" && member.kind === "person" && (await adminCount(ctx, actor.teamId)) <= 1) {
      throw roomError("invalid", "A team needs at least one person who is an admin.");
    }
    await removeMember(ctx, actor, member);
    return null;
  },
});

/**
 * Takes a member out of `actor`'s team: `members.remove`, after its checks. Account deletion
 * (accounts.ts, ADR 0035) takes the same steps, with the departing person as the actor and
 * `details` saying why, but leaves the channels and machines in batches of its own.
 */
export async function removeMember(ctx: MutationCtx, actor: Actor, member: Doc<"members">, details?: { reason: "account_deleted" }): Promise<void> {
  const memberIds = await beginRemoval(ctx, actor, member, details);
  while (await leaveChannelsStep(ctx, memberIds));
  while (await takeBackMachineStep(ctx, actor, member, details?.reason ?? "member_removed"));
}

/**
 * One step of taking a departing person's personal machines out of the team (ADR 0035): one
 * machine is unlinked, as machines.unlink takes one, and its bridge token forgotten, so a token the
 * person kept reads and reports nothing; then the pairing codes they or their agents made that
 * nobody used are deleted. A team machine they linked is the team's and stays linked. True while
 * more may be left.
 */
export async function takeBackMachineStep(
  ctx: MutationCtx,
  actor: Actor,
  member: Doc<"members">,
  reason: "account_deleted" | "member_removed",
): Promise<boolean> {
  const machines = await ctx.db
    .query("machines")
    .withIndex("by_team", (q) => q.eq("teamId", member.teamId))
    .collect();
  const machine = machines.find((m) => m.belongsTo.kind === "person" && m.belongsTo.memberId === member._id && m.unlinkedAt === undefined);
  if (machine) {
    await endLiveTerminals(ctx, machine._id);
    await endLiveSpaces(ctx, machine._id);
    await stopActiveRuns(ctx, machine._id);
    await ctx.db.patch(machine._id, { unlinkedAt: Date.now(), bridgeTokenHash: undefined });
    await audit(ctx, actor, "machine.unlinked", machine._id, { reason });
    return true;
  }
  let codes = 0;
  for (const memberId of await leavingWith(ctx, member)) {
    // A cloud machine's code is the room's own, for the team's machine, and stays.
    for (const code of await ctx.db
      .query("pairingCodes")
      .withIndex("by_created_by_used", (q) => q.eq("createdBy", memberId).eq("usedAt", undefined))
      .take(CODES_STEP)) {
      if (code.machineId) continue;
      await ctx.db.delete(code._id);
      codes++;
    }
  }
  return codes > 0;
}

/** At most this many unused pairing codes are read per member in one step. */
const CODES_STEP = 200;

/**
 * The first part of taking a member out, in one step whatever they have: they're out of the team,
 * the agents they added stop, and they lose their shared browsers, their calls (the calls' own
 * steps follow, calls.ts) and the personal GitHub accounts they connected. Their private channels
 * and direct messages are left to `leaveChannelsStep`. Returns who leaves with them.
 */
export async function beginRemoval(ctx: MutationCtx, actor: Actor, member: Doc<"members">, details?: { reason: "account_deleted" }): Promise<Id<"members">[]> {
  await ctx.db.patch(member._id, { removedAt: Date.now() });
  // Removing a person also stops the agents they added, so their browser access goes too.
  const memberIds = await leavingWith(ctx, member);
  await revokeBrowserAccess(ctx, actor, { memberIds });
  // Every call they are in, the direct messages' and private channels' calls included.
  await removeFromCalls(ctx, memberIds);
  // ADR 0020: the personal GitHub accounts they connected go with them; organizations stay the team's.
  await disconnectMembersAccounts(ctx, actor, memberIds);
  await audit(ctx, actor, "member.removed", member._id, details);
  return memberIds;
}

/**
 * At most this many private channel and direct message seats are taken away in one step. Each
 * reads two index ranges (the channel, and whether anyone is left in it), so a step stays far
 * under Convex's 4,096.
 */
export const LEAVE_CHANNELS_STEP = 500;

/**
 * One step of the rest of taking members out (ADR 0015 and 0016): they leave every direct message
 * and private channel, and can't read them again, and a private channel nobody is left in is
 * archived. True while more may be left.
 */
export async function leaveChannelsStep(ctx: MutationCtx, memberIds: Id<"members">[]): Promise<boolean> {
  let budget = LEAVE_CHANNELS_STEP;
  for (const memberId of memberIds) {
    const rows = await ctx.db
      .query("channelMembers")
      .withIndex("by_member", (q) => q.eq("memberId", memberId))
      .take(budget);
    for (const row of rows) {
      await ctx.db.delete(row._id);
      await archiveIfEmpty(ctx, row.channelId);
    }
    budget -= rows.length;
    if (budget === 0) return true;
  }
  return false;
}

/** The member, and for a person the agents they added in its team: who stops when they leave. */
export async function leavingWith(ctx: QueryCtx, member: Doc<"members">): Promise<Id<"members">[]> {
  const memberIds = [member._id];
  if (member.kind !== "person") return memberIds;
  for (const agent of await ctx.db.query("agents").withIndex("by_team", (q) => q.eq("teamId", member.teamId)).collect()) {
    if (agent.addedBy !== member._id) continue;
    const agentMember = await ctx.db.query("members").withIndex("by_agent", (q) => q.eq("agentId", agent._id)).unique();
    if (agentMember) memberIds.push(agentMember._id);
  }
  return memberIds;
}

const vOnOff = v.union(v.literal("on"), v.literal("off"));

function requirePerson(actor: { kind: "person" | "agent" }): void {
  if (actor.kind !== "person") throw roomError("forbidden", "Email notifications belong to people; agents get no email.");
}

export const { person: emailNotifications, agent: emailNotificationsAgent } = roomQuery({
  name: "members.emailNotifications",
  description:
    "Your own email notifications in this team (people): joined, whether you get an email when someone you invited joins, and the address they go to (null if Uplink Room has none for you).",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    requirePerson(actor);
    const person = actor.member.personId ? await ctx.db.get(actor.member.personId) : null;
    return { joined: actor.member.joinedEmails ?? ("on" as const), email: person?.email ?? null };
  },
});

export const { person: setEmailNotifications, agent: setEmailNotificationsAgent } = roomMutation({
  name: "members.setEmailNotifications",
  description:
    "Turn your own email notifications in this team on or off (people). joined: an email when someone you invited joins. The invites, reminders and welcomes other people get aren't affected.",
  scope: "messages.post",
  args: { joined: vOnOff },
  handler: async (ctx, actor, args) => {
    requirePerson(actor);
    await ctx.db.patch(actor.member._id, { joinedEmails: args.joined });
    return null;
  },
});

export const { person: setLink, agent: setLinkAgent } = roomMutation({
  name: "members.setLink",
  description:
    "Choose your Link (people, ADR 0049): the agent your Inbox talks to. What you write in the Inbox goes to it in a direct message with you; it answers there, or starts the work itself with tasks.create and runs.start. Pass agentMemberId, an agent in the team that the room can reach (over A2A, at a routine webhook, or through the connector when it checks in), or null for none: the Inbox's box then starts a thread on Enter. Returns the direct message's channelId, or null.",
  scope: "messages.post",
  args: { agentMemberId: v.union(v.id("members"), v.null()) },
  argDocs: { agentMemberId: "The agent's member id, from teams.roster or teams.members, or null to have no Link" },
  handler: async (ctx, actor, args) => {
    if (actor.kind !== "person") throw roomError("forbidden", "A Link belongs to a person: it is the agent their Inbox talks to.");
    if (args.agentMemberId === null) {
      await ctx.db.patch(actor.member._id, { link: undefined });
      return null;
    }
    const agent = await teamMember(ctx, actor, args.agentMemberId);
    if (agent.kind !== "agent" || !agent.agentId) throw roomError("invalid", "Your Link is an agent: pick one from the roster.");
    const agentDoc = await ctx.db.get(agent.agentId);
    if (!agentDoc || !(await linkReach(ctx, actor.member, agentDoc))) {
      const a2a = (await reachOf(ctx, agent.agentId)) === "a2a";
      throw roomError(
        "invalid",
        a2a
          ? `${agent.name} can't take messages from you over A2A: its Agent Card has no endpoint yet, or it takes work only from the person who added it.`
          : `The room can't reach ${agent.name} yet, so it wouldn't get your messages. Connect it over A2A, give it a routine webhook, or connect it through the connector first.`,
      );
    }
    const { channelId } = await openDirectChannel(ctx, actor, [agent._id], []);
    await ctx.db.patch(actor.member._id, { link: { memberId: agent._id, channelId } });
    return { channelId };
  },
});

/** The longest custom status, in characters: one line beside a name. */
export const MAX_STATUS = 80;

export const { person: setStatus, agent: setStatusAgent } = roomMutation({
  name: "members.setStatus",
  description: `Set your custom status: a short line on what you're doing, such as "Reviewing PRs" or "Heads down until 3", which teammates see beside your name in People (teams.members gives it as status). Up to ${MAX_STATUS} characters on one line; pass null or an empty string to clear it.`,
  scope: "messages.post",
  args: { text: v.union(v.string(), v.null()) },
  argDocs: { text: `Your status, up to ${MAX_STATUS} characters, or null to clear it` },
  handler: async (ctx, actor, args) => {
    const text = (args.text ?? "").replace(/\s+/g, " ").trim();
    if ([...text].length > MAX_STATUS) throw roomError("invalid", `A status is at most ${MAX_STATUS} characters.`);
    await ctx.db.patch(actor.member._id, { status: text || undefined });
    return null;
  },
});

export const { person: link, agent: linkAgent } = roomQuery({
  name: "members.link",
  description:
    "Your Link (ADR 0049), or null: the agent your Inbox talks to (memberId, agentId, name), the direct message with it (channelId), and how the room reaches it with your messages (reach: a2a, webhook or checks_in; null when it can't). For an agent, its person's Link only when that agent is the Link itself; null otherwise.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const person = actor.kind === "person" ? actor.member : actor.accountable;
    const found = person ? await linkOf(ctx, person) : null;
    if (!person || !found?.agent.agentId) return null;
    // Another of the person's agents isn't in that direct message, so it doesn't learn of it.
    if (actor.kind === "agent" && actor.member._id !== found.agent._id) return null;
    const agent = await ctx.db.get(found.agent.agentId);
    return {
      memberId: found.agent._id,
      agentId: found.agent.agentId,
      name: found.agent.name,
      channelId: found.channel._id,
      reach: agent ? await linkReach(ctx, person, agent) : null,
    };
  },
});

/** A heartbeat is written at most this often while nothing changes, so a minute's beat stays one write. */
export const PRESENCE_WRITE_MS = 45_000;
/** A session counts this long after its last beat: a beat a minute, with room for one late one. */
export const PRESENCE_LIVE_MS = 150_000;
/** A member's other sessions quiet for this long are deleted at their next beat; their newest is kept for "Last seen". */
export const PRESENCE_KEEP_MS = 60 * 60_000;
/** At most this many sessions are kept per member. */
export const PRESENCE_MAX_SESSIONS = 8;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const { person: heartbeat, agent: heartbeatAgent } = roomMutation({
  name: "members.heartbeat",
  description:
    "Say you're here, about once a minute while the app is open: others see you as active (active: true, the window is in use) or away (open but idle). Past a couple of minutes without one, the app shows you as offline. Pass a sessionId (8 to 64 letters, digits, - or _) that stays the same for one launch of your app, so an idle window on one computer doesn't hide an active one on another. An agent may call it too; its teammates then see it as online.",
  scope: "room.read",
  agentAudit: false,
  args: { active: v.boolean(), sessionId: v.optional(v.string()) },
  handler: async (ctx, actor, args) => {
    if (args.sessionId !== undefined && !SESSION_ID.test(args.sessionId)) {
      throw roomError("invalid", "sessionId is 8 to 64 letters, digits, - or _.");
    }
    const mine = await ctx.db
      .query("presence")
      .withIndex("by_member", (q) => q.eq("memberId", actor.member._id))
      .take(PRESENCE_MAX_SESSIONS * 4);
    const row = mine.find((r) => r.sessionId === args.sessionId);
    const now = Date.now();
    const beat = { lastSeenAt: now, active: args.active, expiresAt: now + PRESENCE_LIVE_MS };
    if (!row) {
      await ctx.db.insert("presence", {
        teamId: actor.teamId,
        memberId: actor.member._id,
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        ...beat,
      });
    } else if (row.active !== args.active || now - row.lastSeenAt >= PRESENCE_WRITE_MS) {
      await ctx.db.patch(row._id, beat);
    }
    // This member's other sessions: those quiet for an hour go, and any past the newest few.
    const others = mine.filter((r) => r !== row).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const [i, r] of others.entries()) {
      if (now - r.lastSeenAt > PRESENCE_KEEP_MS || i >= PRESENCE_MAX_SESSIONS - 1) await ctx.db.delete(r._id);
    }
    return null;
  },
});

/**
 * A member's presence from their sessions: last seen at their newest beat, and active while a session
 * that beat within PRESENCE_LIVE_MS of that newest one says so. Measured against the newest beat, not
 * the clock, so the query reads no time (Convex doesn't re-run a query as time passes); the app
 * counts someone as offline once their newest beat is too old by its own clock.
 */
export function presenceOf(sessions: { lastSeenAt: number; active: boolean }[]): { lastSeenAt: number; active: boolean } | null {
  if (sessions.length === 0) return null;
  const lastSeenAt = Math.max(...sessions.map((s) => s.lastSeenAt));
  return { lastSeenAt, active: sessions.some((s) => s.active && lastSeenAt - s.lastSeenAt <= PRESENCE_LIVE_MS) };
}

export const { person: presence, agent: presenceAgent } = roomQuery({
  name: "members.presence",
  description:
    "When each member of the team last had the app open (lastSeenAt, ms) and whether they were using it (active: true while any of their app sessions that beat lately is in use). Count someone as offline when lastSeenAt is more than about two and a half minutes old. Members who never sent a heartbeat aren't listed.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .take(4000);
    const byMember = new Map<string, typeof rows>();
    for (const r of rows) byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r]);
    return [...byMember.entries()].map(([memberId, sessions]) => ({ memberId: memberId as Id<"members">, ...presenceOf(sessions)! }));
  },
});
