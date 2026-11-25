import { v } from "convex/values";
import { REX_TABS_TOOL, vAccess, vRuntimeMode } from "@uplink-room/protocol";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { requireAdmin } from "./lib/actor";
import { pairingCode, sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { endTerminal, setRunState } from "./lib/bridgeMessages";
import { exceedsLimits, handWheelsToOwner, isOnline, ONLINE_WINDOW_MS, requireMachineControl, scheduleOnlineCheck } from "./lib/machines";
import { audit, inTeam, memberView } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import { isLive, liveTerminalsOn, lowerTerminalsAbove } from "./lib/terminals";
import { endLiveSpaces, lowerSpacesAbove } from "./lib/spaces";
import { lowerThreadModesAbove, lowerThreadsAbove, machineModeCap } from "./lib/threads";
import { cloudFor, cloudView } from "./lib/cloudMachines";
import { bridgeReleaseFrom } from "./lib/cloudBoot";

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export const { person: createPairingCode, agent: createPairingCodeAgent } = roomMutation({
  name: "machines.createPairingCode",
  description:
    "Get a code to pair a machine's bridge with the team (`uplink-bridge pair <code>`). It belongs to you, or to the team when belongsToTeam is set (admins only). Valid for 10 minutes.",
  scope: "machines.manage",
  args: { name: v.string(), belongsToTeam: v.optional(v.boolean()) },
  handler: async (ctx, actor, args) => {
    if (args.belongsToTeam) requireAdmin(actor);
    const belongsTo = args.belongsToTeam
      ? ({ kind: "team" } as const)
      : ({ kind: "person", memberId: actor.accountable?._id ?? actor.member._id } as const);
    const code = pairingCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    await ctx.db.insert("pairingCodes", {
      teamId: actor.teamId,
      codeHash: await sha256(code),
      createdBy: actor.member._id,
      belongsTo,
      name: args.name.trim() || "Machine",
      expiresAt,
    });
    return { code, expiresAt };
  },
});

export const { person: bridgeRelease, agent: bridgeReleaseAgent } = roomQuery({
  name: "machines.bridgeRelease",
  description:
    "The bridge release a machine installs from, the one cloud machines run: the npm tarball's url, its sha256 as the room recorded it, and its version. Check a download's sha256 against it before installing (npm doesn't check it), install with Node 24 or newer (`npm install -g --allow-scripts=node-pty <file>`), then pair with a code from machines.createPairingCode. Null when this deployment has no release.",
  scope: "room.read",
  args: {},
  handler: async () => bridgeReleaseFrom(process.env["UPLINK_BRIDGE_TARBALL_URL"]),
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "machines.list",
  description:
    "List the team's linked machines: who each belongs to, whether its bridge is online, its settings (mostOpenAccess: the most open access a terminal there can have, which is what runs.start's access goes up to; on a personal machine, watch or suggest also means only its person and their agents can start runs there, so teammates need drive or open; slots: terminals teammates and agents may start without asking; slotsInUse) and limits, the most its owner's bridge lets those settings be (not what a terminal can use), its live terminals, and for a cloud machine its state (running, stopped, ...). tools lists the programs the bridge found there to report run states from (claude, herdr, tmux, rex, t3code); they aren't runs.start harness names. t3 says where its bridge's T3 Code pairing stands: connected, unreachable (T3 Code isn't running) or needs_pairing (the pairing expired or was revoked and the bridge couldn't pair again by itself, usually because T3 Code isn't open there: open it, or run uplink-bridge t3-pair on that machine), with expiresAt, when the pairing ends. Start a terminal on one with runs.start.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const now = Date.now();
    const machines = await ctx.db
      .query("machines")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    return Promise.all(
      machines
        .filter((m) => m.unlinkedAt === undefined)
        .map(async (m) => {
          const terminals = await ctx.db
            .query("terminals")
            .withIndex("by_machine", (q) => q.eq("machineId", m._id))
            .collect();
          const live = terminals.filter((x) => x.status === "starting" || x.status === "live");
          return {
            machineId: m._id,
            name: m.name,
            belongsTo:
              m.belongsTo.kind === "team"
                ? { kind: "team" as const }
                : { kind: "person" as const, member: await memberView(ctx, m.belongsTo.memberId) },
            online: isOnline(m, now),
            lastSeenAt: m.lastSeenAt,
            hostname: m.hostname,
            os: m.os,
            tools: m.tools,
            /**
             * Rex (ADR 0019): whether runs can start in Rex here (its bridge opens Rex tabs), and
             * whether Rex runs there now (unknown until the bridge reports).
             */
            rex: { available: m.tools.includes(REX_TABS_TOOL), running: m.rex?.running },
            mostOpenAccess: m.mostOpenAccess,
            /** The most permissive permission mode a run here may use (ADR 0043). */
            mostPermissiveMode: machineModeCap(m),
            slots: m.slots,
            slotsInUse: live.filter((x) => x.usesSlot).length,
            longestProfileMs: m.longestProfileMs,
            limits: m.limits,
            sharingStopped: m.sharingStoppedAt !== undefined,
            liveTerminals: live.length,
            /** Its bridge's T3 Code pairing (ADR 0021), if the bridge reported one. */
            t3: m.t3 ? { state: m.t3.state, expiresAt: m.t3.expiresAt, reason: m.t3.reason } : undefined,
            /** Set for a cloud machine (#10): its state at the provider. */
            cloud: await cloudFor(ctx, m._id).then((c) => (c ? cloudView(c) : undefined)),
          };
        }),
    );
  },
});

