import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LocalRequestError } from "./localErrors.ts";
import type { T3Catalog, T3CatalogThread } from "./adapters/types.ts";
import { readShareRequest, T3_ID as ID, T3_SHARE_MAX, type T3ShareRequest } from "./t3ShareSpec.ts";

export { T3_SHARE_MAX, type T3ShareRequest };

/**
 * The T3 Code threads picked on this machine to share with the room (Settings, Machines, this
 * computer; `uplink-bridge t3-share`). A thread T3 Code has is private until someone here picks it:
 * pairing, choosing a project or starting a thread in T3 Code shares nothing. Threads launched for
 * room runs are always shared and are never saved here.
 *
 * The choice belongs to one pairing and one T3 Code environment. A file saved for another pairing
 * is deleted unread, as `threads.json` is, and one picked in another environment (T3 Code paired
 * again, another server) shares nothing until someone here picks again.
 */
export interface SavedT3Thread {
  id: string;
  /** As T3 Code named it when it was picked, to show it while T3 Code doesn't list it. */
  title?: string;
  project?: string;
}
export interface SavedT3Sharing {
  v: 1;
  machineId: string;
  teamId?: string;
  environmentId: string;
  threads: SavedT3Thread[];
}

/** What the local socket's `t3-threads` answers: this machine's threads, for the person here only. */
export interface T3SharingView {
  /** The pairing the bridge runs for, so the app only shows it for this machine's own settings. */
  machineId: string | null;
  /** Bumped on each saved change; a save names the revision it was made from. */
  revision: number;
  /** `sharing_stopped`: sharing is stopped on this machine, so T3 Code isn't read. `no_t3`: no T3 Code adapter. */
  state: T3Catalog["state"] | "sharing_stopped" | "no_t3";
  environmentId?: string;
  threads: T3CatalogThread[];
  /** Picked here, in this environment, but not in T3 Code's list now: shared again if it comes back. */
  missing: SavedT3Thread[];
  /** How many threads were picked in another T3 Code environment, none of which is shared here. */
  otherEnvironment?: number;
}

/** A `t3-share` request from the local socket, or a refusal that says what was wrong. */
export function parseShareRequest(value: unknown): T3ShareRequest {
  const request = readShareRequest(value);
  if (typeof request === "string") throw new LocalRequestError(`Invalid T3 Code sharing request: ${request}.`);
  return request;
}

/** The saved choice, if it was saved for this pairing. Any other file is deleted unread. */
export async function loadT3Sharing(file: string, pairing: { machineId: string; teamId?: string } | undefined): Promise<SavedT3Sharing | undefined> {
  let saved: Partial<SavedT3Sharing>;
  try {
    saved = JSON.parse(await readFile(file, "utf8")) as Partial<SavedT3Sharing>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Unreadable: nothing is shared by it, and the next save replaces it.
    return undefined;
  }
  const valid =
    saved.v === 1 &&
    !!pairing &&
    saved.machineId === pairing.machineId &&
    saved.teamId === pairing.teamId &&
    typeof saved.environmentId === "string" &&
    ID.test(saved.environmentId) &&
    Array.isArray(saved.threads);
  if (!valid) {
    await rm(file, { force: true });
    return undefined;
  }
  const threads = saved.threads!
    .filter((t): t is SavedT3Thread => typeof t?.id === "string" && ID.test(t.id))
    .slice(0, T3_SHARE_MAX)
    .map((t) => ({
      id: t.id,
      ...(typeof t.title === "string" ? { title: t.title.slice(0, 200) } : {}),
      ...(typeof t.project === "string" ? { project: t.project.slice(0, 200) } : {}),
    }));
  return { v: 1, machineId: saved.machineId!, ...(saved.teamId !== undefined ? { teamId: saved.teamId } : {}), environmentId: saved.environmentId!, threads };
}

/** Saves the choice whole, or not at all: a crash mid-write leaves the previous one. */
export async function saveT3Sharing(file: string, saved: SavedT3Sharing) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(saved), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
