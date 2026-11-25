/**
 * A run's permission mode and the files sent to it (ADR 0043): who picks the mode, the machine's cap
 * on it, how a thread's mode reaches its bridge and comes back from T3 Code, the flags a terminal
 * starts with, and files that go into a thread from its box or reach a run with a chat message.
 */
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeInbox, bridgeSays, linkMachine, newRoom, newTeam, type Person, type Room } from "./setup";

const FEATURES = ["thread_driver", "thread_messages", "thread_modes", "thread_attachments", "run_messages", "thread_run_messages", "run_message_files"];

/** Julio's machine, open to teammates, whose bridge takes modes and files; Ana is a teammate. */
async function room(features = FEATURES) {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  await bridgeSays(t, token, { type: "bridge_features", features });
  return { t, teamId, julio, ana, machineId, token };
}

async function startThread(
  t: Room,
  teamId: Id<"teams">,
  who: Person,
  machineId: Id<"machines">,
  token: string,
  runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
) {
  const taskId = await who.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });
  const { runId } = await who.as.mutation(api.runs.start, {
    teamId,
    taskId,
    harness: "codex",
    machineId,
    via: "thread",
    access: "open",
    ...(runtimeMode ? { runtimeMode } : {}),
  });
  const threadRef = `t3-${runId}`;
  await bridgeSays(t, token, { type: "thread_bound", runId, threadRef });
  return { runId: runId as Id<"runs">, threadRef };
}

const sent = async (t: Room, token: string, type: string) => (await bridgeInbox(t, token)).filter((m: any) => m.type === type);

async function attach(t: Room, person: Person, teamId: Id<"teams">, body: string, type: string, name: string) {
  const { uploadId } = await person.as.mutation(api.messages.attachUrl, { teamId });
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([body], { type })));
  return { uploadId, storageId, name };
}

test("a machine allows only approvals required until whoever it belongs to allows more, and only they can", async () => {
  const { t, teamId, julio, ana, machineId, token } = await room();
  expect((await julio.as.query(api.machines.list, { teamId }))[0]).toMatchObject({ mostPermissiveMode: "approval-required" });
  await expect(startThread(t, teamId, julio, machineId, token, "full-access")).rejects.toThrow(/allows at most approval-required/);
  await expect(ana.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" })).rejects.toThrow(
    /belongs to Julio/,
  );
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId } = await startThread(t, teamId, julio, machineId, token, "full-access");
  expect(await sent(t, token, "start_thread")).toMatchObject([{ runId, runtimeMode: "full-access" }]);
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({
    runtimeMode: "full-access",
    runtimeModeSetBy: { name: "Julio" },
    machine: { mostPermissiveMode: "full-access" },
  });
});

test("a thread started without a mode asks for approvals, as before, and an old bridge can't start one in another", async () => {
  const { t, teamId, julio, machineId, token } = await room(["thread_driver", "thread_messages"]);
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId } = await startThread(t, teamId, julio, machineId, token);
  const [start] = await sent(t, token, "start_thread");
  expect(start).not.toHaveProperty("runtimeMode");
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "approval-required", changesMode: false });
  await expect(startThread(t, teamId, julio, machineId, token, "auto")).rejects.toThrow(/too old to start a thread in auto/);
});

test("only the thread's driver changes its mode, within the machine's cap and the modes its provider takes", async () => {
  const { t, teamId, julio, ana, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto" });
  // Ana drives her own thread on Julio's machine: Julio, an admin and the machine's person, doesn't drive it.
  const { runId, threadRef } = await startThread(t, teamId, ana, machineId, token);
  await expect(julio.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "auto" })).rejects.toThrow(/Only the thread's driver/);
  await expect(ana.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "full-access" })).rejects.toThrow(/allows at most auto/);
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "approval-required", modes: ["approval-required", "auto-accept-edits"] });
  await expect(ana.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "auto" })).rejects.toThrow(/provider takes approval-required, auto-accept-edits/);

  await ana.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "auto-accept-edits" });
  expect(await sent(t, token, "set_thread_mode")).toEqual([
    { v: 1, type: "set_thread_mode", threadRef, from: { memberId: ana.memberId, name: "Ana" }, runtimeMode: "auto-accept-edits" },
  ]);
  // It takes effect once T3 Code has it, named for Ana.
  expect(await ana.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "approval-required", runtimeModePending: "auto-accept-edits" });
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "auto-accept-edits", modes: ["approval-required", "auto-accept-edits"] });
  expect(await ana.as.query(api.threads.get, { teamId, runId })).toMatchObject({
    runtimeMode: "auto-accept-edits",
    runtimeModes: ["approval-required", "auto-accept-edits"],
    runtimeModeSetBy: { name: "Ana" },
  });
  // The change is recorded with who made it.
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.filter((a) => a.action === "run.mode_set")).toMatchObject([
    { actorId: ana.memberId, target: runId, details: { from: "approval-required", to: "auto-accept-edits" } },
  ]);
});

