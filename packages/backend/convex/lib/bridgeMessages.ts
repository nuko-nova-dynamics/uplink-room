import { accessRank, minAccess, type BridgeMessage, type BridgeMessageOf } from "@uplink-room/protocol";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { handWheelsToOwner } from "./machines";
import { sendToBridge } from "./outbox";
import { harnessOfTool } from "./harnesses";
import { normalizeRepo } from "./repos";
import { deliverWaiting, noticeIfWaiting, runEnded, runMessageResult } from "./runDelivery";
import { roomFilesOf, threadAttachmentsOf } from "./attachments";
import { actorRef, cancelWhatAccessForbids, isLive, splitOutput } from "./terminals";
import { aboveModeCap, bridgeHandles, cancelThreadWhatAccessForbids, capLoweringRefused, isThreadRun, threadIsOpen, keepWithinModeCap, runtimeModeOf, threadAccessOf } from "./threads";
import { threadDiffReceived, threadHistoryReceived, threadItemsReceived } from "./threadView";
import { dispatchIfQueued } from "./taskQueue";

/** Output chunks kept per terminal for late viewers. Older ones are dropped. */
const OUTPUT_CHUNKS_KEPT = 2000;

type Machine = Doc<"machines">;

/** Applies one message from a machine's bridge to the room. */
export async function handleBridgeMessage(
  ctx: MutationCtx,
  machine: Machine,
  message: Exclude<BridgeMessage, { type: "register_machine" | "limits_changed" | "rex_found" | "terminal_size" | `space${string}` }>,
): Promise<void> {
  switch (message.type) {
    case "terminal_started":
      return terminalStarted(ctx, machine, message);
    case "terminal_start_failed":
      return terminalStartFailed(ctx, machine, message);
    case "terminal_output":
      return terminalOutput(ctx, machine, message);
    case "terminal_access":
      return terminalAccess(ctx, machine, message);
    case "input_rejected":
      return inputRejected(ctx, machine, message);
    case "terminal_ended":
      return terminalEnded(ctx, machine, message);
    case "run_state_changed":
      return runStateChanged(ctx, machine, message);
    case "thread_bound":
      return threadBound(ctx, machine, message);
    case "thread_closed":
      return threadClosed(ctx, machine, message);
    case "thread_start_failed":
      return threadStartFailed(ctx, machine, message);
    case "profile_created":
      return profileCreated(ctx, machine, message);
    case "profile_expired":
      return profileExpired(ctx, machine, message);
    case "bridge_features":
      return bridgeFeatures(ctx, machine, message);
    case "thread_access":
      return threadAccess(ctx, machine, message);
    case "t3_status":
      return t3Status(ctx, machine, message);
    case "thread_items":
      return threadItemsReceived(ctx, machine, message);
    case "thread_history_page":
      return threadHistoryReceived(ctx, machine, message);
    case "thread_diff":
      return threadDiffReceived(ctx, machine, message);
    case "thread_message_result":
      return threadMessageResult(ctx, machine, message);
    case "run_message_result":
      return runMessageResult(ctx, machine, message);
    case "run_hearing":
      return runHearing(ctx, machine, message);
    case "thread_mode":
      return threadMode(ctx, machine, message);
  }
}

/**
 * A thread's permission mode as T3 Code has it (ADR 0043), and the modes its provider takes. The mode
 * the room asked for (`runtimeModeRequested`) takes effect here, named for whoever asked; any other
 * mode that differs from the room's was changed in T3 Code itself, so the room names nobody for it.
 */
