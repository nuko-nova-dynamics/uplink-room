/**
 * The room's scheduled work for messages to live runs (ADR 0026, lib/runDelivery.ts).
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { expireClaim as expire, noticeWaiting as notice, settleEnded as settle } from "./lib/runDelivery";

/** A claim the bridge didn't answer in time counts as unsure: handed over once more, then failed. */
export const expireClaim = internalMutation({
  args: { claimId: v.string(), deliveryIds: v.array(v.id("runInbox")) },
  handler: async (ctx, { claimId, deliveryIds }) => {
    await expire(ctx, claimId, deliveryIds);
  },
});

/** One step of failing an ended run's messages (lib/runDelivery.ts `runEnded`). */
export const settleEnded = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await settle(ctx, runId);
  },
});

/** One step of telling a bridge which of its terminals' runs have messages waiting (lib/runDelivery.ts `deliverWaiting`). */
export const noticeWaiting = internalMutation({
  args: { machineId: v.id("machines"), status: v.union(v.literal("live"), v.literal("starting")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { machineId, status, cursor }) => {
    await notice(ctx, machineId, status, cursor);
  },
});
