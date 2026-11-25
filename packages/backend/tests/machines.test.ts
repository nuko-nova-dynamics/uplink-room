import { expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeInbox, bridgeSays, LIMITS, linkMachine, newLimitedRoom, newRoom, newTeam } from "./setup";

test("a person links a computer by pairing its bridge, and the team sees it online", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");

  await linkMachine(t, teamId, admin, "julio-mbp");

  const machines = await ana.as.query(api.machines.list, { teamId });
  expect(machines).toMatchObject([
    {
      name: "julio-mbp",
      belongsTo: { kind: "person", member: { name: "Julio" } },
      online: true,
      mostOpenAccess: "suggest",
      tools: ["tmux", "claude-code"],
    },
  ]);
});

test("team members read the bridge release other machines install, with the sha256 the room recorded", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const sha256 = "cd".repeat(32);
  const url = "https://abc.public.blob.vercel-storage.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz";
  try {
    vi.stubEnv("UPLINK_BRIDGE_TARBALL_URL", `${url}#sha256=${sha256}`);
    expect(await ana.as.query(api.machines.bridgeRelease, { teamId })).toEqual({ url, sha256, version: "0.2.5" });
    // Someone signed in but not on the team gets nothing.
    const stranger = t.withIdentity({ subject: "user_Eve", name: "Eve", email: "eve@example.com", emailVerified: true });
    await expect(stranger.query(api.machines.bridgeRelease, { teamId })).rejects.toThrow();
    // A setting with no hash isn't a release anyone can check.
    vi.stubEnv("UPLINK_BRIDGE_TARBALL_URL", url);
    expect(await ana.as.query(api.machines.bridgeRelease, { teamId })).toBeNull();
    // The URL goes into commands people paste into a shell: anything but the release script's shape
    // is no release. PowerShell ends a quoted string at ’ too, so this one would have run code.
    for (const bad of [
      "https://abc.public.blob.vercel-storage.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz’;Write-Output(12345);’",
      "https://abc.public.blob.vercel-storage.com/bridge/$(id)/uplink-room-bridge-0.2.5-57b537f.tgz",
      "http://abc.public.blob.vercel-storage.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz",
      "https://example.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz",
      "https://abc.public.blob.vercel-storage.com.example.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz",
      "https://abc.public.blob.vercel-storage.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz?x=1",
    ]) {
      vi.stubEnv("UPLINK_BRIDGE_TARBALL_URL", `${bad}#sha256=${sha256}`);
      expect(await ana.as.query(api.machines.bridgeRelease, { teamId }), bad).toBeNull();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a pairing code works once", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { code } = await admin.as.mutation(api.machines.createPairingCode, { teamId, name: "box" });
  await t.mutation(api.bridge.pair, { code, hostname: "box", os: "linux" });
  await expect(t.mutation(api.bridge.pair, { code, hostname: "box", os: "linux" })).rejects.toThrow(/pairing code/i);
});

test("a Pair's code given to bridge pairing says which code a machine needs", async () => {
  const t = newRoom();
  await expect(t.mutation(api.bridge.pair, { code: "ZZZZ-ZZZZ", hostname: "box", os: "linux" })).rejects.toThrow(/isn't valid/);
  for (const code of ["PAPRIKA-9204-FROST-5589", "river 4821 maple 0937"]) {
    await expect(t.mutation(api.bridge.pair, { code, hostname: "box", os: "linux" })).rejects.toThrow(
      /That's a Pair code.*Link a machine/,
    );
  }
});

test("unlinking a machine cuts the room's access to it at once", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");

  await admin.as.mutation(api.machines.unlink, { teamId, machineId });

  expect(await bridgeInbox(t, token)).toMatchObject([{ type: "unlink" }]);
  await expect(
    t.mutation(api.bridge.send, { token, messages: [{ v: 1, type: "terminal_output", terminalId: "x", seq: 1, data: "hi" }] }),
  ).rejects.toThrow(/unlinked/i);
  expect(await admin.as.query(api.machines.list, { teamId })).toEqual([]);
});

test("removing a member unlinks their personal machines and refuses their bridge tokens, and a team machine they linked stays", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  // An admin when he linked the rack for the team.
  await julio.as.mutation(api.members.setRole, { teamId, memberId: pepe.memberId, role: "admin" });
  const laptop = await linkMachine(t, teamId, pepe, "pepe-laptop");
  const rack = await linkMachine(t, teamId, pepe, "rack", { team: true });

  await julio.as.mutation(api.members.remove, { teamId, memberId: pepe.memberId });

  expect((await julio.as.query(api.machines.list, { teamId })).map((m) => m.name)).toEqual(["rack"]);
  await expect(bridgeInbox(t, laptop.token)).rejects.toThrow(/bridge token/);
  await t.mutation(api.bridge.heartbeat, { token: rack.token });
  const log = await julio.as.query(api.activity.list, { teamId });
  expect(log.filter((e) => e.action === "machine.unlinked").map((e) => [e.target, e.details])).toEqual([[laptop.machineId, { reason: "member_removed" }]]);
});

