/**
 * The lifecycle of cloud machines (#10, ADR 0013), shared by the Room API
 * functions in `cloudMachines.ts` and the places that need a machine awake:
 * starting a terminal or a thread run, and profile maintenance.
 *
 * Every start, stop and delete bumps the machine's `generation`, and each
 * scheduled provider call carries the generation it was made for, so a late
 * result from an older operation changes nothing.
 */
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { endTerminal, setRunState } from "./bridgeMessages";
import { roomError } from "./errors";
import { isOnline } from "./machines";
import { endLiveSpaces, isLiveSpace } from "./spaces";
import { isLive } from "./terminals";

const MINUTE = 60 * 1000;

/** Julio's decision on #10: stop after 15 minutes with no live work. */
export const IDLE_MINUTES = 15;
/** The decision brief's estimate: 2 vCPUs (4 GB). */
export const DEFAULT_VCPUS = 2;
export const VCPU_CHOICES = [1, 2, 4, 8] as const;
/** How often a running machine is checked for live work. */
export const CHECK_EVERY_MS = MINUTE;
/**
 * Each boot gets this long at the provider, and is extended by as much while
 * work goes on. A short session bounds the bill if the room ever stops checking.
 */
export const SESSION_MS = 60 * MINUTE;
/** Extend the session once less than this is left and work is live. */
export const EXTEND_WHEN_LEFT_MS = 20 * MINUTE;
/** How long the bridge may take to come back after a boot. The first boot installs it, so it gets longer. */
export const BRIDGE_WAIT_MS = { creating: 10 * MINUTE, starting: 5 * MINUTE } as const;
/** With the bridge quiet this long, the room asks the provider whether the box still runs, at most this often. */
export const RECONCILE_EVERY_MS = 3 * MINUTE;
/** Stop and delete calls are retried this many times before the machine shows as failed. */
export const MAX_ATTEMPTS = 6;

export type Cloud = Doc<"cloudMachines">;
type WakeReason = NonNullable<Cloud["wakeReason"]>;
type StopReason = NonNullable<Cloud["stopReason"]>;

export async function cloudFor(ctx: QueryCtx, machineId: Id<"machines">): Promise<Cloud | null> {
  return ctx.db
    .query("cloudMachines")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .unique();
}

/** Starts the machine unless it is running or already starting. Concurrent starts share one wake. */
export async function wake(ctx: MutationCtx, cloud: Cloud, reason: WakeReason): Promise<void> {
  switch (cloud.state) {
    case "creating":
    case "starting":
    case "running":
      return;
    case "stopping":
      // The box is going down. It starts again as soon as the stop finishes.
      if (!cloud.wakeAfterStop) await ctx.db.patch(cloud._id, { wakeAfterStop: true, wakeReason: reason });
      return;
    case "deleting":
    case "deleted":
      throw roomError("invalid", "This cloud machine was deleted.");
    case "stopped":
    case "failed": {
      const generation = cloud.generation + 1;
      await cancelJobs(ctx, cloud);
      await ctx.db.patch(cloud._id, {
        state: "starting",
        stateChangedAt: Date.now(),
        generation,
        wakeReason: reason,
        wakeAfterStop: undefined,
        stopReason: undefined,
        lastError: undefined,
        attempts: 0,
        stopGaveUp: undefined,
        extendRequestedAt: undefined,
      });
      await watchStart(ctx, cloud._id, generation, "starting");
      await ctx.scheduler.runAfter(0, internal.cloudMachineActions.startAtProvider, { cloudId: cloud._id, generation });
      return;
    }
  }
}

/**
 * The start's watchdog, set before the provider is called. A Convex action
 * runs at most once, so one that dies after booting the box would otherwise
 * leave the machine starting forever, billing, with its work stuck. Unless the
 * bridge registers first, the watchdog fails the waiting work and stops the box.
 */
export async function watchStart(
  ctx: MutationCtx,
  cloudId: Id<"cloudMachines">,
  generation: number,
  state: "creating" | "starting",
): Promise<void> {
  const bridgeWaitId = await ctx.scheduler.runAfter(BRIDGE_WAIT_MS[state], internal.cloudMachines.bridgeWaitExpired, {
    cloudId,
    generation,
  });
  await ctx.db.patch(cloudId, { bridgeWaitId });
}

/** Wake-before-start: work for a stopped cloud machine starts it. The work waits in the bridge's queue meanwhile. */
export async function wakeForWork(ctx: MutationCtx, machineId: Id<"machines">, reason: WakeReason = "work"): Promise<void> {
  const cloud = await cloudFor(ctx, machineId);
  if (cloud) await wake(ctx, cloud, reason);
}

