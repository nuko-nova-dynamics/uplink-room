import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { canSeeId, memberCanSee, taskOutsideChannels } from "./channels";
export { taskOutsideChannels };
import { roomError } from "./errors";
import { seesRun } from "./runLabels";

export type MemberView = {
  memberId: Id<"members">;
  name: string;
  kind: "person" | "agent";
  /** For agents: the person accountable for it. */
  addedBy?: { memberId: Id<"members">; name: string };
};

/** How a member is shown: an agent's actions always carry the agent's name and who added it. */
export async function memberView(ctx: QueryCtx, memberId: Id<"members">): Promise<MemberView> {
  const member = await ctx.db.get(memberId);
  if (!member) return { memberId, name: "Former member", kind: "person" };
  return viewOf(ctx, member);
}

export async function viewOf(ctx: QueryCtx, member: Doc<"members">): Promise<MemberView> {
  if (member.kind === "agent" && member.agentId) {
    const agent = await ctx.db.get(member.agentId);
    const addedBy = agent ? await ctx.db.get(agent.addedBy) : null;
    return {
      memberId: member._id,
      name: member.name,
      kind: "agent",
      ...(addedBy ? { addedBy: { memberId: addedBy._id, name: addedBy.name } } : {}),
    };
  }
  return { memberId: member._id, name: member.name, kind: member.kind };
}

export async function maybeView(ctx: QueryCtx, memberId: Id<"members"> | undefined) {
  return memberId ? await memberView(ctx, memberId) : undefined;
}

/** A current member of the actor's team, or a not-found error. */
export async function teamMember(
  ctx: QueryCtx,
  actor: Actor,
  memberId: Id<"members">,
): Promise<Doc<"members">> {
  const member = await ctx.db.get(memberId);
  if (!member || member.teamId !== actor.teamId || member.removedAt !== undefined) {
    throw roomError("not_found", "That member isn't in this team.");
  }
  return member;
}

/**
 * Loads a document and checks it belongs to the actor's team. A channel, and anything that lives
 * in one (a message, a shared browser, saved logins), also needs the actor to see that channel
 * (lib/channels.ts): a direct message or private channel is only for its members.
 */
export async function inTeam<T extends "projects" | "channels" | "tasks" | "runs" | "machines" | "terminals" | "spaces" | "profiles" | "agents" | "messages" | "browsers" | "savedLogins">(
  ctx: QueryCtx,
  actor: Actor,
  id: Id<T>,
): Promise<Doc<T>> {
  const doc = (await ctx.db.get(id)) as (Doc<T> & { teamId: Id<"teams"> }) | null;
  if (!doc || doc.teamId !== actor.teamId) throw roomError("not_found", "Not found in this team.");
  const channelId =
    ctx.db.normalizeId("channels", id) ??
    ("channelId" in doc ? (doc as { channelId?: Id<"channels"> }).channelId : undefined);
  if (channelId && !(await canSeeId(ctx, actor, channelId))) {
    throw roomError("not_found", "Not found in this team.");
  }
  // A run sent from a direct message or private channel, and a task from one, can be acted on only
  // by that channel's members (ADR 0015, ADR 0016). The team still sees them, without their texts,
  // through runs.get, tasks.get, the board and the Inbox.
  const direct = "directChannelId" in doc ? (doc as { directChannelId?: Id<"channels"> }).directChannelId : undefined;
  if (direct && !(await canSeeId(ctx, actor, direct))) {
    throw roomError("not_found", "Not found in this team.");
  }
  // A task in a project counts as that project's channel for an agent key limited to some (ADR 0049).
  if (ctx.db.normalizeId("tasks", id) && (await taskOutsideChannels(ctx, actor, doc as unknown as Doc<"tasks">))) {
    throw roomError("not_found", "Not found in this team.");
  }
  // A closed run (ADR 0044) is there only for its person and their agents.
  const asRun = ctx.db.normalizeId("runs", id);
  if (asRun && !(await seesRun(ctx, doc as unknown as Doc<"runs">, actor))) {
    throw roomError("not_found", "Not found in this team.");
  }
  // A terminal or Space on such a run is as private as the run: its output, input and controls.
  const runId = "runId" in doc ? (doc as { runId?: Id<"runs"> }).runId : undefined;
  // A channel-limited key (ADR 0049) reaches a terminal or Space only through a run it sees.
  const throughRun = ctx.db.normalizeId("terminals", id) !== null || ctx.db.normalizeId("spaces", id) !== null;
  if ((runId || (throughRun && actor.channelIds)) && (await hiddenByRun(ctx, actor, runId))) {
    throw roomError("not_found", "Not found in this team.");
  }
  return doc;
}

/** Whether a run came from a direct message or private channel the actor can't see (ADR 0016). */
export async function hiddenByRun(ctx: QueryCtx, actor: Actor, runId: Id<"runs"> | undefined): Promise<boolean> {
  // A channel-limited key (ADR 0049) sees a terminal or Space only through a run it can see.
  if (!runId) return actor.channelIds !== undefined;
  const run = await ctx.db.get(runId);
  if (!run) return actor.channelIds !== undefined;
  if (!(await seesRun(ctx, run, actor))) return true;
  return !!run.directChannelId && !(await canSeeId(ctx, actor, run.directChannelId));
}

