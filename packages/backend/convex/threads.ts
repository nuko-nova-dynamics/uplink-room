/**
 * T3 Code threads as places teammates work in (ADR 0021). A thread run has an access level and a
 * driver, with the same rules as a terminal: whoever started it picks the access, up to the
 * machine's most open level, and whoever the machine belongs to can lower it; the driver passes the
 * wheel, others ask for it on Drive and take it on Open.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  accessRank,
  MAX_MESSAGE_FILES,
  minAccess,
  ROOM_MESSAGE_PREFIX,
  vAccess,
  vRuntimeMode,
} from "@uplink-room/protocol";
import { checkAttachment, keepThreadAttachments, roomFilesOf, threadAttachmentsOf, vNewAttachment } from "./lib/attachments";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { randomSecret } from "./lib/crypto";
import { DIFF_KEPT_MS, dropHistoryRows, roomMessageOf } from "./lib/threadView";
import { canAnswer } from "./inbox";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actsFor, type Actor } from "./lib/actor";
import { memberCanSee } from "./lib/channels";
import { roomError } from "./lib/errors";
import {
  handThread,
  mayBeHandedWheel,
  mayDriveThere,
  nextDriverThere,
  ownerRunsOnly,
  personDrivesText,
  requireMachineControl,
  actorMayDriveThere,
  requireMayDriveThere,
} from "./lib/machines";
import { audit, inTeam, maybeView, memberView, nextDriverInChannel, runsInChannel, teamMember } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import { actorRef } from "./lib/terminals";
import {
  aboveModeCap,
  bridgeHandles,
  cancelThreadWhatAccessForbids,
  isThreadRun,
  machineModeCap,
  modeCapText,
  runtimeModeOf,
  threadAccessOf,
  threadIsOpen,
  THREAD_MESSAGE_MAX,
  type ThreadRun,
} from "./lib/threads";

/** Watchers seen in this window count as watching. */
const WATCH_WINDOW_MS = 30 * 1000;

/**
 * An id as one path segment of T3 Code's hosted thread link, escaping even URL-safe punctuation as
 * T3 Code does (packages/shared/src/threadLinks.ts `hostedSegment`, MIT, T3 Tools Inc., at commit
 * 9e85538535c8553901351112ab02dd1dd62db5ee).
 */
