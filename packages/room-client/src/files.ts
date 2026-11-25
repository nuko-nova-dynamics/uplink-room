/**
 * Files `uplink join` shares between processes (ADR 0032): the joined sessions' own files, and the
 * Claude Code settings files their hooks go in. Each is replaced whole, so a reader never sees half
 * of one, and changes to one file are made one process at a time under its lock.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Windows refuses to rename over a file another process (or this one) has open, with EPERM, EACCES
 * or EBUSY, for as long as it stays open: a hook reading the file it replaces. On the CI runner
 * three of four renames failed while another loop read the file. Those are retried for a while.
 */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_TRIES_MS = 3000;

async function retryBusy(action: () => Promise<void>): Promise<void> {
  const until = Date.now() + RENAME_TRIES_MS;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      return await action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !BUSY.has(code) || Date.now() > until) throw error;
      await sleep(wait);
    }
  }
}

const renameOver = (from: string, to: string) => retryBusy(() => rename(from, to));
const removeLock = (file: string) => retryBusy(() => rm(file, { force: true }));

/**
 * Writes `file` whole: a temporary file beside it, then a rename over it. `mode` (such as 0o600)
 * is set on the new file before it takes the name; on Windows it means only read-only or not.
 */
export async function replaceFile(file: string, text: string, opts: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, opts.mode === undefined ? {} : { mode: opts.mode });
    if (opts.mode !== undefined) await chmod(temp, opts.mode);
    await renameOver(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** A lock older than this is taken over: what runs under one takes well under a second. */
export const STALE_LOCK_MS = 30_000;
/** How long a process waits for a lock before giving up, under the 10-second SessionEnd hook timeout. */
const LOCK_WAIT_MS = 8_000;

/** Whether the process that wrote a lock (`<pid> <id>`) still runs. A process of another user (EPERM) does. */
function holderRuns(content: string): boolean {
  const pid = Number(content.split(" ")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock as one process saw it: how old it is, who wrote it, and which file it is (a new lock at the path is another). */
type SeenLock = { age: number; holder: string; id: string };

async function seeLock(lock: string): Promise<SeenLock | undefined> {
  const s = await stat(lock).catch(() => undefined);
  if (!s) return undefined;
  // An empty lock is one its maker is still writing.
  const holder = await readFile(lock, "utf8").catch(() => "");
  return { age: Date.now() - s.mtimeMs, holder, id: `${s.ino} ${s.mtimeMs} ${holder}` };
}

/**
 * Removes an abandoned lock, if it is still the one `seen` describes. Every process that finds the
 * same abandoned lock tries, so one at a time: each first makes that lock's takeover file (O_EXCL),
 * and only the one that made it looks again and removes it. Without that, one that read the old
 * lock could remove the new lock another had just taken in its place. False when another process
 * is taking it over.
 */
async function takeOver(lock: string, seen: SeenLock, staleMs: number): Promise<boolean> {
  const marker = `${lock}.${createHash("sha256").update(seen.id).digest("hex").slice(0, 16)}.takeover`;
  try {
    await (await open(marker, "wx", 0o600)).close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (process.platform === "win32" && BUSY.has(code)) return false;
    if (code !== "EEXIST") throw error;
    // One whose taker exited halfway is cleared, for the next try.
    const age = await stat(marker).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    );
    if (age > staleMs) await removeLock(marker).catch(() => {});
    return false;
  }
  try {
    if ((await seeLock(lock))?.id === seen.id) await removeLock(lock).catch(() => {});
    return true;
  } finally {
    await removeLock(marker).catch(() => {});
  }
}

/**
 * Runs `fn` while holding `file`'s lock (`<file>.uplink-lock`, made with O_EXCL), so two processes
 * never read and write the file at once: two joins, or a join and a leave. A lock whose process
 * no longer runs, or that is STALE_LOCK_MS old, is taken over (takeOver).
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, opts: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  const lock = `${file}.uplink-lock`;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const until = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  await mkdir(dirname(lock), { recursive: true });
  const mine = `${process.pid} ${randomUUID()}`;
  for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try {
        await handle.writeFile(mine);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform === "win32" && BUSY.has(code)) {
        if (Date.now() > until) throw error;
        await sleep(wait);
        continue;
      }
      if (code !== "EEXIST") throw error;
      const seen = await seeLock(lock);
      if (!seen) continue;
      if ((seen.age > staleMs || (seen.holder !== "" && !holderRuns(seen.holder))) && (await takeOver(lock, seen, staleMs))) continue;
      if (Date.now() > until) throw new Error(`${file} stayed locked by another uplink process (${lock}).`);
      await sleep(wait);
    }
  }
  try {
    return await fn();
  } finally {
    // Only this process's own lock: one taken over as stale isn't this one's to remove.
    const held = await readFile(lock, "utf8").catch(() => "");
    if (held === mine) await removeLock(lock).catch(() => {});
  }
}

/** `withFileLock` for several files, taken in one order so two processes can't wait on each other. */
export async function withFileLocks<T>(files: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(files)].sort();
  if (!first) return fn();
  return withFileLock(first, () => withFileLocks(rest, fn));
}
