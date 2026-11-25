/**
 * The lock that serializes changes to the settings files joins and leaves share (files.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "./support.ts";

// A file URL, not a path: import() reads a Windows path's drive letter as a URL scheme.
const FILES = new URL("../src/files.ts", import.meta.url).href;

/** A process id that no longer runs: a child that has exited. */
function exitedPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

/**
 * One process that waits until `at`, takes the lock and holds it for a moment, and notes in `log`
 * when it went in and came out.
 */
const CONTENDER = `
import { appendFile } from "node:fs/promises";
const { withFileLock } = await import(process.argv[1]);
const [file, log, at] = process.argv.slice(2);
while (Date.now() < Number(at)) await new Promise((resolve) => setTimeout(resolve, 1));
await withFileLock(file, async () => {
  await appendFile(log, "in\\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await appendFile(log, "out\\n");
});
`;

test("processes that all find an abandoned lock at once hold it one at a time", async () => {
  const dir = await tempDir("uplink-lock-");
  const file = join(dir, "settings.local.json");
  const log = join(dir, "log");
  await writeFile(`${file}.uplink-lock`, `${exitedPid()} abandoned`);
  await writeFile(log, "");
  const at = String(Date.now() + 1500);
  const results = await Promise.allSettled(
    Array.from(
      { length: 24 },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", CONTENDER, FILES, file, log, at], { stdio: ["ignore", "ignore", "inherit"] });
          child.once("error", reject);
          child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`a contender exited with ${code}`))));
        }),
    ),
  );
  // Reap every contender before tempDir removes the shared directory, even on failure.
  for (const result of results) if (result.status === "rejected") throw result.reason;
  let holding = 0;
  let most = 0;
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  for (const line of lines) most = Math.max(most, (holding += line === "in" ? 1 : -1));
  expect(lines).toHaveLength(48);
  expect(most).toBe(1);
});
