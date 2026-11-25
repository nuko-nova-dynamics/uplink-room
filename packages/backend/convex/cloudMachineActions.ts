"use node";
/**
 * The provider calls for cloud machines (#10, ADR 0013). Mutations can't call
 * out, so `cloudMachines.ts` schedules these, and each reports back through an
 * internal mutation with the generation it was made for.
 *
 * They run in Node because the Vercel Sandbox SDK needs it. The provider's
 * credentials (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`) stay in
 * the Convex environment and never reach a machine; the machine gets only a
 * one-time pairing code, the room's URL and where to download the bridge.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { bootScript, tarballSetting } from "./lib/cloudBoot";
import { SESSION_MS } from "./lib/cloudMachines";
import {
  cloudProviderOverride,
  missingCloudEnv,
  ROOM_TAG,
  roomTag,
  type BootStep,
  type CloudMachineProvider,
} from "./lib/cloudProvider";
import { vercelSandboxProvider } from "./lib/vercelSandbox";

function provider(): CloudMachineProvider {
  const override = cloudProviderOverride();
  if (override) return override;
  const missing = missingCloudEnv();
  if (override === null || missing.length > 0) {
    throw new Error(`Cloud machines aren't configured: set ${missing.join(", ")} in the Convex environment.`);
  }
  return vercelSandboxProvider({
    token: process.env["VERCEL_TOKEN"]!,
    teamId: process.env["VERCEL_TEAM_ID"]!,
    projectId: process.env["VERCEL_PROJECT_ID"]!,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const args = { cloudId: v.id("cloudMachines"), generation: v.number() };

async function load(ctx: ActionCtx, a: { cloudId: any; generation: number }) {
  const found = await ctx.runQuery(internal.cloudMachines.forAction, { cloudId: a.cloudId });
  if (!found || !found.machine || found.cloud.generation !== a.generation) return null;
  return found;
}

/** This boot's boot step: the script, and a fresh one-time pairing code in its environment. */
async function bootStep(ctx: ActionCtx, a: { cloudId: any; generation: number }): Promise<BootStep | null> {
  const tarball = tarballSetting(process.env["UPLINK_BRIDGE_TARBALL_URL"]);
  if (!tarball)
    throw new Error(
      "UPLINK_BRIDGE_TARBALL_URL has no sha256 (it should read <url>#sha256=<hex>), so the bridge can't be checked. Run the Bridge release again.",
    );
  const code = await ctx.runMutation(internal.cloudMachines.pairingCodeFor, a);
  if (!code) return null;
  return {
    script: bootScript(),
    env: {
      UPLINK_CONVEX_URL: process.env["CONVEX_CLOUD_URL"] ?? "",
      UPLINK_BRIDGE_TARBALL: tarball.url,
      UPLINK_BRIDGE_TARBALL_SHA256: tarball.sha256,
      UPLINK_PAIRING_CODE: code,
    },
  };
}

/**
 * A create or start was overtaken while it talked to the provider: the
 * machine was stopped or deleted meanwhile (or the start's watchdog gave up),
 * and that operation may have run before this one reached the provider. So
 * this one undoes what it did, to match what the room wants now. Both calls
 * are safe to repeat.
 */
async function undoSuperseded(ctx: ActionCtx, p: CloudMachineProvider, cloudId: any, name: string) {
  const now = await ctx.runQuery(internal.cloudMachines.forAction, { cloudId });
  const state = now?.cloud.state;
  const op = !now || state === "deleting" || state === "deleted" ? "delete" : state === "stopping" || state === "stopped" || state === "failed" ? "stop" : null;
  try {
    // Re-checked right before the call: if a newer operation began meanwhile, this one must not undo its boot.
    const again = op ? await ctx.runQuery(internal.cloudMachines.forAction, { cloudId }) : null;
    if (op && (!now || again?.cloud.generation === now.cloud.generation)) {
      if (op === "delete") await p.delete(name);
      else await p.stop(name);
    }
  } catch (error) {
    // Not fatal: the reconciler run asked for below stops or deletes the box.
    console.error(`Couldn't undo a superseded start of ${name}: ${message(error)}`);
  }
  await ctx.runMutation(internal.cloudMachines.kick, {});
}

