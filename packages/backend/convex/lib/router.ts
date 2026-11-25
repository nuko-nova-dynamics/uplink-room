/**
 * The one router for chat messages (ADR 0024, ADR 0026, ADR 0029): who a message names, and which
 * A2A agents and live runs it goes to. `messages.post` routes every post through it, and the A2A
 * worker routes an agent's answer through it after posting it, so an agent's answer reaches the
 * agents and runs it names. ADR 0026 replaced ADR 0024's rule that the room never sends one
 * agent's answer to another, and set no loop limit between agents.
 *
 * Which messages reach a recipient, the same for agents and runs:
 * - at a channel's top level, the ones that name it;
 * - in a thread, the ones that name it, and every reply in its own thread (one that hangs off its
 *   message; for an agent, also one opened for it), plus a reply to a message a run posted;
 * - in a direct message, every message.
 *
 * A run gets a message as a row in its inbox (`runInbox`), labelled with who sent it, the person
 * accountable and whether that person is the run's own. The run's bridge puts it into the run's
 * session when it takes run messages (lib/runDelivery.ts). Messaging a run needs only messages.post;
 * sending an A2A agent work still needs runs.start (ADR 0012).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accountableId, accountableStands, activeAgentKeys, hasScope, type Actor } from "./actor";
import { maySendWork, peerForAgent } from "./a2a/runs";
import { messageAgent, threadOwners } from "./a2a/conversations";
import { directMemberIds, directRunIds, memberCanSee, whereLabel } from "./channels";
import { roomError } from "./errors";
import { teamMember } from "./members";
import { mentionTokens, runTokens, withNames } from "./messages";
import { isScope, type Scope } from "./scopes";
import { addressRefusal, hearsFrom, hearsIn, runNamer, runNamesIn, runPerson, visibleOutsideLine } from "./runLabels";
import { deliverToHosted, markSeen } from "./deliveries";
import { MAX_WAITING, noticeRun } from "./runDelivery";

export { MAX_WAITING } from "./runDelivery";

/**
 * The members a message names: `<@memberId>` tokens in its body (unknown ids and, in a direct
 * message or private channel, non-members are left as text) and the ids passed (which must be team
 * members, and in a direct message or private channel, its members).
 */
export async function resolveMentions(
  ctx: QueryCtx,
  actor: Actor,
  channel: Doc<"channels">,
  body: string,
  passed: Id<"members">[],
): Promise<Doc<"members">[]> {
  const found: Doc<"members">[] = [];
  const seen = new Set<string>();
  for (const id of passed) {
    if (seen.has(id)) continue;
    const member = await teamMember(ctx, actor, id);
    if (!(await memberCanSee(ctx, channel, member._id))) {
      throw roomError("invalid", `${member.name} isn't in ${whereLabel(channel)}, so they can't be mentioned in it.`);
    }
    seen.add(id);
    found.push(member);
  }
  for (const token of mentionTokens(body)) {
    const id = ctx.db.normalizeId("members", token);
    if (!id || seen.has(id)) continue;
    const member = await ctx.db.get(id);
    if (!member || member.teamId !== actor.teamId || member.removedAt !== undefined) continue;
    if (!(await memberCanSee(ctx, channel, member._id))) continue;
    seen.add(id);
    found.push(member);
  }
  return found;
}

/**
 * The live runs a message is addressed to: `<@run:runId>` tokens in its body (a run that isn't live,
 * or that the poster can't address here, stays text) and the runs passed (each must be addressable,
 * or the post is refused). See `addressRefusal` for who may address a run where. `kept`: on an edit,
 * the runs the message already addressed.
 */
export async function resolveAddressedRuns(
  ctx: QueryCtx,
  actor: Actor,
  channel: Doc<"channels">,
  body: string,
  passed: Id<"runs">[],
  kept: readonly Id<"runs">[] = [],
): Promise<Id<"runs">[]> {
  const found: Id<"runs">[] = [];
  for (const id of passed) {
    if (found.includes(id)) continue;
    const run = await ctx.db.get(id);
    const refusal = run ? await addressRefusal(ctx, actor, run, channel) : { code: "not_found" as const, message: "Not found in this team." };
    if (refusal) throw roomError(refusal.code, refusal.message);
    found.push(id);
  }
  for (const token of runTokens(body)) {
    const id = ctx.db.normalizeId("runs", token);
    if (!id || found.includes(id)) continue;
    // An edit keeps a run the message already addressed while its token stays, live or not.
    if (kept.includes(id)) {
      found.push(id);
      continue;
    }
    const run = await ctx.db.get(id);
    if (!run || (await addressRefusal(ctx, actor, run, channel))) continue;
    found.push(id);
  }
  return found;
}

/**
 * An A2A agent as the sender of its own answer, which the room posts for it (ADR 0024): it acts for
 * the person who added it, with the scopes its unrevoked keys have together, so its answer starts
 * A2A work only if one of its keys may (runs.start), and messages a run only if one may post
 * (messages.post). Null when the agent or its person left.
 */
