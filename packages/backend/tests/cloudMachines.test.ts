import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { setCloudProviderForTests } from "../convex/lib/cloudProvider";
import { vercelSandboxProvider } from "../convex/lib/vercelSandbox";
import { bootScript, tarballSetting } from "../convex/lib/cloudBoot";
import { fakeCloudProvider, type FakeCloudProvider } from "./fakeCloudProvider";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, DAY, LIMITS, newRoom, newTeam, type Room } from "./setup";

/** #10: cloud machines on demand, tested at the Room API with a fake provider. */

const MINUTE = 60 * 1000;
/**
 * Real timers, kept before the fake ones are installed. Some work in an action runs in real time
 * whatever the fake clock says: WebCrypto (`sha256`, used for every pairing code) completes on
 * Node's threadpool. Waits yield to the real event loop so that work can finish.
 */
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
let fake: FakeCloudProvider;
const TARBALL_SHA256 = "ab".repeat(32);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  vi.stubEnv("UPLINK_BRIDGE_TARBALL_URL", `https://downloads.example.com/uplink-room-bridge-0.1.0.tgz#sha256=${TARBALL_SHA256}`);
  vi.stubEnv("CONVEX_CLOUD_URL", "https://focused-fish-459.convex.cloud");
  fake = fakeCloudProvider();
  setCloudProviderForTests(fake.provider);
});

afterEach(() => {
  setCloudProviderForTests(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Runs what the room scheduled to happen now (provider calls), without jumping ahead to later checks. */
async function settle(t: Room) {
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

/** Lets time pass in small steps, running each scheduled check on the way. */
async function advance(t: Room, ms: number) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(left, 20 * 1000);
    vi.advanceTimersByTime(step);
    left -= step;
    await settle(t);
  }
}

/** Lets time pass while the bridge stays up: it sends its heartbeat every minute, as a running bridge does. */
async function advanceWithBridge(t: Room, token: string, ms: number) {
  for (let left = ms; left > 0; left -= MINUTE) {
    await advance(t, Math.min(left, MINUTE));
    await t.mutation(api.bridge.heartbeat, { token });
  }
}

async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  return { t, teamId, julio, ana };
}

/** The provider's name for the only cloud machine created so far. */
function boxName() {
  return fake.created[0]!.spec.name;
}

/**
 * The machine boots: the boot step pairs the bridge on its first boot (the
 * token then stays on the kept disk) and the bridge registers with the cursor
 * it saved, as `uplink-bridge run` does.
 */
async function bridgeBoots(t: Room, name = boxName()) {
  const boot = fake.boots.filter((b) => b.name === name).at(-1);
  if (!boot) throw new Error("The machine was never booted.");
  const disk = fake.disk(name);
  let token = disk.get("token");
  if (!token) {
    const paired = await t.mutation(api.bridge.pair, {
      code: boot.boot.env["UPLINK_PAIRING_CODE"]!,
      hostname: name,
      os: "linux",
    });
    token = paired.token;
    disk.set("token", token);
  }
  await t.mutation(api.bridge.send, {
    token,
    messages: [
      {
        v: 1,
        type: "register_machine",
        hostname: name,
        os: "linux",
        bridgeVersion: "0.1.0",
        tools: ["tmux", "claude-code"],
        limits: LIMITS,
        afterSeq: Number(disk.get("afterSeq") ?? 0),
      },
    ],
  });
  await settle(t);
  return token;
}

/** The bridge handles everything queued for it and saves its cursor on the disk. */
async function bridgeHandlesInbox(t: Room, token: string, name = boxName()) {
  const disk = fake.disk(name);
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: Number(disk.get("afterSeq") ?? 0) });
  const last = messages.at(-1)?.seq;
  if (last !== undefined) {
    disk.set("afterSeq", String(last));
    await t.mutation(api.bridge.ack, { token, upToSeq: last });
  }
  return messages.map((m) => m.message);
}

/** Julio makes a cloud machine and its bridge comes up. */
async function runningBox() {
  const r = await room();
  const machineId = (await r.julio.as.mutation(api.cloudMachines.create, {
    teamId: r.teamId,
    name: "team-box",
  })) as Id<"machines">;
  await settle(r.t);
  const token = await bridgeBoots(r.t);
  return { ...r, machineId, token };
}

async function status(r: { t: Room; teamId: Id<"teams">; julio: { as: any } }, machineId: Id<"machines">) {
  return r.julio.as.query(api.cloudMachines.status, { teamId: r.teamId, machineId });
}

async function newTask(r: { teamId: Id<"teams">; julio: { as: any } }) {
  return r.julio.as.mutation(api.tasks.create, { teamId: r.teamId, title: "Fix the flaky test" });
}

test("without the provider settings, cloud machines say what's missing and none can be made", async () => {
  setCloudProviderForTests(undefined);
  vi.stubEnv("VERCEL_TOKEN", "");
  const { julio, teamId } = await room();
  const settings = await julio.as.query(api.cloudMachines.settings, { teamId });
  expect(settings).toMatchObject({ configured: false, provider: "vercel", region: "iad1", idleMinutes: 15 });
  expect(settings.missing).toContain("VERCEL_TOKEN");
  await expect(julio.as.mutation(api.cloudMachines.create, { teamId, name: "box" })).rejects.toThrow(/not_configured/);
});

