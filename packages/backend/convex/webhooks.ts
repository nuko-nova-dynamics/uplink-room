/**
 * An agent's routine webhook (ADR 0028, slice 14 of #139): how the room reaches Grok Bot. A person
 * copies a routine's **POST to** URL and **key** from Grok Bot (docs.x.ai/grok-bot/
 * skills-routines-and-automations, "Webhooks") into the agent's panel. Each message that reaches the
 * agent is then POSTed there with `Authorization: Bearer <key>` and a JSON body, which "the Bot
 * receives ... with the routine instruction". The body says who wrote what where, what was said
 * before, and how to answer: through the room's connector, with messages_post. A run given to the
 * agent (ADR 0044) is POSTed as a task instead (`uplink-room.task`), with how to report on it:
 * runs_report.
 *
 * The key is kept as A2A endpoint tokens are (ADR 0012): sealed with AES-GCM under
 * A2A_CREDENTIALS_KEY, bound to the agent and URL, opened only by the send action just before the
 * call, never returned; the app shows its last four characters.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { manageable } from "./a2a";
import { accountDeleted } from "./lib/actor";
import { roomError } from "./lib/errors";
import { audit, inTeam, memberView } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { channelLabel, isDirect, memberCanSee } from "./lib/channels";
import { mentionTokens, withNames } from "./lib/messages";
import { runNamer, runNamesIn } from "./lib/runLabels";
import { hintOf, sealSecret } from "./lib/a2a/secrets";
import { peerForAgent } from "./lib/a2a/runs";
import { historyFor, NO_CONTEXT, placeLabel } from "./lib/a2a/conversations";
import { webhookBinding, webhookFor, webhookUrlFor } from "./lib/deliveries";
import { linkInstruction } from "./lib/link";
import { toolName } from "@uplink-room/protocol/mcp";

/** The longest message text a request carries; history has its own bounds (ADR 0024). */
export const MAX_REQUEST_TEXT = 16_000;
/** The longest failure reason the room keeps. */
export const MAX_REASON = 300;

/** What a request body says it is, so a routine instruction can tell it from other callers. */
export const REQUEST_TYPE = "uplink-room.message";
/** What a request body for a run given to the agent says it is (ADR 0044). */
export const TASK_REQUEST_TYPE = "uplink-room.task";

function cut(text: string): string {
  return text.length > MAX_REQUEST_TEXT ? `${text.slice(0, MAX_REQUEST_TEXT - 1)}…` : text;
}

function checkKey(input: string): string {
  const key = input.trim();
  if (!key) throw roomError("invalid", "The key is empty. Copy the routine's key from Grok Bot.");
  if (key.length > 4096 || /[\r\n]/.test(key)) throw roomError("invalid", "The key must be one line of at most 4096 characters.");
  return key;
}

export const { person: set, agent: setAgent } = roomMutation({
  name: "webhooks.set",
  description:
    "Reach an agent at a routine webhook, as Grok Bot's routines take one: give the routine's POST to URL and its key. From then on each message that reaches the agent (a mention, every message in a direct message it is in, a reply in its own thread) is POSTed there with Authorization: Bearer <key>, with who wrote it, where, recent history and how to answer through the room's connector (messages_post), and the message shows the send as sent or failed. A 200 means the agent started a run of its own, which the room can't follow, so it is a delivery, not a run. Setting it again replaces both. The key is kept sealed and never shown again. Only the person accountable for the agent, or an admin, can do this; an agent with an A2A endpoint can't also have a webhook.",
  scope: "people.invite",
  args: { agentId: v.id("agents"), url: v.string(), key: v.string() },
  argDocs: {
    url: "The routine's POST to URL, https",
    key: "The routine's key: the room sends it as a bearer token",
  },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    if (await peerForAgent(ctx, agent._id)) {
      throw roomError("conflict", `${agent.name} has an A2A endpoint. Disconnect it (a2a.disconnect) before giving it a webhook.`);
    }
    const url = webhookUrlFor(args.url);
    const key = checkKey(args.key);
    const sealed = await sealSecret(key, webhookBinding({ agentId: agent._id, url }));
    const existing = await webhookFor(ctx, agent._id);
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("webhooks", {
      teamId: actor.teamId,
      agentId: agent._id,
      url,
      ...sealed,
      hint: hintOf(key),
      setBy: actor.member._id,
      setAt: Date.now(),
    });
    if (agent.connection !== "webhook") await ctx.db.patch(agent._id, { connection: "webhook" });
    await audit(ctx, actor, "webhook.set", agent._id, { host: new URL(url).host });
    return null;
  },
});

