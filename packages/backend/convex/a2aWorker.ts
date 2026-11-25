/**
 * The A2A worker's database side (ADR 0012). Its network side is a2aNode.ts, in
 * Convex actions, outside every mutation: mutations only record intent and
 * schedule a step. Each step claims one
 * binding (a lease, so steps on a binding never overlap), rechecks that the
 * agent and its endpoint may still be used, does one piece of network work
 * against the agent's gateway, and commits bounded observations back through
 * internal mutations. Nothing here is in the Room API catalog, so no MCP or
 * HTTP caller can report an A2A run's state.
 *
 * A step does one of:
 *   send       the next message in the outbox (SendStreamingMessage when the
 *              card offers streaming, else SendMessage)
 *   reconcile  a message whose delivery is unknown: look for it in the agent's
 *              tasks by message id before anything is sent again
 *   cancel     CancelTask, when someone stopped the run
 *   follow     SubscribeToTask for a few minutes, or GetTask (polling)
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { accountableStands } from "./lib/actor";
import { a2aTiming, nth } from "./lib/a2a/timing";
import type { Endpoint } from "./lib/a2a/protocol";
import { dialectOf, peerDialects, type Dialect } from "./lib/a2a/dialect";
import { MAX_SAVED_TEXT, PLAIN_REDACTOR, redactor, type Redactor } from "./lib/a2a/redact";
import { credentialBinding, openSecret } from "./lib/a2a/secrets";
import { vDialect } from "./schema";
import { TERMINAL, vObservation } from "./lib/a2a/observe";
import { afterRunNews, decideProposal, freshHistory, mayProposeThread, replyTaskEnded as moveEndedReply, whereOf } from "./lib/a2a/conversations";
import {
  applyObservation,
  agentMaySee,
  agentMember,
  detachBinding,
  endUnknown,
  markContactLost,
  stopAsked,
  type Binding,
} from "./lib/a2a/runs";

// --- Agent Cards ---

export const peerForCheck = internalQuery({
  args: { peerId: v.id("a2aPeers") },
  handler: async (ctx, { peerId }) => ctx.db.get(peerId),
});

export const cardChecked = internalMutation({
  args: {
    peerId: v.id("a2aPeers"),
    generation: v.number(),
    card: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { peerId, generation, card, error }) => {
    const peer = await ctx.db.get(peerId);
    if (!peer || peer.checkGeneration !== generation) return null;
    const now = Date.now();
    if (error || !card) {
      await ctx.db.patch(peerId, {
        status: "failed",
        error: error ?? "The card couldn't be read.",
        checkedAt: now,
      });
      return null;
    }
    const { endpoint, ...rest } = card as {
      endpoint: { url: string; tenant?: string };
    } & Doc<"a2aPeers">["card"] &
      object;
    const same =
      peer.endpoint?.url === endpoint.url &&
      (peer.endpoint?.tenant ?? "") === (endpoint.tenant ?? "");
    const nextCard = rest as NonNullable<Doc<"a2aPeers">["card"]>;
    // A card that now names another version: what the room learned to speak goes (ADR 0018).
    const sameVersion =
      dialectOf(peer.card?.protocolVersion) === dialectOf(nextCard.protocolVersion);
    await ctx.db.patch(peerId, {
      status: "ready",
      error: undefined,
      checkedAt: now,
      endpoint,
      // Runs started against another endpoint are never followed or canceled at this one.
      // Another interface or tenant is another gateway: what was learned about the old one goes.
      ...(same
        ? {}
        : {
            endpointGeneration: peer.endpointGeneration + 1,
            cancel: "unknown" as const,
            listTasks: "unknown" as const,
          }),
      // What a check or a send learned about the version was about the card before; a send or a
      // check still in flight is fenced off by the generation, so it can't bring it back.
      ...(same && sameVersion
        ? {}
        : {
            speaks: undefined,
            connection: undefined,
            dialectGeneration: (peer.dialectGeneration ?? 0) + 1,
          }),
      card: nextCard,
    });
    return null;
  },
});

// --- Steps ---

export type Claim = {
  lease: string;
  work: { kind: "send" | "reconcile"; messageId: string } | { kind: "cancel" } | { kind: "follow" };
  endpoint: Endpoint;
  /** The endpoint and version generations the claim was made on: what a step learns is kept only for them. */
  endpointGeneration: number;
  dialectGeneration: number;
  /** The A2A version to speak (ADR 0018). */
  dialect: Dialect;
  /** The version the agent's card names. */
  declared: Dialect;
  /** True when the room hasn't learned which version the agent answers: a send may try the other once. */
  mayProbe: boolean;
  streaming: boolean;
  listTasks: Doc<"a2aPeers">["listTasks"];
  credential: {
    kind: "bearer" | "header";
    headerName?: string;
    origin: string;
    ciphertext: string;
    iv: string;
  } | null;
  peerId: Id<"a2aPeers">;
  agentName: string;
  taskId?: string;
  /** The task's context, or for a first message, the conversation's (ADR 0024). */
  contextId?: string;
  /** The first message carries the conversation's context, and hasn't gone again without it yet. */
  mayDropContext?: boolean;
  /** The agent's previous task in the conversation, for referenceTaskIds (spec 3.4.3). */
  previousTaskId?: string;
  /** The agent may propose a thread of its own here (ADR 0024): said in the message's metadata. */
  proposals?: boolean;
  /** Files the run already keeps, by part: a task read again doesn't store them twice. */
  fileKeys: string[];
  message?: {
    messageId: string;
    kind: "start" | "reply";
    text: string;
    from: string;
    at: number;
    /** The version it last went out in, if it went out: where to look for it when delivery is unclear. */
    dialect?: Dialect;
    /** What was said in its place since the agent last heard from it, and where (ADR 0024). */
    history?: { author: string; text: string; at: number }[];
    where?: string;
    /** An answer to the agent's thread proposal. */
    decision?: { open: boolean; byTimeout: boolean };
  };
  /** For reconcile: where the last step stopped in the agent's task list, or the task it found. */
  reconcile?: { pageToken: string; pages: number; taskId?: string };
  meta: Binding["meta"];
};

