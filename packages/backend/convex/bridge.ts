/**
 * The room's side of the bridge-to-room protocol (`@uplink-room/protocol`).
 *
 * A bridge pairs once with a pairing code and gets a bridge token. With it, it
 * sends its messages (`send`), reads the room's messages for it in order
 * (`inbox`), and acknowledges what it handled (`ack`). These functions are for
 * bridges only; they aren't part of the Room API.
 */
import { v } from "convex/values";
import {
  REX_FEATURE,
  REX_TABS_TOOL,
  ROOM_FEATURES,
  vBridgeMessage,
  vRunMessageHow,
  type BridgeMessage,
  type MachineLimits,
  type RoomMessage,
} from "@uplink-room/protocol";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { publicMutation, publicQuery } from "./lib/refusals";
import { accountDeleted, memberStillActs } from "./lib/actor";
import { randomSecret, sha256 } from "./lib/crypto";
import { canonicalPairCode } from "./lib/pairs";
import { roomError } from "./lib/errors";
import { capToLimits, defaultSettings, handWheelsToOwner, markSeen } from "./lib/machines";
import { lowerThreadsAbove } from "./lib/threads";
import { closeThreads, endTerminal, handleBridgeMessage } from "./lib/bridgeMessages";
import { liveTerminalsOn } from "./lib/terminals";
import { endLiveSpaces, handleSpaceMessage, type SpaceMessage } from "./lib/spaces";
import { forgetFoundTabs, handleRexMessage, REX_MESSAGES, type RexMessage } from "./lib/rex";
import { sendToBridge } from "./lib/outbox";
import { bridgeRegistered, cloudFor, holdsQueue } from "./lib/cloudMachines";
import { forgetFollows } from "./lib/threadView";
import { claimRunMessages as claimRunMessages_, holdRunMessages as holdRunMessages_ } from "./lib/runDelivery";
import { runAttachUrl as runAttachUrl_, runSays } from "./lib/runSay";
import { vNewAttachment } from "./lib/attachments";

const SPACE_MESSAGES = new Set<BridgeMessage["type"]>([
  "spaces_found",
  "space_shared",
  "space_share_failed",
  "space_access",
  "space_ended",
  "space_view_ready",
  "space_view_failed",
  "space_action_result",
  "space_rejected",
  "space_power",
  "space_view_renewed",
]);

/** Writes to lastSeenAt at most this often, so busy terminals don't churn the machine list. */
const SEEN_RESOLUTION_MS = 20 * 1000;

async function machineForToken(ctx: QueryCtx, token: string): Promise<Doc<"machines">> {
  const tokenHash = await sha256(token);
  const machine = await ctx.db
    .query("machines")
    .withIndex("by_bridge_token", (q) => q.eq("bridgeTokenHash", tokenHash))
    .unique();
  // A deleted account's personal machines stop the moment the deletion lands, before the steps
  // that unlink them run (accounts.ts, ADR 0035).
  if (!machine || (machine.belongsTo.kind === "person" && (await accountDeleted(ctx, machine.belongsTo.memberId)))) {
    throw roomError("unauthenticated", "This bridge token isn't valid. Pair the bridge again.");
  }
  return machine;
}

