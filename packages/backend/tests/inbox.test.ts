import { expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { addTeammate, bridgeInbox, bridgeSays, linkMachine, newRoom, newTeam } from "./setup";

const approval = { kind: "approval", text: "Codex wants to run a command", action: "pnpm add -D tiled-map" } as const;

/** Julio owns a task; Ana drives its run on her own machine. */
async function anaDrivesJuliosTask() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Add the tile map" });
  const { machineId, token } = await linkMachine(t, teamId, ana, "ana-laptop");
  const { runId, terminalId } = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  return { t, teamId, julio, ana, taskId, runId, terminalId: terminalId!, token };
}

test("a waiting run goes to its driver's inbox with what it asks, not to the task owner's", async () => {
  const { t, teamId, julio, ana, taskId, terminalId, token } = await anaDrivesJuliosTask();

  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: approval });

  const anas = await ana.as.query(api.inbox.get, { teamId });
  expect(anas.needsYou).toMatchObject([{ taskId, title: "Add the tile map", reason: "Codex wants to run a command", state: "waiting" }]);
  const julios = await julio.as.query(api.inbox.get, { teamId });
  expect(julios.needsYou).toEqual([]);
  // The owner sees who it's waiting on, without being asked.
  expect(julios.working).toMatchObject([{ taskId, waitingOn: [{ name: "Ana" }] }]);
  const [card] = await julio.as.query(api.tasks.board, { teamId });
  expect(card).toMatchObject({ state: "waiting", column: "needs_someone", waitingOn: [{ name: "Ana" }] });
});

test("an inbox item clears as soon as the run stops waiting, wherever it was answered", async () => {
  const { t, teamId, ana, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: approval });

  // Answered in the terminal itself, not in the room.
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "working" });

  const inbox = await ana.as.query(api.inbox.get, { teamId });
  expect(inbox.needsYou).toEqual([]);
  expect(inbox.working).toMatchObject([{ state: "working" }]);
});

test("a waiting run the bridge reports Stopped leaves Needs you, with no prompt left to answer", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { token } = await linkMachine(t, teamId, admin, "julio-mbp");
  // A T3 Code thread deleted while it waited.
  const source = { kind: "thread", threadRef: "t3-thread-gone" } as const;
  await bridgeSays(t, token, { type: "run_state_changed", source, state: "waiting", prompt: approval, harness: "codex" });
  expect((await admin.as.query(api.inbox.get, { teamId })).needsYou).toMatchObject([{ unfiled: true }]);

  await bridgeSays(t, token, { type: "run_state_changed", source, state: "stopped" });

  expect(await admin.as.query(api.inbox.get, { teamId })).toMatchObject({ needsYou: [], working: [] });
  const [unfiled] = await admin.as.query(api.runs.unfiled, { teamId });
  expect(unfiled).toMatchObject({ state: "stopped" });
  expect(unfiled!.prompt).toBeUndefined();
});

test("a driver answers an approval from the inbox, and the bridge gets the answer", async () => {
  const { t, teamId, ana, runId, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: approval });

  await ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow", promptId: "" });

  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  expect(messages.map((m) => m.message)).toContainEqual(
    expect.objectContaining({ type: "answer_prompt", source: { kind: "terminal", terminalId }, answer: "allow", from: expect.objectContaining({ name: "Ana" }) }),
  );
});

test("finished work stays in Done until it's settled, and comes back when a run changes state", async () => {
  const { t, teamId, ana, taskId, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "done" });
  expect((await ana.as.query(api.inbox.get, { teamId })).done).toMatchObject([{ taskId, state: "done" }]);

  await ana.as.mutation(api.inbox.settle, { teamId, taskId });
  expect(await ana.as.query(api.inbox.get, { teamId })).toMatchObject({ needsYou: [], working: [], done: [] });

  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: approval });
  expect((await ana.as.query(api.inbox.get, { teamId })).needsYou).toMatchObject([{ taskId }]);
});

