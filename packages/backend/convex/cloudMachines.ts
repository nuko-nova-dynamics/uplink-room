/**
 * Cloud machines (#10, ADR 0013): persistent team machines the room starts on
 * demand at a provider (Vercel Sandbox in `iad1`, Linux) and stops after 15
 * minutes with no live work.
 *
 * A cloud machine is an ordinary team machine: same settings, slots, access
 * and machine-bound profiles. Only admins make, stop and delete one; anyone
 * who may start runs may start one, and starting a terminal or run on a
 * stopped one starts it first (`lib/cloudMachines.ts`). Provider calls happen
 * in the Node actions of `cloudMachineActions.ts`; their results come back
 * through the internal mutations at the end of this file.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAdmin } from "./lib/actor";
import {
  CLOUD_ENV_VARS,
  CLOUD_PROVIDER,
  CLOUD_REGION,
  missingCloudEnv,
} from "./lib/cloudProvider";
import {
  beginStop,
  BRIDGE_WAIT_MS,
  cancelJobs,
  CHECK_EVERY_MS,
  cloudFor,
  cloudView,
  DEFAULT_VCPUS,
  endWorkOnStoppedBox,
  EXTEND_WHEN_LEFT_MS,
  failWaitingWork,
  IDLE_MINUTES,
  liveWork,
  maintenanceBackoff,
  MAX_ATTEMPTS,
  owesProfileCleanup,
  queuedStarts,
  RECONCILE_EVERY_MS,
  resourceNameFor,
  SESSION_MS,
  VCPU_CHOICES,
  kickReconcile,
  startDeleteAttempt,
  wake,
  watchStart,
  type Cloud,
} from "./lib/cloudMachines";
import { planReconcile } from "./lib/cloudReconcile";
import { pairingCode, sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { defaultSettings, isOnline, ONLINE_WINDOW_MS } from "./lib/machines";
import { audit, inTeam } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { endLiveSpaces } from "./lib/spaces";
import { endLiveTerminals, stopActiveRuns } from "./machines";

const MINUTE = 60 * 1000;
const PAIRING_CODE_TTL_MS = 10 * MINUTE;
/** After a confirmed delete, the provider is asked again this much later. */
const VERIFY_DELETED_AFTER_MS = 20 * MINUTE;
/** An extension request with no answer after this long counts as lost and is asked again. */
const EXTEND_IN_FLIGHT_MS = 2 * MINUTE;
/** Retries of a failed stop or delete: 10 s, 20 s, 40 s ... up to 30 minutes. */
const retryDelay = (attempt: number) => Math.min(5_000 * 2 ** attempt, 30 * MINUTE);


async function requireCloud(ctx: QueryCtx, machine: Doc<"machines">): Promise<Cloud> {
  const cloud = await cloudFor(ctx, machine._id);
  if (!cloud) throw roomError("invalid", `${machine.name} isn't a cloud machine.`);
  return cloud;
}

// ---------------------------------------------------------------------------
// Reading

export const { person: settings, agent: settingsAgent } = roomQuery({
  name: "cloudMachines.settings",
  description:
    "Whether cloud machines are configured (and which Convex environment variables are missing), the provider and region they start in, their size, how long they stay up with no live work, deletes the provider hasn't confirmed yet (`deleting`, with their last error), and machines whose stop ran out of tries, so their box may still run (`notStopped`).",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const missing = missingCloudEnv();
    // Deletes still going on: the provider hasn't confirmed the box is gone, so it may still bill.
    const rows = await ctx.db
      .query("cloudMachines")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    const deleting = await Promise.all(
      rows
        .filter((c) => c.state === "deleting")
        .map(async (c) => ({
          machineId: c.machineId,
          name: (await ctx.db.get(c.machineId))?.name ?? c.resourceName,
          since: c.stateChangedAt,
          attempts: c.attempts ?? 0,
          lastError: c.lastError,
        })),
    );
    // Stops that ran out of tries: the box may still run, and bill, until the reconciler stops it.
    const notStopped = await Promise.all(
      rows
        .filter((c) => c.state === "failed" && c.stopGaveUp)
        .map(async (c) => ({
          machineId: c.machineId,
          name: (await ctx.db.get(c.machineId))?.name ?? c.resourceName,
          since: c.stateChangedAt,
          lastError: c.lastError,
        })),
    );
    return {
      deleting,
      notStopped,
      configured: missing.length === 0,
      missing,
      envVars: [...CLOUD_ENV_VARS],
      provider: CLOUD_PROVIDER,
      region: CLOUD_REGION,
      os: "linux",
      vcpus: DEFAULT_VCPUS,
      vcpuChoices: [...VCPU_CHOICES],
      idleMinutes: IDLE_MINUTES,
    };
  },
});