export const pair = publicMutation({
  args: { code: v.string(), hostname: v.string(), os: v.string() },
  handler: async (ctx, args) => {
    const codeHash = await sha256(args.code.trim().toUpperCase());
    const pairing = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("codeHash", codeHash))
      .unique();
    // A code works only while whoever made it still could (a cloud machine's is the room's own):
    // not after they left the team or their account was deleted (ADR 0035).
    if (
      !pairing ||
      pairing.usedAt !== undefined ||
      pairing.expiresAt < Date.now() ||
      (!pairing.machineId && !(await memberStillActs(ctx, pairing.createdBy)))
    ) {
      // A Pair's code (RIVER-4821-MAPLE-0937) is the other code people paste here by mistake.
      if (!pairing && canonicalPairCode(args.code)) {
        throw roomError(
          "invalid",
          "That's a Pair code, for joining a Pair with uplink pair. A machine pairs with a machine code such as ABCD-EFGH: in the app, Settings → Machines → Link a machine → Another machine, or uplink machines createPairingCode name=<machine>.",
        );
      }
      throw roomError("invalid", "This pairing code isn't valid, was used, or expired. Make a new one.");
    }
    await ctx.db.patch(pairing._id, { usedAt: Date.now() });
    const token = randomSecret("ubt", 32);
    if (pairing.machineId) {
      // A cloud machine's boot step pairs as the machine the room already made (#10).
      const machine = await ctx.db.get(pairing.machineId);
      if (!machine || machine.unlinkedAt !== undefined) {
        throw roomError("invalid", "This pairing code isn't valid, was used, or expired. Make a new one.");
      }
      await ctx.db.patch(machine._id, { bridgeTokenHash: await sha256(token), hostname: args.hostname, os: args.os });
      await markSeen(ctx, machine._id);
      return { token, machineId: machine._id, teamId: machine.teamId, belongsTo: null, linkedBy: machine.linkedBy };
    }
    const linkedBy = pairing.belongsTo.kind === "person" ? pairing.belongsTo.memberId : pairing.createdBy;
    const machineId = await ctx.db.insert("machines", {
      teamId: pairing.teamId,
      name: pairing.name,
      belongsTo: pairing.belongsTo,
      linkedBy,
      ...defaultSettings(pairing.belongsTo.kind === "team"),
      bridgeTokenHash: await sha256(token),
      hostname: args.hostname,
      os: args.os,
      tools: [],
    });
    await markSeen(ctx, machineId);
    // The bridge keeps who the machine belongs to, so it decides slot use itself (spec #3, Security).
    return {
      token,
      machineId,
      teamId: pairing.teamId,
      belongsTo: pairing.belongsTo.kind === "person" ? pairing.belongsTo.memberId : null,
      linkedBy,
    };
  },
});

export const send = publicMutation({
  args: { token: v.string(), messages: v.array(vBridgeMessage) },
  handler: async (ctx, { token, messages }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) {
      throw roomError("forbidden", "This machine was unlinked from the team.");
    }
    const now = Date.now();
    if (
      machine.lastSeenAt === undefined ||
      machine.offlineSince !== undefined ||
      now - machine.lastSeenAt > SEEN_RESOLUTION_MS
    ) {
      await markSeen(ctx, machine._id);
    }
    for (const message of messages) {
      if (message.type === "register_machine") {
        await register(ctx, machine, message);
      } else if (message.type === "limits_changed") {
        const current = (await ctx.db.get(machine._id))!;
        const patch = limitsPatch(current, message.limits);
        await ctx.db.patch(machine._id, patch);
        // The machine's own limit can put its settings below Drive (ADR 0025): drivers first.
        await handWheelsToOwner(ctx, (await ctx.db.get(machine._id))!);
        await lowerThreadsToLimit(ctx, current, patch.mostOpenAccess);
      } else if (REX_MESSAGES.has(message.type)) {
        await handleRexMessage(ctx, (await ctx.db.get(machine._id))!, message as RexMessage);
      } else if (SPACE_MESSAGES.has(message.type)) {
        await handleSpaceMessage(ctx, (await ctx.db.get(machine._id))!, message as SpaceMessage);
      } else {
        await handleBridgeMessage(ctx, (await ctx.db.get(machine._id))!, message as Exclude<BridgeMessage, SpaceMessage | RexMessage | { type: "register_machine" | "limits_changed" }>);
      }
    }
    // What this room takes beyond the first protocol (ADR 0021). A bridge from before ignores it.
    return { features: [...ROOM_FEATURES] };
  },
});

/**
 * A Claude Code session's hook claims the messages waiting for the run in one of this machine's
 * terminals (ADR 0026), or the bridge claims them to send into a T3 Code thread (`threadRef`, ADR
 * 0037): the room hands over what the run's driver may read now, labelled for that driver, and the
 * bridge answers `run_message_result` once the session has them. A bridge calls it only once the
 * room names `run_messages` in `send`'s answer, and with a thread only once it names
 * `thread_run_messages` (lib/runDelivery.ts).
 */
export const claimRunMessages = publicMutation({
  args: {
    token: v.string(),
    terminalRef: v.optional(v.string()),
    threadRef: v.optional(v.string()),
    how: vRunMessageHow,
    reserve: v.number(),
    maxFiles: v.optional(v.number()),
  },
  handler: async (ctx, { token, terminalRef, threadRef, ...args }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) throw roomError("forbidden", "This machine was unlinked from the team.");
    if ((terminalRef === undefined) === (threadRef === undefined)) throw roomError("invalid", "Name a terminal or a thread, not both.");
    return await claimRunMessages_(ctx, machine, terminalRef !== undefined ? { terminalRef, ...args } : { threadRef: threadRef!, ...args });
  },
});

