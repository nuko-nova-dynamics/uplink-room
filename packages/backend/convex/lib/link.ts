/**
 * A person's Link (ADR 0049): the roster agent their Inbox talks to. The Inbox shows the direct
 * message between the person and that agent as a conversation; the agent reads each message there
 * through its usual reach (A2A, a routine webhook, or checking in) and either answers or starts the
 * work itself with tasks.create and runs.start. The room has no model of its own deciding this.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { toolName } from "@uplink-room/protocol/mcp";
import { peerForAgent } from "./a2a/runs";
import { reachOf, type Reach } from "./deliveries";

/**
 * How the room reaches a person's Link with that person's messages, or null when it can't: an A2A
 * agent whose card has no endpoint yet, or that takes work only from the person who added it, gets
 * nothing from anyone else (checkSender), so for them it is unreachable.
 */
export async function linkReach(ctx: QueryCtx, person: Doc<"members">, agent: Doc<"agents">): Promise<Reach | null> {
  const reach = await reachOf(ctx, agent._id);
  if (reach !== "a2a") return reach ?? null;
  const peer = await peerForAgent(ctx, agent._id);
  if (!peer?.endpoint) return null;
  if (peer.sendWork === "accountable" && agent.addedBy !== person._id) return null;
  return "a2a";
}

/** A person's Link while it stands: the agent is still in the team and the direct message is open. */
export async function linkOf(
  ctx: QueryCtx,
  person: Doc<"members">,
): Promise<{ agent: Doc<"members">; channel: Doc<"channels"> } | null> {
  if (!person.link) return null;
  const agent = await ctx.db.get(person.link.memberId);
  const channel = await ctx.db.get(person.link.channelId);
  if (!agent || agent.kind !== "agent" || agent.removedAt !== undefined) return null;
  if (!channel || channel.archivedAt !== undefined) return null;
  return { agent, channel };
}

/**
 * What the agent is told with a message that reaches it in a person's Link conversation, written
 * by that person: that it is their Link, and to start work itself rather than ask. Null anywhere
 * else, and for a sender whose Link it isn't.
 */
export async function linkInstruction(
  ctx: QueryCtx,
  channel: Doc<"channels">,
  senderId: Id<"members">,
  agentMemberId: Id<"members">,
): Promise<string | null> {
  const sender = await ctx.db.get(senderId);
  const link = sender?.link;
  if (!sender || !link || link.channelId !== channel._id || link.memberId !== agentMemberId) return null;
  return [
    `You are ${sender.name}'s Link: this direct message is their Inbox in Uplink Room, where they write to you as in a chat.`,
    "When a message is conversation or a question, answer it here.",
    `When it asks for work, start it yourself instead of asking first: make a task with ${toolName("tasks.create")}, titled from their words, with ownerId ${sender._id} so it is theirs, then start a run on it with ${toolName("runs.start")} and their message as the prompt: a T3 Code thread (via thread) on one of their machines from ${toolName("machines.list")}, or via agent to give it to an agent from ${toolName("teams.roster")}.`,
    `Then post one short line here with ${toolName("messages.post")}, passing the run in mentionedRuns, so their Inbox shows a card that follows the run.`,
    "When you can't tell whether it is work, answer as conversation: they can make it a task from your reply.",
  ].join(" ");
}

/**
 * Whether a conversation's top level is its asker's Link conversation: the message that started it
 * was written by the person whose Link conversation the place is. There the Inbox shows answers in
 * place and has no Yes or No for a thread proposal, so the agent is offered none and none is taken.
 */
export async function inLinkConversation(
  ctx: QueryCtx,
  channelId: Id<"channels">,
  triggerMessageId: Id<"messages"> | undefined,
): Promise<boolean> {
  const trigger = triggerMessageId ? await ctx.db.get(triggerMessageId) : null;
  const author = trigger ? await ctx.db.get(trigger.authorId) : null;
  return author?.link?.channelId === channelId;
}
