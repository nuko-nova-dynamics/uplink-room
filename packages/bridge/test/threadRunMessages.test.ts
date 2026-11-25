/**
 * Messages to a run in a T3 Code thread (ADR 0026, ADR 0037, slice 6 of #139). The room says
 * messages wait for a thread's run; the bridge claims them by the thread and sends them into it
 * with `message.dispatch`: added to the turn in progress only where T3 Code says steering doesn't
 * stop a running tool, otherwise at the thread's next turn. Each delivery gives the run a key, and
 * `uplink-bridge say` and `reply` with that key post as the thread's run.
 */
import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_FEATURES, THREAD_ITEM_LIMITS, type BridgeMessage, type RoomMessage, type RunSaid, type RunSay } from "@uplink-room/protocol";
import type { RunDelivery, RunMessageClaim, RunMessageClaimRequest } from "@uplink-room/protocol/runMessages";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { LocalSocket, localRequest } from "../src/localSocket.ts";
import { quoteArgument } from "../src/platform.ts";
import { RunKeys } from "../src/runMessages.ts";
import { socketPathFor } from "../src/platform.ts";
import { T3CodeAdapter } from "../src/adapters/t3code.ts";
import { exchangePairingToken } from "../src/adapters/t3client.ts";
import { FakeT3, PAIRING_TOKEN } from "./tools/fakeT3.ts";

/** A room that takes thread run messages and hands them over at a claim, by the run's ref. */
class Room implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void;
  waiting = new Map<string, RunDelivery[]>();
  claims: RunMessageClaimRequest[] = [];
  said: RunSay[] = [];
  /** When set, a claim is answered only once it settles. */
  gate: Promise<unknown> | undefined;
  private features: readonly string[];
  constructor(features: readonly string[] = ROOM_FEATURES) {
    this.features = features;
  }
  send(message: BridgeMessage) {
    this.messages.push(message);
    return { features: [...this.features] };
  }
  onMessage(handler: (message: RoomMessage) => void) {
    this.handler = handler;
  }
  async claimRunMessages(request: RunMessageClaimRequest): Promise<RunMessageClaim> {
    this.claims.push(request);
    await this.gate;
    const ref = request.threadRef ?? request.terminalRef!;
    const deliveries = this.waiting.get(ref)?.splice(0) ?? [];
    return { claimId: `claim-${this.claims.length}`, deliveries, more: false };
  }
  async say(request: RunSay): Promise<RunSaid> {
    this.said.push(request);
    return { messageId: "msg-new", label: "Codex (Julio)", place: request.replyTo ? "a thread in #payments" : (request.in ?? "") };
  }
  /** A message for the run in `threadRef` waits in the room, and the bridge hears so. */
  post(threadRef: string, delivery: RunDelivery) {
    this.waiting.set(threadRef, [...(this.waiting.get(threadRef) ?? []), delivery]);
    this.handler!({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef } });
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<BridgeMessage, { type: T }> => m.type === type);
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * How each harness's turns steer, as T3 Code's adapters declare them (apps/server
 * orchestration-v2/Adapters, at v0.1.8-nightly.20261105.4234) and #138 test 7 read from its
 * database: Codex steers a turn; Claude Code's steering stops the running tool; Grok can't steer,
 * only interrupt and restart.
 */
const STEERS = { supportsActiveSteering: true, supportsSteeringByInterruptRestart: true, supportsQueuedMessages: true };
const STOPS_TOOLS = { supportsActiveSteering: true, activeSteeringInterruptsTools: true, supportsSteeringByInterruptRestart: false, supportsQueuedMessages: true };
const RESTARTS = { supportsActiveSteering: false, supportsSteeringByInterruptRestart: true, supportsQueuedMessages: true };

