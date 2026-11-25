import type { T3ThreadRow, T3ThreadsView } from "../../main/t3ThreadsSpec";
import type { T3ThreadsApi } from "../lib/t3Threads";

/**
 * This computer's T3 Code threads in the gym (Settings, Machines, ADR 0045), as its bridge would list
 * them: sample data, so no gym run reads this computer's real bridge. Saving takes 400 ms and keeps
 * what was picked, or for `save-fails` refuses as a folder the bridge can't write does.
 */
export type T3ThreadsScene = "list" | "save-fails" | "empty" | "bridge-off" | "unavailable" | "other-environment";

const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** Sample threads across three projects: two shared, one started from the room, the rest private. */
function sample(): T3ThreadRow[] {
  const row = (id: string, title: string, project: string, state: T3ThreadRow["state"], ago: number, shared = false, fromRoom = false): T3ThreadRow => ({
    id,
    title,
    project,
    projectRoot: `/Users/rosa/work/${project.toLowerCase().replace(/\s+/g, "-")}`,
    state,
    updatedAt: minutes(ago),
    shared: shared || fromRoom,
    fromRoom,
  });
  return [
    row("t3-1", "Round invoice totals half up", "Billing", "working", 2, true),
    row("uplink-room-gym-run", "Totals per station for the March export", "Billing", "working", 6, false, true),
    row("t3-3", "Tax export columns for the accountant", "Billing", "waiting", 9),
    row("t3-4", "Retry webhook deliveries with backoff", "Payments API", "done", 35, true),
    row("t3-5", "Personal notes: salary review prep", "Scratch", "idle", 80),
    row("t3-6", "Migrate cron jobs to the queue", "Payments API", "failed", 140),
    row("t3-7", "Draft the Q4 roadmap", "Planning", "done", 60 * 5),
    row("t3-8", "Spike: replace the PDF renderer", "Billing", "stopped", 60 * 26),
    row("t3-9", "Clean up feature flags", "Payments API", "idle", 60 * 50),
  ];
}

export function gymT3Threads(scene: T3ThreadsScene, machineId: string): T3ThreadsApi {
  let view: T3ThreadsView =
    scene === "bridge-off"
      ? { state: "bridge_off" }
      : scene === "unavailable"
        ? { state: "unavailable", error: "The bridge running on this computer can't list T3 Code threads. Restart Uplink Room, or update uplink-bridge if you run it yourself." }
        : {
            state: "ready",
            machineId,
            revision: 3,
            environmentId: "env-gym",
            threads: scene === "empty" ? [] : sample().map((t) => (scene === "other-environment" && !t.fromRoom ? { ...t, shared: false } : t)),
            missing: scene === "list" || scene === "save-fails" ? [{ id: "t3-gone", title: "Old billing migration", project: "Billing" }] : [],
            ...(scene === "other-environment" ? { otherEnvironment: 2 } : {}),
          };
  return {
    read: async () => view,
    pairedMachine: async () => machineId,
    share: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (scene === "save-fails")
        throw new Error("Couldn't save the choice on this computer (EACCES: permission denied). Nothing new is shared. Try again.");
      if (!("threads" in view)) return view;
      const picked = new Set(request.threads);
      view = {
        ...view,
        revision: view.revision + 1,
        threads: view.threads.map((t) => ({ ...t, shared: t.fromRoom || picked.has(t.id) })),
        missing: view.missing.filter((m) => picked.has(m.id)),
      };
      delete (view as { otherEnvironment?: number }).otherEnvironment;
      return view;
    },
  };
}