test("a mode changed in T3 Code shows in the room without a name, and lowering the cap lowers open threads", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token, "auto");
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "full-access" });
  const changed = await julio.as.query(api.threads.get, { teamId, runId });
  expect(changed).toMatchObject({ runtimeMode: "full-access" });
  expect(changed.runtimeModeSetBy).toBeUndefined();

  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto-accept-edits" });
  expect(await sent(t, token, "set_thread_mode")).toMatchObject([{ threadRef, runtimeMode: "auto-accept-edits", from: { name: "Julio" } }]);
  // Full access until T3 Code has the lower mode: the header never shows less than the agent may do.
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "full-access", runtimeModePending: "auto-accept-edits" });
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "auto-accept-edits" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({
    runtimeMode: "auto-accept-edits",
    runtimeModeLoweredFrom: "full-access",
  });

  // A change still on its way above a lower cap is dropped, and the thread keeps its mode, never raised to the cap.
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  await julio.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "full-access" });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto" });
  const dropped = await julio.as.query(api.threads.get, { teamId, runId });
  expect(dropped).toMatchObject({ runtimeMode: "auto-accept-edits" });
  expect(dropped.runtimeModePending).toBeUndefined();
  expect((await sent(t, token, "set_thread_mode")).at(-1)).toMatchObject({ runtimeMode: "auto-accept-edits" });
});

test("lowering the cap asks for the most permissive mode the provider takes within it, tries lower ones on a refusal, and stops the run once none is left", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token, "full-access");
  const modes = ["approval-required", "auto-accept-edits", "full-access"];
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "full-access", modes });
  const memberId = (await julio.as.query(api.threads.get, { teamId, runId })).driver!.memberId;

  // The provider has no auto: the cap asks for the most it takes under auto.
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto" });
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["auto-accept-edits"]);
  // T3 Code refuses it anyway: the next lower mode is asked for, and the thread isn't left above its cap.
  await bridgeSays(t, token, { type: "input_rejected", terminalId: threadRef, memberId, reason: "mode_failed", runtimeMode: "auto-accept-edits" });
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["auto-accept-edits", "approval-required"]);
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "full-access", runtimeModePending: "approval-required" });
  // Nothing lower is left: the room stops the run, and says why.
  await bridgeSays(t, token, { type: "input_rejected", terminalId: threadRef, memberId, reason: "mode_failed", runtimeMode: "approval-required" });
  const stopped = await julio.as.query(api.threads.get, { teamId, runId });
  expect(stopped).toMatchObject({ runtimeMode: "full-access", runtimeModeOverCap: true });
  expect(stopped.runtimeModePending).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ state: "stopped", stoppedBy: "room" });
  expect(await sent(t, token, "stop_thread")).toEqual([{ v: 1, type: "stop_thread", threadRef }]);
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.filter((a) => a.action === "run.stopped")).toMatchObject([{ target: runId, details: { reason: "mode_cap", cap: "auto" } }]);
});

