import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, LIMITS, linkMachine, newRoom, newTeam } from "./setup";

async function teamWithTask() {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });
  return { t, teamId, admin, taskId };
}

test("starting a run opens a terminal on the machine, driven by whoever started it", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");

  const { runId, terminalId } = await admin.as.mutation(api.runs.start, {
    teamId,
    taskId,
    harness: "claude-code",
    machineId,
    repo: "github.com/nuko/billing",
    access: "suggest",
  });

  expect(await bridgeInbox(t, token)).toMatchObject([
    { type: "start_terminal", terminalId, startedBy: { name: "Julio" }, usesSlot: false, access: "suggest", command: "claude" },
  ]);
  const task = await admin.as.query(api.tasks.get, { teamId, taskId });
  expect(task.runs).toMatchObject([{ runId, harness: "claude-code", state: "unknown", driver: { name: "Julio" } }]);
  expect(task.column).toBe("working");
});

test("a teammate's terminal uses a slot, and starts fail when every slot is taken", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, slots: 1, mostOpenAccess: "drive" });
  const anasTask = await ana.as.mutation(api.tasks.create, { teamId, title: "Write the release notes" });

  await ana.as.mutation(api.runs.start, { teamId, taskId: anasTask, harness: "codex", machineId });
  await expect(
    ana.as.mutation(api.runs.start, { teamId, taskId: anasTask, harness: "codex", machineId }),
  ).rejects.toThrow(/no free slot/i);

  // Whoever the machine belongs to never uses slots on it.
  await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  const [machine] = await admin.as.query(api.machines.list, { teamId });
  expect(machine).toMatchObject({ slots: 1, slotsInUse: 1, liveTerminals: 2 });
});

test("a terminal can't be opened further than its machine allows", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "drive" });

  await expect(
    admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "open" }),
  ).rejects.toThrow(/allows at most drive/i);
  const { terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "drive" });
  await expect(
    admin.as.mutation(api.terminals.setAccess, { teamId, terminalId: terminalId!, access: "open" }),
  ).rejects.toThrow(/allows at most drive/i);
});

test("lowering a machine's limit lowers the terminals above it, marked with what they were", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "team-box", { team: true });
  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const { terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "open" });

  await admin.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "drive" });

  const terminal = await admin.as.query(api.terminals.get, { teamId, terminalId: terminalId! });
  expect(terminal).toMatchObject({ access: "drive", loweredFrom: "open" });
  expect(await bridgeInbox(t, token)).toContainEqual(
    expect.objectContaining({ type: "change_access", terminalId, access: "drive" }),
  );
});

test("a run can be stopped from the room", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId, terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });

  await admin.as.mutation(api.runs.stop, { teamId, runId });

  expect(await bridgeInbox(t, token)).toContainEqual({ v: 1, type: "stop_terminal", terminalId });
  const task = await admin.as.query(api.tasks.get, { teamId, taskId });
  expect(task.runs[0]).toMatchObject({ state: "stopped" });
});

test("an agent's terminal uses a slot even on its person's machine, as the bridge counts it", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { key } = await addAgent(t, teamId, admin, "Builder", ["room.read", "runs.start"]);

  expect(await callAsAgent(t, key, "runs.start", { taskId, harness: "codex", machineId })).toMatchObject({ ok: true });

  expect(await bridgeInbox(t, token)).toMatchObject([{ type: "start_terminal", startedBy: { name: "Builder" }, usesSlot: true }]);
  expect(await admin.as.query(api.machines.list, { teamId })).toMatchObject([{ slotsInUse: 1 }]);
});

test("a terminal stopped on the machine or by a closing bridge leaves its run Stopped; an exit still decides Done or Failed", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const start = async () => {
    const { runId, terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId });
    await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "suggest" });
    return { runId, terminalId };
  };
  const state = async (runId: any) => (await admin.as.query(api.runs.get, { teamId, runId })).state;

  const closed = await start();
  await bridgeSays(t, token, { type: "terminal_ended", terminalId: closed.terminalId, reason: "bridge_stopped" });
  expect(await state(closed.runId)).toBe("stopped");

  const stopped = await start();
  await bridgeSays(t, token, { type: "terminal_ended", terminalId: stopped.terminalId, reason: "stopped" });
  expect(await state(stopped.runId)).toBe("stopped");

  const exited = await start();
  await bridgeSays(t, token, { type: "terminal_ended", terminalId: exited.terminalId, reason: "exited", exitCode: 0 });
  expect(await state(exited.runId)).toBe("done");

  const crashed = await start();
  await bridgeSays(t, token, { type: "terminal_ended", terminalId: crashed.terminalId, exitCode: 2 });
  expect(await state(crashed.runId)).toBe("failed");
});

