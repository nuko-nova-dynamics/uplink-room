/** Following runs (runs.changes) and reminders a run's driver sets for it (runs.remind). */
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, bridgeSays, callAsAgent, linkMachine, newRoom, newTeam } from "./setup";

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock `ms` ahead and runs what the room scheduled up to then (as tests/invites.test.ts does). */
async function advance(t: ReturnType<typeof newRoom>, ms: number) {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    await realSleep(5);
  }
}

async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  return { t, teamId, julio, general: general!.channelId, machineId, token };
}

test("runs.changes returns the runs you started whose state changed after your cursor, and nothing twice", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  const { key } = await addAgent(t, teamId, julio, "Lead", ["room.read", "runs.start", "terminals.drive"]);
  const start = async () =>
    ((await callAsAgent(t, key, "runs.start", { machineId, harness: "shell", command: "npm test", title: "tests" })).result as { runId: Id<"runs">; terminalId: Id<"terminals"> });
  const a = await start();
  const b = await start();

  const { cursor } = (await callAsAgent(t, key, "runs.changes")).result as { cursor: number };
  expect(((await callAsAgent(t, key, "runs.changes", { after: cursor })).result as { changes: unknown[] }).changes).toEqual([]);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await bridgeSays(t, token, { type: "terminal_ended", terminalId: b.terminalId, exitCode: 1 });
  const page = (await callAsAgent(t, key, "runs.changes", { after: cursor })).result as { changes: { runId: string; state: string }[]; cursor: number };
  expect(page.changes).toEqual([expect.objectContaining({ runId: b.runId, state: "failed" })]);
  expect(((await callAsAgent(t, key, "runs.changes", { after: page.cursor })).result as { changes: unknown[] }).changes).toEqual([]);

  // Named runs: only those, here the one that hasn't changed.
  const named = (await callAsAgent(t, key, "runs.changes", { after: cursor, runIds: [a.runId] })).result as { changes: unknown[] };
  expect(named.changes).toEqual([]);
});

test("a reminder reaches the run's inbox after its delay, and is skipped once the run has ended", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const { t, teamId, julio, general, machineId, token } = await room();
  const { runId, terminalId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude-code", access: "watch" });

  await julio.as.mutation(api.runs.remind, { teamId, runId, channelId: general, text: "check CI on the pull request", inMs: 5 * 60_000 });
  const late = await julio.as.mutation(api.runs.remind, { teamId, runId, channelId: general, text: "check again", inMs: 60 * 60_000 });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toEqual([]);

  await advance(t, 5 * 60_000);
  const inbox = await julio.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox.messages).toEqual([expect.objectContaining({ text: "Reminder: check CI on the pull request", fromDriver: true, status: "waiting" })]);

  await bridgeSays(t, token, { type: "terminal_ended", terminalId, exitCode: 0 });
  await advance(t, 60 * 60_000);
  const skipped = await t.run(async (ctx) => ctx.db.get(late.reminderId));
  expect(skipped).toMatchObject({ status: "skipped", why: "The run had ended." });

});

test("only the run's driver, or an agent of theirs, sets its reminders", async () => {
  const { t, teamId, julio, general, machineId } = await room();
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const ana = await addTeammate(t, teamId, julio, "Ana");
  await expect(ana.as.mutation(api.runs.remind, { teamId, runId, channelId: general, text: "hi", inMs: 60_000 })).rejects.toThrow(/driver/);
  const { key } = await addAgent(t, teamId, julio, "Helper", ["room.read", "messages.post"]);
  expect((await callAsAgent(t, key, "runs.remind", { runId, channelId: general, text: "check CI", inMs: 60_000 })).ok).toBe(true);
});

test("a reminder is skipped once its setter no longer drives the run", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const { t, teamId, julio, general, machineId, token } = await room();
  const ana = await addTeammate(t, teamId, julio, "Ana");
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const { runId, terminalId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId, access: "open" });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude-code", access: "open" });
  const { reminderId } = await julio.as.mutation(api.runs.remind, { teamId, runId, channelId: general, text: "check CI", inMs: 60_000 });
  await julio.as.mutation(api.terminals.passWheel, { teamId, terminalId: terminalId!, to: ana.memberId });
  await advance(t, 60_000);
  expect(await t.run(async (ctx) => ctx.db.get(reminderId))).toMatchObject({ status: "skipped", why: "Whoever set it no longer drives the run." });
});