export async function agentSender(ctx: QueryCtx, member: Doc<"members">): Promise<Actor | null> {
  if (member.kind !== "agent" || !member.agentId || member.removedAt !== undefined) return null;
  const agent = await ctx.db.get(member.agentId);
  const accountable = agent ? await ctx.db.get(agent.addedBy) : null;
  if (!agent || !accountable || !(await accountableStands(ctx, accountable))) return null;
  // Only unrevoked keys, so revoked ones never crowd out a valid key.
  const scopes = new Set<Scope>();
  for (const key of await activeAgentKeys(ctx, agent._id)) for (const s of key.scopes) if (isScope(s)) scopes.add(s);
  return {
    kind: "agent",
    teamId: member.teamId,
    member,
    role: member.role === "admin" && accountable.role === "admin" ? "admin" : "member",
    scopes,
    accountable,
  };
}

/**
 * Sends a message to the A2A agents it is for (ADR 0012, ADR 0024): the agents it names; in a
 * direct message, every agent in it; and in a thread, the agents whose own thread it is. Each gets
 * it in its conversation in this place: on its open task, or as a new task in the same context. An
 * agent never gets its own message; a run it drives can message it (ADR 0029 D2: stored under the
 * agent, not written by it). Returns the runs it went to.
 */
async function sendToAgents(
  ctx: MutationCtx,
  sender: Actor,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  parent: Doc<"messages"> | undefined,
  agents: Doc<"members">[],
) {
  // A mention that can't be sent (no endpoint, the agent takes work only from its person, or an
  // agent sender without runs.start) is still a mention; it just starts nothing.
  if (!maySendWork(sender)) return [];
  const names = new Map<string, string>();
  for (const member of await Promise.all(mentionTokens(message.body).map((id) => ctx.db.normalizeId("members", id)))) {
    if (!member) continue;
    const doc = await ctx.db.get(member);
    if (doc) names.set(doc._id, doc.name);
  }
  await runNamesIn(ctx, sender.teamId, message.body, runNamer(ctx), names);
  // The work is the message as written, Markdown and all; only mention tokens become names.
  const prompt = withNames(message.body, (id) => names.get(id)).trim();
  const runs: Id<"runs">[] = [];
  for (const member of agents) {
    if (!member.agentId || (member.agentId === sender.member.agentId && !message.asRun)) continue;
    const peer = await peerForAgent(ctx, member.agentId);
    if (!peer?.endpoint) continue;
    try {
      const runId = await messageAgent(ctx, sender, {
        agentMember: member,
        channel,
        threadRoot: parent,
        message,
        text: prompt || "(an attachment)",
      });
      if (runId && !runs.includes(runId)) runs.push(runId);
    } catch {
      // Refused for this sender: the mention stays a mention.
    }
  }
  return runs;
}

