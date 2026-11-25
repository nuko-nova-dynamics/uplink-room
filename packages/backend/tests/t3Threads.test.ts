/**
 * T3 Code threads as places teammates work in (ADR 0021): access and the wheel, the bridge's
 * features and the machine's T3 Code pairing.
 */
import { expect, test, vi } from "vitest";
import { ROOM_FEATURES } from "@uplink-room/protocol";
import { api } from "../convex/_generated/api";
import { channelOfId } from "../convex/lib/members";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeInbox, bridgeSays, linkMachine, newRoom, newTeam, type Person, type Room } from "./setup";

async function teamWithMachine() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  // A personal machine starts at Suggest; let its threads go up to Open.
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  return { t, teamId, julio, ana, machineId, token };
}

/** A thread run started by `who`, bound to a T3 Code thread id. */
async function threadRun(
  t: Room,
  teamId: Id<"teams">,
  who: Person,
  machineId: Id<"machines">,
  token: string,
  access?: "watch" | "suggest" | "drive" | "open",
) {
  const taskId = await who.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });
  const { runId } = await who.as.mutation(api.runs.start, {
    teamId,
    taskId,
    harness: "codex",
    machineId,
    via: "thread",
    ...(access ? { access } : {}),
  });
  const threadRef = `t3-${runId}`;
  await bridgeSays(t, token, { type: "thread_bound", runId, threadRef });
  return { runId: runId as Id<"runs">, threadRef };
}

const sent = async (t: Room, token: string, type: string) =>
  (await bridgeInbox(t, token)).filter((m: any) => m.type === type);

test("a thread run takes its access when it starts, up to the machine's limit, and the bridge hears it", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId } = await threadRun(t, teamId, julio, machineId, token, "drive");
  expect(await sent(t, token, "start_thread")).toMatchObject([{ access: "drive" }]);
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({
    access: "drive",
    startedBy: { name: "Julio" },
    driver: { name: "Julio" },
  });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "suggest" });
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Another" });
  await expect(
    julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", access: "open" }),
  ).rejects.toThrow(/at most suggest/);
});

test("only whoever started a thread opens up its access, and whoever the machine belongs to can lower it", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  // Ana's thread on Julio's machine.
  const { runId, threadRef } = await threadRun(t, teamId, ana, machineId, token, "suggest");
  await ana.as.mutation(api.threads.setAccess, { teamId, runId, access: "open" });
  expect((await sent(t, token, "change_thread_access")).at(-1)).toMatchObject({ threadRef, access: "open" });
  await julio.as.mutation(api.threads.setAccess, { teamId, runId, access: "watch" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ access: "watch" });
  await expect(julio.as.mutation(api.threads.setAccess, { teamId, runId, access: "drive" })).rejects.toThrow(
    /Only whoever started this thread/,
  );
});

test("a thread's wheel passes only through a bridge that takes thread drivers, and answers then go as the new driver", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "open");
  // A bridge from before ADR 0021 would keep Julio as the driver and refuse Ana's answers.
  await expect(ana.as.mutation(api.threads.takeWheel, { teamId, runId })).rejects.toThrow(/too old/);

  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  await ana.as.mutation(api.threads.takeWheel, { teamId, runId });
  // With who started the thread, for a bridge that saved its threads before ADR 0021.
  expect((await sent(t, token, "thread_driver_changed")).at(-1)).toMatchObject({
    threadRef,
    driver: { name: "Ana" },
    starterId: (await t.run((ctx) => ctx.db.get(runId)))!.startedBy,
  });
  expect(await ana.as.query(api.runs.get, { teamId, runId })).toMatchObject({ driver: { name: "Ana" } });

  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "thread", threadRef },
    state: "waiting",
    prompt: { kind: "approval", text: "Run tests?", action: "pnpm test", promptId: "p1" },
  });
  await ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow", promptId: "p1" });
  expect((await sent(t, token, "answer_prompt")).at(-1)).toMatchObject({ from: { name: "Ana" }, promptId: "p1" });
});

