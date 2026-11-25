/**
 * Runs sent to agents over A2A (ADR 0012): starting one, replying, stopping,
 * detaching, and applying what the worker observed. These are the only places
 * that change an A2A run's state, and only `applyObservation` (called by the
 * worker, never by a Room API function) moves it to what the agent reported.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { actsFor, hasScope, type Actor } from "../actor";
import { roomError } from "../errors";
import { audit, maybeView, memberView } from "../members";
import { canSeeId, memberCanSee, privateTitle, whereLabel } from "../channels";
import { MAX_TEXT, mergeArtifacts, roomStateFor, TERMINAL, type Observation } from "./observe";
import { PLAIN_REDACTOR, type Redactor } from "./redact";
import { afterRunNews, freshHistory, openTaskOf, replyInConversation, withdrawProposal } from "./conversations";

/** Longest text the room sends in one message. */
export const MAX_SEND_TEXT = 16_000;

export type Binding = Doc<"a2aBindings">;

export async function peerForAgent(
  ctx: QueryCtx,
  agentId: Id<"agents">,
): Promise<Doc<"a2aPeers"> | null> {
  return ctx.db
    .query("a2aPeers")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .unique();
}

export async function bindingForRun(ctx: QueryCtx, runId: Id<"runs">): Promise<Binding | null> {
  return ctx.db
    .query("a2aBindings")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

export async function agentMember(
  ctx: QueryCtx,
  agentId: Id<"agents">,
): Promise<Doc<"members"> | null> {
  return ctx.db
    .query("members")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .unique();
}

/** Asks the worker to take a step on this binding now (or right after the step running now). */
export async function wake(ctx: MutationCtx, binding: Binding): Promise<void> {
  const now = Date.now();
  if (binding.lease && binding.lease.until > now) {
    await ctx.db.patch(binding._id, { wakeRequested: true });
    return;
  }
  await ctx.db.patch(binding._id, { nextCheckAt: now });
  await ctx.scheduler.runAfter(0, internal.a2aNode.step, { bindingId: binding._id });
}

export function cleanText(text: string, what: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw roomError("invalid", `${what} needs text.`);
  if (trimmed.length > MAX_SEND_TEXT) {
    throw roomError(
      "invalid",
      `${what} is longer than ${MAX_SEND_TEXT} characters. Put the rest in a file and link it.`,
    );
  }
  return trimmed;
}

/**
 * Whether `actor` may send `agent` work: it is in the team, has an endpoint whose card was read,
 * takes work from this sender, and isn't the sender itself, unless a run the agent drives sends it
 * (`asRun`: the run posts as its driver, ADR 0029 D2). The agent's endpoint, or a refusal.
 */
export async function checkSender(ctx: QueryCtx, actor: Actor, agent: Doc<"agents">, opts: { asRun?: boolean } = {}): Promise<Doc<"a2aPeers">> {
  if (agent.teamId !== actor.teamId) throw roomError("not_found", "No such agent in this team.");
  const member = await agentMember(ctx, agent._id);
  if (!member || member.removedAt !== undefined)
    throw roomError("not_found", `${agent.name} isn't in the team any more.`);
  if (actor.member.agentId === agent._id && !opts.asRun)
    throw roomError("invalid", "An agent can't send work to itself.");
  const peer = await peerForAgent(ctx, agent._id);
  if (!peer) {
    throw roomError(
      "invalid",
      `${agent.name} has no A2A endpoint. Connect one in its settings (a2a.connect).`,
    );
  }
  if (!peer.endpoint) {
    throw roomError(
      "invalid",
      peer.status === "checking"
        ? `${agent.name}'s Agent Card is still being read. Try again in a moment.`
        : `${agent.name}'s Agent Card couldn't be read: ${peer.error ?? "unknown error"}`,
    );
  }
  if (peer.sendWork === "accountable" && !actsFor(actor, agent.addedBy)) {
    const person = await ctx.db.get(agent.addedBy);
    throw roomError(
      "forbidden",
      `${agent.name} takes work only from ${person?.name ?? "the person accountable for it"}.`,
    );
  }
  return peer;
}

export type OutboxEntry = Binding["outbox"][number];

/** A run to open for an agent, already checked: what is sent and where it belongs. */
export type NewRun = {
  teamId: Id<"teams">;
  agent: Doc<"agents">;
  peer: Doc<"a2aPeers">;
  /** Who sends it: the run's driver and starter. */
  by: { memberId: Id<"members">; name: string };
  /** The first message as sent, its last lines saying where it comes from. */
  text: string;
  title: string;
  task?: Doc<"tasks"> | undefined;
  directChannelId?: Id<"channels"> | undefined;
  meta: Omit<Binding["meta"], "runId">;
  conversationId?: Id<"a2aConversations"> | undefined;
  triggerMessageId?: Id<"messages"> | undefined;
  /** The conversation's context, sent with the first message (ADR 0024). */
  contextId?: string | undefined;
  previousTaskId?: string | undefined;
  /** More of the first message: its history, the chat message it is, a proposal's answer. */
  first?: Pick<OutboxEntry, "history" | "chatMessageId" | "decision"> | undefined;
  /** Messages that waited for the agent's last task and go to this one once it has a task. */
  replies?: OutboxEntry[] | undefined;
  /** A task the agent already opened for the first message (it arrived): followed, never sent again. */
  adopted?: { taskId: string; contextId?: string | undefined; messageId: string } | undefined;
};

/** Opens a run and its binding, and asks the worker to send the first message now. */
export async function insertRun(ctx: MutationCtx, r: NewRun): Promise<Id<"runs">> {
  const now = Date.now();
  const runId = await ctx.db.insert("runs", {
    teamId: r.teamId,
    ...(r.task ? { taskId: r.task._id } : {}),
    harness: "a2a",
    agentId: r.agent._id,
    ...(r.directChannelId ? { directChannelId: r.directChannelId } : {}),
    title: r.title,
    driverId: r.by.memberId,
    startedBy: r.by.memberId,
    state: "unknown",
    stateChangedAt: now,
  });
  const bindingId = await ctx.db.insert("a2aBindings", {
    teamId: r.teamId,
    runId,
    peerId: r.peer._id,
    agentId: r.agent._id,
    endpointGeneration: r.peer.endpointGeneration,
    meta: { ...r.meta, runId },
    ...(r.adopted ? { taskId: r.adopted.taskId, ...(r.adopted.contextId ? { contextId: r.adopted.contextId } : {}) } : {}),
    outbox: [
      {
        messageId: r.adopted?.messageId ?? crypto.randomUUID(),
        kind: "start",
        text: r.text,
        from: r.by.name,
        by: r.by.memberId,
        at: now,
        status: r.adopted ? "sent" : "pending",
        ...(r.first?.history?.length ? { history: r.first.history } : {}),
        ...(r.first?.chatMessageId ? { chatMessageId: r.first.chatMessageId } : {}),
        ...(r.first?.decision ? { decision: r.first.decision } : {}),
      },
      ...(r.replies ?? []),
    ],
    version: 0,
    artifacts: [],
    following: true,
    nextCheckAt: now,
    quietPolls: 0,
    failures: 0,
    lastContactAt: now,
    lastChangeAt: now,
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    ...(r.triggerMessageId ? { triggerMessageId: r.triggerMessageId } : {}),
    ...(r.contextId ? { sentContextId: r.contextId } : {}),
    ...(r.previousTaskId ? { previousTaskId: r.previousTaskId } : {}),
  });
  await ctx.scheduler.runAfter(0, internal.a2aNode.step, { bindingId });
  return runId;
}

/**
 * Sends work to an A2A agent as a new run: a task's run (`taskId`), or an unfiled one for a mention
 * outside chat conversations. Refuses when the agent isn't connected, takes work only from its
 * person, or is the sender itself. A run on a task, or one started through the Room API, has a
 * conversation of its own, so a reply after it finishes continues the agent's context (ADR 0024).
 */
export async function startA2ARun(
  ctx: MutationCtx,
  actor: Actor,
  opts: {
    agentId: Id<"agents">;
    prompt: string;
    task?: Doc<"tasks">;
  },
): Promise<Id<"runs">> {
  const { agent, taskChannelId, fromTask } = await checkRecipient(ctx, actor, opts.agentId, opts.task);
  const peer = await checkSender(ctx, actor, agent);
  const prompt = cleanText(opts.prompt, "A run for an agent");
  const team = await ctx.db.get(actor.teamId);
  const title = givenTitle(agent, prompt, opts.task, fromTask);
  const conversationId = await ctx.db.insert("a2aConversations", {
    teamId: actor.teamId,
    agentId: agent._id,
    updatedAt: Date.now(),
  });
  const runId = await insertRun(ctx, {
    teamId: actor.teamId,
    agent,
    peer,
    by: { memberId: actor.member._id, name: actor.member.name },
    text: sentFromRoom(prompt, actor, opts.task),
    title,
    task: opts.task,
    directChannelId: taskChannelId,
    meta: {
      team: team?.name ?? "",
      ...(opts.task ? { taskId: opts.task._id, task: opts.task.title } : {}),
    },
    conversationId,
  });
  await ctx.db.patch(conversationId, { originRunId: runId, openRunId: runId });
  await audit(ctx, actor, "a2a.sent", runId, {
    agentId: agent._id,
    ...(opts.task ? { taskId: opts.task._id } : {}),
  });
  return runId;
}

/**
 * The checks every run sent or given to an agent passes (ADR 0012, ADR 0044): the agent is in the
 * team and wasn't removed, isn't the sender itself, and can see the private channel or direct
 * message a task came from. The agent, its member, and that channel.
 */
export async function checkRecipient(ctx: QueryCtx, actor: Actor, agentId: Id<"agents">, task: Doc<"tasks"> | undefined) {
  const agent = await ctx.db.get(agentId);
  if (!agent || agent.teamId !== actor.teamId)
    throw roomError("not_found", "No such agent in this team.");
  const member = await agentMember(ctx, agent._id);
  if (!member || member.removedAt !== undefined)
    throw roomError("not_found", `${agent.name} isn't in the team any more.`);
  if (actor.member.agentId === agent._id)
    throw roomError("invalid", "An agent can't send work to itself.");
  // A task from a direct message or private channel is listed for the team, but only that
  // channel's members see its texts (ADR 0015, ADR 0016), so the run's title doesn't quote it.
  const taskChannelId = task?.directChannelId;
  const fromTask = taskChannelId ? await ctx.db.get(taskChannelId) : null;
  if (taskChannelId && !(fromTask && (await memberCanSee(ctx, fromTask, member._id)))) {
    // The agent would read the task, so it must be one of the channel's members.
    throw roomError("invalid", `${agent.name} isn't in ${fromTask ? whereLabel(fromTask) : "the channel this task came from"}, so it can't take this task's work.`);
  }
  return { agent, member, taskChannelId, fromTask };
}

/** A sent or given run's title: where a private task came from, else the task's title or the prompt's first line. */
export function givenTitle(agent: Doc<"agents">, prompt: string, task: Doc<"tasks"> | undefined, fromTask: Doc<"channels"> | null): string {
  return task?.directChannelId
    ? privateTitle(fromTask, "run")
    : (task?.title ?? (prompt.split("\n")[0]!.slice(0, 80) || `${agent.name} run`));
}

/** The first message of a run for an agent, its last lines saying who sent it from the room and for which task. */
export function sentFromRoom(prompt: string, actor: Actor, task: Doc<"tasks"> | undefined): string {
  const where = task ? ` for the task "${task.title}"` : "";
  return `${prompt}\n\n---\nSent from Uplink Room by ${actor.member.name}${where}.`;
}

/** Whether `actor` may steer this run: its driver or starter, the task's owner, or an admin. */
export async function canSteer(ctx: QueryCtx, actor: Actor, run: Doc<"runs">): Promise<boolean> {
  if (actor.role === "admin") return true;
  if (run.driverId && actsFor(actor, run.driverId)) return true;
  if (run.startedBy && actsFor(actor, run.startedBy)) return true;
  const task = run.taskId ? await ctx.db.get(run.taskId) : null;
  return !!task && actsFor(actor, task.ownerId);
}

function isFinal(state: Doc<"runs">["state"]): boolean {
  return state === "done" || state === "failed" || state === "stopped";
}

async function setState(
  ctx: MutationCtx,
  run: Doc<"runs">,
  next: Pick<Doc<"runs">, "state" | "prompt" | "failReason" | "stoppedBy">,
): Promise<void> {
  const samePrompt = JSON.stringify(run.prompt ?? null) === JSON.stringify(next.prompt ?? null);
  const same = run.state === next.state && samePrompt && run.failReason === next.failReason;
  if (same) return;
  const now = Date.now();
  await ctx.db.patch(run._id, {
    state: next.state,
    prompt: next.prompt,
    failReason: next.failReason,
    stoppedBy: next.state === "stopped" ? next.stoppedBy : undefined,
    // A new question while already Waiting is news too: it is what notifies and un-settles.
    ...(run.state !== next.state || (next.state === "waiting" && !samePrompt)
      ? { stateChangedAt: now }
      : {}),
    endedAt: isFinal(next.state) ? (run.endedAt ?? now) : undefined,
  });
}

/**
 * A reply on an A2A run (runs.reply, the run panel). While the agent's task is open it goes to that
 * task; after the task finished it continues the conversation, as a new task in the agent's same
 * context and a new run. On a run from chat it is a chat message in that place (ADR 0024). Returns
 * the run the reply went to.
 */
export async function replyToRun(
  ctx: MutationCtx,
  actor: Actor,
  run: Doc<"runs">,
  text: string,
): Promise<Id<"runs">> {
  const binding = await bindingForRun(ctx, run._id);
  if (!binding) throw roomError("invalid", "Only a run sent to an agent over A2A takes replies.");
  if (!(await canSteer(ctx, actor, run))) {
    throw roomError(
      "forbidden",
      "Only the run's driver, whoever started it, the task's owner or an admin can reply.",
    );
  }
  const recipient = run.agentId ? await agentMember(ctx, run.agentId) : null;
  if (!recipient || !(await agentMaySee(ctx, run, recipient._id))) {
    throw roomError("conflict", "The agent isn't in the conversation this run came from any more, so it can't be sent more of it.");
  }
  const body = cleanText(text, "A reply");
  const runId = await replyInConversation(ctx, actor, run, binding, recipient, body);
  await audit(ctx, actor, "a2a.replied", runId);
  return runId;
}

/** Whether the agent's task on this binding is still open: followed, and not in a terminal state. */
export function isOpen(binding: Binding): boolean {
  return binding.following && !(binding.externalState && TERMINAL.has(binding.externalState));
}

/**
 * Someone asked to stop the run: nothing new starts from it, neither a thread proposal nor the
 * messages that waited for it (ADR 0024). That holds when the task ended some other way first, or
 * the agent refused (not_cancelable): the person asked for it to stop.
 */
export function stopAsked(binding: Binding): boolean {
  const status = binding.cancel?.status;
  return status === "pending" || status === "sent" || status === "canceled" || status === "not_cancelable";
}

/**
 * Queues a reply on an open run's task. Refused before the agent has a task, and while the last
 * message is still on its way (runs.reply, from the run panel, sends one at a time).
 */
export async function queueReply(ctx: MutationCtx, actor: Actor, binding: Binding, body: string): Promise<void> {
  if (!binding.taskId) {
    throw roomError(
      "conflict",
      "The agent hasn't started a task for this run yet, so there is nothing to reply to. Wait for it.",
    );
  }
  if (binding.outbox.some((e) => e.status === "pending" || e.status === "sending")) {
    throw roomError("conflict", "The last message is still on its way. Wait for it to arrive.");
  }
  await appendToOutbox(ctx, binding, {
    messageId: crypto.randomUUID(),
    kind: "reply",
    text: body,
    from: actor.member.name,
    by: actor.member._id,
    at: Date.now(),
    status: "pending",
  });
}

/**
 * Adds a message to a run's outbox and wakes the worker. Keeps the first message (it holds the
 * run's delivery) and the last 20 replies, and drops the history of messages already sent.
 */
export async function appendToOutbox(ctx: MutationCtx, binding: Binding, entry: OutboxEntry): Promise<void> {
  const [start, ...replies] = binding.outbox.map((e) =>
    e.history && e.status !== "pending" && e.status !== "sending" ? { ...e, history: undefined } : e,
  );
  const outbox = [start!, ...replies.slice(-19), entry];
  await ctx.db.patch(binding._id, { outbox });
  await wake(ctx, { ...binding, outbox });
}

/**
 * Stops an A2A run: asks the agent to cancel its task. The run shows Stopped
 * only once the agent reports the task Canceled (ADR 0012). Before anything
 * was sent, it just doesn't send.
 */
export async function stopA2ARun(
  ctx: MutationCtx,
  actor: Actor,
  run: Doc<"runs">,
  binding: Binding,
): Promise<"stopped" | "cancel_requested"> {
  if (!binding.following || isFinal(run.state)) {
    throw roomError(
      "conflict",
      isFinal(run.state) ? "This run is already finished." : "The room no longer follows this run.",
    );
  }
  await withdrawProposal(ctx, binding, `No thread opened: ${actor.member.name} stopped the run.`);
  const start = binding.outbox[0];
  if (!binding.taskId && start?.status === "pending") {
    await ctx.db.patch(binding._id, {
      outbox: binding.outbox.map((e, i) =>
        i === 0 ? { ...e, status: "failed" as const, error: "Stopped before it was sent." } : e,
      ),
      following: false,
      cancel: { requestedAt: Date.now(), by: actor.member._id, status: "canceled" },
    });
    await setState(ctx, run, { state: "stopped", stoppedBy: "room" });
    await afterRunNews(ctx, binding._id, { kind: "ended", text: `${actor.member.name} stopped it before it was sent.`, tone: "info" });
    await audit(ctx, actor, "run.stopped", run._id);
    return "stopped";
  }
  const peer = await ctx.db.get(binding.peerId);
  const agent = await ctx.db.get(binding.agentId);
  if (peer?.cancel === "unsupported") {
    throw roomError(
      "conflict",
      `${agent?.name ?? "This agent"} can't be stopped from the room: its gateway doesn't take cancel requests. Stop following the run (runs.detach), or stop it at the gateway.`,
    );
  }
  if (binding.cancel?.status === "pending" || binding.cancel?.status === "sent")
    return "cancel_requested";
  const updated = {
    ...binding,
    cancel: { requestedAt: Date.now(), by: actor.member._id, status: "pending" as const },
  };
  await ctx.db.patch(binding._id, { cancel: updated.cancel });
  await wake(ctx, updated);
  await audit(ctx, actor, "run.stop_requested", run._id);
  return "cancel_requested";
}

/**
 * Stops following an A2A run. The agent may still be working on it; the run
 * shows Unknown, with why, rather than an invented Stopped or Done.
 */
export async function detachBinding(
  ctx: MutationCtx,
  binding: Binding,
  reason: string,
  by?: Id<"members">,
): Promise<void> {
  if (!binding.following) return;
  await ctx.db.patch(binding._id, {
    following: false,
    detached: { at: Date.now(), ...(by ? { by } : {}), reason },
    lease: undefined,
    wakeRequested: undefined,
  });
  await withdrawProposal(ctx, binding, "No thread opened: the room stopped following the run.");
  const run = await ctx.db.get(binding.runId);
  if (run && !isFinal(run.state)) {
    await setState(ctx, run, {
      state: "unknown",
      failReason: `${reason} The agent may still be running.`,
    });
  }
  await afterRunNews(ctx, binding._id, { kind: "ended", text: `${reason} It may still be working on it.`, tone: "warn" });
}

/** Ends following without a terminal state from the agent: the run shows Unknown, with why. */
export async function endUnknown(
  ctx: MutationCtx,
  binding: Binding,
  reason: string,
): Promise<void> {
  await ctx.db.patch(binding._id, { following: false });
  await withdrawProposal(ctx, binding, "No thread opened: the room stopped following the run.");
  const run = await ctx.db.get(binding.runId);
  if (run && !isFinal(run.state))
    await setState(ctx, run, { state: "unknown", failReason: reason });
  await afterRunNews(ctx, binding._id, { kind: "ended", text: reason, tone: "warn" });
}

/** Marks the run Unknown while contact is lost, keeping the last observed A2A state. */
export async function markContactLost(
  ctx: MutationCtx,
  binding: Binding,
  agentName: string,
): Promise<void> {
  const run = await ctx.db.get(binding.runId);
  if (run && !isFinal(run.state)) {
    await setState(ctx, run, {
      state: "unknown",
      failReason: `Lost contact with ${agentName}. The room keeps trying; the last state it saw was ${binding.externalState ?? "none"}.`,
    });
  }
}

/**
 * A rejection that is about the context the room sent, not the work: Hermes refuses a context past
 * its turn limit ("Anti-loop protection: context … exceeded 5 turns. Start a new context …",
 * plugins/platforms/a2a/adapter.py), and other agents refuse one they no longer know (ADR 0024).
 */
export function refusesContext(text: string | undefined): boolean {
  return !!text && /\bcontext\b/i.test(text) && /\b(turns?|exceeded|expired|limit|unknown|not found|invalid)\b/i.test(text);
}

/** Whether a message to an agent came from a person: not an agent, and not a run posting as itself. */
async function fromPerson(ctx: QueryCtx, entry: Binding["outbox"][number] | undefined): Promise<boolean> {
  if (!entry) return false;
  const by = await ctx.db.get(entry.by);
  if (!by || by.kind !== "person") return false;
  const message = entry.chatMessageId ? await ctx.db.get(entry.chatMessageId) : null;
  return !message?.asRun;
}

/**
 * Applies one observation from the worker (the run's only reporter). Refuses a
 * report about another task or conversation, a state older than the one kept,
 * and anything after the task ended. `r` cleans what the agent wrote right before
 * it is saved, after artifact pieces are joined (redact.ts, ADR 0018). What the
 * agent said is then posted in chat, where the run has a place (ADR 0024).
 */
export async function applyObservation(
  ctx: MutationCtx,
  binding: Binding,
  obs: Observation,
  agentName: string,
  deliveredMessageId?: string,
  r: Redactor = PLAIN_REDACTOR,
): Promise<"changed" | "unchanged" | "stale"> {
  // What the agent said, as it will be kept: cleaned, then cut.
  const said = obs.message !== undefined ? r.cut(obs.message, MAX_TEXT).text : undefined;
  if (binding.externalState && TERMINAL.has(binding.externalState)) return "stale";
  if (obs.taskId && binding.taskId && obs.taskId !== binding.taskId) {
    // The agent answered a message with a task of its own instead of on the task it was sent to
    // (Hermes opens a task for every message): that task is the conversation's next run (ADR 0024).
    if (deliveredMessageId && binding.conversationId && (!obs.contextId || !binding.contextId || obs.contextId === binding.contextId)) {
      return adoptTask(ctx, binding, obs, deliveredMessageId, agentName, r);
    }
    return "stale";
  }
  if (obs.contextId && binding.contextId && obs.contextId !== binding.contextId) return "stale";
  const run = await ctx.db.get(binding.runId);
  if (!run) return "stale";
  const now = Date.now();
  const news = async () => afterRunNews(ctx, binding._id, { kind: "observed", before: binding, obs, said });

  // The agent rejected the first task at once over the context it was sent, not the work: the
  // message goes once more without it, so the agent starts a fresh context, and the history sent
  // with it carries the conversation (ADR 0024). The rejected task did no work; it isn't followed.
  // Only for a person's message: Hermes's turn limit is the one loop guard between agents, since
  // the room sets none (ADR 0026, ADR 0029 D18), so an agent's or a run's message stays refused.
  if (
    obs.kind === "task" &&
    obs.state === "TASK_STATE_REJECTED" &&
    binding.sentContextId !== undefined &&
    !binding.contextRetried &&
    (binding.externalState === undefined || binding.externalState === "TASK_STATE_SUBMITTED") &&
    refusesContext(said) &&
    (await fromPerson(ctx, binding.outbox[0]))
  ) {
    const [start, ...rest] = binding.outbox;
    // The fresh context starts empty: the message carries the place's recent messages again.
    const history = await freshHistory(ctx, binding);
    await ctx.db.patch(binding._id, {
      observedAt: now,
      lastContactAt: now,
      failures: 0,
      version: binding.version + 1,
      taskId: undefined,
      contextId: undefined,
      externalState: undefined,
      statusAt: undefined,
      lastMessage: undefined,
      artifacts: [],
      reconcile: undefined,
      sentContextId: undefined,
      contextRetried: true,
      outbox: [
        { ...start!, messageId: crypto.randomUUID(), status: "pending" as const, error: undefined, dialect: undefined, history },
        ...rest,
      ],
      // The step that holds the lease schedules the next one at once (release).
      wakeRequested: true,
      lastChangeAt: now,
    });
    if (binding.conversationId) {
      await ctx.db.patch(binding.conversationId, { contextId: undefined, contextGeneration: undefined, contextKept: undefined, lastTaskId: undefined, updatedAt: now });
    }
    return "changed";
  }

  const patch: Partial<Binding> = {
    observedAt: now,
    lastContactAt: now,
    failures: 0,
    lastError: undefined,
    version: binding.version + 1,
  };
  if (deliveredMessageId) {
    patch.reconcile = undefined;
    patch.outbox = binding.outbox.map((e) =>
      e.messageId === deliveredMessageId ? { ...e, status: "sent" as const, error: undefined, history: undefined } : e,
    );
  }
  if (!binding.contextId && obs.contextId) patch.contextId = obs.contextId;

  // A direct Message: the agent answered without a task, so the run is done.
  if (obs.kind === "message" && !binding.taskId) {
    await ctx.db.patch(binding._id, {
      ...patch,
      ...(said ? { lastMessage: said } : {}),
      following: false,
      lastChangeAt: now,
    });
    await setState(ctx, run, { state: "done" });
    await news();
    return "changed";
  }
  if (obs.kind === "message") {
    if (said) patch.lastMessage = said;
    await ctx.db.patch(binding._id, { ...patch, lastChangeAt: now });
    await news();
    return "changed";
  }
  if (!binding.taskId && obs.taskId) patch.taskId = obs.taskId;

  const stale =
    obs.state !== undefined &&
    obs.statusAt !== undefined &&
    binding.statusAt !== undefined &&
    obs.statusAt < binding.statusAt;
  const state = stale ? undefined : obs.state;
  let changed = false;
  if (state !== undefined && state !== binding.externalState) {
    patch.externalState = state;
    changed = true;
  }
  if (!stale && obs.statusAt !== undefined) patch.statusAt = obs.statusAt;
  // A status message belongs to its status: a new status without one clears it. An
  // artifact-only event (no state) leaves it.
  const message = state !== undefined ? said : binding.lastMessage;
  if (state !== undefined && message !== binding.lastMessage) {
    patch.lastMessage = message;
    changed = true;
  }
  // A whole-task snapshot is the truth about its artifacts, even when it has none.
  if (obs.artifacts && (obs.artifacts.length || obs.snapshot)) {
    const merged = mergeArtifacts(binding.artifacts, obs.artifacts, obs.snapshot === true, r);
    if (JSON.stringify(merged) !== JSON.stringify(binding.artifacts)) {
      patch.artifacts = merged;
      changed = true;
    }
  }
  patch.quietPolls = changed ? 0 : binding.quietPolls + 1;
  if (changed) patch.lastChangeAt = now;

  const current = state ?? binding.externalState;
  if (current && TERMINAL.has(current)) {
    patch.following = false;
    if (
      binding.cancel &&
      (binding.cancel.status === "pending" || binding.cancel.status === "sent")
    ) {
      patch.cancel = {
        ...binding.cancel,
        status: current === "TASK_STATE_CANCELED" ? "canceled" : "not_cancelable",
      };
    }
  }
  await ctx.db.patch(binding._id, patch);

  if (current) {
    const mapped = roomStateFor(current, agentName, message || undefined);
    const stoppedBy = binding.cancel ? "room" : "agent";
    await setState(ctx, run, { ...mapped, ...(mapped.state === "stopped" ? { stoppedBy } : {}) });
  }
  const result = stale ? "stale" : changed || (!!obs.taskId && !binding.taskId) ? "changed" : "unchanged";
  if (result === "changed" || obs.proposal) await news();
  return result;
}

/**
 * A message the agent took into a new task of its own: it leaves this run's outbox (it arrived),
 * and a new run in the same conversation follows that task. Nothing is sent again. The files that
 * task sent as bytes go with it, so its answer is posted with them.
 */
async function adoptTask(
  ctx: MutationCtx,
  binding: Binding,
  obs: Observation,
  messageId: string,
  agentName: string,
  r: Redactor,
): Promise<"changed" | "stale"> {
  const entry = binding.outbox.find((e) => e.messageId === messageId);
  const agent = await ctx.db.get(binding.agentId);
  const peer = await ctx.db.get(binding.peerId);
  const run = await ctx.db.get(binding.runId);
  if (!entry || entry.kind !== "reply" || !agent || !peer || !run || !obs.taskId) return "stale";
  const moving = (binding.files ?? []).filter((f) => f.taskId === obs.taskId);
  const staying = (binding.files ?? []).filter((f) => f.taskId !== obs.taskId);
  await ctx.db.patch(binding._id, {
    outbox: binding.outbox.filter((e) => e.messageId !== messageId),
    reconcile: undefined,
    ...(moving.length ? { files: staying.length ? staying : undefined } : {}),
  });
  const { runId: _old, ...meta } = binding.meta;
  const runId = await insertRun(ctx, {
    teamId: binding.teamId,
    agent,
    peer,
    by: { memberId: entry.by, name: entry.from },
    text: entry.text,
    title: run.title ?? `${agentName} run`,
    task: await openTaskOf(ctx, run),
    directChannelId: run.directChannelId,
    meta,
    conversationId: binding.conversationId,
    triggerMessageId: entry.chatMessageId ?? binding.triggerMessageId,
    // The message went in the task's context: kept as the context sent, so a task rejected over it
    // (Hermes's turn limit) goes once more in a fresh one, as a first message does.
    contextId: binding.contextId,
    previousTaskId: binding.taskId,
    first: entry.chatMessageId ? { chatMessageId: entry.chatMessageId } : undefined,
    adopted: { taskId: obs.taskId, contextId: obs.contextId ?? binding.contextId, messageId },
  });
  if (binding.conversationId) await ctx.db.patch(binding.conversationId, { openRunId: runId, updatedAt: Date.now() });
  if (entry.chatMessageId) {
    const m = await ctx.db.get(entry.chatMessageId);
    const swap = (ids: Id<"runs">[] | undefined) => [...(ids ?? []).filter((id) => id !== binding.runId), runId];
    if (m) await ctx.db.patch(m._id, { mentionedRuns: swap(m.mentionedRuns), a2aRuns: swap(m.a2aRuns) });
  }
  const adopted = await bindingForRun(ctx, runId);
  if (adopted && moving.length) await ctx.db.patch(adopted._id, { files: moving });
  if (adopted) await applyObservation(ctx, (await ctx.db.get(adopted._id))!, obs, agentName, undefined, r);
  return "changed";
}

/** The A2A side of a run, for runView. */
/**
 * `hidden`: the viewer isn't in the direct message the run came from, so what was sent and what the
 * agent answered are left out (ADR 0015).
 */
export async function a2aView(ctx: QueryCtx, run: Doc<"runs">, hidden = false) {
  if (!run.agentId) return undefined;
  const binding = await bindingForRun(ctx, run._id);
  const agent = await ctx.db.get(run.agentId);
  const member = await agentMember(ctx, run.agentId);
  const peer = binding ? await ctx.db.get(binding.peerId) : null;
  if (!binding) return undefined;
  const start = binding.outbox.find((e) => e.kind === "start");
  const conv = binding.conversationId ? await ctx.db.get(binding.conversationId) : null;
  const reachable = !!peer?.endpoint && !!member && member.removedAt === undefined && peer.endpointGeneration === binding.endpointGeneration;
  return {
    agent: { agentId: run.agentId, memberId: member?._id, name: agent?.name ?? "Former agent" },
    connected: !!peer,
    canCancel: peer?.cancel ?? ("unknown" as const),
    externalState: binding.externalState,
    statusAt: binding.statusAt,
    observedAt: binding.observedAt,
    contextId: binding.contextId,
    taskId: binding.taskId,
    /**
     * The agent conversation this run is part of (ADR 0024): the task panel draws a task's runs that
     * share one as one chat. Absent on runs from before conversations.
     */
    conversationId: binding.conversationId,
    following: binding.following,
    delivery: start?.status,
    lastMessage: hidden ? undefined : binding.lastMessage,
    artifacts: hidden ? [] : binding.artifacts,
    lastError: hidden ? undefined : binding.lastError,
    lastContactAt: binding.lastContactAt,
    /**
     * Where a reply goes (runs.reply, ADR 0024): "task", the agent's open task; "conversation", a new
     * task in the same context once this one finished; "none", nowhere now (the agent has no task
     * yet, or it was disconnected or removed).
     */
    replies: (!reachable
      ? "none"
      : isOpen(binding)
        ? binding.taskId
          ? "task"
          : "none"
        : "conversation") as "task" | "conversation" | "none",
    /** The chat place the run's conversation is in, for a link back to it. Left out for viewers outside it. */
    place:
      conv?.channelId && !hidden
        ? { channelId: conv.channelId, ...(conv.threadRootId ? { threadRootId: conv.threadRootId } : {}), ...(binding.triggerMessageId ? { messageId: binding.triggerMessageId } : {}) }
        : undefined,
    cancel: binding.cancel
      ? {
          status: binding.cancel.status,
          requestedAt: binding.cancel.requestedAt,
          by: await memberView(ctx, binding.cancel.by),
          error: hidden ? undefined : binding.cancel.error,
        }
      : undefined,
    detached: binding.detached
      ? {
          at: binding.detached.at,
          reason: hidden ? "" : binding.detached.reason,
          by: await maybeView(ctx, binding.detached.by),
        }
      : undefined,
    messages: await Promise.all(
      binding.outbox.slice(-10).map(async (e) => ({
        kind: e.kind,
        text: hidden ? "" : e.text,
        at: e.at,
        status: e.status,
        error: hidden ? undefined : e.error,
        by: await memberView(ctx, e.by),
      })),
    ),
  };
}

/** Whether an agent actor may set off A2A work (a mention): it needs the runs.start scope. */
/**
 * Whether checkSender would let the actor send this agent work over A2A: its card has an endpoint,
 * and it takes work from the team or the actor acts for its person. True for an agent the room
 * doesn't reach over A2A, which takes work from anyone on the team (ADR 0044).
 */
export async function takesWorkFrom(ctx: QueryCtx, actor: Actor, agent: Doc<"agents">): Promise<boolean> {
  // An agent can't send work to itself (checkSender, runs.start).
  if (actor.member.agentId === agent._id) return false;
  const peer = await peerForAgent(ctx, agent._id);
  if (!peer) return true;
  if (!peer.endpoint) return false;
  return !(peer.sendWork === "accountable" && !actsFor(actor, agent.addedBy));
}

export function maySendWork(actor: Actor): boolean {
  return hasScope(actor, "runs.start");
}

/** Whether the agent a run was sent to can still see the direct message or private channel it came from. */
export async function agentMaySee(ctx: QueryCtx, run: Doc<"runs">, agentMemberId: Id<"members">): Promise<boolean> {
  if (!run.directChannelId) return true;
  const channel = await ctx.db.get(run.directChannelId);
  return !!channel && (await memberCanSee(ctx, channel, agentMemberId));
}

/**
 * An agent left a private channel or was removed from it (ADR 0016): its runs from there stop at
 * once. Each is detached, so nothing queued is sent and no reply is taken; the run shows Unknown,
 * as the agent may still be working on what it already had.
 */
export async function detachChannelRuns(ctx: MutationCtx, channelId: Id<"channels">, agent: Doc<"members">, by: Id<"members">) {
  if (!agent.agentId) return;
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_agent", (q) => q.eq("agentId", agent.agentId))
    .collect();
  for (const run of runs) {
    if (run.directChannelId !== channelId) continue;
    const binding = await bindingForRun(ctx, run._id);
    if (binding) await detachBinding(ctx, binding, `${agent.name} was taken out of the conversation this run came from.`, by);
  }
}

/** Whether the viewer can't see the direct message or private channel a run came from (ADR 0015, ADR 0016). */
export async function runIsHidden(ctx: QueryCtx, run: Doc<"runs">, viewer: Actor | undefined): Promise<boolean> {
  if (!run.directChannelId) return false;
  if (!viewer) return true;
  return !(await canSeeId(ctx, viewer, run.directChannelId));
}