test("only admins can change a team machine's settings", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, admin, "team-box", { team: true });

  await expect(
    ana.as.mutation(api.machines.updateSettings, { teamId, machineId, slots: 5 }),
  ).rejects.toThrow(/admin/i);
  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, slots: 1 });
  const [box] = await admin.as.query(api.machines.list, { teamId });
  expect(box).toMatchObject({ belongsTo: { kind: "team" }, slots: 1, mostOpenAccess: "drive" });
});

test("only the person a machine belongs to can change its settings", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, ana, "ana-laptop");

  await expect(
    admin.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" }),
  ).rejects.toThrow(/belongs to/i);
});

test("machine settings can't go past the limits set on the machine itself", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp", {
    limits: { mostOpenAccess: "drive", slots: 1, longestProfileMs: 1000 },
  });

  await expect(
    admin.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" }),
  ).rejects.toThrow(/machine itself/i);
});

test("a bridge that starts again ends the terminals the room thought were live, freeing their slots", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, slots: 1, mostOpenAccess: "drive" });
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Write the release notes" });
  const { runId, terminalId } = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "codex", tool: "codex", access: "watch" });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "working" });

  // Changing the machine's own limits is not a restart.
  await bridgeSays(t, token, { type: "limits_changed", limits: LIMITS });
  expect(await ana.as.query(api.terminals.list, { teamId })).toHaveLength(1);

  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });

  expect(await ana.as.query(api.terminals.list, { teamId })).toEqual([]);
  expect(await ana.as.query(api.runs.get, { teamId, runId })).toMatchObject({ state: "failed" });
  expect(await admin.as.query(api.machines.list, { teamId })).toMatchObject([{ slotsInUse: 0 }]);
  await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
});

test("a bridge registers on a machine with thousands of ended terminals, reading only its live ones", async () => {
  const t = newLimitedRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const memberId = (await admin.as.query(api.teams.mine, {}))[0]!.memberId as Id<"members">;
  const terminal = { teamId, machineId, startedBy: memberId, access: "drive" as const, usesSlot: true, title: "claude", tool: "claude", outputSeq: 0 };
  // 2,500 ended terminals with long commands: more than the 16 MiB one transaction can read.
  for (let chunk = 0; chunk < 5; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) await ctx.db.insert("terminals", { ...terminal, status: "ended", command: "x".repeat(8000), endedAt: 0 });
    });
  }
  const live = await t.run((ctx) => ctx.db.insert("terminals", { ...terminal, status: "live" }));

  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });

  expect(await t.run((ctx) => ctx.db.get(live))).toMatchObject({ status: "ended" });
}, 60_000);

