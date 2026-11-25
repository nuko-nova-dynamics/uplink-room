/**
 * Where cloud machines run (#10, ADR 0013). The room talks to a provider only
 * through this interface, so Vercel Sandbox can be replaced and tests can use
 * a fake.
 *
 * A cloud machine is an ordinary team machine whose computer the room can
 * start and stop. The provider keeps its disk while it is stopped; nothing
 * else survives a stop, so the boot step starts the bridge again on every
 * boot.
 *
 * This module never loads a provider SDK: the real adapter
 * (`vercelSandbox.ts`) is loaded only by the Node actions in
 * `cloudMachineActions.ts`.
 */
import { tarballSetting } from "./cloudBoot";

/** What the provider says about a machine right now. `missing`: it has no such machine. */
export type ProviderState = "starting" | "running" | "stopping" | "stopped" | "failed" | "missing";

export type MachineSpec = {
  /** The provider's name for the machine, unique per provider project. Derived from the room's machine id. */
  name: string;
  region: string;
  vcpus: number;
  /** Labels the provider keeps with the machine, for finding it in its dashboard. */
  tags: Record<string, string>;
};

export type SessionOptions = {
  /** How long this boot may run before the provider stops it on its own. The room extends it while work goes on. */
  timeoutMs: number;
};

/** The boot step: a shell script run detached on every boot, with its environment for that boot only. */
export type BootStep = {
  script: string;
  env: Record<string, string>;
};

/** A box the provider has, as its listing shows it. */
export type ProviderBox = { name: string; state: ProviderState; tags: Record<string, string> };

export interface CloudMachineProvider {
  readonly name: string;
  /**
   * Creates the machine with a persistent disk if it doesn't exist yet, and
   * leaves it running. Safe to repeat: the name makes a retried create find
   * the same machine instead of buying a second one.
   */
  create(spec: MachineSpec, session: SessionOptions): Promise<void>;
  /**
   * Boots the machine from its kept disk if it is stopped (or keeps the
   * running session), then runs the boot step detached. Safe to repeat.
   */
  start(name: string, session: SessionOptions, boot: BootStep, generation: number): Promise<void>;
  /** Stops the machine, keeping its disk. Safe to repeat. */
  stop(name: string): Promise<void>;
  /** Lets the running session go on this much longer. */
  extend(name: string, ms: number): Promise<void>;
  status(name: string): Promise<ProviderState>;
  /** Deletes the machine and the disk snapshots only it uses. */
  delete(name: string): Promise<void>;
  /**
   * Every box tagged with this room (`ROOM_TAG`), whatever its state. The
   * reconciler compares it with what the room wants. Boxes without the tag
   * belong to someone else and are never listed.
   */
  list(room: string): Promise<ProviderBox[]>;
  /** The ids of the snapshots kept from this box. Only while the box exists: afterwards the provider lists none. */
  listSnapshots(name: string): Promise<string[]>;
  /** Deletes a snapshot by id. Safe to repeat, and on one already deleted. */
  deleteSnapshot(id: string): Promise<void>;
}

/** Tags every box carries: which Uplink Room deployment owns it, which machine it is, and the boot's generation. */
export const ROOM_TAG = "room";
export const GENERATION_TAG = "gen";

/**
 * This deployment's name, from `CONVEX_CLOUD_URL` (such as `focused-fish-459`).
 * Two deployments can share one provider project, so the reconciler only ever
 * touches boxes tagged with it. Null when unknown: then nothing is reconciled.
 */
export function roomTag(env: Record<string, string | undefined> = process.env): string | null {
  const url = env["CONVEX_CLOUD_URL"];
  if (!url) return null;
  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

let override: CloudMachineProvider | null | undefined;

/** Tests swap in a fake (or `null` for "not configured"); `undefined` goes back to the environment. */
export function setCloudProviderForTests(provider: CloudMachineProvider | null | undefined): void {
  override = provider;
}

/** The test override, if a test set one. */
export function cloudProviderOverride(): CloudMachineProvider | null | undefined {
  return override;
}

/** The Convex environment variables cloud machines need. The UI and errors name the missing ones. */
export const CLOUD_ENV_VARS = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "UPLINK_BRIDGE_TARBALL_URL"] as const;

/** The provider's own settings: without them nothing can reach a box, so there is nothing to reconcile. */
export const PROVIDER_ENV_VARS = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const;

/**
 * Whether this deployment has the provider's settings. `crons.ts` reads it when the deployment is
 * pushed (Convex evaluates cron definitions only on deploy), so a deployment without cloud machines
 * schedules no reconcile runs at all.
 */
export function providerConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return PROVIDER_ENV_VARS.every((name) => !!env[name]);
}

/** The variables still unset, or none when a test provider stands in. */
export function missingCloudEnv(env: Record<string, string | undefined> = process.env): string[] {
  if (override !== undefined) return override === null ? [...CLOUD_ENV_VARS] : [];
  // The tarball's setting counts as missing until it carries the sha256 a machine checks it against.
  return CLOUD_ENV_VARS.filter((name) =>
    name === "UPLINK_BRIDGE_TARBALL_URL" ? !tarballSetting(env[name]) : !env[name],
  );
}

/** The provider and region cloud machines start in (Julio's decision on #10, 2026-11-02). */
export const CLOUD_PROVIDER = "vercel";
export const CLOUD_REGION = "iad1";
