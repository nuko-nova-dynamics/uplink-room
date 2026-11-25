import type { RoomMessage } from "@uplink-room/protocol";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Queues a message for a machine's bridge. The bridge reads them in order. */
export async function sendToBridge(
  ctx: MutationCtx,
  machineId: Id<"machines">,
  message: RoomMessage,
): Promise<void> {
  const last = await ctx.db
    .query("bridgeOutbox")
    .withIndex("by_machine_seq", (q) => q.eq("machineId", machineId))
    .order("desc")
    .first();
  const machine = await ctx.db.get(machineId);
  const seq = Math.max(last?.seq ?? 0, machine?.outboxSeq ?? 0) + 1;
  await ctx.db.insert("bridgeOutbox", { machineId, seq, message });
  await ctx.db.patch(machineId, { outboxSeq: seq });
}
