/**
 * Hosted assistants the room can reach, and the ones it can't (ADR 0028, slice 14 of #139).
 *
 * - **Grok Bot** takes messages at a routine webhook: a person sets its URL and key on the agent
 *   (webhooks.set), and each message that reaches the agent is POSTed there with
 *   `Authorization: Bearer <key>` (docs.x.ai/grok-bot/skills-routines-and-automations, "Webhooks").
 *   A 200 means "Grok Bot accepted the call and started a run, not that the Bot has finished", so
 *   the room keeps a delivery record (sent, or failed with the reason), not a run (D17 of ADR 0029).
 *   Grok Bot answers by posting through the room's connector; the request says how.
 * - **dots, Muse and Duet**, and any connector agent with no way in, only read and post through
 *   the connector when they run. They check in on their own schedule: a message to one waits until
 *   it reads the place through the Room API, then shows as seen.
 *
 * Which messages reach an agent is the router's (lib/router.ts): a mention, every message in a
 * direct message it is in, and replies in its own thread (ADR 0024, ADR 0026).
 */
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accountableId, type Actor } from "./actor";
import { memberCanSee } from "./channels";
import { roomError } from "./errors";
import { maySendWork, peerForAgent } from "./a2a/runs";
import { allowInsecurePeers, isDeploymentHost, isPrivateHost } from "./a2a/peerUrl";
import { WEBHOOK_DEADLINE_MS } from "./webhookTiming";

/** How the room reaches an agent, when it can: over A2A, at a routine webhook, or not at all (it checks in). */
export type Reach = "a2a" | "webhook" | "checks_in";

/** At most this many delivery rows (or, for a read, messages) are marked seen at a time. */
const SEEN_BATCH = 100;

export async function webhookFor(ctx: QueryCtx, agentId: Id<"agents">): Promise<Doc<"webhooks"> | null> {
  return ctx.db
    .query("webhooks")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .unique();
}

/** Whether the agent joined through the remote connector and its connection still works. */
async function viaConnector(ctx: QueryCtx, agentId: Id<"agents">): Promise<boolean> {
  const connector = await ctx.db
    .query("connectors")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .first();
  if (!connector?.agentKeyId) return false;
  const key = await ctx.db.get(connector.agentKeyId);
  return !!key && key.revokedAt === undefined;
}

/**
 * How the room reaches an agent: `a2a` with an A2A endpoint, `webhook` with a routine webhook,
 * `checks_in` for a connector agent with neither (it reads and posts only when it runs), and
 * nothing for any other agent, which the room knows nothing about.
 */
export async function reachOf(ctx: QueryCtx, agentId: Id<"agents">): Promise<Reach | undefined> {
  if (await peerForAgent(ctx, agentId)) return "a2a";
  if (await webhookFor(ctx, agentId)) return "webhook";
  if (await viaConnector(ctx, agentId)) return "checks_in";
  return undefined;
}

/**
 * The URL a webhook is POSTed to, as given: public https only (or, with A2A_ALLOW_INSECURE_PEERS on a
 * deployment, http and private addresses for development), no user name or password, never the
 * deployment itself. What the name resolves to is checked when each request connects (guardedFetch).
 */
export function webhookUrlFor(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw roomError("invalid", "That isn't a URL. Copy the routine's POST to address.");
  }
  if (url.username || url.password) throw roomError("invalid", "Give the URL without a user name or password: the key goes in its own field.");
  if (isDeploymentHost(url.hostname)) throw roomError("invalid", "That is this deployment's own address.");
  const insecure = allowInsecurePeers();
  if (url.protocol !== "https:" && !(insecure && url.protocol === "http:")) {
    throw roomError("invalid", "The webhook's URL must use https.");
  }
  if (!insecure && isPrivateHost(url.hostname)) {
    throw roomError("invalid", "That is a private or local address, which the room can't reach. Give the routine's public https URL.");
  }
  url.hash = "";
  return url.toString();
}