test("an admin makes a cloud machine: one persistent box in iad1 that pairs its bridge as that team machine", async () => {
  const r = await room();
  const machineId = await r.julio.as.mutation(api.cloudMachines.create, { teamId: r.teamId, name: "team-box" });
  expect(await status(r, machineId)).toMatchObject({ state: "creating", provider: "vercel", region: "iad1" });
  await settle(r.t);

  expect(fake.created).toHaveLength(1);
  expect(fake.created[0]!.spec).toMatchObject({ region: "iad1", vcpus: 2 });
  expect(fake.created[0]!.spec.name).toContain(machineId);
  // The boot step carries a one-time pairing code and the room's URL for this boot only, never in the script.
  const [boot] = fake.boots;
  expect(boot!.boot.env).toMatchObject({
    UPLINK_CONVEX_URL: "https://focused-fish-459.convex.cloud",
    UPLINK_BRIDGE_TARBALL: "https://downloads.example.com/uplink-room-bridge-0.1.0.tgz",
    UPLINK_BRIDGE_TARBALL_SHA256: TARBALL_SHA256,
  });
  expect(boot!.boot.env["UPLINK_PAIRING_CODE"]).toBeTruthy();
  expect(boot!.boot.script).not.toContain(boot!.boot.env["UPLINK_PAIRING_CODE"]);
  expect(boot!.boot.script).toContain("uplink-bridge");

  await bridgeBoots(r.t);

  // Pairing joined the machine the room already made: still one machine, now online and running.
  const machines = await r.ana.as.query(api.machines.list, { teamId: r.teamId });
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({
    machineId,
    name: "team-box",
    belongsTo: { kind: "team" },
    online: true,
    mostOpenAccess: "drive",
    cloud: { state: "running", region: "iad1" },
  });
  expect(await status(r, machineId)).toMatchObject({ state: "running" });
});

test("only admins make, stop and delete cloud machines; any member may start one; agents need the scope", async () => {
  const r = await runningBox();
  await expect(r.ana.as.mutation(api.cloudMachines.create, { teamId: r.teamId, name: "mine" })).rejects.toThrow(/admin/i);
  await expect(r.ana.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId })).rejects.toThrow(/admin/i);
  await expect(r.ana.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId })).rejects.toThrow(/admin/i);
  await r.ana.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });

  const reader = await addAgent(r.t, r.teamId, r.julio, "Reader", ["room.read"]);
  expect(await callAsAgent(r.t, reader.key, "cloudMachines.status", { machineId: r.machineId })).toMatchObject({
    ok: true,
    result: { state: "running" },
  });
  expect(await callAsAgent(r.t, reader.key, "cloudMachines.start", { machineId: r.machineId })).toMatchObject({
    ok: false,
    error: { code: "forbidden" },
  });
  // An agent can be an admin over team machines (ADR 0003), here one Julio added and made an admin.
  const ops = await addAgent(r.t, r.teamId, r.julio, "Ops", ["room.read", "machines.manage"]);
  const opsMember = (await r.julio.as.query(api.teams.members, { teamId: r.teamId })).find((m: any) => m.name === "Ops")!;
  await r.julio.as.mutation(api.members.setRole, { teamId: r.teamId, memberId: opsMember.memberId, role: "admin" });
  const made = await callAsAgent(r.t, ops.key, "cloudMachines.create", { name: "agent-box" });
  expect(made).toMatchObject({ ok: true });
  const anasAgent = await addAgent(r.t, r.teamId, r.ana, "Helper", ["room.read", "machines.manage"]);
  expect(await callAsAgent(r.t, anasAgent.key, "cloudMachines.create", { name: "nope" })).toMatchObject({
    ok: false,
    error: { code: "forbidden" },
  });
});

test("a cloud machine stops after 15 minutes with no live work, and a live terminal keeps it running", async () => {
  const r = await runningBox();
  const name = boxName();

  // A terminal is live from minute 0 to minute 20.
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });
  await advanceWithBridge(r.t, r.token, 20 * MINUTE);
  expect(fake.state(name)).toBe("running");
  await bridgeSays(r.t, r.token, { type: "terminal_ended", terminalId, exitCode: 0 });

  // Fifteen minutes with nothing live: not before, then the box stops at the provider.
  await advanceWithBridge(r.t, r.token, 14 * MINUTE);
  expect(fake.state(name)).toBe("running");
  await advanceWithBridge(r.t, r.token, 2 * MINUTE);
  expect(fake.state(name)).toBe("stopped");
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped", stopReason: "idle" });
});

test("starting a run on a stopped cloud machine starts it, waits for its bridge, then starts the terminal", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(fake.state(name)).toBe("stopped");
  fake.disk(name).set("work.txt", "kept on the disk");

  const taskId = await newTask(r);
  const { runId, terminalId } = await r.ana.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "claude-code",
    machineId: r.machineId,
  });
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting" });
  await settle(r.t);
  expect(fake.count("start")).toBe(2); // the first boot after create, and this wake
  expect(fake.state(name)).toBe("running");
  expect(fake.disk(name).get("work.txt")).toBe("kept on the disk");

  // Until the bridge is back, the terminal waits as starting.
  expect(await r.ana.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "starting" });

  // The same bridge comes back with its token and cursor: no new pairing, and the queued start reaches it.
  const token = await bridgeBoots(r.t);
  expect(token).toBe(r.token);
  expect(await r.ana.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "starting" });
  expect(await bridgeHandlesInbox(r.t, token)).toMatchObject([{ type: "start_terminal", terminalId }]);
  expect(await status(r, r.machineId)).toMatchObject({ state: "running" });
  expect(await r.ana.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "unknown" });
  expect(await r.ana.as.query(api.machines.list, { teamId: r.teamId })).toHaveLength(1);
});

test("two starts at once share one wake", async () => {
  const r = await runningBox();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  const startsBefore = fake.count("start");

  const taskId = await newTask(r);
  await Promise.all([
    r.julio.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId }),
    r.ana.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId }),
    r.ana.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId }),
  ]);
  await settle(r.t);
  expect(fake.count("start")).toBe(startsBefore + 1);
});