function hostedSegment(id: string) {
  return encodeURIComponent(id).replace(/[.!~*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A thread run in the actor's team that the room still works with. */
async function openThread(ctx: QueryCtx, actor: Actor, runId: Id<"runs">): Promise<ThreadRun> {
  const run = await inTeam(ctx, actor, runId);
  if (!isThreadRun(run)) throw roomError("invalid", "This run isn't a T3 Code thread.");
  if (!threadIsOpen(run)) throw roomError("invalid", "This thread's run was stopped in the room.");
  return run;
}

async function machineOf(ctx: QueryCtx, run: ThreadRun): Promise<Doc<"machines">> {
  const machine = await ctx.db.get(run.machineId);
  if (!machine || machine.unlinkedAt !== undefined) throw roomError("invalid", "This thread's machine was unlinked.");
  return machine;
}

async function canControlMachine(ctx: QueryCtx, actor: Actor, machine: Doc<"machines">) {
  try {
    await requireMachineControl(ctx, actor, machine);
    return true;
  } catch {
    return false;
  }
}

function isDriver(actor: Actor, run: Doc<"runs">): boolean {
  return run.driverId === actor.member._id;
}

function requireDriver(actor: Actor, run: Doc<"runs">): void {
  if (!isDriver(actor, run)) throw roomError("forbidden", "Only the thread's driver can do this. Ask for the wheel first.");
}

/**
 * As requireDriver, and the driver must still be someone who may drive on the thread's machine: on
 * a personal machine set below Drive, its person or their agent (ADR 0025). Returns the machine.
 */
async function requireDriverThere(ctx: QueryCtx, actor: Actor, run: ThreadRun): Promise<Doc<"machines">> {
  requireDriver(actor, run);
  const machine = await machineOf(ctx, run);
  await requireMayDriveThere(ctx, actor, machine, run._id);
  return machine;
}

/**
 * On a machine that takes runs only from its person, refuses a new driver who may not be handed the
 * wheel there (mayBeHandedWheel, ADR 0025), whatever the thread's own level. Returns whether the
 * machine is such a machine, so the caller skips the usual level rules only there.
 */
async function requireMayBeHandedWheel(ctx: QueryCtx, machine: Doc<"machines">, run: ThreadRun, memberId: Id<"members">, what: string) {
  if (!ownerRunsOnly(machine)) return false;
  if (!(await mayBeHandedWheel(ctx, machine, { runId: run._id, startedBy: run.startedBy }, memberId))) {
    throw roomError("forbidden", await personDrivesText(ctx, machine, what));
  }
  return true;
}

function requireAtLeast(run: Doc<"runs">, access: "suggest" | "drive", what: string) {
  const current = threadAccessOf(run);
  if (accessRank(current) < accessRank(access)) {
    throw roomError("forbidden", `This thread is set to ${current}, so teammates can't ${what}.`);
  }
}

/** The bridge must take the new driver, or it would refuse their answers (`thread_driver`). */
function requireDriverChanges(machine: Doc<"machines">) {
  if (!bridgeHandles(machine, "thread_driver")) {
    throw roomError(
      "invalid",
      `The bridge on ${machine.name} is too old to pass a thread's wheel. Update Uplink Room there, then try again.`,
    );
  }
}

/** Makes someone the thread's driver, and tells the bridge. */
async function setDriver(ctx: MutationCtx, actor: Actor, run: ThreadRun, memberId: Id<"members">): Promise<void> {
  const member = await teamMember(ctx, actor, memberId);
  // A thread from a private channel or direct message is driven only by someone still in it (ADR 0016).
  const channel = run.directChannelId ? await ctx.db.get(run.directChannelId) : null;
  if (channel && !(await memberCanSee(ctx, channel, member._id))) {
    throw roomError("forbidden", "They're no longer in the channel this thread came from, so they can't drive it.");
  }
  await ctx.db.patch(run._id, { driverId: member._id });
  const requests = await ctx.db
    .query("threadWheelRequests")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .collect();
  for (const r of requests) {
    if (r.status === "pending" && r.fromId === member._id) {
      await ctx.db.patch(r._id, { status: "granted", answeredBy: actor.member._id });
    }
  }
  await sendToBridge(ctx, run.machineId, {
    v: 1,
    type: "thread_driver_changed",
    threadRef: run.threadRef,
    driver: actorRef(member),
    ...(run.startedBy ? { starterId: run.startedBy } : {}),
  });
  await audit(ctx, actor, "thread.driver_changed", run._id, { from: run.driverId, to: member._id });
}

/**
 * Someone left a private channel or was removed from it (ADR 0016): a thread on one of its runs that
 * they drive goes to nextDriverInChannel, as a terminal does. With nobody there it stays put. On a
 * personal machine set below Drive it goes only to someone who may drive there, and with nobody who
 * may, nobody drives (ADR 0025).
 */
export async function releaseChannelThreads(ctx: MutationCtx, actor: Actor, channelId: Id<"channels">, memberId: Id<"members">) {
  for (const run of await runsInChannel(ctx, channelId)) {
    if (!isThreadRun(run) || !threadIsOpen(run) || !run.driverId) continue;
    const machine = await ctx.db.get(run.machineId);
    if (!machine || !bridgeHandles(machine, "thread_driver")) continue;
    if (ownerRunsOnly(machine)) {
      if (run.driverId !== memberId && (await mayDriveThere(ctx, machine, run._id, run.driverId))) continue;
      const next = await nextDriverThere(ctx, machine, channelId, memberId, { runId: run._id, startedBy: run.startedBy });
      if (next) await setDriver(ctx, actor, run, next);
      else await handThread(ctx, run, undefined, actor, "left_channel");
      continue;
    }
    if (run.driverId !== memberId || !run.startedBy) continue;
    const next = await nextDriverInChannel(ctx, actor, channelId, memberId, {
      startedBy: run.startedBy,
      access: threadAccessOf(run),
    });
    if (next) await setDriver(ctx, actor, run, next);
  }
}

export const { person: get, agent: getAgent } = roomQuery({
  name: "threads.get",
  description:
    "One T3 Code thread run as a place to work in: its access (watch, suggest, drive or open, up to its machine's limit), who started it, who drives it, and where its machine's T3 Code pairing stands (t3: connected, unreachable or needs_pairing, with when the pairing ends).",
  scope: "room.read",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (!isThreadRun(run)) throw roomError("invalid", "This run isn't a T3 Code thread.");
    const machine = await ctx.db.get(run.machineId);
    const now = Date.now();
    const watchers = await ctx.db
      .query("threadWatchers")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    const environmentId = machine?.t3?.environmentId;
    return {
      runId: run._id,
      threadRef: run.threadRef,
      /** Who has the thread's conversation open now. */
      watching: await Promise.all(watchers.filter((w) => now - w.lastSeenAt < WATCH_WINDOW_MS).map((w) => memberView(ctx, w.memberId))),
      /** Whether its bridge can show the conversation (`thread_view`); an older bridge can't. */
      showsConversation: bridgeHandles(machine, "thread_view"),
      /** Whether its bridge takes messages (threads.send) and answers to questions (`thread_messages`, `thread_questions`). */
      takesMessages: bridgeHandles(machine, "thread_messages"),
      takesAnswers: bridgeHandles(machine, "thread_questions"),
      /** T3 Code has items older than the oldest threads.items returns: threads.loadOlder asks for them. */
      older: run.threadOlder === true,
      /** The last threads.loadOlder: loading, or why it failed. */
      history: run.threadHistory,
      /** Whether you may answer its approvals (inbox.answer): its driver, the task's owner or an admin. */
      answersApprovals: await canAnswer(ctx, actor, run),
      /**
       * The thread's link in T3 Code (its hosted app at app.t3.codes opens the desktop app, the
       * mobile app or itself), once the thread exists there and its bridge said which T3 Code it is.
       */
      t3Link:
        environmentId && run.threadRef !== run._id
          ? `https://app.t3.codes/threads/${hostedSegment(environmentId)}/${hostedSegment(run.threadRef)}`
          : undefined,
      access: threadAccessOf(run),
      loweredFrom: run.threadLoweredFrom,
      /**
       * What the agent may do without asking (ADR 0043): its permission mode, the modes its T3 Code
       * provider takes (absent until the bridge reports them), who set it from the room and when, and
       * the mode it had before the machine's cap lowered it.
       */
      runtimeMode: runtimeModeOf(run),
      runtimeModes: run.runtimeModes,
      runtimeModeSetBy: await maybeView(ctx, run.runtimeModeSetBy),
      runtimeModeSetAt: run.runtimeModeSetAt,
      runtimeModeLoweredFrom: run.runtimeModeLoweredFrom,
      /** The room stopped the thread because T3 Code refused every mode within the machine's cap: `runtimeMode` is above it. */
      runtimeModeOverCap: run.runtimeModeOverCap === true,
      /** A mode asked for that T3 Code hasn't confirmed yet: `runtimeMode` stays the one in effect until it does. */
      runtimeModePending: run.runtimeModeRequested?.mode,
      /** Whether its bridge takes a new mode (`thread_modes`) and files with a message (`thread_attachments`). */
      changesMode: bridgeHandles(machine, "thread_modes"),
      takesFiles: bridgeHandles(machine, "thread_attachments"),
      /** False once the run was stopped in the room: its access and wheel no longer change. */
      open: threadIsOpen(run),
      startedBy: await maybeView(ctx, run.startedBy),
      driver: await maybeView(ctx, run.driverId),
      machine: machine
        ? {
            machineId: machine._id,
            name: machine.name,
            mostOpenAccess: machine.mostOpenAccess,
            mostPermissiveMode: machineModeCap(machine),
            t3: machine.t3,
            /** Whether its bridge takes a new driver for a thread (`thread_driver`). */
            passesWheel: bridgeHandles(machine, "thread_driver"),
          }
        : undefined,
    };
  },
});

export const { person: setAccess, agent: setAccessAgent } = roomMutation({
  name: "threads.setAccess",
  description:
    "Set a T3 Code thread's access: watch, suggest, drive or open, up to its machine's limit. Whoever started the thread picks the level; whoever the machine belongs to can always lower it.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), access: vAccess },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    const machine = await machineOf(ctx, run);
    if (accessRank(args.access) > accessRank(machine.mostOpenAccess)) {
      throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
    }
    const current = threadAccessOf(run);
    const lowering = accessRank(args.access) <= accessRank(current);
    const isStarter = run.startedBy !== undefined && actsFor(actor, run.startedBy);
    if (!isStarter && !(lowering && (await canControlMachine(ctx, actor, machine)))) {
      throw roomError(
        "forbidden",
        "Only whoever started this thread can change its access; whoever the machine belongs to can lower it.",
      );
    }
    await ctx.db.patch(run._id, { threadAccess: args.access, threadLoweredFrom: undefined });
    await cancelThreadWhatAccessForbids(ctx, run._id, args.access);
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "change_thread_access",
      threadRef: run.threadRef,
      access: minAccess(args.access, machine.mostOpenAccess),
    });
    await audit(ctx, actor, "thread.access_changed", run._id, { from: current, to: args.access });
    return null;
  },
});

