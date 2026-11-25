/**
 * A T3 Code thread's permission mode and the files sent into it (ADR 0043): the mode a thread starts
 * in and a driver's change reach T3 Code, T3 Code's own mode comes back to the room, and files from
 * the thread's box or with a run's messages go in as T3 Code attachments, uploaded first.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_FEATURES, type BridgeMessage, type RoomMessage } from "@uplink-room/protocol";
import type { RunDelivery, RunMessageClaim, RunMessageClaimRequest } from "@uplink-room/protocol/runMessages";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { T3CodeAdapter } from "../src/adapters/t3code.ts";
import { exchangePairingToken } from "../src/adapters/t3client.ts";
import { FakeT3, PAIRING_TOKEN } from "./tools/fakeT3.ts";
import { FileServer } from "./tools/fileServer.ts";

class Room implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void | Promise<void>;
  waiting = new Map<string, RunDelivery[]>();
  /** Each claim the bridge asked for. */
  claims: RunMessageClaimRequest[] = [];
  /** How `bridge:holdRunMessages` answers, if this room has it. */
  hold?: () => boolean;
  holds = 0;
  private features: readonly string[];
  constructor(features: readonly string[] = ROOM_FEATURES) {
    this.features = features;
  }
  send(message: BridgeMessage) {
    this.messages.push(message);
    return { features: [...this.features] };
  }
  onMessage(handler: (message: RoomMessage) => void | Promise<void>) {
    this.handler = handler;
  }
  async claimRunMessages(request: RunMessageClaimRequest): Promise<RunMessageClaim> {
    this.claims.push(request);
    const deliveries = this.waiting.get(request.threadRef ?? "")?.splice(0) ?? [];
    return { claimId: "claim-1", deliveries, more: false };
  }
  holdRunMessages?: (request: { claimId: string; deliveryIds: string[] }) => Promise<{ held: boolean }> = async () => {
    this.holds++;
    return { held: this.hold?.() ?? false };
  };
  deliver(message: RoomMessage) {
    this.handler!(message);
  }
  private queue: Promise<unknown> = Promise.resolve();
  /** As `ConvexLink` hands commands over: each only once the bridge is done with the one before. */
  deliverInOrder(message: RoomMessage) {
    this.queue = this.queue.then(() => this.handler!(message));
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<BridgeMessage, { type: T }> => m.type === type);
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const julio = { memberId: "julio", name: "Julio" };
const ana = { memberId: "ana", name: "Ana" };

async function setup(script: (fake: FakeT3) => void = () => {}, { features, ...options }: { claimMs?: number; features?: readonly string[] } = {}) {
  const fake = await new FakeT3().start();
  cleanups.push(() => fake.close());
  fake.providers[0]!.supportedRuntimeModes = ["approval-required", "auto-accept-edits", "full-access"];
  script(fake);
  const files = await FileServer.start();
  cleanups.push(() => files.close());
  const session = await exchangePairingToken(fake.url, PAIRING_TOKEN);
  const dir = await mkdtemp(join(tmpdir(), "uplink-thread-modes-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const room = new Room(features);
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    adapters: [new T3CodeAdapter({ session, project: "/work/billing", sharedThreads: ["thread-a", "thread-b"], retryMs: 50 })],
    linkedBy: julio.memberId,
    ...options,
  });
  cleanups.push(() => bridge.close());
  await bridge.start();
  await expect.poll(() => fake.subscribed).toBe(true);
  return { fake, room, files };
}

const idle = (fake: FakeT3, mode = "approval-required") =>
  fake.threads.set("thread-a", { id: "thread-a", projectId: "project-1", title: "Fix totals", status: "completed", activeRunId: null, runtimeMode: mode });