export const { person: status, agent: statusAgent } = roomQuery({
  name: "cloudMachines.status",
  description:
    "A cloud machine's state at its provider: creating, starting, running, stopping, stopped, failed, deleting or deleted, with why it last started or stopped, its last error, and when the idle stop happens.",
  scope: "room.read",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    return cloudView(await requireCloud(ctx, machine));
  },
});

// ---------------------------------------------------------------------------
// Making, starting, stopping and deleting

export const { person: create, agent: createAgent } = roomMutation({
  name: "cloudMachines.create",
  description:
    "Admins only. Make a cloud machine: a Linux team machine on Vercel Sandbox in iad1 that keeps its disk, settings and profiles when stopped. It starts now to install and pair its bridge, starts again whenever a terminal or run needs it, and stops after 15 minutes with no live work. vcpus: 1, 2 (default), 4 or 8, with 2 GB of memory each.",
  scope: "machines.manage",
  args: { name: v.string(), vcpus: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const missing = missingCloudEnv();
    if (missing.length > 0) {
      throw roomError(
        "not_configured",
        `Cloud machines aren't configured yet. An admin sets ${missing.join(", ")} in the Convex environment.`,
      );
    }
    const vcpus = args.vcpus ?? DEFAULT_VCPUS;
    if (!(VCPU_CHOICES as readonly number[]).includes(vcpus)) {
      throw roomError("invalid", `A cloud machine has ${VCPU_CHOICES.join(", ")} vCPUs.`);
    }
    const now = Date.now();
    const machineId = await ctx.db.insert("machines", {
      teamId: actor.teamId,
      name: args.name.trim() || "Cloud machine",
      belongsTo: { kind: "team" },
      linkedBy: actor.accountable?._id ?? actor.member._id,
      ...defaultSettings(true),
      os: "linux",
      tools: [],
    });
    const cloudId = await ctx.db.insert("cloudMachines", {
      teamId: actor.teamId,
      machineId,
      provider: CLOUD_PROVIDER,
      resourceName: resourceNameFor(machineId),
      region: CLOUD_REGION,
      vcpus,
      idleMinutes: IDLE_MINUTES,
      createdBy: actor.member._id,
      state: "creating",
      stateChangedAt: now,
      generation: 1,
      wakeReason: "create",
      attempts: 0,
    });
    await watchStart(ctx, cloudId, 1, "creating");
    await ctx.scheduler.runAfter(0, internal.cloudMachineActions.provision, { cloudId, generation: 1 });
    await audit(ctx, actor, "cloud_machine.created", machineId, { provider: CLOUD_PROVIDER, region: CLOUD_REGION, vcpus });
    return machineId;
  },
});

export const { person: start, agent: startAgent } = roomMutation({
  name: "cloudMachines.start",
  description:
    "Start a stopped cloud machine from its kept disk. You rarely need this: starting a terminal or run on a stopped cloud machine starts it, waits for its bridge, then goes on. Its bridge starts again on boot; runs that were going when it stopped don't come back.",
  scope: "runs.start",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    const cloud = await requireCloud(ctx, machine);
    await wake(ctx, cloud, "start");
    await audit(ctx, actor, "cloud_machine.started", machine._id);
    return null;
  },
});

export const { person: stop, agent: stopAgent } = roomMutation({
  name: "cloudMachines.stop",
  description:
    "Admins only. Stop a cloud machine now, keeping its disk, settings and profiles. Its live terminals end and its runs stop; they don't come back when it starts again. It also stops by itself after 15 minutes with no live work.",
  scope: "machines.manage",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const machine = await inTeam(ctx, actor, args.machineId);
    const cloud = await requireCloud(ctx, machine);
    if (cloud.state === "deleting" || cloud.state === "deleted") throw roomError("invalid", "This cloud machine was deleted.");
    if (cloud.state === "stopping") {
      // Already stopping: the stop also cancels work queued for the next boot, or it would start the box again.
      if (cloud.wakeAfterStop) await ctx.db.patch(cloud._id, { wakeAfterStop: undefined });
      await failWaitingWork(ctx, machine._id, "An admin stopped the cloud machine before this started.");
      await audit(ctx, actor, "cloud_machine.stopped", machine._id);
      return null;
    }
    if (cloud.state === "stopped") return null;
    await endLiveTerminals(ctx, machine._id);
    await endLiveSpaces(ctx, machine._id);
    await stopActiveRuns(ctx, machine._id);
    await failWaitingWork(ctx, machine._id, "An admin stopped the cloud machine before this started.");
    await beginStop(ctx, cloud, "admin");
    await audit(ctx, actor, "cloud_machine.stopped", machine._id);
    return null;
  },
});