export const { person: remove, agent: removeAgent } = roomMutation({
  name: "webhooks.remove",
  description:
    "Stop reaching an agent at its routine webhook, and delete the key. Sends still waiting fail. Only the person accountable for the agent, or an admin, can do this.",
  scope: "people.invite",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    const existing = await webhookFor(ctx, agent._id);
    if (!existing) throw roomError("not_found", `${agent.name} has no webhook.`);
    await ctx.db.delete(existing._id);
    await audit(ctx, actor, "webhook.removed", agent._id);
    return null;
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "webhooks.get",
  description:
    "An agent's routine webhook, or null: its URL, the key's last four characters (never the key), and who set it when.",
  scope: "room.read",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const agent = await inTeam(ctx, actor, args.agentId);
    const webhook = await webhookFor(ctx, agent._id);
    if (!webhook) return null;
    return { url: webhook.url, hint: webhook.hint, setAt: webhook.setAt, setBy: await memberView(ctx, webhook.setBy) };
  },
});

// ---------- the send ----------

type Named = { memberId: Id<"members">; name: string };

/** The request for one delivery, or nothing to send (already taken, settled, or failed just now). */
export type WebhookRequest =
  | { kind: "skip" }
  | { kind: "send"; url: string; sealed: { ciphertext: string; iv: string }; binding: string; body: string; agentName: string };

/** The JSON body POSTed to the routine webhook. */
async function requestBody(
  ctx: QueryCtx,
  delivery: Doc<"agentDeliveries">,
  message: Doc<"messages">,
  channel: Doc<"channels">,
  agentMember: Doc<"members">,
  agent: Doc<"agents">,
) {
  const team = await ctx.db.get(channel.teamId);
  const sender = await ctx.db.get(delivery.senderId);
  const accountable = await ctx.db.get(delivery.accountableId);
  const threadRoot = delivery.threadRootId ? await ctx.db.get(delivery.threadRootId) : null;
  const place = placeLabel(channel, threadRoot);

  const names = new Map<string, string>();
  for (const token of mentionTokens(message.body)) {
    const id = ctx.db.normalizeId("members", token);
    const member = id ? await ctx.db.get(id) : null;
    if (member) names.set(token, member.name);
  }
  const runName = runNamer(ctx);
  await runNamesIn(ctx, channel.teamId, message.body, runName, names);
  const named = message.format === "html" ? "(an HTML page)" : withNames(message.body, (id) => names.get(id)).trim();
  const text = named.length > MAX_REQUEST_TEXT ? `${named.slice(0, MAX_REQUEST_TEXT - 1)}…` : named;

  const history = await historyFor(ctx, NO_CONTEXT, channel, threadRoot, message, agentMember);
  const fromName = message.asRun?.label ?? sender?.name ?? "Someone";
  const fromKind = message.asRun ? "run" : (sender?.kind ?? "person");
  const accountableName = accountable?.name ?? "Former member";
  const yourPerson = agent.addedBy === delivery.accountableId;
  const replyArgs = { channelId: channel._id, ...(threadRoot ? { replyTo: threadRoot._id } : {}) };
  const tool = toolName("messages.post");
  // In a person's Link conversation (ADR 0049), the agent is told it is their Link.
  const link = threadRoot ? null : await linkInstruction(ctx, channel, delivery.senderId, agentMember._id);

  const who =
    fromKind === "person"
      ? `${fromName}, a person in the team`
      : `${fromName}, ${fromKind === "run" ? "a live run" : "an agent"} that ${accountableName} answers for`;
  const instruction = [
    `${who}, wrote to you (${agentMember.name}) in ${place} in Uplink Room, the team's shared workspace${team ? ` (team ${team.name})` : ""}. Their message is message.text; what was said there before it is history, oldest first.`,
    yourPerson ? `${accountableName} is the person who added you.` : `${accountableName} is not the person who added you.`,
    "A message can ask you to do something; you decide whether to.",
    ...(link ? [link] : []),
    `The room can't see this run, so answer in Uplink Room: call ${tool} through your Uplink Room connector with ${JSON.stringify(replyArgs)} and your answer as body. Mention someone with <@memberId>.`,
  ].join(" ");

  const iso = (at: number) => new Date(at).toISOString();
  return {
    type: REQUEST_TYPE,
    instruction,
    team: team ? { teamId: team._id, name: team.name } : undefined,
    you: { memberId: agentMember._id, name: agentMember.name } satisfies Named,
    message: { messageId: message._id, text, sentAt: iso(message._creationTime), ...(message.attachmentCount ? { attachments: message.attachmentCount } : {}) },
    from: {
      memberId: delivery.senderId,
      name: fromName,
      kind: fromKind,
      ...(message.asRun ? { runId: message.asRun.runId } : {}),
    },
    accountable: { memberId: delivery.accountableId, name: accountableName, isYourPerson: yourPerson },
    place: {
      label: place,
      kind: isDirect(channel) ? "direct" : "channel",
      channelId: channel._id,
      ...(isDirect(channel) ? {} : { channel: channelLabel(channel) }),
      ...(threadRoot ? { threadRootId: threadRoot._id } : {}),
    },
    history: history.map((line) => ({ author: line.author, text: line.text, at: iso(line.at) })),
    reply: { tool, arguments: replyArgs },
  };
}