test("on Drive teammates ask for the wheel, and dropping below Drive cancels what they asked", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  const { runId } = await threadRun(t, teamId, julio, machineId, token, "drive");
  await expect(ana.as.mutation(api.threads.takeWheel, { teamId, runId })).rejects.toThrow(/ask the driver/);
  const requestId = await ana.as.mutation(api.threads.requestWheel, { teamId, runId });
  expect(await julio.as.query(api.threads.wheelRequests, { teamId, runId })).toMatchObject([{ requestId, from: { name: "Ana" } }]);

  await julio.as.mutation(api.threads.setAccess, { teamId, runId, access: "suggest" });
  expect(await julio.as.query(api.threads.wheelRequests, { teamId, runId })).toEqual([]);
  await expect(julio.as.mutation(api.threads.answerWheelRequest, { teamId, requestId, grant: true })).rejects.toThrow(
    /already answered/,
  );
  // Below Drive the wheel only goes back to whoever started the thread.
  await expect(julio.as.mutation(api.threads.passWheel, { teamId, runId, to: ana.memberId as Id<"members"> })).rejects.toThrow(
    /set to suggest/,
  );
});

test("lowering a machine's most open access lowers its threads above it, and a bridge's clamp never raises one", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "open");
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "drive" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ access: "drive", loweredFrom: "open" });
  expect((await sent(t, token, "change_thread_access")).at(-1)).toMatchObject({ threadRef, access: "drive" });

  await bridgeSays(t, token, { type: "thread_access", threadRef, access: "suggest" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ access: "suggest" });
  await bridgeSays(t, token, { type: "thread_access", threadRef, access: "open" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ access: "suggest" });
});

test("a bridge that comes back with a lower limit of its own lowers the machine's threads above it", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "open");
  // Lowered in bridge.json while the bridge was stopped: it clamps its own copy without saying so.
  await bridgeSays(t, token, {
    type: "register_machine",
    hostname: "julio-mbp.local",
    os: "darwin",
    bridgeVersion: "0.1.0",
    tools: ["t3code"],
    limits: { mostOpenAccess: "drive", slots: 2, longestProfileMs: 1000 },
  });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ access: "drive", loweredFrom: "open" });
  expect((await sent(t, token, "change_thread_access")).at(-1)).toMatchObject({ threadRef, access: "drive" });
});

test("a wheel request follows its thread to the private channel it came from, so its audit entries stay there", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  const { runId } = await threadRun(t, teamId, julio, machineId, token, "drive");
  const channelId = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "#Launch", memberIds: [ana.memberId] });
  await t.run((ctx) => ctx.db.patch(runId, { directChannelId: channelId }));
  const requestId = await ana.as.mutation(api.threads.requestWheel, { teamId, runId });
  expect(await t.run((ctx) => channelOfId(ctx, requestId))).toBe(channelId);
});

test("a wheel request from someone who left the thread's private channel can't be granted", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  const { runId } = await threadRun(t, teamId, julio, machineId, token, "drive");
  const channelId = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "#Launch", memberIds: [ana.memberId] });
  await t.run((ctx) => ctx.db.patch(runId, { directChannelId: channelId }));
  const requestId = await ana.as.mutation(api.threads.requestWheel, { teamId, runId });
  const driver = (await t.run((ctx) => ctx.db.get(runId)))?.driverId;
  await ana.as.mutation(api.channels.leave, { teamId, channelId });
  await expect(julio.as.mutation(api.threads.answerWheelRequest, { teamId, requestId, grant: true })).rejects.toThrow(/no longer in the channel/);
  expect((await t.run((ctx) => ctx.db.get(runId)))?.driverId).toBe(driver);
});

test("the room names what it takes, keeps the bridge's T3 Code pairing, and forgets both when a bridge registers again", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const reply = await t.mutation(api.bridge.send, { token, messages: [] });
  expect(reply).toEqual({ features: [...ROOM_FEATURES] });

  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver"] });
  await bridgeSays(t, token, {
    type: "t3_status",
    state: "needs_pairing",
    reason: "expired",
    expiresAt: 1_790_000_000_000,
    environmentId: "env-1",
  });
  const listed = (await julio.as.query(api.machines.list, { teamId })).find((m) => m.machineId === machineId)!;
  expect(listed.t3).toEqual({ state: "needs_pairing", reason: "expired", expiresAt: 1_790_000_000_000 });

  await bridgeSays(t, token, {
    type: "register_machine",
    hostname: "julio-mbp.local",
    os: "darwin",
    bridgeVersion: "0.1.0",
    tools: ["t3code"],
    limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 },
  });
  const again = (await julio.as.query(api.machines.list, { teamId })).find((m) => m.machineId === machineId)!;
  expect(again.t3).toBeUndefined();
  const machine = await t.run((ctx) => ctx.db.get(machineId));
  expect(machine?.bridgeFeatures).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The thread's conversation (ADR 0022)