export const { person: remove, agent: removeAgent } = roomMutation({
  name: "cloudMachines.remove",
  description:
    "Admins only. Delete a cloud machine: its box, its disk snapshots and every profile on it. The machine is unlinked and its bridge token revoked at once. This can't be undone. On a machine still being deleted, it retries the delete at the provider now.",
  scope: "machines.manage",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const machine = await inTeam(ctx, actor, args.machineId);
    const cloud = await requireCloud(ctx, machine);
    if (cloud.state === "deleted") return null;
    if (cloud.state === "deleting") {
      // Retry now as a new attempt. An attempt still in flight is superseded: its failure no longer
      // schedules anything, so only one chain of attempts runs.
      await cancelJobs(ctx, cloud);
      await ctx.db.patch(cloud._id, { attempts: 0, retryId: undefined });
      await startDeleteAttempt(ctx, (await ctx.db.get(cloud._id))!);
      await audit(ctx, actor, "cloud_machine.delete_retried", machine._id);
      return null;
    }
    await endLiveTerminals(ctx, machine._id);
    await endLiveSpaces(ctx, machine._id);
    await stopActiveRuns(ctx, machine._id);
    await failWaitingWork(ctx, machine._id, "The cloud machine was deleted.");
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    for (const p of profiles) {
      if (p.status === "creating" || p.status === "ready") await ctx.db.patch(p._id, { status: "deleted" });
    }
    // Unlinked: the bridge gets `unlink`, and its token stops working.
    await ctx.db.patch(machine._id, { unlinkedAt: Date.now() });
    const generation = cloud.generation + 1;
    await cancelJobs(ctx, cloud);
    await ctx.db.patch(cloud._id, {
      state: "deleting",
      stateChangedAt: Date.now(),
      generation,
      attempts: 0,
      wakeAfterStop: undefined,
      idleCheckId: undefined,
      bridgeWaitId: undefined,
      retryId: undefined,
      maintenancePending: undefined,
    });
    await startDeleteAttempt(ctx, (await ctx.db.get(cloud._id))!);
    await audit(ctx, actor, "cloud_machine.deleted", machine._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// The idle stop

/**
 * Runs every minute while a machine runs. It records when live work was last
 * seen, stops the machine once there was none for `idleMinutes`, extends the
 * provider session while work goes on, and asks the provider about the box
 * when the bridge has gone quiet.
 */
export const idleCheck = internalMutation({
  args: { cloudId: v.id("cloudMachines") },
  handler: async (ctx, { cloudId }) => {
    const cloud = await ctx.db.get(cloudId);
    if (!cloud) return null;
    if (cloud.state !== "running") {
      await ctx.db.patch(cloud._id, { idleCheckId: undefined });
      return null;
    }
    const machine = await ctx.db.get(cloud.machineId);
    if (!machine) return null;
    const now = Date.now();
    const idleMs = cloud.idleMinutes * MINUTE;
    // A terminal can't be live without its bridge: a bridge quiet for the whole idle time keeps nothing awake.
    const quietFor = now - (machine.lastSeenAt ?? 0);
    const work = quietFor >= idleMs ? null : await liveWork(ctx, machine._id);
    const lastBusyAt = work ? now : (cloud.lastBusyAt ?? cloud.runningSince ?? now);
    if (!work && now - lastBusyAt >= idleMs) {
      await ctx.db.patch(cloud._id, { lastBusyAt, idleCheckId: undefined });
      await beginStop(ctx, (await ctx.db.get(cloud._id))!, "idle");
      return null;
    }
    const patch: Partial<Cloud> = { lastBusyAt };
    // The deadline moves only when the provider accepts the extension (`providerExtended`). One
    // request is in flight at a time; a failed one is asked again at the next check.
    const extending = cloud.extendRequestedAt !== undefined && now - cloud.extendRequestedAt < EXTEND_IN_FLIGHT_MS;
    if (work && !extending && cloud.sessionEndsAt !== undefined && cloud.sessionEndsAt - now < EXTEND_WHEN_LEFT_MS) {
      patch.extendRequestedAt = now;
      await ctx.scheduler.runAfter(0, internal.cloudMachineActions.extendAtProvider, {
        cloudId: cloud._id,
        generation: cloud.generation,
        from: cloud.sessionEndsAt,
        ms: SESSION_MS,
      });
    }
    if (
      !isOnline(machine, now) &&
      quietFor >= ONLINE_WINDOW_MS &&
      (cloud.lastReconcileAt === undefined || now - cloud.lastReconcileAt >= RECONCILE_EVERY_MS)
    ) {
      patch.lastReconcileAt = now;
      await ctx.scheduler.runAfter(0, internal.cloudMachineActions.reconcile, {
        cloudId: cloud._id,
        generation: cloud.generation,
      });
    }
    patch.idleCheckId = await ctx.scheduler.runAfter(CHECK_EVERY_MS, internal.cloudMachines.idleCheck, { cloudId });
    await ctx.db.patch(cloud._id, patch);
    return null;
  },
});

// ---------------------------------------------------------------------------
// For the provider actions

export const forAction = internalQuery({
  args: { cloudId: v.id("cloudMachines") },
  handler: async (ctx, { cloudId }) => {
    const cloud = await ctx.db.get(cloudId);
    if (!cloud) return null;
    return { cloud, machine: await ctx.db.get(cloud.machineId) };
  },
});

/** Whether a provider call for `generation` should still go ahead. */
async function current(ctx: QueryCtx, cloudId: Id<"cloudMachines">, generation: number) {
  const cloud = await ctx.db.get(cloudId);
  return cloud && cloud.generation === generation ? cloud : null;
}

/**
 * A one-time pairing code for this boot, bound to the machine the room
 * already made. It works only if the box's disk has no pairing yet (its first
 * boot, or a fresh disk); otherwise it expires unused in 10 minutes.
 */
export const pairingCodeFor = internalMutation({
  args: { cloudId: v.id("cloudMachines"), generation: v.number() },
  handler: async (ctx, { cloudId, generation }) => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud) return null;
    const machine = await ctx.db.get(cloud.machineId);
    if (!machine || machine.unlinkedAt !== undefined) return null;
    const code = pairingCode();
    await ctx.db.insert("pairingCodes", {
      teamId: cloud.teamId,
      codeHash: await sha256(code),
      createdBy: cloud.createdBy,
      belongsTo: { kind: "team" },
      name: machine.name,
      expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
      machineId: machine._id,
    });
    return code;
  },
});

/**
 * The provider booted the box and ran the boot step; the watchdog set at the
 * wake keeps waiting for the bridge. Returns whether this boot is still the
 * machine's current operation, so a superseded action can undo what it did.
 */
export const providerStarted = internalMutation({
  args: { cloudId: v.id("cloudMachines"), generation: v.number() },
  handler: async (ctx, { cloudId, generation }): Promise<boolean> => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud || (cloud.state !== "creating" && cloud.state !== "starting" && cloud.state !== "running")) {
      await kickReconcile(ctx);
      return false;
    }
    await ctx.db.patch(cloud._id, { sessionEndsAt: Date.now() + SESSION_MS, attempts: 0, bootedGeneration: generation });
    await kickReconcile(ctx);
    return true;
  },
});