/**
 * While a cloud machine stops, its old bridge may still be reading its queue.
 * It gets nothing then, so a start queued meanwhile waits for the next boot
 * instead of reaching a bridge that is about to go away.
 */
export function holdsQueue(cloud: Cloud | null): boolean {
  return cloud?.state === "stopping" || cloud?.state === "stopped";
}

/** Starts stopping the machine at the provider, keeping its disk. */
export async function beginStop(ctx: MutationCtx, cloud: Cloud, reason: StopReason, lastError?: string): Promise<void> {
  const generation = cloud.generation + 1;
  await cancelJobs(ctx, cloud);
  await ctx.db.patch(cloud._id, {
    state: "stopping",
    stateChangedAt: Date.now(),
    stopReason: reason,
    generation,
    attempts: 0,
    stopGaveUp: undefined,
    ...(lastError ? { lastError } : {}),
    idleCheckId: undefined,
    bridgeWaitId: undefined,
    retryId: undefined,
    extendRequestedAt: undefined,
    lastProgressAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.cloudMachineActions.stopAtProvider, { cloudId: cloud._id, generation });
}

export async function cancelJobs(ctx: MutationCtx, cloud: Cloud): Promise<void> {
  for (const id of [cloud.idleCheckId, cloud.bridgeWaitId, cloud.retryId]) {
    if (!id) continue;
    const job = await ctx.db.system.get("_scheduled_functions", id);
    if (job && job.state.kind === "pending") await ctx.scheduler.cancel(id);
  }
}

/** The bridge of a cloud machine registered: the machine is running, and the idle check starts. */
export async function bridgeRegistered(ctx: MutationCtx, machineId: Id<"machines">): Promise<void> {
  const cloud = await cloudFor(ctx, machineId);
  if (!cloud) return;
  if (cloud.state !== "creating" && cloud.state !== "starting" && cloud.state !== "failed" && cloud.state !== "running") return;
  const now = Date.now();
  if (cloud.bridgeWaitId) {
    const job = await ctx.db.system.get("_scheduled_functions", cloud.bridgeWaitId);
    if (job && job.state.kind === "pending") await ctx.scheduler.cancel(cloud.bridgeWaitId);
  }
  const idleCheckId =
    cloud.idleCheckId && (await pending(ctx, cloud.idleCheckId))
      ? cloud.idleCheckId
      : await ctx.scheduler.runAfter(CHECK_EVERY_MS, internal.cloudMachines.idleCheck, { cloudId: cloud._id });
  await ctx.db.patch(cloud._id, {
    state: "running",
    ...(cloud.state === "running" ? {} : { stateChangedAt: now, runningSince: now }),
    lastBusyAt: now,
    lastError: undefined,
    stopGaveUp: undefined,
    bridgeWaitId: undefined,
    idleCheckId,
    // A registered bridge deletes expired profiles before it takes work, and gets queued deletions.
    maintenancePending: undefined,
    maintenanceAttempts: undefined,
  });
}

async function pending(ctx: QueryCtx, id: Id<"_scheduled_functions">): Promise<boolean> {
  const job = await ctx.db.system.get("_scheduled_functions", id);
  return !!job && (job.state.kind === "pending" || job.state.kind === "inProgress");
}

const QUEUED_WORK = new Set(["start_terminal", "start_thread", "create_profile", "delete_profile"]);

/**
 * What keeps a machine awake, or null when it is idle: live or starting
 * terminals, live Space shares, thread runs that are Working or Waiting, and
 * work still queued for the bridge (a start that hasn't reached it yet).
 * Bridge heartbeats don't count.
 */
export async function liveWork(ctx: QueryCtx, machineId: Id<"machines">): Promise<string | null> {
  const terminals = await ctx.db
    .query("terminals")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  if (terminals.some(isLive)) return "terminal";
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  if (spaces.some(isLiveSpace)) return "space";
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machineId))
    .collect();
  if (runs.some((r) => r.threadRef !== undefined && (r.state === "working" || r.state === "waiting"))) return "thread";
  for await (const row of ctx.db.query("bridgeOutbox").withIndex("by_machine_seq", (q) => q.eq("machineId", machineId))) {
    if (QUEUED_WORK.has((row.message as { type: string }).type)) return "queued";
  }
  return null;
}

/**
 * Fails the work that was waiting for a machine that didn't start: terminals
 * still starting and thread runs whose start never reached a bridge. Their
 * queued starts are dropped, so a later boot never starts them.
 */