test("a start that races the idle stop waits for the stop, then wakes the machine again", async () => {
  const r = await runningBox();
  const name = boxName();
  await advance(r.t, 14 * MINUTE);
  const hold = fake.holdNext("stop");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await vi.advanceTimersByTimeAsync(2 * MINUTE);
  for (let i = 0; i < 100 && !reached; i++) await vi.advanceTimersByTimeAsync(10);
  expect(reached).toBe(true);
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopping" });

  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  // The old bridge, still up while the box stops, never sees the start.
  expect(await bridgeInbox(r.t, r.token, Number(fake.disk(name).get("afterSeq") ?? 0))).toEqual([]);

  hold.release();
  await settle(r.t);
  expect(fake.count("stop")).toBe(1);
  expect(fake.state(name)).toBe("running");
  await bridgeBoots(r.t);
  expect(await bridgeHandlesInbox(r.t, r.token)).toMatchObject([{ type: "start_terminal", terminalId }]);
});

test("when the machine can't start, the waiting terminal and its run fail with the reason, and a later start retries", async () => {
  const r = await runningBox();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);

  fake.failNext("start", "Vercel answered 429: too many sandboxes");
  const taskId = await newTask(r);
  const { runId, terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await settle(r.t);

  expect(await status(r, r.machineId)).toMatchObject({ state: "failed", lastError: expect.stringMatching(/429/) });
  const terminal = await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! });
  expect(terminal).toMatchObject({ status: "failed", failReason: expect.stringMatching(/couldn't start/i) });
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "failed" });
  // The failed start never reaches the bridge later.
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  await bridgeBoots(r.t);
  expect(await bridgeHandlesInbox(r.t, r.token)).toEqual([]);
  expect(await status(r, r.machineId)).toMatchObject({ state: "running" });
});

test("a bridge that never comes back fails the waiting terminal and stops the box", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);

  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await settle(r.t);
  expect(fake.state(name)).toBe("running");
  await advance(r.t, 11 * MINUTE);

  expect(await status(r, r.machineId)).toMatchObject({ state: "failed", lastError: expect.stringMatching(/bridge/i) });
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "failed" });
  expect(fake.state(name)).toBe("stopped");
});

test("an admin's stop ends the live work: a stopped machine is not a suspended run", async () => {
  const r = await runningBox();
  const taskId = await newTask(r);
  const { runId, terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });

  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(fake.state(boxName())).toBe("stopped");
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "ended" });
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "stopped" });

  // Starting the same disk later doesn't bring the run back.
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  await bridgeBoots(r.t);
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "stopped" });
});

test("when the provider stops the box by itself, the room notices and ends what ran there", async () => {
  const r = await runningBox();
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });

  fake.stopByItself(boxName());
  await advance(r.t, 6 * MINUTE); // the bridge goes quiet, then the room asks the provider
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped", stopReason: "provider" });
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "failed" });
});

test("long work extends the provider session before it runs out", async () => {
  const r = await runningBox();
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });
  const firstSession = fake.boots.at(-1)!.session.timeoutMs;
  await advanceWithBridge(r.t, r.token, 90 * MINUTE);
  expect(fake.extended.length).toBeGreaterThan(0);
  expect(fake.state(boxName())).toBe("running");
  expect(90 * MINUTE).toBeGreaterThan(firstSession);
});

test("deleting a cloud machine unlinks it, revokes its bridge and deletes the box", async () => {
  const r = await runningBox();
  const name = boxName();
  await expect(r.julio.as.mutation(api.machines.unlink, { teamId: r.teamId, machineId: r.machineId })).rejects.toThrow(
    /cloudMachines\.remove|delete/i,
  );

  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);

  expect(fake.state(name)).toBe("missing");
  expect(await status(r, r.machineId)).toMatchObject({ state: "deleted" });
  expect(await r.julio.as.query(api.machines.list, { teamId: r.teamId })).toEqual([]);
  expect(await bridgeInbox(r.t, r.token)).toMatchObject([{ type: "unlink" }]);
  await expect(r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId })).rejects.toThrow(
    /deleted/i,
  );
});

