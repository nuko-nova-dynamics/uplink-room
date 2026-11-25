import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const CLOSED_OUTPUT = new URL("../../protocol/src/closedOutput.ts", import.meta.url).href;

// The app's bridge as the app quits (UPLINK-ROOM-BRIDGE-3): it keeps logging while it stops, after
// the app, which read its output, is gone. It notes on disk what happened, since its output can't.
const STOPPING_BRIDGE = (guarded: boolean, notes: string) => `
import { appendFileSync } from "node:fs";
import { onClosedOutput } from ${JSON.stringify(CLOSED_OUTPUT)};
const note = (line) => appendFileSync(${JSON.stringify(notes)}, line + "\\n");
if (${guarded}) onClosedOutput(() => note("closed"));
process.on("exit", (code) => note("exit " + code));
let line = 0;
const timer = setInterval(() => {
  console.log("stopping, step " + line);
  if (++line === 20) { clearInterval(timer); note("stopped"); }
}, 20);
`;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs the script, closes its output after its first line, and returns what it noted. */
async function closeOutputUnder(guarded: boolean): Promise<string[]> {
  dir = mkdtempSync(join(tmpdir(), "closed-output-"));
  const notes = join(dir, "notes.txt");
  const child = spawn(process.execPath, ["--input-type=module", "-e", STOPPING_BRIDGE(guarded, notes)], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.once("data", () => {
    child.stdout.destroy();
    child.stderr.destroy();
  });
  await new Promise((resolve) => child.once("exit", resolve));
  return readFileSync(notes, "utf8").trim().split("\n");
}

test("without onClosedOutput, a log line after the reader is gone crashes the process (the bug)", async () => {
  expect(await closeOutputUnder(false)).toEqual(["exit 1"]);
});

test("with onClosedOutput, the process finishes what it was doing and exits cleanly", async () => {
  expect(await closeOutputUnder(true)).toEqual(["closed", "stopped", "exit 0"]);
});