/**
 * Makes the box if it isn't there (the first boot, or a box the provider
 * removed), then boots it. Reports back, or undoes the boot if superseded.
 */
async function boot(ctx: ActionCtx, a: { cloudId: any; generation: number }, op: "create" | "start") {
  const found = await load(ctx, a);
  if (!found || found.cloud.state !== (op === "create" ? "creating" : "starting")) return null;
  const { cloud, machine } = found;
  let p: CloudMachineProvider;
  try {
    p = provider();
  } catch (error) {
    await ctx.runMutation(internal.cloudMachines.providerFailed, { ...a, op, error: message(error) });
    return null;
  }
  try {
    await p.create(
      {
        name: cloud.resourceName,
        region: cloud.region,
        vcpus: cloud.vcpus,
        tags: { app: "uplink-room", machine: machine!._id, ...(roomTag() ? { [ROOM_TAG]: roomTag()! } : {}) },
      },
      { timeoutMs: SESSION_MS },
    );
    const step = await bootStep(ctx, a);
    if (!step) {
      await undoSuperseded(ctx, p, a.cloudId, cloud.resourceName);
      return null;
    }
    await p.start(cloud.resourceName, { timeoutMs: SESSION_MS }, step, a.generation);
  } catch (error) {
    await ctx.runMutation(internal.cloudMachines.providerFailed, { ...a, op, error: message(error) });
    return null;
  }
  if (!(await ctx.runMutation(internal.cloudMachines.providerStarted, a))) {
    await undoSuperseded(ctx, p, a.cloudId, cloud.resourceName);
  }
  return null;
}

/** First boot: make the box, then boot it so the bridge installs and pairs. */
export const provision = internalAction({ args, handler: (ctx, a) => boot(ctx, a, "create") });

/** A later boot, from the kept disk. */
export const startAtProvider = internalAction({ args, handler: (ctx, a) => boot(ctx, a, "start") });

/** Stops the box, then asks the provider whether it really stopped. */
export const stopAtProvider = internalAction({
  args,
  handler: async (ctx, a) => {
    const found = await load(ctx, a);
    if (!found || found.cloud.state !== "stopping") return null;
    let providerState;
    try {
      const p = provider();
      await p.stop(found.cloud.resourceName);
      providerState = await p.status(found.cloud.resourceName);
    } catch (error) {
      await ctx.runMutation(internal.cloudMachines.providerFailed, { ...a, op: "stop", error: message(error) });
      return null;
    }
    await ctx.runMutation(internal.cloudMachines.providerStopped, { ...a, providerState });
    return null;
  },
});

/** Asks for more session time. The room moves its deadline only once the provider has accepted. */
export const extendAtProvider = internalAction({
  args: { ...args, from: v.number(), ms: v.number() },
  handler: async (ctx, { from, ms, ...a }) => {
    const found = await load(ctx, a);
    if (!found || found.cloud.state !== "running") return null;
    try {
      await provider().extend(found.cloud.resourceName, ms);
    } catch (error) {
      await ctx.runMutation(internal.cloudMachines.providerFailed, { ...a, op: "extend", error: message(error) });
      return null;
    }
    await ctx.runMutation(internal.cloudMachines.providerExtended, { ...a, from, ms });
    return null;
  },
});

/** The bridge went quiet: is the box still running at the provider? */
export const reconcile = internalAction({
  args,
  handler: async (ctx, a) => {
    const found = await load(ctx, a);
    if (!found || found.cloud.state !== "running") return null;
    let providerState;
    try {
      providerState = await provider().status(found.cloud.resourceName);
    } catch {
      return null; // Asked again at the next check.
    }
    await ctx.runMutation(internal.cloudMachines.reconciled, { ...a, providerState });
    return null;
  },
});

