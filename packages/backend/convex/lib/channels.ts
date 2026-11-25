/**
 * Who may see a channel (ADR 0015, ADR 0016). This is the one place channel access is decided. A
 * channel is one of three kinds:
 *
 * - a team channel, open to the whole team;
 * - a direct message, open only to its fixed members;
 * - a private channel, open only to its members, who can change.
 *
 * Direct messages and private channels keep their members in `channelMembers`. Everything that
 * reads or writes by channel (messages, calls, attachments, shared browsers, saved logins, runs and
 * tasks from a direct message or private channel) goes through `channelAccess`, directly or through
 * `inTeam`. Team admins are no exception: nobody sees a conversation they aren't in.
 *
 * Someone who can't see a channel gets `not_found`, the same answer as for a channel that doesn't
 * exist, so a direct message's or private channel's existence isn't given away either.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { roomError } from "./errors";

export const MIN_DIRECT_MEMBERS = 2;
export const MAX_DIRECT_MEMBERS = 10;

export type ChannelKind = "channel" | "direct" | "private";

/** The channel's kind; absent means a team channel. */
export function kindOf(channel: Pick<Doc<"channels">, "kind">): ChannelKind {
  return channel.kind ?? "channel";
}

export function isDirect(channel: Pick<Doc<"channels">, "kind">): boolean {
  return channel.kind === "direct";
}

export function isPrivate(channel: Pick<Doc<"channels">, "kind">): boolean {
  return channel.kind === "private";
}

/** A direct message or a private channel: only the members in `channelMembers` can see it. */
export function hasMemberList(channel: Pick<Doc<"channels">, "kind">): boolean {
  return isDirect(channel) || isPrivate(channel);
}

/** Whether `memberId` (a member of the channel's team) may see the channel. */
export async function memberCanSee(
  ctx: QueryCtx,
  channel: Doc<"channels">,
  memberId: Id<"members">,
): Promise<boolean> {
  if (!hasMemberList(channel)) return true;
  const row = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", channel._id).eq("memberId", memberId))
    .unique();
  return row !== null;
}

/** Whether the actor may see this channel. */
export async function canSee(ctx: QueryCtx, actor: Actor, channel: Doc<"channels">): Promise<boolean> {
  if (channel.teamId !== actor.teamId) return false;
  // An agent key limited to some channels sees no other (ADR 0049), whatever its member could.
  if (actor.channelIds && !actor.channelIds.has(channel._id)) return false;
  return memberCanSee(ctx, channel, actor.member._id);
}

const NOT_FOUND = "Not found in this team.";

/** The channel, if the actor may see it; otherwise `not_found`. */
export async function channelAccess(
  ctx: QueryCtx,
  actor: Actor,
  channelId: Id<"channels">,
): Promise<Doc<"channels">> {
  const channel = await ctx.db.get(channelId);
  if (!channel || !(await canSee(ctx, actor, channel))) throw roomError("not_found", NOT_FOUND);
  return channel;
}

/** A message, and its channel, if the actor may see the channel; otherwise `not_found`. */
export async function messageAccess(
  ctx: QueryCtx,
  actor: Actor,
  messageId: Id<"messages">,
): Promise<{ message: Doc<"messages">; channel: Doc<"channels"> }> {
  const message = await ctx.db.get(messageId);
  if (!message || message.teamId !== actor.teamId) throw roomError("not_found", NOT_FOUND);
  return { message, channel: await channelAccess(ctx, actor, message.channelId) };
}

/** A call, and its channel, if the actor may see the channel; otherwise `not_found`. */
export async function callAccess(
  ctx: QueryCtx,
  actor: Actor,
  callId: Id<"calls">,
): Promise<{ call: Doc<"calls">; channel: Doc<"channels"> }> {
  const call = await ctx.db.get(callId);
  if (!call || call.teamId !== actor.teamId) throw roomError("not_found", NOT_FOUND);
  return { call, channel: await channelAccess(ctx, actor, call.channelId) };
}

