/**
 * Who may start work on a personal machine (ADR 0025): its person always; teammates and their
 * agents only while its most open access is Drive or Open, each terminal in a free slot. Lowering it
 * to Watch or Suggest makes its person the driver of what teammates were driving there.
 */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, LIMITS, newRoom, newTeam } from "./setup";

/** Axel's machine, whose bridge runs terminals, T3 Code threads and Rex tabs. Julio is an admin, Ana a member. */
async function axelsMachine() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const axel = await addTeammate(t, teamId, julio, "Axel");
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { code } = await axel.as.mutation(api.machines.createPairingCode, { teamId, name: "loiko-machine" });
  const paired = await t.mutation(api.bridge.pair, { code, hostname: "loiko.local", os: "darwin" });
  const machineId = paired.machineId as Id<"machines">;
  const token = paired.token;
  const tools = ["claude", "t3code", "rex", "rex-tabs"];
  await bridgeSays(t, token, { type: "register_machine", hostname: "loiko.local", os: "darwin", bridgeVersion: "0.2.8", tools, limits: LIMITS });
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Fix the flaky test" });
  return { t, teamId, julio, axel, ana, machineId, token, taskId };
}

const VIAS = ["terminal", "thread", "rex"] as const;

test("the person a machine belongs to starts terminals, threads and Rex tabs there at Suggest and Watch, using no slot, and so do their agents", async () => {
  const { t, teamId, axel, machineId, token } = await axelsMachine();
  const axelsTask = await axel.as.mutation(api.tasks.create, { teamId, title: "Tidy the README" });
  expect((await axel.as.query(api.machines.list, { teamId }))[0]!.mostOpenAccess).toBe("suggest");

  for (const level of ["suggest", "watch"] as const) {
    await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: level });
    for (const via of VIAS) {
      await axel.as.mutation(api.runs.start, { teamId, taskId: axelsTask, harness: "claude-code", machineId, via });
    }
  }
  const machine = (await axel.as.query(api.machines.list, { teamId }))[0]!;
  expect(machine.slotsInUse).toBe(0);

  // Axel's own agent, over the Room API: the bridge is told whom it answers for, so it takes it too.
  const { key } = await addAgent(t, teamId, axel, "Claude", ["room.read", "runs.start"]);
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell", title: "Check disk" });
  expect(started.ok).toBe(true);
  expect(await bridgeInbox(t, token)).toContainEqual(
    expect.objectContaining({
      type: "start_terminal",
      terminalId: started.result.terminalId,
      accountable: { memberId: axel.memberId, name: "Axel" },
    }),
  );
});

test("a teammate can't start a terminal, a T3 Code thread or a Rex tab on a personal machine set to Suggest or Watch, admin or not", async () => {
  const { t, teamId, julio, axel, ana, machineId, token, taskId } = await axelsMachine();
  const anasTask = await ana.as.mutation(api.tasks.create, { teamId, title: "Bump the SDK" });
  for (const level of ["suggest", "watch"] as const) {
    await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: level });
    const can = level === "watch" ? "watch terminals" : "watch or suggest in terminals";
    for (const via of VIAS) {
      for (const [who, task] of [[julio, taskId], [ana, anasTask]] as const) {
        await expect(who.as.mutation(api.runs.start, { teamId, taskId: task, harness: "claude-code", machineId, via })).rejects.toThrow(
          `loiko-machine takes runs only from Axel. Teammates can ${can} Axel shares.`,
        );
      }
    }
  }
  // Nothing was made, and nothing reached the bridge.
  expect(await t.run(async (ctx) => (await ctx.db.query("runs").collect()).length)).toBe(0);
  expect((await bridgeInbox(t, token)).filter((m) => m.type === "start_terminal" || m.type === "start_thread")).toEqual([]);
});

test("a teammate's agent is refused at Suggest over the Room API, with what to do", async () => {
  const { t, teamId, julio, machineId } = await axelsMachine();
  const { key } = await addAgent(t, teamId, julio, "Claude", ["room.read", "runs.start"]);

  const refused = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell", title: "Check disk" });

  expect(refused.status).toBe(403);
  expect(refused.error).toEqual({
    code: "forbidden",
    message:
      "loiko-machine takes runs only from Axel. Teammates can watch or suggest in terminals Axel shares. To run there, ask Axel to set it to Drive or Open, or pick another machine.",
  });
});

