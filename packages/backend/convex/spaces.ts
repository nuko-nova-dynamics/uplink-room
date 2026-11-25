/**
 * Spaces in the Room API (spec #6, ADR 0009): sharing a Cua Space found on a machine, viewing it,
 * the wheel, suggestions and Space actions. The access and driver rules are the terminals' (#3).
 */
import { v } from "convex/values";
import { accessRank, vAccess, vSpaceAction, type SpaceAction } from "@uplink-room/protocol";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actsFor, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { requireMachineControl } from "./lib/machines";
import { audit, hiddenByRun, inTeam, maybeView, memberView, nextDriverInChannel, runsInChannel, teamMember } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import {
  cancelWhatSpaceAccessForbids,
  closeView as closeSpaceView,
  endSpace,
  isLiveSpace,
  isOpenView,
  requireRunning,
  scheduleViewCheck,
  VIEW_WINDOW_MS,
  viewsOf,
} from "./lib/spaces";
import { actorRef } from "./lib/terminals";

async function spaceView(ctx: QueryCtx, space: Doc<"spaces">) {
  const machine = await ctx.db.get(space.machineId);
  const now = Date.now();
  const views = await ctx.db
    .query("spaceViews")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  return {
    spaceId: space._id,
    spaceRef: space.spaceRef,
    name: space.name,
    os: space.os,
    kind: space.kind,
    status: space.status,
    failReason: space.failReason,
    power: space.power ?? "running",
    access: space.access,
    loweredFrom: space.loweredFrom,
    machine: machine
      ? { machineId: machine._id, name: machine.name, mostOpenAccess: machine.mostOpenAccess }
      : undefined,
    sharedBy: await memberView(ctx, space.sharedBy),
    driver: await maybeView(ctx, space.driverId),
    watching: await Promise.all(
      views
        .filter((w) => isOpenView(w) && now - w.lastSeenAt < VIEW_WINDOW_MS)
        .map((w) => memberView(ctx, w.memberId)),
    ),
    runId: space.runId,
    endedAt: space.endedAt,
  };
}

async function liveSpace(ctx: QueryCtx, actor: Actor, spaceId: Id<"spaces">) {
  const space = await inTeam(ctx, actor, spaceId);
  if (!isLiveSpace(space)) throw roomError("invalid", "This Space is no longer shared.");
  return space;
}

async function machineOf(ctx: QueryCtx, space: Doc<"spaces">) {
  const machine = await ctx.db.get(space.machineId);
  if (!machine) throw roomError("not_found", "This Space's machine is gone.");
  return machine;
}

async function canControlMachine(ctx: QueryCtx, actor: Actor, machine: Doc<"machines">) {
  try {
    await requireMachineControl(ctx, actor, machine);
    return true;
  } catch {
    return false;
  }
}

function isDriver(actor: Actor, space: Doc<"spaces">) {
  return space.driverId === actor.member._id;
}

/**
 * Only a person who drives gets an interactive view. An agent that drives works through Space
 * actions, which need the spaces.drive scope and are logged; a view needs only room.read.
 */
function interactiveFor(member: Doc<"members">, space: Doc<"spaces">) {
  return member.kind === "person" && space.driverId === member._id;
}

function requireDriver(actor: Actor, space: Doc<"spaces">) {
  if (!isDriver(actor, space)) throw roomError("forbidden", "Only the Space's driver can do this. Ask for the wheel first.");
}

function requireAtLeast(space: Doc<"spaces">, access: "suggest" | "drive", what: string) {
  if (accessRank(space.access) < accessRank(access)) {
    throw roomError("forbidden", `This Space is set to ${space.access}, so teammates can't ${what}.`);
  }
}

// ---------------------------------------------------------------------------
// Finding and sharing
// ---------------------------------------------------------------------------