test("a profile that expires while the machine is stopped wakes it, so its bridge deletes the profile", async () => {
  const r = await runningBox();
  const profileId = await r.ana.as.mutation(api.profiles.create, {
    teamId: r.teamId,
    machineId: r.machineId,
    name: "Ana's Claude",
    keepForMs: DAY,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  const startsBefore = fake.count("start");

  await advance(r.t, DAY);
  expect(fake.count("start")).toBe(startsBefore + 1);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting", wakeReason: "maintenance" });
  expect(await r.ana.as.query(api.profiles.mine, { teamId: r.teamId })).toEqual([]);
  expect(profileId).toBeTruthy();
});

test("the Vercel adapter asks for a named, persistent iad1 sandbox that keeps one snapshot, and runs the boot step detached", async () => {
  const calls: { fn: string; args: any }[] = [];
  const sandbox = {
    status: "stopped",
    tags: { app: "uplink-room", room: "focused-fish-459" },
    async writeFiles(files: unknown) {
      calls.push({ fn: "writeFiles", args: files });
    },
    async runCommand(args: unknown) {
      calls.push({ fn: "runCommand", args });
    },
    async stop() {
      calls.push({ fn: "stop", args: null });
    },
    async extendTimeout(ms: number) {
      calls.push({ fn: "extendTimeout", args: ms });
    },
    async update(args: unknown) {
      calls.push({ fn: "update", args });
    },
    async delete(args: unknown) {
      calls.push({ fn: "delete", args });
    },
  };
  const notFound = Object.assign(new Error("not found"), { response: { status: 404 } });
  const sdk = {
    Sandbox: {
      async getOrCreate(args: unknown) {
        calls.push({ fn: "getOrCreate", args });
        return sandbox;
      },
      async get(args: { name: string }) {
        calls.push({ fn: "get", args });
        if (args.name === "gone") throw notFound;
        return sandbox;
      },
    },
  };
  const provider = vercelSandboxProvider(
    { token: "vercel-token", teamId: "team_1", projectId: "prj_1" },
    async () => sdk as any,
  );

  await provider.create({ name: "uplink-m1", region: "iad1", vcpus: 2, tags: { app: "uplink-room" } }, { timeoutMs: 3_600_000 });
  expect(calls[0]).toMatchObject({
    fn: "getOrCreate",
    args: {
      name: "uplink-m1",
      region: "iad1",
      resources: { vcpus: 2 },
      timeout: 3_600_000,
      persistent: true,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true },
      token: "vercel-token",
      teamId: "team_1",
      projectId: "prj_1",
    },
  });

  calls.length = 0;
  await provider.start("uplink-m1", { timeoutMs: 3_600_000 }, { script: "echo hi", env: { UPLINK_PAIRING_CODE: "ABC" } }, 7);
  expect(calls.map((c) => c.fn)).toEqual(["get", "update", "writeFiles", "runCommand"]);
  expect(calls[1]!.args).toMatchObject({ tags: { app: "uplink-room", room: "focused-fish-459", gen: "7" } });
  expect(calls[3]!.args).toMatchObject({ cmd: "bash", detached: true, env: { UPLINK_PAIRING_CODE: "ABC" } });

  expect(await provider.status("uplink-m1")).toBe("stopped");
  expect(await provider.status("gone")).toBe("missing");
  await provider.delete("uplink-m1");
  expect(calls.at(-1)).toMatchObject({ fn: "delete", args: { deleteOrphanSnapshots: true } });
});

// ---------------------------------------------------------------------------
// Review findings on PR #46: each test fails without its fix.

/**
 * Lets fake time pass in steps, without waiting for scheduled functions to finish, so a provider call
 * can stay held. For waits that need minutes to pass, such as a watchdog. Each step also yields a real
 * event-loop turn, so real-time work in flight keeps pace with the fake clock.
 */
async function stepUntil(check: () => Promise<boolean> | boolean, stepMs = 1000, maxSteps = 2000) {
  for (let i = 0; i < maxSteps; i++) {
    if (await check()) return;
    await realSleep(0);
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error("The condition never held.");
}

/**
 * Waits for work that is due now (scheduled to run at once) without letting the fake clock run
 * ahead: each try moves fake time by 1 ms and yields 1 ms of real time, so real-time work (WebCrypto)
 * finishes and no later timer (a watchdog, the reconciler's follow-up) fires meanwhile. Bounded in
 * real time, about 5 s.
 */
async function waitFor(check: () => Promise<boolean> | boolean, tries = 5000) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await realSleep(1);
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("The condition never held.");
}

test("finding 1: work started during an idle stop stays queued for the next boot instead of being ended", async () => {
  const r = await runningBox();
  await advanceWithBridge(r.t, r.token, 14 * MINUTE);
  const hold = fake.holdNext("stop");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await stepUntil(() => reached);

  const taskId = await newTask(r);
  const { runId, terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  const thread = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "claude-code",
    machineId: r.machineId,
    via: "thread",
  });
  hold.release();
  await settle(r.t);

  // The stop finished and the machine is starting again; the new work is still waiting, not ended.
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({
    status: "starting",
  });
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "unknown" });
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId: thread.runId })).toMatchObject({
    state: "unknown",
  });
  await bridgeBoots(r.t);
  const delivered = await bridgeHandlesInbox(r.t, r.token);
  expect(delivered.map((m) => m.type)).toEqual(["start_terminal", "start_thread"]);
});

test("finding 1: after a stop with nobody waiting on a wake, queued work still starts the machine again", async () => {
  const r = await runningBox();
  await advanceWithBridge(r.t, r.token, 14 * MINUTE);
  const hold = fake.holdNext("stop");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await stepUntil(() => reached);
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  // Even if the request to wake after the stop is lost, the queued start wakes the machine.
  await r.t.run(async (ctx) => {
    const cloud = await ctx.db
      .query("cloudMachines")
      .withIndex("by_machine", (q) => q.eq("machineId", r.machineId))
      .unique();
    await ctx.db.patch(cloud!._id, { wakeAfterStop: undefined });
  });
  hold.release();
  await settle(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting" });
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({
    status: "starting",
  });
});

test("finding 2: a delete that lands while the box is being created deletes the box the create made", async () => {
  const r = await room();
  const hold = fake.holdNext("create");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  const machineId = await r.julio.as.mutation(api.cloudMachines.create, { teamId: r.teamId, name: "team-box" });
  await waitFor(() => reached);
  const { resourceName } = await status(r, machineId);

  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId });
  await stepUntil(async () => (await status(r, machineId)).state === "deleted");
  expect(fake.state(resourceName)).toBe("missing");

  // Now the create goes through at the provider. Its action finds it was superseded and deletes the box.
  hold.release();
  await settle(r.t);
  expect(fake.count("create")).toBe(1);
  expect(fake.state(resourceName)).toBe("missing");
  expect(await status(r, machineId)).toMatchObject({ state: "deleted" });
});

test("finding 3: a delete keeps retrying through a provider outage, shows as stuck, and remove retries at once", async () => {
  const r = await runningBox();
  const name = boxName();
  fake.failTimes("delete", 9, "Vercel answered 503: unavailable");
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await advance(r.t, 30 * MINUTE);
  expect(fake.count("delete")).toBeGreaterThanOrEqual(6);
  expect(await status(r, r.machineId)).toMatchObject({ state: "deleting", lastError: expect.stringMatching(/503/) });
  const settings = await r.julio.as.query(api.cloudMachines.settings, { teamId: r.teamId });
  expect(settings.deleting).toMatchObject([{ machineId: r.machineId, name: "team-box", lastError: expect.stringMatching(/503/) }]);

  const before = fake.count("delete");
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(fake.count("delete")).toBe(before + 1);

  await advance(r.t, 6 * 60 * MINUTE);
  expect(fake.state(name)).toBe("missing");
  expect(await status(r, r.machineId)).toMatchObject({ state: "deleted" });
  expect((await r.julio.as.query(api.cloudMachines.settings, { teamId: r.teamId })).deleting).toEqual([]);
});