test("a settled task with a failed run leaves Needs someone for Done on the board, and comes back when a run changes state", async () => {
  const { t, teamId, julio, ana, taskId, terminalId, token } = await anaDrivesJuliosTask();
  const { machineId } = (await ana.as.query(api.machines.list, { teamId }))[0]!;
  const more = [
    (await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId })).terminalId!,
    (await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId })).terminalId!,
  ];
  const ends = async (id: typeof terminalId, state: "done" | "failed" | "waiting") =>
    bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId: id }, state, ...(state === "waiting" ? { prompt: approval } : {}) });
  await ends(terminalId, "failed");
  await ends(more[0]!, "done");
  await ends(more[1]!, "done");
  expect(await julio.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ state: "failed", column: "needs_someone", settled: false });

  await julio.as.mutation(api.inbox.settle, { teamId, taskId });

  // The Inbox already hid it (settledAt is newer than every run's change); the board now agrees.
  expect((await julio.as.query(api.inbox.get, { teamId })).done).toEqual([]);
  // The runs still say what happened; settling only puts the task away.
  expect(await julio.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ state: "failed", column: "done", settled: true });
  expect(await julio.as.query(api.tasks.board, { teamId })).toMatchObject([{ taskId, column: "done", settled: true }]);

  await ends(more[1]!, "waiting");
  expect(await julio.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ state: "waiting", column: "needs_someone", settled: false });
});

test("a settled task with a run still working stays in Working", async () => {
  const { t, teamId, julio, taskId, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "working" });
  // An agent can settle unfinished work; the board still shows it working.
  await julio.as.mutation(api.inbox.settle, { teamId, taskId });
  expect(await julio.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ column: "working", settled: false });
});

test("a settled unfiled run says so, until it changes state again", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const source = { kind: "thread", threadRef: "t3-thread-settle" } as const;
  await bridgeSays(t, token, { type: "run_state_changed", source, state: "done", harness: "codex" });
  const [unfiled] = await admin.as.query(api.runs.unfiled, { teamId });
  expect(await admin.as.query(api.runs.get, { teamId, runId: unfiled!.runId })).toMatchObject({ settled: false });

  await admin.as.mutation(api.inbox.settle, { teamId, runId: unfiled!.runId });
  expect(await admin.as.query(api.runs.get, { teamId, runId: unfiled!.runId })).toMatchObject({ settled: true });

  await bridgeSays(t, token, { type: "run_state_changed", source, state: "working" });
  expect(await admin.as.query(api.runs.get, { teamId, runId: unfiled!.runId })).toMatchObject({ settled: false });
});

test("an answer names the approval it answers, and an answer to an earlier approval is refused", async () => {
  const { t, teamId, ana, runId, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "terminal", terminalId },
    state: "waiting",
    prompt: { ...approval, promptId: "approval-2" },
  });

  await expect(ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow", promptId: "approval-1" })).rejects.toThrow(
    /isn't the approval/i,
  );
  await ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow", promptId: "approval-2" });

  const answers = (await bridgeInbox(t, token)).filter((m: any) => m.type === "answer_prompt");
  expect(answers).toMatchObject([{ promptId: "approval-2", answer: "allow" }]);
});

test("an answer that doesn't name the approval is refused, so a slow answer can't approve a newer one", async () => {
  const { t, teamId, ana, runId, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "terminal", terminalId },
    state: "waiting",
    prompt: { ...approval, promptId: "approval-b" },
  });

  await expect(ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow" } as any)).rejects.toThrow();
  await expect(ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow", promptId: "" })).rejects.toThrow(
    /isn't the approval/i,
  );

  expect((await bridgeInbox(t, token)).filter((m: any) => m.type === "answer_prompt")).toEqual([]);
});