export async function failWaitingWork(ctx: MutationCtx, machineId: Id<"machines">, reason: string): Promise<void> {
  const queued = await ctx.db
    .query("bridgeOutbox")
    .withIndex("by_machine_seq", (q) => q.eq("machineId", machineId))
    .collect();
  for (const row of queued) {
    const message = row.message as { type: string; terminalId?: string; runId?: string };
    if (message.type === "start_terminal" && message.terminalId) {
      const id = ctx.db.normalizeId("terminals", message.terminalId);
      const terminal = id ? await ctx.db.get(id) : null;
      if (terminal && terminal.status === "starting") {
        await ctx.db.patch(terminal._id, { status: "failed", failReason: reason, endedAt: Date.now() });
        await endTerminal(ctx, (await ctx.db.get(terminal._id))!, "failed");
      }
      await ctx.db.delete(row._id);
    } else if (message.type === "start_thread" && message.runId) {
      const id = ctx.db.normalizeId("runs", message.runId);
      const run = id ? await ctx.db.get(id) : null;
      if (run && run.state !== "done" && run.state !== "failed" && run.state !== "stopped") {
        await setRunState(ctx, run._id, "failed", undefined);
        await ctx.db.patch(run._id, { failReason: reason });
      }
      await ctx.db.delete(row._id);
    }
  }
}

/**
 * Terminal and thread-run starts still queued for the bridge. They never
 * reached a session: while a machine stops its queue is held, so starts made
 * then wait here for the next boot.
 */
export async function queuedStarts(ctx: QueryCtx, machineId: Id<"machines">) {
  const terminals = new Set<string>();
  const runs = new Set<string>();
  for await (const row of ctx.db.query("bridgeOutbox").withIndex("by_machine_seq", (q) => q.eq("machineId", machineId))) {
    const message = row.message as { type: string; terminalId?: string; runId?: string };
    if (message.type === "start_terminal" && message.terminalId) terminals.add(message.terminalId);
    if (message.type === "start_thread" && message.runId) runs.add(message.runId);
  }
  return { terminals, runs, any: terminals.size + runs.size > 0 };
}

/**
 * The box is gone at the provider: whatever reached its session ended with it.
 * A stopped machine is not a suspended run, so nothing comes back on the next
 * boot. Starts still queued never reached that session; they stay queued for
 * the next boot.
 */
export async function endWorkOnStoppedBox(ctx: MutationCtx, machineId: Id<"machines">, reason: string): Promise<void> {
  const queued = await queuedStarts(ctx, machineId);
  const terminals = await ctx.db
    .query("terminals")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  for (const terminal of terminals) {
    if (!isLive(terminal)) continue;
    if (terminal.status === "starting" && queued.terminals.has(terminal._id)) continue;
    await ctx.db.patch(terminal._id, { status: "failed", failReason: reason, endedAt: Date.now() });
    await endTerminal(ctx, (await ctx.db.get(terminal._id))!, "failed");
  }
  await endLiveSpaces(ctx, machineId);
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machineId))
    .collect();
  for (const run of runs) {
    if (queued.runs.has(run._id)) continue;
    if (run.threadRef !== undefined && run.state !== "done" && run.state !== "failed" && run.state !== "stopped") {
      await setRunState(ctx, run._id, "stopped", undefined);
    }
  }
}

/**
 * A profile expired or was deleted while the machine's box is down, so its
 * disk and snapshot may still hold the profile's logins. The machine starts so
 * its bridge deletes it; the next idle stop saves the cleaned disk and deletes
 * the older snapshot. Until a bridge registers, a failed wake is retried.
 */
export async function wakeForMaintenance(ctx: MutationCtx, machineId: Id<"machines">): Promise<void> {
  const cloud = await cloudFor(ctx, machineId);
  if (!cloud || cloud.state === "deleting" || cloud.state === "deleted") return;
  // A connected bridge deletes it itself. Otherwise (the machine is down, starting, or "running"
  // with a quiet bridge, as when the provider stopped the box before the room noticed) the cleanup
  // is owed until a bridge registers; if the start under way fails, the retry still happens.
  if (cloud.state === "running") {
    const machine = await ctx.db.get(machineId);
    if (machine && isOnline(machine, Date.now())) return;
  }
  await ctx.db.patch(cloud._id, { maintenancePending: true });
  if (cloud.state === "stopped" || cloud.state === "stopping" || cloud.state === "failed") {
    await wake(ctx, (await ctx.db.get(cloud._id))!, "maintenance");
  }
}

