"use node";
/**
 * Cloud machines on Vercel Sandbox (#10, ADR 0013), through `@vercel/sandbox`
 * (3.9.1, read against vercel.com/docs/sandbox on 2026-11-02).
 *
 * A machine is a named, persistent sandbox: stopping it snapshots its
 * filesystem, and the next session boots from that snapshot. Only the
 * filesystem survives, so the boot step runs again on every boot. It keeps one
 * snapshot that never expires, so a stopped machine never loses its setup to
 * the 30-day default, and earlier snapshots (which may hold expired profiles)
 * are deleted as soon as a newer one exists.
 *
 * The SDK needs Node, so only the Node actions in `cloudMachineActions.ts`
 * load it, and only when they build this provider.
 */
import { BOOT_SCRIPT_PATH } from "./cloudBoot";
import { GENERATION_TAG, ROOM_TAG, type CloudMachineProvider, type ProviderState } from "./cloudProvider";

type Sdk = typeof import("@vercel/sandbox");
export type VercelCredentials = { token: string; teamId: string; projectId: string };

/** Session states the SDK reports, mapped to ours. */
const STATES: Record<string, ProviderState> = {
  pending: "starting",
  running: "running",
  stopping: "stopping",
  snapshotting: "stopping",
  stopped: "stopped",
  aborted: "stopped",
  failed: "failed",
};

function isNotFound(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 404;
}

export function vercelSandboxProvider(
  credentials: VercelCredentials,
  load: () => Promise<Sdk> = () => import("@vercel/sandbox"),
): CloudMachineProvider {
  async function get(name: string) {
    const { Sandbox } = await load();
    return Sandbox.get({ ...credentials, name });
  }

  return {
    name: "vercel",
    async create(spec, session) {
      const { Sandbox } = await load();
      await Sandbox.getOrCreate({
        ...credentials,
        name: spec.name,
        region: spec.region as never,
        resources: { vcpus: spec.vcpus },
        timeout: session.timeoutMs,
        persistent: true,
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true },
        tags: spec.tags,
      });
    },
    async start(name, session, boot, generation) {
      const sandbox = await get(name);
      // The next session's length, and which generation's boot this is. `update` never resumes;
      // writing the boot step does.
      await sandbox.update({ timeout: session.timeoutMs, tags: { ...sandbox.tags, [GENERATION_TAG]: String(generation) } });
      await sandbox.writeFiles([{ path: BOOT_SCRIPT_PATH, content: Buffer.from(boot.script), mode: 0o700 }]);
      await sandbox.runCommand({ cmd: "bash", args: [BOOT_SCRIPT_PATH], env: boot.env, detached: true });
    },
    async stop(name) {
      let sandbox;
      try {
        sandbox = await get(name);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      const state = STATES[sandbox.status] ?? "failed";
      if (state === "stopped") return;
      await sandbox.stop();
    },
    async extend(name, ms) {
      await (await get(name)).extendTimeout(ms);
    },
    async status(name) {
      try {
        return STATES[(await get(name)).status] ?? "failed";
      } catch (error) {
        if (isNotFound(error)) return "missing";
        throw error;
      }
    },
    async delete(name) {
      let sandbox;
      try {
        sandbox = await get(name);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      await sandbox.delete({ deleteOrphanSnapshots: true });
    },
    async list(room) {
      const { Sandbox } = await load();
      const boxes = [];
      // The listing takes a single tag filter: this room's tag.
      for await (const sandbox of await Sandbox.list({ ...credentials, tags: { [ROOM_TAG]: room } })) {
        // Checked again here, so a filter the API ignored can't widen what the reconciler may touch.
        if (sandbox.tags?.[ROOM_TAG] !== room) continue;
        boxes.push({ name: sandbox.name, state: STATES[sandbox.status] ?? "failed", tags: sandbox.tags ?? {} });
      }
      return boxes;
    },
    async listSnapshots(name) {
      let sandbox;
      try {
        sandbox = await get(name);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const ids = [];
      for await (const snapshot of await sandbox.listSnapshots()) {
        if (snapshot.status === "created") ids.push(snapshot.id);
      }
      return ids;
    },
    async deleteSnapshot(id) {
      const { Snapshot } = await load();
      let snapshot;
      try {
        snapshot = await Snapshot.get({ ...credentials, snapshotId: id });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      if (snapshot.status === "deleted") return;
      await snapshot.delete();
    },
  };
}