test("a thread starts in the mode the room asked for, and one its provider doesn't take fails to start", async () => {
  const { fake, room } = await setup();
  room.deliver({ v: 1, type: "start_thread", runId: "run-1", harness: "codex", startedBy: julio, runtimeMode: "full-access" });
  await expect.poll(() => fake.launches).toHaveLength(1);
  expect(fake.launches[0]).toMatchObject({ runtimeMode: "full-access" });
  // The launched thread reports its mode, with the modes its provider takes.
  await expect.poll(() => room.of("thread_mode")).toEqual([
    { v: 1, type: "thread_mode", threadRef: "uplink-room-run-1", runtimeMode: "full-access", modes: ["approval-required", "auto-accept-edits", "full-access"] },
  ]);
  room.deliver({ v: 1, type: "start_thread", runId: "run-2", harness: "codex", startedBy: julio, runtimeMode: "auto" });
  await expect.poll(() => room.of("thread_start_failed")).toMatchObject([{ runId: "run-2", reason: "mode_unsupported" }]);
  // Without a mode, as from an older room: approvals required, as before.
  room.deliver({ v: 1, type: "start_thread", runId: "run-3", harness: "codex", startedBy: julio });
  await expect.poll(() => fake.launches).toHaveLength(2);
  expect(fake.launches[1]).toMatchObject({ runtimeMode: "approval-required" });
});

test("the driver's mode reaches T3 Code; anyone else may only lower it; a change made in T3 Code comes back to the room", async () => {
  const { fake, room } = await setup((fake) => idle(fake, "auto-accept-edits"));
  await expect.poll(() => room.of("thread_mode").at(-1)?.runtimeMode).toBe("auto-accept-edits");
  room.deliver({ v: 1, type: "set_thread_mode", threadRef: "thread-a", from: ana, runtimeMode: "full-access" });
  await expect.poll(() => room.of("input_rejected")).toMatchObject([{ terminalId: "thread-a", memberId: "ana", reason: "not_driver" }]);
  room.deliver({ v: 1, type: "set_thread_mode", threadRef: "thread-a", from: julio, runtimeMode: "full-access" });
  await expect.poll(() => fake.commands.filter((c) => c.type === "thread.runtime-mode.set")).toMatchObject([
    { threadId: "thread-a", runtimeMode: "full-access" },
  ]);
  await expect.poll(() => room.of("thread_mode").at(-1)?.runtimeMode).toBe("full-access");
  // The machine's cap lowers it whoever drives: a lower mode is taken from anyone.
  room.deliver({ v: 1, type: "set_thread_mode", threadRef: "thread-a", from: ana, runtimeMode: "approval-required" });
  await expect.poll(() => room.of("thread_mode").at(-1)?.runtimeMode).toBe("approval-required");
  // A mode its provider doesn't take is refused before it reaches T3 Code.
  room.deliver({ v: 1, type: "set_thread_mode", threadRef: "thread-a", from: julio, runtimeMode: "auto" });
  // The room hears which mode was refused, so it shows the one T3 Code still has.
  await expect.poll(() => room.of("input_rejected").at(-1)).toMatchObject({ memberId: "julio", reason: "mode_failed", runtimeMode: "auto" });
  // Someone changes it in T3 Code itself.
  fake.update({ ...fake.threads.get("thread-a")!, runtimeMode: "auto-accept-edits" });
  await expect.poll(() => room.of("thread_mode").at(-1)?.runtimeMode).toBe("auto-accept-edits");
});

test("a thread found in T3 Code is reported before its mode, so the room has its run when the mode arrives", async () => {
  const { room } = await setup((fake) => idle(fake, "full-access"));
  await expect.poll(() => room.of("thread_mode")).toHaveLength(1);
  const reportedAt = room.messages.findIndex((m) => m.type === "run_state_changed" && m.source.kind === "thread" && m.source.threadRef === "thread-a");
  const modeAt = room.messages.findIndex((m) => m.type === "thread_mode" && m.threadRef === "thread-a");
  expect(reportedAt).toBeGreaterThanOrEqual(0);
  expect(reportedAt).toBeLessThan(modeAt);
  expect(room.of("thread_mode")[0]).toMatchObject({ runtimeMode: "full-access", modes: ["approval-required", "auto-accept-edits", "full-access"] });
});

