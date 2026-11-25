/**
 * Runs in Node before and after the bridge tests: ends every spawn-helper that this checkout's
 * node-pty started and that was left with parent pid 1.
 *
 * On macOS node-pty starts each terminal through its `spawn-helper`, which opens the terminal and
 * then becomes the program. If the process that called `pty.spawn` dies before the helper has
 * opened the terminal (a test worker killed mid-test), the terminal's other end is already closed:
 * the helper waits in open() forever, and nothing is left to signal it. A helper with parent pid 1
 * that is still the helper can never start its program, so ending it loses nothing
 * (microsoft/node-pty#1014).
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/** node-pty's own folder, as its helper's path starts (node-pty resolves it from its real path). */
const PTY_DIR = realpathSync(dirname(createRequire(import.meta.url).resolve("node-pty/package.json")));
const HELPER = /^\/(?:prebuilds\/[^/]+|build\/Release)\/spawn-helper(?: |$)/;

/** The pids of this checkout's orphaned spawn-helpers. Only macOS starts terminals through one. */
export function orphanedHelpers(): number[] {
  if (process.platform !== "darwin") return [];
  const ps = execFileSync("ps", ["-Ao", "pid=,ppid=,args="], { encoding: "utf8" });
  return ps.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!row || row[2] !== "1" || !row[3]!.startsWith(PTY_DIR)) return [];
    return HELPER.test(row[3]!.slice(PTY_DIR.length)) ? [Number(row[1])] : [];
  });
}

/** Ends this checkout's orphaned spawn-helpers and returns their pids. */
export function endOrphanedHelpers(): number[] {
  const pids = orphanedHelpers();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return pids;
}

export default function setup() {
  endOrphanedHelpers();
  return () => void endOrphanedHelpers();
}