/** Takes the binding for one step, after rechecking that its agent and endpoint may still be used. */
export const claim = internalMutation({
  args: { bindingId: v.id("a2aBindings") },
  handler: async (ctx, { bindingId }): Promise<Claim | null> => {
    const binding = await ctx.db.get(bindingId);
    if (!binding || !binding.following) return null;
    const now = Date.now();
    if (binding.lease && binding.lease.until > now) return null;
    // A stale wake-up: a newer step already moved the next check later.
    if (binding.nextCheckAt > now + 25 && !binding.wakeRequested) return null;
    const run = await ctx.db.get(binding.runId);
    if (!run) {
      await ctx.db.patch(binding._id, { following: false });
      return null;
    }
    const peer = await ctx.db.get(binding.peerId);
    if (!peer) {
      await detachBinding(ctx, binding, "The agent's A2A endpoint was disconnected.");
      return null;
    }
    if (peer.endpointGeneration !== binding.endpointGeneration) {
      await detachBinding(
        ctx,
        binding,
        "The agent's A2A address changed after this run started, so the room stopped following it at the old one.",
      );
      return null;
    }
    const agent = await ctx.db.get(binding.agentId);
    const member = await agentMember(ctx, binding.agentId);
    if (!agent || !member || member.removedAt !== undefined) {
      await detachBinding(ctx, binding, `${agent?.name ?? "The agent"} was removed from the team.`);
      return null;
    }
    const accountable = await ctx.db.get(agent.addedBy);
    if (!(await accountableStands(ctx, accountable))) {
      await detachBinding(ctx, binding, `The person accountable for ${agent.name} left the team or deleted their account.`);
      return null;
    }
    // A run from a direct message or private channel goes only to an agent still in it (ADR 0016):
    // checked before every step, so nothing queued reaches an agent that was taken out since.
    if (!(await agentMaySee(ctx, run, member._id))) {
      await detachBinding(ctx, binding, `${agent.name} isn't in the conversation this run came from any more.`);
      return null;
    }
    if (!peer.endpoint) {
      await ctx.db.patch(binding._id, {
        nextCheckAt: now + nth(a2aTiming().retryMs, binding.failures),
      });
      await ctx.scheduler.runAfter(
        nth(a2aTiming().retryMs, binding.failures),
        internal.a2aNode.step,
        { bindingId },
      );
      return null;
    }

    const versions = peerDialects(peer);
    const terminal = binding.externalState !== undefined && TERMINAL.has(binding.externalState);
    const sending = binding.outbox.find((e) => e.status === "sending");
    const pending = binding.outbox.find((e) => e.status === "pending");
    let work: Claim["work"] | null = null;
    let outbox = binding.outbox;
    if (sending) {
      // A step was sending this and didn't finish: it may have arrived. Ask before sending again.
      work = { kind: "reconcile", messageId: sending.messageId };
    } else if (binding.cancel?.status === "pending" && binding.taskId && !terminal) {
      work = { kind: "cancel" };
    } else if (pending && (pending.kind === "start" || binding.taskId) && !(pending.kind === "reply" && stopAsked(binding))) {
      // After a Stop, the messages that wait aren't sent: they are dropped when the run ends (carryOver).
      work = { kind: "send", messageId: pending.messageId };
      // Kept with the message: if the step dies after sending it, the next one looks for it in this version.
      outbox = binding.outbox.map((e) =>
        e.messageId === pending.messageId
          ? { ...e, status: "sending" as const, dialect: versions.speaks }
          : e,
      );
    } else if (binding.taskId && !terminal) {
      work = { kind: "follow" };
    }
    if (!work) {
      await ctx.db.patch(binding._id, { following: false, lease: undefined });
      return null;
    }
    const lease = crypto.randomUUID();
    await ctx.db.patch(binding._id, {
      lease: { token: lease, until: now + a2aTiming().leaseMs },
      wakeRequested: undefined,
      outbox,
    });
    const stored = await ctx.db
      .query("a2aCredentials")
      .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
      .unique();
    // A token goes only to the origin it was given for (it is also sealed to that origin).
    const credential =
      stored && stored.origin === new URL(peer.endpoint.url).origin ? stored : null;
    const entry =
      "messageId" in work
        ? binding.outbox.find((e) => e.messageId === (work as { messageId: string }).messageId)
        : undefined;
    return {
      lease,
      work,
      endpoint: peer.endpoint,
      endpointGeneration: peer.endpointGeneration,
      dialectGeneration: peer.dialectGeneration ?? 0,
      dialect: versions.speaks,
      declared: versions.declared,
      mayProbe: !versions.learned,
      streaming: (peer.card?.streaming ?? false) && !binding.pollOnly,
      listTasks: peer.listTasks,
      credential: credential
        ? {
            kind: credential.kind,
            ...(credential.headerName ? { headerName: credential.headerName } : {}),
            origin: credential.origin,
            ciphertext: credential.ciphertext,
            iv: credential.iv,
          }
        : null,
      peerId: peer._id,
      agentName: agent.name,
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
      ...(binding.contextId
        ? { contextId: binding.contextId }
        : binding.sentContextId
          ? { contextId: binding.sentContextId, mayDropContext: !binding.contextRetried }
          : {}),
      ...(binding.previousTaskId && !binding.taskId ? { previousTaskId: binding.previousTaskId } : {}),
      ...((await mayProposeThread(ctx, binding)) ? { proposals: true } : {}),
      fileKeys: (binding.files ?? []).map((f) => f.key),
      ...(entry
        ? {
            message: {
              messageId: entry.messageId,
              kind: entry.kind,
              text: entry.text,
              from: entry.from,
              at: entry.at,
              ...(entry.dialect ? { dialect: entry.dialect } : {}),
              ...(entry.history?.length ? { history: entry.history, where: (await whereOf(ctx, binding)) ?? "the conversation" } : {}),
              ...(entry.decision ? { decision: entry.decision } : {}),
            },
          }
        : {}),
      meta: binding.meta,
      ...(work.kind === "reconcile" && binding.reconcile?.messageId === work.messageId
        ? {
            reconcile: {
              pageToken: binding.reconcile.pageToken,
              pages: binding.reconcile.pages,
              ...(binding.reconcile.taskId ? { taskId: binding.reconcile.taskId } : {}),
            },
          }
        : {}),
    };
  },
});