test("a thread run is refused for a harness T3 Code can't run, before anything reaches the machine", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  await expect(admin.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId, via: "thread" })).rejects.toThrow(
    /T3 Code runs agents, not a plain shell/,
  );
  await expect(admin.as.mutation(api.runs.start, { teamId, taskId, harness: "hermes-agent", machineId, via: "thread" })).rejects.toThrow(
    /no Hermes Agent provider/,
  );
  expect(await bridgeInbox(t, token)).toEqual([]);
});

test("Hermes Agent runs in a terminal with its own command, hermes", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "hermes-agent", machineId });
  expect(await bridgeInbox(t, token)).toEqual([
    expect.objectContaining({ type: "start_terminal", terminalId, harness: "hermes-agent", command: "hermes" }),
  ]);
});

test("stopping a T3 Code thread run asks the bridge to stop the bound thread", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });
  await bridgeSays(t, token, { type: "thread_bound", runId, threadRef: "t3-thread-1" });

  await admin.as.mutation(api.runs.stop, { teamId, runId });

  expect((await bridgeInbox(t, token)).map((m: any) => m.type)).toEqual(["start_thread", "stop_thread"]);
  expect((await bridgeInbox(t, token))[1]).toMatchObject({ type: "stop_thread", threadRef: "t3-thread-1" });
  // A late report from the thread doesn't bring a stopped run back.
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: "t3-thread-1" }, state: "working" });
  expect(await admin.as.query(api.runs.get, { teamId, runId })).toMatchObject({ state: "stopped" });
});

/** A run launched in T3 Code and bound to a thread, with a way to read its state. */
async function boundThreadRun() {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });
  await bridgeSays(t, token, { type: "thread_bound", runId, threadRef: "t3-thread-1" });
  const source = { kind: "thread", threadRef: "t3-thread-1" } as const;
  const report = (state: string, extra: object = {}) => bridgeSays(t, token, { type: "run_state_changed", source, state, ...extra });
  const get = () => admin.as.query(api.runs.get, { teamId, runId });
  return { t, teamId, admin, taskId, runId, report, get, token, machineId };
}

test("a run the bridge reports Stopped comes back when the thread is continued", async () => {
  const { report, get } = await boundThreadRun();
  await report("working");
  // Interrupted in T3 Code.
  await report("stopped");
  expect(await get()).toMatchObject({ state: "stopped" });

  // The person sends another message, and the agent works, asks, then finishes.
  await report("working");
  const resumed = await get();
  expect(resumed.state).toBe("working");
  expect(resumed.endedAt).toBeUndefined();
  await report("waiting", { prompt: { kind: "question", text: "Which branch?" } });
  expect(await get()).toMatchObject({ state: "waiting", prompt: { text: "Which branch?" } });
  await report("stopped");
  await report("done");
  expect(await get()).toMatchObject({ state: "done" });
});

test("a bridge that loses T3 Code (Unknown) doesn't bring a run it reported Stopped back", async () => {
  const { report, get } = await boundThreadRun();
  await report("stopped");
  await report("unknown");
  expect(await get()).toMatchObject({ state: "stopped" });
});

test("a bridge that loses T3 Code (Unknown) doesn't bring settled Done or Failed work back", async () => {
  for (const finished of ["done", "failed"] as const) {
    const { teamId, admin, taskId, report, get } = await boundThreadRun();
    await report(finished);
    const before = await get();
    expect(before.endedAt).toBeDefined();
    await admin.as.mutation(api.inbox.settle, { teamId, taskId });
    expect(await admin.as.query(api.inbox.get, { teamId })).toMatchObject({ needsYou: [], working: [], done: [] });

    await report("unknown");

    // The run keeps its state, end time and change time, so the settled work stays out of the Inbox.
    expect(await get()).toMatchObject({ state: finished, endedAt: before.endedAt, stateChangedAt: before.stateChangedAt });
    expect(await admin.as.query(api.inbox.get, { teamId })).toMatchObject({ needsYou: [], working: [], done: [] });
    // A real report still changes it.
    await report("working");
    expect(await get()).toMatchObject({ state: "working" });
  }
});