export const { person: found, agent: foundAgent } = roomQuery({
  name: "spaces.found",
  description: "The Cua Spaces a machine's bridge found on it, and whether each is shared with the room.",
  scope: "room.read",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    const rows = await ctx.db
      .query("foundSpaces")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    const shared = await ctx.db
      .query("spaces")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    const out = [];
    for (const row of rows) {
      const live = shared.find((s) => s.spaceRef === row.spaceRef && isLiveSpace(s));
      // A shared Space's id only for whoever may see it (a channel-limited key: through a run it sees).
      const visible = live && !(await hiddenByRun(ctx, actor, live.runId));
      out.push({
        spaceRef: row.spaceRef,
        name: row.name,
        os: row.os,
        kind: row.kind,
        state: row.state ?? "running",
        shared: Boolean(live),
        spaceId: visible ? live._id : undefined,
      });
    }
    return out;
  },
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "spaces.list",
  description: "List the Spaces shared with the room, on every machine or on one.",
  scope: "room.read",
  args: { machineId: v.optional(v.id("machines")) },
  handler: async (ctx, actor, args) => {
    const spaces = args.machineId
      ? await ctx.db
          .query("spaces")
          .withIndex("by_machine", (q) => q.eq("machineId", args.machineId!))
          .collect()
      : await ctx.db
          .query("spaces")
          .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
          .collect();
    const visible = [];
    // A Space shared for a task from a private channel is listed only for its members (ADR 0016).
    for (const s of spaces) {
      if (s.teamId === actor.teamId && isLiveSpace(s) && !(await hiddenByRun(ctx, actor, s.runId))) visible.push(s);
    }
    return Promise.all(visible.map((s) => spaceView(ctx, s)));
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "spaces.get",
  description: "One Space: its machine, access, driver, who shared it, who is watching, and its run.",
  scope: "room.read",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => spaceView(ctx, await inTeam(ctx, actor, args.spaceId)),
});

export const { person: share, agent: shareAgent } = roomMutation({
  name: "spaces.share",
  description:
    "Share a Cua Space that a machine's bridge found (see spaces.found) with the room, at an access level up to the machine's limit. Only whoever the machine belongs to (an admin, for a team machine) can. Give taskId to make it one of that task's runs.",
  scope: "machines.manage",
  args: { machineId: v.id("machines"), spaceRef: v.string(), access: vAccess, taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    if (machine.unlinkedAt !== undefined) throw roomError("invalid", "This machine was unlinked.");
    await requireMachineControl(ctx, actor, machine);
    if (machine.sharingStoppedAt !== undefined) {
      throw roomError("invalid", "Sharing is stopped on this machine. Resume sharing first.");
    }
    const foundSpace = (
      await ctx.db
        .query("foundSpaces")
        .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
        .collect()
    ).find((row) => row.spaceRef === args.spaceRef);
    if (!foundSpace) throw roomError("not_found", "This machine's bridge hasn't found a Space with that id.");
    const existing = await ctx.db
      .query("spaces")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    if (existing.some((s) => s.spaceRef === args.spaceRef && isLiveSpace(s))) {
      throw roomError("conflict", "This Space is already shared.");
    }
    if (accessRank(args.access) > accessRank(machine.mostOpenAccess)) {
      throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
    }
    const task = args.taskId ? await inTeam(ctx, actor, args.taskId) : null;
    if (task?.closedAt !== undefined) throw roomError("invalid", "This task is closed.");
    const spaceId = await ctx.db.insert("spaces", {
      teamId: actor.teamId,
      machineId: machine._id,
      spaceRef: foundSpace.spaceRef,
      name: foundSpace.name,
      ...(foundSpace.os ? { os: foundSpace.os } : {}),
      ...(foundSpace.kind ? { kind: foundSpace.kind } : {}),
      sharedBy: actor.member._id,
      access: args.access,
      driverId: actor.member._id,
      status: "starting",
      gateway: [],
    });
    if (task) {
      // Cua reports no run state, so a Space run is Unknown until it ends (spec #6).
      const runId = await ctx.db.insert("runs", {
        teamId: actor.teamId,
        taskId: task._id,
        harness: "space",
        machineId: machine._id,
        spaceId,
        title: foundSpace.name,
        driverId: actor.member._id,
        startedBy: actor.member._id,
        state: "unknown",
        stateChangedAt: Date.now(),
        // A task from a private channel keeps its runs to that channel's members (ADR 0016).
        ...(task.directChannelId ? { directChannelId: task.directChannelId } : {}),
      });
      await ctx.db.patch(spaceId, { runId });
    }
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "share_space",
      spaceId,
      spaceRef: foundSpace.spaceRef,
      sharedBy: actorRef(actor.member),
      access: args.access,
    });
    await audit(ctx, actor, "space.shared", spaceId, { machineId: machine._id, spaceRef: foundSpace.spaceRef, access: args.access });
    return spaceId;
  },
});