test("files from the thread's box are uploaded to T3 Code first, then go with the message as its attachments", async () => {
  const { fake, room, files } = await setup((fake) => idle(fake));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const shot = files.add("screen shot.png", png, "image/png");
  const log = files.add("build.log", "line one\nline two\n", "text/plain");
  room.deliver({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m1", from: julio, text: "What broke?", attachments: [shot, log] });
  await expect.poll(() => room.of("thread_message_result")).toMatchObject([{ messageId: "m1", status: "sent" }]);
  expect(fake.uploads.map(({ type, name, mimeType, sizeBytes }) => ({ type, name, mimeType, sizeBytes }))).toEqual([
    { type: "image", name: "screen shot.png", mimeType: "image/png", sizeBytes: png.byteLength },
    { type: "file", name: "build.log", mimeType: "text/plain", sizeBytes: 18 },
  ]);
  expect(fake.uploads[0]!.body).toEqual(png);
  expect(fake.uploads[1]!.body?.toString()).toBe("line one\nline two\n");
  expect(fake.commands.find((c) => c.type === "message.dispatch")).toMatchObject({
    text: "What broke?",
    attachments: [
      { type: "image", id: "pending-1", name: "screen shot.png", mimeType: "image/png", sizeBytes: png.byteLength },
      { type: "file", id: "pending-2", name: "build.log", mimeType: "text/plain", sizeBytes: 18 },
    ],
  });
});

test("a file that can't be fetched fails the message before anything reaches the thread", async () => {
  const { fake, room, files } = await setup((fake) => idle(fake));
  const gone = { ...files.add("screen.png", "x", "image/png"), url: `${files.base}/storage/missing` };
  room.deliver({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m1", from: julio, text: "", attachments: [gone] });
  await expect.poll(() => room.of("thread_message_result")).toMatchObject([{ messageId: "m1", status: "failed" }]);
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toEqual([]);
});

test("a message's files move off the room's command queue: another run's stop is handled meanwhile, and its own stop sends nothing", async () => {
  const { fake, room, files } = await setup((fake) => {
    idle(fake);
    fake.threads.set("thread-b", { id: "thread-b", projectId: "project-1", title: "Other", status: "running", activeRunId: "run-b", runtimeMode: "approval-required" });
  });
  let release!: () => void;
  files.gate = new Promise<void>((resolve) => (release = resolve));
  const log = files.add("build.log", "line one\n", "text/plain");
  room.deliverInOrder({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m1", from: julio, text: "Read this", attachments: [log] });
  await expect.poll(() => files.asked).toHaveLength(1);
  // The file is still on its way, and a stop for another thread's run reaches T3 Code.
  room.deliverInOrder({ v: 1, type: "stop_thread", threadRef: "thread-b" });
  await expect.poll(() => fake.commands.filter((c) => c.type === "thread.stop")).toMatchObject([{ threadId: "thread-b" }]);
  // Its own run is stopped too before the file is in: the message never reaches the thread.
  room.deliverInOrder({ v: 1, type: "stop_thread", threadRef: "thread-a" });
  await expect.poll(() => fake.commands.filter((c) => c.type === "thread.stop")).toHaveLength(2);
  release();
  await expect.poll(() => room.of("thread_message_result")).toMatchObject([{ messageId: "m1", status: "failed", error: "run_stopped" }]);
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toEqual([]);
});

test("a stop counts against every message sent before it, including one still waiting behind another's files", async () => {
  const { fake, room, files } = await setup((fake) => idle(fake));
  let release!: () => void;
  files.gate = new Promise<void>((resolve) => (release = resolve));
  const log = files.add("build.log", "line one\n", "text/plain");
  room.deliverInOrder({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m1", from: julio, text: "Read this", attachments: [log] });
  room.deliverInOrder({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m2", from: julio, text: "Then fix it" });
  await expect.poll(() => files.asked).toHaveLength(1);
  room.deliverInOrder({ v: 1, type: "stop_thread", threadRef: "thread-a" });
  await expect.poll(() => fake.commands.filter((c) => c.type === "thread.stop")).toHaveLength(1);
  release();
  await expect.poll(() => room.of("thread_message_result")).toMatchObject([
    { messageId: "m1", status: "failed", error: "run_stopped" },
    { messageId: "m2", status: "failed", error: "run_stopped" },
  ]);
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toEqual([]);
});

test("a thread's messages keep their order when one waits for its files", async () => {
  const { fake, room, files } = await setup((fake) => idle(fake));
  let release!: () => void;
  files.gate = new Promise<void>((resolve) => (release = resolve));
  const log = files.add("build.log", "line one\n", "text/plain");
  room.deliverInOrder({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m1", from: julio, text: "Read this", attachments: [log] });
  room.deliverInOrder({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m2", from: julio, text: "Then fix it" });
  await expect.poll(() => files.asked).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toEqual([]);
  release();
  await expect.poll(() => room.of("thread_message_result").map((r) => r.messageId)).toEqual(["m1", "m2"]);
  expect(fake.commands.filter((c) => c.type === "message.dispatch").map((c) => c.text)).toEqual(["Read this", "Then fix it"]);
});

test("a run's messages carry their files into the thread as attachments, and the text says they came with it", async () => {
  const { fake, room, files } = await setup((fake) => {
    idle(fake);
    fake.projections.set("thread-a", { runtimeRequests: [], turnItems: [], runs: [] });
  });
  const shot = files.add("chart.png", "png-bytes", "image/png");
  room.waiting.set("thread-a", [
    {
      deliveryId: "d1",
      messageId: "msg-1",
      place: "#payments",
      text: "the chart looks wrong",
      attachments: 1,
      files: [shot],
      from: { memberId: "ana", name: "Ana", kind: "person" },
      accountable: { memberId: "ana", name: "Ana" },
      fromDriver: false,
      at: 1,
    },
  ]);
  room.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef: "thread-a" } });
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ status: "delivered" }]);
  const dispatched = fake.commands.find((c) => c.type === "message.dispatch") as { text: string; attachments: unknown[] };
  expect(dispatched.attachments).toEqual([{ type: "image", id: "pending-1", name: "chart.png", mimeType: "image/png", sizeBytes: 9 }]);
  expect(dispatched.text).toContain("Its 1 attached file came with this message.");
  // The link the room gave never reaches the thread.
  expect(dispatched.text).not.toContain(files.base);
});

/** A message from Ana to the run in thread-a, with one file. */
const withFile = (files: FileServer): RunDelivery => ({
  deliveryId: "d1",
  messageId: "msg-1",
  place: "#payments",
  text: "the chart looks wrong",
  attachments: 1,
  files: [files.add("chart.png", "png-bytes", "image/png")],
  from: { memberId: "ana", name: "Ana", kind: "person" },
  accountable: { memberId: "ana", name: "Ana" },
  fromDriver: false,
  at: 1,
});

const threadIdle = (fake: FakeT3) => {
  idle(fake);
  fake.projections.set("thread-a", { runtimeRequests: [], turnItems: [], runs: [] });
};

test("a claim asks for no more files than one message into a thread takes", async () => {
  const { room } = await setup(threadIdle);
  room.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef: "thread-a" } });
  await expect.poll(() => room.claims).toMatchObject([{ threadRef: "thread-a", maxFiles: 40 }]);
});

test("a room from before files in claims gets no maxFiles and no holds, which it would refuse", async () => {
  const { fake, room, files } = await setup(threadIdle, { features: ROOM_FEATURES.filter((f) => f !== "run_message_files"), claimMs: 1200 });
  room.hold = () => true;
  // Past when a hold would go (a third of the claim), within the claim itself.
  files.delayMs = 600;
  room.waiting.set("thread-a", [withFile(files)]);
  room.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef: "thread-a" } });
  await expect.poll(() => room.of("run_message_result"), { timeout: 3000 }).toMatchObject([{ status: "delivered" }]);
  expect(room.claims).toEqual([{ threadRef: "thread-a", how: "next_turn", reserve: expect.any(Number) }]);
  expect(room.holds).toBe(0);
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toHaveLength(1);
});

test("a claim that lapsed while its files moved sends nothing into the thread", async () => {
  const { fake, room, files } = await setup(threadIdle, { claimMs: 400 });
  files.delayMs = 800;
  room.waiting.set("thread-a", [withFile(files)]);
  room.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef: "thread-a" } });
  await expect.poll(() => room.of("run_message_result"), { timeout: 3000 }).toMatchObject([{ status: "released" }]);
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toEqual([]);
});

test("the bridge holds a claim while its files move, and sends once they're in", async () => {
  const { fake, room, files } = await setup(threadIdle, { claimMs: 400 });
  room.hold = () => true;
  files.delayMs = 800;
  room.waiting.set("thread-a", [withFile(files)]);
  room.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef: "thread-a" } });
  await expect.poll(() => room.of("run_message_result"), { timeout: 3000 }).toMatchObject([{ status: "delivered" }]);
  expect(room.holds).toBeGreaterThan(0);
  expect(fake.commands.filter((c) => c.type === "message.dispatch")).toHaveLength(1);
});
