/**
 * Live check for cloud machines (#10): one real Vercel Sandbox in iad1 and a
 * Convex deployment's Room API.
 *
 * It creates a small persistent sandbox with the real adapter
 * (`convex/lib/vercelSandbox.ts`), runs the real boot step
 * (`convex/lib/cloudBoot.ts`) so the bridge installs, pairs as a team machine
 * and registers, opens a terminal through the Room API and reads its output,
 * stops the box, starts it again from its kept disk, checks that the same
 * machine came back with the file the terminal wrote, then runs one reconcile
 * pass (the real `planReconcile` and adapter) over the box left running while
 * the room says the machine is stopped, which must stop it. Finally it deletes
 * the box, checks no snapshot is left, and unlinks the machine.
 *
 * Its boxes carry their own `room` tag (`live-check-<time>`), so its reconcile
 * pass can't see any deployment's real machines.
 *
 * The room is driven with `npx convex run --identity` against the deployment
 * in `.env.local`, as a throwaway person in a throwaway team, so it runs on
 * whatever Room API code that deployment already has; it never pushes code.
 *
 *   VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... \
 *   BRIDGE_TARBALL=/path/to/uplink-room-bridge-0.1.0.tgz \
 *   npx tsx scripts/cloud-machine-live.ts
 *
 * The bridge tarball is copied into the box, since the check doesn't host it
 * anywhere; a deployment sets `UPLINK_BRIDGE_TARBALL_URL` instead.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { bootScript } from "../convex/lib/cloudBoot";
import { planReconcile } from "../convex/lib/cloudReconcile";
import { vercelSandboxProvider } from "../convex/lib/vercelSandbox";

const run = promisify(execFile);
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const credentials = { token: env("VERCEL_TOKEN"), teamId: env("VERCEL_TEAM_ID"), projectId: env("VERCEL_PROJECT_ID") };
const tarballPath = env("BRIDGE_TARBALL");
const identity = JSON.stringify({ subject: `user_cloud_check_${Date.now()}`, name: "Cloud Check", email: "cloud-check@example.com" });
const started = Date.now();
const log = (...parts: unknown[]) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls a deployed function as the throwaway person. */
async function room<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { stdout } = await run("npx", ["convex", "run", "--identity", identity, fn, JSON.stringify(args)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = stdout.trim();
  return (text ? JSON.parse(text) : null) as T;
}

async function until<T>(what: string, ms: number, check: () => Promise<T | undefined | null | false>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(3000);
  }
}

const provider = vercelSandboxProvider(credentials);
const name = `uplink-live-check-${Date.now()}`;
const liveRoom = `live-check-${Date.now()}`;
const tarballInBox = "/vercel/sandbox/uplink-room-bridge.tgz";
const convexUrl = (await readFile(".env.local", "utf8")).match(/^CONVEX_URL=(.+)$/m)?.[1]?.trim();
if (!convexUrl) throw new Error("No CONVEX_URL in .env.local.");
const session = { timeoutMs: 30 * 60 * 1000 };
let teamId: string | undefined;
let machineId: string | undefined;
let lastOutput = "";
const result: Record<string, unknown> = { sandbox: name, region: "iad1" };

