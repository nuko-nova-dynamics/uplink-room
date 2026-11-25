import { accessRank, type Access } from "@uplink-room/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sendToBridge } from "./outbox";

export function isLive(terminal: Doc<"terminals">): boolean {
  return terminal.status === "starting" || terminal.status === "live";
}

/**
 * A machine's starting and live terminals, oldest first, never its ended ones: it keeps every
 * terminal it ever had.
 */
export async function liveTerminalsOn(ctx: QueryCtx, machineId: Id<"machines">): Promise<Doc<"terminals">[]> {
  const of = (status: "starting" | "live") =>
    ctx.db
      .query("terminals")
      .withIndex("by_machine_status", (q) => q.eq("machineId", machineId).eq("status", status))
      .collect();
  return [...(await of("starting")), ...(await of("live"))].sort((a, b) => a._creationTime - b._creationTime);
}

/**
 * Lowers every live terminal on a machine that is above `access`, marking the
 * level it had before ("Drive, was Open"), and tells the bridge.
 */
export async function lowerTerminalsAbove(
  ctx: MutationCtx,
  machineId: Id<"machines">,
  access: Access,
): Promise<void> {
  // Only the live ones, so a machine with thousands of ended terminals stays within a transaction's reads.
  for (const terminal of await liveTerminalsOn(ctx, machineId)) {
    if (!isLive(terminal) || accessRank(terminal.access) <= accessRank(access)) continue;
    await ctx.db.patch(terminal._id, { access, loweredFrom: terminal.access });
    await cancelWhatAccessForbids(ctx, terminal._id, access);
    await sendToBridge(ctx, machineId, {
      v: 1,
      type: "change_access",
      terminalId: terminal._id,
      access,
    });
  }
}

/**
 * Call after a terminal's access drops to `access`. Below Drive its pending
 * wheel requests are cancelled; below Suggest its pending suggestions are
 * dismissed. Otherwise a request made at a higher level could still be granted.
 */
export async function cancelWhatAccessForbids(
  ctx: MutationCtx,
  terminalId: Id<"terminals">,
  access: Access,
): Promise<void> {
  if (accessRank(access) < accessRank("drive")) {
    const requests = await ctx.db
      .query("wheelRequests")
      .withIndex("by_terminal", (q) => q.eq("terminalId", terminalId))
      .collect();
    for (const r of requests)
      if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  }
  if (accessRank(access) < accessRank("suggest")) {
    const suggestions = await ctx.db
      .query("suggestions")
      .withIndex("by_terminal", (q) => q.eq("terminalId", terminalId))
      .collect();
    for (const s of suggestions)
      if (s.status === "pending") await ctx.db.patch(s._id, { status: "dismissed" });
  }
}

/** How the room names a member to a bridge. */
export function actorRef(member: Doc<"members">) {
  return { memberId: member._id as string, name: member.name };
}

/**
 * Largest stored output chunk, in UTF-8 bytes. The bridge flushes at 16 KiB or more, so most
 * flushes fit in one chunk; a bigger one is split. Keeps each row far under Convex's 1 MiB
 * document limit and lets `terminals.output` page by size.
 */
export const OUTPUT_CHUNK_BYTES = 32 * 1024;

/**
 * Most output `terminals.output` returns at once, in UTF-8 bytes: well under Convex's 16 MiB
 * per-function read and return limits, with room for one oversized chunk stored before chunks
 * were split.
 */
export const OUTPUT_PAGE_BYTES = 4 * 1024 * 1024;

/** The UTF-8 length of a string. Strings in Convex have no unpaired surrogates. */
export function utf8Bytes(data: string): number {
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < data.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Splits output into pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
export function splitOutput(data: string, maxBytes = OUTPUT_CHUNK_BYTES): string[] {
  // A UTF-16 code unit is at most 3 UTF-8 bytes (a surrogate pair is 4 for 2 units).
  if (data.length * 3 <= maxBytes) return [data];
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < data.length; ) {
    const code = data.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < data.length;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes > 0 && bytes + size > maxBytes) {
      pieces.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += pair ? 2 : 1;
  }
  if (start < data.length) pieces.push(data.slice(start));
  return pieces;
}

/**
 * Terminal output as plain text, for agents that read a terminal instead of drawing it
 * (`terminals.read`). The converter is shared with the room client (`@uplink-room/protocol`), whose
 * run_in_terminal and wait_for_terminal keep its state from one chunk to the next.
 */
export { MAX_PENDING, plainText, takeUnits } from "@uplink-room/protocol/terminalText";