test("at Drive or Open a teammate starts runs there, each terminal in a free slot and a thread in none", async () => {
  const { teamId, julio, axel, machineId, taskId } = await axelsMachine();
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "drive", slots: 1 });

  const first = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });
  await expect(julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "rex" })).rejects.toThrow(/no free slot/i);
  expect((await julio.as.query(api.terminals.get, { teamId, terminalId: first.terminalId! })).usesSlot).toBe(true);

  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open", slots: 2 });
  const second = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "rex", access: "open" });
  expect((await julio.as.query(api.terminals.get, { teamId, terminalId: second.terminalId! })).driver?.name).toBe("Julio");
  expect((await axel.as.query(api.machines.list, { teamId }))[0]!.slotsInUse).toBe(2);
});

test("lowering a machine to Suggest makes its person the driver of teammates' terminals, Rex runs and threads, and the work keeps running", async () => {
  const { t, teamId, julio, axel, machineId, token, taskId } = await axelsMachine();
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const terminalRun = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "open" });
  const rexRun = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId, via: "rex", access: "drive" });
  const threadRun = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" });
  const terminalId = terminalRun.terminalId!;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "codex", tool: "codex", access: "open" });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "working" });
  const before = (await bridgeInbox(t, token)).length;

  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "suggest" });

  for (const id of [terminalId, rexRun.terminalId!]) {
    expect(await axel.as.query(api.terminals.get, { teamId, terminalId: id })).toMatchObject({ driver: { name: "Axel" }, access: "suggest", status: expect.stringMatching(/starting|live/) });
  }
  expect(await axel.as.query(api.runs.get, { teamId, runId: terminalRun.runId })).toMatchObject({ state: "working", driver: { name: "Axel" } });
  expect(await axel.as.query(api.threads.get, { teamId, runId: threadRun.runId })).toMatchObject({ driver: { name: "Axel" }, access: "suggest" });
  // The bridge hears each new driver before the lower level, so even a bridge from before this rule takes it.
  const sent = (await bridgeInbox(t, token)).slice(before);
  expect(sent.map((m) => m.type)).toEqual([
    "driver_changed",
    "driver_changed",
    "thread_driver_changed",
    "change_access",
    "change_access",
    "change_thread_access",
  ]);
  expect(sent[0]).toMatchObject({ terminalId, driver: { memberId: axel.memberId, name: "Axel" } });
  expect(sent[2]).toMatchObject({ threadRef: threadRun.runId, driver: { memberId: axel.memberId } });

  // Julio's keyboard is off, and he can't take the wheel back while the machine stays at Suggest.
  await expect(julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\r" })).rejects.toThrow(/driver/);
  await expect(julio.as.mutation(api.terminals.takeWheel, { teamId, terminalId })).rejects.toThrow(
    "loiko-machine is set to suggest, so only Axel drives there.",
  );
  await expect(julio.as.mutation(api.threads.takeWheel, { teamId, runId: threadRun.runId })).rejects.toThrow(/only Axel drives there/);
  const julioId = (await julio.as.query(api.teams.mine, {}))[0]!.memberId;
  await expect(axel.as.mutation(api.terminals.passWheel, { teamId, terminalId, to: julioId })).rejects.toThrow(/only Axel drives there/);
  await julio.as.mutation(api.terminals.suggest, { teamId, terminalId, command: "pnpm test" });
  await axel.as.mutation(api.terminals.input, { teamId, terminalId, data: "pnpm test\r" });

  // The thread's approval now waits on Axel, and his answer reaches the bridge as the driver's.
  const prompt = { kind: "approval", text: "Codex wants to run pnpm install", promptId: "p1" } as const;
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: threadRun.runId }, state: "waiting", prompt });
  await axel.as.mutation(api.inbox.answer, { teamId, runId: threadRun.runId, answer: "allow", promptId: "p1" });
  expect((await bridgeInbox(t, token)).at(-1)).toMatchObject({ type: "answer_prompt", from: { memberId: axel.memberId }, answer: "allow" });
});

test("a bridge that lowers its own limit below Drive hands teammates' terminals to the machine's person", async () => {
  const { t, teamId, julio, axel, machineId, token, taskId } = await axelsMachine();
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "drive" });
  const { terminalId } = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "drive" });

  await bridgeSays(t, token, { type: "limits_changed", limits: { ...LIMITS, mostOpenAccess: "suggest" } });

  expect((await axel.as.query(api.machines.list, { teamId }))[0]!.mostOpenAccess).toBe("suggest");
  expect((await axel.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).driver?.name).toBe("Axel");
});