export const { person: setMode, agent: setModeAgent } = roomMutation({
  name: "threads.setMode",
  description:
    "As a T3 Code thread's driver, change what its agent may do without asking (its permission mode): approval-required, auto-accept-edits, auto or full-access, among the modes its provider takes (threads.get runtimeModes) and up to the machine's mostPermissiveMode. T3 Code applies it from the agent's next step. Until T3 Code confirms it, threads.get keeps runtimeMode at the mode in effect and names the new one in runtimeModePending; if T3 Code refuses it, the pending mode is dropped and the same change can be asked again. The room records who changed it, and the thread's header shows it. Others ask the driver, or take control first.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), runtimeMode: vRuntimeMode },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    const machine = await requireDriverThere(ctx, actor, run);
    if (!bridgeHandles(machine, "thread_modes")) {
      throw roomError("invalid", `The bridge on ${machine.name} is too old to change a thread's permission mode. Update Uplink Room there, or change it in T3 Code.`);
    }
    if (aboveModeCap(machine, args.runtimeMode)) throw roomError("invalid", modeCapText(machine));
    if (run.runtimeModes && !run.runtimeModes.includes(args.runtimeMode)) {
      throw roomError("invalid", `This thread's T3 Code provider takes ${run.runtimeModes.join(", ")}.`);
    }
    const current = runtimeModeOf(run);
    // Nothing to do only when the thread already has it and nothing else is on its way: a change
    // that is still pending, or was refused, can be asked again (ADR 0043).
    if (current === args.runtimeMode && !run.runtimeModeRequested) return null;
    // The mode in effect stays until T3 Code confirms the new one (lib/bridgeMessages.ts `threadMode`),
    // so the header never shows less than the agent may do.
    await ctx.db.patch(run._id, {
      runtimeModeRequested: current === args.runtimeMode ? undefined : { mode: args.runtimeMode, by: actor.member._id, at: Date.now() },
    });
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "set_thread_mode",
      threadRef: run.threadRef,
      from: actorRef(actor.member),
      runtimeMode: args.runtimeMode,
    });
    await audit(ctx, actor, "run.mode_set", run._id, { from: current, to: args.runtimeMode });
    return null;
  },
});

