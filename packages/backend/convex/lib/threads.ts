/**
 * T3 Code thread runs as places teammates work in (ADR 0021): a thread has an access level and a
 * driver, like a terminal. The thread itself lives in T3 Code on its machine; the room keeps its
 * access on the run (`threadAccess`) and its driver in `driverId`.
 */
import {
  accessRank,
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
  runtimeModeRank,
  type Access,
  type BridgeFeature,
  type RuntimeMode,
} from "@uplink-room/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { sendToBridge } from "./outbox";

/** A run that is a T3 Code thread on a machine. */
export type ThreadRun = Doc<"runs"> & { threadRef: string; machineId: Id<"machines"> };

export function isThreadRun(run: Doc<"runs">): run is ThreadRun {
  return run.threadRef !== undefined && run.machineId !== undefined;
}

/** A thread's access: Watch for a thread run from before ADR 0021. */
export function threadAccessOf(run: Doc<"runs">): Access {
  return run.threadAccess ?? "watch";
}

/**
 * Whether the room still works with this thread. A run the room stopped (someone stopped it, or its
 * machine was unlinked) is over for the room, whatever T3 Code does with the thread later. A run T3
 * Code itself reported Stopped (interrupted there) can go on, as can a Done or Failed one: the
 * thread takes follow-ups.
 */
export function threadIsOpen(run: Doc<"runs">): boolean {
  return !(run.state === "stopped" && run.stoppedBy !== "bridge");
}

/** The longest message the room sends into a thread, in characters. */
export const THREAD_MESSAGE_MAX = 20_000;

/** Whether the machine's bridge said it handles a feature (`bridge_features`). */
export function bridgeHandles(machine: Doc<"machines"> | null, feature: BridgeFeature): boolean {
  return machine?.bridgeFeatures?.includes(feature) === true;
}

/**
 * Call after a thread's access drops to `access`: below Drive its pending wheel requests are
 * cancelled, so a request made at a higher level can't be granted later.
 */
export async function cancelThreadWhatAccessForbids(ctx: MutationCtx, runId: Id<"runs">, access: Access): Promise<void> {
  if (accessRank(access) >= accessRank("drive")) return;
  const requests = await ctx.db
    .query("threadWheelRequests")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  // Below Suggest, teammates' pending messages go too (ADR 0023).
  if (accessRank(access) >= accessRank("suggest")) return;
  const suggestions = await ctx.db
    .query("threadSuggestions")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  for (const s of suggestions) if (s.status === "pending") await ctx.db.patch(s._id, { status: "dismissed" });
}

/**
 * The machine's most open access dropped to `access`: every open thread run above it is lowered,
 * keeps the level it had (`threadLoweredFrom`), and its bridge hears the new level.
 */
export async function lowerThreadsAbove(ctx: MutationCtx, machineId: Id<"machines">, access: Access): Promise<void> {
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machineId))
    .collect();
  for (const run of runs) {
    if (!isThreadRun(run) || !threadIsOpen(run)) continue;
    const current = threadAccessOf(run);
    if (accessRank(current) <= accessRank(access)) continue;
    await ctx.db.patch(run._id, { threadAccess: access, threadLoweredFrom: current });
    await cancelThreadWhatAccessForbids(ctx, run._id, access);
    await sendToBridge(ctx, machineId, { v: 1, type: "change_thread_access", threadRef: run.threadRef, access });
  }
}

/** A run's permission mode (ADR 0043): `approval-required` for a run that never named one. */
export function runtimeModeOf(run: Pick<Doc<"runs">, "runtimeMode">): RuntimeMode {
  return run.runtimeMode ?? DEFAULT_RUNTIME_MODE;
}

/** The most permissive mode a run on this machine may use (ADR 0043): `approval-required` until its owner allows more. */
export function machineModeCap(machine: Pick<Doc<"machines">, "mostPermissiveMode">): RuntimeMode {
  return machine.mostPermissiveMode ?? DEFAULT_RUNTIME_MODE;
}

/** Whether `mode` is past what the machine allows. */
export function aboveModeCap(machine: Pick<Doc<"machines">, "mostPermissiveMode">, mode: RuntimeMode): boolean {
  return runtimeModeRank(mode) > runtimeModeRank(machineModeCap(machine));
}

/** What the app and the Room API say when a mode is past the machine's cap. */
export function modeCapText(machine: Pick<Doc<"machines">, "name" | "mostPermissiveMode">): string {
  return `${machine.name} allows at most ${machineModeCap(machine)}. Whoever it belongs to can allow more in its settings.`;
}

/**
 * The most permissive mode below `limit` (or at it, when `inclusive`) that a thread's provider takes
 * (`offered`, from `thread_mode`; every mode when it listed none). Approval-required when the
 * provider lists nothing under the limit, since it is the least the agent may do. Undefined when
 * nothing is under the limit: `limit` is approval-required and not inclusive.
 */
export function modeUnder(limit: RuntimeMode, offered: readonly RuntimeMode[] | undefined, inclusive: boolean): RuntimeMode | undefined {
  const under = RUNTIME_MODES.filter((m) => (inclusive ? runtimeModeRank(m) <= runtimeModeRank(limit) : runtimeModeRank(m) < runtimeModeRank(limit)));
  return under.filter((m) => !offered || offered.includes(m)).at(-1) ?? under[0];
}