async function threadMode(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_mode">) {
  const run = await threadRunOf(ctx, machine, m.threadRef);
  if (!run) return;
  const modes = m.modes?.length ? [...new Set(m.modes)] : undefined;
  const sameModes = JSON.stringify(modes) === JSON.stringify(run.runtimeModes);
  const asked = run.runtimeModeRequested;
  if (asked && asked.mode === m.runtimeMode) {
    await ctx.db.patch(run._id, {
      runtimeMode: m.runtimeMode,
      runtimeModes: modes,
      runtimeModeSetBy: asked.by,
      runtimeModeSetAt: Date.now(),
      runtimeModeLoweredFrom: asked.loweredFrom,
      runtimeModeRequested: undefined,
    });
    return await keepWithinModeCap(ctx, machine, run._id);
  }
  if (runtimeModeOf(run) === m.runtimeMode) {
    if (!sameModes) await ctx.db.patch(run._id, { runtimeModes: modes });
    return;
  }
  await ctx.db.patch(run._id, {
    runtimeMode: m.runtimeMode,
    runtimeModes: modes,
    runtimeModeSetBy: undefined,
    runtimeModeSetAt: Date.now(),
    runtimeModeLoweredFrom: undefined,
  });
  await keepWithinModeCap(ctx, machine, run._id);
}

/** How a run on this machine hears messages, as its bridge learned it. */
async function runHearing(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"run_hearing">) {
  let run: Doc<"runs"> | null = null;
  if (m.source.kind === "terminal") {
    const terminal = await findTerminal(ctx, machine, m.source.terminalId);
    run = terminal?.runId ? await ctx.db.get(terminal.runId) : null;
  } else {
    const threadRef = m.source.threadRef;
    run = await ctx.db
      .query("runs")
      .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", threadRef))
      .unique();
  }
  if (run && run.machineId === machine._id && run.hearing !== m.hearing) await ctx.db.patch(run._id, { hearing: m.hearing });
}

/**
 * What a bridge process handles, said once after it registers. Registering forgot the last
 * process's features, so threads on a machine below Drive weren't handed to its person then: they
 * are now, if this bridge takes a thread's new driver (ADR 0025).
 */
async function bridgeFeatures(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"bridge_features">) {
  await ctx.db.patch(machine._id, { bridgeFeatures: m.features.slice(0, 64) });
  if (m.features.includes("thread_driver")) await handWheelsToOwner(ctx, (await ctx.db.get(machine._id))!, undefined, true);
  // Messages sent to its runs while the machine's bridge didn't take them (ADR 0026).
  if (m.features.includes("run_messages")) await deliverWaiting(ctx, machine._id);
  // A new bridge process names its features first after `register_machine` clears them: thread
  // messages the last one took but never answered for go again (ADR 0043).
  if (machine.bridgeFeatures === undefined && m.features.includes("thread_messages")) await resendThreadMessages(ctx, machine, m.features);
}

/** How far back a restarted bridge is sent a thread message still on its way: a day. */
export const THREAD_RESEND_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Sends a restarted bridge again each thread message that went to its machine and has no answer
 * (`thread_message_result`) yet (ADR 0043). The bridge takes a message with files on its own, after
 * the room counts it handled, so a bridge that stopped while the files moved lost it; the room keeps
 * it `sending` until the bridge answers. One still queued for the bridge reaches it anyway and isn't
 * doubled. T3 Code takes a message once by its id, so one that did get there before the bridge
 * stopped isn't sent twice. A message to a run stopped meanwhile fails instead.
 */