test("stopping from the room ends a run the bridge already reported Stopped for good", async () => {
  const { teamId, admin, runId, report, get } = await boundThreadRun();
  await report("stopped");
  await admin.as.mutation(api.runs.stop, { teamId, runId });
  await report("working");
  expect(await get()).toMatchObject({ state: "stopped" });
});

test("a launched thread is bound to its run, so its reports don't make an unfiled run", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });

  await bridgeSays(
    t,
    token,
    { type: "thread_bound", runId, threadRef: "t3-thread-2" },
    { type: "run_state_changed", source: { kind: "thread", threadRef: "t3-thread-2" }, state: "working", title: "Fix totals" },
  );

  expect(await admin.as.query(api.runs.get, { teamId, runId })).toMatchObject({ state: "working", threadRef: "t3-thread-2" });
  expect(await admin.as.query(api.runs.unfiled, { teamId })).toEqual([]);
});

test("a thread that fails to start fails its run with the bridge's reason", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });

  await bridgeSays(t, token, {
    type: "thread_start_failed",
    runId,
    reason: "project_not_registered",
    detail: "No T3 Code project contains /work/billing.",
  });

  expect(await admin.as.query(api.runs.get, { teamId, runId })).toMatchObject({
    state: "failed",
    failReason: "project_not_registered: No T3 Code project contains /work/billing.",
  });
});

// ---------- live runs are addressable (ADR 0026) ----------

test("runs.live names each live run by its harness and driver, numbered when one person has two of a harness", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { machineId: teamBox } = await linkMachine(t, teamId, admin, "team-box", { team: true });
  const first = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  const second = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId: teamBox });

  const live = await ana.as.query(api.runs.live, { teamId });
  expect(live.map((r) => r.label)).toEqual(["Claude Code (Julio)", "Claude Code 2 (Julio)", "Codex (Julio)", "Claude Code (Ana)"]);
  expect(live[1]).toMatchObject({
    runId: second.runId,
    token: `<@run:${second.runId}>`,
    harness: "claude-code",
    driver: { name: "Julio" },
    accountable: { name: "Julio" },
    task: { taskId, title: "Fix invoice totals" },
    hears: "anyone",
    hearsYou: true,
  });

  // An ended run is no longer addressable, and the numbers close up.
  await admin.as.mutation(api.runs.stop, { teamId, runId: first.runId });
  const after = await ana.as.query(api.runs.live, { teamId });
  expect(after.map((r) => r.label)).toEqual(["Claude Code (Julio)", "Codex (Julio)", "Claude Code (Ana)"]);
  expect(after[0]!.runId).toBe(second.runId);
});

test("only a run's driver narrows who may message it, to themselves and their agents", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  const mine = await addAgent(t, teamId, admin, "Builder", ["room.read", "terminals.drive"]);
  const anas = await addAgent(t, teamId, ana, "Scout", ["room.read", "terminals.drive"]);

  await expect(ana.as.mutation(api.runs.setHears, { teamId, runId, hears: "driver" })).rejects.toThrow(/Only the run's driver/);
  expect(await callAsAgent(t, anas.key, "runs.setHears", { runId, hears: "driver" })).toMatchObject({ ok: false, error: { code: "forbidden" } });

  expect(await admin.as.mutation(api.runs.setHears, { teamId, runId, hears: "driver" })).toEqual({ runId, hears: "driver" });
  const [forAna] = await ana.as.query(api.runs.live, { teamId });
  expect(forAna).toMatchObject({ hears: "driver", hearsYou: false });
  const forBuilder = await callAsAgent(t, mine.key, "runs.live");
  expect(forBuilder.result[0]).toMatchObject({ hears: "driver", hearsYou: true });
  expect((await callAsAgent(t, anas.key, "runs.live")).result[0]).toMatchObject({ hearsYou: false });

  // The driver's own agent may open it up again.
  expect(await callAsAgent(t, mine.key, "runs.setHears", { runId, hears: "anyone" })).toMatchObject({ ok: true });
  expect((await ana.as.query(api.runs.live, { teamId }))[0]).toMatchObject({ hears: "anyone", hearsYou: true });
});