test("an answer from the task's owner reaches the bridge as the driver's, and the log keeps who answered", async () => {
  const { t, teamId, julio, ana, runId, terminalId, token } = await anaDrivesJuliosTask();
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: approval });

  await julio.as.mutation(api.inbox.answer, { teamId, runId, answer: "deny", promptId: "" });

  const answers = (await bridgeInbox(t, token)).filter((m: any) => m.type === "answer_prompt");
  expect(answers).toMatchObject([{ answer: "deny", from: { memberId: ana.memberId, name: "Ana" } }]);
  expect((await julio.as.query(api.runs.get, { teamId, runId })).lastAnswer).toMatchObject({ answer: "deny", by: { name: "Julio" } });
  const [entry] = await julio.as.query(api.activity.list, { teamId, target: runId });
  expect(entry).toMatchObject({ action: "approval.answered", actor: { name: "Julio" } });
});

test("inbox rows carry the task's project, and none for a task without one or an unfiled run", async () => {
  const { t, teamId, julio, ana, terminalId, token } = await anaDrivesJuliosTask();
  const projectId = await julio.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });
  const filedTask = await julio.as.mutation(api.tasks.create, { teamId, title: "Export invoices", projectId });
  const { machineId, token: anaToken } = await linkMachine(t, teamId, ana, "ana-desktop");
  const filed = await ana.as.mutation(api.runs.start, { teamId, taskId: filedTask, harness: "codex", machineId });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: approval });
  await bridgeSays(t, anaToken, { type: "run_state_changed", source: { kind: "terminal", terminalId: filed.terminalId }, state: "waiting", prompt: approval });
  await bridgeSays(t, anaToken, { type: "run_state_changed", source: { kind: "thread", threadRef: "t3-thread-1" }, state: "working", harness: "codex", title: "Loose thread" });

  const inbox = await ana.as.query(api.inbox.get, { teamId });

  expect(inbox.needsYou.find((r) => r.taskId === filedTask)?.projectId).toBe(projectId);
  expect(inbox.needsYou.find((r) => r.title === "Add the tile map")?.projectId).toBeUndefined();
  const loose = inbox.working.find((r) => r.unfiled);
  expect(loose?.title).toBe("Loose thread");
  expect(loose?.projectId).toBeUndefined();
});

test("a snooze ends at its time even when nothing else changes, and a replaced snooze doesn't end early", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const HOUR = 60 * 60 * 1000;
    const { t, teamId, ana, taskId, terminalId, token } = await anaDrivesJuliosTask();
    await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "done" });
    vi.advanceTimersByTime(1000);
    await ana.as.mutation(api.inbox.snooze, { teamId, taskId, until: Date.now() + HOUR });
    vi.advanceTimersByTime(1000);
    await ana.as.mutation(api.inbox.snooze, { teamId, taskId, until: Date.now() + 2 * HOUR });
    expect((await ana.as.query(api.inbox.get, { teamId })).done).toEqual([]);

    vi.advanceTimersByTime(HOUR);
    await t.finishInProgressScheduledFunctions();
    expect((await ana.as.query(api.inbox.get, { teamId })).done).toEqual([]);

    // Nothing else writes at the deadline, so the room must, or a subscribed Inbox stays snoozed.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await t.run((ctx) => ctx.db.get(taskId)))!.snoozedUntil).toBeUndefined();
    expect((await ana.as.query(api.inbox.get, { teamId })).done).toMatchObject([{ taskId, state: "done" }]);
  } finally {
    vi.useRealTimers();
  }
});

test("a task stays in Working while any run is still going, even after another run failed", async () => {
  const { t, teamId, ana, taskId, terminalId, token } = await anaDrivesJuliosTask();
  const { terminalId: retry } = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId: (await ana.as.query(api.machines.list, { teamId }))[0]!.machineId });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "failed" });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId: retry! }, state: "working" });

  const inbox = await ana.as.query(api.inbox.get, { teamId });
  // The failed attempt still shows as the row's state, but the retry keeps the task out of Done.
  expect(inbox.done).toEqual([]);
  expect(inbox.working).toMatchObject([{ taskId, state: "failed" }]);

  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId: retry! }, state: "done" });
  expect((await ana.as.query(api.inbox.get, { teamId })).done).toMatchObject([{ taskId }]);
});