/**
 * The bridge still moves a claim's files (ADR 0043): it keeps the claim's messages claimed for
 * another two minutes, up to 15 minutes after the claim (lib/runDelivery.ts). `held: false` means the
 * claim lapsed or was settled, so the bridge sends nothing. A bridge calls it only for a claim with
 * files, which only a room that names `run_message_files` hands over.
 */
export const holdRunMessages = publicMutation({
  args: { token: v.string(), claimId: v.string(), deliveryIds: v.array(v.string()) },
  handler: async (ctx, { token, claimId, deliveryIds }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) throw roomError("forbidden", "This machine was unlinked from the team.");
    return await holdRunMessages_(ctx, machine, claimId, deliveryIds);
  },
});

/**
 * A run in one of this machine's terminals, or in a T3 Code thread it reports (`threadRef`, ADR
 * 0037), posts as itself (ADR 0026): `uplink-bridge say --in <place>` and `uplink-bridge reply
 * <messageId>`, which the bridge sends here with its own token, so the agent never holds a room key.
 * It answers with the message, or a room error the bridge passes on, which `send`'s fire-and-forget
 * stream can't. A bridge calls it only once the room names `run_say` in `send`'s answer, and with a
 * thread only once it names `thread_run_messages` (lib/runSay.ts).
 */
export const runSay = publicMutation({
  args: {
    token: v.string(),
    terminalRef: v.optional(v.string()),
    threadRef: v.optional(v.string()),
    text: v.string(),
    in: v.optional(v.string()),
    replyTo: v.optional(v.string()),
    attachments: v.optional(v.array(vNewAttachment)),
  },
  handler: async (ctx, { token, terminalRef, threadRef, ...args }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) throw roomError("forbidden", "This machine was unlinked from the team.");
    if ((terminalRef === undefined) === (threadRef === undefined)) throw roomError("invalid", "Name a terminal or a thread, not both.");
    return await runSays(ctx, machine, terminalRef !== undefined ? { terminalRef, ...args } : { threadRef: threadRef!, ...args });
  },
});

/**
 * Where the bridge uploads one file a run sends with its next `bridge:runSay` (ADR 0047): `uplink-bridge
 * say --file` and `reply --file`. The upload is the run's driver's, valid for an hour, as
 * `messages.attachUrl` gives it, and only while the terminal or thread has a live run. A bridge calls
 * it only once the room names `run_say_files`.
 */
export const runAttachUrl = publicMutation({
  args: { token: v.string(), terminalRef: v.optional(v.string()), threadRef: v.optional(v.string()) },
  handler: async (ctx, { token, terminalRef, threadRef }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) throw roomError("forbidden", "This machine was unlinked from the team.");
    if ((terminalRef === undefined) === (threadRef === undefined)) throw roomError("invalid", "Name a terminal or a thread, not both.");
    return await runAttachUrl_(ctx, machine, terminalRef !== undefined ? { terminalRef } : { threadRef: threadRef! });
  },
});

/** Keeps the machine shown as online while the bridge is idle. */
export const heartbeat = publicMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) throw roomError("forbidden", "This machine was unlinked from the team.");
    await markSeen(ctx, machine._id);
    return null;
  },
});

export const inbox = publicQuery({
  args: { token: v.string(), afterSeq: v.number() },
  handler: async (ctx, { token, afterSeq }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) {
      return { messages: [{ seq: Number.MAX_SAFE_INTEGER, message: { v: 1 as const, type: "unlink" as const } }] };
    }
    // A cloud machine that is stopping keeps its queue for its next boot (#10).
    if (holdsQueue(await cloudFor(ctx, machine._id))) return { messages: [] };
    const rows = await ctx.db
      .query("bridgeOutbox")
      .withIndex("by_machine_seq", (q) => q.eq("machineId", machine._id).gt("seq", afterSeq))
      .take(500);
    return { messages: rows.map((r) => ({ seq: r.seq, message: r.message as RoomMessage })) };
  },
});