export const { person: updateSettings, agent: updateSettingsAgent } = roomMutation({
  name: "machines.updateSettings",
  description:
    "Change a machine's settings: the most open access allowed, the most permissive permission mode a run there may use (mostPermissiveMode: approval-required, auto-accept-edits, auto or full-access; lowering it lowers open T3 Code threads above it to the most permissive mode each one's provider takes within it, and stops a thread T3 Code won't lower; saving it again asks again; terminals keep the mode they started with), how many slots teammates may use without asking, and the longest a profile may be kept (ms). Lowering the access lowers running terminals, Spaces and T3 Code threads above it. On a personal machine, watch and suggest also mean only the person it belongs to (and their agents) can start runs there; lowering it to either makes that person the driver of every terminal and thread there that someone else drives, and that work keeps running.",
  scope: "machines.manage",
  args: {
    machineId: v.id("machines"),
    mostOpenAccess: v.optional(vAccess),
    mostPermissiveMode: v.optional(vRuntimeMode),
    slots: v.optional(v.number()),
    longestProfileMs: v.optional(v.number()),
  },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    await requireMachineControl(ctx, actor, machine);
    const { machineId, ...settings } = args;
    if (settings.slots !== undefined && (settings.slots < 0 || !Number.isInteger(settings.slots))) {
      throw roomError("invalid", "Slots must be a whole number, 0 or more.");
    }
    if (settings.longestProfileMs !== undefined && settings.longestProfileMs < 0) {
      throw roomError("invalid", "The longest profile time can't be negative.");
    }
    const { mostPermissiveMode, ...limited } = settings;
    const over = exceedsLimits(limited, machine.limits);
    if (over) throw roomError("invalid", over);
    const patch = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
    await ctx.db.patch(machineId, patch);
    if (settings.mostOpenAccess) {
      // Drivers first, while the bridge still has these terminals at their old level (ADR 0025).
      await handWheelsToOwner(ctx, (await ctx.db.get(machine._id))!, actor);
      await lowerTerminalsAbove(ctx, machine._id, settings.mostOpenAccess);
      await lowerSpacesAbove(ctx, machine._id, settings.mostOpenAccess);
      await lowerThreadsAbove(ctx, machine._id, settings.mostOpenAccess);
    }
    // On every save, not only a lower cap: a thread still above it (T3 Code was away) is asked again.
    if (mostPermissiveMode) await lowerThreadModesAbove(ctx, (await ctx.db.get(machine._id))!, mostPermissiveMode);
    await audit(ctx, actor, "machine.settings_changed", machineId, patch);
    return null;
  },
});

export const { person: stopSharing, agent: stopSharingAgent } = roomMutation({
  name: "machines.stopSharing",
  description: "Stop sharing every terminal and Space on a machine at once.",
  scope: "machines.manage",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    await requireMachineControl(ctx, actor, machine);
    await endLiveTerminals(ctx, machine._id);
    await clearThreadPrompts(ctx, machine._id);
    await endLiveSpaces(ctx, machine._id);
    await ctx.db.patch(machine._id, { sharingStoppedAt: Date.now() });
    await sendToBridge(ctx, machine._id, { v: 1, type: "stop_sharing" });
    await audit(ctx, actor, "machine.sharing_stopped", machine._id);
    return null;
  },
});