async function resendThreadMessages(
  ctx: MutationCtx,
  machine: Machine,
  features: string[],
): Promise<void> {
  const outbox = await ctx.db
    .query("bridgeOutbox")
    .withIndex("by_machine_seq", (q) => q.eq("machineId", machine._id))
    .collect();
  const pending = await ctx.db
    .query("threadMessages")
    .withIndex("by_status_at", (q) =>
      q.eq("status", "sending").gt("at", Date.now() - THREAD_RESEND_MAX_MS),
    )
    .collect();
  const messages = new Map(pending.map((message) => [String(message._id), message]));
  // Include older queued messages too, so rebuilding never moves a replay ahead of them.
  for (const row of outbox) {
    const queued = row.message as { type?: string; messageId?: string };
    if (queued.type !== "send_thread_message" || !queued.messageId) continue;
    const id = ctx.db.normalizeId("threadMessages", queued.messageId);
    const message = id ? await ctx.db.get(id) : null;
    if (message?.status === "sending") messages.set(String(message._id), message);
  }
  for (const message of [...messages.values()].sort(
    (a, b) => a.at - b.at || a._creationTime - b._creationTime,
  )) {
    const run = await ctx.db.get(message.runId);
    if (!run || run.machineId !== machine._id || !isThreadRun(run)) continue;
    // Replace queued copies in the same transaction, in original message order.
    for (const row of outbox) {
      const queued = row.message as { type?: string; messageId?: string };
      if (queued.type === "send_thread_message" && queued.messageId === message._id)
        await ctx.db.delete(row._id);
    }
    const fail = (error: string) => ctx.db.patch(message._id, { status: "failed", error });
    if (!threadIsOpen(run)) {
      await fail("run_stopped");
      continue;
    }
    const from = await ctx.db.get(message.fromId);
    if (!from) {
      await fail("not_driver");
      continue;
    }
    const rows = await threadAttachmentsOf(ctx, message);
    // A bridge that can't send files never sends the message without them.
    if (rows.length && !features.includes("thread_attachments")) {
      await fail("files_unsupported");
      continue;
    }
    const files = rows.length ? await roomFilesOf(ctx, rows) : [];
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "send_thread_message",
      threadRef: run.threadRef!,
      messageId: message._id,
      from: actorRef(from),
      text: message.text,
      ...(files.length ? { attachments: files } : {}),
    });
  }
}

/** The bridge clamped a thread's access to the machine's own limit. A late report never raises it. */
async function threadAccess(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_access">) {
  const run = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", m.threadRef))
    .unique();
  if (!run || !isThreadRun(run)) return;
  const access = minAccess(threadAccessOf(run), m.access);
  if (access === threadAccessOf(run)) return;
  await ctx.db.patch(run._id, { threadAccess: access });
  await cancelThreadWhatAccessForbids(ctx, run._id, access);
}

/** How a message sent from the room into a thread went (ADR 0023). */
async function threadMessageResult(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_message_result">) {
  const id = ctx.db.normalizeId("threadMessages", m.messageId);
  const row = id ? await ctx.db.get(id) : null;
  const run = row ? await ctx.db.get(row.runId) : null;
  if (!row || !run || run.machineId !== machine._id) return;
  await ctx.db.patch(row._id, { status: m.status, error: m.status === "failed" ? (m.error ?? "failed").slice(0, 300) : undefined });
}

/** Where the machine's T3 Code pairing stands now. */
async function t3Status(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"t3_status">) {
  await ctx.db.patch(machine._id, {
    t3: {
      state: m.state,
      ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
      ...(m.reason ? { reason: m.reason } : {}),
      // An id the room puts in a link: kept only when it can't break out of its path segment.
      ...(m.environmentId && /^[\w.:-]{1,200}$/.test(m.environmentId) ? { environmentId: m.environmentId } : {}),
      at: Date.now(),
    },
  });
}

/** A terminal on this machine, by room id or, for one found on the machine, by its localRef. */
export async function findTerminal(
  ctx: MutationCtx,
  machine: Machine,
  ref: string,
): Promise<Doc<"terminals"> | null> {
  const id = ctx.db.normalizeId("terminals", ref);
  if (id) {
    const terminal = await ctx.db.get(id);
    return terminal && terminal.machineId === machine._id ? terminal : null;
  }
  return await ctx.db
    .query("terminals")
    .withIndex("by_machine_local", (q) => q.eq("machineId", machine._id).eq("localRef", ref))
    .order("desc")
    .first();
}