test("a driver's choice that replaced the cap's lowering still keeps the thread within the cap when T3 Code refuses it", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token, "full-access");
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "full-access", modes: ["approval-required", "auto-accept-edits", "full-access"] });
  const memberId = (await julio.as.query(api.threads.get, { teamId, runId })).driver!.memberId;
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto-accept-edits" });
  // Before T3 Code has the cap's mode, the driver picks one within the cap, and it replaces the cap's request.
  await julio.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "auto-accept-edits" });
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["auto-accept-edits", "auto-accept-edits"]);
  // T3 Code refuses it: the thread is still in full access, past the cap, so the next lower mode is asked for.
  await bridgeSays(t, token, { type: "input_rejected", terminalId: threadRef, memberId, reason: "mode_failed", runtimeMode: "auto-accept-edits" });
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["auto-accept-edits", "auto-accept-edits", "approval-required"]);
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "full-access", runtimeModePending: "approval-required" });
  // Refused too: nothing lower is left, and the room stops the run.
  await bridgeSays(t, token, { type: "input_rejected", terminalId: threadRef, memberId, reason: "mode_failed", runtimeMode: "approval-required" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "full-access", runtimeModeOverCap: true });
  expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ state: "stopped", stoppedBy: "room" });
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.filter((a) => a.action === "run.stopped")).toMatchObject([{ target: runId, details: { reason: "mode_cap", cap: "auto-accept-edits" } }]);
});

test("a thread reported above its machine's cap is lowered at once, and saving the same cap again asks again", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto" });
  const { threadRef } = await startThread(t, teamId, julio, machineId, token, "auto");
  // Someone raised it in T3 Code itself, past the cap: the room asks for the cap's mode.
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "full-access" });
  expect(await sent(t, token, "set_thread_mode")).toMatchObject([{ threadRef, runtimeMode: "auto" }]);
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto" });
  expect(await sent(t, token, "set_thread_mode")).toMatchObject([{ threadRef, runtimeMode: "auto" }, { threadRef, runtimeMode: "auto" }]);
});

test("a driver's raise that reaches T3 Code after the cap rolled it back is lowered again when T3 Code reports it", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "approval-required", modes: ["approval-required", "auto-accept-edits", "full-access"] });
  const memberId = (await julio.as.query(api.threads.get, { teamId, runId })).driver!.memberId;
  await julio.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "full-access" });
  // The owner lowers the cap before T3 Code confirms the raise: the room rolls it back.
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "auto-accept-edits" });
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["full-access", "approval-required"]);
  // The raise had already reached T3 Code, and the rollback is refused.
  await bridgeSays(t, token, { type: "input_rejected", terminalId: threadRef, memberId, reason: "mode_failed", runtimeMode: "approval-required" });
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "full-access" });
  // T3 Code reports full access: the room asks for the most it may have under the cap.
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["full-access", "approval-required", "auto-accept-edits"]);
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "full-access", runtimeModePending: "auto-accept-edits" });
});

test("a mode change waits for T3 Code: the header keeps the mode in effect, a refusal restores it, and the same choice can be tried again", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token, "full-access");
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "full-access" });

  await julio.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "approval-required" });
  // Until the bridge says T3 Code has it, the thread still runs with full access, and the header says so.
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "full-access", runtimeModePending: "approval-required" });
  const memberId = (await julio.as.query(api.threads.get, { teamId, runId })).driver!.memberId;
  await bridgeSays(t, token, { type: "input_rejected", terminalId: threadRef, memberId, reason: "mode_failed", runtimeMode: "approval-required" });
  const refused = await julio.as.query(api.threads.get, { teamId, runId });
  expect(refused).toMatchObject({ runtimeMode: "full-access" });
  expect(refused.runtimeModePending).toBeUndefined();

  // The same choice again reaches the bridge again.
  await julio.as.mutation(api.threads.setMode, { teamId, runId, runtimeMode: "approval-required" });
  expect((await sent(t, token, "set_thread_mode")).map((m: any) => m.runtimeMode)).toEqual(["approval-required", "approval-required"]);
  await bridgeSays(t, token, { type: "thread_mode", threadRef, runtimeMode: "approval-required" });
  expect(await julio.as.query(api.threads.get, { teamId, runId })).toMatchObject({ runtimeMode: "approval-required", runtimeModeSetBy: { name: "Julio" } });
});