/** The runs a message is for: those it addresses, the run whose thread it is in, and a direct message's runs. */
async function runRecipients(
  ctx: QueryCtx,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  parent: Doc<"messages"> | undefined,
  replyTarget: Doc<"messages"> | undefined,
): Promise<Id<"runs">[]> {
  const ids: Id<"runs">[] = [...(message.addressedRuns ?? [])];
  const add = (id: Id<"runs"> | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(parent?.asRun?.runId);
  add(replyTarget?.asRun?.runId);
  for (const id of await directRunIds(ctx, channel)) add(id);
  // A run never gets its own message.
  return ids.filter((id) => id !== message.asRun?.runId);
}

/**
 * A centered line in the place, about a run: the room's, with no seq, as a pin line. `warn` for a
 * message that didn't reach the run, `info` for what the place should know, such as whose output a
 * run in it is.
 */
export async function runLine(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  parent: Doc<"messages"> | undefined,
  run: Doc<"runs">,
  text: string,
  tone: "info" | "warn" = "warn",
) {
  await ctx.db.insert("messages", {
    teamId: channel.teamId,
    channelId: channel._id,
    authorId: run.driverId!,
    format: "markdown",
    body: "",
    ...(parent ? { replyTo: parent._id } : {}),
    mentionedTasks: [],
    mentionedRuns: [],
    system: { kind: "run", runId: run._id, text, tone },
  });
  await ctx.db.patch(channel._id, { lastMessageAt: Date.now() });
}

/**
 * Puts a message in the inbox of each run it is for, when the run still may get it here and hears
 * this sender. A run that takes messages only from its driver, or whose inbox is full, gets nothing,
 * and a line in the place says so. A message from a direct message or private channel to a run whose
 * output people outside it can see is in the run's inbox as failed (`visible_outside`, ADR 0039),
 * with a line in the place, unless it is a direct message opened with that run (`hearsIn`). Returns the runs it went to.
 */
async function sendToRuns(
  ctx: MutationCtx,
  sender: Actor,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  parent: Doc<"messages"> | undefined,
  replyTarget: Doc<"messages"> | undefined,
): Promise<Id<"runs">[]> {
  const sent: Id<"runs">[] = [];
  // Messaging a run needs messages.post (D3): an agent whose answer the room posts may not have it.
  if (!hasScope(sender, "messages.post")) return sent;
  const name = runNamer(ctx);
  const accountable = accountableId(sender);
  for (const runId of await runRecipients(ctx, channel, message, parent, replyTarget)) {
    const run = await ctx.db.get(runId);
    if (!run || (await addressRefusal(ctx, sender, run, channel))) continue;
    const person = await runPerson(ctx, run);
    const row = {
      teamId: run.teamId,
      runId: run._id,
      messageId: message._id,
      channelId: channel._id,
      from: { memberId: message.authorId, ...(message.asRun ? { runId: message.asRun.runId } : {}) },
      accountableId: accountable,
      fromDriver: person !== null && person._id === accountable,
      at: Date.now(),
    };
    // What a run hears shows in its output, which people outside a private place may see (ADR 0039):
    // the message fails at once, and the place says why. A direct message opened with the run is
    // the exception: it said whose output the run is when it opened (channels.openDirect).
    if (!(await hearsIn(ctx, run, channel))) {
      await ctx.db.insert("runInbox", { ...row, status: "failed", error: "visible_outside" });
      await runLine(ctx, channel, parent, run, visibleOutsideLine(await name(run), channel));
      continue;
    }
    if (!(await hearsFrom(ctx, run, sender))) {
      await runLine(ctx, channel, parent, run, `${await name(run)} takes messages only from ${person?.name ?? "its driver"} and their agents, so it didn't get this.`);
      continue;
    }
    // Claimed messages count too: a claim the bridge gives back, or nobody answers, waits again.
    const waiting = await ctx.db
      .query("runInbox")
      .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "waiting"))
      .take(MAX_WAITING);
    const claimed =
      waiting.length < MAX_WAITING
        ? await ctx.db
            .query("runInbox")
            .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "claimed"))
            .take(MAX_WAITING - waiting.length)
        : [];
    if (waiting.length + claimed.length >= MAX_WAITING) {
      await runLine(ctx, channel, parent, run, `${await name(run)} isn't taking messages: ${MAX_WAITING} are already waiting for it.`);
      continue;
    }
    await ctx.db.insert("runInbox", { ...row, status: "waiting" });
    // The run's bridge claims it for the run's session, if it takes run messages (lib/runDelivery.ts).
    await noticeRun(ctx, run);
    sent.push(run._id);
  }
  return sent;
}

/**
 * Routes a message just posted: to the A2A agents and live runs it is for. `agents` are the agents
 * it names; `replyTarget` is the message a reply was written under, when that isn't the thread's
 * first message; `sentTo` are agents the caller already sent it to, such as a run panel's reply
 * (runs.reply) to the run's own agent, which don't get it twice. Returns the A2A runs it went to
 * (kept in mentionedRuns and a2aRuns) and the runs whose inbox it is in.
 */
export async function routeMessage(
  ctx: MutationCtx,
  sender: Actor,
  channel: Doc<"channels">,
  message: Doc<"messages">,
  parent: Doc<"messages"> | undefined,
  opts: { agents: Doc<"members">[]; replyTarget?: Doc<"messages"> | undefined; sentTo?: Id<"members">[] },
): Promise<{ a2aRuns: Id<"runs">[]; runs: Id<"runs">[] }> {
  const agents = [...opts.agents];
  const add = (member: Doc<"members"> | null) => {
    if (member && !agents.some((a) => a._id === member._id)) agents.push(member);
  };
  for (const id of await directMemberIds(ctx, channel)) {
    const member = await ctx.db.get(id);
    if (member && member.kind === "agent" && member.removedAt === undefined) add(member);
  }
  // A reply in an agent's own thread continues its conversation without naming it (ADR 0024).
  if (parent) for (const id of await threadOwners(ctx, parent)) add(await ctx.db.get(id));
  const sentTo = new Set<string>(opts.sentTo ?? []);
  const a2aRuns = await sendToAgents(ctx, sender, channel, message, parent, agents.filter((a) => !sentTo.has(a._id)));
  // Agents the room reaches at a routine webhook, or that check in on their own schedule (slice 14).
  await deliverToHosted(ctx, sender, channel, message, parent, agents.filter((a) => !sentTo.has(a._id)));
  // An agent posting in a place has read it: what waited for it there is seen. A run it drives
  // posting there (asRun) says nothing about what the agent itself read.
  if (sender.kind === "agent" && !message.asRun) {
    await markSeen(ctx, sender.member._id, parent ? { kind: "thread", channelId: channel._id, threadRootId: parent._id } : { kind: "top", channelId: channel._id });
  }
  const runs = await sendToRuns(ctx, sender, channel, message, parent, opts.replyTarget);
  return { a2aRuns, runs };
}