test("removing a member whose laptop has thousands of ended terminals still removes them and unlinks it", async () => {
  const t = newLimitedRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, ana, "ana-mbp");
  const terminal = { teamId, machineId, startedBy: ana.memberId as Id<"members">, access: "drive" as const, usesSlot: true, title: "claude", tool: "claude", outputSeq: 0 };
  for (let chunk = 0; chunk < 5; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) await ctx.db.insert("terminals", { ...terminal, status: "ended", command: "x".repeat(8000), endedAt: 0 });
    });
  }
  const live = await t.run((ctx) => ctx.db.insert("terminals", { ...terminal, status: "live" }));

  await admin.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });

  expect(await t.run((ctx) => ctx.db.get(live))).toMatchObject({ status: "ended" });
  expect((await admin.as.query(api.teams.members, { teamId })).map((m) => m.name)).not.toContain("Ana");
}, 60_000);

test("lowering a machine's access with thousands of ended terminals reads only its live ones", async () => {
  const t = newLimitedRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp", { team: true });
  const memberId = (await admin.as.query(api.teams.mine, {}))[0]!.memberId as Id<"members">;
  const terminal = { teamId, machineId, startedBy: memberId, access: "open" as const, usesSlot: true, title: "claude", tool: "claude", outputSeq: 0 };
  for (let chunk = 0; chunk < 5; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) await ctx.db.insert("terminals", { ...terminal, status: "ended", command: "x".repeat(8000), endedAt: 0 });
    });
  }
  const live = await t.run((ctx) => ctx.db.insert("terminals", { ...terminal, status: "live" }));

  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "watch" });

  expect(await t.run((ctx) => ctx.db.get(live))).toMatchObject({ access: "watch", loweredFrom: "open" });
}, 60_000);

test("resuming sharing tells the bridge, and a bridge that registers again is sharing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Demo" });

  await admin.as.mutation(api.machines.stopSharing, { teamId, machineId });
  await admin.as.mutation(api.machines.resumeSharing, { teamId, machineId });

  const sent = await bridgeInbox(t, token);
  expect(sent.slice(-2)).toEqual([
    { v: 1, type: "stop_sharing" },
    { v: 1, type: "resume_sharing" },
  ]);

  await admin.as.mutation(api.machines.stopSharing, { teamId, machineId });
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });

  expect(await admin.as.query(api.machines.list, { teamId })).toMatchObject([{ sharingStopped: false }]);
  await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId });
});

test("a bridge that registers keeps terminals whose start is still queued, and ends one whose start it took", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Write the release notes" });
  const queued = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });

  // The bridge restarts before it reads the start.
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });

  expect(await admin.as.query(api.terminals.get, { teamId, terminalId: queued.terminalId! })).toMatchObject({ status: "starting" });
  expect(await admin.as.query(api.runs.get, { teamId, runId: queued.runId })).toMatchObject({ state: "unknown" });

  // The previous process took this start (acknowledged it), so the new one has no such terminal.
  const taken = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  await t.mutation(api.bridge.ack, { token, upToSeq: messages.at(-1)!.seq });
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });

  expect(await admin.as.query(api.runs.get, { teamId, runId: taken.runId })).toMatchObject({ state: "failed" });
});

test("the bridge still reads a queued message from an older protocol shape", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  // An answer_prompt queued before answers carried a promptId.
  const old = { v: 1, type: "answer_prompt", source: { kind: "terminal", terminalId: "x" }, from: { memberId: "m", name: "Julio" }, answer: "allow" };
  await t.run(async (ctx) => {
    await ctx.db.insert("bridgeOutbox", { machineId, seq: 1000, message: old });
  });

  expect(await bridgeInbox(t, token)).toContainEqual(old);
});

/** Julio's machine runs a task's terminal (waiting on him) and a T3 Code thread. */
async function machineWithRuns() {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Ship it" });
  const { runId, terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Ship", tool: "codex", access: "suggest" });
  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "terminal", terminalId },
    state: "waiting",
    prompt: { kind: "approval", text: "Codex wants to run a command" },
  });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: "thread-1" }, state: "working", harness: "codex" });
  return { t, teamId, admin, machineId, token, runId };
}

