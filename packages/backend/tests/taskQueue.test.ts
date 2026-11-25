/** ADR 0050: tasks that wait for others, and queue for a machine's free slot. */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeInbox, bridgeSays, linkMachine, newRoom, newTeam } from "./setup";

/**
 * Runs what the room scheduled to run now, such as a queue's dispatch. Not settleScheduled: a linked
 * machine's online check stays scheduled 90 seconds out.
 */
async function drain(t: ReturnType<typeof newRoom>) {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/** Julio's team machine with one slot, and Ana, a teammate whose terminals use it. */
async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, "build-box", { team: true });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, slots: 1, mostOpenAccess: "open" });
  return { t, teamId, julio, ana, machineId, token };
}

const starts = async (t: ReturnType<typeof newRoom>, token: string) =>
  (await bridgeInbox(t, token)).filter((m: { type: string }) => m.type === "start_terminal");

test("a queued task waits for the tasks it needs, and starts by itself once they are closed", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  const fix = await julio.as.mutation(api.tasks.create, { teamId, title: "Fix the rate limiter" });
  const review = await julio.as.mutation(api.tasks.create, { teamId, title: "Review the fix", needs: [fix] });
  await julio.as.mutation(api.tasks.queue, { teamId, taskId: review, machineId, harness: "claude-code" });
  await drain(t);
  expect(await starts(t, token)).toEqual([]);
  expect(await julio.as.query(api.tasks.get, { teamId, taskId: review })).toMatchObject({
    needs: [{ taskId: fix, title: "Fix the rate limiter", closed: false }],
    queued: { machine: { name: "build-box" }, harness: "claude-code", via: "terminal" },
    runs: [],
  });

  // The fix's run finishes and its owner keeps it: the review starts.
  const { runId, terminalId } = await julio.as.mutation(api.runs.start, { teamId, taskId: fix, harness: "shell", machineId });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "sh", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, exitCode: 0 });
  await drain(t);
  // Its terminal ended, so the machine has a slot, but the review still waits for the fix to close.
  expect((await julio.as.query(api.tasks.get, { teamId, taskId: review })).runs).toEqual([]);
  await julio.as.mutation(api.tasks.keepRun, { teamId, taskId: fix, runId });
  await drain(t);
  const card = await julio.as.query(api.tasks.get, { teamId, taskId: review });
  expect(card.queued).toBeUndefined();
  expect(card.runs).toEqual([expect.objectContaining({ harness: "claude-code", driver: expect.objectContaining({ name: "Julio" }) })]);
});

test("queued terminals wait for a free slot, oldest first", async () => {
  const { t, teamId, ana, machineId, token } = await room();
  const first = await ana.as.mutation(api.tasks.create, { teamId, title: "First" });
  const second = await ana.as.mutation(api.tasks.create, { teamId, title: "Second" });
  await ana.as.mutation(api.tasks.queue, { teamId, taskId: first, machineId, harness: "codex" });
  await ana.as.mutation(api.tasks.queue, { teamId, taskId: second, machineId, harness: "codex" });
  await drain(t);
  // Ana's terminals use the machine's one slot: only the first starts.
  const [started] = await starts(t, token);
  expect(await starts(t, token)).toHaveLength(1);
  expect((await ana.as.query(api.tasks.get, { teamId, taskId: first })).runs).toHaveLength(1);
  expect((await ana.as.query(api.tasks.get, { teamId, taskId: second })).queued).toBeDefined();

  // Its terminal ends: the slot is free, and the second starts.
  const terminalId = (started as unknown as { terminalId: Id<"terminals"> }).terminalId;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "codex", tool: "codex", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, exitCode: 0 });
  await drain(t);
  expect(await starts(t, token)).toHaveLength(2);
  expect((await ana.as.query(api.tasks.get, { teamId, taskId: second })).queued).toBeUndefined();
});

test("a plan of tasks is created in one call, its needs by key; a plan whose needs loop is refused whole", async () => {
  const { teamId, julio, machineId } = await room();
  const { tasks } = await julio.as.mutation(api.tasks.createMany, {
    teamId,
    tasks: [
      { key: "fix", title: "Fix CVE-123" },
      { key: "review", title: "Review the fix", needs: ["fix"], queue: { machineId, harness: "claude-code" } },
    ],
  });
  expect(tasks).toHaveLength(2);
  const review = await julio.as.query(api.tasks.get, { teamId, taskId: tasks[1]!.taskId });
  expect(review.needs).toEqual([expect.objectContaining({ taskId: tasks[0]!.taskId })]);
  expect(review.queued).toBeDefined();

  const before = (await julio.as.query(api.tasks.board, { teamId })).length;
  await expect(
    julio.as.mutation(api.tasks.createMany, {
      teamId,
      tasks: [
        { key: "a", title: "A", needs: ["b"] },
        { key: "b", title: "B", needs: ["a"] },
      ],
    }),
  ).rejects.toThrow(/already waits for this task/);
  expect(await julio.as.query(api.tasks.board, { teamId })).toHaveLength(before);
});

test("only whoever queued a task, or its owner, can move it in the queue", async () => {
  const { t, teamId, julio, ana, machineId } = await room();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Ana's task", needs: [await ana.as.mutation(api.tasks.create, { teamId, title: "First" })] });
  await ana.as.mutation(api.tasks.queue, { teamId, taskId, machineId, harness: "codex" });
  await expect(ben.as.mutation(api.tasks.queue, { teamId, taskId, machineId, harness: "shell", command: "rm -rf build" })).rejects.toThrow(/Only whoever queued it/);
  await expect(ben.as.mutation(api.tasks.unqueue, { teamId, taskId })).rejects.toThrow(/Only whoever queued/);
  expect((await ana.as.query(api.tasks.get, { teamId, taskId })).queued).toMatchObject({ harness: "codex" });
});