export const { person: requestWheel, agent: requestWheelAgent } = roomMutation({
  name: "threads.requestWheel",
  description: "Ask the driver of a Drive (or Open) T3 Code thread for the wheel.",
  scope: "terminals.drive",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    if (isDriver(actor, run)) throw roomError("conflict", "You already drive this thread.");
    requireAtLeast(run, "drive", "ask for the wheel");
    const pending = await ctx.db
      .query("threadWheelRequests")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    const mine = pending.find((r) => r.status === "pending" && r.fromId === actor.member._id);
    if (mine) return mine._id;
    return await ctx.db.insert("threadWheelRequests", { runId: run._id, fromId: actor.member._id, status: "pending" });
  },
});

export const { person: wheelRequests, agent: wheelRequestsAgent } = roomQuery({
  name: "threads.wheelRequests",
  description: "Pending requests for a T3 Code thread's wheel.",
  scope: "room.read",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    const rows = await ctx.db
      .query("threadWheelRequests")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    return Promise.all(
      rows.filter((r) => r.status === "pending").map(async (r) => ({ requestId: r._id, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: answerWheelRequest, agent: answerWheelRequestAgent } = roomMutation({
  name: "threads.answerWheelRequest",
  description: "As a T3 Code thread's driver, hand the wheel to whoever asked (grant: true) or say no.",
  scope: "terminals.drive",
  args: { requestId: v.id("threadWheelRequests"), grant: v.boolean() },
  handler: async (ctx, actor, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw roomError("not_found", "No such request.");
    const run = await openThread(ctx, actor, request.runId);
    const machine = await requireDriverThere(ctx, actor, run);
    if (request.status !== "pending") throw roomError("conflict", "This request was already answered.");
    if (args.grant) {
      // Access may have dropped since the request was made.
      requireAtLeast(run, "drive", "be handed the wheel");
      await requireMayBeHandedWheel(ctx, machine, run, request.fromId, "be handed the wheel");
      requireDriverChanges(machine);
      await setDriver(ctx, actor, run, request.fromId);
    } else {
      await ctx.db.patch(request._id, { status: "denied", answeredBy: actor.member._id });
    }
    return null;
  },
});

export const { person: takeWheel, agent: takeWheelAgent } = roomMutation({
  name: "threads.takeWheel",
  description:
    "Take the wheel of an Open T3 Code thread at once. On a Drive thread, ask for it instead. On Watch and Suggest threads only whoever started it (not their agent) can take it back. On a personal machine set to Watch or Suggest, only the person it belongs to drives: they can take the wheel of any thread there, and a teammate who started one can't take it back.",
  scope: "terminals.drive",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    if (isDriver(actor, run)) return null;
    const access = threadAccessOf(run);
    const machine = await machineOf(ctx, run);
    // On a machine that takes runs only from its person, only whoever may be handed the wheel there
    // takes it, whatever the thread's own level (ADR 0025).
    if (!(await requireMayBeHandedWheel(ctx, machine, run, actor.member._id, "take the wheel"))) {
      if (access === "drive") throw roomError("forbidden", "This thread is set to drive: ask the driver for the wheel.");
      // Below Drive the bridge takes a new driver only if it is exactly whoever started the thread.
      if (access !== "open" && actor.member._id !== run.startedBy) {
        throw roomError("forbidden", `This thread is set to ${access}, so only whoever started it can take the wheel.`);
      }
    }
    requireDriverChanges(machine);
    await setDriver(ctx, actor, run, actor.member._id);
    return null;
  },
});

export const { person: passWheel, agent: passWheelAgent } = roomMutation({
  name: "threads.passWheel",
  description:
    "As a T3 Code thread's driver, pass the wheel to a teammate or an agent. On Watch and Suggest threads the wheel can only go back to whoever started it. On a personal machine set to Watch or Suggest it can go only to the person the machine belongs to, or back to their agent that started it.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), to: v.id("members") },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    const isStarter = run.startedBy !== undefined && actsFor(actor, run.startedBy);
    if (!isDriver(actor, run) && !isStarter) {
      throw roomError("forbidden", "Only the driver, or whoever started the thread, can pass the wheel.");
    }
    const machine = await machineOf(ctx, run);
    const restricted = await requireMayBeHandedWheel(ctx, machine, run, args.to, "be handed the wheel");
    if (!restricted && args.to !== run.startedBy) requireAtLeast(run, "drive", "be handed the wheel");
    requireDriverChanges(machine);
    await setDriver(ctx, actor, run, args.to);
    return null;
  },
});

// ---------------------------------------------------------------------------
// The thread's conversation (ADR 0022)
// ---------------------------------------------------------------------------

/** A thread run in the actor's team, whatever its state: its conversation stays readable. */
async function threadRunOf(ctx: QueryCtx, actor: Actor, runId: Id<"runs">): Promise<ThreadRun> {
  const run = await inTeam(ctx, actor, runId);
  if (!isThreadRun(run)) throw roomError("invalid", "This run isn't a T3 Code thread.");
  return run;
}

export const { person: watch, agent: watchAgent } = roomMutation({
  name: "threads.watch",
  description:
    "Say you're reading a T3 Code thread's conversation. Call it every ~15 seconds while it's open: while anyone watches, the thread's bridge follows it and threads.items fills with its newest items, changing as the agent works.",
  scope: "room.read",
  // A presence heartbeat: logging each call would bury the activity log.
  agentAudit: false,
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    const now = Date.now();
    const existing = await ctx.db
      .query("threadWatchers")
      .withIndex("by_run_member", (q) => q.eq("runId", run._id).eq("memberId", actor.member._id))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { lastSeenAt: now });
    const watcherId = existing?._id ?? (await ctx.db.insert("threadWatchers", { runId: run._id, memberId: actor.member._id, lastSeenAt: now }));
    const job = existing?.checkId ? await ctx.db.system.get("_scheduled_functions", existing.checkId) : null;
    if (!job || (job.state.kind !== "pending" && job.state.kind !== "inProgress")) {
      const checkId = await ctx.scheduler.runAt(now + WATCH_WINDOW_MS, internal.threads.checkWatcher, { watcherId });
      await ctx.db.patch(watcherId, { checkId });
    }
    if (run.threadWatchedAt === undefined) {
      const machine = await ctx.db.get(run.machineId);
      if (machine && machine.unlinkedAt === undefined && bridgeHandles(machine, "thread_view")) {
        await sendToBridge(ctx, machine._id, { v: 1, type: "watch_thread", threadRef: run.threadRef });
        await ctx.db.patch(run._id, { threadWatchedAt: now });
      }
    }
    return null;
  },
});

/**
 * Drops a watcher whose window passed with no `threads.watch`. When the last one goes, the bridge
 * stops following the thread; what the room kept stays readable.
 */
export const checkWatcher = internalMutation({
  args: { watcherId: v.id("threadWatchers") },
  handler: async (ctx, { watcherId }) => {
    const watcher = await ctx.db.get(watcherId);
    if (!watcher) return null;
    if (Date.now() - watcher.lastSeenAt < WATCH_WINDOW_MS) {
      const checkId = await ctx.scheduler.runAt(watcher.lastSeenAt + WATCH_WINDOW_MS, internal.threads.checkWatcher, { watcherId });
      await ctx.db.patch(watcher._id, { checkId });
      return null;
    }
    await ctx.db.delete(watcher._id);
    const others = await ctx.db
      .query("threadWatchers")
      .withIndex("by_run", (q) => q.eq("runId", watcher.runId))
      .first();
    const run = await ctx.db.get(watcher.runId);
    if (others || !run || run.threadWatchedAt === undefined || !run.machineId || run.threadRef === undefined) return null;
    await sendToBridge(ctx, run.machineId, { v: 1, type: "unwatch_thread", threadRef: run.threadRef });
    await ctx.db.patch(run._id, { threadWatchedAt: undefined });
    return null;
  },
});

export const { person: items, agent: itemsAgent } = roomQuery({
  name: "threads.items",
  description:
    "A T3 Code thread's conversation, newest first: messages (role user or assistant; one sent from the room has sentBy, and suggestedBy for a teammate's suggestion), the agent's reasoning, tool calls with their input and output (kind tool), file changes with their diff, plans, approvals and questions with how they ended (kind request), checkpoints (a turn's number and files; its full diff is threads.requestDiff), and notices. The room keeps the newest 300 items while someone watches (threads.watch); when older is true in threads.get, threads.loadOlder fetches earlier ones. Long text is cut (cut: true). Paged: pass paginationOpts { numItems, cursor: null }, then each result's continueCursor, until isDone.",
  scope: "room.read",
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    const result = await ctx.db
      .query("threadItems")
      .withIndex("by_run_order", (q) => q.eq("runId", run._id))
      .order("desc")
      .paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(args.paginationOpts.numItems, 100)) });
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => {
          // A message sent from the room names who sent it, and whose suggestion it was.
          const sent = await roomMessageOf(ctx, run._id, row.item);
          if (!sent) return row.item;
          const suggestion = sent.suggestionId ? await ctx.db.get(sent.suggestionId) : null;
          const files = await threadAttachmentsOf(ctx, sent);
          return {
            ...row.item,
            sentBy: await memberView(ctx, sent.fromId),
            // The room's own copy of what was sent (ADR 0043): an image shows from it, in a thread
            // everyone on the team can see. A private place's run gives no lasting link (ADR 0016).
            ...(files.length
              ? {
                  roomFiles: await Promise.all(
                    files.map(async (f) => ({
                      name: f.name,
                      kind: f.kind,
                      size: f.size,
                      url: f.kind === "image" && !run.directChannelId ? await ctx.storage.getUrl(f.storageId) : null,
                    })),
                  ),
                }
              : {}),
            ...(suggestion ? { suggestedBy: await memberView(ctx, suggestion.fromId) } : {}),
          };
        }),
      ),
    };
  },
});