/** What a webhook's key is sealed to: its agent and URL, so it opens for no other. */
export function webhookBinding(webhook: Pick<Doc<"webhooks">, "agentId" | "url">): string {
  return `webhook|${webhook.agentId}|${webhook.url}`;
}

/**
 * Records a message reaching hosted agents (`agents`, the router's list), each once: a send to a
 * routine webhook, scheduled now, or a wait for an agent that checks in. An agent never gets its own
 * message, nor one in a place it can't see; a run it drives can message it (ADR 0029 D2). Sending to a webhook starts a run of the agent's own, so
 * it is work, as for A2A (ADR 0012): an agent sender needs runs.start. Returns how many it recorded.
 */
export async function deliverToHosted(
  ctx: MutationCtx,
  sender: Actor,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  parent: Doc<"messages"> | undefined,
  agents: Doc<"members">[],
): Promise<number> {
  let count = 0;
  const done = new Set<string>();
  for (const member of agents) {
    if (!member.agentId || done.has(member._id)) continue;
    done.add(member._id);
    if (!message.asRun && (member._id === message.authorId || member.agentId === sender.member.agentId)) continue;
    if (!(await memberCanSee(ctx, channel, member._id))) continue;
    const reach = await reachOf(ctx, member.agentId);
    if (reach !== "webhook" && reach !== "checks_in") continue;
    const webhook = reach === "webhook" ? await webhookFor(ctx, member.agentId) : null;
    if (reach === "webhook" && !maySendWork(sender)) continue;
    const deliveryId = await ctx.db.insert("agentDeliveries", {
      teamId: channel.teamId,
      messageId: message._id,
      channelId: channel._id,
      ...(parent ? { threadRootId: parent._id } : {}),
      memberId: member._id,
      agentId: member.agentId,
      via: reach === "webhook" ? "webhook" : "check_in",
      status: reach === "webhook" ? "sending" : "waiting",
      senderId: sender.member._id,
      accountableId: accountableId(sender),
      ...(webhook ? { webhookId: webhook._id } : {}),
      at: Date.now(),
    });
    if (reach === "webhook") {
      await ctx.scheduler.runAfter(0, internal.webhooksNode.send, { deliveryId });
      // A scheduled action that fails isn't retried; a scheduled mutation runs exactly once.
      await ctx.scheduler.runAfter(WEBHOOK_DEADLINE_MS, internal.webhooks.checkSending, { deliveryId });
    }
    count++;
  }
  if (count) await ctx.db.patch(message._id, { deliveryCount: (message.deliveryCount ?? 0) + count });
  return count;
}

/**
 * Records a run given to an agent reaching it (ADR 0044), at its start or with a reply: a send of
 * the task to its routine webhook, scheduled now, or, for an agent that checks in or holds only a
 * key, a wait until it reads the run (runs.get) or reports on it (runs.report). A wait already
 * open for the run is kept rather than doubled. The sender's checks are runs.start's, done before.
 */
export async function deliverRunToHosted(
  ctx: MutationCtx,
  sender: Actor,
  run: Doc<"runs">,
  member: Doc<"members">,
): Promise<void> {
  if (!member.agentId) return;
  const webhook = (await reachOf(ctx, member.agentId)) === "webhook" ? await webhookFor(ctx, member.agentId) : null;
  if (!webhook) {
    const open = (await runDeliveries(ctx, run._id)).some((d) => d.status === "waiting");
    if (open) return;
  }
  const deliveryId = await ctx.db.insert("agentDeliveries", {
    teamId: run.teamId,
    runId: run._id,
    memberId: member._id,
    agentId: member.agentId,
    via: webhook ? "webhook" : "check_in",
    status: webhook ? "sending" : "waiting",
    senderId: sender.member._id,
    accountableId: accountableId(sender),
    ...(webhook ? { webhookId: webhook._id } : {}),
    at: Date.now(),
  });
  if (webhook) {
    await ctx.scheduler.runAfter(0, internal.webhooksNode.send, { deliveryId });
    await ctx.scheduler.runAfter(WEBHOOK_DEADLINE_MS, internal.webhooks.checkSending, { deliveryId });
  }
}