/** The provider accepted an extension: the deadline moves now, and only now. */
export const providerExtended = internalMutation({
  args: { cloudId: v.id("cloudMachines"), generation: v.number(), from: v.number(), ms: v.number() },
  handler: async (ctx, { cloudId, generation, from, ms }) => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud) return null;
    await ctx.db.patch(cloud._id, {
      sessionEndsAt: Math.max(cloud.sessionEndsAt ?? 0, from + ms),
      extendRequestedAt: undefined,
    });
    return null;
  },
});

/** The bridge didn't register after a boot: fail what waited, and stop the box so it costs nothing. */
export const bridgeWaitExpired = internalMutation({
  args: { cloudId: v.id("cloudMachines"), generation: v.number() },
  handler: async (ctx, { cloudId, generation }) => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud || (cloud.state !== "creating" && cloud.state !== "starting")) return null;
    const minutes = Math.round(BRIDGE_WAIT_MS[cloud.state] / MINUTE);
    const reason = `The cloud machine's bridge didn't come back within ${minutes} minutes of the start: the provider didn't finish starting it, or the bridge didn't connect. Its boot log is ~/.uplink-room/boot.log on the machine.`;
    await failWaitingWork(ctx, cloud.machineId, "The cloud machine couldn't start its bridge.");
    await ctx.db.patch(cloud._id, { bridgeWaitId: undefined });
    await beginStop(ctx, (await ctx.db.get(cloud._id))!, "bridge_missing", reason);
    return null;
  },
});