export const { person: loadOlder, agent: loadOlderAgent } = roomMutation({
  name: "threads.loadOlder",
  description:
    "Ask a T3 Code thread's bridge for up to 50 items before the oldest the room keeps; they appear in threads.items for 30 minutes. threads.get says when they're loading or why they failed.",
  scope: "room.read",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    const machine = await ctx.db.get(run.machineId);
    if (!machine || machine.unlinkedAt !== undefined || !bridgeHandles(machine, "thread_view")) {
      throw roomError("invalid", "This thread's bridge can't send its conversation. Update Uplink Room on its machine.");
    }
    if (run.threadHistory?.status === "loading" && Date.now() - run.threadHistory.at < 30_000) return null;
    const oldest = await ctx.db
      .query("threadItems")
      .withIndex("by_run_order", (q) => q.eq("runId", run._id))
      .first();
    if (!oldest) throw roomError("invalid", "Open the thread first: the room has none of its items yet.");
    const requestId = randomSecret("th", 12);
    await ctx.db.patch(run._id, { threadHistory: { requestId, status: "loading", at: Date.now() } });
    await sendToBridge(ctx, machine._id, { v: 1, type: "thread_history", threadRef: run.threadRef, requestId, beforeItemId: oldest.itemId });
    return null;
  },
});