/** Deletes the box and its snapshots, then confirms the provider has no such machine. One numbered attempt. */
export const deleteAtProvider = internalAction({
  args: { ...args, attempt: v.number() },
  handler: async (ctx, { attempt, ...a }) => {
    const found = await load(ctx, a);
    if (!found || found.cloud.state !== "deleting" || found.cloud.deleteAttempt !== attempt) return null;
    let snapshotIds: string[] = [];
    try {
      const p = provider();
      // Listed first: once the box is gone its snapshots can't be listed by name, and the
      // provider's own cleanup of them is asynchronous. The reconciler deletes any left.
      snapshotIds = await p.listSnapshots(found.cloud.resourceName).catch(() => []);
      await p.delete(found.cloud.resourceName);
      const state = await p.status(found.cloud.resourceName);
      if (state !== "missing") throw new Error(`The provider still reports the box as ${state}.`);
    } catch (error) {
      await ctx.runMutation(internal.cloudMachines.providerFailed, { ...a, op: "delete", error: message(error), attempt });
      return null;
    }
    await ctx.runMutation(internal.cloudMachines.providerDeleted, { ...a, attempt, snapshotIds });
    return null;
  },
});

/** Some time after a confirmed delete: delete again if the box is back, and keep at it if it won't go. */
export const verifyDeleted = internalAction({
  args: { cloudId: v.id("cloudMachines") },
  handler: async (ctx, { cloudId }) => {
    const found = await ctx.runQuery(internal.cloudMachines.forAction, { cloudId });
    if (!found || found.cloud.state !== "deleted") return null;
    try {
      const p = provider();
      if ((await p.status(found.cloud.resourceName)) === "missing") return null;
      await p.delete(found.cloud.resourceName);
      if ((await p.status(found.cloud.resourceName)) === "missing") return null;
    } catch (error) {
      console.error(`Couldn't check that ${found.cloud.resourceName} is deleted: ${message(error)}`);
    }
    await ctx.runMutation(internal.cloudMachines.deleteReappeared, { cloudId });
    return null;
  },
});

/**
 * The reconciler (ADR 0013): lists the boxes this room owns at the provider,
 * has the room apply its side of the plan, then makes the provider calls,
 * re-checking each against the machine's generation right before the call.
 * The cron runs it every 5 minutes, and provider actions ask for a run soon
 * after they finish.
 */
export const reconcileAll = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.cloudMachines.reconcileStarted, {});
    const room = roomTag();
    if (!room || (cloudProviderOverride() === undefined && missingCloudEnv().length > 0)) return null;
    let p: CloudMachineProvider;
    try {
      p = provider();
    } catch {
      return null;
    }
    const listedAt = Date.now();
    const boxes = await p.list(room);
    const work = await ctx.runMutation(internal.cloudMachines.reconcileRoom, {
      boxes: boxes.map((b) => ({ name: b.name, state: b.state })),
      listedAt,
    });
    for (const op of work.provider) {
      if (op.cloudId !== undefined && op.generation !== undefined) {
        const wanted = await ctx.runQuery(internal.cloudMachines.stillWanted, {
          cloudId: op.cloudId as any,
          generation: op.generation,
          op: op.op,
        });
        if (!wanted) continue;
      }
      try {
        if (op.op === "stop") await p.stop(op.name);
        else await p.delete(op.name);
        console.log(`Reconciler: ${op.op} ${op.name}: ${op.why}.`);
      } catch (error) {
        console.error(`Reconciler couldn't ${op.op} ${op.name}: ${message(error)}`);
      }
    }
    for (const sweep of work.sweeps) {
      try {
        const ids = new Set([...sweep.snapshotIds, ...(await p.listSnapshots(sweep.name))]);
        for (const id of ids) await p.deleteSnapshot(id);
        await ctx.runMutation(internal.cloudMachines.snapshotsSwept, { cloudId: sweep.cloudId });
      } catch (error) {
        console.error(`Reconciler couldn't delete the snapshots of ${sweep.name}: ${message(error)}`);
      }
    }
    return null;
  },
});