/** A provider call threw. */
export const providerFailed = internalMutation({
  args: {
    cloudId: v.id("cloudMachines"),
    generation: v.number(),
    op: v.union(v.literal("create"), v.literal("start"), v.literal("stop"), v.literal("extend"), v.literal("delete")),
    error: v.string(),
    /** For a delete: which attempt failed. A superseded attempt's failure changes nothing. */
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { cloudId, generation, op, error, attempt }) => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud) return null;
    if (op !== "extend") await kickReconcile(ctx);
    const lastError = error.slice(0, 500);
    if (op === "extend") {
      // The deadline stays where it is; the next idle check asks again.
      await ctx.db.patch(cloud._id, { lastError: `Couldn't extend the session: ${lastError}`, extendRequestedAt: undefined });
      return null;
    }
    if (op === "create" || op === "start") {
      if (cloud.state !== "creating" && cloud.state !== "starting") return null;
      await failWaitingWork(ctx, cloud.machineId, `The cloud machine couldn't start: ${lastError}`);
      // The box may be half up: make sure it is stopped, and show the start's error.
      await beginStop(ctx, cloud, "start_failed", lastError);
      return null;
    }
    const attempts = (cloud.attempts ?? 0) + 1;
    if (op === "delete") {
      // A delete never gives up: until the provider confirms the box is gone it may bill, and its
      // snapshot holds the machine's logins. It stays `deleting`, listed in `cloudMachines.settings`.
      if (cloud.state !== "deleting" || attempt !== cloud.deleteAttempt) return null;
      await ctx.db.patch(cloud._id, {
        attempts,
        lastError: `Couldn't delete the box at the provider yet (${attempts} tries; still trying): ${lastError}`,
      });
      await startDeleteAttempt(ctx, (await ctx.db.get(cloud._id))!, retryDelay(attempts));
      return null;
    }
    // A stop retries with backoff, then shows as failed, so Start isn't held behind it. The box may
    // still run: the reconciler keeps stopping it, and settles the machine once it is down
    // (`stopSettled`). Stop or Start retries at once.
    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(cloud._id, {
        attempts,
        state: "failed",
        stateChangedAt: Date.now(),
        retryId: undefined,
        stopGaveUp: true,
        lastError: `Couldn't stop the box at the provider after ${attempts} tries, so it may still cost money. The room keeps trying every 5 minutes. ${lastError}`,
      });
      // A profile cleanup owed (a profile expired while it stopped) is retried with backoff, as after
      // a stop that ends failed.
      if (cloud.maintenancePending || (await owesProfileCleanup(ctx, cloud.machineId))) {
        await ctx.db.patch(cloud._id, { maintenancePending: true });
        await scheduleMaintenanceRetry(ctx, (await ctx.db.get(cloud._id))!);
      }
      return null;
    }
    const retryId = await ctx.scheduler.runAfter(retryDelay(attempts), internal.cloudMachineActions.stopAtProvider, {
      cloudId,
      generation,
    });
    await ctx.db.patch(cloud._id, { attempts, lastError, retryId, lastProgressAt: Date.now() });
    return null;
  },
});

