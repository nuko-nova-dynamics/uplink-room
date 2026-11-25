/**
 * The reconciler's plan (#10, ADR 0013): what to do so the boxes that really
 * exist at the provider match what the room wants. Pure, so it can be tested
 * directly and run by the live check.
 *
 * Every start, stop and delete action may change the provider, and two of them
 * can race. Each action still corrects what it can on the spot, but correctness
 * rests here: the reconciler runs every 5 minutes and soon after each provider
 * action, so a leak lasts at most one interval.
 *
 * What it never touches:
 *  - boxes without this room's tag (another deployment's, or anyone else's);
 *  - a machine creating or starting whose boot the provider hasn't confirmed:
 *    its action and watchdog own it;
 *  - a running machine's box while it runs: the idle stop owns it;
 *  - a stop or delete still making progress (less than 10 minutes without any);
 *  - a machine that changed state after the listing began: the listing may be older than the change.
 */
import type { ProviderState } from "./cloudProvider";

export type BoxView = { name: string; state: ProviderState };

export type RowView = {
  cloudId: string;
  resourceName: string;
  state: "creating" | "starting" | "running" | "stopping" | "stopped" | "failed" | "deleting" | "deleted";
  generation: number;
  bootedGeneration?: number;
  stateChangedAt: number;
  lastProgressAt?: number;
  snapshotsSweptAt?: number;
  /**
   * The machine changed state after the provider listing began, so the listing may predate it (a
   * box listed stopped that has booted since). The reconciler leaves it for the next pass.
   */
  fenced?: boolean;
};

export type ProviderOp = {
  op: "stop" | "delete";
  name: string;
  /** Unset for a box no machine owns. Otherwise the op is re-checked against this generation right before the call. */
  cloudId?: string;
  generation?: number;
  why: string;
};

export type RoomOp =
  /** A confirmed boot whose box is down again (such as stopped by a stale compensating stop): boot it again. */
  | { op: "restartBoot"; cloudId: string; generation: number }
  /** A running machine whose box isn't running: the room marks it stopped and ends what ran there. */
  | { op: "boxGone"; cloudId: string; generation: number; providerState: ProviderState }
  /** A stop or delete that stopped making progress: its action died. Start it again. */
  | { op: "restartStop"; cloudId: string; generation: number }
  | { op: "restartDelete"; cloudId: string; generation: number }
  /** A deleted machine whose box is gone: delete the snapshots it left. */
  | { op: "sweepSnapshots"; cloudId: string; name: string }
  /**
   * A failed machine whose box is confirmed down: end the work the room still shows running there.
   * A stop that ran out of tries settles as an ordinary stop (#51).
   */
  | { op: "settleStopped"; cloudId: string; generation: number };

export const STALL_MS = 10 * 60 * 1000;

const UP = new Set<ProviderState>(["running", "starting"]);

export function planReconcile(boxes: BoxView[], rows: RowView[], now: number): { provider: ProviderOp[]; room: RoomOp[] } {
  const provider: ProviderOp[] = [];
  const room: RoomOp[] = [];
  const byName = new Map(rows.map((r) => [r.resourceName, r]));
  const boxByName = new Map(boxes.map((b) => [b.name, b]));

  for (const box of boxes) {
    if (!byName.has(box.name)) provider.push({ op: "delete", name: box.name, why: "no machine owns this box" });
  }

  for (const row of rows) {
    if (row.fenced) continue;
    const box = boxByName.get(row.resourceName);
    const state: ProviderState = box?.state ?? "missing";
    const stalled = now - (row.lastProgressAt ?? row.stateChangedAt) > STALL_MS;
    const at = { cloudId: row.cloudId, generation: row.generation };
    switch (row.state) {
      case "creating":
      case "starting":
        if (row.bootedGeneration === row.generation && !UP.has(state) && state !== "stopping") {
          room.push({ op: "restartBoot", ...at });
        }
        break;
      case "running":
        if (!UP.has(state)) room.push({ op: "boxGone", ...at, providerState: state });
        break;
      case "stopping":
        if (stalled) room.push({ op: "restartStop", ...at });
        break;
      case "stopped":
      case "failed":
        if (UP.has(state)) provider.push({ op: "stop", name: row.resourceName, ...at, why: `the machine is ${row.state}` });
        // A stop that gave up leaves the machine failed with its work still shown running.
        else if (row.state === "failed" && state !== "stopping") room.push({ op: "settleStopped", ...at });
        break;
      case "deleting":
        if (stalled) room.push({ op: "restartDelete", ...at });
        break;
      case "deleted":
        if (box) provider.push({ op: "delete", name: row.resourceName, ...at, why: "the machine was deleted" });
        else if (row.snapshotsSweptAt === undefined) room.push({ op: "sweepSnapshots", cloudId: row.cloudId, name: row.resourceName });
        break;
    }
  }
  return { provider, room };
}