async function held(
  ctx: { db: { get: (id: Id<"a2aBindings">) => Promise<Binding | null> } },
  bindingId: Id<"a2aBindings">,
  lease: string,
) {
  const binding = await ctx.db.get(bindingId);
  if (!binding || binding.lease?.token !== lease) return null;
  return binding;
}

/**
 * Asked right before each send to an agent (a stream, a plain message, and the plain send after a
 * stream was refused): whether this step still holds the binding and its lease is live, the room
 * still follows it, and the agent may still have it: in the team, its person too, and in the
 * direct message or private channel the run came from. What `claim` found can be stale by then,
 * since the agent can be taken out while the step waits on the network (ADR 0016).
 */
export const maySend = internalMutation({
  args: { bindingId: v.id("a2aBindings"), lease: v.string() },
  handler: async (ctx, { bindingId, lease }): Promise<boolean> => {
    const binding = await held(ctx, bindingId, lease);
    if (!binding || !binding.following || !binding.lease || binding.lease.until <= Date.now()) return false;
    const run = await ctx.db.get(binding.runId);
    const agent = await ctx.db.get(binding.agentId);
    const member = await agentMember(ctx, binding.agentId);
    const accountable = agent ? await ctx.db.get(agent.addedBy) : null;
    if (!run || !agent || !member || member.removedAt !== undefined || !(await accountableStands(ctx, accountable))) {
      return false;
    }
    if (!(await agentMaySee(ctx, run, member._id))) {
      await detachBinding(ctx, binding, `${agent.name} isn't in the conversation this run came from any more.`);
      return false;
    }
    return true;
  },
});