test("a Claude Code or Codex terminal starts with its mode's flags, and other terminals start as the machine sets them up", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostPermissiveMode: "full-access" });
  await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId, runtimeMode: "full-access" });
  await julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId, runtimeMode: "auto-accept-edits" });
  await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  expect((await sent(t, token, "start_terminal")).map((m: any) => m.command)).toEqual([
    "claude --permission-mode bypassPermissions",
    "codex -a on-request -s workspace-write",
    "claude",
  ]);
  await expect(julio.as.mutation(api.runs.start, { teamId, harness: "codex", machineId, runtimeMode: "auto" })).rejects.toThrow(
    /codex terminal can start in approval-required, auto-accept-edits, full-access/,
  );
  await expect(julio.as.mutation(api.runs.start, { teamId, harness: "hermes-agent", machineId, runtimeMode: "full-access" })).rejects.toThrow(
    /can't set a permission mode for a hermes-agent terminal/,
  );
});

test("files sent from a thread's box reach its bridge with links, show on the message, and keep their bytes", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token);
  const shot = await attach(t, julio, teamId, "png-bytes", "image/png", "screen.png");
  const log = await attach(t, julio, teamId, "log line", "text/plain", "build.log");
  const { messageId } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "", attachments: [shot, log] });
  const [message] = await sent(t, token, "send_thread_message");
  expect(message).toMatchObject({
    threadRef,
    messageId,
    text: "",
    attachments: [
      { name: "screen.png", kind: "image", mimeType: "image/png", size: 9, url: expect.stringMatching(/^https?:\/\//) },
      { name: "build.log", kind: "file", size: 8 },
    ],
  });
  const listedMessages = await julio.as.query(api.threads.messages, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } });
  expect(listedMessages.page[0]).toMatchObject({ files: [{ name: "screen.png", kind: "image" }, { name: "build.log", kind: "file" }] });
  // Kept, so the hourly sweep of uploads leaves the bytes.
  expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toEqual([]);
  expect(await t.run(async (ctx) => (await ctx.storage.getUrl(shot.storageId)) !== null)).toBe(true);
  // The conversation shows the room's copy of the image on the item T3 Code reports for the message.
  await bridgeSays(t, token, {
    type: "thread_items",
    threadRef,
    reset: true,
    items: [{ itemId: "item-1", order: 1, kind: "message", role: "user", text: "", messageRef: `uplink-room:${messageId}`, attachments: [{ name: "screen.png", kind: "image" }] }],
  });
  const items = await julio.as.query(api.threads.items, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } });
  expect(items.page[0]).toMatchObject({
    roomFiles: [
      { name: "screen.png", kind: "image", url: expect.stringMatching(/^https?:\/\//) },
      { name: "build.log", kind: "file", url: null },
    ],
  });
});

test("a thread's box refuses files to a bridge that can't send them, and more than ten", async () => {
  const { t, teamId, julio, machineId, token } = await room(["thread_driver", "thread_messages"]);
  const { runId } = await startThread(t, teamId, julio, machineId, token);
  const shot = await attach(t, julio, teamId, "png-bytes", "image/png", "screen.png");
  await expect(julio.as.mutation(api.threads.send, { teamId, runId, text: "look", attachments: [shot] })).rejects.toThrow(/too old to send files/);
  await expect(julio.as.mutation(api.threads.send, { teamId, runId, text: "  " })).rejects.toThrow(/needs text or a file/);
});

test("a chat message's files go with it to a run, only to a bridge that gives them to the run", async () => {
  for (const features of [FEATURES, FEATURES.filter((f) => f !== "run_message_files")]) {
    const { t, teamId, julio, ana, machineId, token } = await room(features);
    const threadRef = "thread-codex";
    await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef }, state: "working", title: "Fix billing", harness: "codex" });
    const runId = await t.run(async (ctx) =>
      (await ctx.db.query("runs").withIndex("by_machine_thread", (q) => q.eq("machineId", machineId).eq("threadRef", threadRef)).unique())!._id,
    );
    const [general] = await julio.as.query(api.channels.list, { teamId });
    const shot = await attach(t, ana, teamId, "png-bytes", "image/png", "screen.png");
    await ana.as.mutation(api.messages.post, { teamId, channelId: general!.channelId, body: `<@run:${runId}> see this`, attachments: [shot] });
    const handed = await t.mutation(api.bridge.claimRunMessages, { token, threadRef, how: "next_turn", reserve: 0 });
    if (features.includes("run_message_files"))
      expect(handed.deliveries[0]).toMatchObject({ attachments: 1, files: [{ name: "screen.png", kind: "image", url: expect.any(String) }] });
    else {
      expect(handed.deliveries[0]).toMatchObject({ attachments: 1 });
      expect(handed.deliveries[0]).not.toHaveProperty("files");
    }
  }
});