export const { person: stopSharing, agent: stopSharingAgent } = roomMutation({
  name: "spaces.stopSharing",
  description: "Stop sharing a Space. Everyone's view of it closes at once. Whoever shared it, or whoever the machine belongs to, can.",
  scope: "machines.manage",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    const machine = await machineOf(ctx, space);
    if (!actsFor(actor, space.sharedBy)) await requireMachineControl(ctx, actor, machine);
    await endSpace(ctx, space);
    await sendToBridge(ctx, machine._id, { v: 1, type: "unshare_space", spaceId: space._id });
    await audit(ctx, actor, "space.unshared", space._id);
    return null;
  },
});

export const { person: setAccess, agent: setAccessAgent } = roomMutation({
  name: "spaces.setAccess",
  description:
    "Set a Space's access: watch, suggest, drive or open, up to its machine's limit. Whoever shared it picks the level; whoever the machine belongs to can always lower it.",
  scope: "spaces.drive",
  args: { spaceId: v.id("spaces"), access: vAccess },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    const machine = await machineOf(ctx, space);
    if (accessRank(args.access) > accessRank(machine.mostOpenAccess)) {
      throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
    }
    const lowering = accessRank(args.access) <= accessRank(space.access);
    if (!actsFor(actor, space.sharedBy) && !(lowering && (await canControlMachine(ctx, actor, machine)))) {
      throw roomError(
        "forbidden",
        "Only whoever shared this Space can change its access; whoever the machine belongs to can lower it.",
      );
    }
    await ctx.db.patch(space._id, { access: args.access, loweredFrom: undefined });
    await cancelWhatSpaceAccessForbids(ctx, space._id, args.access);
    await sendToBridge(ctx, machine._id, { v: 1, type: "change_space_access", spaceId: space._id, access: args.access });
    await audit(ctx, actor, "space.access_changed", space._id, { from: space.access, to: args.access });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Space views
// ---------------------------------------------------------------------------

async function myOpenView(ctx: QueryCtx, actor: Actor, spaceId: Id<"spaces">) {
  const views = await ctx.db
    .query("spaceViews")
    .withIndex("by_space_member", (q) => q.eq("spaceId", spaceId).eq("memberId", actor.member._id))
    .order("desc")
    .collect();
  return { open: views.find(isOpenView), latest: views[0] };
}

export const { person: openView, agent: openViewAgent } = roomMutation({
  name: "spaces.openView",
  description:
    "Open your view of a Space: the bridge on its machine makes a viewer link for you, interactive only if you are a person who drives it (an agent that drives acts through spaces.act). Read it with spaces.myView, and call spaces.watch every ~15 seconds while it's open.",
  scope: "room.read",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    requireRunning(space);
    const interactive = interactiveFor(actor.member, space);
    const now = Date.now();
    const { open } = await myOpenView(ctx, actor, space._id);
    const usable =
      open &&
      open.interactive === interactive &&
      (open.status === "requested" || (open.expiresAt ?? 0) > now);
    if (usable) {
      await ctx.db.patch(open._id, { lastSeenAt: now });
      return open._id;
    }
    if (open) await closeSpaceView(ctx, space, open, "replaced");
    const viewId = await ctx.db.insert("spaceViews", {
      spaceId: space._id,
      memberId: actor.member._id,
      interactive,
      status: "requested",
      lastSeenAt: now,
    });
    await scheduleViewCheck(ctx, viewId, now + VIEW_WINDOW_MS);
    await sendToBridge(ctx, space.machineId, {
      v: 1,
      type: "open_space_view",
      spaceId: space._id,
      viewId,
      viewer: actorRef(actor.member),
      interactive,
    });
    return viewId;
  },
});

export const { person: myView, agent: myViewAgent } = roomQuery({
  name: "spaces.myView",
  description:
    "Your latest view of a Space: its status and, once ready, the links to load it (one per address of the bridge's gateway). Only you can read your view's links.",
  scope: "room.read",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await inTeam(ctx, actor, args.spaceId);
    const { latest } = await myOpenView(ctx, actor, space._id);
    if (!latest) return null;
    const ready = latest.status === "ready" && latest.path && latest.ticket;
    return {
      viewId: latest._id,
      status: latest.status,
      interactive: latest.interactive,
      failReason: latest.failReason,
      closedReason: latest.closedReason,
      expiresAt: latest.expiresAt,
      urls: ready ? space.gateway.map((base) => `${base.replace(/\/$/, "")}${latest.path}#ticket=${latest.ticket}`) : [],
    };
  },
});