async function terminalStarted(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"terminal_started">) {
  const access = minAccess(m.access, machine.mostOpenAccess);
  const fields = {
    status: "live" as const,
    localRef: m.localRef,
    tool: m.tool,
    ...(m.cwd ? { cwd: m.cwd } : {}),
    ...(m.repo ? { repo: normalizeRepo(m.repo) } : {}),
  };
  const existing = m.terminalId
    ? await findTerminal(ctx, machine, m.terminalId)
    : await findTerminal(ctx, machine, m.localRef);
  if (existing && isLive(existing)) {
    if (m.terminalId) {
      // The room asked for this terminal, so its access stays the room's: the report can be older
      // than a change made in the room since, a raise as well as a lowering. A clamp on the machine
      // arrives separately as `terminal_access`, which lowers it.
      await ctx.db.patch(existing._id, fields);
      return;
    }
    // A report can arrive after the room lowered access; it never raises it.
    const lowered = minAccess(existing.access, access);
    await ctx.db.patch(existing._id, { ...fields, access: lowered, ...(m.rex && !existing.inRex ? { inRex: "tab" as const } : {}) });
    if (accessRank(lowered) < accessRank(existing.access)) await cancelWhatAccessForbids(ctx, existing._id, lowered);
    await sendToBridge(ctx, machine._id, { v: 1, type: "terminal_linked", localRef: m.localRef, terminalId: existing._id });
    return;
  }
  if (m.terminalId) {
    // A terminal the room already ended, for example a run stopped before the bridge started its
    // terminal. Stop it, so it doesn't run unseen.
    await sendToBridge(ctx, machine._id, { v: 1, type: "stop_terminal", terminalId: m.terminalId });
    return;
  }
  if (machine.sharingStoppedAt !== undefined) return;
  // A Rex tab shared from the machine (`uplink-bridge share-rex`) says so itself; from a bridge that
  // doesn't, it's one the bridge reported finding. A share that beat that report is repaired by the
  // next one (lib/rex.ts).
  const rexTab =
    m.rex !== undefined ||
    (
      await ctx.db
        .query("foundRexTabs")
        .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
        .collect()
    ).some((row) => row.tabRef === m.localRef);
  const terminalId = await ctx.db.insert("terminals", {
    teamId: machine.teamId,
    machineId: machine._id,
    ...(rexTab ? { inRex: "tab" as const } : {}),
    startedBy: machine.linkedBy,
    driverId: machine.linkedBy,
    usesSlot: false,
    title: m.title,
    outputSeq: 0,
    ...fields,
    access,
  });
  await sendToBridge(ctx, machine._id, { v: 1, type: "terminal_linked", localRef: m.localRef, terminalId });
  const driver = await ctx.db.get(machine.linkedBy);
  if (driver) {
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "driver_changed",
      terminalId,
      driver: { memberId: driver._id, name: driver.name },
    });
  }
}

async function terminalStartFailed(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"terminal_start_failed">) {
  const terminal = await findTerminal(ctx, machine, m.terminalId);
  if (!terminal) return;
  const now = Date.now();
  await ctx.db.patch(terminal._id, { status: "failed", failReason: m.reason, endedAt: now });
  if (terminal.runId) {
    await setRunState(ctx, terminal.runId, "failed", undefined);
  }
}

/**
 * Stores a flush of output as chunks of at most `OUTPUT_CHUNK_BYTES`, numbered on from the
 * terminal's `outputSeq`, so replay order is exact and `terminals.output` can page by size.
 * The bridge's own seq only drops repeats of a message it sent again.
 */
async function terminalOutput(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"terminal_output">) {
  const terminal = await findTerminal(ctx, machine, m.terminalId);
  if (!terminal || m.seq <= (terminal.bridgeOutputSeq ?? terminal.outputSeq)) return;
  const pieces = splitOutput(m.data);
  let seq = terminal.outputSeq;
  for (const data of pieces) await ctx.db.insert("terminalOutput", { terminalId: terminal._id, seq: ++seq, data });
  await ctx.db.patch(terminal._id, { outputSeq: seq, bridgeOutputSeq: m.seq });
  // Drop what fell out of the kept window each time the seq passes a hundred.
  if (Math.floor(seq / 100) !== Math.floor(terminal.outputSeq / 100)) {
    const old = await ctx.db
      .query("terminalOutput")
      .withIndex("by_terminal_seq", (q) => q.eq("terminalId", terminal._id).lte("seq", seq - OUTPUT_CHUNKS_KEPT))
      .take(200 + pieces.length);
    for (const chunk of old) await ctx.db.delete(chunk._id);
  }
}

