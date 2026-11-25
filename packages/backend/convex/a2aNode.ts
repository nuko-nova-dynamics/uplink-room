"use node";
/**
 * The A2A worker's network side (ADR 0012), in Convex's Node.js runtime so that
 * every request goes through guardedFetch: each connection's address is
 * checked as it opens. Mutations only record intent and schedule a step here;
 * a step claims its binding (a2aWorker.claim), does one piece of network work,
 * and commits bounded observations back through internal mutations.
 *
 * A step does one of:
 *   send       the next message in the outbox (SendStreamingMessage when the
 *              card offers streaming, else SendMessage)
 *   reconcile  a message whose delivery is unknown: look for it in the agent's
 *              tasks by message id before anything is sent again
 *   cancel     CancelTask, when someone stopped the run
 *   follow     SubscribeToTask for a few minutes, or GetTask (polling)
 *
 * Each speaks the A2A version the claim names (ADR 0018): 1.0, or 0.3 for an
 * agent that only answers it, with 0.3's method names (message/send, …).
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Claim } from "./a2aWorker";
import { guardedFetch } from "./lib/a2a/guardedFetch";
import { a2aTiming } from "./lib/a2a/timing";
import {
  A2ACallError,
  call as rawCall,
  fetchCard,
  RPC,
  stream as rawStream,
  type Credential,
  type Endpoint,
} from "./lib/a2a/protocol";
import {
  historyText,
  methodFor,
  otherDialect,
  outgoingMessage,
  sendParams,
  type Dialect,
  type Op,
} from "./lib/a2a/dialect";
import {
  credentialRefused,
  wrongVersion,
  neitherAnswered,
  notAnswered,
  otherRefused,
  versionRefused,
  type Attempt,
  tokenRefused,
} from "./lib/a2a/explain";
import { checkConnection as probeConnection } from "./lib/a2a/connection";

/** Message metadata keys of the room's chat conventions (ADR 0024). */
const CAPABILITIES = "uplink.room/capabilities";
const PROPOSE_CAPABILITY = "propose-thread";
const THREAD_DECISION = "uplink.room/thread-decision";
import { redact, redactor, type Redactor } from "./lib/a2a/redact";
import {
  coalesceArtifacts,
  fromSendResult,
  fromStreamResult,
  fromTask,
  TERMINAL,
  type Observation,
} from "./lib/a2a/observe";
import { credentialBinding, openSecret } from "./lib/a2a/secrets";

const call = (
  endpoint: Endpoint,
  credential: Credential | null,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  dialect: Dialect,
) => rawCall(guardedFetch, endpoint, credential, method, params, timeoutMs, dialect);

const stream = (
  endpoint: Endpoint,
  credential: Credential | null,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  connectTimeoutMs: number,
  dialect: Dialect,
) =>
  rawStream(guardedFetch, endpoint, credential, method, params, signal, connectTimeoutMs, dialect);

/** The method for `op` in `dialect`. A version without one (0.3 can't list tasks) answers as an agent would. */
function methodOf(dialect: Dialect, op: Op): string {
  const method = methodFor(dialect, op);
  if (!method) {
    throw new A2ACallError(`A2A ${dialect} has no method for this.`, {
      kind: "rpc",
      code: RPC.methodNotFound,
      ambiguous: false,
    });
  }
  return method;
}

/** Pages of ListTasks read while looking for a lost message, one per step. */
const MAX_LIST_PAGES = 5;

/**
 * A call within the step's time budget, so a step never runs into Convex's
 * 10-minute action limit. Out of time, it throws `outOfTime`: the step saves
 * nothing new and the next one goes on.
 */
async function callIn(
  step: Step,
  op: Op,
  params: Record<string, unknown>,
  timeoutMs: number,
  dialect: Dialect = step.dialect,
): Promise<unknown> {
  const method = methodOf(dialect, op);
  const left = step.startedAt + a2aTiming().stepBudgetMs - Date.now();
  if (left < 1_000) {
    throw Object.assign(
      new A2ACallError("This step ran out of time; the next one goes on.", {
        kind: "network",
        ambiguous: true,
      }),
      { outOfTime: true },
    );
  }
  return call(
    step.claim.endpoint,
    step.credential,
    method,
    params,
    Math.min(timeoutMs, left),
    dialect,
  );
}

function outOfTime(error: unknown): boolean {
  return (error as { outOfTime?: boolean } | null)?.outOfTime === true;
}