/** After a stop: the provider's answer about the box. */
export const providerStopped = internalMutation({
  args: {
    cloudId: v.id("cloudMachines"),
    generation: v.number(),
    providerState: v.union(
      v.literal("starting"),
      v.literal("running"),
      v.literal("stopping"),
      v.literal("stopped"),
      v.literal("failed"),
      v.literal("missing"),
    ),
  },
  handler: async (ctx, { cloudId, generation, providerState }) => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud || cloud.state !== "stopping") return null;
    if (providerState !== "stopped" && providerState !== "missing" && providerState !== "failed") {
      // Still saving its disk: ask again shortly. Offline or a stop request alone doesn't prove it stopped.
      await ctx.scheduler.runAfter(10_000, internal.cloudMachineActions.stopAtProvider, { cloudId, generation });
      await ctx.db.patch(cloud._id, { lastProgressAt: Date.now() });
      return null;
    }
    await stopSettled(ctx, cloud);
    return null;
  },
});

/**
 * A stop's box is confirmed down: after the stop's own check, or, for a stop
 * that ran out of tries, when the reconciler sees the box down. The machine
 * settles stopped (or failed, when it stopped because a start failed), and
 * work or a profile cleanup owed starts it again.
 */
async function stopSettled(ctx: MutationCtx, cloud: Cloud) {
  const failed = cloud.stopReason === "bridge_missing" || cloud.stopReason === "start_failed";
  await ctx.db.patch(cloud._id, {
    state: failed ? "failed" : "stopped",
    stateChangedAt: Date.now(),
    stoppedAt: Date.now(),
    sessionEndsAt: undefined,
    runningSince: undefined,
    attempts: 0,
    stopGaveUp: undefined,
    ...(failed ? {} : { lastError: undefined }),
  });
  await endWorkOnStoppedBox(ctx, cloud.machineId, "The cloud machine stopped.");
  await kickReconcile(ctx);
  const owes = cloud.maintenancePending || (await owesProfileCleanup(ctx, cloud.machineId));
  if (owes && !cloud.maintenancePending) await ctx.db.patch(cloud._id, { maintenancePending: true });
  // Work queued while it stopped waits for the next boot, so it starts again right away.
  if (cloud.wakeAfterStop || (await queuedStarts(ctx, cloud.machineId)).any) {
    await ctx.db.patch(cloud._id, { wakeAfterStop: undefined });
    await wake(ctx, (await ctx.db.get(cloud._id))!, cloud.wakeAfterStop ? (cloud.wakeReason ?? "work") : "work");
    return;
  }
  if (owes) {
    // A failed machine retries with backoff; a stopped one starts now so its bridge cleans the disk.
    if (failed) await scheduleMaintenanceRetry(ctx, (await ctx.db.get(cloud._id))!);
    else await wake(ctx, (await ctx.db.get(cloud._id))!, "maintenance");
  }
}

/** The provider's answer when the room asked about a running machine whose bridge went quiet. */
export const reconciled = internalMutation({
  args: {
    cloudId: v.id("cloudMachines"),
    generation: v.number(),
    providerState: v.union(
      v.literal("starting"),
      v.literal("running"),
      v.literal("stopping"),
      v.literal("stopped"),
      v.literal("failed"),
      v.literal("missing"),
    ),
  },
  handler: async (ctx, { cloudId, generation, providerState }) => {
    await boxGone(ctx, cloudId, generation, providerState);
    return null;
  },
});

/** A running machine's box isn't running at the provider: the room marks it stopped and ends what ran there. */
async function boxGone(ctx: MutationCtx, cloudId: Id<"cloudMachines">, generation: number, providerState: string) {
  {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud || cloud.state !== "running") return null;
    if (providerState === "running" || providerState === "starting") return null;
    await cancelJobs(ctx, cloud);
    await ctx.db.patch(cloud._id, {
      state: "stopped",
      stateChangedAt: Date.now(),
      stopReason: "provider",
      stoppedAt: Date.now(),
      generation: cloud.generation + 1,
      sessionEndsAt: undefined,
      runningSince: undefined,
      idleCheckId: undefined,
    });
    await endWorkOnStoppedBox(ctx, cloud.machineId, "The cloud machine stopped at its provider.");
    if (cloud.maintenancePending || (await owesProfileCleanup(ctx, cloud.machineId))) {
      await ctx.db.patch(cloud._id, { maintenancePending: true });
    }
    const after = (await ctx.db.get(cloud._id))!;
    if ((await queuedStarts(ctx, cloud.machineId)).any) await wake(ctx, after, "work");
    else if (after.maintenancePending) await wake(ctx, after, "maintenance");
    return null;
  }
}