// ---------------------------------------------------------------------------

const item = (n: number, extra: Record<string, unknown> = {}) => ({ itemId: `i${String(n).padStart(4, "0")}`, order: n, kind: "message", role: "assistant", text: `Answer ${n}`, ...extra });
const page = (p: Person, teamId: Id<"teams">, runId: Id<"runs">, numItems = 100) =>
  p.as.query(api.threads.items, { teamId, runId, paginationOpts: { numItems, cursor: null } });

test("the bridge follows a thread while someone has it open, once however many watch, and stops when the last goes", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
    const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "watch");
    // A bridge from before ADR 0022 can't follow it: nothing is asked of it.
    await julio.as.mutation(api.threads.watch, { teamId, runId });
    expect(await sent(t, token, "watch_thread")).toEqual([]);

    await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_view"] });
    for (let i = 0; i < 3; i++) {
      await julio.as.mutation(api.threads.watch, { teamId, runId });
      await ana.as.mutation(api.threads.watch, { teamId, runId });
      vi.advanceTimersByTime(15_000);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await sent(t, token, "watch_thread")).toMatchObject([{ threadRef }]);
    expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ watching: [{ name: "Julio" }, { name: "Ana" }], showsConversation: true });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await sent(t, token, "unwatch_thread")).toMatchObject([{ threadRef }]);
    // Opened again: asked again.
    await ana.as.mutation(api.threads.watch, { teamId, runId });
    expect(await sent(t, token, "watch_thread")).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("the room keeps a thread's newest 300 items, a first batch drops what T3 Code no longer has, and removed items go", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: false, items: [item(1), item(2), item(3)] });
  // Item 2 is gone from T3 Code (its turn was rolled back) when the bridge follows the thread again.
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: false, items: [item(1, { text: "Edited" }), item(3)] });
  expect((await page(julio, teamId, runId)).page.map((i) => [i.itemId, i.text])).toEqual([["i0003", "Answer 3"], ["i0001", "Edited"]]);

  for (let start = 4; start < 404; start += 50) {
    await bridgeSays(t, token, { type: "thread_items", threadRef, items: Array.from({ length: 50 }, (_, i) => item(start + i)) });
  }
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [], removed: ["i0403"] });
  const kept = await t.run((ctx) => ctx.db.query("threadItems").withIndex("by_run_order", (q) => q.eq("runId", runId)).collect());
  // The newest 300 (i0104 to i0403), less the one removed.
  expect(kept).toHaveLength(299);
  expect([kept[0]!.itemId, kept.at(-1)!.itemId]).toEqual(["i0104", "i0402"]);
  // T3 Code still has the dropped ones.
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ older: true });
  // Long text is cut again by the room, whatever the bridge sent.
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [item(500, { text: "x".repeat(20_000) })] });
  expect((await page(julio, teamId, runId, 1)).page[0]).toMatchObject({ itemId: "i0500", cut: true });
  expect((await page(julio, teamId, runId, 1)).page[0]!.text).toHaveLength(16_000);
});