export const ack = publicMutation({
  args: { token: v.string(), upToSeq: v.number() },
  handler: async (ctx, { token, upToSeq }) => {
    const machine = await machineForToken(ctx, token);
    if (machine.unlinkedAt !== undefined) {
      // The bridge handled `unlink`: forget its token for good.
      await ctx.db.patch(machine._id, { bridgeTokenHash: undefined });
      return null;
    }
    const rows = await ctx.db
      .query("bridgeOutbox")
      .withIndex("by_machine_seq", (q) => q.eq("machineId", machine._id).lte("seq", upToSeq))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/** The machine's own limits, and its settings capped at them. */
function limitsPatch(machine: Doc<"machines">, limits: MachineLimits) {
  return {
    limits,
    ...capToLimits(
      { mostOpenAccess: machine.mostOpenAccess, slots: machine.slots, longestProfileMs: machine.longestProfileMs },
      limits,
    ),
  };
}

/**
 * A limit lowered on the machine itself (in its bridge.json, maybe while the bridge was stopped)
 * lowers the machine's most open access, and its open threads with it, as Settings does: otherwise
 * the room could pass a thread's wheel at a level the bridge has already dropped (ADR 0021).
 */
async function lowerThreadsToLimit(ctx: MutationCtx, before: Doc<"machines">, mostOpenAccess: Doc<"machines">["mostOpenAccess"]) {
  if (mostOpenAccess !== before.mostOpenAccess) await lowerThreadsAbove(ctx, before._id, mostOpenAccess);
}

/** A bridge process started. It has no terminals yet, and it is sharing. */
async function register(
  ctx: MutationCtx,
  machine: Doc<"machines">,
  message: Extract<BridgeMessage, { type: "register_machine" }>,
) {
  const limited = limitsPatch(machine, message.limits);
  await ctx.db.patch(machine._id, {
    hostname: message.hostname,
    os: message.os,
    bridgeVersion: message.bridgeVersion,
    tools: message.tools,
    ...limited,
    sharingStoppedAt: undefined,
    // A new bridge process says again what it handles and where T3 Code stands; an older one
    // started there must not be sent what only the last one handled (ADR 0021).
    bridgeFeatures: undefined,
    t3: undefined,
  });
  await markSeen(ctx, machine._id);
  // Terminals from the previous bridge process are gone; otherwise their slots stay used forever.
  // A terminal whose start is still queued never reached that process: this one starts it. A
  // bridge that sends its saved cursor (`afterSeq`) already handled every message up to it, even
  // if it never acknowledged them, so only starts after the cursor are still to come.
  const queued = await ctx.db
    .query("bridgeOutbox")
    .withIndex("by_machine_seq", (q) => q.eq("machineId", machine._id).gt("seq", message.afterSeq ?? 0))
    .collect();
  const queuedStarts = new Set(
    queued.map((r) => r.message as RoomMessage).flatMap((m) => (m.type === "start_terminal" ? [m.terminalId] : [])),
  );
  // Rows at or below the saved cursor were handled by the bridge, which may have died before
  // acknowledging them. The new process skips them for good, so they are acknowledged here; otherwise
  // they would count as work still waiting for this machine forever (#10).
  if (message.afterSeq !== undefined) {
    const passed = await ctx.db
      .query("bridgeOutbox")
      .withIndex("by_machine_seq", (q) => q.eq("machineId", machine._id).lte("seq", message.afterSeq!))
      .collect();
    for (const row of passed) await ctx.db.delete(row._id);
  }
  for (const terminal of await liveTerminalsOn(ctx, machine._id)) {
    if (terminal.status === "starting" && queuedStarts.has(terminal._id)) continue;
    await endTerminal(ctx, terminal, "failed");
  }
  // Nor does it share any Space yet. A share still queued is ended too: the person shares it again.
  await endLiveSpaces(ctx, machine._id);
  // What the last bridge found in Rex goes; a bridge that can share Rex tabs hears the room takes its
  // reports, and sends them. An older or Rex-less bridge is never told, so it never sends them.
  await forgetFoundTabs(ctx, machine._id);
  await ctx.db.patch(machine._id, { rex: undefined });
  if (message.tools.includes(REX_TABS_TOOL))
    await sendToBridge(ctx, machine._id, { v: 1, type: "room_features", features: [REX_FEATURE] });
  // Nor does it follow any thread's conversation (ADR 0022).
  await forgetFollows(ctx, machine._id);
  // Nor has it said which threads T3 Code lists: it reports each again, and those are open (ADR 0026).
  await closeThreads(ctx, machine);
  // A cloud machine whose bridge is back is running, and the idle check starts (#10).
  await bridgeRegistered(ctx, machine._id);
  // The machine's own limit can put its settings below Drive (ADR 0025): drivers first.
  await handWheelsToOwner(ctx, (await ctx.db.get(machine._id))!);
  await lowerThreadsToLimit(ctx, machine, limited.mostOpenAccess);
}
