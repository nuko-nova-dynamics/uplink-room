/**
 * Files the room hands the bridge with a message (ADR 0043): a thread message's attachments, or a
 * chat message's files that reach a run. The bridge downloads each once from the link the room gave,
 * and then hands it to the harness the way the harness takes files: T3 Code's attachments, Codex's
 * `localImage` input, Hermes's `image.attach`, or, for a harness with no input for files (Claude Code
 * in a terminal), a copy in the run's workspace whose path the message names. The link never reaches
 * the run, T3 Code or the room's views.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RoomFile } from "@uplink-room/protocol";

/** The most the bridge downloads for one file: the room's own limit for any attachment (50 MB). */
export const ROOM_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** How long one download may take. */
const DOWNLOAD_MS = 120_000;

export class RoomFileError extends Error {}

/** Downloads one file, refusing more bytes than the room said it has, or than ROOM_FILE_MAX_BYTES. */
export async function downloadRoomFile(file: RoomFile, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const limit = Math.min(ROOM_FILE_MAX_BYTES, Math.max(0, file.size));
  let response: Response;
  try {
    response = await fetchImpl(file.url, { signal: AbortSignal.timeout(DOWNLOAD_MS), redirect: "follow" });
  } catch (error) {
    throw new RoomFileError(`Couldn't download ${file.name} from the room: ${(error as Error).message}`);
  }
  if (!response.ok || !response.body) throw new RoomFileError(`Couldn't download ${file.name} from the room: HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new RoomFileError(`${file.name} is larger than the room said.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * A file name that stays one plain name in a folder: no separators, no leading dots, no control
 * characters, at most 120 characters, keeping its extension.
 */
export function safeFileName(name: string): string {
  // oxlint-disable-next-line no-control-regex -- removing control characters from a name people chose
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^[.\s]+/, "").trim();
  const base = cleaned || "file";
  if (base.length <= 120) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
  return `${base.slice(0, 120 - ext.length)}${ext}`;
}

/** The folder in a run's workspace that holds files sent to it: `.uplink-room/files`, which git ignores. */
export function filesFolder(workspace: string): string {
  return join(workspace, ".uplink-room", "files");
}

export interface SavedFile {
  name: string;
  path: string;
  kind: RoomFile["kind"];
  mimeType: string;
}

/** `O_NOFOLLOW` where the platform has it (not Windows, where the exclusive create and the checks after it stand in). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** A new file only: fails on anything already at the path, a symlink included, so nothing is written through one. */
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

/** Whether `path` is `root` or inside it, both resolved. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A folder of the workspace's own: made if it's missing, and refused if what is there is a symlink
 * (or a Windows junction) or not a folder, since the repository decides what is in the workspace
 * and a link could send the bridge's writes anywhere.
 */
async function ownFolder(path: string): Promise<void> {
  try {
    // Not recursive: one level at a time, each checked, and mkdir follows no link at its last part.
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RoomFileError(`${path} is a link or not a folder, so the bridge doesn't write there.`);
}

/**
 * Writes `bytes` at `path` in a folder `ownFolder` checked: into a new file of its own first, made
 * exclusively, then renamed over `path`, so a symlink at `path` is replaced, never written through.
 * The new file is checked to be the one the bridge opened, as Windows has no O_NOFOLLOW.
 */
async function writeOwnFile(path: string, bytes: Buffer | string): Promise<void> {
  const part = join(dirname(path), `.${randomUUID()}.part`);
  const handle = await open(part, CREATE_NEW, 0o644);
  try {
    const [opened, there] = [await handle.stat(), await lstat(part)];
    if (there.isSymbolicLink() || !there.isFile() || opened.ino !== there.ino || opened.dev !== there.dev)
      throw new RoomFileError(`${part} changed while the bridge wrote it.`);
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await unlink(part).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(part, path);
  } catch (error) {
    await unlink(part).catch(() => {});
    throw error;
  }
}

/**
 * Downloads a message's files into `<workspace>/.uplink-room/files/<folder>/`, one name each, and
 * returns where each went. `folder` is the room's id for the delivery, so a message delivered again
 * writes the same paths. The `.uplink-room` folder gets a `.gitignore` of `*`, so nothing sent to a
 * run lands in a commit. A file that fails to download is left out; the run hears it stayed in the room.
 *
 * The repository decides what is in the workspace, so the bridge follows no link it finds there:
 * `.uplink-room`, `files`, the delivery's folder and `.gitignore` must be its own, or nothing is
 * saved, and each file is written so that a link where it goes is replaced (`writeOwnFile`), and
 * must resolve inside the workspace.
 */
export async function saveRoomFiles(
  workspace: string,
  folder: string,
  files: RoomFile[],
  fetchImpl: typeof fetch = fetch,
): Promise<SavedFile[]> {
  // Paths as the run knows its workspace; the workspace itself may sit behind a link of the machine's.
  // Absolute, as the run reads them from its own working directory: a relative workspace (runs.start
  // takes one) would otherwise name `project/.uplink-room/...` to a run already in `project`.
  const root = join(resolve(workspace), ".uplink-room");
  const dir = join(root, "files", safeFileName(folder));
  let resolved: string;
  try {
    resolved = join(await realpath(workspace), ".uplink-room", "files", safeFileName(folder));
    for (const level of [root, join(root, "files"), dir]) await ownFolder(level);
    // Checked again as resolved, in case a folder was swapped for a link after its check.
    if ((await realpath(dir)) !== resolved) return [];
    const ignore = join(root, ".gitignore");
    const existing = await lstat(ignore).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) return [];
    if (!existing || (await readFile(ignore, "utf8")) !== "*\n") await writeOwnFile(ignore, "*\n");
  } catch {
    return [];
  }
  const saved: SavedFile[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const base = safeFileName(file.name);
    const dot = base.lastIndexOf(".");
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++)
      name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
    used.add(name.toLowerCase());
    try {
      const bytes = await downloadRoomFile(file, fetchImpl);
      const path = join(dir, name);
      await writeOwnFile(path, bytes);
      if (!within(resolved, await realpath(path))) throw new RoomFileError(`${path} left the run's workspace.`);
      saved.push({ name: file.name, path, kind: file.kind, mimeType: file.mimeType });
    } catch {
      // It stays in the room: the delivery says so.
    }
  }
  return saved;
}

