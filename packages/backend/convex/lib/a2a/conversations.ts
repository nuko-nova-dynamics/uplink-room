/**
 * Talking with an A2A agent in chat (ADR 0024). A place is one conversation with an agent: a
 * channel's top level, a thread, or a direct message, and a run on a task has its own. The room
 * keeps the agent's A2A context per conversation, so each message continues it:
 *
 *   - while the agent's task is open (Submitted, Working, Input required, Auth required), a message
 *     goes to that task (spec 3.4.3, "use taskId … to continue or refine a specific task");
 *   - once the task is finished, a message starts a new task in the same context ("use contextId
 *     without taskId to start a new task within an existing conversation context"), a run of its own.
 *
 * Each message also carries what was said in the place since the agent last heard from it, so an
 * agent that keeps no context still has the conversation. The agent's answers, questions and
 * progress come back as chat messages from the agent's member, where it was called; what the agent
 * didn't say itself (a failure, a refused message) comes back as a short line with a link to the
 * run. While the agent works it shows as writing. An agent can propose its own thread
 * (`uplink.room/propose-thread`): Yes, No, or Yes after 30 seconds.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { hasScope, requireScope, type Actor } from "../actor";
import { keepRoomFiles } from "../attachments";
import { canSee, channelLabel, hasMemberList, isDirect, memberCanSee, privateTitle } from "../channels";
import { postAs } from "../chat";
import { roomError } from "../errors";
import { mentionTokens, withNames } from "../messages";
import { runNamer, runNamesIn } from "../runLabels";
import { agentSender, resolveAddressedRuns, resolveMentions, routeMessage } from "../router";
import { setTyping } from "../typing";
import type { Observation } from "./observe";
import { PLAIN_REDACTOR } from "./redact";
import { inLinkConversation, linkInstruction } from "../link";
import {
  agentMaySee,
  agentMember,
  appendToOutbox,
  bindingForRun,
  checkSender,
  insertRun,
  isOpen,
  peerForAgent,
  queueReply,
  stopAsked,
  type Binding,
  type OutboxEntry,
} from "./runs";

export type Conversation = Doc<"a2aConversations">;
export type HistoryLine = { author: string; text: string; at: number };
/** What history needs to know of a conversation: whether the agent keeps its context, and what it last heard. */
export type ContextState = Pick<Conversation, "contextId" | "contextKept" | "contextIgnored" | "heardSeq">;
/** An agent that keeps no context with the room, such as one reached at a routine webhook: history is the place's recent messages. */
export const NO_CONTEXT: ContextState = {};

/** How long a thread proposal waits for Yes or No before it counts as Yes. */
export const PROPOSAL_MS = 30_000;
/** At most this many messages, and characters, of history go with one message. */
export const HISTORY_MESSAGES = 20;
export const HISTORY_CHARS = 4_000;
/** One message in the history is cut to this. */
const HISTORY_ONE = 1_000;
/** A run posts at most this many progress messages; after that, the last one is edited. */
export const MAX_PROGRESS_POSTS = 10;
/** At most this many messages wait for the agent's open task at once. */
export const MAX_QUEUED = 5;
/** The longest answer the room posts; the whole artifacts stay on the run. */
const MAX_POST = 16_000;
/** Fingerprints of posted texts kept per run, to post nothing twice. */
const SAID_KEPT = 20;

export const PROPOSE_THREAD = "uplink.room/propose-thread";
export const THREAD_DECISION = "uplink.room/thread-decision";
export const CAPABILITIES = "uplink.room/capabilities";

/** What the room tells an agent that keeps no context, in the text it reads, so an LLM agent can propose a thread. */
export const PROPOSE_HINT = `To suggest moving this to a thread of its own, start your answer with the line "${PROPOSE_THREAD}: <a short title>". The room asks the person, and opens the thread unless they say no within ${PROPOSAL_MS / 1000} seconds.`;

const DEFAULT_PROPOSAL = "This looks like it should be its own thread. Want me to open it?";
/** Where a canceled proposal shows, when the message its thread would open under is gone. */
const TRIGGER_GONE = "No thread opened: the message it would open under was deleted.";

// ---------- places ----------