export const checkCard = internalAction({
  args: { peerId: v.id("a2aPeers"), generation: v.number() },
  handler: async (ctx, { peerId, generation }): Promise<null> => {
    const peer = await ctx.runQuery(internal.a2aWorker.peerForCheck, { peerId });
    if (!peer || peer.checkGeneration !== generation) return null;
    try {
      const card = await fetchCard(guardedFetch, peer.cardUrl, a2aTiming().cardTimeoutMs);
      await ctx.runMutation(internal.a2aWorker.cardChecked, { peerId, generation, card });
    } catch (error) {
      await ctx.runMutation(internal.a2aWorker.cardChecked, {
        peerId,
        generation,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
    return null;
  },
});

function credentialFor(claim: Claim, secret: string): Credential {
  return claim.credential?.kind === "header"
    ? { kind: "header", name: claim.credential.headerName ?? "x-api-key", secret }
    : { kind: "bearer", secret };
}

/**
 * The message as sent. History, when there is any, is a second text part, and is in the metadata
 * too (ADR 0024); so is what the room offers the agent (`uplink.room/capabilities`) and an answer
 * to its thread proposal (`uplink.room/thread-decision`).
 */
function outgoing(step: Step, dialect: Dialect) {
  const claim = step.claim;
  const m = claim.message!;
  return outgoingMessage(dialect, {
    messageId: m.messageId,
    text: m.text,
    ...(m.history?.length ? { more: [historyText(m.where ?? "the conversation", m.history)] } : {}),
    ...(m.kind === "reply" && claim.taskId ? { taskId: claim.taskId } : {}),
    ...(step.contextId ? { contextId: step.contextId } : {}),
    ...(m.kind === "start" && claim.previousTaskId && step.contextId ? { referenceTaskIds: [claim.previousTaskId] } : {}),
    metadata: {
      uplinkRoom: { ...claim.meta, from: m.from, ...(m.history?.length ? { history: m.history } : {}) },
      ...(claim.proposals ? { [CAPABILITIES]: [PROPOSE_CAPABILITY] } : {}),
      ...(m.decision ? { [THREAD_DECISION]: m.decision } : {}),
    },
  });
}

type Step = {
  ctx: ActionCtx;
  bindingId: Id<"a2aBindings">;
  claim: Claim;
  credential: Credential | null;
  /** Cleans what the agent wrote of the room's token, before anything is cut (redact.ts). */
  redactor: Redactor;
  /** The A2A version this step speaks: the claim's, or the other one after a send found it answers. */
  dialect: Dialect;
  /** Set once the agent's answer to the message being sent was committed. */
  delivered?: boolean;
  /** Set when a held stream ended early because someone replied to or stopped the run. */
  woke?: boolean;
  /** When the step began, for its time budget. */
  startedAt: number;
  /** The context the message carries: the claim's, until the agent refused it (ADR 0024). */
  contextId?: string | undefined;
};

/** What an error says, without the room's token in it: run errors are readable by the whole team. */
function said(step: Step, error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error), step.credential);
}

/** The biggest file the room keeps from an agent's file part. Responses are read with a 512 KB limit anyway. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * File parts with bytes in what the agent answered (`{ raw, filename, mediaType }` in 1.0,
 * `{ kind: "file", file: { bytes, name, mimeType } }` in 0.3): in artifacts and in messages. Each
 * keyed by the artifact or message it is in and its place there.
 */
function fileParts(result: unknown): { key: string; name: string; mediaType: string; base64: string }[] {
  const r = (result ?? {}) as Record<string, any>;
  const out: { key: string; name: string; mediaType: string; base64: string }[] = [];
  const add = (owner: unknown, parts: unknown) => {
    if (typeof owner !== "string" || !Array.isArray(parts)) return;
    parts.slice(0, 50).forEach((p: any, i: number) => {
      const file = p?.kind === "file" && p.file && typeof p.file === "object" ? p.file : null;
      const base64 = typeof p?.raw === "string" ? p.raw : typeof file?.bytes === "string" ? file.bytes : undefined;
      if (!base64) return;
      const name = String(p?.filename ?? file?.name ?? "") || "file";
      const mediaType = String(p?.mediaType ?? file?.mimeType ?? "") || "application/octet-stream";
      out.push({ key: `${owner}:${i}`.slice(0, 300), name: name.slice(0, 200), mediaType: mediaType.slice(0, 100), base64 });
    });
  };
  const task = r["task"] ?? (r["kind"] === "task" || (r["id"] && r["status"]) ? r : undefined);
  const artifacts = [
    ...(Array.isArray(task?.artifacts) ? task.artifacts : []),
    ...(r["artifactUpdate"]?.artifact ? [r["artifactUpdate"].artifact] : []),
    ...(r["kind"] === "artifact-update" && r["artifact"] ? [r["artifact"]] : []),
  ];
  for (const a of artifacts.slice(0, 8)) add(a?.artifactId, a?.parts);
  for (const m of [r["message"] ?? (r["kind"] === "message" ? r : undefined), r["statusUpdate"]?.status?.message, r["kind"] === "status-update" ? r["status"]?.message : undefined, task?.status?.message]) {
    if (m && typeof m === "object") add((m as any).messageId, (m as any).parts);
  }
  return out;
}

/** The task a result is about, when it names one: a Task, a stream update, or a Message on a task. */
function taskOf(result: unknown): string | undefined {
  const r = (result ?? {}) as Record<string, any>;
  const task = r["task"] ?? (r["kind"] === "task" || (r["id"] && r["status"]) ? r : undefined);
  const id = task?.id ?? r["statusUpdate"]?.taskId ?? r["artifactUpdate"]?.taskId ?? r["message"]?.taskId ?? r["taskId"];
  return typeof id === "string" && id ? id.slice(0, 300) : undefined;
}

/**
 * Stores the files the agent sent as bytes, once each, and hands them to the run, which posts them
 * with the agent's answer as attachments (ADR 0024). Ones it already keeps are skipped. Each is
 * kept with the task it came in: a reply the agent took into a new task of its own takes its files
 * to the run that follows that task.
 */
async function keepFiles(step: Step, result: unknown): Promise<void> {
  const known = new Set(step.claim.fileKeys);
  const taskId = taskOf(result);
  const stored: { key: string; storageId: Id<"_storage">; name: string; contentType: string; size: number; taskId?: string }[] = [];
  for (const f of fileParts(result)) {
    if (known.has(f.key) || stored.length >= 4) continue;
    const bytes = Buffer.from(f.base64, "base64");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) continue;
    const storageId = await step.ctx.storage.store(new Blob([bytes], { type: f.mediaType }));
    stored.push({ key: f.key, storageId, name: f.name, contentType: f.mediaType, size: bytes.length, ...(taskId ? { taskId } : {}) });
    known.add(f.key);
  }
  if (!stored.length) return;
  step.claim.fileKeys.push(...stored.map((f) => f.key));
  await step.ctx.runMutation(internal.a2aWorker.filesReceived, { bindingId: step.bindingId, lease: step.claim.lease, files: stored });
}