export const { person: requestDiff, agent: requestDiffAgent } = roomMutation({
  name: "threads.requestDiff",
  description:
    "Ask a T3 Code thread's bridge for one turn's diff (a checkpoint item's turn), read with threads.diff. A diff fetched in the last day is reused.",
  scope: "room.read",
  args: { runId: v.id("runs"), turn: v.number() },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    if (!Number.isInteger(args.turn) || args.turn < 1) throw roomError("invalid", "turn is a checkpoint's turn number, 1 or more.");
    const machine = await ctx.db.get(run.machineId);
    if (!machine || machine.unlinkedAt !== undefined || !bridgeHandles(machine, "thread_view")) {
      throw roomError("invalid", "This thread's bridge can't send diffs. Update Uplink Room on its machine.");
    }
    const existing = await ctx.db
      .query("threadDiffs")
      .withIndex("by_run_turn", (q) => q.eq("runId", run._id).eq("turn", args.turn))
      .first();
    const now = Date.now();
    if (existing && (existing.status === "ready" || (existing.status === "loading" && now - existing.at < 30_000))) return null;
    const requestId = randomSecret("td", 12);
    if (existing) await ctx.db.patch(existing._id, { requestId, status: "loading", requestedBy: actor.member._id, error: undefined, at: now });
    else {
      const diffId = await ctx.db.insert("threadDiffs", { runId: run._id, turn: args.turn, requestId, requestedBy: actor.member._id, status: "loading", at: now });
      await ctx.scheduler.runAfter(DIFF_KEPT_MS, internal.threads.dropDiff, { diffId });
    }
    await sendToBridge(ctx, machine._id, { v: 1, type: "thread_diff_request", threadRef: run.threadRef, requestId, turn: args.turn });
    return null;
  },
});

export const { person: diff, agent: diffAgent } = roomQuery({
  name: "threads.diff",
  description: "One turn's diff asked for with threads.requestDiff: loading, ready (unified diff text, cut: true when cut short) or failed with why.",
  scope: "room.read",
  args: { runId: v.id("runs"), turn: v.number() },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    const row = await ctx.db
      .query("threadDiffs")
      .withIndex("by_run_turn", (q) => q.eq("runId", run._id).eq("turn", args.turn))
      .first();
    return row ? { turn: row.turn, status: row.status, diff: row.diff, cut: row.cut, error: row.error, at: row.at } : null;
  },
});