test("finding 4: the session deadline moves only when the provider accepts the extension, and a failed one is retried", async () => {
  const r = await runningBox();
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });
  const firstDeadline = (await status(r, r.machineId)).sessionEndsAt!;
  fake.failNext("extend", "Vercel answered 500");

  for (let i = 0; i < 60 && fake.count("extend") === 0; i++) await advanceWithBridge(r.t, r.token, MINUTE);
  expect(fake.count("extend")).toBe(1);
  expect(fake.extended).toHaveLength(0);
  expect((await status(r, r.machineId)).sessionEndsAt).toBe(firstDeadline);

  await advanceWithBridge(r.t, r.token, 3 * MINUTE);
  expect(fake.extended).toHaveLength(1);
  expect((await status(r, r.machineId)).sessionEndsAt).toBe(firstDeadline + 60 * MINUTE);
});

test("finding 5: a start whose provider call never returns is failed by a watchdog set before the call, and the box is stopped", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);

  // The action dies (or hangs) inside the provider call: it never reports back.
  const hold = fake.holdNext("start");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await waitFor(() => reached);
  await stepUntil(async () => (await status(r, r.machineId)).state === "failed", 10_000);
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({
    status: "failed",
  });

  // The call finally returns and boots the box; the superseded action stops it again.
  hold.release();
  await settle(r.t);
  expect(fake.state(name)).toBe("stopped");
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });

  // Start works again.
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  await bridgeBoots(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "running" });
});

test("finding 6: a profile expiring on a failed (stopped) machine wakes it, and a maintenance wake that fails is retried", async () => {
  const r = await runningBox();
  await r.ana.as.mutation(api.profiles.create, {
    teamId: r.teamId,
    machineId: r.machineId,
    name: "Ana's Claude",
    keepForMs: DAY,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  // A later start fails: the machine shows failed, with its box stopped.
  fake.failNext("start", "Vercel answered 429");
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });
  expect(fake.state(boxName())).toBe("stopped");
  const starts = fake.count("start");

  fake.failNext("start", "Vercel answered 429");
  await advance(r.t, DAY);
  expect(fake.count("start")).toBe(starts + 1);
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });

  for (let i = 0; i < 60 && fake.count("start") === starts + 1; i++) await advance(r.t, MINUTE);
  expect(fake.count("start")).toBe(starts + 2);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting", wakeReason: "maintenance" });
});

test("finding 2: a box that reappears after a confirmed delete is deleted by the later check", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(fake.state(name)).toBe("missing");
  // An overtaken create made the box again and then died before undoing it.
  await fake.provider.create({ name, region: "iad1", vcpus: 2, tags: {} }, { timeoutMs: 1 });
  expect(fake.state(name)).toBe("running");
  await advance(r.t, 21 * MINUTE);
  expect(fake.state(name)).toBe("missing");
  expect(await status(r, r.machineId)).toMatchObject({ state: "deleted" });
});

test("finding 7: a first create that failed before any sandbox existed recovers on the next Start", async () => {
  const r = await room();
  fake.failNext("create", "Vercel answered 429: rate limited");
  const machineId = await r.julio.as.mutation(api.cloudMachines.create, { teamId: r.teamId, name: "team-box" });
  await settle(r.t);
  const { resourceName } = await status(r, machineId);
  expect(await status(r, machineId)).toMatchObject({ state: "failed", lastError: expect.stringMatching(/429/) });
  expect(fake.state(resourceName)).toBe("missing");

  // Start makes sure the sandbox exists, then boots it; the bridge pairs as the same machine.
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId });
  await settle(r.t);
  expect(fake.state(resourceName)).toBe("running");
  await bridgeBoots(r.t, resourceName);
  expect(await status(r, machineId)).toMatchObject({ state: "running" });
  expect(await r.julio.as.query(api.machines.list, { teamId: r.teamId })).toMatchObject([{ machineId, online: true }]);
});

test("bot 4449562546: an admin's stop during an idle stop cancels the work queued for the next boot", async () => {
  const r = await runningBox();
  const name = boxName();
  await advanceWithBridge(r.t, r.token, 14 * MINUTE);
  const hold = fake.holdNext("stop");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await stepUntil(() => reached);
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, {
    teamId: r.teamId,
    taskId,
    harness: "shell",
    machineId: r.machineId,
  });
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  const starts = fake.count("start");
  hold.release();
  await settle(r.t);

  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped" });
  expect(fake.count("start")).toBe(starts);
  expect(fake.state(name)).toBe("stopped");
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({
    status: "failed",
  });
});

test("bot 4449562560: a profile that expires during an ordinary start still gets its cleanup if that start fails", async () => {
  const r = await runningBox();
  await r.ana.as.mutation(api.profiles.create, {
    teamId: r.teamId,
    machineId: r.machineId,
    name: "Ana's Claude",
    keepForMs: 5 * MINUTE,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await advance(r.t, 3 * MINUTE);
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  const starts = fake.count("start");

  // An ordinary start is in flight (and will fail) when the profile expires.
  const hold = fake.holdNext("start");
  fake.failNext("start", "Vercel answered 429");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => reached);
  await stepUntil(async () => (await r.ana.as.query(api.profiles.mine, { teamId: r.teamId })).length === 0, 10_000);
  hold.release();
  await settle(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });

  for (let i = 0; i < 30 && fake.count("start") === starts + 1; i++) await advance(r.t, MINUTE);
  expect(fake.count("start")).toBe(starts + 2);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting", wakeReason: "maintenance" });
});

