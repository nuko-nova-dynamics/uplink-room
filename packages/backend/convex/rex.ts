/**
 * Rex tabs in the Room API (ADR 0019): the tabs a machine's bridge can share, sharing one as a
 * terminal, and ending that share. A shared Rex tab follows the terminals' access, driver and wheel
 * rules (spec #3); its program keeps running in Rex when the share ends.
 */
import { v } from "convex/values";
import { accessRank, REX_TABS_TOOL, vAccess } from "@uplink-room/protocol";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { actsFor } from "./lib/actor";
import { endTerminal } from "./lib/bridgeMessages";
import { roomError } from "./lib/errors";
import { requireMachineControl } from "./lib/machines";
import { audit, inTeam } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import { actorRef, isLive } from "./lib/terminals";

async function foundOn(ctx: QueryCtx, machine: Doc<"machines">) {
  return ctx.db
    .query("foundRexTabs")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
}

/** The live terminal sharing a found tab: one the room shared (its localRef), or one the bridge names. */
function sharingTerminal(row: Doc<"foundRexTabs">, terminals: Doc<"terminals">[]) {
  return terminals.find(
    (t) =>
      isLive(t) &&
      t.inRex !== undefined &&
      (t.localRef === row.tabRef || (row.terminalRef !== undefined && (t._id === row.terminalRef || t.localRef === row.terminalRef))),
  );
}

export const { person: found, agent: foundAgent } = roomQuery({
  name: "rex.found",
  description:
    "The Rex tabs a machine's bridge can share: tabs opened through Uplink Room (uplink-bridge rex-open, or a run started in Rex), with whether each is shared. Also whether the machine can open Rex tabs at all, whether Rex runs there, and how many other Rex tabs it has, which can't be shared. Only whoever the machine belongs to (an admin, for a team machine) can read it.",
  scope: "room.read",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    // Tab names and folders are the person's own until they share one.
    await requireMachineControl(ctx, actor, machine);
    const terminals = await ctx.db
      .query("terminals")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    const rows = await foundOn(ctx, machine);
    return {
      available: machine.tools.includes(REX_TABS_TOOL),
      running: machine.rex?.running ?? false,
      otherTabs: machine.rex?.otherTabs ?? 0,
      checkedAt: machine.rex?.checkedAt,
      tabs: rows.map((row) => {
        const live = sharingTerminal(row, terminals);
        return {
          tabRef: row.tabRef,
          session: row.session,
          title: row.title,
          command: row.command,
          cwd: row.cwd,
          shared: Boolean(live),
          terminalId: live?._id,
          /** `run`: a run the room started in this tab, which stops from its task. */
          kind: live?.inRex,
        };
      }),
    };
  },
});

export const { person: share, agent: shareAgent } = roomMutation({
  name: "rex.share",
  description:
    "Share a Rex tab that a machine's bridge found (rex.found) with the room as a terminal, at an access level up to the machine's limit. Teammates see its output; its driver types into it, under the usual access and wheel rules. Only whoever the machine belongs to (an admin, for a team machine) can. The tab's program keeps running in Rex when the share ends (rex.stopSharing).",
  scope: "machines.manage",
  args: { machineId: v.id("machines"), tabRef: v.string(), access: vAccess },
  argDocs: {
    tabRef: "The tab's id in Rex, from rex.found",
    access: "How much teammates may do in it: watch, suggest, drive or open, up to the machine's mostOpenAccess",
  },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    if (machine.unlinkedAt !== undefined) throw roomError("invalid", "This machine was unlinked.");
    await requireMachineControl(ctx, actor, machine);
    if (machine.sharingStoppedAt !== undefined) {
      throw roomError("invalid", "Sharing is stopped on this machine. Resume sharing first.");
    }
    const row = (await foundOn(ctx, machine)).find((r) => r.tabRef === args.tabRef);
    if (!row) throw roomError("not_found", "This machine's bridge hasn't found a shareable Rex tab with that id.");
    const terminals = await ctx.db
      .query("terminals")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    if (sharingTerminal(row, terminals)) throw roomError("conflict", "This Rex tab is already shared.");
    if (accessRank(args.access) > accessRank(machine.mostOpenAccess)) {
      throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
    }
    const terminalId = await ctx.db.insert("terminals", {
      teamId: actor.teamId,
      machineId: machine._id,
      startedBy: actor.member._id,
      driverId: actor.member._id,
      access: args.access,
      // The machine's own tab, shared by whoever it belongs to: no slot.
      usesSlot: false,
      title: row.title || row.command,
      tool: "rex",
      localRef: row.tabRef,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      inRex: "tab",
      status: "starting",
      outputSeq: 0,
    });
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "share_rex_tab",
      terminalId,
      tabRef: row.tabRef,
      sharedBy: actorRef(actor.member),
      access: args.access,
    });
    await audit(ctx, actor, "rex.shared", terminalId, { machineId: machine._id, access: args.access });
    return terminalId;
  },
});

export const { person: stopSharing, agent: stopSharingAgent } = roomMutation({
  name: "rex.stopSharing",
  description:
    "Stop sharing a Rex tab (one shared with rex.share). Everyone's view of it ends, and its program keeps running in Rex. Whoever shared it, or whoever the machine belongs to, can. A run started in Rex (runs.start via rex) stops with runs.stop instead.",
  scope: "machines.manage",
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    if (terminal.inRex !== "tab") {
      throw roomError("invalid", "This terminal isn't a shared Rex tab. Stop its run with runs.stop.");
    }
    if (!isLive(terminal)) throw roomError("invalid", "This Rex tab is no longer shared.");
    const machine = await ctx.db.get(terminal.machineId);
    if (!machine) throw roomError("not_found", "This terminal's machine is gone.");
    if (!actsFor(actor, terminal.startedBy)) await requireMachineControl(ctx, actor, machine);
    await endTerminal(ctx, terminal, "stopped");
    await sendToBridge(ctx, machine._id, { v: 1, type: "stop_terminal", terminalId: terminal._id });
    await audit(ctx, actor, "rex.unshared", terminal._id);
    return null;
  },
});