/** Drops older items someone loaded once their time is up. */
export const dropHistory = internalMutation({
  // `more`: a follow-up for rows the last batch left, whatever made them go.
  args: { runId: v.id("runs"), more: v.optional(v.boolean()) },
  handler: async (ctx, { runId, more }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    if (more) {
      await dropHistoryRows(ctx, runId);
      return null;
    }
    // A later page moved the time on; its own job drops them.
    if (run.threadHistoryExpiresAt === undefined || run.threadHistoryExpiresAt > Date.now()) return null;
    await ctx.db.patch(runId, { threadHistoryExpiresAt: undefined });
    // T3 Code still has them: "Show earlier messages" fetches them again.
    if (await dropHistoryRows(ctx, runId)) await ctx.db.patch(runId, { threadOlder: true });
    return null;
  },
});

export const dropDiff = internalMutation({
  args: { diffId: v.id("threadDiffs") },
  handler: async (ctx, { diffId }) => {
    if (await ctx.db.get(diffId)) await ctx.db.delete(diffId);
    return null;
  },
});

// ---------------------------------------------------------------------------
// The message box (ADR 0023)
// ---------------------------------------------------------------------------

/** The bridge must take thread messages, or a message would never reach T3 Code. */
function requireMessages(machine: Doc<"machines">) {
  if (!bridgeHandles(machine, "thread_messages")) {
    throw roomError("invalid", `The bridge on ${machine.name} is too old to send messages into a thread. Update Uplink Room there.`);
  }
}

/** Sends a message into a thread as its driver, and records who sent what. */
async function sendMessage(
  ctx: MutationCtx,
  actor: Actor,
  run: ThreadRun,
  machine: Doc<"machines">,
  text: string,
  suggestionId?: Id<"threadSuggestions">,
  attachments: { uploadId: Id<"uploads">; storageId: Id<"_storage">; name: string }[] = [],
) {
  const body = text.trim();
  if (!body && !attachments.length) throw roomError("invalid", "A message needs text or a file.");
  if (body.length > THREAD_MESSAGE_MAX) throw roomError("invalid", `A message can be at most ${THREAD_MESSAGE_MAX} characters.`);
  requireMessages(machine);
  if (attachments.length > MAX_MESSAGE_FILES) throw roomError("invalid", `A message can carry at most ${MAX_MESSAGE_FILES} files.`);
  if (attachments.length && !bridgeHandles(machine, "thread_attachments")) {
    throw roomError("invalid", `The bridge on ${machine.name} is too old to send files into a thread. Update Uplink Room there, or attach them in T3 Code.`);
  }
  // The same checks and limits as a chat message's attachments (lib/attachments.ts).
  const checked = [];
  for (const item of attachments) checked.push(await checkAttachment(ctx, actor, item));
  const messageId = await ctx.db.insert("threadMessages", {
    runId: run._id,
    fromId: actor.member._id,
    ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
    text: body,
    ...(suggestionId ? { suggestionId } : {}),
    ...(checked.length ? { attachmentCount: checked.length } : {}),
    status: "sending",
    at: Date.now(),
  });
  await keepThreadAttachments(ctx, { _id: messageId, runId: run._id }, checked);
  // Who can see this thread sees what goes into it (ADR 0039): the files go only where the message
  // goes, and their links only to the thread's own bridge.
  const files = checked.length ? await roomFilesOf(ctx, checked) : [];
  await sendToBridge(ctx, machine._id, {
    v: 1,
    type: "send_thread_message",
    threadRef: run.threadRef,
    messageId,
    from: actorRef(actor.member),
    text: body,
    ...(files.length ? { attachments: files } : {}),
  });
  await audit(ctx, actor, "thread.message_sent", run._id, {
    messageId,
    text: body.slice(0, 500),
    ...(suggestionId ? { suggestionId } : {}),
    ...(checked.length ? { files: checked.map((f) => f.name) } : {}),
  });
  return messageId;
}

export const { person: send, agent: sendAgent } = roomMutation({
  name: "threads.send",
  description:
    "As a T3 Code thread's driver, send it a message: an idle thread starts a turn with it, a busy one takes it after the turn in progress (nothing is interrupted). It can carry up to 10 files (attachments: uploads from messages.attachUrl, as for messages.post, with the same limits), which T3 Code gives the agent as the message's attachments; the text may then be empty. The room records who sent it (threads.messages). Teammates on a Suggest or more open thread propose messages with threads.suggest instead.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), text: v.string(), attachments: v.optional(v.array(vNewAttachment)) },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    const machine = await requireDriverThere(ctx, actor, run);
    return { messageId: await sendMessage(ctx, actor, run, machine, args.text, undefined, args.attachments) };
  },
});