test("a run started in the app is open to its team and can't be closed (ADR 0044)", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    taskId,
    harness: "claude-code",
    machineId,
  });

  expect(await ana.as.query(api.runs.live, { teamId })).toEqual([
    expect.objectContaining({ runId, open: true, hearsYou: true }),
  ]);
  await expect(admin.as.mutation(api.runs.setOpen, { teamId, runId, open: false })).rejects.toThrow(
    /Only a session that joined with uplink join/,
  );
  expect(await admin.as.mutation(api.runs.setOpen, { teamId, runId, open: true })).toEqual({
    runId,
    open: true,
  });
});

test("a thread run stays live between turns, until T3 Code closes its thread, it is stopped, or its machine is unlinked", async () => {
  const { t, teamId, admin, taskId, runId, report, token, machineId } = await boundThreadRun();
  const live = async () => (await admin.as.query(api.runs.live, { teamId })).map((r) => r.runId);
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_closed"] });
  await report("working");
  expect((await admin.as.query(api.runs.live, { teamId })).map((r) => [r.runId, r.label, r.via])).toEqual([[runId, "Codex (Julio)", "thread"]]);
  // T3 Code reports a finished turn as Done; the thread is still open, so it can still be messaged.
  await report("done");
  expect(await live()).toEqual([runId]);
  // Archived in T3 Code.
  await bridgeSays(t, token, { type: "thread_closed", threadRef: "t3-thread-1" });
  expect(await live()).toEqual([]);

  // A new bridge process reports again each thread T3 Code lists; until it does, none is open.
  await report("done", { title: "Again" });
  expect(await live()).toEqual([runId]);
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });
  expect(await live()).toEqual([]);
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_closed"] }, { type: "run_state_changed", source: { kind: "thread", threadRef: "t3-thread-1" }, state: "done", title: "Again" });
  expect(await live()).toEqual([runId]);

  // Stopped: over, whatever the thread does.
  await admin.as.mutation(api.runs.stop, { teamId, runId });
  expect(await live()).toEqual([]);

  // Unlinking the machine ends its threads' runs as addresses too.
  const { runId: other } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });
  await bridgeSays(t, token, { type: "thread_bound", runId: other, threadRef: "t3-thread-2" });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: "t3-thread-2" }, state: "done" });
  expect(await live()).toEqual([other]);
  await admin.as.mutation(api.machines.unlink, { teamId, machineId });
  expect(await live()).toEqual([]);
});

test("a Done thread run from a bridge that never says when T3 Code closes a thread isn't live", async () => {
  const { teamId, admin, report } = await boundThreadRun();
  await report("done");
  expect(await admin.as.query(api.runs.live, { teamId })).toEqual([]);
});

test("runs.live says how a run hears messages once its bridge reports it, and that they wait until then", async () => {
  const { t, teamId, admin, taskId } = await teamWithTask();
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  expect((await admin.as.query(api.runs.live, { teamId }))[0]).toMatchObject({ hearing: "unknown", machine: { name: "julio-mbp" } });
  // A bridge that delivers run messages reports how the run hears them (slice 4 of #139).
  await bridgeSays(t, token, { type: "bridge_features", features: ["run_messages"] });
  const terminalId = (await t.run((ctx) => ctx.db.get(runId)))!.terminalId!;
  await bridgeSays(t, token, { type: "run_hearing", source: { kind: "terminal", terminalId }, hearing: "mid_task" });
  expect((await admin.as.query(api.runs.live, { teamId }))[0]).toMatchObject({ hearing: "mid_task" });
});

test("a terminal shared from the machine with claude is a Claude Code run, named and numbered with the ones the room starts", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  // `uplink-bridge share -- claude`: the bridge names the terminal by its Claude Code adapter, `claude`.
  await bridgeSays(
    t,
    token,
    { type: "terminal_started", localRef: "local-1", title: "claude", tool: "claude", access: "suggest" },
    { type: "run_state_changed", source: { kind: "terminal", terminalId: "local-1" }, state: "working" },
  );
  const live = await julio.as.query(api.runs.live, { teamId });
  expect(live.map((r) => r.label)).toEqual(["Claude Code (Julio)", "Claude Code 2 (Julio)"]);
  const shared = await t.run(async (ctx) => ctx.db.get(live[1]!.runId as Id<"runs">));
  expect(shared!.harness).toBe("claude-code");
});