test("older items load from the bridge before the oldest the room keeps, and go after 30 minutes", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00Z") });
  try {
    const { t, teamId, julio, machineId, token } = await teamWithMachine();
    await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_view"] });
    const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
    await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: [item(60), item(61)] });
    await julio.as.mutation(api.threads.loadOlder, { teamId, runId });
    const [ask] = await sent(t, token, "thread_history");
    expect(ask).toMatchObject({ threadRef, beforeItemId: "i0060" });
    expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ history: { status: "loading" } });

    await bridgeSays(t, token, { type: "thread_history_page", threadRef, requestId: (ask as any).requestId, older: false, items: [item(58), item(59)] });
    expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual(["i0061", "i0060", "i0059", "i0058"]);
    const after = await julio.as.query(api.threads.get, { teamId, runId });
    expect(after.older).toBe(false);
    expect(after.history).toBeUndefined();

    // A second page 20 minutes later keeps both 30 minutes from then: the first page alone going
    // would leave a gap before the second that nobody could load again.
    vi.advanceTimersByTime(20 * 60 * 1000);
    await t.run((ctx) => ctx.db.patch(runId, { threadOlder: true }));
    await julio.as.mutation(api.threads.loadOlder, { teamId, runId });
    const [, again] = await sent(t, token, "thread_history");
    expect(again).toMatchObject({ beforeItemId: "i0058" });
    await bridgeSays(t, token, { type: "thread_history_page", threadRef, requestId: (again as any).requestId, older: false, items: [item(57)] });
    // 31 minutes after the first page: its job finds the time moved on.
    vi.advanceTimersByTime(11 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual(["i0061", "i0060", "i0059", "i0058", "i0057"]);

    vi.advanceTimersByTime(20 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual(["i0061", "i0060"]);
    // T3 Code still has them, so "Show earlier messages" can fetch them again.
    expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ older: true });
  } finally {
    vi.useRealTimers();
  }
});

test("while older items are loaded, what leaves the newest 300 stays with them, so no gap opens between", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_view"] });
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: Array.from({ length: 300 }, (_, i) => item(51 + i)) });
  await julio.as.mutation(api.threads.loadOlder, { teamId, runId });
  const [ask] = await sent(t, token, "thread_history");
  await bridgeSays(t, token, { type: "thread_history_page", threadRef, requestId: (ask as any).requestId, older: false, items: Array.from({ length: 50 }, (_, i) => item(1 + i)) });
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [item(351)] });
  const ids = (await t.run((ctx) => ctx.db.query("threadItems").withIndex("by_run_order", (q) => q.eq("runId", runId)).collect())).map((r) => r.itemId);
  expect(ids).toHaveLength(351);
  expect(ids).toContain("i0051");
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ older: false });
});

test("an update to an item older than the room's window waits for its page, so no lone row opens a gap", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: Array.from({ length: 150 }, (_, i) => item(51 + i)) });
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [item(10, { text: "Done" }), item(201)] });
  const ids = (await t.run((ctx) => ctx.db.query("threadItems").withIndex("by_run_order", (q) => q.eq("runId", runId)).collect())).map((r) => r.itemId);
  expect([ids[0], ids.at(-1), ids.length]).toEqual(["i0051", "i0201", 151]);
});

test("a history page asked for before the thread was followed again is refused when it comes", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_view"] });
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: [item(51), item(52)] });
  await julio.as.mutation(api.threads.loadOlder, { teamId, runId });
  const [ask] = await sent(t, token, "thread_history");
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: [item(799), item(800)] });
  await bridgeSays(t, token, { type: "thread_history_page", threadRef, requestId: (ask as any).requestId, older: false, items: [item(49), item(50)] });
  expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual(["i0800", "i0799"]);
});

test("a thread followed again replaces what the room kept, history loaded earlier included, so no gap or undone turn stays", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_view"] });
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: [item(60), item(61)] });
  await julio.as.mutation(api.threads.loadOlder, { teamId, runId });
  const [ask] = await sent(t, token, "thread_history");
  await bridgeSays(t, token, { type: "thread_history_page", threadRef, requestId: (ask as any).requestId, older: true, items: [item(58), item(59)] });

  // Nobody followed it while it moved on to item 800 and item 59's turn was rolled back.
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: [item(799), item(800)] });
  expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual(["i0800", "i0799"]);
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ older: true });
});

test("T3 Code's item ids are kept whole, however long, so two that share a beginning stay two", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  // An approval's id from a real T3 Code runs to about 300 characters.
  const long = (n: number) => `runtime-request:${"x".repeat(260)}:${n}`;
  await bridgeSays(t, token, {
    type: "thread_items",
    threadRef,
    reset: true,
    older: false,
    items: [item(1, { itemId: long(1) }), item(2, { itemId: long(2) }), item(3, { itemId: "y".repeat(1001) })],
  });
  expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual([long(2), long(1)]);
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [], removed: [long(1)] });
  expect((await page(julio, teamId, runId)).page.map((i) => i.itemId)).toEqual([long(2)]);
});

