import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineLimits } from "@uplink-room/protocol";
export const DEFAULT_LIMITS: MachineLimits = {
  mostOpenAccess: "suggest",
  slots: 2,
  longestProfileMs: 7 * 24 * 60 * 60 * 1000,
};
export interface BridgeConfig {
  url?: string;
  token?: string;
  machineId?: string;
  teamId?: string;
  /** Who the machine belongs to, from pairing: a member id, or null for a team machine. */
  belongsTo?: string | null;
  /** Who linked the machine, from pairing. */
  linkedBy?: string;
  afterSeq?: number;
  limits: MachineLimits;
  /**
   * The T3 Code client session from `uplink-bridge t3-pair`: the server's URL and a bearer token
   * with `orchestration:read` and `orchestration:operate`. It stays on this machine; the bridge
   * never sends it to the room. `expiresAt` (ms) is when T3 Code ends the session, saved from the
   * pairing since ADR 0021; the room hears it, not the token.
   */
  t3?: { url: string; token: string; expiresAt?: number };
}
/**
 * The bridge's private folder: `UPLINK_BRIDGE_HOME` if set, else
 * `~/.uplink-room` on macOS and Linux. On Windows it's
 * `%LOCALAPPDATA%\Uplink Room\bridge`, inside the person's profile, whose
 * folder permissions already admit only them, SYSTEM and administrators;
 * Windows has no 0600 file modes, so the modes below change nothing there.
 */
export function bridgeHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (env.UPLINK_BRIDGE_HOME) return env.UPLINK_BRIDGE_HOME;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local");
    return win32.join(local, "Uplink Room", "bridge");
  }
  return join(homedir(), ".uplink-room");
}
export function validateLimits(limits: MachineLimits) {
  if (
    !["watch", "suggest", "drive", "open"].includes(limits.mostOpenAccess) ||
    !Number.isSafeInteger(limits.slots) ||
    limits.slots < 0 ||
    !Number.isFinite(limits.longestProfileMs) ||
    limits.longestProfileMs <= 0
  )
    throw new Error("Invalid local limits");
  return { ...limits };
}
export async function loadConfig(home = bridgeHome()): Promise<BridgeConfig> {
  try {
    const config = JSON.parse(await readFile(join(home, "bridge.json"), "utf8")) as BridgeConfig;
    config.limits = validateLimits(config.limits);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { limits: { ...DEFAULT_LIMITS } };
    throw error;
  }
}
/** How long a config writer waits for the lock before giving up. */
const LOCK_WAIT_MS = 10_000;
/**
 * A lock older than this is stale whoever holds it. Writers hold it only for one read and write of
 * bridge.json, so this only matters when the holder's pid was reused by an unrelated process.
 */
const LOCK_STALE_MS = 30_000;
function alive(pid: number) {
  try {
    // Signal 0 tests whether the process exists, on Windows too. EPERM means it exists.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
/**
 * Runs `action` holding `bridge.json.lock`, the one lock every writer of bridge.json takes (a
 * running bridge's saves, `pair`, `t3-pair`, `limits` and `unlink`), so no write lands between
 * another writer's read and write. The lock is a file created with `wx`, which fails if it exists,
 * holding the holder's pid. A lock whose process has exited, or older than `LOCK_STALE_MS`, is
 * stale and is removed. Only one waiter removes it: it first takes `bridge.json.lock.break` the
 * same way, then checks that the lock is still the stale one it read.
 */
export async function withConfigLock<T>(
  home: string,
  action: () => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "bridge.json.lock");
  const nonce = randomUUID();
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (await createLock(lock, nonce)) break;
    // Undefined: released meanwhile, or (on Windows) still being deleted.
    const holder = await readLock(lock);
    if (holder !== undefined && stale(holder)) {
      await breakLock(lock, holder);
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(
        `bridge.json is locked by process ${holder?.pid ?? "unknown"}. If no uplink-bridge command is running, delete ${lock}.`,
      );
    await sleep(holder === undefined ? 2 : 10 + Math.random() * 20);
  }
  try {
    return await action();
  } finally {
    await rm(lock, { force: true, maxRetries: 5 });
  }
}
interface LockHolder {
  pid?: number;
  nonce?: string;
  at: number;
}
async function createLock(path: string, nonce: string) {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, at: Date.now() }));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || deletePending(error)) return false;
    throw error;
  }
}
/**
 * Windows refuses to open a file that another process has deleted but not yet closed (EPERM,
 * sometimes EACCES). For the lock that means a holder is releasing it: busy, not forbidden.
 */
function deletePending(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}
async function readLock(path: string): Promise<LockHolder | undefined> {
  try {
    const text = await readFile(path, "utf8");
    try {
      const saved = JSON.parse(text) as Partial<LockHolder>;
      if (Number.isSafeInteger(saved.pid) && Number.isFinite(saved.at)) return saved as LockHolder;
    } catch {}
    // Empty or partly written: its writer is between creating and filling it, or died there. Its
    // age decides.
    return { at: (await stat(path)).mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || deletePending(error)) return undefined;
    throw error;
  }
}
function stale(holder: LockHolder) {
  return Date.now() - holder.at > LOCK_STALE_MS || (holder.pid !== undefined && !alive(holder.pid));
}
async function breakLock(lock: string, holder: LockHolder) {
  const gate = `${lock}.break`;
  if (!(await createLock(gate, randomUUID()))) {
    // Another waiter is breaking it. A gate left by a process that died is removed the same way.
    const breaker = await readLock(gate);
    if (breaker && stale(breaker)) await rm(gate, { force: true, maxRetries: 5 });
    await sleep(10);
    return;
  }
  try {
    const now = await readLock(lock);
    if (now && now.pid === holder.pid && now.nonce === holder.nonce && now.at === holder.at)
      await rm(lock, { force: true });
  } finally {
    await rm(gate, { force: true, maxRetries: 5 });
  }
}
/**
 * Changes the saved config on disk under the config lock: re-reads `bridge.json`, applies
 * `change`, and saves it, so fields other commands wrote since (`pair`, `t3-pair`) are kept. With
 * `token`, it changes nothing and returns false unless the saved pairing still has that token: a
 * running bridge's saves can never put back a pairing that `pair` replaced.
 */
export async function updateConfig(
  home: string,
  change: (config: BridgeConfig) => void,
  options: { token?: string; waitMs?: number } = {},
) {
  return withConfigLock(
    home,
    async () => {
      const config = await loadConfig(home);
      if (options.token !== undefined && config.token !== options.token) return false;
      change(config);
      await saveConfig(config, home);
      return true;
    },
    options,
  );
}
/**
 * Writes the whole config. Not locked: commands change it with `updateConfig`, which calls this
 * under the lock.
 */
export async function saveConfig(config: BridgeConfig, home = bridgeHome()) {
  validateLimits(config.limits);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const path = join(home, "bridge.json");
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, path);
  await chmod(path, 0o600);
}