// ---------------------------------------------------------------------------
// Round 3 (Codex on a093ae3): the reconciler is the safety net.

const ROOM = "focused-fish-459";

/** One reconcile pass, as the cron runs it every 5 minutes, then whatever it scheduled. */
async function reconcile(t: Room) {
  await t.action(internal.cloudMachineActions.reconcileAll, {});
  await settle(t);
}

async function pendingJobs(t: Room, fn: string) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (j) => j.name.includes(fn) && j.state.kind === "pending",
    ).length,
  );
}

test("round 3, finding 1: a start the bridge passed but never acknowledged doesn't keep the machine awake forever", async () => {
  const r = await runningBox();
  const name = boxName();
  const taskId = await newTask(r);
  await r.julio.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId });
  // The bridge handles the start and saves its cursor, then dies before acknowledging it.
  const disk = fake.disk(name);
  const { messages } = await r.t.query(api.bridge.inbox, { token: r.token, afterSeq: Number(disk.get("afterSeq") ?? 0) });
  disk.set("afterSeq", String(messages.at(-1)!.seq));

  // Quiet bridge: the idle stop stops it, and the leftover row wakes it once.
  await advance(r.t, 32 * MINUTE);
  expect(fake.count("stop")).toBe(1);
  await bridgeBoots(r.t);
  // The new bridge registered with its cursor, which covers that row: it is no longer live work.
  await advanceWithBridge(r.t, r.token, 17 * MINUTE);
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped", stopReason: "idle" });
  expect(fake.state(name)).toBe("stopped");
});

test("round 3, finding 2: a stale compensating stop that stops a newer boot is repaired by the reconciler", async () => {
  // WebCrypto as slow as on a loaded CI runner: every pairing code's hash takes 50 ms of real time.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args: Parameters<SubtleCrypto["digest"]>) => {
    await realSleep(50);
    return digest(...args);
  });
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  // Start A hangs in the provider call until the watchdog gives up on it.
  const startA = fake.holdNext("start");
  let aReached = false;
  void startA.reached.then(() => (aReached = true));
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => aReached);
  await stepUntil(async () => (await status(r, r.machineId)).state === "failed", 10_000);
  // The watchdog's stop asked for a reconcile run 20 s later. Let it run now, while A's boot is still
  // held and the box is down, so it has nothing to do and can't take the stop held below.
  const stopsBefore = fake.count("stop");
  await stepUntil(async () => (await r.t.run((ctx) => ctx.db.query("cloudReconciler").first()))?.pendingId === undefined);
  expect(fake.count("stop")).toBe(stopsBefore);

  // A returns and compensates with a stop, which is slow to land.
  const lateStop = fake.holdNext("stop");
  let stopReached = false;
  void lateStop.reached.then(() => (stopReached = true));
  startA.release();
  await waitFor(() => stopReached);
  // Meanwhile a newer start boots the box.
  const bootsBefore = fake.boots.length;
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => fake.boots.length > bootsBefore && fake.state(name) === "running");
  // The stale stop lands on the newer boot.
  lateStop.release();
  await waitFor(() => fake.state(name) === "stopped");

  await reconcile(r.t);
  expect(fake.state(name)).toBe("running");
  await bridgeBoots(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "running" });
});

test("round 3, finding 3: a delete whose action dies mid-call is restarted by its guard", async () => {
  const r = await runningBox();
  const name = boxName();
  const hold = fake.holdNext("delete");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => reached);
  // That action never reports back.
  await stepUntil(async () => (await status(r, r.machineId)).state === "deleted", 10_000, 200);
  expect(fake.state(name)).toBe("missing");
  hold.release();
  await settle(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "deleted" });
});

test("round 3, finding 4: a compensating stop that failed is caught by the reconcile run right after", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  const hold = fake.holdNext("start");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => reached);
  await stepUntil(async () => (await status(r, r.machineId)).state === "failed", 10_000);
  fake.failNext("stop", "Vercel answered 503");
  hold.release();
  await settle(r.t);
  // The boot went through and its compensating stop failed: the box runs while the room shows failed.
  expect(fake.state(name)).toBe("running");
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });
  // No cron needed: provider actions ask for a reconcile soon after.
  await advance(r.t, MINUTE);
  expect(fake.state(name)).toBe("stopped");
});

test("round 3, finding 5: Retry now while a delete is in flight keeps one chain of attempts", async () => {
  const r = await runningBox();
  const hold = fake.holdNext("delete");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => reached);
  fake.failNext("delete", "Vercel answered 503");
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await vi.advanceTimersByTimeAsync(100);
  // The in-flight attempt now fails too; its retry must not start a second chain.
  fake.failNext("delete", "Vercel answered 503");
  hold.release();
  await settle(r.t);
  expect(await pendingJobs(r.t, "deleteAtProvider")).toBe(1);
});

test("reconciler: it deletes boxes tagged for this room that no machine owns, and never touches anyone else's", async () => {
  const r = await runningBox();
  fake.addBox("uplink-stray", { app: "uplink-room", room: ROOM });
  fake.addBox("prod-box", { app: "uplink-room", room: "prod-otter-1" });
  fake.addBox("someone-else", {});
  await reconcile(r.t);
  expect(fake.state("uplink-stray")).toBe("missing");
  expect(fake.state("prod-box")).toBe("running");
  expect(fake.state("someone-else")).toBe("running");
  expect(fake.state(boxName())).toBe("running");
});

test("reconciler: a deleted machine's box that came back is deleted, and its stray snapshots too", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  fake.addBox(name, { app: "uplink-room", room: ROOM });
  fake.addSnapshot(name);
  await reconcile(r.t);
  expect(fake.state(name)).toBe("missing");
  expect(fake.snapshotsOf(name)).toEqual([]);
});