/** How long a delivery's saved files stay in a workspace whose run's end the bridge never saw: 7 days. */
export const ROOM_FILES_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A workspace's `.uplink-room/files` folder, only when both levels are the workspace's own folders
 * (no link, as `saveRoomFiles` checks) and it resolves where the workspace does.
 */
async function ownFilesFolder(workspace: string): Promise<string | undefined> {
  const root = join(resolve(workspace), ".uplink-room");
  const files = join(root, "files");
  for (const level of [root, files]) {
    const stat = await lstat(level).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  }
  if ((await realpath(files)) !== join(await realpath(workspace), ".uplink-room", "files")) return undefined;
  return files;
}

/**
 * Removes one delivery's folder when it is a folder of its own. `rm` takes away a link inside it as
 * a link, never what it points at, and a link where the folder should be is left alone.
 */
async function removeDelivery(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  await rm(path, { recursive: true, force: true });
}

/** Removes the folders of the deliveries named (the room's ids, as `saveRoomFiles` names them), following no link. */
export async function removeRoomFiles(workspace: string, deliveries: Iterable<string>): Promise<void> {
  const dir = await ownFilesFolder(workspace).catch(() => undefined);
  if (!dir) return;
  for (const delivery of deliveries) await removeDelivery(join(dir, safeFileName(delivery))).catch(() => {});
}

/**
 * Removes a workspace's delivery folders last written more than `keptMs` ago, following no link, and
 * says how many are left.
 */
export async function pruneRoomFiles(workspace: string, keptMs = ROOM_FILES_KEPT_MS, now = Date.now()): Promise<number> {
  const dir = await ownFilesFolder(workspace).catch(() => undefined);
  if (!dir) return 0;
  let left = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    // A link or a file there isn't a delivery's folder: left alone, and not counted.
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const stat = await lstat(path).catch(() => undefined);
    if (!stat?.isDirectory()) continue;
    if (now - stat.mtimeMs > keptMs) await removeDelivery(path).catch(() => {});
    else left++;
  }
  return left;
}

/**
 * The workspaces where this bridge saved files for a run (ADR 0043), kept in a file of the bridge's
 * own (`{ v: 1, workspaces: [...] }`), so a bridge that starts again removes what a run whose end it
 * never saw left behind: on start, each workspace's delivery folders older than ROOM_FILES_KEPT_MS go,
 * and a workspace with none left is forgotten.
 */
export class RoomFilesIndex {
  private workspaces = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private file?: string;
  constructor(file?: string) {
    this.file = file;
  }
  /** Records a workspace the bridge saves files in. */
  add(workspace: string): Promise<void> {
    const path = resolve(workspace);
    if (this.workspaces.has(path)) return this.writes;
    this.workspaces.add(path);
    return this.save();
  }
  /** Reads the saved workspaces and removes their old delivery folders. */
  async prune(keptMs = ROOM_FILES_KEPT_MS, now = Date.now()): Promise<void> {
    if (!this.file) return;
    const saved = await readFile(this.file, "utf8")
      .then((text) => JSON.parse(text) as { workspaces?: unknown })
      .catch(() => undefined);
    const listed = Array.isArray(saved?.workspaces) ? saved.workspaces.filter((w): w is string => typeof w === "string") : [];
    for (const workspace of listed) {
      if ((await pruneRoomFiles(workspace, keptMs, now)) > 0) this.workspaces.add(workspace);
    }
    await this.save();
  }
  private save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, JSON.stringify({ v: 1, workspaces: [...this.workspaces] }) + "\n", { mode: 0o600 });
      })
      .catch(() => {});
    return this.writes;
  }
}