/** Where a run's conversation is ("#general", "a direct message"), for the history's heading. */
export const whereOfBinding = internalQuery({
  args: { bindingId: v.id("a2aBindings") },
  handler: async (ctx, { bindingId }): Promise<string | null> => {
    const binding = await ctx.db.get(bindingId);
    return binding ? ((await whereOf(ctx, binding)) ?? null) : null;
  },
});

/** Whether someone asked for a step while this one holds the binding (a reply or a stop). */
export const wakeRequested = internalQuery({
  args: { bindingId: v.id("a2aBindings") },
  handler: async (ctx, { bindingId }) => (await ctx.db.get(bindingId))?.wakeRequested === true,
});

/**
 * The redactor for what the agent reported, opened here, in the mutation that saves it: pieces of
 * a streamed artifact are joined here, so only here can a token sent in pieces be seen whole
 * (ADR 0018). The token is the one a step would send: given for the endpoint's origin. It stays in
 * this mutation's memory and never reaches an argument, a return value or a log.
 */
async function savingRedactor(ctx: MutationCtx, peerId: Id<"a2aPeers">): Promise<Redactor> {
  const peer = await ctx.db.get(peerId);
  if (!peer?.endpoint) return PLAIN_REDACTOR;
  const stored = await ctx.db
    .query("a2aCredentials")
    .withIndex("by_peer", (q) => q.eq("peerId", peerId))
    .unique();
  if (!stored || stored.origin !== new URL(peer.endpoint.url).origin) return PLAIN_REDACTOR;
  try {
    const secret = await openSecret(stored, credentialBinding(peerId, stored.origin));
    return redactor(
      stored.kind === "header"
        ? { kind: "header", name: stored.headerName ?? "x-api-key", secret }
        : { kind: "bearer", secret },
    );
  } catch {
    // The step that called the agent opened the same token; if it can't be opened now, headers and bearer tokens still go.
    return PLAIN_REDACTOR;
  }
}