try {
  await room("people:ensure");
  teamId = await room<string>("teams:create", { name: `Cloud check ${new Date().toISOString().slice(0, 16)}` });
  const { code } = await room<{ code: string }>("machines:createPairingCode", { teamId, name, belongsToTeam: true });
  log("room: team and pairing code ready");

  let t = Date.now();
  await provider.create({ name, region: "iad1", vcpus: 2, tags: { app: "uplink-room", room: liveRoom } }, session);
  result["createMs"] = Date.now() - t;
  log("provider: created", name);
  const box = await Sandbox.get({ ...credentials, name });
  const probe = await box.runCommand("bash", ["-lc", ". /etc/os-release; echo $PRETTY_NAME; node -v; command -v make g++ python3 npm | tr '\\n' ' '"]);
  result["image"] = (await probe.stdout()).trim();
  log("box:", result["image"]);
  await box.writeFiles([{ path: tarballInBox, content: await readFile(tarballPath) }]);

  const boot = (pairing?: string) => ({
    script: bootScript(),
    env: { UPLINK_CONVEX_URL: convexUrl, UPLINK_BRIDGE_TARBALL: tarballInBox, ...(pairing ? { UPLINK_PAIRING_CODE: pairing } : {}) },
  });
  t = Date.now();
  await provider.start(name, session, boot(code), 1);
  const machine = await until("the bridge to pair and register", 10 * 60 * 1000, async () => {
    const machines = await room<any[]>("machines:list", { teamId });
    return machines.find((m) => m.name === name && m.online);
  });
  machineId = machine.machineId;
  result["firstBootToOnlineMs"] = Date.now() - t;
  log("room: machine online", machineId, machine.os, machine.tools);

  const taskId = await room<string>("tasks:create", { teamId, title: "Cloud machine live check" });
  const first = await room<{ terminalId: string }>("runs:start", { teamId, taskId, harness: "shell", machineId, access: "drive" });
  await until("the terminal to go live", 60_000, async () => (await room("terminals:get", { teamId, terminalId: first.terminalId })).status === "live");
  await room("terminals:input", { teamId, terminalId: first.terminalId, data: "echo uplink-live-$((40+2)) | tee /vercel/sandbox/persist.txt\r" });
  await until("the terminal's output", 60_000, async () => {
    const out = await room<{ chunks: { data: string }[] }>("terminals:output", { teamId, terminalId: first.terminalId });
    return out.chunks.map((c) => c.data).join("").includes("uplink-live-42");
  });
  result["terminal"] = "typed through the Room API; output read back";
  log("room: terminal ran and its output came back");

  t = Date.now();
  await provider.stop(name);
  result["stopMs"] = Date.now() - t;
  result["afterStop"] = await provider.status(name);
  log("provider: stopped:", result["afterStop"]);
  await until("the room to see the machine offline", 3 * 60 * 1000, async () => {
    const machines = await room<any[]>("machines:list", { teamId });
    return machines.find((m) => m.machineId === machineId && !m.online);
  });

  t = Date.now();
  await provider.start(name, session, boot(), 2);
  await until("the bridge to come back", 5 * 60 * 1000, async () => {
    const machines = await room<any[]>("machines:list", { teamId });
    return machines.find((m) => m.machineId === machineId && m.online);
  });
  result["wakeToOnlineMs"] = Date.now() - t;
  result["machinesInTeam"] = (await room<any[]>("machines:list", { teamId })).length;
  log("room: the same machine is back online");

  const second = await room<{ terminalId: string }>("runs:start", { teamId, taskId, harness: "shell", machineId, access: "drive" });
  await until("the second terminal to go live", 60_000, async () => (await room("terminals:get", { teamId, terminalId: second.terminalId })).status === "live");
  await room("terminals:input", { teamId, terminalId: second.terminalId, data: "cat /vercel/sandbox/persist.txt; ls ~/.uplink-room; command -v uplink-bridge\r" });
  const output = await until("the kept file", 60_000, async () => {
    const out = await room<{ chunks: { data: string }[] }>("terminals:output", { teamId, terminalId: second.terminalId });
    const text = out.chunks.map((c) => c.data).join("");
    lastOutput = text;
    // The command line itself shows `cat ...`, never the word alone on a line of output.
    return /[\r\n]uplink-live-42\r?\n/.test(text) && text;
  });
  result["diskKept"] = output.includes("bridge.json") ? "persist.txt and the bridge's pairing survived the stop" : "persist.txt survived";
  // Hooks run \`uplink-bridge hook ...\` from the terminal, so the bridge must be on its PATH.
  result["bridgeOnTerminalPath"] = /\.uplink-room\/npm\/bin\/uplink-bridge/.test(output);
  log("room: the file written before the stop is still there");

  // One reconcile pass: the box runs, but the room (here, a row we hand the planner) says stopped.
  const listed = await provider.list(liveRoom);
  result["listed"] = listed.map((b) => `${b.name} ${b.state} gen=${b.tags["gen"]}`);
  const plan = planReconcile(
    listed.map((b) => ({ name: b.name, state: b.state })),
    [{ cloudId: "live", resourceName: name, state: "stopped", generation: 3, stateChangedAt: Date.now() }],
    Date.now(),
  );
  result["plan"] = plan.provider.map((op) => `${op.op} ${op.name}: ${op.why}`);
  t = Date.now();
  for (const op of plan.provider) {
    if (op.op === "stop") await provider.stop(op.name);
    else await provider.delete(op.name);
  }
  result["reconcileStopMs"] = Date.now() - t;
  result["afterReconcile"] = await provider.status(name);
  log("reconcile: box is", result["afterReconcile"]);
  result["ok"] = result["afterReconcile"] === "stopped" && plan.provider.length === 1 && result["bridgeOnTerminalPath"] === true;
} catch (error) {
  result["ok"] = false;
  result["error"] = error instanceof Error ? error.message : String(error);
  if (lastOutput) result["lastTerminalOutput"] = lastOutput.slice(-1500);
  try {
    const box = await Sandbox.get({ ...credentials, name });
    const tail = await box.runCommand("bash", ["-lc", "ls -la /vercel/sandbox; tail -n 15 ~/.uplink-room/boot.log 2>/dev/null"]);
    result["bootLog"] = (await tail.stdout()).trim();
  } catch {
    // Nothing more to show.
  }
} finally {
  if (machineId && teamId) await room("machines:unlink", { teamId, machineId }).catch(() => {});
  // As the delete step does: list the snapshots while the box exists, then delete them by id after it.
  const snapshotIds = await provider.listSnapshots(name).catch(() => [] as string[]);
  result["snapshotsBeforeDelete"] = snapshotIds.length;
  await provider.delete(name).catch((error) => (result["deleteError"] = String(error)));
  result["afterDelete"] = await provider.status(name).catch((error) => String(error));
  result["snapshotsListedAfterDelete"] = await provider.listSnapshots(name).catch((error) => String(error));
  for (const id of snapshotIds) await provider.deleteSnapshot(id).catch((error) => (result["snapshotDeleteError"] = String(error)));
  result["snapshotsSwept"] = snapshotIds.length;
  log("cleanup: box", result["afterDelete"]);
  console.log(JSON.stringify(result, null, 2));
}