async function terminalAccess(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"terminal_access">) {
  const terminal = await findTerminal(ctx, machine, m.terminalId);
  if (!terminal) return;
  // The bridge reports the level it clamped to. A late report never raises a level the room lowered since.
  const access = minAccess(terminal.access, m.access);
  await ctx.db.patch(terminal._id, { access });
  await cancelWhatAccessForbids(ctx, terminal._id, access);
}

/** The thread run this machine's bridge names by `threadRef`, by the thread or by the run it launched. */
async function threadRunOf(ctx: MutationCtx, machine: Machine, threadRef: string) {
  const run = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", threadRef))
    .unique();
  return run && isThreadRun(run) ? run : null;
}

async function inputRejected(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"input_rejected">) {
  // A thread's mode the bridge couldn't set (ADR 0043): the room drops it, so the thread shows the
  // mode T3 Code still has and the same change can be asked again. One that leaves the thread above
  // its machine's cap can't just be dropped: a lower mode is tried, or the run stops. That holds
  // whoever asked, as a driver's choice may have replaced the cap's own request before it was done.
  if (m.runtimeMode !== undefined) {
    const run = await threadRunOf(ctx, machine, m.terminalId);
    const asked = run?.runtimeModeRequested;
    if (run && asked?.mode === m.runtimeMode) {
      if (asked.loweredFrom !== undefined || aboveModeCap(machine, runtimeModeOf(run))) await capLoweringRefused(ctx, machine, run, m.runtimeMode, m.reason);
      else await ctx.db.patch(run._id, { runtimeModeRequested: undefined });
    }
  }
  const terminal = await findTerminal(ctx, machine, m.terminalId);
  // Only a member of this machine's team may appear in its team's log.
  const memberId = ctx.db.normalizeId("members", m.memberId);
  const member = memberId ? await ctx.db.get(memberId) : null;
  await ctx.db.insert("audit", {
    teamId: machine.teamId,
    actorId: member && member.teamId === machine.teamId ? member._id : machine.linkedBy,
    action: "terminal.input_rejected_by_bridge",
    target: terminal?._id ?? m.terminalId,
    details: { reason: m.reason, machineId: machine._id },
    at: Date.now(),
  });
}

async function terminalEnded(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"terminal_ended">) {
  const terminal = await findTerminal(ctx, machine, m.terminalId);
  if (!terminal) return;
  // Stopped means someone ended it; only an exit says whether the work finished or failed.
  // A process killed by a signal failed, whatever exit code came with it (node-pty reports 0).
  const exitCode = m.signal !== undefined && m.signal > 0 ? 128 + m.signal : m.exitCode;
  const runState =
    m.reason === "stopped" || m.reason === "bridge_stopped"
      ? "stopped"
      : exitCode === undefined || exitCode === 0
        ? "done"
        : "failed";
  if (m.reason !== "stopped" && m.reason !== "bridge_stopped" && exitCode !== undefined && terminal.exitCode === undefined) {
    await ctx.db.patch(terminal._id, { exitCode });
  }
  await endTerminal(ctx, terminal, runState);
}

/**
 * Ends a terminal in the room: marks it ended (unless it already ended or
 * failed), cancels its pending wheel requests, and finishes its run with
 * `runState` if the run is still going, and fails the messages that waited for that run.
 */