/** Asks a thread's bridge for a lower mode on behalf of the machine's cap: the bridge takes a lower mode from anyone. */
async function askCapMode(ctx: MutationCtx, machine: Doc<"machines">, run: ThreadRun, mode: RuntimeMode, loweredFrom: RuntimeMode | undefined) {
  await ctx.db.patch(run._id, {
    runtimeModeRequested: loweredFrom === undefined ? undefined : { mode, at: Date.now(), loweredFrom },
  });
  const by = machine.belongsTo.kind === "person" ? machine.belongsTo.memberId : machine.linkedBy;
  const member = await ctx.db.get(by);
  await sendToBridge(ctx, machine._id, {
    v: 1,
    type: "set_thread_mode",
    threadRef: run.threadRef,
    // The machine's cap, not the driver, lowers it.
    from: { memberId: by, name: member?.name ?? "The machine's owner" },
    runtimeMode: mode,
  });
}

/**
 * The machine's cap on permission modes is `cap` (ADR 0043): every open thread run above it is asked
 * to lower to the most permissive mode its provider takes within the cap (`modeUnder`), and its
 * bridge hears the new mode; one with a pending change above it keeps the mode it has, and the
 * change is dropped. Its `runtimeMode` stays the mode in effect until T3 Code confirms the lower
 * one, which then keeps the mode it had (`runtimeModeLoweredFrom`); a refusal tries the next lower
 * mode, and stops the run once none is left (`capLoweringRefused`). Called on every save of the
 * cap, so saving it again asks again. A bridge that can't change a thread's mode (no
 * `thread_modes`) started it asking for approvals, so it has none above any cap. Terminals keep the
 * flags they started with: the change reaches only runs started after it, and the app says so.
 */
export async function lowerThreadModesAbove(ctx: MutationCtx, machine: Doc<"machines">, cap: RuntimeMode): Promise<void> {
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id))
    .collect();
  for (const run of runs) {
    if (!isThreadRun(run) || !threadIsOpen(run)) continue;
    const current = runtimeModeOf(run);
    const pending = run.runtimeModeRequested?.mode;
    const above = (mode: RuntimeMode) => runtimeModeRank(mode) > runtimeModeRank(cap);
    if (!above(current) && !(pending && above(pending))) continue;
    if (!bridgeHandles(machine, "thread_modes")) continue;
    // A thread within the cap whose driver asked for more keeps its mode: the change is dropped, and
    // the bridge is told the mode it has, in case the change already reached T3 Code. Never raised.
    if (!above(current)) await askCapMode(ctx, machine, run, current, undefined);
    else await askCapMode(ctx, machine, run, modeUnder(cap, run.runtimeModes, true)!, current);
  }
}

/**
 * A thread whose mode in effect, as its bridge reported it, is above its machine's cap (ADR 0043):
 * raised in T3 Code itself, or a driver's raise that reached T3 Code while the cap was lowered and
 * its rollback was lost. It is lowered as lowerThreadModesAbove would, unless a lowering is already
 * on its way, so whatever order the reports come in, no thread stays above its cap.
 */
export async function keepWithinModeCap(ctx: MutationCtx, machine: Doc<"machines">, runId: Id<"runs">): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || !isThreadRun(run) || !threadIsOpen(run)) return;
  if (!aboveModeCap(machine, runtimeModeOf(run)) || run.runtimeModeRequested?.loweredFrom !== undefined) return;
  if (!bridgeHandles(machine, "thread_modes")) return;
  await askCapMode(ctx, machine, run, modeUnder(machineModeCap(machine), run.runtimeModes, true)!, runtimeModeOf(run));
}

/**
 * The bridge refused a mode that would have brought the thread within its machine's cap (ADR 0043):
 * one the cap asked for, or a driver's choice that replaced it, so the thread is still above its
 * cap. The next lower mode its provider takes is asked for; once none is left, or the bridge
 * couldn't set a mode at all, the room stops the run, as runs.stop does, and marks it
 * (`runtimeModeOverCap`), so no agent keeps working for the room past what its machine allows.
 */
export async function capLoweringRefused(ctx: MutationCtx, machine: Doc<"machines">, run: ThreadRun, refused: RuntimeMode, reason: string) {
  const asked = run.runtimeModeRequested;
  if (!asked || (asked.loweredFrom === undefined && !aboveModeCap(machine, runtimeModeOf(run)))) return;
  const loweredFrom = asked.loweredFrom ?? runtimeModeOf(run);
  const next = reason === "mode_failed" ? modeUnder(refused, run.runtimeModes, false) : undefined;
  if (next) return await askCapMode(ctx, machine, run, next, loweredFrom);
  const now = Date.now();
  await ctx.db.patch(run._id, {
    state: "stopped",
    stoppedBy: "room",
    prompt: undefined,
    stateChangedAt: now,
    endedAt: now,
    runtimeModeRequested: undefined,
    runtimeModeOverCap: true,
  });
  await sendToBridge(ctx, machine._id, { v: 1, type: "stop_thread", threadRef: run.threadRef });
  await ctx.db.insert("audit", {
    teamId: machine.teamId,
    actorId: machine.belongsTo.kind === "person" ? machine.belongsTo.memberId : machine.linkedBy,
    action: "run.stopped",
    target: run._id,
    details: { reason: "mode_cap", mode: runtimeModeOf(run), cap: machineModeCap(machine), refused, bridgeReason: reason },
    at: now,
  });
}