/** One observation from the worker. "ignored": the step lost its lease or the run isn't followed any more. */
export const observed = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    observation: vObservation,
    deliveredMessageId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<"changed" | "unchanged" | "stale" | "ignored"> => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding || !binding.following) return "ignored";
    const agent = await ctx.db.get(binding.agentId);
    return applyObservation(
      ctx,
      binding,
      args.observation,
      agent?.name ?? "The agent",
      args.deliveredMessageId,
      await savingRedactor(ctx, binding.peerId),
    );
  },
});

/** A send the agent refused outright. A refused first message fails the run; a refused reply doesn't. */
export const sendFailed = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    messageId: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding) return null;
    const entry = binding.outbox.find((e) => e.messageId === args.messageId);
    await ctx.db.patch(binding._id, {
      outbox: binding.outbox.map((e) =>
        e.messageId === args.messageId ? { ...e, status: "failed" as const, error: args.error } : e,
      ),
      lastError: args.error,
    });
    if (entry?.kind === "start") {
      await ctx.db.patch(binding._id, { following: false });
      const run = await ctx.db.get(binding.runId);
      if (run) {
        const now = Date.now();
        await ctx.db.patch(run._id, {
          state: "failed",
          failReason: args.error,
          prompt: undefined,
          stateChangedAt: now,
          endedAt: now,
        });
      }
      await afterRunNews(ctx, binding._id, { kind: "ended", text: args.error, tone: "warn" });
    } else if (entry) {
      await afterRunNews(ctx, binding._id, { kind: "line", text: `It didn't take your message: ${args.error}`, tone: "warn" });
    }
    return null;
  },
});

/**
 * A reply the agent refused because its task had ended (UnsupportedOperationError or
 * TaskNotFoundError, spec 3.1.1): it took nothing, so it goes as a new task in the same context.
 */
export const replyTaskEnded = internalMutation({
  args: { bindingId: v.id("a2aBindings"), lease: v.string(), messageId: v.string() },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding) return null;
    await moveEndedReply(ctx, binding, args.messageId);
    return null;
  },
});

/**
 * The agent refused the first message for the context it carried (ADR 0024, spec 3.4.1: "If an
 * agent cannot accept a client-provided contextId, it MUST reject the request with an error"): the
 * conversation forgets that context, and the message goes once more without it, in this step.
 */
export const contextRefused = internalMutation({
  args: { bindingId: v.id("a2aBindings"), lease: v.string() },
  handler: async (ctx, args): Promise<{ history?: { author: string; text: string; at: number }[] } | null> => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding) return null;
    // The fresh context starts empty: the message carries the place's recent messages again.
    const history = await freshHistory(ctx, binding);
    const [start, ...rest] = binding.outbox;
    await ctx.db.patch(binding._id, {
      sentContextId: undefined,
      contextRetried: true,
      previousTaskId: undefined,
      outbox: [{ ...start!, history }, ...rest],
    });
    if (binding.conversationId) {
      await ctx.db.patch(binding.conversationId, { contextId: undefined, contextGeneration: undefined, contextKept: undefined, lastTaskId: undefined, updatedAt: Date.now() });
    }
    return history?.length ? { history } : {};
  },
});

/** At most this many files an agent sent as bytes are kept for its answer. */
const MAX_FILES = 4;

/**
 * Files the agent sent as bytes (file parts), stored by the step: kept for the answer, which posts
 * them as attachments. Bytes the run can't keep (the step lost its lease, or past MAX_FILES) go.
 */