export const { person: interrupt, agent: interruptAgent } = roomMutation({
  name: "threads.interrupt",
  description:
    "As a T3 Code thread's driver, stop the turn in progress. The thread stays: a message sent afterwards starts the next turn. To end the run for good, use runs.stop.",
  scope: "terminals.drive",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    const machine = await requireDriverThere(ctx, actor, run);
    requireMessages(machine);
    await sendToBridge(ctx, machine._id, { v: 1, type: "interrupt_thread", threadRef: run.threadRef, from: actorRef(actor.member) });
    await audit(ctx, actor, "thread.interrupted", run._id);
    return null;
  },
});

export const { person: messages, agent: messagesAgent } = roomQuery({
  name: "threads.messages",
  description:
    "Who sent what into a T3 Code thread from the room, newest first, with how each went (sending, sent, queued behind a turn, or failed and why) and whose suggestion it was. Messages typed in T3 Code itself aren't listed: T3 Code records no sender. Paged: pass paginationOpts { numItems, cursor: null }, then each result's continueCursor, until isDone.",
  scope: "room.read",
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    const result = await ctx.db
      .query("threadMessages")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .order("desc")
      .paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(args.paginationOpts.numItems, 100)) });
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => {
          const suggestion = row.suggestionId ? await ctx.db.get(row.suggestionId) : null;
          return {
            messageId: row._id,
            /** T3 Code's id for it, as a thread item's messageRef shows it. */
            messageRef: `${ROOM_MESSAGE_PREFIX}${row._id}`,
            text: row.text,
            /** The files sent with it, by name (ADR 0043). */
            files: (await threadAttachmentsOf(ctx, row)).map((f) => ({ name: f.name, kind: f.kind, size: f.size })),
            status: row.status,
            error: row.error,
            at: row.at,
            by: await memberView(ctx, row.fromId),
            suggestedBy: suggestion ? await memberView(ctx, suggestion.fromId) : undefined,
          };
        }),
      ),
    };
  },
});

export const { person: suggest, agent: suggestAgent } = roomMutation({
  name: "threads.suggest",
  description: "Propose a message for a Suggest (or more open) T3 Code thread. It goes into the thread only if its driver sends it.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), text: v.string() },
  handler: async (ctx, actor, args) => {
    const run = await openThread(ctx, actor, args.runId);
    // A driver who may no longer drive there (ADR 0025) suggests like any teammate.
    const drives = isDriver(actor, run) && (await actorMayDriveThere(ctx, actor, await ctx.db.get(run.machineId), run._id));
    if (!drives) requireAtLeast(run, "suggest", "suggest messages");
    const text = args.text.trim();
    if (!text) throw roomError("invalid", "A suggestion needs text.");
    if (text.length > THREAD_MESSAGE_MAX) throw roomError("invalid", `A suggestion can be at most ${THREAD_MESSAGE_MAX} characters.`);
    return await ctx.db.insert("threadSuggestions", { runId: run._id, fromId: actor.member._id, text, status: "pending" });
  },
});

export const { person: suggestions, agent: suggestionsAgent } = roomQuery({
  name: "threads.suggestions",
  description: "A T3 Code thread's pending suggested messages.",
  scope: "room.read",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await threadRunOf(ctx, actor, args.runId);
    const rows = await ctx.db
      .query("threadSuggestions")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    return Promise.all(
      rows.filter((r) => r.status === "pending").map(async (r) => ({ suggestionId: r._id, text: r.text, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: sendSuggestion, agent: sendSuggestionAgent } = roomMutation({
  name: "threads.sendSuggestion",
  description: "As a T3 Code thread's driver, send a suggested message, optionally edited first.",
  scope: "terminals.drive",
  args: { suggestionId: v.id("threadSuggestions"), text: v.optional(v.string()) },
  handler: async (ctx, actor, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) throw roomError("not_found", "No such suggestion.");
    const run = await openThread(ctx, actor, suggestion.runId);
    const machine = await requireDriverThere(ctx, actor, run);
    if (suggestion.status !== "pending") throw roomError("conflict", "This suggestion was already answered.");
    const text = args.text ?? suggestion.text;
    await ctx.db.patch(suggestion._id, { status: "sent", sentText: text, answeredBy: actor.member._id });
    return { messageId: await sendMessage(ctx, actor, run, machine, text, suggestion._id) };
  },
});

export const { person: dismissSuggestion, agent: dismissSuggestionAgent } = roomMutation({
  name: "threads.dismissSuggestion",
  description: "As a T3 Code thread's driver, dismiss a suggested message.",
  scope: "terminals.drive",
  args: { suggestionId: v.id("threadSuggestions") },
  handler: async (ctx, actor, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) throw roomError("not_found", "No such suggestion.");
    const run = await openThread(ctx, actor, suggestion.runId);
    await requireDriverThere(ctx, actor, run);
    await ctx.db.patch(suggestion._id, { status: "dismissed", answeredBy: actor.member._id });
    return null;
  },
});