export const { person: watch, agent: watchAgent } = roomMutation({
  name: "spaces.watch",
  description: "Say your view of a Space is still open. Call it every ~15 seconds; a view without it for 30 seconds is closed.",
  scope: "room.read",
  agentAudit: false,
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await inTeam(ctx, actor, args.spaceId);
    const { open } = await myOpenView(ctx, actor, space._id);
    if (!open) return null;
    await ctx.db.patch(open._id, { lastSeenAt: Date.now() });
    const job = open.checkId ? await ctx.db.system.get("_scheduled_functions", open.checkId) : null;
    if (!job || (job.state.kind !== "pending" && job.state.kind !== "inProgress")) {
      await scheduleViewCheck(ctx, open._id, Date.now() + VIEW_WINDOW_MS);
    }
    return null;
  },
});

export const { person: closeView, agent: closeViewAgent } = roomMutation({
  name: "spaces.closeView",
  description: "Close your view of a Space.",
  scope: "room.read",
  agentAudit: false,
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await inTeam(ctx, actor, args.spaceId);
    const { open } = await myOpenView(ctx, actor, space._id);
    if (open) await closeSpaceView(ctx, space, open, "closed");
    return null;
  },
});

/** Closes a view whose heartbeat stopped; if it beat since, checks again at the new window's end. */
export const checkView = internalMutation({
  args: { viewId: v.id("spaceViews") },
  handler: async (ctx, { viewId }) => {
    const view = await ctx.db.get(viewId);
    if (!view || !isOpenView(view)) return null;
    const space = await ctx.db.get(view.spaceId);
    if (!space) return null;
    if (Date.now() - view.lastSeenAt >= VIEW_WINDOW_MS) await closeSpaceView(ctx, space, view, "left");
    else await scheduleViewCheck(ctx, view._id, view.lastSeenAt + VIEW_WINDOW_MS);
    return null;
  },
});

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

/**
 * Someone left a private channel or was removed from it (ADR 0016): every view they have of a
 * Space shared for one of its runs closes at once (the bridge cuts it), whether or not they drive,
 * and a Space they drive goes to nextDriverInChannel.
 */
export async function releaseChannelSpaces(ctx: MutationCtx, actor: Actor, channelId: Id<"channels">, memberId: Id<"members">) {
  for (const run of await runsInChannel(ctx, channelId)) {
    const space = run.spaceId ? await ctx.db.get(run.spaceId) : null;
    if (!space || !isLiveSpace(space)) continue;
    for (const view of await ctx.db
      .query("spaceViews")
      .withIndex("by_space_member", (q) => q.eq("spaceId", space._id).eq("memberId", memberId))
      .collect()) {
      await closeSpaceView(ctx, space, view, "removed from the channel");
    }
    if (space.driverId !== memberId) continue;
    const next = await nextDriverInChannel(ctx, actor, channelId, memberId, { startedBy: space.sharedBy, access: space.access });
    if (next) await setDriver(ctx, actor, space, next);
  }
}

/** Makes someone the Space's driver, closes views whose input no longer matches, and tells the bridge. */
async function setDriver(ctx: MutationCtx, actor: Actor, space: Doc<"spaces">, memberId: Id<"members">) {
  const member = await teamMember(ctx, actor, memberId);
  await ctx.db.patch(space._id, { driverId: member._id });
  if (space.runId) await ctx.db.patch(space.runId, { driverId: member._id });
  const requests = await ctx.db
    .query("spaceWheelRequests")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  for (const r of requests) {
    if (r.status === "pending" && r.fromId === member._id) {
      await ctx.db.patch(r._id, { status: "granted", answeredBy: actor.member._id });
    }
  }
  await sendToBridge(ctx, space.machineId, {
    v: 1,
    type: "space_driver_changed",
    spaceId: space._id,
    driver: actorRef(member),
  });
  // The old driver's view must stop taking input, and a new person driver's must start: both reopen.
  const next = { ...space, driverId: member._id };
  for (const view of await viewsOf(ctx, space._id)) {
    const viewer = await ctx.db.get(view.memberId);
    if (isOpenView(view) && viewer && view.interactive !== interactiveFor(viewer, next)) {
      await closeSpaceView(ctx, space, view, "wheel_moved");
    }
  }
  await audit(ctx, actor, "space.driver_changed", space._id, { from: space.driverId, to: member._id });
}

