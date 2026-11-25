/**
 * Spaces (spec #6, ADR 0009): the room's side of the rules shared with terminals, and the bridge
 * messages about Spaces. The bridge on the Space's machine enforces the same rules again.
 */
import { accessRank, minAccess, type Access, type BridgeMessageOf } from "@uplink-room/protocol";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { setRunState } from "./bridgeMessages";
import { roomError } from "./errors";
import { sendToBridge } from "./outbox";

type Machine = Doc<"machines">;

/** A Space view whose heartbeat is older than this is closed. */
export const VIEW_WINDOW_MS = 30 * 1000;
/** Screenshots kept on Space action rows, per Space. Older rows lose their image. */
const SCREENSHOTS_KEPT = 20;

export type SpaceMessage = BridgeMessageOf<
  | "spaces_found"
  | "space_shared"
  | "space_share_failed"
  | "space_access"
  | "space_ended"
  | "space_view_ready"
  | "space_view_failed"
  | "space_action_result"
  | "space_rejected"
  | "space_power"
  | "space_view_renewed"
>;

export function isLiveSpace(space: Doc<"spaces">): boolean {
  return space.status === "starting" || space.status === "live";
}

/** Throws unless the Space runs on its machine: a stopped or suspended Space takes no views or actions. */
export function requireRunning(space: Doc<"spaces">): void {
  if (space.power && space.power !== "running") {
    throw roomError("invalid", `This Space is ${space.power} on its machine. It opens again when it starts.`);
  }
}

export function isOpenView(view: Doc<"spaceViews">): boolean {
  return view.status === "requested" || view.status === "ready";
}

/** Closes a Space view in the room and tells the bridge to cut its connection. */
export async function closeView(
  ctx: MutationCtx,
  space: Doc<"spaces">,
  view: Doc<"spaceViews">,
  reason: string,
): Promise<void> {
  if (!isOpenView(view)) return;
  await ctx.db.patch(view._id, { status: "closed", closedReason: reason, ticket: undefined });
  if (isLiveSpace(space)) {
    await sendToBridge(ctx, space.machineId, { v: 1, type: "close_space_view", spaceId: space._id, viewId: view._id });
  }
}

export async function viewsOf(ctx: MutationCtx, spaceId: Id<"spaces">) {
  return ctx.db
    .query("spaceViews")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .collect();
}

/**
 * Call after a Space's access drops to `access`. Below Drive its pending wheel requests are
 * cancelled; below Suggest its pending suggestions are dismissed.
 */
export async function cancelWhatSpaceAccessForbids(ctx: MutationCtx, spaceId: Id<"spaces">, access: Access) {
  if (accessRank(access) < accessRank("drive")) {
    const requests = await ctx.db
      .query("spaceWheelRequests")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  }
  if (accessRank(access) < accessRank("suggest")) {
    const suggestions = await ctx.db
      .query("spaceSuggestions")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    for (const s of suggestions) if (s.status === "pending") await ctx.db.patch(s._id, { status: "dismissed" });
  }
}

/** Lowers every live Space on a machine that is above `access`, marking the level it had before. */
export async function lowerSpacesAbove(ctx: MutationCtx, machineId: Id<"machines">, access: Access) {
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  for (const space of spaces) {
    if (!isLiveSpace(space) || accessRank(space.access) <= accessRank(access)) continue;
    await ctx.db.patch(space._id, { access, loweredFrom: space.access });
    await cancelWhatSpaceAccessForbids(ctx, space._id, access);
    await sendToBridge(ctx, machineId, { v: 1, type: "change_space_access", spaceId: space._id, access });
  }
}

/**
 * Ends a Space in the room: closes its views, cancels its wheel requests and finishes its run.
 * The bridge is not told: callers that end it from the room send `unshare_space` or `stop_sharing`.
 */
export async function endSpace(ctx: MutationCtx, space: Doc<"spaces">, runState: "stopped" | "failed" = "stopped") {
  if (isLiveSpace(space)) await ctx.db.patch(space._id, { status: "ended", endedAt: Date.now() });
  for (const view of await viewsOf(ctx, space._id)) {
    if (isOpenView(view)) await ctx.db.patch(view._id, { status: "closed", closedReason: "space_ended", ticket: undefined });
  }
  const requests = await ctx.db
    .query("spaceWheelRequests")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  if (space.runId) {
    const run = await ctx.db.get(space.runId);
    if (run && run.state !== "done" && run.state !== "failed" && run.state !== "stopped") {
      await setRunState(ctx, run._id, runState, undefined);
    }
  }
}

/** Ends every live Space on a machine, as stopping sharing, unlinking or a bridge restart does. */
export async function endLiveSpaces(ctx: MutationCtx, machineId: Id<"machines">) {
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  for (const space of spaces) if (isLiveSpace(space)) await endSpace(ctx, space);
}

/** Schedules the check that closes a view once its heartbeat stops. One check is pending per view. */
export async function scheduleViewCheck(ctx: MutationCtx, viewId: Id<"spaceViews">, at: number) {
  const checkId = await ctx.scheduler.runAt(at, internal.spaces.checkView, { viewId });
  await ctx.db.patch(viewId, { checkId });
}

async function spaceOn(ctx: MutationCtx, machine: Machine, ref: string) {
  const id = ctx.db.normalizeId("spaces", ref);
  const space = id ? await ctx.db.get(id) : null;
  return space && space.machineId === machine._id ? space : null;
}

