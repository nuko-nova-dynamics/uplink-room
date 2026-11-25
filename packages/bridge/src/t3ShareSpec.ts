/**
 * The T3 Code sharing types and checks the bridge (t3Sharing.ts) and the desktop app
 * (apps/desktop/src/main/t3ThreadsSpec.ts) both use, so the two can't disagree on what a thread id
 * or a save is. Pure: no Node imports, so the app's renderer can load it too.
 */

/** Where a thread stands, for the person picking threads to share. */
export type T3ThreadState = "working" | "waiting" | "done" | "failed" | "stopped" | "idle";
export const T3_THREAD_STATES: ReadonlySet<T3ThreadState> = new Set(["working", "waiting", "done", "failed", "stopped", "idle"]);

/** A save of the threads picked on this machine: from the list `revision` names, in the T3 Code environment it names. */
export interface T3ShareRequest {
  machineId: string;
  environmentId: string;
  revision: number;
  threads: string[];
}

/** A T3 Code thread or environment id, as the bridge takes it. */
export const T3_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
/** Most threads one machine shares by pick; more is a mistake, not a choice. */
export const T3_SHARE_MAX = 500;

/** The save, with each thread named once, or the name of the field that's wrong. */
export function readShareRequest(value: unknown): T3ShareRequest | string {
  if (typeof value !== "object" || value === null) return "not an object";
  const { machineId, environmentId, revision, threads } = value as Record<string, unknown>;
  if (typeof machineId !== "string" || !machineId || machineId.length > 200) return "machineId";
  if (typeof environmentId !== "string" || !T3_ID.test(environmentId)) return "environmentId";
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return "revision";
  if (!Array.isArray(threads) || threads.length > T3_SHARE_MAX || !threads.every((id) => typeof id === "string" && T3_ID.test(id))) return "threads";
  return { machineId, environmentId, revision, threads: [...new Set(threads as string[])] };
}