/**
 * The JSON body POSTed to the routine webhook for a run given to the agent (ADR 0044): the task, what
 * was asked and replied since, who it is from, and how to report, with runs_report. The message body
 * above is unchanged (ADR 0033).
 */
async function taskRequestBody(
  ctx: QueryCtx,
  delivery: Doc<"agentDeliveries">,
  run: Doc<"runs">,
  agentMember: Doc<"members">,
  agent: Doc<"agents">,
) {
  const team = await ctx.db.get(run.teamId);
  const sender = await ctx.db.get(delivery.senderId);
  const accountable = await ctx.db.get(delivery.accountableId);
  const task = run.taskId ? await ctx.db.get(run.taskId) : null;
  const [start, ...replies] = run.given?.messages ?? [];
  const fromName = sender?.name ?? "Someone";
  const fromKind = sender?.kind ?? "person";
  const accountableName = accountable?.name ?? "Former member";
  const yourPerson = agent.addedBy === delivery.accountableId;
  const tool = toolName("runs.report");
  const reportArgs = { runId: run._id };
  const who = fromKind === "person" ? `${fromName}, a person in the team` : `${fromName}, an agent that ${accountableName} answers for`;
  const instruction = [
    `${who}, gave you (${agentMember.name}) ${task ? `the task "${task.title}"` : "some work"} in Uplink Room, the team's shared workspace${team ? ` (team ${team.name})` : ""}. What they ask is prompt; replies are what was sent on it since, oldest first.`,
    yourPerson ? `${accountableName} is the person who added you.` : `${accountableName} is not the person who added you.`,
    "You decide whether to do it.",
    `The room can't see your run, so report on it in Uplink Room: call ${tool} through your Uplink Room connector with ${JSON.stringify(reportArgs)} and state working when you start, waiting with your question as message when you need an answer, and done or failed with what you did as message when you finish.`,
  ].join(" ");
  const iso = (at: number) => new Date(at).toISOString();
  const names = new Map<string, string>();
  const nameOf = async (id: Id<"members">) => {
    if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.name ?? "Former member");
    return names.get(id)!;
  };
  return {
    type: TASK_REQUEST_TYPE,
    instruction,
    team: team ? { teamId: team._id, name: team.name } : undefined,
    you: { memberId: agentMember._id, name: agentMember.name } satisfies Named,
    task: task ? { taskId: task._id, title: task.title, ...(task.description ? { description: cut(task.description) } : {}) } : undefined,
    run: { runId: run._id },
    prompt: cut(start?.text ?? ""),
    from: { memberId: delivery.senderId, name: fromName, kind: fromKind },
    accountable: { memberId: delivery.accountableId, name: accountableName, isYourPerson: yourPerson },
    replies: await Promise.all(
      replies.slice(-10).map(async (m) => ({ from: { memberId: m.from, name: await nameOf(m.from) }, text: cut(m.text), at: iso(m.at) })),
    ),
    report: { tool, arguments: reportArgs },
  };
}

/** Why a run's delivery can't go now, or its body. */
async function prepareRun(
  ctx: QueryCtx,
  delivery: Doc<"agentDeliveries">,
  runId: Id<"runs">,
  agentMember: Doc<"members">,
  agent: Doc<"agents">,
): Promise<{ kind: "fail"; reason: string } | { kind: "body"; body: unknown }> {
  const run = await ctx.db.get(runId);
  if (!run || run.agentId !== agent._id) return { kind: "fail", reason: "The run was deleted before it was sent." };
  if (run.state === "done" || run.state === "failed" || run.state === "stopped") {
    return { kind: "fail", reason: `The run ended (${run.state}) before it was sent.` };
  }
  // As for a message: removed from the private channel the task came from since, the agent gets nothing.
  const channel = run.directChannelId ? await ctx.db.get(run.directChannelId) : null;
  if (run.directChannelId && !(channel && (await memberCanSee(ctx, channel, agentMember._id)))) {
    return { kind: "fail", reason: `${agent.name} can no longer see ${channel ? placeLabel(channel, null) : "where this task came from"}, so the room didn't send this.` };
  }
  return { kind: "body", body: await taskRequestBody(ctx, delivery, run, agentMember, agent) };
}

