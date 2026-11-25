/**
 * Rex tabs (ADR 0019): the bridge messages about Rex. A machine's bridge reports the Rex tabs it can
 * share (`rex_found`) and the size Rex gives a shared tab (`terminal_size`). It sends them only after
 * the room's `room_features` lists `rex`.
 */
import type { BridgeMessageOf } from "@uplink-room/protocol";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { findTerminal } from "./bridgeMessages";
import { isLive } from "./terminals";

export type RexMessage = BridgeMessageOf<"rex_found" | "terminal_size">;
export const REX_MESSAGES = new Set(["rex_found", "terminal_size"]);

/** The most found tabs kept per machine. */
const FOUND_KEPT = 200;

export async function handleRexMessage(ctx: MutationCtx, machine: Doc<"machines">, m: RexMessage): Promise<void> {
  if (m.type === "rex_found") {
    await ctx.db.patch(machine._id, {
      rex: { running: m.running, otherTabs: Math.max(0, Math.floor(m.otherTabs)), checkedAt: Date.now() },
    });
    await forgetFoundTabs(ctx, machine._id);
    for (const tab of m.tabs.slice(0, FOUND_KEPT)) {
      await ctx.db.insert("foundRexTabs", {
        machineId: machine._id,
        tabRef: tab.tabRef,
        sessionRef: tab.sessionRef,
        session: tab.session.slice(0, 128),
        title: tab.title.slice(0, 128),
        command: tab.command.slice(0, 1000),
        ...(tab.cwd ? { cwd: tab.cwd.slice(0, 1000) } : {}),
        ...(tab.terminalRef ? { terminalRef: tab.terminalRef } : {}),
      });
      // A tab shared before the room knew it was one (its share beat this report, from a bridge that
      // doesn't say so in `terminal_started`) becomes a Rex tab now.
      const shared = await findTerminal(ctx, machine, tab.terminalRef ?? tab.tabRef);
      if (shared && isLive(shared) && shared.inRex === undefined) await ctx.db.patch(shared._id, { inRex: "tab" });
    }
    return;
  }
  const terminal = await findTerminal(ctx, machine, m.terminalId);
  if (!terminal || !Number.isFinite(m.cols) || !Number.isFinite(m.rows)) return;
  const size = { cols: Math.min(1000, Math.max(1, Math.round(m.cols))), rows: Math.min(1000, Math.max(1, Math.round(m.rows))) };
  if (terminal.size?.cols !== size.cols || terminal.size?.rows !== size.rows) await ctx.db.patch(terminal._id, { size });
}

/** Drops what a machine's bridge reported about Rex, as a newly started bridge reports it again. */
export async function forgetFoundTabs(ctx: MutationCtx, machineId: Doc<"machines">["_id"]): Promise<void> {
  const old = await ctx.db
    .query("foundRexTabs")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  for (const row of old) await ctx.db.delete(row._id);
}