/** A thread in the watched project, at work (`busy`) or between turns, run by a provider whose turns steer as `turns` says. */
function thread(fake: FakeT3, id: string, providerInstanceId: string, turns: Record<string, unknown>, busy = true) {
  fake.threads.set(id, { id, projectId: "project-1", title: id, status: busy ? "running" : "completed", activeRunId: busy ? `run-${id}` : null, providerInstanceId });
  fake.projections.set(id, {
    runtimeRequests: [],
    turnItems: [],
    runs: [{ id: `run-${id}`, status: busy ? "running" : "completed", providerThreadId: `pt-${id}`, activeAttemptId: `attempt-${id}` }],
    providerThreads: [{ id: `pt-${id}`, providerSessionId: `ps-${id}` }],
    providerSessions: [{ id: `ps-${id}`, providerInstanceId, updatedAt: "2026-11-05T17:00:00.000Z", capabilities: { turns } }],
    providerTurns: [{ runAttemptId: `attempt-${id}`, status: busy ? "running" : "completed" }],
  });
}

const clock = { at: Date.now(), now() { return this.at; } };

async function setup(script: (fake: FakeT3) => void, options: { features?: readonly string[]; retryMs?: number } = {}) {
  const fake = await new FakeT3().start();
  cleanups.push(() => fake.close());
  fake.providers.push(
    { instanceId: "my_claude", driver: "claudeAgent", enabled: true, installed: true, status: "ready", models: [{ slug: "haiku" }] },
    { instanceId: "my_grok", driver: "grok", enabled: true, installed: true, status: "ready", models: [{ slug: "fast" }] },
  );
  script(fake);
  const session = await exchangePairingToken(fake.url, PAIRING_TOKEN);
  const dir = await mkdtemp(join(tmpdir(), "uplink-thread-runs-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const room = new Room(options.features);
  clock.at = Date.now();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 2, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    adapters: [new T3CodeAdapter({ session, project: "/work/billing", sharedThreads: [...fake.threads.keys()], retryMs: 50 })],
    linkedBy: "julio",
    clock,
    ...(options.retryMs !== undefined ? { threadRetryMs: options.retryMs } : {}),
  });
  cleanups.push(() => bridge.close());
  const socketPath = socketPathFor(dir);
  const socket = new LocalSocket(socketPath, bridge);
  await socket.start();
  cleanups.push(() => socket.close());
  await bridge.start();
  await expect.poll(() => fake.subscribed).toBe(true);
  return { fake, room, bridge, socketPath };
}

function message(deliveryId: string, more: Partial<RunDelivery> = {}): RunDelivery {
  return {
    deliveryId,
    messageId: `msg-${deliveryId}`,
    place: "#payments",
    text: "release the 3D model\nI'm taking over",
    from: { memberId: "ana", name: "Ana", kind: "person" },
    accountable: { memberId: "ana", name: "Ana" },
    fromDriver: false,
    at: 1,
    ...more,
  };
}

const dispatched = (fake: FakeT3, threadId: string) => fake.commands.filter((c) => c.type === "message.dispatch" && c.threadId === threadId);
/** The key a delivery gave the run, from its reply hint. */
const keyIn = (text: unknown) => /--key (urt_[A-Za-z0-9_-]+)/.exec(String(text))?.[1];

test("a message to a Codex thread at work is added to its turn, labelled, with how the run answers and its own key; the room hears it went mid-task", async () => {
  const { fake, room } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const [command] = dispatched(fake, "thread-codex");
  expect(command).toMatchObject({
    commandId: "uplink-room:run-message:claim-1",
    messageId: "uplink-room:run:claim-1",
    dispatchMode: { type: "steer_active", targetRunId: "run-thread-codex" },
  });
  const text = String(command!.text);
  expect(text).toContain("Message msg-d1 in #payments, from Ana, a person. Ana is accountable for it and is not this run's driver.");
  expect(text).toContain("> release the 3D model\n> I'm taking over");
  expect(text).toMatch(/reply --socket \S+ --key urt_[A-Za-z0-9_-]{32} <message id> "text"/);
  expect(text).toMatch(/say --socket \S+ --key urt_[A-Za-z0-9_-]{32} --in "#place" "text"/);
  // The claim kept room for those lines.
  expect(room.claims).toEqual([{ threadRef: "thread-codex", how: "next_turn", reserve: expect.any(Number), maxFiles: 40 }]);
  expect(room.claims[0]!.reserve).toBeGreaterThan(text.slice(text.lastIndexOf("\n\n") + 2).length);
  await expect.poll(() => room.of("run_message_result")).toEqual([
    { v: 1, type: "run_message_result", claimId: "claim-1", deliveryIds: ["d1"], status: "delivered", how: "mid_task" },
  ]);
});