test("the task's owner answers a thread's approvals as in the Inbox, though someone else drives it", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread" });
  await bridgeSays(t, token, { type: "thread_bound", runId, threadRef: `t3-${runId}` });
  expect(await ana.as.query(api.threads.get, { teamId, runId: runId as Id<"runs"> })).toMatchObject({ answersApprovals: true });
  expect(await ben.as.query(api.threads.get, { teamId, runId: runId as Id<"runs"> })).toMatchObject({ answersApprovals: false });
});

test("a turn's diff is fetched once from the bridge and shared, and the thread's T3 Code link names its server", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "thread_view"] });
  await bridgeSays(t, token, { type: "t3_status", state: "connected", environmentId: "d67cf93e-fb75-4ceb-b17c-9a1a733b6787" });
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await julio.as.mutation(api.threads.requestDiff, { teamId, runId, turn: 2 });
  await ana.as.mutation(api.threads.requestDiff, { teamId, runId, turn: 2 });
  const asks = await sent(t, token, "thread_diff_request");
  expect(asks).toMatchObject([{ threadRef, turn: 2 }]);
  expect(await ana.as.query(api.threads.diff, { teamId, runId, turn: 2 })).toMatchObject({ status: "loading" });
  await bridgeSays(t, token, { type: "thread_diff", threadRef, requestId: (asks[0] as any).requestId, diff: "diff --git a/x b/x\n+1\n" });
  expect(await ana.as.query(api.threads.diff, { teamId, runId, turn: 2 })).toMatchObject({ status: "ready", diff: "diff --git a/x b/x\n+1\n" });

  expect((await julio.as.query(api.threads.get, { teamId, runId })).t3Link).toBe(
    `https://app.t3.codes/threads/d67cf93e-fb75-4ceb-b17c-9a1a733b6787/${threadRef}`,
  );
});

// ---------------------------------------------------------------------------
// The message box and questions (ADR 0023)
// ---------------------------------------------------------------------------

const ALL = ["thread_driver", "thread_view", "thread_messages", "thread_questions"];

test("only a thread's driver sends it a message, through a bridge that takes them, and the room records who sent it and how it went", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "open");
  await expect(julio.as.mutation(api.threads.send, { teamId, runId, text: "Add the station name" })).rejects.toThrow(/too old/);
  await bridgeSays(t, token, { type: "bridge_features", features: ALL });
  await expect(ana.as.mutation(api.threads.send, { teamId, runId, text: "Add the station name" })).rejects.toThrow(/Only the thread's driver/);
  const { messageId } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "  Add the station name  " });
  expect((await sent(t, token, "send_thread_message")).at(-1)).toMatchObject({ threadRef, messageId, from: { name: "Julio" }, text: "Add the station name" });
  const log = () => ana.as.query(api.threads.messages, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } });
  expect((await log()).page).toMatchObject([{ messageId, messageRef: `uplink-room:${messageId}`, status: "sending", by: { name: "Julio" } }]);
  await bridgeSays(t, token, { type: "thread_message_result", threadRef, messageId, status: "queued" });
  expect((await log()).page[0]).toMatchObject({ status: "queued" });
  await julio.as.mutation(api.threads.interrupt, { teamId, runId });
  expect((await sent(t, token, "interrupt_thread")).at(-1)).toMatchObject({ threadRef, from: { name: "Julio" } });
  const activity = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["thread.message_sent", "thread.interrupted"]));
});

test("a message queued behind a turn shows as sent once T3 Code runs it, and the conversation names who sent it", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "open");
  await bridgeSays(t, token, { type: "bridge_features", features: ALL });
  const { messageId } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "Add the station name" });
  await bridgeSays(t, token, { type: "thread_message_result", threadRef, messageId, status: "queued" });
  const log = async () => (await ana.as.query(api.threads.messages, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } })).page[0];
  // T3 Code shows a queued message as pending, then completed when its own turn starts.
  const message = (status: string) => item(5, { role: "user", messageRef: `uplink-room:${messageId}`, status, text: "Add the station name" });
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [message("pending")] });
  expect(await log()).toMatchObject({ status: "queued" });
  await bridgeSays(t, token, { type: "thread_items", threadRef, items: [message("completed")] });
  expect(await log()).toMatchObject({ status: "sent" });
  // Every page of the conversation names who sent it, however old the message.
  expect((await page(ana, teamId, runId)).page[0]).toMatchObject({ itemId: "i0005", sentBy: { name: "Julio" } });
});