/** Actors whose call already wrote an audit row, so the Room API factory doesn't log it twice. */
const audited = new WeakSet<Actor>();

export function wasAudited(actor: Actor): boolean {
  return audited.has(actor);
}

/** What a document can point at on the way to its channel. */
type ChannelPointers = {
  channelId?: Id<"channels">;
  directChannelId?: Id<"channels">;
  runId?: Id<"runs">;
  terminalId?: Id<"terminals">;
  spaceId?: Id<"spaces">;
};

/**
 * The channel an id lives in, or the direct message or private channel a run or task came from.
 * Things on a run (a terminal, a Space) and things in those (a suggestion, a wheel request) follow
 * it to the run's channel, so their audit entries stay with that channel too (ADR 0016).
 */
export async function channelOfId(ctx: QueryCtx, id: string): Promise<Id<"channels"> | undefined> {
  const channelId = ctx.db.normalizeId("channels", id);
  if (channelId) return channelId;
  const tables = [
    "messages", "calls", "browsers", "savedLogins", "taskProposals", "runs", "tasks", "terminals", "spaces",
    "suggestions", "wheelRequests", "spaceSuggestions", "spaceWheelRequests", "spaceActions", "spaceViews",
    "threadWheelRequests", "threadSuggestions", "threadMessages",
  ] as const;
  for (const table of tables) {
    const docId = ctx.db.normalizeId(table, id);
    if (docId) return channelOfDoc(ctx, (await ctx.db.get(docId)) as ChannelPointers | null, 3);
  }
  return undefined;
}

async function channelOfDoc(ctx: QueryCtx, doc: ChannelPointers | null, depth: number): Promise<Id<"channels"> | undefined> {
  if (!doc) return undefined;
  if (doc.channelId) return doc.channelId;
  if (doc.directChannelId) return doc.directChannelId;
  if (depth === 0) return undefined;
  const next = doc.runId ?? doc.terminalId ?? doc.spaceId;
  return next ? channelOfDoc(ctx, (await ctx.db.get(next)) as ChannelPointers | null, depth - 1) : undefined;
}

/** The ids an audit entry names: its target, and the string values among its details. */
export function auditIds(target: string, details: unknown): string[] {
  const ids = [target];
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const value of Object.values(details as Record<string, unknown>)) if (typeof value === "string") ids.push(value);
  }
  return ids;
}

/** The first channel any of these ids lives in. */
export async function channelOfIds(ctx: QueryCtx, ids: string[]): Promise<Id<"channels"> | undefined> {
  for (const id of ids) {
    const channelId = await channelOfId(ctx, id);
    if (channelId) return channelId;
  }
  return undefined;
}

/**
 * Logs an action. The entry keeps the channel it is about, found now (or passed by a caller that
 * found it before the action changed things, such as deleting the message), so activity.list can
 * keep it to those who can see that channel after the message is gone (ADR 0016).
 */
export async function audit(
  ctx: MutationCtx,
  actor: Actor,
  action: string,
  target: string,
  details?: unknown,
  opts: { channelId?: Id<"channels"> } = {},
): Promise<void> {
  audited.add(actor);
  const channelId = opts.channelId ?? (await channelOfIds(ctx, auditIds(target, details)));
  await ctx.db.insert("audit", {
    teamId: actor.teamId,
    actorId: actor.member._id,
    ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
    ...(actor.accountable ? { accountableId: actor.accountable._id } : {}),
    action,
    target,
    ...(details === undefined ? {} : { details }),
    at: Date.now(),
    ...(channelId ? { channelId } : {}),
  });
}

/**
 * Who takes the wheel of a terminal or Space on a private channel's run when its driver leaves
 * the channel (ADR 0016): whoever started it, if still in the channel, else whoever removed them,
 * if in it. Below Drive only the starter can drive (the bridge holds to that), so then only them.
 */
export async function nextDriverInChannel(
  ctx: QueryCtx,
  actor: Actor,
  channelId: Id<"channels">,
  leaving: Id<"members">,
  holder: { startedBy: Id<"members">; access: string },
): Promise<Id<"members"> | null> {
  const channel = await ctx.db.get(channelId);
  if (!channel) return null;
  const candidates = holder.access === "drive" || holder.access === "open" ? [holder.startedBy, actor.member._id] : [holder.startedBy];
  for (const id of candidates) {
    if (id === leaving) continue;
    const member = await ctx.db.get(id);
    if (member && member.removedAt === undefined && (await memberCanSee(ctx, channel, id))) return id;
  }
  return null;
}

/** Every run from one direct message or private channel, and the tasks on them. */
export async function runsInChannel(ctx: QueryCtx, channelId: Id<"channels">) {
  return await ctx.db
    .query("runs")
    .withIndex("by_direct_channel", (q) => q.eq("directChannelId", channelId))
    .collect();
}