/**
 * When the room learns a box stopped: does it still owe the disk a profile cleanup? Yes if a
 * profile expired after the bridge was last heard from (it may have died before deleting it, even
 * while it still looked online), or a profile deletion is still queued for the bridge.
 */
export async function owesProfileCleanup(ctx: QueryCtx, machineId: Id<"machines">): Promise<boolean> {
  const machine = await ctx.db.get(machineId);
  const lastSeenAt = machine?.lastSeenAt ?? 0;
  const profiles = await ctx.db
    .query("profiles")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  if (profiles.some((p) => p.status === "expired" && p.expiresAt > lastSeenAt)) return true;
  for await (const row of ctx.db.query("bridgeOutbox").withIndex("by_machine_seq", (q) => q.eq("machineId", machineId))) {
    if ((row.message as { type: string }).type === "delete_profile") return true;
  }
  return false;
}

/** Backoff for maintenance wakes that didn't reach a bridge: 10 minutes, doubling, up to 6 hours. */
export function maintenanceBackoff(attempt: number): number {
  return Math.min(10 * MINUTE * 2 ** attempt, 6 * 60 * MINUTE);
}

export function cloudView(cloud: Cloud) {
  return {
    state: cloud.state,
    provider: cloud.provider,
    region: cloud.region,
    vcpus: cloud.vcpus,
    idleMinutes: cloud.idleMinutes,
    resourceName: cloud.resourceName,
    stateChangedAt: cloud.stateChangedAt,
    wakeReason: cloud.wakeReason,
    stopReason: cloud.stopReason,
    lastError: cloud.lastError,
    runningSince: cloud.runningSince,
    stoppedAt: cloud.stoppedAt,
    /** When the idle stop happens if nothing starts before then. Unset while not running. */
    stopsIdleAt:
      cloud.state === "running" && cloud.lastBusyAt !== undefined
        ? cloud.lastBusyAt + cloud.idleMinutes * MINUTE
        : undefined,
    sessionEndsAt: cloud.sessionEndsAt,
    /** A start came while it was stopping: it starts again once stopped. */
    startsAfterStop: cloud.wakeAfterStop === true,
    /** Failed because its stop ran out of tries: the box may still run. The room keeps stopping it. */
    stopFailed: cloud.stopGaveUp === true,
  };
}

export type CloudView = ReturnType<typeof cloudView>;

/** The provider's name for a machine's box. Vercel names are unique per project. */
export function resourceNameFor(machineId: Id<"machines">): string {
  return `uplink-${machineId}`;
}

/** How long after scheduling a delete attempt its guard checks that the attempt reported back. */
export const DELETE_GUARD_MS = 10 * MINUTE;

/**
 * Starts delete attempt n+1 after `delayMs`. Attempts are numbered: only the
 * current attempt's failure schedules the next, so a manual retry while one is
 * in flight can't start a second chain. A guard set with each attempt starts
 * the next one if this attempt's action dies without reporting back (Convex
 * runs a scheduled action at most once).
 */
export async function startDeleteAttempt(ctx: MutationCtx, cloud: Cloud, delayMs = 0): Promise<void> {
  const attempt = (cloud.deleteAttempt ?? 0) + 1;
  const retryId = await ctx.scheduler.runAfter(delayMs, internal.cloudMachineActions.deleteAtProvider, {
    cloudId: cloud._id,
    generation: cloud.generation,
    attempt,
  });
  await ctx.scheduler.runAfter(delayMs + DELETE_GUARD_MS, internal.cloudMachines.deleteGuard, { cloudId: cloud._id, attempt });
  await ctx.db.patch(cloud._id, { deleteAttempt: attempt, retryId, lastProgressAt: Date.now() });
}

/** A reconcile run soon after a provider action, in addition to the cron's run every 5 minutes. */
export const RECONCILE_SOON_MS = 20 * 1000;

/** Asks for a reconcile run soon. Many asks while one is pending share it. */
export async function kickReconcile(ctx: MutationCtx): Promise<void> {
  const row = await ctx.db
    .query("cloudReconciler")
    .withIndex("by_key", (q) => q.eq("key", "main"))
    .unique();
  if (row?.pendingId) {
    const job = await ctx.db.system.get("_scheduled_functions", row.pendingId);
    if (job && job.state.kind === "pending") return;
  }
  const pendingId = await ctx.scheduler.runAfter(RECONCILE_SOON_MS, internal.cloudMachineActions.reconcileAll, {});
  if (row) await ctx.db.patch(row._id, { pendingId });
  else await ctx.db.insert("cloudReconciler", { key: "main", pendingId });
}