export const providerDeleted = internalMutation({
  // Any attempt's confirmation counts: the provider no longer knowing the box is true whichever attempt asked.
  args: {
    cloudId: v.id("cloudMachines"),
    generation: v.number(),
    attempt: v.optional(v.number()),
    snapshotIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { cloudId, generation, snapshotIds }) => {
    const cloud = await current(ctx, cloudId, generation);
    if (!cloud || cloud.state !== "deleting") return null;
    await ctx.db.patch(cloud._id, {
      state: "deleted",
      stateChangedAt: Date.now(),
      lastError: undefined,
      attempts: 0,
      retryId: undefined,
      ...(snapshotIds && snapshotIds.length > 0 ? { snapshotIds } : {}),
    });
    await kickReconcile(ctx);
    // A create or start that was in flight may still make the box after this. Its action undoes that,
    // but an action can die; so the provider is asked once more a while later.
    await ctx.scheduler.runAfter(VERIFY_DELETED_AFTER_MS, internal.cloudMachineActions.verifyDeleted, { cloudId });
    return null;
  },
});

/** A maintenance wake didn't reach a bridge: try again later, with backoff, until one does. */
async function scheduleMaintenanceRetry(ctx: MutationCtx, cloud: Cloud) {
  const attempts = (cloud.maintenanceAttempts ?? 0) + 1;
  await ctx.scheduler.runAfter(maintenanceBackoff(attempts - 1), internal.cloudMachines.maintenanceRetry, {
    cloudId: cloud._id,
  });
  await ctx.db.patch(cloud._id, { maintenanceAttempts: attempts });
}

export const maintenanceRetry = internalMutation({
  args: { cloudId: v.id("cloudMachines") },
  handler: async (ctx, { cloudId }) => {
    const cloud = await ctx.db.get(cloudId);
    if (!cloud || !cloud.maintenancePending) return null;
    if (cloud.state !== "stopped" && cloud.state !== "failed") return null;
    await wake(ctx, cloud, "maintenance");
    return null;
  },
});

/** A deleted machine's box was found again at the provider: go back to deleting it until it's gone. */
export const deleteReappeared = internalMutation({
  args: { cloudId: v.id("cloudMachines") },
  handler: async (ctx, { cloudId }) => {
    const cloud = await ctx.db.get(cloudId);
    if (!cloud || cloud.state !== "deleted") return null;
    const generation = cloud.generation + 1;
    await ctx.db.patch(cloud._id, {
      state: "deleting",
      stateChangedAt: Date.now(),
      generation,
      attempts: 0,
      lastError: "The box was still at the provider after its delete; deleting it again.",
    });
    await startDeleteAttempt(ctx, (await ctx.db.get(cloud._id))!);
    return null;
  },
});

/** A delete attempt's action didn't report back in time (it died): start the next attempt. */
export const deleteGuard = internalMutation({
  args: { cloudId: v.id("cloudMachines"), attempt: v.number() },
  handler: async (ctx, { cloudId, attempt }) => {
    const cloud = await ctx.db.get(cloudId);
    if (!cloud || cloud.state !== "deleting" || cloud.deleteAttempt !== attempt) return null;
    await startDeleteAttempt(ctx, cloud);
    return null;
  },
});

// ---------------------------------------------------------------------------
// The reconciler (ADR 0013): the safety net under every provider action

const vProviderState = v.union(
  v.literal("starting"),
  v.literal("running"),
  v.literal("stopping"),
  v.literal("stopped"),
  v.literal("failed"),
  v.literal("missing"),
);

/**
 * Compares the boxes the provider really has (this room's only) with what
 * the room wants, applies the room's side of the plan here, atomically, and
 * returns the provider calls for the action to make.
 */