/** The conversation an agent has in a place, made on first use. */
export async function conversationAt(
  ctx: MutationCtx,
  teamId: Id<"teams">,
  agentId: Id<"agents">,
  channelId: Id<"channels">,
  threadRootId: Id<"messages"> | undefined,
): Promise<Conversation> {
  const found = await ctx.db
    .query("a2aConversations")
    .withIndex("by_place", (q) => q.eq("agentId", agentId).eq("channelId", channelId).eq("threadRootId", threadRootId))
    .first();
  if (found) return found;
  const id = await ctx.db.insert("a2aConversations", {
    teamId,
    agentId,
    channelId,
    ...(threadRootId ? { threadRootId } : {}),
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

/**
 * The agents whose own thread this is (ADR 0024): it hangs off one of their messages, or was opened
 * for them. One under a message a run posted is the run's (lib/router.ts), not its agent driver's.
 */
export async function threadOwners(ctx: QueryCtx, root: Doc<"messages">): Promise<Id<"members">[]> {
  const owners: Id<"members">[] = [];
  const author = root.asRun ? null : await ctx.db.get(root.authorId);
  if (author?.kind === "agent" && author.removedAt === undefined) owners.push(author._id);
  const opened = await ctx.db
    .query("a2aConversations")
    .withIndex("by_thread", (q) => q.eq("channelId", root.channelId).eq("threadRootId", root._id))
    .take(10);
  for (const c of opened) {
    if (!c.ownThread) continue;
    const member = await agentMember(ctx, c.agentId);
    if (member && member.removedAt === undefined && !owners.includes(member._id)) owners.push(member._id);
  }
  return owners;
}

/** "#general", "a thread in #general", "a direct message". */
export function placeLabel(channel: Doc<"channels">, threadRoot: Doc<"messages"> | null | undefined): string {
  if (isDirect(channel)) return threadRoot ? "a thread in a direct message" : "a direct message";
  return threadRoot ? `a thread in ${channelLabel(channel)}` : channelLabel(channel);
}

function footer(from: string, where: string, hint: boolean): string {
  return `\n\n---\nSent from Uplink Room by ${from} in ${where}.${hint ? `\n${PROPOSE_HINT}` : ""}`;
}

/**
 * Whether the agent is known to keep this conversation's context: it answered in the context the
 * room sent it. Until then (the first messages, an agent that ignores contexts, a fresh context),
 * history is the place's recent messages, the agent's own included, not just what came since it
 * last heard.
 */
function keepsContext(conv: ContextState): boolean {
  return conv.contextId !== undefined && conv.contextKept === true && !conv.contextIgnored;
}

// ---------- history ----------

/**
 * What was said in the place since the agent last heard from it, oldest first, bounded: at most
 * HISTORY_MESSAGES messages and HISTORY_CHARS characters, each cut to HISTORY_ONE. Only from the
 * place itself, and only if the agent can see it: a direct message or private channel the agent
 * isn't in gives nothing (ADR 0016). The agent's own messages are left out when it keeps context,
 * since it has them. Credential headers and bearer tokens in what others wrote are taken out.
 */
export async function historyFor(
  ctx: QueryCtx,
  conv: ContextState,
  channel: Doc<"channels">,
  threadRoot: Doc<"messages"> | null | undefined,
  before: Doc<"messages">,
  agent: Doc<"members">,
): Promise<HistoryLine[]> {
  if (!(await memberCanSee(ctx, channel, agent._id))) return [];
  const keeps = keepsContext(conv);
  const heard = keeps ? (conv.heardSeq ?? 0) : 0;
  const rows = threadRoot
    ? await ctx.db
        .query("messages")
        .withIndex("by_reply", (q) => q.eq("replyTo", threadRoot._id))
        .order("desc")
        .take(HISTORY_MESSAGES * 3)
    : await ctx.db
        .query("messages")
        .withIndex("by_channel_top", (q) =>
          q.eq("channelId", channel._id).eq("replyTo", undefined).lt("_creationTime", before._creationTime),
        )
        .order("desc")
        .take(HISTORY_MESSAGES * 3);
  const candidates = rows.filter((m) => m._creationTime < before._creationTime);
  // A thread starts from its first message.
  if (threadRoot && threadRoot._id !== before._id) candidates.push(threadRoot);
  const names = new Map<string, string>();
  const nameOf = async (id: Id<"members">) => {
    const known = names.get(id);
    if (known !== undefined) return known;
    const name = (await ctx.db.get(id))?.name ?? "Former member";
    names.set(id, name);
    return name;
  };
  const runName = runNamer(ctx);
  const out: HistoryLine[] = [];
  let chars = 0;
  for (const m of candidates) {
    if (m.seq !== undefined && m.seq <= heard) break;
    if (m.system || m.deletedAt !== undefined || m.echoOf !== undefined) continue;
    // Its own messages, which a context it keeps holds; not a run's it drives (ADR 0029 D2).
    const own = m.authorId === agent._id && !m.asRun;
    if (own && keeps) continue;
    for (const id of mentionTokens(m.body)) {
      const member = ctx.db.normalizeId("members", id);
      if (member) await nameOf(member);
    }
    await runNamesIn(ctx, agent.teamId, m.body, runName, names);
    const body = m.format === "html" ? "(an HTML page)" : withNames(m.body, (id) => names.get(id)).trim();
    const files = m.attachmentCount ? ` (${m.attachmentCount} attachment${m.attachmentCount === 1 ? "" : "s"})` : "";
    const text = PLAIN_REDACTOR.cut(`${body}${files}`.trim(), HISTORY_ONE).text;
    if (!text) continue;
    if (out.length >= HISTORY_MESSAGES || chars + text.length > HISTORY_CHARS) break;
    const author = m.asRun ? m.asRun.label : await nameOf(m.authorId);
    out.push({ author: own ? `${author} (you)` : author, text, at: m._creationTime });
    chars += text.length;
  }
  return out.reverse();
}

/**
 * The history a run's first message carries when the room starts a fresh context for it (the
 * agent refused or rejected the old one): the place's recent messages, the agent's own included,
 * since the new context starts empty.
 */
export async function freshHistory(ctx: QueryCtx, binding: Binding): Promise<HistoryLine[] | undefined> {
  const conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  const start = binding.outbox[0];
  const triggerId = start?.chatMessageId ?? binding.triggerMessageId;
  if (!conv?.channelId || !triggerId) return start?.history;
  const channel = await ctx.db.get(conv.channelId);
  const trigger = await ctx.db.get(triggerId);
  const member = await agentMember(ctx, binding.agentId);
  if (!channel || !trigger || !member) return start?.history;
  const threadRoot = conv.threadRootId ? await ctx.db.get(conv.threadRootId) : null;
  const lines = await historyFor(ctx, { ...conv, contextId: undefined, contextKept: undefined }, channel, threadRoot, trigger, member);
  return lines.length ? lines : undefined;
}

/** Where a run's conversation is, as the history's heading names it ("#general", "a direct message"). */
export async function whereOf(ctx: QueryCtx, binding: Binding): Promise<string | undefined> {
  const conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  const channel = conv?.channelId ? await ctx.db.get(conv.channelId) : null;
  if (!channel) return undefined;
  return placeLabel(channel, conv?.threadRootId ? await ctx.db.get(conv.threadRootId) : null);
}

/** Whether the agent may propose a thread here: a channel's or direct message's top level. */
export async function mayProposeThread(ctx: QueryCtx, binding: Binding): Promise<boolean> {
  const conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  if (!conv?.channelId || conv.threadRootId !== undefined || binding.triggerMessageId === undefined) return false;
  // Not in a person's Link conversation (ADR 0049): its Inbox has no Yes or No for a proposal.
  return !(await inLinkConversation(ctx, conv.channelId, binding.triggerMessageId));
}


// ---------- sending ----------

/**
 * The run whose task is open in this conversation, if any. One at another endpoint than the
 * agent's current one isn't: the worker stops following it at the old address, so a message
 * queued there would never go out. The message starts a task at the current endpoint instead.
 */
async function openBinding(ctx: QueryCtx, conv: Conversation, peer: Doc<"a2aPeers">): Promise<Binding | null> {
  if (!conv.openRunId) return null;
  const binding = await bindingForRun(ctx, conv.openRunId);
  if (!binding || !isOpen(binding)) return null;
  return binding.peerId === peer._id && binding.endpointGeneration === peer.endpointGeneration ? binding : null;
}

/** The room task a run is on, while it is still open: a run that goes on from it belongs to it too. */
export async function openTaskOf(ctx: QueryCtx, run: Doc<"runs"> | null): Promise<Doc<"tasks"> | undefined> {
  const task = run?.taskId ? await ctx.db.get(run.taskId) : null;
  // A closed task gets no new runs: later work on it is unfiled (GLOSSARY, Closed task).
  return task && task.closedAt === undefined ? task : undefined;
}

type Sender = { memberId: Id<"members">; name: string };

/**
 * Sends one message in a conversation: to the agent's open task when there is one (it waits there
 * until the agent has a task, and moves to the next task if that one ends first), or as a new task
 * in the conversation's context. `message` is the chat message it is; a proposal's answer has none.
 * Returns the run it went to, or null when too many messages already wait.
 */
export async function sendInConversation(
  ctx: MutationCtx,
  opts: {
    conv: Conversation;
    agent: Doc<"agents">;
    agentMember: Doc<"members">;
    peer: Doc<"a2aPeers">;
    sender: Sender;
    text: string;
    message?: Doc<"messages"> | undefined;
    decision?: OutboxEntry["decision"];
  },
): Promise<Id<"runs"> | null> {
  const { conv, agent, agentMember: member, peer, sender } = opts;
  const channel = conv.channelId ? await ctx.db.get(conv.channelId) : null;
  const threadRoot = conv.threadRootId ? await ctx.db.get(conv.threadRootId) : null;
  const history =
    channel && opts.message ? await historyFor(ctx, conv, channel, threadRoot, opts.message, member) : [];
  const where = channel ? placeLabel(channel, threadRoot) : undefined;
  const now = Date.now();
  const heard = opts.message?.seq !== undefined ? Math.max(conv.heardSeq ?? 0, opts.message.seq) : conv.heardSeq;
  const open = await openBinding(ctx, conv, peer);
  // In a person's Link conversation (ADR 0049), the agent is told it is their Link.
  const link = channel && !threadRoot ? await linkInstruction(ctx, channel, sender.memberId, member._id) : null;
  // A new task tells an agent not known to keep context how to propose a thread, in text it reads;
  // not in a Link conversation, whose Inbox shows no proposals and expects answers in place.
  const hint = !link && !open && !!channel && !threadRoot && !keepsContext(conv) && !opts.decision;
  const text = where ? `${opts.text}${footer(sender.name, where, hint)}${link ? `\n${link}` : ""}` : opts.text;
  if (open) {
    if (open.outbox.filter((e) => e.status === "pending").length >= MAX_QUEUED) {
      if (channel) {
        await postLine(ctx, channel, threadRoot, member._id, open.runId, `${agent.name} has ${MAX_QUEUED} messages waiting to go out, so this one wasn't sent. Send it again once it answers.`, "warn");
      }
      return null;
    }
    await appendToOutbox(ctx, open, {
      messageId: crypto.randomUUID(),
      kind: "reply",
      text,
      from: sender.name,
      by: sender.memberId,
      at: now,
      status: "pending",
      ...(history.length ? { history } : {}),
      ...(opts.message ? { chatMessageId: opts.message._id } : {}),
      ...(opts.decision ? { decision: opts.decision } : {}),
    });
    await ctx.db.patch(conv._id, { heardSeq: heard, updatedAt: now });
    // Answering a question: the agent works again as soon as it reads it.
    if (channel) await setWorking(ctx, channel, conv.threadRootId, member._id, open.runId, true);
    return open.runId;
  }
  const generationOk = conv.contextGeneration === peer.endpointGeneration;
  const team = await ctx.db.get(conv.teamId);
  const origin = conv.originRunId ? await ctx.db.get(conv.originRunId) : null;
  const task = origin?.taskId ? await ctx.db.get(origin.taskId) : null;
  const openTask = await openTaskOf(ctx, origin);
  const firstLine = opts.text.split("\n")[0]!.slice(0, 80);
  const runId = await insertRun(ctx, {
    teamId: conv.teamId,
    agent,
    peer,
    by: sender,
    text,
    title: channel
      ? !hasMemberList(channel)
        ? firstLine || `${agent.name} run`
        : privateTitle(channel, "message", sender.name)
      : (task?.title ?? origin?.title ?? (firstLine || `${agent.name} run`)),
    task: openTask,
    directChannelId: channel && hasMemberList(channel) ? channel._id : origin?.directChannelId,
    meta: {
      team: team?.name ?? "",
      ...(task ? { taskId: task._id, task: task.title } : {}),
      ...(channel
        ? {
            channelId: channel._id,
            channel: isDirect(channel) ? "direct message" : channel.name,
            ...(opts.message ? { messageId: opts.message._id } : {}),
          }
        : {}),
    },
    conversationId: conv._id,
    triggerMessageId: opts.message?._id,
    contextId: generationOk ? conv.contextId : undefined,
    previousTaskId: generationOk ? conv.lastTaskId : undefined,
    first: {
      ...(history.length ? { history } : {}),
      ...(opts.message ? { chatMessageId: opts.message._id } : {}),
      ...(opts.decision ? { decision: opts.decision } : {}),
    },
  });
  await ctx.db.patch(conv._id, {
    openRunId: runId,
    heardSeq: heard,
    updatedAt: now,
    ...(generationOk ? {} : { contextId: undefined, contextGeneration: undefined, contextKept: undefined, lastTaskId: undefined }),
  });
  if (channel) await setWorking(ctx, channel, conv.threadRootId, member._id, runId, true);
  return runId;
}

/**
 * A chat message to an agent (messages.post): the place's conversation gets it, if `actor` may
 * send the agent work. Throws a room error when it may not; the message stays a mention.
 */
export async function messageAgent(
  ctx: MutationCtx,
  actor: Actor,
  opts: {
    agentMember: Doc<"members">;
    channel: Doc<"channels">;
    threadRoot: Doc<"messages"> | undefined;
    message: Doc<"messages">;
    text: string;
  },
): Promise<Id<"runs"> | null> {
  const agent = opts.agentMember.agentId ? await ctx.db.get(opts.agentMember.agentId) : null;
  if (!agent) return null;
  // A run's message is sent as the run's, which can be one its agent driver drives (ADR 0029 D2).
  const asRun = opts.message.asRun;
  const peer = await checkSender(ctx, actor, agent, { asRun: asRun !== undefined });
  const conv = await conversationAt(ctx, actor.teamId, agent._id, opts.channel._id, opts.threadRoot?._id);
  return sendInConversation(ctx, {
    conv,
    agent,
    agentMember: opts.agentMember,
    peer,
    sender: { memberId: actor.member._id, name: asRun?.label ?? actor.member.name },
    text: opts.text,
    message: opts.message,
  });
}

/**
 * A reply on a run (runs.reply), after its permissions are checked. On a run from chat it is
 * posted in that place as the sender's message, then sent as any chat message there is. Otherwise
 * it goes to the run's open task, or once that is finished, starts the next task in the run's own
 * conversation.
 */
export async function replyInConversation(
  ctx: MutationCtx,
  actor: Actor,
  run: Doc<"runs">,
  binding: Binding,
  member: Doc<"members">,
  body: string,
): Promise<Id<"runs">> {
  const agent = await ctx.db.get(binding.agentId);
  if (!agent) throw roomError("conflict", "This agent isn't in the team any more.");
  let conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  const channel = conv?.channelId ? await ctx.db.get(conv.channelId) : null;
  if (conv && channel) {
    if (!(await canSee(ctx, actor, channel))) {
      throw roomError("forbidden", "This run came from a conversation you aren't in.");
    }
    // The reply is posted there as the sender's chat message, so it takes what messages.post takes:
    // an agent key needs that scope too, not only runs.start, and an archived channel takes nothing.
    requireScope(actor, "messages.post");
    if (channel.archivedAt !== undefined) throw roomError("invalid", "This run came from an archived channel.");
    const peer = await checkSender(ctx, actor, agent);
    const threadRoot = conv.threadRootId ? await ctx.db.get(conv.threadRootId) : null;
    // At a channel's top level, a message reaches the agent when it names it.
    const named = !hasMemberList(channel) && !threadRoot && !mentionTokens(body).includes(member._id);
    const parent = threadRoot ?? undefined;
    const addressedRuns = await resolveAddressedRuns(ctx, actor, channel, body, []);
    const message = await postAs(ctx, channel, actor.member._id, named ? `<@${member._id}> ${body}` : body, {
      parent,
      mentioned: [member._id],
      ...(addressedRuns.length ? { extra: { addressedRuns } } : {}),
    });
    const runId = await sendInConversation(ctx, { conv, agent, agentMember: member, peer, sender: { memberId: actor.member._id, name: actor.member.name }, text: body, message });
    if (!runId) throw roomError("conflict", `${agent.name} has ${MAX_QUEUED} messages waiting to go out. Send this again once it answers.`);
    // Then everywhere else a chat message there goes (lib/router.ts): the live runs it is for, and
    // the other agents in a direct message or thread. The run's own agent has it already.
    const routed = await routeMessage(ctx, actor, channel, message, parent, { agents: [], sentTo: [member._id] });
    const a2aRuns = [runId, ...routed.a2aRuns.filter((id) => id !== runId)];
    await ctx.db.patch(message._id, { mentionedRuns: a2aRuns, a2aRuns });
    await setTyping(ctx, channel, actor.member._id, null);
    return runId;
  }
  if (isOpen(binding)) {
    await queueReply(ctx, actor, binding, body);
    return run._id;
  }
  // Finished: the next task in the same context. A run from before conversations gets its own now.
  if (!conv) {
    const id = await ctx.db.insert("a2aConversations", {
      teamId: run.teamId,
      agentId: agent._id,
      originRunId: run._id,
      ...(binding.contextId ? { contextId: binding.contextId, contextGeneration: binding.endpointGeneration } : {}),
      ...(binding.taskId ? { lastTaskId: binding.taskId } : {}),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(binding._id, { conversationId: id });
    conv = (await ctx.db.get(id))!;
  }
  const peer = await checkSender(ctx, actor, agent);
  const runId = await sendInConversation(ctx, { conv, agent, agentMember: member, peer, sender: { memberId: actor.member._id, name: actor.member.name }, text: body });
  if (!runId) throw roomError("conflict", `${agent.name} has ${MAX_QUEUED} messages waiting to go out. Send this again once it answers.`);
  return runId;
}

/**
 * The agent's task ended while messages still waited for it (sent before it had a task, or not
 * yet sent): they go on to a new task in the same context, as a new run (ADR 0024). Never sent
 * twice: they were never sent to the task that ended. After someone asked to stop the run they
 * aren't sent at all, so the Stop doesn't start the conversation again: a line says so.
 */
async function carryOver(ctx: MutationCtx, binding: Binding, conv: Conversation): Promise<void> {
  const waiting = binding.outbox.filter((e) => e.kind === "reply" && e.status === "pending");
  if (!waiting.length) return;
  if (stopAsked(binding)) {
    const who = (await ctx.db.get(binding.cancel!.by))?.name ?? "Someone";
    await ctx.db.patch(binding._id, {
      outbox: binding.outbox.map((e) => (waiting.includes(e) ? { ...e, status: "failed" as const, error: `Not sent: ${who} stopped the run.` } : e)),
    });
    const channel = conv.channelId ? await ctx.db.get(conv.channelId) : null;
    const member = await agentMember(ctx, binding.agentId);
    if (channel && member && member.removedAt === undefined && channel.archivedAt === undefined && (await memberCanSee(ctx, channel, member._id))) {
      const n = waiting.length;
      const what = n === 1 ? `A message waiting for ${member.name} wasn't sent` : `${n} messages waiting for ${member.name} weren't sent`;
      const threadRoot = conv.threadRootId ? await ctx.db.get(conv.threadRootId) : null;
      await postLine(ctx, channel, threadRoot, member._id, binding.runId, `${what}: ${who} stopped the run.`, "info");
    }
    return;
  }
  await ctx.db.patch(binding._id, { outbox: binding.outbox.filter((e) => !waiting.includes(e)) });
  const agent = await ctx.db.get(binding.agentId);
  const peer = agent ? await peerForAgent(ctx, agent._id) : null;
  if (!agent || !peer?.endpoint || peer.endpointGeneration !== binding.endpointGeneration) return;
  const [first, ...rest] = waiting;
  const sender = { memberId: first!.by, name: first!.from };
  const fresh = (await ctx.db.get(conv._id))!;
  const ended = await ctx.db.get(binding.runId);
  const runId = await insertRun(ctx, {
    teamId: binding.teamId,
    agent,
    peer,
    by: sender,
    text: first!.text,
    title: ended?.title ?? `${agent.name} run`,
    task: await openTaskOf(ctx, ended),
    directChannelId: ended?.directChannelId,
    meta: { ...binding.meta },
    conversationId: conv._id,
    triggerMessageId: first!.chatMessageId ?? binding.triggerMessageId,
    contextId: fresh.contextGeneration === peer.endpointGeneration ? (fresh.contextId ?? binding.contextId) : undefined,
    previousTaskId: binding.taskId,
    first: { history: first!.history, chatMessageId: first!.chatMessageId, decision: first!.decision },
    replies: rest,
  });
  await ctx.db.patch(conv._id, { openRunId: runId, updatedAt: Date.now() });
  // The chat messages that waited now point at the run they went to.
  for (const e of waiting) {
    if (!e.chatMessageId) continue;
    const m = await ctx.db.get(e.chatMessageId);
    if (!m) continue;
    const swap = (ids: Id<"runs">[] | undefined) => [...(ids ?? []).filter((id) => id !== binding.runId), runId];
    await ctx.db.patch(m._id, { mentionedRuns: swap(m.mentionedRuns), a2aRuns: swap(m.a2aRuns) });
  }
  const channel = fresh.channelId ? await ctx.db.get(fresh.channelId) : null;
  const member = await agentMember(ctx, agent._id);
  if (channel && member) await setWorking(ctx, channel, fresh.threadRootId, member._id, runId, true);
}

/**
 * A reply the agent refused because its task had ended (UnsupportedOperationError or
 * TaskNotFoundError, spec 3.1.1): the agent took nothing, so it goes as a new task in the same
 * context, with a new message id (ADR 0024).
 */
export async function replyTaskEnded(ctx: MutationCtx, binding: Binding, messageId: string): Promise<void> {
  const entry = binding.outbox.find((e) => e.messageId === messageId);
  if (!entry) return;
  await ctx.db.patch(binding._id, {
    outbox: binding.outbox.map((e) =>
      e.messageId === messageId ? { ...e, status: "pending" as const, messageId: crypto.randomUUID(), error: undefined, dialect: undefined } : e,
    ),
  });
  let conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  if (!conv) {
    const id = await ctx.db.insert("a2aConversations", {
      teamId: binding.teamId,
      agentId: binding.agentId,
      originRunId: binding.runId,
      ...(binding.contextId ? { contextId: binding.contextId, contextGeneration: binding.endpointGeneration } : {}),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(binding._id, { conversationId: id });
    conv = (await ctx.db.get(id))!;
  }
  await carryOver(ctx, (await ctx.db.get(binding._id))!, conv);
}

// ---------- the agent's side, in chat ----------

/** A short fingerprint of a text, to post nothing twice (FNV-1a over its words). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** A line the room writes in chat about an agent's run, with a link to it. It has no seq, like a pin line. */
async function postLine(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  threadRoot: Doc<"messages"> | null | undefined,
  agentMemberId: Id<"members">,
  runId: Id<"runs">,
  text: string,
  tone: "info" | "warn",
) {
  const now = Date.now();
  await ctx.db.insert("messages", {
    teamId: channel.teamId,
    channelId: channel._id,
    authorId: agentMemberId,
    format: "markdown",
    body: "",
    ...(threadRoot ? { replyTo: threadRoot._id } : {}),
    mentionedTasks: [],
    mentionedRuns: [],
    system: { kind: "run", runId, text: PLAIN_REDACTOR.cut(text, 600).text, tone },
  });
  await ctx.db.patch(channel._id, { lastMessageAt: now });
}

/**
 * Shows the agent as writing in the place while its run works, and stops when it doesn't (one
 * typing row per member and channel, lib/typing.ts). Only the run that set the row takes it away.
 */
export async function setWorking(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  threadRootId: Id<"messages"> | undefined,
  memberId: Id<"members">,
  runId: Id<"runs">,
  working: boolean,
) {
  const row = await ctx.db
    .query("typing")
    .withIndex("by_member_channel", (q) => q.eq("memberId", memberId).eq("channelId", channel._id))
    .unique();
  if (!working) {
    if (row?.runId === runId) await ctx.db.delete(row._id);
    return;
  }
  if (row && row.runId === runId && row.replyTo === threadRootId) return;
  if (row) await ctx.db.patch(row._id, { at: Date.now(), runId, replyTo: threadRootId });
  else {
    await ctx.db.insert("typing", {
      teamId: channel.teamId,
      channelId: channel._id,
      memberId,
      at: Date.now(),
      runId,
      ...(threadRootId ? { replyTo: threadRootId } : {}),
    });
  }
}

export type RunNews =
  /** The agent reported something (applyObservation). */
  | { kind: "observed"; before: Binding; obs: Observation; said: string | undefined }
  /** The room ended the run without the agent saying so: refused, not confirmed, no longer followed. */
  | { kind: "ended"; text: string; tone: "info" | "warn" }
  /** Something about one message that doesn't end the run, such as a refused reply. */
  | { kind: "line"; text: string; tone: "info" | "warn" };

/**
 * A link's file name, as its list item shows it: the last part of its path, decoded. A name that
 * isn't valid percent-encoding ("report-100%.pdf") shows as written, and a link that isn't a URL
 * shows whole: the answer is posted in the mutation that saved it, so nothing here may throw.
 */
function linkName(url: string): string {
  let last: string;
  try {
    last = new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return url;
  }
  try {
    return decodeURIComponent(last) || url;
  } catch {
    return last || url;
  }
}

/** The texts of the agent's finished answer: its last status message and its artifacts, each once, then its links. */
function answerOf(binding: Binding, said: string | undefined, posted: Set<string>): string {
  const texts: string[] = [];
  const seen = new Set(posted);
  const add = (t: string | undefined) => {
    const text = t?.trim();
    if (!text || seen.has(fingerprint(text))) return;
    seen.add(fingerprint(text));
    texts.push(text);
  };
  add(said);
  for (const a of binding.artifacts) add(a.text ? `${a.text}${a.truncated ? "\n\n(Cut short here; the run has the rest.)" : ""}` : undefined);
  const links = binding.artifacts.flatMap((a) => a.urls.map((url) => `- [${linkName(url).replace(/[[\]]/g, "")}](${url})`));
  const body = [...texts, ...(links.length ? [links.join("\n")] : [])].join("\n\n");
  return body.length > MAX_POST ? `${body.slice(0, MAX_POST - 1)}…` : body;
}

/**
 * After a run's news: the conversation's bookkeeping (its context, its open run), and in chat the
 * agent's answer, question or progress as its own message, a line for what it didn't say itself,
 * and whether it shows as writing. Runs in the mutation that saved the news, so each is posted once.
 */
export async function afterRunNews(ctx: MutationCtx, bindingId: Id<"a2aBindings">, news: RunNews): Promise<void> {
  let binding = await ctx.db.get(bindingId);
  if (!binding?.conversationId) return;
  const conv = await ctx.db.get(binding.conversationId);
  const run = await ctx.db.get(binding.runId);
  if (!conv || !run) return;
  const now = Date.now();
  const convPatch: Partial<Conversation> = {};
  // The context the agent answered in is the conversation's from now on. One other than the room
  // sent means the agent doesn't keep contexts: history carries the conversation for it.
  if (binding.contextId && binding.contextId !== conv.contextId) {
    convPatch.contextId = binding.contextId;
    convPatch.contextGeneration = binding.endpointGeneration;
    if (binding.sentContextId !== undefined && binding.sentContextId !== binding.contextId) convPatch.contextIgnored = true;
  }
  if (binding.contextId && binding.sentContextId === binding.contextId && !conv.contextKept) convPatch.contextKept = true;
  if (binding.taskId) convPatch.lastTaskId = binding.taskId;
  const open = isOpen(binding);
  if (!open && conv.openRunId === binding.runId) convPatch.openRunId = undefined;
  if (Object.keys(convPatch).length) await ctx.db.patch(conv._id, { ...convPatch, updatedAt: now });
  // Messages that waited for a task that has now ended go on to the next one.
  if (!open && news.kind === "observed") {
    await carryOver(ctx, binding, { ...conv, ...convPatch });
    binding = (await ctx.db.get(bindingId))!;
  }

  const channel = conv.channelId ? await ctx.db.get(conv.channelId) : null;
  const member = await agentMember(ctx, binding.agentId);
  const threadRoot = conv.threadRootId ? await ctx.db.get(conv.threadRootId) : null;
  // The agent speaks only where it still is (ADR 0016), and never in an archived channel.
  const speaks = !!channel && !!member && member.removedAt === undefined && channel.archivedAt === undefined && (await memberCanSee(ctx, channel, member._id));
  if (!channel || !member || !speaks) {
    if (!open) await dropFiles(ctx, binding);
    return;
  }
  await setWorking(ctx, channel, conv.threadRootId, member._id, run._id, open && (run.state === "working" || run.state === "unknown"));

  const chat = {
    said: [...(binding.chat?.said ?? [])],
    // From before `routed`: everything said was posted as its own message.
    routed: [...(binding.chat?.routed ?? binding.chat?.said ?? [])],
    progress: binding.chat?.progress ?? 0,
    lastProgressId: binding.chat?.lastProgressId,
    ended: binding.chat?.ended,
  };
  /** Texts already shown, in a message or an edit of the last progress message: not shown again as progress. */
  const posted = new Set(chat.said);
  /**
   * Texts already posted as a message of their own, and so sent where that message goes. An answer
   * or question repeats only these: text shown only by editing the progress message never went
   * anywhere, so an answer that repeats it is still posted, and still reaches who it is for.
   */
  const delivered = new Set(chat.routed);
  const remember = (text: string, routed = false) => {
    const keep = (list: string[]) => [...list.filter((f) => f !== fingerprint(text)), fingerprint(text)].slice(-SAID_KEPT);
    chat.said = keep(chat.said);
    if (routed) chat.routed = keep(chat.routed);
  };
  const parent = threadRoot ?? undefined;
  // An answer or a question is addressed to whoever asked, as a reply would be; a direct message's members hear of it anyway.
  const asker = !isDirect(channel) && run.startedBy ? [run.startedBy] : [];
  // The agent as the sender of what it says, for the members and runs it names and where its answer goes.
  const sender = await agentSender(ctx, member);
  const say = async (text: string, addressed: boolean) => {
    const named = sender ? await resolveMentions(ctx, sender, channel, text, []) : [];
    // An agent that may not post messages (D3) names a run as text only, as it can't message it.
    const runs = sender && hasScope(sender, "messages.post") ? await resolveAddressedRuns(ctx, sender, channel, text, []) : [];
    const mentioned = [...new Set([...(addressed ? asker : []), ...named.map((m) => m._id)])];
    const message = await postAs(ctx, channel, member._id, text, {
      parent,
      mentioned,
      mentionedRuns: [run._id],
      extra: { a2a: { runId: run._id }, ...(runs.length ? { addressedRuns: runs } : {}) },
    });
    remember(text, true);
    // Each message goes, once, to the agents and runs it names, the runs whose thread it is in, and
    // in a direct message to every agent and run there, as anyone's message does (ADR 0026: no loop
    // limit). Progress too: a run in a direct message hears everything said in it.
    if (sender) {
      const routed = await routeMessage(ctx, sender, channel, message, parent, { agents: named.filter((m) => m.kind === "agent") });
      if (routed.a2aRuns.length) {
        await ctx.db.patch(message._id, { mentionedRuns: [run._id, ...routed.a2aRuns], a2aRuns: routed.a2aRuns });
        return (await ctx.db.get(message._id))!;
      }
    }
    return message;
  };
  const line = (text: string, tone: "info" | "warn") => postLine(ctx, channel, threadRoot, member._id, run._id, text, tone);

  if (news.kind === "line") {
    await line(news.text, news.tone);
    return;
  }
  if (news.kind === "ended") {
    if (!chat.ended) {
      await line(news.text, news.tone);
      chat.ended = true;
    }
    await dropFiles(ctx, binding);
    await ctx.db.patch(binding._id, { chat });
    return;
  }

  const { before, obs } = news;
  // In a person's Link conversation (ADR 0049) a proposal isn't taken: one that came with no other
  // text is said as an answer, so the person still sees what the agent wrote.
  const linkHere = obs.proposal && binding.triggerMessageId ? await inLinkConversation(ctx, channel._id, binding.triggerMessageId) : false;
  // Never the person's own words echoed back: only what the agent said is its answer.
  const said = obs.fromUser ? undefined : news.said?.trim() || undefined;
  const text = said ?? (linkHere && obs.proposal && !obs.fromUser ? obs.proposal.title?.trim() || DEFAULT_PROPOSAL : undefined);
  const state = binding.externalState;
  const stateChanged = before.externalState !== state;
  const name = member.name;

  const proposalBody = text || DEFAULT_PROPOSAL;
  // Once someone asked to stop the run it proposes nothing: a Yes after the wait would only start
  // the conversation again (ADR 0024). What the run ends with shows instead.
  const stopping = stopAsked(binding);
  if (obs.proposal && stopping && open) {
    // Nothing to post.
  } else if (
    obs.proposal &&
    !stopping &&
    !threadRoot &&
    binding.triggerMessageId &&
    !conv.proposalMessageId &&
    !posted.has(fingerprint(proposalBody)) &&
    // In a Link conversation a proposal is answered as anything else said (ADR 0049).
    !linkHere
  ) {
    // The agent asks to move its work to a thread of its own: Yes, No, or Yes after a short wait.
    const body = proposalBody;
    const expiresAt = now + PROPOSAL_MS;
    // The members and runs it names hear of it, under the same checks as anything else it says.
    const named = sender ? await resolveMentions(ctx, sender, channel, body, []) : [];
    const runs = sender && hasScope(sender, "messages.post") ? await resolveAddressedRuns(ctx, sender, channel, body, []) : [];
    let message = await postAs(ctx, channel, member._id, body, {
      mentioned: [...new Set([...asker, ...named.map((m) => m._id)])],
      mentionedRuns: [run._id],
      extra: {
        ...(runs.length ? { addressedRuns: runs } : {}),
        a2a: {
          runId: run._id,
          proposal: {
            ...(obs.proposal.title ? { title: obs.proposal.title } : {}),
            status: "pending",
            expiresAt,
            triggerMessageId: binding.triggerMessageId,
            conversationId: conv._id,
          },
        },
      },
    });
    remember(body, true);
    // Posted like any of its messages, it goes where they go: in a direct message, to its runs.
    if (sender) {
      const routed = await routeMessage(ctx, sender, channel, message, undefined, { agents: named.filter((m) => m.kind === "agent") });
      if (routed.a2aRuns.length) {
        await ctx.db.patch(message._id, { mentionedRuns: [run._id, ...routed.a2aRuns], a2aRuns: routed.a2aRuns });
        message = (await ctx.db.get(message._id))!;
      }
    }
    if (!open) chat.ended = true;
    await ctx.db.patch(conv._id, { proposalMessageId: message._id, updatedAt: now });
    await ctx.scheduler.runAfter(PROPOSAL_MS, internal.a2aWorker.proposalTimeout, { messageId: message._id });
  } else if (obs.kind === "message") {
    // A direct Message answer: its text, and the files it sent as bytes attached, as for a finished task.
    const fresh = !!text && !delivered.has(fingerprint(text));
    const files = binding.files ?? [];
    if (fresh || files.length) {
      const message = await say(fresh ? text! : "", true);
      if (files.length) {
        await keepRoomFiles(ctx, message, files);
        await ctx.db.patch(binding._id, { files: undefined });
      }
      if (!open) await settleAnswered(ctx, run);
    } else if (!text && !open && !chat.ended) await line(`${name} answered without any text.`, "info");
    if (!open) chat.ended = true;
  } else if (state === "TASK_STATE_INPUT_REQUIRED") {
    if (text && !delivered.has(fingerprint(text))) await say(text, true);
    else if (!text && stateChanged) await line(`${name} needs more from you to go on. Answer here.`, "info");
  } else if (state === "TASK_STATE_AUTH_REQUIRED") {
    if (stateChanged) await line(run.prompt?.text ?? `${name} needs someone to sign in at its gateway before it can go on.`, "warn");
  } else if (state === "TASK_STATE_SUBMITTED" || state === "TASK_STATE_WORKING") {
    // Progress: only a status message with text, never the bare state.
    if (text && !posted.has(fingerprint(text))) {
      if (chat.progress < MAX_PROGRESS_POSTS) {
        const message = await say(text, false);
        chat.progress += 1;
        chat.lastProgressId = message._id;
      } else if (chat.lastProgressId) {
        const last = await ctx.db.get(chat.lastProgressId);
        if (last && last.deletedAt === undefined) {
          await ctx.db.patch(last._id, { body: text, editedAt: now });
          remember(text);
        } else {
          // Someone deleted it: progress goes on in a new message, which later news edits.
          chat.lastProgressId = (await say(text, false))._id;
        }
      }
    }
  } else if (state === "TASK_STATE_COMPLETED" && !chat.ended) {
    const body = answerOf(binding, text, delivered);
    const files = binding.files ?? [];
    if (body || files.length) {
      const message = await say(body || "", true);
      if (files.length) await keepRoomFiles(ctx, message, files);
      await settleAnswered(ctx, run);
    } else {
      await line(`${name} finished without a message.`, "info");
    }
    chat.ended = true;
    await ctx.db.patch(binding._id, { files: undefined });
  } else if ((state === "TASK_STATE_FAILED" || state === "TASK_STATE_REJECTED") && !chat.ended) {
    const why = text ?? binding.lastMessage;
    await line(
      state === "TASK_STATE_FAILED"
        ? why
          ? `${name} couldn't finish: ${why}`
          : `${name} reported that the task failed.`
        : why
          ? `${name} declined: ${why}`
          : `${name} won't do this task.`,
      "warn",
    );
    chat.ended = true;
  } else if (state === "TASK_STATE_CANCELED" && !chat.ended) {
    await line(binding.cancel ? `${name} stopped, as asked.` : `${name} stopped this work.`, "info");
    chat.ended = true;
  }
  if (!open && state !== "TASK_STATE_COMPLETED") await dropFiles(ctx, binding);
  await ctx.db.patch(binding._id, { chat });
}

/**
 * A chat run whose answer was posted where it was asked settles itself: the person reads the answer
 * in chat, so it doesn't wait in their Inbox's Done (GLOSSARY, Settle: by a rule). Only an unfiled
 * run; one on a task is the task's to settle. A failure or a question isn't settled.
 */
async function settleAnswered(ctx: MutationCtx, run: Doc<"runs">) {
  if (run.taskId) return;
  const fresh = await ctx.db.get(run._id);
  if (fresh?.state === "done") await ctx.db.patch(run._id, { settledAt: Math.max(Date.now(), fresh.stateChangedAt) });
}

/** Files an agent sent that won't be posted: their bytes go. */
async function dropFiles(ctx: MutationCtx, binding: Binding) {
  const fresh = await ctx.db.get(binding._id);
  if (!fresh?.files?.length) return;
  for (const f of fresh.files) await ctx.storage.delete(f.storageId);
  await ctx.db.patch(binding._id, { files: undefined });
}

// ---------- thread proposals ----------

/** Who may answer an agent's thread proposal: whoever wrote the message it would open under, the run's driver or starter, or an admin. */
export async function mayDecide(ctx: QueryCtx, actor: Actor, message: Doc<"messages">): Promise<boolean> {
  const proposal = message.a2a?.proposal;
  if (!proposal) return false;
  if (actor.role === "admin") return true;
  const trigger = await ctx.db.get(proposal.triggerMessageId);
  if (trigger?.authorId === actor.member._id) return true;
  const run = await ctx.db.get(message.a2a!.runId);
  return !!run && (run.driverId === actor.member._id || run.startedBy === actor.member._id);
}

/**
 * Whether `actor` may answer this proposal through messages.answerProposal: an answer goes to the
 * agent as the conversation's next message, which is A2A work, so it takes what runs.reply takes.
 * An agent key needs runs.start, and the agent must take work from this sender (checkSender) and
 * still be in the place. Throws a room error when it may not.
 */
export async function checkDecider(ctx: QueryCtx, actor: Actor, message: Doc<"messages">): Promise<void> {
  requireScope(actor, "runs.start");
  const proposal = message.a2a?.proposal;
  const conv = proposal ? await ctx.db.get(proposal.conversationId) : null;
  const agent = conv ? await ctx.db.get(conv.agentId) : null;
  if (!agent) throw roomError("conflict", "This agent isn't in the team any more.");
  await checkSender(ctx, actor, agent);
  const run = await ctx.db.get(message.a2a!.runId);
  const member = await agentMember(ctx, agent._id);
  if (!run || !member || !(await agentMaySee(ctx, run, member._id))) {
    throw roomError("conflict", "The agent isn't in the conversation this proposal came from any more.");
  }
}

/**
 * Cancels an agent's pending thread proposal: no thread opens, and `reason` says why where the
 * proposal shows. The conversation can take a new proposal. With `tell`, the agent gets its answer
 * as the conversation's next message, as for a No (`uplink.room/thread-decision` with open false),
 * so a task that waits on the answer goes on; without, nothing more goes to the agent (its run was
 * stopped or isn't followed). False when the proposal was no longer pending.
 */
export async function cancelProposal(
  ctx: MutationCtx,
  message: Doc<"messages">,
  reason: string,
  tell: string | null,
): Promise<boolean> {
  const proposal = message.a2a?.proposal;
  if (!proposal || proposal.status !== "pending") return false;
  const now = Date.now();
  await ctx.db.patch(message._id, {
    a2a: { ...message.a2a!, proposal: { ...proposal, status: "canceled", reason, decidedAt: now } },
  });
  const conv = await ctx.db.get(proposal.conversationId);
  if (!conv) return true;
  if (conv.proposalMessageId === message._id) await ctx.db.patch(conv._id, { proposalMessageId: undefined, updatedAt: now });
  if (!tell) return true;
  const run = await ctx.db.get(message.a2a!.runId);
  const agent = await ctx.db.get(conv.agentId);
  const member = agent ? await agentMember(ctx, agent._id) : null;
  const peer = agent ? await peerForAgent(ctx, agent._id) : null;
  if (!agent || !member || member.removedAt !== undefined || !peer?.endpoint || !run?.driverId) return true;
  // The room settles it, as when nobody answers in time: it goes in the name of the run's driver.
  const sender = { memberId: run.driverId, name: (await ctx.db.get(run.driverId))?.name ?? "Uplink Room" };
  const channel = conv.channelId ? await ctx.db.get(conv.channelId) : null;
  const where = channel ? (isDirect(channel) ? "the direct message" : channelLabel(channel)) : "here";
  await sendInConversation(ctx, {
    conv: (await ctx.db.get(conv._id))!,
    agent,
    agentMember: member,
    peer,
    sender,
    text: `No thread: ${tell} Answer here in ${where}.`,
    decision: { open: false, byTimeout: false },
  });
  return true;
}

/**
 * A run that stopped, or that the room stopped following, takes its pending thread proposal with
 * it: a Yes after the wait would only start the conversation again (ADR 0024).
 */
export async function withdrawProposal(ctx: MutationCtx, binding: Binding, reason: string): Promise<void> {
  const conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  const message = conv?.proposalMessageId ? await ctx.db.get(conv.proposalMessageId) : null;
  if (message?.a2a?.runId === binding.runId) await cancelProposal(ctx, message, reason, null);
}

/**
 * A message is being deleted (messages.delete) while a thread proposal waits on it: the proposal
 * itself, or the message its thread would open under. No thread opens, and the agent is told so.
 */
export async function proposalMessageDeleted(ctx: MutationCtx, message: Doc<"messages">): Promise<void> {
  if (message.a2a?.proposal?.status === "pending") {
    await cancelProposal(ctx, message, "No thread opened: the proposal was deleted.", "your proposal was deleted.");
    return;
  }
  // Proposals wait only at a channel's or direct message's top level, one per agent's conversation.
  if (message.replyTo !== undefined || message.system) return;
  const convs = await ctx.db
    .query("a2aConversations")
    .withIndex("by_thread", (q) => q.eq("channelId", message.channelId).eq("threadRootId", undefined))
    .take(50);
  for (const conv of convs) {
    const pending = conv.proposalMessageId ? await ctx.db.get(conv.proposalMessageId) : null;
    if (pending?.a2a?.proposal?.triggerMessageId !== message._id) continue;
    await cancelProposal(ctx, pending, TRIGGER_GONE, "the message it would open under was deleted.");
  }
}

/**
 * Answers an agent's thread proposal. Yes (also when nobody answered in time): the conversation
 * moves to a thread under the message that started it, and the agent's work goes on there, in the
 * same context. No: it answers where it was. Either way the agent is told, as the next message of
 * the conversation. A Yes when that message is gone opens nothing: the proposal is canceled and
 * the agent told no thread opened. False when it was already answered.
 */
export async function decideProposal(
  ctx: MutationCtx,
  message: Doc<"messages">,
  open: boolean,
  decider: Sender | null,
): Promise<boolean> {
  const proposal = message.a2a?.proposal;
  if (!proposal || proposal.status !== "pending") return false;
  if (open) {
    const root = await ctx.db.get(proposal.triggerMessageId);
    if (!root || root.deletedAt !== undefined) {
      return cancelProposal(ctx, message, TRIGGER_GONE, "the message it would open under was deleted.");
    }
  }
  const now = Date.now();
  await ctx.db.patch(message._id, {
    a2a: {
      ...message.a2a!,
      proposal: {
        ...proposal,
        status: open ? "accepted" : "declined",
        ...(decider ? { decidedBy: decider.memberId } : {}),
        decidedAt: now,
      },
    },
  });
  const conv = await ctx.db.get(proposal.conversationId);
  if (!conv) return true;
  const trigger = await ctx.db.get(proposal.triggerMessageId);
  const moves = open && !!trigger && trigger.deletedAt === undefined && conv.threadRootId === undefined;
  await ctx.db.patch(conv._id, {
    proposalMessageId: undefined,
    updatedAt: now,
    ...(moves ? { threadRootId: trigger._id, ownThread: true } : {}),
  });
  const run = await ctx.db.get(message.a2a!.runId);
  const agent = await ctx.db.get(conv.agentId);
  const member = agent ? await agentMember(ctx, agent._id) : null;
  const peer = agent ? await peerForAgent(ctx, agent._id) : null;
  const channel = conv.channelId ? await ctx.db.get(conv.channelId) : null;
  if (moves && channel && member && run) {
    // Writing moves to the thread with the work.
    const row = await ctx.db
      .query("typing")
      .withIndex("by_member_channel", (q) => q.eq("memberId", member._id).eq("channelId", channel._id))
      .unique();
    if (row?.runId) await ctx.db.patch(row._id, { replyTo: trigger._id });
  }
  if (!agent || !member || !peer?.endpoint || !run) return true;
  const sender =
    decider ??
    (run.driverId ? { memberId: run.driverId, name: (await ctx.db.get(run.driverId))?.name ?? "Uplink Room" } : null);
  if (!sender) return true;
  const where = channel ? channelLabel(channel) : "here";
  const text = open
    ? decider
      ? `Yes, open a thread for this. Your answers go in the thread from now on.`
      : `Nobody answered within ${PROPOSAL_MS / 1000} seconds, so the room opened the thread. Your answers go in the thread from now on.`
    : `No, answer here in ${channel && isDirect(channel) ? "the direct message" : where}.`;
  await sendInConversation(ctx, {
    conv: (await ctx.db.get(conv._id))!,
    agent,
    agentMember: member,
    peer,
    sender,
    text,
    decision: { open, byTimeout: decider === null },
  });
  return true;
}