test("a Claude Code or Grok thread at work gets the message at its next turn, and a thread between turns starts one with it", async () => {
  const { fake, room } = await setup((fake) => {
    thread(fake, "thread-claude", "my_claude", STOPS_TOOLS);
    thread(fake, "thread-grok", "my_grok", RESTARTS);
    thread(fake, "thread-idle", "codex_px", STEERS, false);
  });
  room.post("thread-claude", message("d1"));
  room.post("thread-grok", message("d2"));
  room.post("thread-idle", message("d3"));
  await expect.poll(() => fake.commands.filter((c) => c.type === "message.dispatch")).toHaveLength(3);
  expect(dispatched(fake, "thread-claude")[0]).toMatchObject({ dispatchMode: { type: "queue_after_active" } });
  expect(dispatched(fake, "thread-grok")[0]).toMatchObject({ dispatchMode: { type: "queue_after_active" } });
  expect(dispatched(fake, "thread-idle")[0]).toMatchObject({ dispatchMode: { type: "start_immediately" } });
  await expect.poll(() => room.of("run_message_result").map((m) => [m.deliveryIds[0], m.status, m.how]).sort()).toEqual([
    ["d1", "delivered", "next_turn"],
    ["d2", "delivered", "next_turn"],
    ["d3", "delivered", "next_turn"],
  ]);
});

test("the bridge tells the room how each thread hears messages, from what T3 Code says its provider's turns do", async () => {
  const { room } = await setup((fake) => {
    thread(fake, "thread-codex", "codex_px", STEERS, false);
    thread(fake, "thread-claude", "my_claude", STOPS_TOOLS, false);
    thread(fake, "thread-grok", "my_grok", RESTARTS);
  });
  const hearing = (threadRef: string) => room.of("run_hearing").filter((m) => m.source.kind === "thread" && m.source.threadRef === threadRef).map((m) => m.hearing);
  await expect.poll(() => hearing("thread-codex")).toEqual(["mid_task"]);
  await expect.poll(() => hearing("thread-claude")).toEqual(["between_turns"]);
  await expect.poll(() => hearing("thread-grok")).toEqual(["between_turns"]);
});