test("unlinking a machine stops its runs, since its bridge can't report on them any more", async () => {
  const { teamId, admin, machineId } = await machineWithRuns();

  await admin.as.mutation(api.machines.unlink, { teamId, machineId });

  const inbox = await admin.as.query(api.inbox.get, { teamId });
  expect(inbox.needsYou).toEqual([]);
  expect(inbox.working).toEqual([]);
  expect(inbox.done.flatMap((row) => row.runs.map((r) => r.state))).toEqual(["stopped", "stopped"]);
});

test("stopping sharing on a machine stops the runs in its terminals", async () => {
  const { teamId, admin, machineId, runId } = await machineWithRuns();

  await admin.as.mutation(api.machines.stopSharing, { teamId, machineId });

  const run = await admin.as.query(api.runs.get, { teamId, runId });
  expect(run.state).toBe("stopped");
  expect(run.prompt).toBeUndefined();
});

test("stopping sharing clears a waiting T3 Code thread's approval from Needs you, and the thread reports again on resume", async () => {
  const { t, teamId, admin, machineId, token } = await machineWithRuns();
  const source = { kind: "thread", threadRef: "thread-1" } as const;
  const prompt = { kind: "approval", text: "T3 Code wants to run a command" } as const;
  await bridgeSays(t, token, { type: "run_state_changed", source, state: "waiting", prompt });
  const threadRun = () =>
    t.run(async (ctx) => (await ctx.db.query("runs").collect()).find((r) => r.threadRef === "thread-1")!);
  expect(await threadRun()).toMatchObject({ state: "waiting", prompt });
  expect((await admin.as.query(api.inbox.get, { teamId })).needsYou).toHaveLength(2);

  await admin.as.mutation(api.machines.stopSharing, { teamId, machineId });

  // The bridge takes no answers while sharing is stopped, so the approval can't wait on anyone.
  const cleared = await threadRun();
  expect(cleared.state).toBe("unknown");
  expect(cleared.prompt).toBeUndefined();
  expect((await admin.as.query(api.inbox.get, { teamId })).needsYou).toEqual([]);

  await admin.as.mutation(api.machines.resumeSharing, { teamId, machineId });
  await bridgeSays(t, token, { type: "run_state_changed", source, state: "waiting", prompt });
  expect(await threadRun()).toMatchObject({ state: "waiting", prompt });
  expect((await admin.as.query(api.inbox.get, { teamId })).needsYou).toHaveLength(1);
});

test("a machine whose bridge goes quiet is marked offline when its online window passes, with one check pending at a time", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      await t.finishInProgressScheduledFunctions();
      await t.mutation(api.bridge.heartbeat, { token });
    }
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.state.kind === "pending"),
    );
    expect(pending).toHaveLength(1);
    expect(await admin.as.query(api.machines.list, { teamId })).toMatchObject([{ online: true }]);

    // The bridge dies. Nothing else writes to the machine, so the room must, or a subscribed list stays online.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({ offlineSince: expect.any(Number) });
    expect(await admin.as.query(api.machines.list, { teamId })).toMatchObject([{ online: false }]);
    await t.mutation(api.bridge.heartbeat, { token });
    expect(await admin.as.query(api.machines.list, { teamId })).toMatchObject([{ online: true }]);
  } finally {
    vi.useRealTimers();
  }
});

test("a bridge that registers with its saved cursor ends a starting terminal whose start it already read", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Write the release notes" });
  const read = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  // The bridge reads and handles this start and saves its cursor, then crashes before it acks or reports.
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  const cursor = messages.at(-1)!.seq;
  const unread = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });

  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS, afterSeq: cursor });

  expect(await admin.as.query(api.terminals.get, { teamId, terminalId: read.terminalId! })).toMatchObject({ status: "ended" });
  expect(await admin.as.query(api.runs.get, { teamId, runId: read.runId })).toMatchObject({ state: "failed" });
  expect(await admin.as.query(api.terminals.get, { teamId, terminalId: unread.terminalId! })).toMatchObject({ status: "starting" });
  expect(await admin.as.query(api.runs.get, { teamId, runId: unread.runId })).toMatchObject({ state: "unknown" });
});
