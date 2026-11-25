/**
 * This computer's T3 Code threads, as Settings, Machines shows them for this computer's own machine
 * (main/bridge.ts asks the bridge over its local socket; packages/bridge/src/t3Sharing.ts).
 * Threads are private until someone here shares them. The list stays on this computer: the room gets
 * nothing of a thread nobody shared, not even its title. Types and pure checks, so main, the
 * renderer, the gym and the tests share them. The id rule and the save's shape are the bridge's own
 * (t3ShareSpec.ts), so the app and the bridge can't disagree on them.
 */
import { readShareRequest, T3_ID, T3_SHARE_MAX, T3_THREAD_STATES, type T3ShareRequest, type T3ThreadState } from "@uplink-room/bridge/t3-share-spec";

export { T3_ID, T3_SHARE_MAX, type T3ShareRequest, type T3ThreadState };

export type T3ThreadRow = {
  id: string;
  title: string;
  /** The project's name in T3 Code, or its folder's. */
  project: string;
  projectRoot?: string;
  state: T3ThreadState;
  /** ISO time T3 Code last changed it, when it says. */
  updatedAt?: string;
  /** The room gets it now. */
  shared: boolean;
  /** Launched for a room run: always shared, ended only from the room or in T3 Code. */
  fromRoom: boolean;
};

/** Shared from here, but not in T3 Code's list now (archived, deleted, or older than it lists). */
export type T3MissingRow = { id: string; title?: string; project?: string };

export type T3BridgeState = "ready" | "connecting" | "needs_pairing" | "not_paired" | "sharing_stopped" | "no_t3";

export type T3ThreadsView =
  /** No bridge answers on this computer. */
  | { state: "bridge_off" }
  /** A bridge answered, but not with a list: an older bridge, or a failure it explained. */
  | { state: "unavailable"; error: string }
  | {
      state: T3BridgeState;
      /** The machine the bridge is paired as; only that machine's settings show the list. */
      machineId: string | null;
      revision: number;
      environmentId?: string;
      threads: T3ThreadRow[];
      missing: T3MissingRow[];
      /** Threads shared while T3 Code was another environment: none of them is shared now. */
      otherEnvironment?: number;
    };

const ROWS_MAX = 2000;
const STATES = T3_THREAD_STATES;
const BRIDGE_STATES = new Set<T3BridgeState>(["ready", "connecting", "needs_pairing", "not_paired", "sharing_stopped", "no_t3"]);

const text = (value: unknown, max = 300): string | undefined =>
  typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").slice(0, max) : undefined;

/** The renderer's save, or null when it isn't one: ids as the bridge takes them, at most T3_SHARE_MAX. */
export function parseT3ShareRequest(value: unknown): T3ShareRequest | null {
  const request = readShareRequest(value);
  return typeof request === "string" ? null : request;
}

/**
 * The bridge's answer as the renderer gets it: known fields only, text cut to length, rows that
 * don't parse left out. Anything that isn't a list is `unavailable`, never an empty list, so a
 * bridge that answers oddly never reads as "nothing to share".
 */
export function parseT3ThreadsView(value: unknown): T3ThreadsView {
  if (typeof value !== "object" || value === null) return { state: "unavailable", error: "The bridge answered without a list." };
  const raw = value as Record<string, unknown>;
  const state = raw["state"];
  if (typeof state !== "string" || !BRIDGE_STATES.has(state as T3BridgeState)) return { state: "unavailable", error: "The bridge answered without a list." };
  const revision = raw["revision"];
  const rows = Array.isArray(raw["threads"]) ? raw["threads"].slice(0, ROWS_MAX) : [];
  const threads: T3ThreadRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = r["id"];
    const rowState = r["state"];
    if (typeof id !== "string" || !T3_ID.test(id) || typeof rowState !== "string" || !STATES.has(rowState as T3ThreadState)) continue;
    const projectRoot = text(r["projectRoot"], 1000);
    const updatedAt = text(r["updatedAt"], 40);
    threads.push({
      id,
      title: text(r["title"])?.trim() || "Untitled thread",
      project: text(r["project"])?.trim() || "No repo",
      ...(projectRoot ? { projectRoot } : {}),
      state: rowState as T3ThreadState,
      ...(updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? { updatedAt } : {}),
      shared: r["shared"] === true || r["fromRoom"] === true,
      fromRoom: r["fromRoom"] === true,
    });
  }
  const missing: T3MissingRow[] = [];
  for (const row of Array.isArray(raw["missing"]) ? raw["missing"].slice(0, T3_SHARE_MAX) : []) {
    const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const id = r["id"];
    if (typeof id !== "string" || !T3_ID.test(id)) continue;
    const title = text(r["title"])?.trim();
    const project = text(r["project"])?.trim();
    missing.push({ id, ...(title ? { title } : {}), ...(project ? { project } : {}) });
  }
  const environmentId = raw["environmentId"];
  const other = raw["otherEnvironment"];
  return {
    state: state as T3BridgeState,
    machineId: typeof raw["machineId"] === "string" ? raw["machineId"] : null,
    revision: typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    ...(typeof environmentId === "string" && T3_ID.test(environmentId) ? { environmentId } : {}),
    threads,
    missing,
    ...(typeof other === "number" && Number.isSafeInteger(other) && other > 0 ? { otherEnvironment: other } : {}),
  };
}

/** The bridge's refusal as the person reads it. An older bridge refuses the command it doesn't know. */
export function t3BridgeError(message: string): string {
  if (message === "Local bridge command failed" || message === "Unknown local bridge command")
    return "The bridge running on this computer can't list T3 Code threads. Restart Uplink Room, or update uplink-bridge if you run it yourself.";
  return message.slice(0, 500);
}