export async function endTerminal(
  ctx: MutationCtx,
  terminal: Doc<"terminals">,
  runState: "done" | "failed" | "stopped",
): Promise<void> {
  if (isLive(terminal)) await ctx.db.patch(terminal._id, { status: "ended", endedAt: Date.now() });
  const requests = await ctx.db
    .query("wheelRequests")
    .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
    .collect();
  for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  if (terminal.runId) {
    const run = await ctx.db.get(terminal.runId);
    if (run && !isFinal(run.state)) await setRunState(ctx, run._id, runState, undefined);
    // Messages to its run that it never got fail now, rather than wait for good (ADR 0026).
    await runEnded(ctx, terminal.runId);
  }
  // A slot may be free now: a task queued for this machine can start (ADR 0050).
  if (terminal.usesSlot) await dispatchIfQueued(ctx, terminal.machineId);
}

function isFinal(state: Doc<"runs">["state"]): boolean {
  return state === "done" || state === "failed" || state === "stopped";
}

async function runStateChanged(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"run_state_changed">) {
  let run: Doc<"runs"> | null = null;
  if (m.source.kind === "terminal") {
    const terminal = await findTerminal(ctx, machine, m.source.terminalId);
    if (!terminal) return;
    run = terminal.runId ? await ctx.db.get(terminal.runId) : null;
    if (!run) {
      const runId = await ctx.db.insert("runs", {
        teamId: machine.teamId,
        harness: m.harness ?? harnessOfTool(terminal.tool),
        ...(terminal.repo ? { repo: terminal.repo } : {}),
        machineId: machine._id,
        terminalId: terminal._id,
        title: m.title ?? terminal.title,
        ...(terminal.driverId ? { driverId: terminal.driverId } : {}),
        startedBy: terminal.startedBy,
        state: "unknown",
        stateChangedAt: Date.now(),
      });
      await ctx.db.patch(terminal._id, { runId });
      run = await ctx.db.get(runId);
    }
  } else {
    const threadRef = m.source.threadRef;
    run = await ctx.db
      .query("runs")
      .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", threadRef))
      .unique();
    if (!run) {
      const runId = await ctx.db.insert("runs", {
        teamId: machine.teamId,
        harness: m.harness ?? "t3code",
        ...(m.repo ? { repo: normalizeRepo(m.repo) } : {}),
        machineId: machine._id,
        threadRef,
        ...(m.title ? { title: m.title } : {}),
        driverId: machine.linkedBy,
        startedBy: machine.linkedBy,
        state: "unknown",
        stateChangedAt: Date.now(),
      });
      run = await ctx.db.get(runId);
    }
  }
  if (!run) return;
  const details: Partial<Doc<"runs">> = {};
  if (m.title && m.title !== run.title) details.title = m.title;
  if (m.repo && !run.repo) details.repo = normalizeRepo(m.repo);
  if (m.harness && run.harness === "t3code") details.harness = m.harness;
  // A report of a thread means T3 Code lists it. Recorded only from a bridge that says when T3 Code
  // archives or deletes one (`thread_closed`): otherwise a thread archived after its turn ended
  // would stay open to messages for good (ADR 0026).
  if (m.source.kind === "thread" && run.threadOpen !== true && bridgeHandles(machine, "thread_closed")) details.threadOpen = true;
  if (Object.keys(details).length) await ctx.db.patch(run._id, details);
  // A thread T3 Code lists again, as a new bridge process reports each: messages that waited for its
  // run are noticed now that it takes them again (ADR 0037).
  if (details.threadOpen) await noticeIfWaiting(ctx, run);
  // A run stopped in the room stays stopped whatever the bridge says later. One the bridge itself
  // reported Stopped (T3 Code interrupted it) comes back when the thread works, asks or finishes
  // again; Unknown, which is a lost connection, doesn't bring it back. Unknown doesn't undo Done
  // or Failed either: it would clear `endedAt` and bring settled work back to the Inbox.
  if (run.state === "stopped" && (run.stoppedBy !== "bridge" || m.state === "unknown")) return;
  if (m.state === "unknown" && (run.state === "done" || run.state === "failed")) return;
  await setRunState(ctx, run._id, m.state, m.state === "waiting" ? m.prompt : undefined, "bridge");
}