export const filesReceived = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    files: v.array(
      v.object({
        key: v.string(),
        storageId: v.id("_storage"),
        name: v.string(),
        contentType: v.string(),
        size: v.number(),
        taskId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    const had = new Set((binding?.files ?? []).map((f) => f.key));
    const fresh = args.files.filter((f) => !had.has(f.key));
    const room = binding?.following ? MAX_FILES - (binding.files?.length ?? 0) : 0;
    const keep = fresh.slice(0, Math.max(0, room));
    for (const f of args.files) if (!keep.includes(f)) await ctx.storage.delete(f.storageId);
    if (binding && keep.length) await ctx.db.patch(binding._id, { files: [...(binding.files ?? []), ...keep] });
    return null;
  },
});

/** A thread proposal nobody answered in time: it counts as Yes (ADR 0024). */
export const proposalTimeout = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (message?.a2a?.proposal?.status === "pending") await decideProposal(ctx, message, true, null);
    return null;
  },
});

/** A message that may or may not have arrived, and the agent can't say: never sent again, and the run is Unknown. */
export const unconfirmed = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    messageId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding) return null;
    const entry = binding.outbox.find((e) => e.messageId === args.messageId);
    await ctx.db.patch(binding._id, {
      outbox: binding.outbox.map((e) =>
        e.messageId === args.messageId
          ? { ...e, status: "unconfirmed" as const, error: args.reason }
          : e,
      ),
      lastError: args.reason,
      reconcile: undefined,
    });
    if (entry?.kind === "start") {
      const fresh = (await ctx.db.get(binding._id))!;
      await endUnknown(ctx, fresh, `Delivery not confirmed: ${args.reason}`);
    } else if (entry) {
      await afterRunNews(ctx, binding._id, { kind: "line", text: `It may not have your last message: ${args.reason}`, tone: "warn" });
    }
    return null;
  },
});

/**
 * Where the search for a lost message stopped: the next step reads this ListTasks page. With
 * `taskId`, the search found the message in that task, and later steps only read it whole.
 */
export const reconcileProgress = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    messageId: v.string(),
    pageToken: v.string(),
    pages: v.number(),
    taskId: v.optional(v.string()),
  },
  handler: async (ctx, { bindingId, lease, messageId, pageToken, pages, taskId }) => {
    const binding = await held(ctx, bindingId, lease);
    if (binding)
      await ctx.db.patch(binding._id, {
        reconcile: { messageId, pageToken, pages, ...(taskId ? { taskId } : {}) },
      });
    return null;
  },
});

/** The outcome of a CancelTask call. */
export const cancelResult = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    status: v.union(
      v.literal("sent"),
      v.literal("unsupported"),
      v.literal("not_cancelable"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding?.cancel) return null;
    // A confirmed cancel was already recorded by the observation.
    if (binding.cancel.status === "canceled") return null;
    await ctx.db.patch(binding._id, {
      cancel: {
        ...binding.cancel,
        status: args.status,
        ...(args.error ? { error: args.error } : {}),
      },
    });
    if (args.status === "unsupported")
      await ctx.db.patch(binding.peerId, { cancel: "unsupported" });
    if (args.status === "sent") await ctx.db.patch(binding.peerId, { cancel: "supported" });
    return null;
  },
});

/**
 * The agent answered in the version its card doesn't name (ADR 0018): from now on the room speaks
 * that one to it. Kept only while the endpoint is the one the step called.
 */