async function commit(step: Step, observation: Observation, deliveredMessageId?: string) {
  return step.ctx.runMutation(internal.a2aWorker.observed, {
    bindingId: step.bindingId,
    lease: step.claim.lease,
    // Parsed with the step's redactor already; the mutation cleans it again after joining pieces.
    observation,
    ...(deliveredMessageId ? { deliveredMessageId } : {}),
  });
}

/**
 * Reads a stream for at most the stream window, committing each observation
 * (artifact-only chunks at most every `streamCommitMs`). Returns whether the
 * task ended, and whether any event arrived.
 */
async function follow(
  step: Step,
  op: "stream" | "subscribe",
  params: Record<string, unknown>,
  deliveredMessageId?: string,
): Promise<{ ended: boolean; events: number; changed: boolean }> {
  const method = methodOf(step.dialect, op);
  const timing = a2aTiming();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timing.streamWindowMs);
  // A reply or a stop waits for this step to end, so a held stream ends as soon as one is asked for.
  let inFlight: Promise<void> | null = null;
  const wakeCheck = setInterval(() => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = step.ctx
      .runQuery(internal.a2aWorker.wakeRequested, { bindingId: step.bindingId })
      .then((wanted) => {
        if (wanted && !controller.signal.aborted) {
          step.woke = true;
          controller.abort();
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  }, timing.wakeCheckMs);
  let delivered = deliveredMessageId;
  let events = 0;
  let changed = false;
  /** An observation not committed yet (artifact chunks wait up to streamCommitMs). */
  const box: { held: Observation | null } = { held: null };
  let lastCommit = 0;
  const flush = async (): Promise<"changed" | "unchanged" | "stale" | "ignored"> => {
    const held = box.held;
    if (!held) return "unchanged";
    const result = await commit(step, held, delivered);
    if (delivered && result !== "ignored") step.delivered = true;
    if (result === "changed") changed = true;
    box.held = null;
    delivered = undefined;
    lastCommit = Date.now();
    return result;
  };
  try {
    for await (const result of stream(
      step.claim.endpoint,
      step.credential,
      method,
      params,
      controller.signal,
      timing.callTimeoutMs,
      step.dialect,
    )) {
      await keepFiles(step, result);
      const obs = fromStreamResult(result, step.redactor);
      events++;
      if (!obs) continue;
      const held = box.held;
      if (held && !obs.state && !held.state && held.taskId === obs.taskId && obs.artifacts) {
        // Chunks wait to be committed together; each keeps whether it appends or replaces.
        box.held = { ...held, artifacts: coalesceArtifacts(held.artifacts ?? [], obs.artifacts, step.redactor) };
      } else {
        if (held && (await flush()) === "ignored") return { ended: true, events, changed };
        box.held = obs;
      }
      const ends = obs.kind === "message" || (obs.state !== undefined && TERMINAL.has(obs.state));
      if (
        obs.state !== undefined ||
        delivered ||
        ends ||
        Date.now() - lastCommit >= timing.streamCommitMs
      ) {
        if ((await flush()) === "ignored") return { ended: true, events, changed };
      }
      if (ends) return { ended: true, events, changed };
    }
    await flush();
    return { ended: false, events, changed };
  } catch (error) {
    // What arrived before the break still counts.
    await flush().catch(() => "ignored" as const);
    if (controller.signal.aborted && error instanceof A2ACallError && error.kind === "network")
      return { ended: false, events, changed };
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(wakeCheck);
    // Nothing may be left running when the step ends (Convex warns of dangling promises).
    if (inFlight) await inFlight;
    if (!controller.signal.aborted) controller.abort();
  }
}

/** Where the run's conversation is, for the history's heading, when the claim didn't carry history. */
async function whereFor(step: Step): Promise<string> {
  return (await step.ctx.runQuery(internal.a2aWorker.whereOfBinding, { bindingId: step.bindingId })) ?? "the conversation";
}

/** The agent answered in `dialect`: the room speaks it from now on, unless the address or card changed since the claim. */
async function learned(step: Step, dialect: Dialect): Promise<void> {
  await step.ctx.runMutation(internal.a2aWorker.dialectLearned, {
    peerId: step.claim.peerId,
    endpointGeneration: step.claim.endpointGeneration,
    dialectGeneration: step.claim.dialectGeneration,
    dialect,
  });
}

/** A send the agent refused outright, with what to tell the person already worded. */
class Refused extends Error {}

/** What the person sees when the agent refused a message. */
function refusal(claim: Claim, error: unknown): string {
  if (error instanceof Refused) return error.message;
  const name = claim.agentName;
  if (credentialRefused(error))
    return tokenRefused(name, (error as A2ACallError).status, !!claim.credential);
  // The room had learned this version, so it didn't try the other.
  if (wrongVersion(error)) return notAnswered(name, "send", claim.dialect, error);
  const reason = error instanceof Error ? error.message : String(error);
  return claim.message!.kind === "start" ? `${name} didn't take the work: ${reason}` : reason;
}

async function send(step: Step): Promise<boolean> {
  const { claim, ctx, bindingId } = step;
  const timing = a2aTiming();
  const messageId = claim.message!.messageId;
  const name = claim.agentName;
  // Checked again just before anything goes out, and again before a fallback send (ADR 0016).
  const stillMay = () => ctx.runMutation(internal.a2aWorker.maySend, { bindingId, lease: claim.lease });
  const sendIn = (dialect: Dialect) =>
    callIn(step, "send", sendParams(dialect, outgoing(step, dialect)), timing.callTimeoutMs, dialect);
  /** The attempt refused for its version, once the send moved to the other version (ADR 0018). */
  const tried: { first: (Attempt & { promised: boolean }) | null } = { first: null };
  /**
   * Moves the send to the other version, once. The agent refused this one and took nothing, so it
   * can't get the message twice. Saved first: if the next answer is lost, the message is looked
   * for in the version it went in. False when the agent may no longer get it.
   */
  const switchVersion = async (op: Op, error: unknown): Promise<boolean> => {
    tried.first = { op, dialect: step.dialect, error, promised: step.dialect === claim.declared };
    if (!(await stillMay())) return false;
    const other = otherDialect(step.dialect);
    await ctx.runMutation(internal.a2aWorker.sendingIn, {
      bindingId,
      lease: claim.lease,
      messageId,
      dialect: other,
    });
    step.dialect = other;
    return true;
  };
  /** The other version refused too: what to throw. No answer, or a fault that may have come after it took the message, is looked for. */
  const refusedAgain = (op: Op, error: unknown): unknown => {
    if ((error instanceof A2ACallError && error.ambiguous) || credentialRefused(error)) return error;
    const second = { op, dialect: step.dialect, error };
    return new Refused(
      wrongVersion(error)
        ? neitherAnswered(name, tried.first!, second)
        : otherRefused(name, tried.first!, second),
    );
  };
  try {
    let streaming = claim.streaming && claim.message!.kind === "start";
    while (streaming) {
      if (!(await stillMay())) return false;
      try {
        const { ended } = await follow(step, "stream", { message: outgoing(step, step.dialect) }, messageId);
        if (tried.first) await learned(step, step.dialect);
        return !ended;
      } catch (error) {
        // The agent took it and the stream broke later: follow the task from here.
        if (step.delivered) {
          if (tried.first) await learned(step, step.dialect);
          await ctx.runMutation(internal.a2aWorker.contactFailed, {
            bindingId,
            lease: claim.lease,
            error: said(step, error),
          });
          return false;
        }
        // "Version not supported": the agent took nothing, so the stream goes once in the other version.
        if (!tried.first && claim.mayProbe && versionRefused(error)) {
          if (!(await switchVersion("stream", error))) return false;
          continue;
        }
        if (error instanceof A2ACallError && error.unsupported) {
          // This version offers no stream though the card says so: send it plainly, nothing was taken.
          await ctx.runMutation(internal.a2aWorker.pollOnly, { bindingId, lease: claim.lease });
          streaming = false;
        } else if (tried.first) {
          throw refusedAgain("stream", error);
        } else if (versionRefused(error)) {
          // The room had learned this version, so it doesn't try the other.
          throw new Refused(notAnswered(name, "stream", step.dialect, error));
        } else {
          throw error;
        }
      }
    }
    if (!(await stillMay())) return false;
    let result: unknown;
    try {
      result = await sendIn(step.dialect);
    } catch (error) {
      if (tried.first) throw refusedAgain("send", error);
      // "Method not found" or "version not supported" means the agent didn't take the message, so
      // asking once in the other A2A version can't deliver it twice (ADR 0018). Only until the room
      // learns which one it answers.
      if (!claim.mayProbe || !wrongVersion(error)) throw error;
      if (!(await switchVersion("send", error))) return false;
      try {
        result = await sendIn(step.dialect);
      } catch (second) {
        throw refusedAgain("send", second);
      }
    }
    if (tried.first) await learned(step, step.dialect);
    await keepFiles(step, result);
    const obs = fromSendResult(result, step.redactor);
    if (!obs)
      throw new A2ACallError("The agent's answer is neither a task nor a message.", {
        kind: "protocol",
        ambiguous: true,
      });
    await commit(step, obs, messageId);
    return true;
  } catch (error) {
    if (step.delivered) return false;
    if (!(error instanceof A2ACallError) || !error.ambiguous) {
      // A first message refused while it carried the conversation's context: the agent may not
      // accept that context (spec 3.4.1), so it goes once more without it (ADR 0024). Refused,
      // it took nothing, so this can't deliver it twice.
      if (
        claim.mayDropContext &&
        step.contextId &&
        claim.message!.kind === "start" &&
        error instanceof A2ACallError &&
        error.kind === "rpc" &&
        !wrongVersion(error) &&
        !credentialRefused(error)
      ) {
        step.contextId = undefined;
        const fresh = await ctx.runMutation(internal.a2aWorker.contextRefused, { bindingId, lease: claim.lease });
        if (fresh) {
          const message = { ...claim.message!, ...(fresh.history ? { history: fresh.history, where: claim.message!.where ?? (await whereFor(step)) } : {}) };
          return send({ ...step, claim: { ...claim, mayDropContext: false, message } });
        }
      }
      // A reply to a task that has ended goes as a new task in the same context.
      if (claim.message!.kind === "reply" && taskEnded(error)) {
        await ctx.runMutation(internal.a2aWorker.replyTaskEnded, { bindingId, lease: claim.lease, messageId });
        return true;
      }
      await ctx.runMutation(internal.a2aWorker.sendFailed, {
        bindingId,
        lease: claim.lease,
        messageId,
        error: redact(refusal(claim, error), step.credential),
      });
      return true;
    }
    // Delivery unclear: the message stays "sending", so the next step looks for it before anything
    // is sent again. That step has its own time budget, so a slow send can't push it past the limit.
    return true;
  }
}

/**
 * The agent refused a message because its task has ended: TaskNotFoundError, or
 * UnsupportedOperationError for a task in a terminal state (spec 3.1.1). The 0.3 SDK answers
 * invalidRequest saying "terminal state" instead (`@a2a-js/sdk` 0.3.14, DefaultRequestHandler).
 */
function taskEnded(error: unknown): boolean {
  return (
    error instanceof A2ACallError &&
    error.kind === "rpc" &&
    !error.ambiguous &&
    (error.code === RPC.taskNotFound ||
      error.code === RPC.unsupportedOperation ||
      (error.code === -32600 && /terminal|final state|completed|has ended/i.test(error.message)))
  );
}

function historyHas(task: unknown, messageId: string): boolean {
  const history = (task as { history?: { messageId?: unknown }[] } | null)?.history;
  return Array.isArray(history) && history.some((m) => m?.messageId === messageId);
}

/** Looks for a message whose delivery is unknown among the agent's tasks, by its message id. */
async function reconcile(step: Step): Promise<boolean> {
  const { claim, ctx, bindingId } = step;
  const messageId = claim.message!.messageId;
  const timing = a2aTiming();
  // Looked for in the version it went out in, which may not be the one the room speaks (ADR 0018).
  step.dialect = claim.message!.dialect ?? claim.dialect;
  let taught = false;
  const ask = async (op: Op, params: Record<string, unknown>) => {
    const result = await callIn(step, op, params, timing.callTimeoutMs);
    // It answered in the version the message went out in: that is the one to speak to it.
    if (!taught && step.dialect !== claim.dialect) {
      taught = true;
      await learned(step, step.dialect);
    }
    return result;
  };
  const gaveUp = async (reason: string) => {
    await ctx.runMutation(internal.a2aWorker.unconfirmed, {
      bindingId,
      lease: claim.lease,
      messageId,
      reason: redact(reason, step.credential),
    });
    return true;
  };
  /** The task found with the message, read whole (a listing may leave its artifacts out). */
  let found = claim.reconcile?.taskId;
  const readFound = async (taskId: string) => {
    const task = await ask("get", { id: taskId, historyLength: 0 });
    await keepFiles(step, task);
    const obs = fromTask(task, step.redactor);
    if (!obs)
      throw new A2ACallError("The agent's answer isn't a task.", {
        kind: "protocol",
        ambiguous: true,
      });
    await commit(step, obs, messageId);
    return true;
  };
  const since = new Date(claim.message!.at - 60_000).toISOString();
  /**
   * A reply to an open task that isn't in that task: Hermes takes every message into a task of its
   * own (ADR 0024), so it is looked for among the context's tasks (ListTasks `contextId`) before it
   * counts as lost. The task holding it, read whole, or null.
   */
  const inContext = async (): Promise<Observation | null> => {
    if (!claim.contextId || claim.listTasks === "unsupported" || step.dialect === "0.3") return null;
    let listed: { tasks?: unknown[] } | null;
    try {
      listed = (await ask("list", {
        contextId: claim.contextId,
        pageSize: 20,
        historyLength: 20,
        statusTimestampAfter: since,
      })) as { tasks?: unknown[] } | null;
    } catch (error) {
      if (!(error instanceof A2ACallError) || !error.unsupported) throw error;
      await ctx.runMutation(internal.a2aWorker.listUnsupported, { peerId: claim.peerId });
      return null;
    }
    const match = (listed?.tasks ?? []).find(
      (task) => (task as { id?: unknown } | null)?.id !== claim.taskId && historyHas(task, messageId),
    ) as { id?: unknown } | undefined;
    if (typeof match?.id !== "string") return null;
    const task = await ask("get", { id: match.id, historyLength: 0 });
    // Its files go with it, as with any answer: kept with that task, and moved to the run that follows it.
    await keepFiles(step, task);
    return fromTask(task, step.redactor);
  };
  try {
    if (claim.taskId) {
      const task = await ask("get", { id: claim.taskId, historyLength: 50 });
      await keepFiles(step, task);
      const obs = fromTask(task, step.redactor);
      if (historyHas(task, messageId)) {
        if (obs) await commit(step, obs, messageId);
        return true;
      }
      // Found in another task of the context: that task is the conversation's next run.
      const other = await inContext();
      if (other) {
        await commit(step, other, messageId);
        return true;
      }
      if (obs) await commit(step, obs);
      return gaveUp(
        `the reply didn't show up in ${claim.agentName}'s task, so it wasn't sent again.`,
      );
    }
    // An earlier step found the task: only reading it is left, so a failed read never searches again.
    if (found) return await readFound(found);
    // A2A 0.3 has no way to list tasks.
    if (claim.listTasks === "unsupported" || step.dialect === "0.3") {
      return gaveUp(
        `${claim.agentName} may or may not have the message, and its gateway can't list tasks to check. Look at its gateway before sending it again.`,
      );
    }
    const pages = claim.reconcile?.pages ?? 0;
    const result = (await ask("list", {
        pageSize: 20,
        historyLength: 20,
        statusTimestampAfter: since,
        // ListTasks leaves artifacts out unless asked (spec 3.1.4).
        includeArtifacts: true,
        ...(claim.reconcile?.pageToken ? { pageToken: claim.reconcile.pageToken } : {}),
      })) as { tasks?: unknown[]; nextPageToken?: unknown } | null;
    const match = (result?.tasks ?? []).find((task) => historyHas(task, messageId));
    const next = typeof result?.nextPageToken === "string" ? result.nextPageToken : "";
    if (!match && next && pages + 1 < MAX_LIST_PAGES) {
      // One page per step: save the place, and the next step reads the next page.
      await ctx.runMutation(internal.a2aWorker.reconcileProgress, {
        bindingId,
        lease: claim.lease,
        messageId,
        pageToken: next,
        pages: pages + 1,
      });
      return true;
    }
    if (!match)
      return gaveUp(
        `${claim.agentName} has no task with the message. It may not have arrived; it wasn't sent again.`,
      );
    // A gateway may still leave artifacts out of a listing: read a finished task whole before it counts.
    const listed = fromTask(match, step.redactor);
    if (
      listed?.state &&
      TERMINAL.has(listed.state) &&
      listed.taskId &&
      !Array.isArray((match as { artifacts?: unknown }).artifacts)
    ) {
      // Saved first: if the read fails, the next step retries it without searching again.
      await ctx.runMutation(internal.a2aWorker.reconcileProgress, {
        bindingId,
        lease: claim.lease,
        messageId,
        pageToken: claim.reconcile?.pageToken ?? "",
        pages,
        taskId: listed.taskId,
      });
      found = listed.taskId;
      return await readFound(found);
    }
    if (listed) {
      await keepFiles(step, match);
      await commit(step, listed, messageId);
    }
    return true;
  } catch (error) {
    if (outOfTime(error)) return true;
    if (error instanceof A2ACallError && error.unsupported && !claim.taskId) {
      await ctx.runMutation(internal.a2aWorker.listUnsupported, { peerId: claim.peerId });
      return gaveUp(
        `${claim.agentName} may or may not have the message, and its gateway can't list tasks to check. Look at its gateway before sending it again.`,
      );
    }
    // The task found earlier is gone at the agent (it may have expired there): stop, as following does.
    const gone =
      found !== undefined &&
      error instanceof A2ACallError &&
      error.kind === "rpc" &&
      error.code === RPC.taskNotFound;
    // Couldn't ask: leave it as sending, so the next step asks again.
    await ctx.runMutation(internal.a2aWorker.contactFailed, {
      bindingId,
      lease: claim.lease,
      error: said(step, error),
      ...(gone ? { gone } : {}),
    });
    return false;
  }
}

async function cancel(step: Step): Promise<boolean> {
  const { claim, ctx, bindingId } = step;
  try {
    const task = await callIn(step, "cancel", { id: claim.taskId! }, a2aTiming().callTimeoutMs);
    await ctx.runMutation(internal.a2aWorker.cancelResult, {
      bindingId,
      lease: claim.lease,
      status: "sent",
    });
    const obs = fromTask(task, step.redactor);
    if (obs) await commit(step, obs);
    return true;
  } catch (error) {
    if (error instanceof A2ACallError && error.unsupported) {
      await ctx.runMutation(internal.a2aWorker.cancelResult, {
        bindingId,
        lease: claim.lease,
        status: "unsupported",
        error: redact(error.message, step.credential),
      });
      return false;
    }
    if (
      error instanceof A2ACallError &&
      error.kind === "rpc" &&
      error.code === RPC.taskNotCancelable
    ) {
      await ctx.runMutation(internal.a2aWorker.cancelResult, {
        bindingId,
        lease: claim.lease,
        status: "not_cancelable",
        error: redact(error.message, step.credential),
      });
      return true;
    }
    if (error instanceof A2ACallError && !error.ambiguous) {
      await ctx.runMutation(internal.a2aWorker.cancelResult, {
        bindingId,
        lease: claim.lease,
        status: "failed",
        error: redact(error.message, step.credential),
      });
      return false;
    }
    await ctx.runMutation(internal.a2aWorker.contactFailed, {
      bindingId,
      lease: claim.lease,
      error: said(step, error),
    });
    return false;
  }
}

async function poll(step: Step): Promise<boolean> {
  const { claim, ctx, bindingId } = step;
  try {
    if (claim.streaming) {
      try {
        const { ended, events, changed } = await follow(step, "subscribe", {
          id: claim.taskId!,
        });
        // A stream that closes at once without news is polled next time, so it can't spin.
        if (!ended && events === 0 && !step.woke)
          await ctx.runMutation(internal.a2aWorker.pollOnly, { bindingId, lease: claim.lease });
        // Subscribe again at once only after real news or a wake; otherwise back off as polling does.
        return !ended && (changed || !!step.woke);
      } catch (error) {
        if (!(error instanceof A2ACallError) || !(error.unsupported || error.kind === "protocol"))
          throw error;
        await ctx.runMutation(internal.a2aWorker.pollOnly, { bindingId, lease: claim.lease });
      }
    }
    const task = await callIn(
      step,
      "get",
      { id: claim.taskId!, historyLength: 0 },
      a2aTiming().callTimeoutMs,
    );
    await keepFiles(step, task);
    const obs = fromTask(task, step.redactor);
    if (!obs)
      throw new A2ACallError("The agent's answer isn't a task.", {
        kind: "protocol",
        ambiguous: true,
      });
    await commit(step, obs);
    return false;
  } catch (error) {
    const gone =
      error instanceof A2ACallError && error.kind === "rpc" && error.code === RPC.taskNotFound;
    await ctx.runMutation(internal.a2aWorker.contactFailed, {
      bindingId,
      lease: claim.lease,
      error: said(step, error),
      ...(gone ? { gone } : {}),
    });
    return false;
  }
}

export const step = internalAction({
  args: { bindingId: v.id("a2aBindings") },
  handler: async (ctx, { bindingId }): Promise<null> => {
    const claimed: Claim | null = await ctx.runMutation(internal.a2aWorker.claim, { bindingId });
    if (!claimed) return null;
    let soon = false;
    let credential: Credential | null = null;
    try {
      if (claimed.credential) {
        const secret = await openSecret(
          claimed.credential,
          credentialBinding(claimed.peerId, claimed.credential.origin),
        );
        credential = credentialFor(claimed, secret);
      }
      const s: Step = {
        ctx,
        bindingId,
        claim: claimed,
        credential,
        redactor: redactor(credential),
        dialect: claimed.dialect,
        startedAt: Date.now(),
        contextId: claimed.contextId,
      };
      switch (claimed.work.kind) {
        case "send":
          soon = await send(s);
          break;
        case "reconcile":
          soon = await reconcile(s);
          break;
        case "cancel":
          soon = await cancel(s);
          break;
        case "follow":
          soon = await poll(s);
          break;
      }
    } catch (error) {
      await ctx.runMutation(internal.a2aWorker.contactFailed, {
        bindingId,
        lease: claimed.lease,
        error: redact(error instanceof Error ? error.message : String(error), credential, 500),
      });
    } finally {
      await ctx.runMutation(internal.a2aWorker.release, {
        bindingId,
        lease: claimed.lease,
        ...(soon ? { soon } : {}),
      });
    }
    return null;
  },
});

/**
 * Check connection (a2a.checkConnection): one harmless call that needs the room's token, and shows
 * which A2A version answers. A version other than the card's is what the room speaks from then on.
 * The result carries this check's id and the generations it read, so it lands only on this check,
 * and only while the address and card are still the ones it called.
 */
export const checkConnection = internalAction({
  args: { peerId: v.id("a2aPeers"), checkId: v.string() },
  handler: async (ctx, { peerId, checkId }): Promise<null> => {
    const peer = await ctx.runQuery(internal.a2aWorker.peerForConnection, { peerId, checkId });
    if (!peer) return null;
    let result: { ok: boolean; dialect?: Dialect; summary: string };
    let credential: Credential | null = null;
    try {
      if (peer.credential) {
        const secret = await openSecret(peer.credential, credentialBinding(peerId, peer.credential.origin));
        credential =
          peer.credential.kind === "header"
            ? { kind: "header", name: peer.credential.headerName ?? "x-api-key", secret }
            : { kind: "bearer", secret };
      }
      result = await probeConnection(guardedFetch, peer.endpoint, credential, peer, a2aTiming().cardTimeoutMs);
    } catch (error) {
      result = {
        ok: false,
        summary: redact(
          `The check failed: ${error instanceof Error ? error.message : String(error)}`,
          credential,
        ),
      };
    }
    await ctx.runMutation(internal.a2aWorker.connectionChecked, {
      peerId,
      checkId,
      endpointGeneration: peer.endpointGeneration,
      dialectGeneration: peer.dialectGeneration,
      ok: result.ok,
      ...(result.dialect ? { dialect: result.dialect } : {}),
      summary: result.summary,
    });
    return null;
  },
});