/** A given run's newest delivery rows, newest first. Bounded: a wait is never doubled, so the newest hold it. */
export async function runDeliveries(ctx: QueryCtx, runId: Id<"runs">): Promise<Doc<"agentDeliveries">[]> {
  return ctx.db
    .query("agentDeliveries")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .order("desc")
    .take(SEEN_BATCH);
}

/** Marks as seen what waited for this agent to read a run given to it (ADR 0044). */
export async function markRunSeen(ctx: MutationCtx, memberId: Id<"members">, runId: Id<"runs">): Promise<number> {
  const rows = (await runDeliveries(ctx, runId)).filter((d) => d.memberId === memberId && d.status === "waiting");
  return mark(ctx, rows);
}

/** Where an agent posted, to mark what waited for it there as seen: a channel's top level, or a thread. */
export type PostPlace =
  | { kind: "top"; channelId: Id<"channels"> }
  | { kind: "thread"; channelId: Id<"channels">; threadRootId: Id<"messages"> };

/** The agent's waiting rows on these messages. */
async function waitingOn(ctx: QueryCtx, memberId: Id<"members">, messageId: Id<"messages">) {
  const rows = await ctx.db
    .query("agentDeliveries")
    .withIndex("by_member_message", (q) => q.eq("memberId", memberId).eq("messageId", messageId))
    .take(SEEN_BATCH);
  return rows.filter((d) => d.status === "waiting");
}

async function mark(ctx: MutationCtx, rows: Doc<"agentDeliveries">[]): Promise<number> {
  const now = Date.now();
  for (const row of rows) await ctx.db.patch(row._id, { status: "seen", settledAt: now });
  return rows.length;
}

/**
 * Marks as seen what waited for an agent that checks in on these messages: the ones a read through
 * the connector returned to it (connectors.noteRead), so a page, or what is addressed to it, marks
 * only what it was given. Bounded to SEEN_BATCH messages.
 */
export async function markSeenMessages(ctx: MutationCtx, memberId: Id<"members">, messageIds: Id<"messages">[]): Promise<number> {
  const rows: Doc<"agentDeliveries">[] = [];
  for (const messageId of new Set(messageIds.slice(0, SEEN_BATCH))) rows.push(...(await waitingOn(ctx, memberId, messageId)));
  return mark(ctx, rows);
}

/**
 * Marks as seen what waited for an agent that checks in where it posted: a channel's top level, or a
 * thread and its first message. The place is in the index range, so waiting rows elsewhere never
 * fill the batch. Bounded.
 */
export async function markSeen(ctx: MutationCtx, memberId: Id<"members">, place: PostPlace): Promise<number> {
  const threadRootId = place.kind === "thread" ? place.threadRootId : undefined;
  const rows = await ctx.db
    .query("agentDeliveries")
    .withIndex("by_member_status_place", (q) =>
      q.eq("memberId", memberId).eq("status", "waiting").eq("channelId", place.channelId).eq("threadRootId", threadRootId),
    )
    .take(SEEN_BATCH);
  if (place.kind === "thread") rows.push(...(await waitingOn(ctx, memberId, place.threadRootId)));
  return mark(ctx, rows);
}

/** Whether anything waits for this agent to check in. */
export async function hasWaiting(ctx: QueryCtx, memberId: Id<"members">): Promise<boolean> {
  const row = await ctx.db
    .query("agentDeliveries")
    .withIndex("by_member_status_place", (q) => q.eq("memberId", memberId).eq("status", "waiting"))
    .first();
  return row !== null;
}