export const dialectLearned = internalMutation({
  args: {
    peerId: v.id("a2aPeers"),
    endpointGeneration: v.number(),
    dialectGeneration: v.number(),
    dialect: vDialect,
  },
  handler: async (ctx, { peerId, endpointGeneration, dialectGeneration, dialect }) => {
    const peer = await ctx.db.get(peerId);
    // The address or the card changed since the step began: what it found is about the old one.
    if (
      !peer ||
      peer.endpointGeneration !== endpointGeneration ||
      (peer.dialectGeneration ?? 0) !== dialectGeneration
    ) {
      return null;
    }
    const declared = dialectOf(peer.card?.protocolVersion);
    await ctx.db.patch(peerId, { speaks: dialect === declared ? undefined : dialect });
    return null;
  },
});

/**
 * The version a message is about to go out in, when a send tries the other one (ADR 0018): saved
 * before the call, so if its answer is lost, the message is looked for where it may have arrived.
 */
export const sendingIn = internalMutation({
  args: { bindingId: v.id("a2aBindings"), lease: v.string(), messageId: v.string(), dialect: vDialect },
  handler: async (ctx, { bindingId, lease, messageId, dialect }) => {
    const binding = await held(ctx, bindingId, lease);
    if (!binding) return null;
    await ctx.db.patch(binding._id, {
      outbox: binding.outbox.map((e) => (e.messageId === messageId ? { ...e, dialect } : e)),
    });
    return null;
  },
});

/** The agent's gateway doesn't list tasks (OpenClaw), so a lost send can't be looked up there. */
export const listUnsupported = internalMutation({
  args: { peerId: v.id("a2aPeers") },
  handler: async (ctx, { peerId }) => {
    const peer = await ctx.db.get(peerId);
    if (peer) await ctx.db.patch(peerId, { listTasks: "unsupported" });
    return null;
  },
});

/** Follow by polling from now on (the agent's stream isn't offered or broke). */
export const pollOnly = internalMutation({
  args: { bindingId: v.id("a2aBindings"), lease: v.string() },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (binding) await ctx.db.patch(binding._id, { pollOnly: true });
    return null;
  },
});

/** A failed contact: count it, show Unknown after a few, give up after a long silence. */
export const contactFailed = internalMutation({
  args: {
    bindingId: v.id("a2aBindings"),
    lease: v.string(),
    error: v.string(),
    gone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding || !binding.following) return null;
    const agent = await ctx.db.get(binding.agentId);
    const name = agent?.name ?? "The agent";
    if (args.gone) {
      await endUnknown(
        ctx,
        binding,
        `${name} no longer has this task (it may have expired there). The last state the room saw was ${binding.externalState ?? "none"}.`,
      );
      return null;
    }
    const failures = binding.failures + 1;
    await ctx.db.patch(binding._id, { failures, lastError: args.error });
    const timing = a2aTiming();
    if (Date.now() - binding.lastContactAt > timing.giveUpAfterMs) {
      await endUnknown(
        ctx,
        { ...binding, failures },
        `The room stopped following: no contact with ${name} since ${new Date(binding.lastContactAt).toISOString()}.`,
      );
    } else if (failures >= timing.failuresBeforeUnknown) {
      await markContactLost(ctx, { ...binding, failures }, name);
    }
    return null;
  },
});

/** Ends a step: frees the lease and schedules the next one while the run is followed. */
export const release = internalMutation({
  args: { bindingId: v.id("a2aBindings"), lease: v.string(), soon: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const binding = await held(ctx, args.bindingId, args.lease);
    if (!binding) return null;
    const timing = a2aTiming();
    const now = Date.now();
    if (binding.following && now - binding.lastChangeAt > timing.quietLimitMs) {
      await ctx.db.patch(binding._id, { lease: undefined });
      await endUnknown(ctx, binding, "The room stopped following: nothing changed for a week.");
      return null;
    }
    if (!binding.following) {
      await ctx.db.patch(binding._id, { lease: undefined, wakeRequested: undefined });
      return null;
    }
    const delay =
      args.soon || binding.wakeRequested
        ? 0
        : binding.failures > 0
          ? nth(timing.retryMs, binding.failures - 1)
          : nth(timing.pollMs, binding.quietPolls);
    await ctx.db.patch(binding._id, {
      lease: undefined,
      wakeRequested: undefined,
      nextCheckAt: now + delay,
    });
    await ctx.scheduler.runAfter(delay, internal.a2aNode.step, { bindingId: binding._id });
    return null;
  },
});