/** A thread run on this machine, by the run id the room sent in `start_thread`. */
async function threadRun(ctx: MutationCtx, machine: Machine, runId: string) {
  const id = ctx.db.normalizeId("runs", runId);
  const run = id ? await ctx.db.get(id) : null;
  return run && run.machineId === machine._id && run.threadRef !== undefined ? run : null;
}

async function threadBound(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_bound">) {
  const run = await threadRun(ctx, machine, m.runId);
  if (!run || run.threadRef === m.threadRef) return;
  // Bind once, from the run id the room gave it. A thread id another run already has stays with
  // that run: two runs with one threadRef would break the lookup reports use.
  if (run.threadRef !== run._id) return;
  const taken = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", m.threadRef))
    .first();
  if (taken) return;
  await ctx.db.patch(run._id, { threadRef: m.threadRef });
}

/** T3 Code archived or deleted the thread: its run, whatever its turn's state, no longer takes messages. */
async function threadClosed(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_closed">) {
  const run = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", m.threadRef))
    .unique();
  if (run?.threadOpen) await ctx.db.patch(run._id, { threadOpen: undefined });
}

/** No thread on this machine is open to messages until its bridge, which registered again, reports it again. */
export async function closeThreads(ctx: MutationCtx, machine: Machine): Promise<void> {
  const open = await ctx.db
    .query("runs")
    .withIndex("by_team_thread_open", (q) => q.eq("teamId", machine.teamId).eq("threadOpen", true))
    .collect();
  for (const run of open) if (run.machineId === machine._id) await ctx.db.patch(run._id, { threadOpen: undefined });
}

async function threadStartFailed(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_start_failed">) {
  const run = await threadRun(ctx, machine, m.runId);
  if (!run || isFinal(run.state)) return;
  await ctx.db.patch(run._id, { failReason: m.detail ? `${m.reason}: ${m.detail}` : m.reason });
  await setRunState(ctx, run._id, "failed", undefined);
}

/**
 * Sets a run's state and what it waits for. Changing state brings settled work back to the Inbox.
 * A Stopped run records who stopped it (`stoppedBy`, the room unless the bridge reported it);
 * any other state clears that.
 */
export async function setRunState(
  ctx: MutationCtx,
  runId: Id<"runs">,
  state: Doc<"runs">["state"],
  prompt: Doc<"runs">["prompt"],
  stoppedBy: "room" | "bridge" = "room",
): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run) return;
  const samePrompt = JSON.stringify(run.prompt ?? null) === JSON.stringify(prompt ?? null);
  if (run.state === state && samePrompt) return;
  const now = Date.now();
  await ctx.db.patch(run._id, {
    state,
    stoppedBy: state === "stopped" ? stoppedBy : undefined,
    prompt,
    stateChangedAt: now,
    ...(isFinal(state) ? { endedAt: now } : { endedAt: undefined }),
  });
}

async function profileCreated(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"profile_created">) {
  const id = ctx.db.normalizeId("profiles", m.profileId);
  const profile = id ? await ctx.db.get(id) : null;
  // A late report must not bring back a profile that was deleted or expired since.
  if (!profile || profile.machineId !== machine._id || profile.status !== "creating") return;
  const expiresAt = Math.min(profile.expiresAt, m.expiresAt);
  await ctx.db.patch(profile._id, { status: "ready", expiresAt });
  // The machine keeps it for less time than the room asked: expire it in the room then too.
  if (expiresAt < profile.expiresAt) await ctx.scheduler.runAt(expiresAt, internal.profiles.expire, { profileId: profile._id });
}

async function profileExpired(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"profile_expired">) {
  const id = ctx.db.normalizeId("profiles", m.profileId);
  const profile = id ? await ctx.db.get(id) : null;
  if (!profile || profile.machineId !== machine._id) return;
  if (profile.status !== "deleted") await ctx.db.patch(profile._id, { status: "expired" });
}