test("a queued message whose turn ran before the room's window shows as sent once its page is loaded", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token, "open");
  await bridgeSays(t, token, { type: "bridge_features", features: ALL });
  const { messageId } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "Add the station name" });
  await bridgeSays(t, token, { type: "thread_message_result", threadRef, messageId, status: "queued" });
  await bridgeSays(t, token, { type: "thread_items", threadRef, reset: true, older: true, items: [item(60), item(61)] });
  await julio.as.mutation(api.threads.loadOlder, { teamId, runId });
  const [ask] = await sent(t, token, "thread_history");
  const done = item(5, { role: "user", messageRef: `uplink-room:${messageId}`, status: "completed", text: "Add the station name" });
  await bridgeSays(t, token, { type: "thread_history_page", threadRef, requestId: (ask as any).requestId, older: false, items: [done] });
  const log = await julio.as.query(api.threads.messages, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } });
  expect(log.page[0]).toMatchObject({ status: "sent" });
});

test("teammates propose messages on a Suggest thread, the driver sends one edited, and going back to Watch drops the rest", async () => {
  const { t, teamId, julio, ana, machineId, token } = await teamWithMachine();
  await bridgeSays(t, token, { type: "bridge_features", features: ALL });
  const { runId } = await threadRun(t, teamId, julio, machineId, token, "watch");
  await expect(ana.as.mutation(api.threads.suggest, { teamId, runId, text: "Use the station id" })).rejects.toThrow(/set to watch/);
  await julio.as.mutation(api.threads.setAccess, { teamId, runId, access: "suggest" });
  const first = await ana.as.mutation(api.threads.suggest, { teamId, runId, text: "Use the station id" });
  await ana.as.mutation(api.threads.suggest, { teamId, runId, text: "Leave it empty" });
  await julio.as.mutation(api.threads.sendSuggestion, { teamId, suggestionId: first, text: "Use the station id when there's no name" });
  expect((await sent(t, token, "send_thread_message")).at(-1)).toMatchObject({ text: "Use the station id when there's no name" });
  const log = await julio.as.query(api.threads.messages, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } });
  expect(log.page[0]).toMatchObject({ by: { name: "Julio" }, suggestedBy: { name: "Ana" } });
  await julio.as.mutation(api.threads.setAccess, { teamId, runId, access: "watch" });
  expect(await julio.as.query(api.threads.suggestions, { teamId, runId })).toEqual([]);
});

test("a thread's question is answered from the room as its driver's, with every question answered and options kept to", async () => {
  const { t, teamId, julio, machineId, token } = await teamWithMachine();
  const { runId, threadRef } = await threadRun(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "thread", threadRef },
    state: "waiting",
    prompt: {
      kind: "question",
      text: "Which rounding? (Half up / Banker's)",
      promptId: "q1",
      questions: [
        { id: "rounding", header: "Rounding", question: "Which rounding?", options: [{ label: "Half up" }, { label: "Banker's" }] },
        { id: "note", header: "Note", question: "Anything else?", options: [], allowCustomAnswer: true },
      ],
    },
  });
  const answer = (answers: Record<string, string | string[]>, promptId = "q1") => julio.as.mutation(api.inbox.answerQuestion, { teamId, runId, promptId, answers });
  await expect(answer({ rounding: "Half up", note: "no" })).rejects.toThrow(/too old/);
  await bridgeSays(t, token, { type: "bridge_features", features: ALL });
  await expect(answer({ rounding: "Half up" })).rejects.toThrow(/Answer every question: Note/);
  await expect(answer({ rounding: "Round down", note: "no" })).rejects.toThrow(/takes one of its options/);
  await expect(answer({ rounding: "Half up", note: "no" }, "q0")).rejects.toThrow(/isn't the question/);
  await answer({ rounding: "Half up", note: "Keep two decimals" });
  expect((await sent(t, token, "answer_question")).at(-1)).toMatchObject({
    threadRef,
    promptId: "q1",
    from: { name: "Julio" },
    answers: { rounding: "Half up", note: "Keep two decimals" },
  });
  expect(await julio.as.query(api.runs.get, { teamId, runId })).toMatchObject({ questionAnswer: { promptId: "q1", by: { name: "Julio" } } });
});