test("reconciler: a stop whose action died is restarted", async () => {
  const r = await runningBox();
  const name = boxName();
  const hold = fake.holdNext("stop");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => reached);
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  await t_reconcileWithoutSettle(r.t);
  await stepUntil(async () => (await status(r, r.machineId)).state === "stopped");
  expect(fake.state(name)).toBe("stopped");
  hold.release();
  await settle(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped" });
});

test("reconciler: it never touches a box booting for the current generation inside its watchdog window", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  const hold = fake.holdNext("start");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await r.julio.as.mutation(api.cloudMachines.start, { teamId: r.teamId, machineId: r.machineId });
  await waitFor(() => reached);
  const before = { stop: fake.count("stop"), del: fake.count("delete"), start: fake.count("start") };
  await t_reconcileWithoutSettle(r.t);
  expect({ stop: fake.count("stop"), del: fake.count("delete"), start: fake.count("start") }).toEqual(before);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting" });
  hold.release();
  await settle(r.t);
  expect(fake.state(name)).toBe("running");
});

/** A reconcile pass while a provider call is held: settling would wait on that call. */
async function t_reconcileWithoutSettle(t: Room) {
  await t.action(internal.cloudMachineActions.reconcileAll, {});
  await vi.advanceTimersByTimeAsync(100);
}

test("reconciler: work queued on a stopped machine whose wake was lost starts the machine", async () => {
  const r = await runningBox();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  const taskId = await newTask(r);
  const hold = fake.holdNext("start");
  await r.julio.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId });
  // The wake is lost: the row goes back to stopped with the start still queued.
  await r.t.run(async (ctx) => {
    const cloud = await ctx.db
      .query("cloudMachines")
      .withIndex("by_machine", (q) => q.eq("machineId", r.machineId))
      .unique();
    await ctx.db.patch(cloud!._id, { state: "stopped", generation: cloud!.generation + 1 });
  });
  hold.release();
  await settle(r.t);
  await reconcile(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting", wakeReason: "work" });
});

test("reconciler: snapshots a delete left behind are found by the ids recorded before the delete, and deleted", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(fake.snapshotsOf(name)).toHaveLength(1);
  fake.leaveSnapshotsOnDelete();
  await r.julio.as.mutation(api.cloudMachines.remove, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  expect(fake.state(name)).toBe("missing");
  expect(fake.snapshotsOf(name)).toHaveLength(1);
  await reconcile(r.t);
  expect(fake.snapshotsOf(name)).toEqual([]);
});

test("bot 4449728425: a reconcile pass ignores machines that changed after its provider listing began", async () => {
  const r = await runningBox();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  // The listing sees the box stopped, then stalls.
  const hold = fake.holdNext("list");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  const pass = r.t.action(internal.cloudMachineActions.reconcileAll, {});
  await waitFor(() => reached);
  // Meanwhile the machine wakes and its bridge comes back with a live terminal.
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId });
  await settle(r.t);
  await bridgeBoots(r.t);
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });
  hold.release();
  await pass;
  await settle(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "running" });
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "live" });
});

test("bot 4449728429: the boot step puts the bridge's folder on terminals' PATH, so hooks find uplink-bridge", () => {
  expect(bootScript()).toContain('export UPLINK_BRIDGE_BIN_DIR="$PREFIX/bin"');
});

test("bot 4449728435: once a failed stop's box is confirmed down, the work the room still shows there ends", async () => {
  const r = await runningBox();
  const taskId = await newTask(r);
  const { terminalId } = await r.julio.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId });
  await bridgeHandlesInbox(r.t, r.token);
  await bridgeSays(r.t, r.token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });
  // The bridge goes quiet, the idle stop starts, and every stop attempt fails.
  fake.failTimes("stop", 6, "Vercel answered 503");
  await advance(r.t, 40 * MINUTE);
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "live" });

  await reconcile(r.t); // stops the box
  await reconcile(r.t); // sees it down, and ends what the room still shows live there
  expect(fake.state(boxName())).toBe("stopped");
  expect(await r.julio.as.query(api.terminals.get, { teamId: r.teamId, terminalId: terminalId! })).toMatchObject({ status: "failed" });
});

test("bot 4449606593: a profile that expires after the provider stopped the box, before the room noticed, still gets cleaned", async () => {
  const r = await runningBox();
  const name = boxName();
  await r.ana.as.mutation(api.profiles.create, {
    teamId: r.teamId,
    machineId: r.machineId,
    name: "Ana's Claude",
    keepForMs: 4 * MINUTE,
  });
  await bridgeHandlesInbox(r.t, r.token);
  await advanceWithBridge(r.t, r.token, MINUTE);
  // The provider stops the box; the room asks it about the quiet bridge, and the answer is slow.
  fake.stopByItself(name);
  const hold = fake.holdNext("status");
  let reached = false;
  void hold.reached.then(() => (reached = true));
  await stepUntil(() => reached);
  // The profile expires while the room still shows the machine running.
  await stepUntil(async () => (await r.ana.as.query(api.profiles.mine, { teamId: r.teamId })).length === 0);
  expect(await status(r, r.machineId)).toMatchObject({ state: "running" });
  const starts = fake.count("start");

  hold.release();
  await settle(r.t);
  expect(fake.count("start")).toBe(starts + 1);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting", wakeReason: "maintenance" });
});

test("bot 4449606593: the reconciler honors pending maintenance on a stopped machine", async () => {
  const r = await runningBox();
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await settle(r.t);
  await r.t.run(async (ctx) => {
    const cloud = await ctx.db
      .query("cloudMachines")
      .withIndex("by_machine", (q) => q.eq("machineId", r.machineId))
      .unique();
    await ctx.db.patch(cloud!._id, { maintenancePending: true });
  });
  await reconcile(r.t);
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting", wakeReason: "maintenance" });
});