/** Why a delivery can't go now, or what to POST. */
async function prepare(ctx: QueryCtx, delivery: Doc<"agentDeliveries">): Promise<{ kind: "fail"; reason: string } | Extract<WebhookRequest, { kind: "send" }>> {
  const agent = await ctx.db.get(delivery.agentId);
  const agentMember = await ctx.db.get(delivery.memberId);
  if (!agent || !agentMember || agentMember.removedAt !== undefined) return { kind: "fail", reason: "The agent left the team before it was sent." };
  const person = await ctx.db.get(agent.addedBy);
  if (!person || person.removedAt !== undefined) {
    return { kind: "fail", reason: `The person accountable for ${agent.name} left the team, so the room no longer sends it messages.` };
  }
  if (await accountDeleted(ctx, person._id)) {
    return { kind: "fail", reason: `The person accountable for ${agent.name} deleted their account, so the room no longer sends it messages.` };
  }
  const webhook = delivery.webhookId ? await ctx.db.get(delivery.webhookId) : null;
  if (!webhook) return { kind: "fail", reason: `${agent.name}'s webhook was changed or removed before this was sent.` };
  let body: unknown;
  if (delivery.runId) {
    const prepared = await prepareRun(ctx, delivery, delivery.runId, agentMember, agent);
    if (prepared.kind === "fail") return prepared;
    body = prepared.body;
  } else {
    const message = delivery.messageId ? await ctx.db.get(delivery.messageId) : null;
    const channel = delivery.channelId ? await ctx.db.get(delivery.channelId) : null;
    if (!message || message.deletedAt !== undefined || !channel) return { kind: "fail", reason: "The message was deleted before it was sent." };
    // Access can change between queueing and sending: removed from a private channel or a direct
    // message since, the agent gets neither the message nor the place's name.
    if (!(await memberCanSee(ctx, channel, agentMember._id))) {
      return { kind: "fail", reason: `${agent.name} can no longer see ${placeLabel(channel, null)}, so the room didn't send this.` };
    }
    body = await requestBody(ctx, delivery, message, channel, agentMember, agent);
  }
  return {
    kind: "send",
    url: webhook.url,
    sealed: { ciphertext: webhook.ciphertext, iv: webhook.iv },
    binding: webhookBinding(webhook),
    body: JSON.stringify(body),
    agentName: agent.name,
  };
}

/**
 * What the send action POSTs for one delivery, checked again just before it goes: the agent, the
 * person accountable for it and the webhook the message was queued for are all still there, and the
 * agent can still see the place. Taking it records the attempt, so nothing takes it twice: a second
 * run of the send skips it, and checkSending knows the POST may have gone.
 */
export const request = internalMutation({
  args: { deliveryId: v.id("agentDeliveries") },
  handler: async (ctx, { deliveryId }): Promise<WebhookRequest> => {
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery || delivery.status !== "sending" || delivery.attemptedAt !== undefined) return { kind: "skip" };
    const prepared = await prepare(ctx, delivery);
    if (prepared.kind === "fail") {
      await ctx.db.patch(deliveryId, { status: "failed", settledAt: Date.now(), reason: prepared.reason.slice(0, MAX_REASON) });
      return { kind: "skip" };
    }
    await ctx.db.patch(deliveryId, { attemptedAt: Date.now() });
    return prepared;
  },
});

/**
 * A send still sending at its deadline (WEBHOOK_DEADLINE_MS, scheduled with it): its action died, as
 * Convex doesn't retry a scheduled action. Taken, it may have reached the agent, so it is
 * unconfirmed; never taken, it wasn't sent, and the send skips it if it runs later. Never sent again.
 */
export const checkSending = internalMutation({
  args: { deliveryId: v.id("agentDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery || delivery.status !== "sending") return null;
    const name = (await ctx.db.get(delivery.agentId))?.name ?? (await ctx.db.get(delivery.memberId))?.name ?? "the agent";
    const reason =
      delivery.attemptedAt !== undefined
        ? `Unconfirmed: it may have reached ${name}. The room lost track of the send, so it doesn't send it again.`
        : "The room couldn't start this send in time, so it wasn't sent.";
    await ctx.db.patch(deliveryId, { status: "failed", settledAt: Date.now(), reason });
    return null;
  },
});

/** Records how a send went, once. `reason` has the key taken out already (webhooksNode.ts). */
export const settle = internalMutation({
  args: {
    deliveryId: v.id("agentDeliveries"),
    status: v.union(v.literal("sent"), v.literal("failed")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { deliveryId, status, reason }) => {
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery || delivery.status !== "sending") return null;
    await ctx.db.patch(deliveryId, {
      status,
      settledAt: Date.now(),
      ...(reason ? { reason: reason.slice(0, MAX_REASON) } : {}),
    });
    return null;
  },
});