/** A thread run on Julio's machine, reported by its bridge, and Ana's message to it in #general with `files` files. */
async function threadRunWithMessages(count: number, files: number) {
  const { t, teamId, julio, ana, machineId, token } = await room();
  const threadRef = "thread-codex";
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef }, state: "working", title: "Fix billing", harness: "codex" });
  const runId = await t.run(async (ctx) =>
    (await ctx.db.query("runs").withIndex("by_machine_thread", (q) => q.eq("machineId", machineId).eq("threadRef", threadRef)).unique())!._id,
  );
  const [general] = await julio.as.query(api.channels.list, { teamId });
  for (let m = 0; m < count; m++) {
    const attachments = [];
    for (let f = 0; f < files; f++) attachments.push(await attach(t, ana, teamId, `bytes ${m}-${f}`, "text/plain", `log-${m}-${f}.txt`));
    await ana.as.mutation(api.messages.post, { teamId, channelId: general!.channelId, body: `<@run:${runId}> logs ${m}`, attachments });
  }
  return { t, token, threadRef, runId };
}

test("a claim carries at most the bridge's budget of files, and the messages past it wait for the next claim", async () => {
  const { t, token, threadRef } = await threadRunWithMessages(5, 10);
  // Without a budget, the room's own: as many files as one message into a thread takes (40).
  const first = await t.mutation(api.bridge.claimRunMessages, { token, threadRef, how: "next_turn", reserve: 0 });
  expect(first.deliveries.map((d) => d.files?.length)).toEqual([10, 10, 10, 10]);
  expect(first.more).toBe(true);
  const second = await t.mutation(api.bridge.claimRunMessages, { token, threadRef, how: "next_turn", reserve: 0, maxFiles: 40 });
  expect(second.deliveries.map((d) => d.files?.length)).toEqual([10]);
  // A smaller budget still takes the first message whole, so none waits forever.
  const small = await threadRunWithMessages(2, 10);
  const one = await small.t.mutation(api.bridge.claimRunMessages, { token: small.token, threadRef: small.threadRef, how: "next_turn", reserve: 0, maxFiles: 5 });
  expect(one.deliveries.map((d) => d.files?.length)).toEqual([10]);
  expect(one.more).toBe(true);
});

afterEach(() => {
  vi.useRealTimers();
});

test("a bridge holds a claim while it moves the files, up to a bound, and a claim it lost can't be held again", async () => {
  const { t, token, threadRef, runId } = await threadRunWithMessages(1, 1);
  vi.useFakeTimers();
  const status = async () => (await t.run((ctx) => ctx.db.query("runInbox").withIndex("by_run_status", (q) => q.eq("runId", runId)).collect())).map((r) => r.status);
  const claim = await t.mutation(api.bridge.claimRunMessages, { token, threadRef, how: "next_turn", reserve: 0 });
  const hold = (c: typeof claim) => t.mutation(api.bridge.holdRunMessages, { token, claimId: c.claimId, deliveryIds: c.deliveries.map((d) => d.deliveryId) });
  // Held every minute, the claim outlives its first two minutes.
  for (let minute = 1; minute <= 3; minute++) {
    vi.advanceTimersByTime(60_000);
    expect(await hold(claim)).toEqual({ held: true });
    await t.finishInProgressScheduledFunctions();
  }
  expect(await status()).toEqual(["claimed"]);
  // Not held, it lapses two minutes after the last hold, and the messages wait again.
  vi.advanceTimersByTime(121_000);
  await t.finishInProgressScheduledFunctions();
  expect(await status()).toEqual(["waiting"]);
  expect(await hold(claim)).toEqual({ held: false });

  // However often it's held, a claim ends 15 minutes after it was made.
  const again = await t.mutation(api.bridge.claimRunMessages, { token, threadRef, how: "next_turn", reserve: 0 });
  for (let minute = 1; minute <= 14; minute++) {
    vi.advanceTimersByTime(60_000);
    expect(await hold(again)).toEqual({ held: true });
  }
  vi.advanceTimersByTime(61_000);
  expect(await hold(again)).toEqual({ held: false });
});