test("#51: a profile that expires during a stop that fails six times still gets its cleanup retried", async () => {
  const r = await runningBox();
  await r.ana.as.mutation(api.profiles.create, {
    teamId: r.teamId,
    machineId: r.machineId,
    name: "Ana's Claude",
    keepForMs: 2 * MINUTE,
  });
  await bridgeHandlesInbox(r.t, r.token);
  // The provider can't stop the box: not for this stop, and not for the reconciler either.
  fake.failTimes("stop", 1000, "Vercel answered 503");
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  // The profile expires while the machine stops, and the stop then runs out of tries.
  await advance(r.t, 10 * MINUTE);
  expect(await r.ana.as.query(api.profiles.mine, { teamId: r.teamId })).toEqual([]);
  expect(await status(r, r.machineId)).toMatchObject({ state: "failed" });
  const starts = fake.count("start");

  await advance(r.t, 60 * MINUTE);
  expect(fake.count("start")).toBeGreaterThan(starts);
  expect(await status(r, r.machineId)).toMatchObject({ wakeReason: "maintenance" });
});

test("#51: a stop that fails six times shows admins the box may still run, and settles stopped once the reconciler stops it", async () => {
  const r = await runningBox();
  fake.failTimes("stop", 6, "Vercel answered 503");
  await r.julio.as.mutation(api.cloudMachines.stop, { teamId: r.teamId, machineId: r.machineId });
  await advance(r.t, 6 * MINUTE);
  expect(await status(r, r.machineId)).toMatchObject({
    state: "failed",
    stopFailed: true,
    lastError: expect.stringMatching(/couldn't stop.*keeps trying.*503/i),
  });
  const settings = await r.julio.as.query(api.cloudMachines.settings, { teamId: r.teamId });
  expect(settings.notStopped).toMatchObject([{ machineId: r.machineId, name: "team-box", lastError: expect.stringMatching(/503/) }]);

  // The reconciler keeps stopping the box; once it sees the box down, the machine is simply stopped.
  await reconcile(r.t);
  await reconcile(r.t);
  expect(fake.state(boxName())).toBe("stopped");
  const after = await status(r, r.machineId);
  expect(after).toMatchObject({ state: "stopped", stopFailed: false });
  expect(after.lastError).toBeUndefined();
  expect((await r.julio.as.query(api.cloudMachines.settings, { teamId: r.teamId })).notStopped).toEqual([]);
});

test("an A2A run (no machine) in the team never wakes, keeps alive or is ended by a cloud machine", async () => {
  const r = await runningBox();
  const name = boxName();
  // A2A runs (#47) have no machine. Working and Waiting ones, one even with a thread ref.
  const a2aRuns = await r.t.run(async (ctx) => {
    const member = (await ctx.db.query("members").collect()).find((m) => m.teamId === r.teamId)!;
    const base = { teamId: r.teamId, harness: "a2a", startedBy: member._id, stateChangedAt: Date.now() };
    return [
      await ctx.db.insert("runs", { ...base, state: "working" as const }),
      await ctx.db.insert("runs", { ...base, state: "waiting" as const, threadRef: "a2a-thread" }),
    ];
  });

  // It doesn't keep the machine alive: the idle stop happens on time.
  await advanceWithBridge(r.t, r.token, 16 * MINUTE);
  expect(fake.state(name)).toBe("stopped");
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped", stopReason: "idle" });

  // The stop doesn't end it, and nothing about it wakes the stopped machine.
  const starts = fake.count("start");
  await reconcile(r.t);
  await advance(r.t, 10 * MINUTE);
  expect(fake.count("start")).toBe(starts);
  expect(await status(r, r.machineId)).toMatchObject({ state: "stopped" });
  for (const runId of a2aRuns) {
    const run = await r.t.run((ctx) => ctx.db.get(runId));
    expect(run!.state === "working" || run!.state === "waiting").toBe(true);
    expect(run!.machineId).toBeUndefined();
  }

  // A real start on the machine still wakes it, with the A2A runs still there.
  const taskId = await newTask(r);
  await r.julio.as.mutation(api.runs.start, { teamId: r.teamId, taskId, harness: "shell", machineId: r.machineId });
  expect(await status(r, r.machineId)).toMatchObject({ state: "starting" });
});

test("a bridge tarball setting without its sha256 leaves cloud machines unconfigured, and the boot step checks the hash", async () => {
  setCloudProviderForTests(undefined);
  vi.stubEnv("VERCEL_TOKEN", "token");
  vi.stubEnv("VERCEL_TEAM_ID", "team");
  vi.stubEnv("VERCEL_PROJECT_ID", "project");
  vi.stubEnv("UPLINK_BRIDGE_TARBALL_URL", "https://downloads.example.com/uplink-room-bridge-0.1.0.tgz");
  const { julio, teamId } = await room();
  const settings = await julio.as.query(api.cloudMachines.settings, { teamId });
  expect(settings).toMatchObject({ configured: false, missing: ["UPLINK_BRIDGE_TARBALL_URL"] });
  await expect(julio.as.mutation(api.cloudMachines.create, { teamId, name: "box" })).rejects.toThrow(/not_configured/);
  expect(tarballSetting("https://x.example.com/b.tgz#sha256=" + "AB".repeat(32))).toBeNull();
  expect(tarballSetting("http://x.example.com/b.tgz#sha256=" + TARBALL_SHA256)).toBeNull();
  expect(tarballSetting("https://x.example.com/b.tgz#sha256=" + TARBALL_SHA256)).toEqual({
    url: "https://x.example.com/b.tgz",
    sha256: TARBALL_SHA256,
  });
  expect(bootScript()).toContain('sha256sum "$TARBALL"');
  expect(bootScript()).toContain('npm install --global --allow-scripts=node-pty --prefix "$PREFIX" "$TARBALL"');
});
