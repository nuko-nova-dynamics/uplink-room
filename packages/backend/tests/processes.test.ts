// @vitest-environment node
/**
 * What the backend's dev and test tooling starts stops with it: a local Convex backend's Node
 * action executor, a Vitest worker, and a `logs` tail. Each of these once ran on for days with
 * parent pid 1.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const BACKEND = fileURLToPath(new URL("..", import.meta.url));
const CONVEX = join(BACKEND, "node_modules", "convex", "bin", "main.js");
const VITEST = join(BACKEND, "node_modules", "vitest", "vitest.mjs");
const posix = process.platform !== "win32";

type Row = { pid: number; ppid: number; pgid: number; args: string };

function ps(): Row[] {
  return execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,args="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
      return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), args: row[4]! }] : [];
    });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Starts `command` in a process group of its own, which everything it starts joins; ended after the test. */
function start(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(command[0]!, command.slice(1), { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  cleanups.push(() => {
    // Windows has no `ps` and no process groups to sweep; the one child is all that runs there.
    if (!posix) return void child.kill();
    for (const row of ps()) if (row.pgid === child.pid) process.kill(row.pid, "SIGKILL");
  });
  return { child, exited, output: () => output };
}

/** A Convex project with one Node action, so a push starts the local backend's Node executor. */
function nodeActionProject() {
  const dir = mkdtempSync(join(tmpdir(), "uplink-local-backend-"));
  mkdirSync(join(dir, "convex"));
  // `convex dev` refuses a project that doesn't list convex; node_modules links to this package's.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "local-backend-check", private: true, dependencies: { convex: "*" } }));
  writeFileSync(
    join(dir, "convex", "hello.ts"),
    `"use node";\nimport { action } from "./_generated/server";\nexport const hi = action({ args: {}, handler: async () => "hi" });\n`,
  );
  symlinkSync(join(BACKEND, "node_modules"), join(dir, "node_modules"), "dir");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Records the Node executors `child`'s local backend starts (`node <tmp>/local.cjs --tempdir <tmp>`). */
function watchExecutors(child: ChildProcess) {
  const seen = new Map<number, string>();
  const timer = setInterval(() => {
    for (const row of ps()) {
      const tempdir = / --tempdir (\S+)/.exec(row.args)?.[1];
      if (row.pgid === child.pid && row.args.includes("local.cjs --ipc-path") && tempdir) seen.set(row.pid, tempdir);
    }
  }, 100);
  cleanups.push(() => clearInterval(timer));
  return seen;
}

/** Skips the test when the backend refused Node actions: it needs Node 22 or 24 on PATH. */
function skipWithoutNodeActions(output: string, skip: (note: string) => void) {
  if (output.includes("DeploymentNotConfiguredForNodeActions")) skip("the local backend runs Node actions only with Node 22 or 24 on PATH");
}

async function expectAllGone(executors: Map<number, string>, group: number) {
  await expect.poll(() => [...executors.keys()].filter(alive), { timeout: 15_000 }).toEqual([]);
  await expect.poll(() => [...executors.values()].filter((dir) => existsSync(dir)), { timeout: 15_000 }).toEqual([]);
  await expect.poll(() => ps().filter((row) => row.pgid === group && /local\.cjs|convex-local-backend/.test(row.args)), { timeout: 15_000 }).toEqual([]);
}

const ENV = { ...process.env, CONVEX_AGENT_MODE: "anonymous", CONVEX_DEPLOYMENT: "", CONVEX_DEPLOY_KEY: "" };

test.skipIf(!posix)(
  "a local backend stops its Node executor and removes its folder when `convex dev --once` ends",
  async ({ skip }) => {
    const dir = nodeActionProject();
    const run = start([process.execPath, CONVEX, "dev", "--once", "--typecheck", "disable"], { cwd: dir, env: ENV });
    const executors = watchExecutors(run.child);
    await run.exited;
    skipWithoutNodeActions(run.output(), skip);
    expect(executors.size, run.output()).toBeGreaterThan(0);
    await expectAllGone(executors, run.child.pid!);
  },
  240_000,
);

test.skipIf(!posix)(
  "SIGTERM to `convex dev` stops its local backend and the backend's Node executor",
  async ({ skip }) => {
    const dir = nodeActionProject();
    const run = start([process.execPath, CONVEX, "dev", "--typecheck", "disable"], { cwd: dir, env: ENV });
    const executors = watchExecutors(run.child);
    await expect
      .poll(() => {
        skipWithoutNodeActions(run.output(), skip);
        return executors.size > 0 && run.output().includes("Convex functions ready");
      }, { timeout: 200_000, interval: 250 })
      .toBe(true);
    process.kill(run.child.pid!, "SIGTERM");
    await run.exited;
    await expectAllGone(executors, run.child.pid!);
  },
  240_000,
);

test.skipIf(!posix)("a Vitest worker exits when Vitest's own process is killed, though a timer would keep it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uplink-held-worker-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "worker.pid");
  const doneFile = join(dir, "done");
  const config = fileURLToPath(new URL("./fixtures/held-worker/vitest.config.ts", import.meta.url));
  const env = { ...process.env, HELD_WORKER_PID_FILE: pidFile, HELD_WORKER_DONE_FILE: doneFile };
  const run = start([process.execPath, VITEST, "run", "--config", config], { cwd: BACKEND, env });
  // The worker has run its test, kept its timer, and waits for Vitest to stop it.
  await expect.poll(() => existsSync(doneFile), { timeout: 30_000 }).toBe(true);
  const worker = Number(readFileSync(pidFile, "utf8"));
  expect(alive(worker)).toBe(true);

  process.kill(run.child.pid!, "SIGKILL");
  await expect.poll(() => alive(worker), { timeout: 10_000 }).toBe(false);
}, 60_000);

test("`pnpm logs` stops by itself, and runs the Convex CLI in its own process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uplink-logs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // A deployment nobody answers at: `convex logs` alone would keep retrying.
  const env = { ...process.env, CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:9", CONVEX_SELF_HOSTED_ADMIN_KEY: "test", CONVEX_DEPLOYMENT: "" };
  const started = Date.now();
  const run = start([process.execPath, join(BACKEND, "scripts", "logs.ts"), "--for", "2", "--history", "1"], { cwd: dir, env });
  await expect.poll(() => run.output().includes("Watching logs"), { timeout: 20_000 }).toBe(true);
  if (posix) expect(ps().filter((row) => row.ppid === run.child.pid)).toEqual([]);
  await run.exited;
  expect(run.child.exitCode).toBe(0);
  expect(Date.now() - started).toBeLessThan(20_000);
}, 30_000);