test("a thread message the bridge took but never answered for goes again to the bridge that restarts, once, and not to a stopped run", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token);
  const shot = await attach(t, julio, teamId, "png-bytes", "image/png", "screen.png");
  const { messageId: withFiles } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "look", attachments: [shot] });
  const { messageId: answered } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "and this" });
  await bridgeSays(t, token, { type: "thread_message_result", threadRef, messageId: answered, status: "sent" });
  // The bridge took both (its cursor passed them), then stopped while the files moved.
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  const afterSeq = Math.max(...messages.map((m: any) => m.seq));
  const restart = async () => {
    await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: ["t3code"], limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 }, afterSeq });
    await bridgeSays(t, token, { type: "bridge_features", features: FEATURES });
  };
  await restart();
  const again = (await bridgeInbox(t, token, afterSeq)).filter((m: any) => m.type === "send_thread_message");
  expect(again).toEqual([
    expect.objectContaining({ threadRef, messageId: withFiles, text: "look", attachments: [expect.objectContaining({ name: "screen.png", url: expect.stringMatching(/^https?:\/\//) })] }),
  ]);
  // Naming its features again in the same process sends nothing more.
  await bridgeSays(t, token, { type: "bridge_features", features: FEATURES });
  expect((await bridgeInbox(t, token, afterSeq)).filter((m: any) => m.type === "send_thread_message")).toHaveLength(1);
  // Still queued for the next process, it isn't doubled; for a run stopped meanwhile, it fails.
  await restart();
  expect((await bridgeInbox(t, token, afterSeq)).filter((m: any) => m.type === "send_thread_message")).toHaveLength(1);
  await julio.as.mutation(api.runs.stop, { teamId, runId });
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("bridgeOutbox").collect()) if ((row.message as any).type === "send_thread_message") await ctx.db.delete(row._id);
  });
  await restart();
  expect((await bridgeInbox(t, token, afterSeq)).filter((m: any) => m.type === "send_thread_message")).toEqual([]);
  const listed = await julio.as.query(api.threads.messages, { teamId, runId, paginationOpts: { numItems: 10, cursor: null } });
  expect(listed.page.find((m: any) => m.messageId === withFiles)).toMatchObject({ status: "failed", error: "run_stopped" });
});

test("restart replays a consumed thread message before a newer message still queued", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  const { runId } = await startThread(t, teamId, julio, machineId, token);
  const { messageId: first } = await julio.as.mutation(api.threads.send, {
    teamId,
    runId,
    text: "first",
  });
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  const afterSeq = Math.max(...messages.map((m: any) => m.seq));
  const { messageId: second } = await julio.as.mutation(api.threads.send, {
    teamId,
    runId,
    text: "second",
  });
  await bridgeSays(t, token, {
    type: "register_machine",
    hostname: "julio-mbp.local",
    os: "darwin",
    bridgeVersion: "0.1.0",
    tools: ["t3code"],
    limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 },
    afterSeq,
  });
  await bridgeSays(t, token, { type: "bridge_features", features: FEATURES });
  const replay = (await bridgeInbox(t, token, afterSeq)).filter(
    (m: any) => m.type === "send_thread_message",
  );
  expect(replay.map((m: any) => m.messageId)).toEqual([first, second]);
});

test("restart preserves follow-ups to a thread interrupted in T3 Code", async () => {
  const { t, teamId, julio, machineId, token } = await room();
  const { runId, threadRef } = await startThread(t, teamId, julio, machineId, token);
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef }, state: "stopped", title: "Fix billing", harness: "codex" });
  expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ state: "stopped", stoppedBy: "bridge" });
  const { messageId } = await julio.as.mutation(api.threads.send, { teamId, runId, text: "continue" });
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: ["t3code"], limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 } });
  await bridgeSays(t, token, { type: "bridge_features", features: FEATURES });
  expect((await sent(t, token, "send_thread_message")).map((m: any) => m.messageId)).toEqual([messageId]);
  expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({ status: "sending" });
});