test("the run posts as its thread with the key a delivery gave it; another thread's id, an unknown key or one an hour past its turn is refused", async () => {
  const { fake, room, socketPath } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const key = keyIn(dispatched(fake, "thread-codex")[0]!.text)!;

  const said = await localRequest(socketPath, { type: "say", key, threadId: "thread-codex", replyTo: "msg-d1", text: "released" });
  expect(said).toEqual({ messageId: "msg-new", label: "Codex (Julio)", place: "a thread in #payments" });
  expect(room.said).toEqual([{ threadRef: "thread-codex", replyTo: "msg-d1", text: "released" }]);
  // T3 Code doesn't give every harness the thread's id (Grok's has none), so the key alone is enough.
  await localRequest(socketPath, { type: "say", key, in: "#payments", text: "build is green" });
  expect(room.said.at(-1)).toEqual({ threadRef: "thread-codex", in: "#payments", text: "build is green" });

  await expect(localRequest(socketPath, { type: "say", key, threadId: "thread-other", in: "#payments", text: "hi" })).rejects.toThrow(/another thread/);
  await expect(localRequest(socketPath, { type: "say", key: "urt_guessed", in: "#payments", text: "hi" })).rejects.toThrow(/isn't a run key/);

  // The key lasts while the thread works, and an hour after its turn ends.
  clock.at += 3 * 60 * 60 * 1000;
  await localRequest(socketPath, { type: "say", key, in: "#payments", text: "still working" });
  fake.update({ ...fake.threads.get("thread-codex")!, status: "completed", activeRunId: null });
  await expect.poll(() => room.of("run_state_changed").at(-1)).toMatchObject({ source: { kind: "thread", threadRef: "thread-codex" }, state: "done" });
  clock.at += 59 * 60 * 1000;
  await localRequest(socketPath, { type: "say", key, in: "#payments", text: "done" });
  clock.at += 2 * 60 * 1000;
  await expect(localRequest(socketPath, { type: "say", key, in: "#payments", text: "late" })).rejects.toThrow(/expired/);
  expect(room.said).toHaveLength(4);
});

test("a key that lapsed stays expired when its thread works again, and no key works 12 hours after it was made", async () => {
  const { fake, room, socketPath } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  const lastState = () => room.of("run_state_changed").at(-1);
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const first = keyIn(dispatched(fake, "thread-codex")[0]!.text)!;
  fake.update({ ...fake.threads.get("thread-codex")!, status: "completed", activeRunId: null });
  await expect.poll(lastState).toMatchObject({ state: "done" });
  // Unused for more than its hour, then the driver starts another turn in T3 Code: no delivery, no new key.
  clock.at += 61 * 60 * 1000;
  fake.update({ ...fake.threads.get("thread-codex")!, status: "running", activeRunId: "run-thread-codex" });
  await expect.poll(lastState).toMatchObject({ state: "working" });
  await expect(localRequest(socketPath, { type: "say", key: first, in: "#payments", text: "back again" })).rejects.toThrow(/expired/);

  // A key made during a turn that never ends still stops 12 hours after it was made.
  room.post("thread-codex", message("d2"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(2);
  const second = keyIn(dispatched(fake, "thread-codex")[1]!.text)!;
  clock.at += 11 * 60 * 60 * 1000;
  await localRequest(socketPath, { type: "say", key: second, in: "#payments", text: "still at it" });
  clock.at += 61 * 60 * 1000;
  await expect(localRequest(socketPath, { type: "say", key: second, in: "#payments", text: "and still" })).rejects.toThrow(/expired/);
  expect(room.said.map((s) => s.text)).toEqual(["still at it"]);
});

test("a thread keeps only its newest 8 keys, and a closed thread's keys stop working at once", async () => {
  const { fake, room, socketPath } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  for (let n = 1; n <= 9; n++) {
    room.post("thread-codex", message(`d${n}`));
    await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(n);
  }
  const keys = dispatched(fake, "thread-codex").map((c) => keyIn(c.text)!);
  await expect(localRequest(socketPath, { type: "say", key: keys[0], in: "#payments", text: "oldest" })).rejects.toThrow(/newer messages replaced it/);
  await localRequest(socketPath, { type: "say", key: keys[1], in: "#payments", text: "second" });
  await localRequest(socketPath, { type: "say", key: keys[8], in: "#payments", text: "newest" });

  // T3 Code deletes the thread: nothing of it stays in the bridge, and its keys post no more.
  fake.remove("thread-codex");
  await expect.poll(() => room.of("thread_closed")).toHaveLength(1);
  await expect(localRequest(socketPath, { type: "say", key: keys[8], in: "#payments", text: "after" })).rejects.toThrow(/isn't a run key/);
  expect(room.said.map((s) => s.text)).toEqual(["second", "newest"]);
});

test("the bridge holds at most 256 keys across all its threads, and drops the oldest first", () => {
  const keys = new RunKeys(() => 0);
  const made = Array.from({ length: 257 }, (_, n) => keys.make(`thread-${n}`));
  expect(keys.check(made[0])).toBe("unknown");
  expect(keys.check(made[1])).toEqual({ threadId: "thread-1" });
  expect(keys.check(made[256])).toEqual({ threadId: "thread-256" });
});

test("a run key never reaches the room: the thread's items that show it carry it hidden", async () => {
  const { fake, room } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const key = keyIn(dispatched(fake, "thread-codex")[0]!.text)!;
  room.handler!({ v: 1, type: "watch_thread", threadRef: "thread-codex" });
  await expect.poll(() => room.of("thread_items").length).toBe(1);
  const item = (n: number, extra: Record<string, unknown>) => ({ id: `item-${n}`, threadId: "thread-codex", runId: "run-thread-codex", ordinal: n, status: "completed", ...extra });
  fake.pushThread("thread-codex", { type: "turn-item.updated", payload: item(1, { type: "user_message", text: String(dispatched(fake, "thread-codex")[0]!.text), messageId: "uplink-room:run:claim-1" }) });
  fake.pushThread("thread-codex", { type: "turn-item.updated", payload: item(2, { type: "command_execution", title: "reply", input: `uplink-bridge reply --key ${key} msg-d1 "released"`, output: "Posted as Codex (Julio)" }) });
  await expect.poll(() => room.of("thread_items").flatMap((m) => m.items).length).toBe(2);
  const sent = JSON.stringify(room.of("thread_items"));
  expect(sent).not.toContain(key);
  expect(sent).toContain("--key urt_[hidden]");
});

test("a key stays hidden when a trim cuts its prefix off, and wherever its secret shows without the prefix", async () => {
  const { fake, room, socketPath } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const key = keyIn(dispatched(fake, "thread-codex")[0]!.text)!;
  const secret = key.slice(4);
  room.handler!({ v: 1, type: "watch_thread", threadRef: "thread-codex" });
  await expect.poll(() => room.of("thread_items").length).toBe(1);
  const item = (n: number, extra: Record<string, unknown>) => ({ id: `item-${n}`, threadId: "thread-codex", runId: "run-thread-codex", ordinal: n, status: "completed", ...extra });
  // The room keeps a tool's last 4,000 characters: this cut falls right after `urt_`.
  const output = `${"a".repeat(10)}${key}${"b".repeat(THREAD_ITEM_LIMITS.output - secret.length)}`;
  fake.pushThread("thread-codex", { type: "turn-item.updated", payload: item(1, { type: "command_execution", title: "env", input: "env", output }) });
  fake.pushThread("thread-codex", { type: "turn-item.updated", payload: item(2, { type: "assistant_message", text: `The key's secret part is ${secret}.` }) });
  // And this one falls inside the secret, so only hiding the key before the trim keeps its last 20 characters out.
  const through = `${"a".repeat(10)}${key}${"c".repeat(THREAD_ITEM_LIMITS.output - 20)}`;
  fake.pushThread("thread-codex", { type: "turn-item.updated", payload: item(3, { type: "command_execution", title: "env", input: "env", output: through }) });
  await expect.poll(() => room.of("thread_items").flatMap((m) => m.items).length).toBe(3);
  const sent = JSON.stringify(room.of("thread_items"));
  expect(sent).not.toContain(secret);
  expect(sent).not.toContain(secret.slice(-20));
  expect(sent).toContain("The key's secret part is [hidden].");

  await localRequest(socketPath, { type: "say", key, in: "#payments", text: `the key ends in ${secret}` });
  expect(room.said.map((s) => s.text)).toEqual(["the key ends in [hidden]"]);
});

test("a run that quotes its own command in what it posts posts the key hidden", async () => {
  const { fake, room, socketPath } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const key = keyIn(dispatched(fake, "thread-codex")[0]!.text)!;
  await localRequest(socketPath, { type: "say", key, replyTo: "msg-d1", text: `I ran uplink-bridge reply --key ${key} msg-d1 and it said the socket was busy` });
  expect(JSON.stringify(room.said)).not.toContain(key.slice(4));
  expect(room.said.map((s) => s.text)).toEqual(["I ran uplink-bridge reply --key urt_[hidden] msg-d1 and it said the socket was busy"]);
});

test("stopping a thread run while its messages are on their way sends nothing into the thread, and they go back to wait", async () => {
  const { fake, room } = await setup((fake) => thread(fake, "thread-idle", "codex_px", STEERS, false));
  const stopped = () => fake.commands.filter((c) => c.type === "thread.stop" && c.threadId === "thread-idle");
  // Stopped while the room's answer to the claim is on its way.
  let answer!: () => void;
  room.gate = new Promise<void>((resolve) => (answer = resolve));
  room.post("thread-idle", message("d1"));
  await expect.poll(() => room.claims).toHaveLength(1);
  room.handler!({ v: 1, type: "stop_thread", threadRef: "thread-idle" });
  await expect.poll(stopped).toHaveLength(1);
  room.gate = undefined;
  answer();
  await expect.poll(() => room.of("run_message_result")).toEqual([
    { v: 1, type: "run_message_result", claimId: "claim-1", deliveryIds: ["d1"], status: "released" },
  ]);

  // Stopped while the bridge reads whether a turn runs, right before it would send.
  let read!: () => void;
  fake.projectionGate = new Promise<void>((resolve) => (read = resolve));
  const reads = fake.projectionReads;
  room.post("thread-idle", message("d2"));
  await expect.poll(() => fake.projectionReads).toBe(reads + 1);
  room.handler!({ v: 1, type: "stop_thread", threadRef: "thread-idle" });
  await expect.poll(stopped).toHaveLength(2);
  fake.projectionGate = undefined;
  read();
  await expect.poll(() => room.of("run_message_result").at(-1)).toEqual({
    v: 1,
    type: "run_message_result",
    claimId: "claim-2",
    deliveryIds: ["d2"],
    status: "released",
  });
  expect(dispatched(fake, "thread-idle")).toEqual([]);
});

test("a bridge whose room doesn't take thread run messages leaves a thread's messages waiting there", async () => {
  const { fake, room } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS), {
    features: ROOM_FEATURES.filter((f) => f !== "thread_run_messages"),
  });
  room.post("thread-codex", message("d1"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(room.claims).toEqual([]);
  expect(dispatched(fake, "thread-codex")).toEqual([]);
});

test("a message T3 Code refuses goes back to wait in the room, and the bridge tries the thread again later", async () => {
  const { fake, room } = await setup((fake) => {
    thread(fake, "thread-codex", "codex_px", STEERS);
    fake.failCommands.add("message.dispatch");
  }, { retryMs: 100 });
  room.post("thread-codex", message("d1"));
  await expect.poll(() => room.of("run_message_result")).toEqual([
    { v: 1, type: "run_message_result", claimId: "claim-1", deliveryIds: ["d1"], status: "released" },
  ]);
  // The room puts it back and says so: the bridge waits before it claims for that thread again.
  room.post("thread-codex", message("d1"));
  expect(room.claims).toHaveLength(1);
  fake.failCommands.delete("message.dispatch");
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  await expect.poll(() => room.of("run_message_result").at(-1)).toMatchObject({ claimId: "claim-2", status: "delivered", how: "mid_task" });
});

function cli(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/bin.ts"), ...args], {
    env: { ...process.env, UPLINK_NO_TELEMETRY: "1", UPLINK_TERMINAL_REF: "", UPLINK_BRIDGE_SOCKET: "", T3CODE_THREAD_ID: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("the commands a delivery names run as given: reply and say with the key, at this bridge's socket, check the thread T3 Code names", async () => {
  const { fake, room, socketPath } = await setup((fake) => thread(fake, "thread-codex", "codex_px", STEERS));
  room.post("thread-codex", message("d1"));
  await expect.poll(() => dispatched(fake, "thread-codex")).toHaveLength(1);
  const text = String(dispatched(fake, "thread-codex")[0]!.text);
  const key = keyIn(text)!;
  // A thread's commands run with T3 Code's environment, so the hint names this bridge's socket.
  expect(text).toContain(`--socket ${quoteArgument(socketPath)}`);

  const replied = await cli(["reply", "--socket", socketPath, "--key", key, "msg-d1", "released", "the model"], { T3CODE_THREAD_ID: "thread-codex" });
  expect(replied).toMatchObject({ code: 0, stdout: "Posted as Codex (Julio) in a thread in #payments (message msg-new).\n" });
  const said = await cli(["say", "--socket", socketPath, "--key", key, "--in", "#payments", "build is green"], {});
  expect(said.code).toBe(0);
  expect(room.said).toEqual([
    { threadRef: "thread-codex", replyTo: "msg-d1", text: "released the model" },
    { threadRef: "thread-codex", in: "#payments", text: "build is green" },
  ]);
  expect((await cli(["reply", "--socket", socketPath, "--key", key, "msg-d1", "hi"], { T3CODE_THREAD_ID: "thread-other" })).stderr).toContain("another thread");
  expect((await cli(["reply", "msg-d1", "hi"], { T3CODE_THREAD_ID: "thread-codex" })).stderr).toContain("--key");
});