export const reconcileRoom = internalMutation({
  args: {
    boxes: v.array(v.object({ name: v.string(), state: vProviderState })),
    /** When the provider listing began. A machine that changed state since is left for the next pass. */
    listedAt: v.number(),
  },
  handler: async (ctx, { boxes, listedAt }) => {
    const now = Date.now();
    const rows = await ctx.db.query("cloudMachines").collect();
    const plan = planReconcile(
      boxes,
      rows.map((r) => ({
        cloudId: r._id,
        resourceName: r.resourceName,
        state: r.state,
        generation: r.generation,
        ...(r.bootedGeneration === undefined ? {} : { bootedGeneration: r.bootedGeneration }),
        stateChangedAt: r.stateChangedAt,
        ...(r.lastProgressAt === undefined ? {} : { lastProgressAt: r.lastProgressAt }),
        ...(r.snapshotsSweptAt === undefined ? {} : { snapshotsSweptAt: r.snapshotsSweptAt }),
        ...(r.stateChangedAt >= listedAt ? { fenced: true } : {}),
      })),
      now,
    );
    const sweeps: { cloudId: Id<"cloudMachines">; name: string; snapshotIds: string[] }[] = [];
    for (const op of plan.room) {
      const cloudId = op.cloudId as Id<"cloudMachines">;
      const cloud = await ctx.db.get(cloudId);
      if (!cloud) continue;
      if (op.op === "sweepSnapshots") {
        sweeps.push({ cloudId, name: op.name, snapshotIds: cloud.snapshotIds ?? [] });
        continue;
      }
      if (cloud.generation !== op.generation) continue;
      if (op.op === "restartBoot") {
        // Boot it again for the same generation; the watchdog set at the wake still bounds it.
        await ctx.db.patch(cloud._id, { bootedGeneration: undefined });
        const action = cloud.state === "creating" ? internal.cloudMachineActions.provision : internal.cloudMachineActions.startAtProvider;
        await ctx.scheduler.runAfter(0, action, { cloudId, generation: cloud.generation });
      } else if (op.op === "boxGone") {
        await boxGone(ctx, cloudId, cloud.generation, op.providerState);
      } else if (op.op === "restartStop") {
        await ctx.db.patch(cloud._id, { lastProgressAt: now, attempts: 0 });
        await ctx.scheduler.runAfter(0, internal.cloudMachineActions.stopAtProvider, { cloudId, generation: cloud.generation });
      } else if (op.op === "restartDelete") {
        await startDeleteAttempt(ctx, cloud);
      } else if (op.op === "settleStopped") {
        // A stop that ran out of tries is now done: the machine settles as after any stop.
        if (cloud.stopGaveUp) await stopSettled(ctx, cloud);
        else await endWorkOnStoppedBox(ctx, cloud.machineId, "The cloud machine stopped.");
      }
    }
    // Work that can't run where it waits: on a deleted machine it fails; on a stopped machine whose
    // wake was lost, the machine starts.
    for (const cloud of rows) {
      const fresh = await ctx.db.get(cloud._id);
      if (!fresh) continue;
      if (fresh.state === "deleting" || fresh.state === "deleted") {
        await failWaitingWork(ctx, fresh.machineId, "The cloud machine was deleted.");
      } else if ((fresh.state === "stopped" || fresh.state === "failed") && (await queuedStarts(ctx, fresh.machineId)).any) {
        await wake(ctx, fresh, "work");
      } else if (fresh.state === "stopped" && fresh.maintenancePending) {
        // A cleanup owed to a stopped machine whose wake was lost. (A failed one retries with backoff.)
        await wake(ctx, fresh, "maintenance");
      }
    }
    return { provider: plan.provider, sweeps };
  },
});

/** Right before the reconciler's provider call: does the room still want it? A newer start or stop wins. */
export const stillWanted = internalQuery({
  args: { cloudId: v.id("cloudMachines"), generation: v.number(), op: v.union(v.literal("stop"), v.literal("delete")) },
  handler: async (ctx, { cloudId, generation, op }) => {
    const cloud = await ctx.db.get(cloudId);
    if (!cloud || cloud.generation !== generation) return false;
    return op === "stop" ? cloud.state === "stopped" || cloud.state === "failed" : cloud.state === "deleted";
  },
});

export const snapshotsSwept = internalMutation({
  args: { cloudId: v.id("cloudMachines") },
  handler: async (ctx, { cloudId }) => {
    const cloud = await ctx.db.get(cloudId);
    if (cloud && cloud.state === "deleted") await ctx.db.patch(cloud._id, { snapshotsSweptAt: Date.now() });
    return null;
  },
});

/** A reconcile run began: a kick from now on schedules the next one. */
export const reconcileStarted = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("cloudReconciler")
      .withIndex("by_key", (q) => q.eq("key", "main"))
      .unique();
    if (row) await ctx.db.patch(row._id, { pendingId: undefined, lastRunAt: Date.now() });
    return null;
  },
});

/** For actions: ask for a reconcile run soon. */
export const kick = internalMutation({
  args: {},
  handler: async (ctx) => {
    await kickReconcile(ctx);
    return null;
  },
});