/** Whether the actor may see the channel with this id (false when it is gone). */
export async function canSeeId(ctx: QueryCtx, actor: Actor, channelId: Id<"channels">): Promise<boolean> {
  const channel = await ctx.db.get(channelId);
  return channel !== null && (await canSee(ctx, actor, channel));
}

/** The members of a direct message or private channel, in the order they were added. Empty for a team channel. */
export async function memberIdsOf(ctx: QueryCtx, channel: Doc<"channels">): Promise<Id<"members">[]> {
  if (!hasMemberList(channel)) return [];
  const rows = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", channel._id))
    .collect();
  return rows.sort((a, b) => a.addedAt - b.addedAt).map((r) => r.memberId);
}

/** A direct message's members, in the order they were added. Empty for any other channel. */
export async function directMemberIds(ctx: QueryCtx, channel: Doc<"channels">): Promise<Id<"members">[]> {
  return isDirect(channel) ? memberIdsOf(ctx, channel) : [];
}

/** The runs in a direct message (ADR 0029 D4), in the order they were added. */
export async function directRunIds(ctx: QueryCtx, channel: Doc<"channels">): Promise<Id<"runs">[]> {
  if (!isDirect(channel)) return [];
  const rows = await ctx.db
    .query("channelRuns")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .take(10);
  return rows.sort((a, b) => a.addedAt - b.addedAt).map((r) => r.runId);
}

/** The key that finds a direct message again for the same members. */
export function memberKeyOf(memberIds: readonly string[]): string {
  return [...new Set(memberIds)].sort().join(",");
}

/**
 * How a channel is named in the A2A message the room sends an agent (its footer): `#name`, also
 * for a private channel, whose agent is one of its members and whose run hides that text from
 * everyone else. A direct message has no name, and its members' names stay out of shared text.
 */
export function channelLabel(channel: Doc<"channels">): string {
  return isDirect(channel) ? "a direct message" : `#${channel.name}`;
}

/** What to call a direct message or private channel when telling someone they aren't in it. */
export function whereLabel(channel: Doc<"channels">): string {
  return isDirect(channel) ? "this direct message" : `#${channel.name}`;
}

/**
 * The title a run or task from a direct message or private channel shows everyone: it never quotes
 * what was said, and a private channel's name stays out of it.
 */
export function privateTitle(channel: Pick<Doc<"channels">, "kind"> | null, what: "message" | "task" | "run", from?: string): string {
  const where = channel && isDirect(channel) ? "a direct message" : "a private channel";
  if (what === "message") {
    return channel && isDirect(channel) ? `Direct message from ${from ?? "a member"}` : `Message from ${from ?? "a member"} in a private channel`;
  }
  return what === "task" ? `A task from ${where}` : `A run from ${where}`;
}

/**
 * Whether an agent key limited to some channels (ADR 0049) can't see this task: one in a project
 * whose channel isn't one of them, or one in no project that this agent didn't create. Always
 * false for everyone else.
 */
export async function taskOutsideChannels(
  ctx: QueryCtx,
  actor: Pick<Actor, "member" | "channelIds">,
  task: Pick<Doc<"tasks">, "projectId" | "createdBy">,
): Promise<boolean> {
  if (!actor.channelIds) return false;
  if (!task.projectId) return task.createdBy !== actor.member._id;
  const project = await ctx.db.get(task.projectId);
  return !project || !actor.channelIds.has(project.channelId);
}

/**
 * Whether an agent key limited to some channels (ADR 0049) can't see this run: one on a task it
 * can't see, or an unfiled run it neither started nor drives. Always false for everyone else.
 */
export async function runOutsideChannels(
  ctx: QueryCtx,
  actor: Pick<Actor, "member" | "channelIds">,
  run: Pick<Doc<"runs">, "taskId" | "startedBy" | "driverId">,
): Promise<boolean> {
  if (!actor.channelIds) return false;
  if (!run.taskId) return run.startedBy !== actor.member._id && run.driverId !== actor.member._id;
  const task = await ctx.db.get(run.taskId);
  return !task || (await taskOutsideChannels(ctx, actor, task));
}