test("a teammate who still drives on a Suggest machine from before this rule can't type, resize, message the thread or answer as its driver", async () => {
  const { t, teamId, axel, ana, machineId, token, taskId } = await axelsMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_messages"] });
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const terminalRun = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "open" });
  const threadRun = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" });
  const terminalId = terminalRun.terminalId!;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "codex", tool: "codex", access: "open" });
  // Lowered before ADR 0025 handed wheels over: Ana still drives both.
  await t.run(async (ctx) => {
    await ctx.db.patch(machineId, { mostOpenAccess: "suggest" });
    await ctx.db.patch(terminalId, { access: "suggest" });
    await ctx.db.patch(threadRun.runId, { threadAccess: "suggest" });
  });
  const prompt = { kind: "approval", text: "Codex wants to run pnpm install", promptId: "p1" } as const;
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: threadRun.runId }, state: "waiting", prompt });
  const before = (await bridgeInbox(t, token)).length;

  const refused = /only Axel drives there/;
  await expect(ana.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\r" })).rejects.toThrow(refused);
  await expect(ana.as.mutation(api.terminals.resize, { teamId, terminalId, cols: 100, rows: 30 })).rejects.toThrow(refused);
  await expect(ana.as.mutation(api.threads.send, { teamId, runId: threadRun.runId, text: "go on" })).rejects.toThrow(refused);
  await expect(ana.as.mutation(api.inbox.answer, { teamId, runId: threadRun.runId, answer: "allow", promptId: "p1" })).rejects.toThrow(
    "Only the run's driver, the task's owner or an admin can answer this.",
  );
  // Nothing of hers reached the bridge; Axel still takes the wheel and types.
  expect((await bridgeInbox(t, token)).slice(before)).toEqual([]);
  await axel.as.mutation(api.terminals.takeWheel, { teamId, terminalId });
  await axel.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\r" });
});

test("a bridge that restarts with a limit below Drive hands teammates' threads to the machine's person once it says it takes thread drivers", async () => {
  const { t, teamId, julio, axel, machineId, token, taskId } = await axelsMachine();
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const threadRun = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" });
  const before = (await bridgeInbox(t, token)).length;

  // A new bridge process, with a lower limit in its bridge.json: features come after it registers.
  const tools = ["claude", "t3code", "rex", "rex-tabs"];
  await bridgeSays(t, token, { type: "register_machine", hostname: "loiko.local", os: "darwin", bridgeVersion: "0.2.9", tools, limits: { ...LIMITS, mostOpenAccess: "suggest" } });
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });

  expect(await axel.as.query(api.threads.get, { teamId, runId: threadRun.runId })).toMatchObject({ driver: { name: "Axel" }, access: "suggest" });
  const sent = (await bridgeInbox(t, token)).slice(before);
  expect(sent.filter((m) => m.type === "thread_driver_changed")).toEqual([
    expect.objectContaining({ threadRef: threadRun.runId, driver: { memberId: axel.memberId, name: "Axel" } }),
  ]);
});

test("a bridge that says it takes thread drivers hears again who drives each thread the room gave the machine's person", async () => {
  const { t, teamId, julio, axel, machineId, token, taskId } = await axelsMachine();
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const threadRun = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" });
  // An older bridge refused the handoff, so it kept Julio while the room names Axel; then it was upgraded.
  await t.run(async (ctx) => {
    await ctx.db.patch(machineId, { mostOpenAccess: "suggest" });
    await ctx.db.patch(threadRun.runId, { threadAccess: "suggest", driverId: axel.memberId as never });
  });
  const before = (await bridgeInbox(t, token)).length;
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  expect((await bridgeInbox(t, token)).slice(before).filter((m) => m.type === "thread_driver_changed")).toEqual([
    expect.objectContaining({ threadRef: threadRun.runId, driver: { memberId: axel.memberId, name: "Axel" } }),
  ]);
});

test("a teammate who still drives on a Watch machine from before this rule can't suggest there either", async () => {
  const { t, teamId, axel, ana, machineId, token, taskId } = await axelsMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_messages"] });
  await axel.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const terminalRun = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, access: "open" });
  const threadRun = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" });
  const terminalId = terminalRun.terminalId!;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "codex", tool: "codex", access: "open" });
  await t.run(async (ctx) => {
    await ctx.db.patch(machineId, { mostOpenAccess: "watch" });
    await ctx.db.patch(terminalId, { access: "watch" });
    await ctx.db.patch(threadRun.runId, { threadAccess: "watch" });
  });
  await expect(ana.as.mutation(api.terminals.suggest, { teamId, terminalId, command: "ls" })).rejects.toThrow(/set to watch/);
  await expect(ana.as.mutation(api.threads.suggest, { teamId, runId: threadRun.runId, text: "go on" })).rejects.toThrow(/set to watch/);
});