export const { person: requestWheel, agent: requestWheelAgent } = roomMutation({
  name: "spaces.requestWheel",
  description: "Ask the driver of a Drive (or Open) Space for the wheel.",
  scope: "spaces.drive",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    if (isDriver(actor, space)) throw roomError("conflict", "You already drive this Space.");
    requireAtLeast(space, "drive", "ask for the wheel");
    return await ctx.db.insert("spaceWheelRequests", { spaceId: space._id, fromId: actor.member._id, status: "pending" });
  },
});

export const { person: wheelRequests, agent: wheelRequestsAgent } = roomQuery({
  name: "spaces.wheelRequests",
  description: "Pending requests for a Space's wheel.",
  scope: "room.read",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await inTeam(ctx, actor, args.spaceId);
    const rows = await ctx.db
      .query("spaceWheelRequests")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .collect();
    return Promise.all(
      rows.filter((r) => r.status === "pending").map(async (r) => ({ requestId: r._id, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: answerWheelRequest, agent: answerWheelRequestAgent } = roomMutation({
  name: "spaces.answerWheelRequest",
  description: "As the Space's driver, hand the wheel to whoever asked (grant: true) or say no.",
  scope: "spaces.drive",
  args: { requestId: v.id("spaceWheelRequests"), grant: v.boolean() },
  handler: async (ctx, actor, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw roomError("not_found", "No such request.");
    const space = await liveSpace(ctx, actor, request.spaceId);
    requireDriver(actor, space);
    if (request.status !== "pending") throw roomError("conflict", "This request was already answered.");
    if (args.grant) {
      requireAtLeast(space, "drive", "be handed the wheel");
      await setDriver(ctx, actor, space, request.fromId);
    } else {
      await ctx.db.patch(request._id, { status: "denied", answeredBy: actor.member._id });
    }
    return null;
  },
});

export const { person: takeWheel, agent: takeWheelAgent } = roomMutation({
  name: "spaces.takeWheel",
  description:
    "Take the wheel of an Open Space at once. On a Drive Space, ask for it instead. On Watch and Suggest Spaces only whoever shared it (not their agent) can take it back.",
  scope: "spaces.drive",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    if (isDriver(actor, space)) return null;
    if (space.access === "drive") throw roomError("forbidden", "This Space is set to drive: ask the driver for the wheel.");
    // Below Drive the bridge accepts only whoever shared the Space as a new driver.
    if (space.access !== "open" && actor.member._id !== space.sharedBy) {
      throw roomError("forbidden", `This Space is set to ${space.access}, so only whoever shared it can take the wheel.`);
    }
    await setDriver(ctx, actor, space, actor.member._id);
    return null;
  },
});

export const { person: passWheel, agent: passWheelAgent } = roomMutation({
  name: "spaces.passWheel",
  description:
    "As the Space's driver, pass the wheel to a teammate or an agent. On Watch and Suggest Spaces the wheel can only go back to whoever shared it.",
  scope: "spaces.drive",
  args: { spaceId: v.id("spaces"), to: v.id("members") },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    if (!isDriver(actor, space) && !actsFor(actor, space.sharedBy)) {
      throw roomError("forbidden", "Only the driver, or whoever shared the Space, can pass the wheel.");
    }
    if (args.to !== space.sharedBy) requireAtLeast(space, "drive", "be handed the wheel");
    await setDriver(ctx, actor, space, args.to);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const { person: suggest, agent: suggestAgent } = roomMutation({
  name: "spaces.suggest",
  description: "Send the driver of a Suggest (or more open) Space a short suggestion. It never acts on the Space by itself.",
  scope: "spaces.drive",
  args: { spaceId: v.id("spaces"), text: v.string() },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    if (!isDriver(actor, space)) requireAtLeast(space, "suggest", "suggest");
    const text = args.text.trim();
    if (!text) throw roomError("invalid", "A suggestion needs some text.");
    if (text.length > 500) throw roomError("invalid", "Keep a suggestion under 500 characters.");
    return await ctx.db.insert("spaceSuggestions", { spaceId: space._id, fromId: actor.member._id, text, status: "pending" });
  },
});

export const { person: suggestions, agent: suggestionsAgent } = roomQuery({
  name: "spaces.suggestions",
  description: "A Space's pending suggestions.",
  scope: "room.read",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await inTeam(ctx, actor, args.spaceId);
    const rows = await ctx.db
      .query("spaceSuggestions")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.status === "pending")
        .map(async (r) => ({ suggestionId: r._id, text: r.text, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: answerSuggestion, agent: answerSuggestionAgent } = roomMutation({
  name: "spaces.answerSuggestion",
  description: "As the Space's driver, mark a suggestion done (done: true) or dismiss it.",
  scope: "spaces.drive",
  args: { suggestionId: v.id("spaceSuggestions"), done: v.boolean() },
  handler: async (ctx, actor, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) throw roomError("not_found", "No such suggestion.");
    const space = await liveSpace(ctx, actor, suggestion.spaceId);
    requireDriver(actor, space);
    if (suggestion.status !== "pending") throw roomError("conflict", "This suggestion was already answered.");
    await ctx.db.patch(suggestion._id, { status: args.done ? "done" : "dismissed", answeredBy: actor.member._id });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Space actions
// ---------------------------------------------------------------------------

const KEY_NAME = /^[a-z0-9_]{1,24}$/i;

function checkAction(action: SpaceAction) {
  const finite = (...values: (number | undefined)[]) => values.every((n) => n === undefined || Number.isFinite(n));
  const ok = (() => {
    switch (action.kind) {
      case "screenshot":
        return true;
      case "click":
        return finite(action.x, action.y) && (action.count === undefined || [1, 2, 3].includes(action.count));
      case "move":
        return finite(action.x, action.y);
      case "scroll":
        return finite(action.dx, action.dy, action.x, action.y);
      case "key":
        return action.keys.length >= 1 && action.keys.length <= 6 && action.keys.every((k) => KEY_NAME.test(k));
      case "type":
        return action.text.length >= 1 && action.text.length <= 10_000;
    }
  })();
  if (!ok) throw roomError("invalid", "This Space action isn't valid.");
}

export const { person: act, agent: actAgent } = roomMutation({
  name: "spaces.act",
  description:
    'Take a Space action on a Space you drive: {kind:"screenshot"}, {kind:"click",x,y,button?,count?,screenshotId?}, {kind:"move",x,y,screenshotId?}, {kind:"scroll",dx,dy,x?,y?,screenshotId?}, {kind:"key",keys:["ctrl","s"]} or {kind:"type",text}. With screenshotId, points are pixels of that screenshot; otherwise screen points. Returns an action id; read the result with spaces.action.',
  scope: "spaces.drive",
  args: { spaceId: v.id("spaces"), action: vSpaceAction },
  handler: async (ctx, actor, args) => {
    const space = await liveSpace(ctx, actor, args.spaceId);
    if (space.status !== "live") throw roomError("invalid", "This Space is still starting.");
    requireRunning(space);
    requireDriver(actor, space);
    checkAction(args.action);
    const actionId = await ctx.db.insert("spaceActions", {
      spaceId: space._id,
      memberId: actor.member._id,
      ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
      action: args.action,
      status: "pending",
      at: Date.now(),
    });
    await sendToBridge(ctx, space.machineId, {
      v: 1,
      type: "space_action",
      spaceId: space._id,
      actionId,
      from: actorRef(actor.member),
      action: args.action,
    });
    return actionId;
  },
});

export const { person: action, agent: actionAgent } = roomQuery({
  name: "spaces.action",
  description: "One Space action: pending, done or failed, its error, and for a screenshot the image (base64) and its screenshotId.",
  scope: "room.read",
  args: { actionId: v.id("spaceActions") },
  handler: async (ctx, actor, args) => {
    const row = await ctx.db.get(args.actionId);
    if (!row) throw roomError("not_found", "Not found in this team.");
    // Through inTeam: a Space on a private channel's run is that channel's alone (ADR 0016), so an
    // action id kept from before leaving shows nothing.
    await inTeam(ctx, actor, row.spaceId);
    return {
      actionId: row._id,
      spaceId: row.spaceId,
      action: row.action,
      status: row.status,
      error: row.error,
      screenshot: row.screenshot,
      by: await memberView(ctx, row.memberId),
      at: row.at,
    };
  },
});

export const { person: actions, agent: actionsAgent } = roomQuery({
  name: "spaces.actions",
  description: "Who did what on a Space, newest first (the last 50 Space actions), without screenshot images.",
  scope: "room.read",
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, actor, args) => {
    const space = await inTeam(ctx, actor, args.spaceId);
    const rows = await ctx.db
      .query("spaceActions")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .order("desc")
      .take(50);
    return Promise.all(
      rows.map(async (r) => ({
        actionId: r._id,
        action: r.action,
        status: r.status,
        error: r.error,
        by: await memberView(ctx, r.memberId),
        at: r.at,
      })),
    );
  },
});