/** Restarts followed bindings whose step died (an action that crashed or timed out). Runs from a cron. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("a2aBindings")
      .withIndex("by_following", (q) => q.eq("following", true).lt("nextCheckAt", now - 2 * 60_000))
      .take(100);
    for (const binding of due) {
      if (binding.lease && binding.lease.until > now) continue;
      await ctx.db.patch(binding._id, { lease: undefined, nextCheckAt: now });
      await ctx.scheduler.runAfter(0, internal.a2aNode.step, { bindingId: binding._id });
    }
    return null;
  },
});

// --- Connection checks (a2a.checkConnection) ---

/**
 * What a connection check needs: the endpoint, the versions, and the token, only when it was
 * given for the endpoint's origin (as for a step's claim). Null when the check isn't the current one.
 */
export const peerForConnection = internalQuery({
  args: { peerId: v.id("a2aPeers"), checkId: v.string() },
  handler: async (ctx, { peerId, checkId }) => {
    const peer = await ctx.db.get(peerId);
    if (!peer || peer.connection?.checkId !== checkId || !peer.endpoint) return null;
    const agent = await ctx.db.get(peer.agentId);
    const stored = await ctx.db
      .query("a2aCredentials")
      .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
      .unique();
    const credential =
      stored && stored.origin === new URL(peer.endpoint.url).origin ? stored : null;
    return {
      agentName: agent?.name ?? "The agent",
      endpoint: peer.endpoint,
      endpointGeneration: peer.endpointGeneration,
      dialectGeneration: peer.dialectGeneration ?? 0,
      ...peerDialects(peer),
      needsCredential: peer.card?.needsCredential ?? false,
      credential: credential
        ? {
            kind: credential.kind,
            ...(credential.headerName ? { headerName: credential.headerName } : {}),
            origin: credential.origin,
            ciphertext: credential.ciphertext,
            iv: credential.iv,
          }
        : null,
    };
  },
});

/**
 * A connection check's result. A version that answered other than the card's is what the room
 * speaks from now on. A result for a check that isn't the current one (the address or the card
 * changed since, which clears it, or a newer check started) changes nothing at all.
 */
export const connectionChecked = internalMutation({
  args: {
    peerId: v.id("a2aPeers"),
    checkId: v.string(),
    endpointGeneration: v.number(),
    dialectGeneration: v.number(),
    ok: v.boolean(),
    dialect: v.optional(vDialect),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const peer = await ctx.db.get(args.peerId);
    if (!peer?.connection || peer.connection.checkId !== args.checkId) return null;
    // Still this check, but what it called is no longer what the room calls: say so, learn nothing.
    if (
      peer.endpointGeneration !== args.endpointGeneration ||
      (peer.dialectGeneration ?? 0) !== args.dialectGeneration
    ) {
      const agent = await ctx.db.get(peer.agentId);
      await ctx.db.patch(peer._id, {
        connection: {
          ...peer.connection,
          status: "failed",
          at: Date.now(),
          summary: `${agent?.name ?? "The agent"}'s address or Agent Card changed while the check ran, so its result was dropped. Check the connection again.`,
        },
      });
      return null;
    }
    const declared = dialectOf(peer.card?.protocolVersion);
    await ctx.db.patch(peer._id, {
      connection: {
        ...peer.connection,
        status: args.ok ? "ok" : "failed",
        at: Date.now(),
        ...(args.dialect ? { dialect: args.dialect } : {}),
        summary: args.summary.slice(0, MAX_SAVED_TEXT),
      },
      ...(args.ok && args.dialect
        ? { speaks: args.dialect === declared ? undefined : args.dialect }
        : {}),
    });
    return null;
  },
});