export const { person: resumeSharing, agent: resumeSharingAgent } = roomMutation({
  name: "machines.resumeSharing",
  description:
    "Let terminals on a machine be shared again after stopping from the room. A stop made on the machine itself lasts until its bridge restarts.",
  scope: "machines.manage",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    await requireMachineControl(ctx, actor, machine);
    await ctx.db.patch(machine._id, { sharingStoppedAt: undefined });
    await sendToBridge(ctx, machine._id, { v: 1, type: "resume_sharing" });
    await audit(ctx, actor, "machine.sharing_resumed", machine._id);
    return null;
  },
});

export const { person: unlink, agent: unlinkAgent } = roomMutation({
  name: "machines.unlink",
  description: "Unlink a machine. The room loses all access to it at once.",
  scope: "machines.manage",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    await requireMachineControl(ctx, actor, machine);
    if (await cloudFor(ctx, machine._id)) {
      throw roomError(
        "invalid",
        `${machine.name} is a cloud machine. Delete it with cloudMachines.remove, so its box and disk are deleted too.`,
      );
    }
    await endLiveTerminals(ctx, machine._id);
    await endLiveSpaces(ctx, machine._id);
    await stopActiveRuns(ctx, machine._id);
    await ctx.db.patch(machine._id, { unlinkedAt: Date.now() });
    await audit(ctx, actor, "machine.unlinked", machine._id);
    return null;
  },
});

/**
 * Ends the machine's live terminals in the room. Their runs stop (someone ended
 * them) and pending wheel requests are cancelled, because the room no longer
 * hears about these terminals: a report from the bridge can't correct them.
 */
export async function endLiveTerminals(ctx: MutationCtx, machineId: Id<"machines">) {
  // Only the starting and live ones: a machine with thousands of ended terminals stays within a
  // transaction's reads, so unlinking it (and removing its person from the team) can't roll back.
  for (const terminal of await liveTerminalsOn(ctx, machineId)) {
    if (isLive(terminal)) await endTerminal(ctx, terminal, "stopped");
  }
}

/**
 * While sharing is stopped the bridge takes no answers for T3 Code threads, so a thread run
 * waiting on an approval would sit in Needs you with Allow and Deny that do nothing. This sets
 * such runs to Unknown with no prompt, as the bridge does for a lost connection. The threads keep
 * running in T3 Code, and the bridge reports them again when sharing resumes.
 */
async function clearThreadPrompts(ctx: MutationCtx, machineId: Id<"machines">) {
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machineId))
    .collect();
  for (const run of runs) {
    if (run.threadRef !== undefined && run.state === "waiting") {
      await setRunState(ctx, run._id, "unknown", undefined, "bridge");
    }
  }
}

/**
 * Stops every run still going on an unlinked machine, threads included: its
 * bridge can't report on them any more, so they would stay Working forever. Its
 * threads no longer take messages between turns either (ADR 0026).
 */
export async function stopActiveRuns(ctx: MutationCtx, machineId: Id<"machines">) {
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machineId))
    .collect();
  for (const run of runs) {
    if (run.state !== "done" && run.state !== "failed" && run.state !== "stopped") {
      await setRunState(ctx, run._id, "stopped", undefined);
    }
    if (run.threadOpen) await ctx.db.patch(run._id, { threadOpen: undefined });
  }
}

/**
 * Marks a machine offline once its online window has passed with no word from
 * its bridge, so subscribed machine lists change. If the bridge was heard from
 * since, it checks again at the new window's end. One check is pending per
 * machine (`onlineCheckId`).
 */
export const checkOnline = internalMutation({
  args: { machineId: v.id("machines") },
  handler: async (ctx, { machineId }) => {
    const machine = await ctx.db.get(machineId);
    if (!machine || machine.unlinkedAt !== undefined || machine.lastSeenAt === undefined) {
      if (machine) await ctx.db.patch(machine._id, { onlineCheckId: undefined });
      return null;
    }
    if (Date.now() - machine.lastSeenAt >= ONLINE_WINDOW_MS) {
      await ctx.db.patch(machine._id, { offlineSince: Date.now(), onlineCheckId: undefined });
    } else {
      await scheduleOnlineCheck(ctx, machine);
    }
    return null;
  },
});