async function viewOn(ctx: MutationCtx, space: Doc<"spaces">, ref: string) {
  const id = ctx.db.normalizeId("spaceViews", ref);
  const view = id ? await ctx.db.get(id) : null;
  return view && view.spaceId === space._id ? view : null;
}

/** Applies one message about Spaces from a machine's bridge. */
export async function handleSpaceMessage(ctx: MutationCtx, machine: Machine, m: SpaceMessage): Promise<void> {
  if (m.type === "spaces_found") {
    const old = await ctx.db
      .query("foundSpaces")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    for (const row of old) await ctx.db.delete(row._id);
    for (const found of m.spaces.slice(0, 200)) {
      await ctx.db.insert("foundSpaces", {
        machineId: machine._id,
        spaceRef: found.spaceRef,
        name: found.name,
        ...(found.os ? { os: found.os } : {}),
        ...(found.kind ? { kind: found.kind } : {}),
        ...(found.state ? { state: found.state } : {}),
      });
    }
    return;
  }
  const space = await spaceOn(ctx, machine, m.spaceId);
  if (!space) return;
  switch (m.type) {
    case "space_shared": {
      if (!isLiveSpace(space)) {
        // Ended in the room while the bridge was sharing it: don't leave it shared unseen.
        await sendToBridge(ctx, machine._id, { v: 1, type: "unshare_space", spaceId: space._id });
        return;
      }
      // The room asked for this share, so its access stays the room's: the report can be older
      // than a change made in the room since, a raise as well as a lowering (as for a terminal the
      // room started). The bridge's clamp to the machine's own limit arrives as `space_access`.
      const access = minAccess(space.access, machine.mostOpenAccess);
      await ctx.db.patch(space._id, { status: "live", access, gateway: m.gateway.slice(0, 8) });
      if (access !== space.access) await cancelWhatSpaceAccessForbids(ctx, space._id, access);
      return;
    }
    case "space_share_failed": {
      if (!isLiveSpace(space)) return;
      await endSpace(ctx, space, "failed");
      await ctx.db.patch(space._id, { status: "failed", failReason: m.reason });
      return;
    }
    case "space_access": {
      const access = minAccess(space.access, m.access);
      await ctx.db.patch(space._id, { access });
      await cancelWhatSpaceAccessForbids(ctx, space._id, access);
      return;
    }
    case "space_ended":
      return endSpace(ctx, space);
    case "space_power": {
      if (!isLiveSpace(space)) return;
      await ctx.db.patch(space._id, { power: m.state });
      const run = space.runId ? await ctx.db.get(space.runId) : null;
      if (m.state !== "running") {
        // Its machine stopped it: nobody stays attached, and its run isn't going on.
        for (const view of await viewsOf(ctx, space._id)) await closeView(ctx, space, view, "space_stopped");
        if (run && run.state !== "done" && run.state !== "failed") await setRunState(ctx, run._id, "stopped", undefined);
      } else if (run && run.state === "stopped") {
        await setRunState(ctx, run._id, "unknown", undefined);
      }
      return;
    }
    case "space_view_ready": {
      const view = await viewOn(ctx, space, m.viewId);
      if (!view) return;
      if (view.status !== "requested") {
        // Closed while the bridge opened it: close it there too.
        if (isLiveSpace(space)) await sendToBridge(ctx, machine._id, { v: 1, type: "close_space_view", spaceId: space._id, viewId: view._id });
        return;
      }
      await ctx.db.patch(view._id, {
        status: "ready",
        path: m.path,
        ticket: m.ticket,
        expiresAt: m.expiresAt,
        interactive: m.interactive,
      });
      return;
    }
    case "space_view_renewed": {
      const view = await viewOn(ctx, space, m.viewId);
      if (view?.status === "ready" && Number.isFinite(m.expiresAt)) await ctx.db.patch(view._id, { expiresAt: m.expiresAt });
      return;
    }
    case "space_view_failed": {
      const view = await viewOn(ctx, space, m.viewId);
      if (view && view.status === "requested") await ctx.db.patch(view._id, { status: "failed", failReason: m.reason });
      return;
    }
    case "space_action_result": {
      const id = ctx.db.normalizeId("spaceActions", m.actionId);
      const action = id ? await ctx.db.get(id) : null;
      if (!action || action.spaceId !== space._id || action.status !== "pending") return;
      await ctx.db.patch(action._id, {
        status: m.ok ? "done" : "failed",
        ...(m.error ? { error: m.error.slice(0, 500) } : {}),
        ...(m.screenshot ? { screenshot: m.screenshot } : {}),
      });
      if (m.screenshot) await dropOldScreenshots(ctx, space._id);
      return;
    }
    case "space_rejected": {
      const memberId = ctx.db.normalizeId("members", m.memberId);
      const member = memberId ? await ctx.db.get(memberId) : null;
      await ctx.db.insert("audit", {
        teamId: machine.teamId,
        actorId: member && member.teamId === machine.teamId ? member._id : machine.linkedBy,
        action: "space.rejected_by_bridge",
        target: space._id,
        details: { reason: m.reason, machineId: machine._id },
        at: Date.now(),
      });
      return;
    }
  }
}

/** Keeps the image only on the newest screenshots, so a long-driven Space doesn't pile them up. */
async function dropOldScreenshots(ctx: MutationCtx, spaceId: Id<"spaces">) {
  let kept = 0;
  for await (const action of ctx.db
    .query("spaceActions")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .order("desc")) {
    if (!action.screenshot) continue;
    if (++kept > SCREENSHOTS_KEPT) await ctx.db.patch(action._id, { screenshot: undefined });
    if (kept > SCREENSHOTS_KEPT + 50) break;
  }
}
