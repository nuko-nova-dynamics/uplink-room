/**
 * T3 Code threads picked on this machine to share (t3Sharing.ts). A thread T3 Code has is private
 * until someone here picks it; the list to pick from stays on the machine; a stop takes effect at
 * once and closes every way the room had to the thread, without touching its work in T3 Code.
 */
import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_FEATURES, type BridgeMessage, type RoomMessage } from "@uplink-room/protocol";
import type { RunMessageClaim, RunMessageClaimRequest } from "@uplink-room/protocol/runMessages";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { LocalSocket, localRequest } from "../src/localSocket.ts";
import { socketPathFor } from "../src/platform.ts";
import { T3CodeAdapter } from "../src/adapters/t3code.ts";
import { exchangePairingToken, type T3Session } from "../src/adapters/t3client.ts";
import { t3ThreadsText } from "../src/cli.ts";
import type { T3SharingView } from "../src/t3Sharing.ts";
import { FakeT3, PAIRING_TOKEN, type FakeThread } from "./tools/fakeT3.ts";

class Room implements RoomLink {
  messages: BridgeMessage[] = [];
  claims: RunMessageClaimRequest[] = [];
  handler?: (message: RoomMessage) => void;
  send(message: BridgeMessage) {
    this.messages.push(message);
    return { features: [...ROOM_FEATURES] };
  }
  onMessage(handler: (message: RoomMessage) => void) {
    this.handler = handler;
  }
  deliver(message: RoomMessage) {
    return this.handler!(message);
  }
  async claimRunMessages(request: RunMessageClaimRequest): Promise<RunMessageClaim> {
    this.claims.push(request);
    return { claimId: `claim-${this.claims.length}`, deliveries: [], more: false };
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<BridgeMessage, { type: T }> => m.type === type);
  }
  /** Everything the room got about a thread. */
  about(threadRef: string) {
    return this.messages.filter((m) => JSON.stringify(m).includes(`"${threadRef}"`));
  }
  reports(threadRef: string) {
    return this.of("run_state_changed").filter((m) => m.source.kind === "thread" && m.source.threadRef === threadRef);
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const driver = { memberId: "driver", name: "Driver" };
const PAIRING = { machineId: "machine-1", teamId: "team-1" };
const running = (id: string, title = id, more: Partial<FakeThread> = {}): FakeThread => ({ id, projectId: "project-1", title, status: "running", ...more });

async function fakeT3(script: (fake: FakeT3) => void = () => {}) {
  const fake = await new FakeT3().start();
  cleanups.push(() => fake.close());
  script(fake);
  return { fake, session: await exchangePairingToken(fake.url, PAIRING_TOKEN) };
}

async function start(fake: FakeT3, session: T3Session, options: { dir?: string; pairing?: typeof PAIRING; file?: string } = {}) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "uplink-t3-sharing-")));
  if (!options.dir) cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const room = new Room();
  const file = options.file ?? join(dir, "t3-threads.json");
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    adapters: [new T3CodeAdapter({ session, project: "/work/billing", retryMs: 50 })],
    linkedBy: driver.memberId,
    pairing: options.pairing ?? PAIRING,
    threadsFile: join(dir, "threads.json"),
    t3SharingFile: file,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await bridge.close();
  };
  cleanups.push(close);
  await bridge.start();
  await expect.poll(() => bridge.t3Threads().state).toBe("ready");
  return { room, bridge, dir, file, close };
}

/** Shares exactly `threads`, from the list as the bridge has it now. */
async function share(bridge: Bridge, threads: string[]) {
  const view = bridge.t3Threads();
  return bridge.shareT3Threads({ machineId: view.machineId, environmentId: view.environmentId, revision: view.revision, threads });
}

test("the list to pick from stays on the machine: unpicked threads, their titles and later updates never reach the room", async () => {
  const { fake, session } = await fakeT3((fake) => {
    fake.threads.set("private-1", running("private-1", "Payroll secrets", { pendingRuntimeRequest: { id: "req-1", kind: "command" } }));
    fake.threads.set("private-2", { ...running("private-2", "Draft offer letter"), status: "completed" });
  });
  const { room, bridge } = await start(fake, session);
  const view = bridge.t3Threads();
  expect(view).toMatchObject({ machineId: "machine-1", environmentId: "env-fake-1", revision: 0, missing: [] });
  expect(view.threads.map((t) => [t.id, t.title, t.project, t.state, t.shared])).toEqual([
    ["private-1", "Payroll secrets", "Billing", "waiting", false],
    ["private-2", "Draft offer letter", "Billing", "done", false],
  ]);
  fake.update(running("private-1", "Payroll secrets, round 2"));
  // A thread made in T3 Code after pairing is private too.
  fake.update(running("private-3", "New and private"));
  await expect.poll(() => bridge.t3Threads().threads.length).toBe(3);
  const sent = JSON.stringify(room.messages);
  for (const text of ["private-1", "private-2", "private-3", "Payroll", "offer letter", "New and private"]) expect(sent).not.toContain(text);
  // No projection was read for the room: the pending request's prompt never left T3 Code.
  expect(fake.projectionReads).toBe(0);
});

test("only the threads picked are shared, at once and with no restart; one made later stays private", async () => {
  const { fake, session } = await fakeT3((fake) => {
    for (const id of ["picked", "other"]) fake.threads.set(id, running(id));
  });
  const { room, bridge, file } = await start(fake, session);
  const after = await share(bridge, ["picked"]);
  expect(after.revision).toBe(1);
  expect(after.threads.find((t) => t.id === "picked")?.shared).toBe(true);
  await expect.poll(() => room.reports("picked").at(-1)).toMatchObject({ state: "working", title: "picked", harness: "codex" });
  fake.update({ ...running("picked"), status: "completed" });
  await expect.poll(() => room.reports("picked").at(-1)?.state).toBe("done");
  fake.update(running("made-later"));
  await expect.poll(() => bridge.t3Threads().threads.some((t) => t.id === "made-later")).toBe(true);
  expect(room.about("other")).toEqual([]);
  expect(room.about("made-later")).toEqual([]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    v: 1,
    machineId: "machine-1",
    teamId: "team-1",
    environmentId: "env-fake-1",
    threads: [{ id: "picked", title: "picked", project: "Billing" }],
  });
});

test("the choice is kept across a restart, for the same pairing and T3 Code environment", async () => {
  const { fake, session } = await fakeT3((fake) => {
    for (const id of ["picked", "other"]) fake.threads.set(id, running(id));
  });
  const dir = await mkdtemp(join(tmpdir(), "uplink-t3-sharing-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const first = await start(fake, session, { dir });
  await share(first.bridge, ["picked"]);
  await first.close();
  const again = await start(fake, session, { dir });
  await expect.poll(() => again.room.reports("picked").length).toBe(1);
  expect(again.bridge.t3Threads().threads.filter((t) => t.shared).map((t) => t.id)).toEqual(["picked"]);
  expect(again.room.about("other")).toEqual([]);
});

test("a choice saved for another pairing is deleted unread, and one picked in another T3 Code environment shares nothing", async () => {
  const { fake, session } = await fakeT3((fake) => fake.threads.set("picked", running("picked")));
  const dir = await mkdtemp(join(tmpdir(), "uplink-t3-sharing-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "t3-threads.json");
  const saved = { v: 1, machineId: "machine-1", teamId: "team-1", environmentId: "env-fake-1", threads: [{ id: "picked" }] };
  // Paired again as another machine: the file is another pairing's.
  await writeFile(file, JSON.stringify(saved));
  const other = await start(fake, session, { dir, pairing: { machineId: "machine-2", teamId: "team-1" } });
  await expect.poll(() => readFile(file, "utf8").catch(() => "gone")).toBe("gone");
  expect(other.room.about("picked")).toEqual([]);
  await other.close();
  // The same pairing, but picked while T3 Code was another environment.
  await writeFile(file, JSON.stringify({ ...saved, environmentId: "env-other" }));
  const elsewhere = await start(fake, session, { dir });
  const view = elsewhere.bridge.t3Threads();
  expect(view).toMatchObject({ otherEnvironment: 1, missing: [] });
  expect(view.threads[0]).toMatchObject({ id: "picked", shared: false });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(elsewhere.room.about("picked")).toEqual([]);
  // Picking again here replaces it.
  await share(elsewhere.bridge, ["picked"]);
  await expect.poll(() => elsewhere.room.reports("picked").length).toBe(1);
  expect(elsewhere.bridge.t3Threads().otherEnvironment).toBeUndefined();
});

test("a save from another pairing, another environment, an older list or naming a thread T3 Code doesn't list is refused", async () => {
  const { fake, session } = await fakeT3((fake) => {
    fake.threads.set("picked", running("picked"));
    fake.threads.set("child", running("child", "child", { lineage: { relationshipToParent: "subagent" } } as Partial<FakeThread>));
    fake.threads.set("old", running("old", "old", { archivedAt: "2026-11-01T00:00:00.000Z" }));
  });
  const { room, bridge } = await start(fake, session);
  // Subagents and archived threads aren't offered.
  expect(bridge.t3Threads().threads.map((t) => t.id)).toEqual(["picked"]);
  const view = bridge.t3Threads();
  const ask = { machineId: "machine-1", environmentId: "env-fake-1", revision: 0, threads: ["picked"] };
  await expect(bridge.shareT3Threads({ ...ask, machineId: "machine-2" })).rejects.toThrow(/another pairing/);
  await expect(bridge.shareT3Threads({ ...ask, environmentId: "env-other" })).rejects.toThrow(/another environment/);
  await expect(bridge.shareT3Threads({ ...ask, threads: ["child"] })).rejects.toThrow(/isn't in T3 Code's list/);
  await expect(bridge.shareT3Threads({ ...ask, threads: ["old"] })).rejects.toThrow(/isn't in T3 Code's list/);
  await expect(bridge.shareT3Threads({ ...ask, threads: ["bad id!"] })).rejects.toThrow(/Invalid/);
  await expect(bridge.shareT3Threads({ ...ask, threads: "picked" })).rejects.toThrow(/Invalid/);
  await share(bridge, ["picked"]);
  // Made from the list before that save.
  await expect(bridge.shareT3Threads({ ...ask, revision: view.revision, threads: [] })).rejects.toThrow(/changed meanwhile/);
  expect(room.about("child")).toEqual([]);
  expect(room.about("old")).toEqual([]);
});

test("stopping sharing closes every way to the thread and drops reads on their way, without touching its work in T3 Code", async () => {
  const { fake, session } = await fakeT3((fake) => {
    fake.threads.set("thread-a", running("thread-a", "Shared for a while", { activeRunId: "run-a" }));
    fake.projections.set("thread-a", {
      runtimeRequests: [{ id: "req-1", kind: "command", status: "pending", responseCapability: { type: "live" } }],
      turnItems: [{ id: "i1", type: "approval_request", requestId: "req-1", requestKind: "command", prompt: "rm -rf build", reason: "Clean the build?" }],
    });
    fake.diffs.set("thread-a:0-1", "diff --git a/x b/x\n");
  });
  const { room, bridge } = await start(fake, session);
  await share(bridge, ["thread-a"]);
  await expect.poll(() => room.reports("thread-a").length).toBe(1);
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-a" });
  await expect.poll(() => fake.threadSubs.filter((s) => s.threadId === "thread-a").length).toBe(1);
  // An approval appears, and its prompt is being read while sharing stops.
  let release!: () => void;
  fake.projectionGate = new Promise<void>((resolve) => (release = resolve));
  fake.update(running("thread-a", "Shared for a while", { activeRunId: "run-a", pendingRuntimeRequest: { id: "req-1", kind: "command" } }));
  await expect.poll(() => fake.projectionReads).toBeGreaterThan(0);
  // What the room got while it was shared (its first items, the approval among them) stays in the room.
  const shared = room.messages.length;
  const after = await share(bridge, []);
  expect(after.threads[0]).toMatchObject({ id: "thread-a", shared: false });
  release();
  fake.projectionGate = undefined;
  // The room's run goes Unknown and takes no more messages; the follow ends.
  await expect.poll(() => room.reports("thread-a").at(-1)?.state).toBe("unknown");
  expect(room.of("thread_closed")).toEqual([{ v: 1, type: "thread_closed", threadRef: "thread-a" }]);
  await expect.poll(() => fake.threadSubs.filter((s) => s.threadId === "thread-a").length).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = room.about("thread-a").length;
  expect(room.reports("thread-a").some((m) => m.state === "waiting")).toBe(false);
  // Later changes, room requests and messages get nothing from it, and change nothing in T3 Code.
  fake.update({ ...running("thread-a", "Renamed in private"), status: "completed" });
  fake.pushThread("thread-a", { type: "turn-item.updated", payload: { id: "i2", type: "assistant_message", text: "private reply" } });
  room.deliver({ v: 1, type: "thread_history", threadRef: "thread-a", requestId: "h1", beforeItemId: "i1" });
  room.deliver({ v: 1, type: "thread_diff_request", threadRef: "thread-a", requestId: "d1", turn: 1 });
  room.deliver({ v: 1, type: "answer_prompt", source: { kind: "thread", threadRef: "thread-a" }, from: driver, promptId: "any", answer: "allow" });
  room.deliver({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId: "m1", from: driver, text: "hello" });
  room.deliver({ v: 1, type: "stop_thread", threadRef: "thread-a" });
  room.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef: "thread-a" } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-a" });
  await expect.poll(() => room.of("thread_history_page").length + room.of("thread_diff").length).toBe(2);
  await expect.poll(() => room.of("thread_message_result").length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(room.of("thread_history_page")[0]).toMatchObject({ items: [], error: expect.stringMatching(/isn't shared/) });
  expect(room.of("thread_diff")[0]).toMatchObject({ error: expect.stringMatching(/isn't shared/) });
  expect(room.of("thread_diff")[0]).not.toHaveProperty("diff");
  expect(room.of("thread_message_result")[0]).toMatchObject({ status: "failed" });
  expect(room.messages.slice(shared).filter((m) => m.type === "thread_items")).toEqual([]);
  expect(room.claims).toEqual([]);
  expect(fake.commands).toEqual([]);
  expect(fake.threadSubs.filter((s) => s.threadId === "thread-a")).toEqual([]);
  const later = room.about("thread-a").slice(before);
  // Only refusals: the answer and the stop are refused on the machine, not passed to T3 Code.
  expect(later.map((m) => m.type).sort()).toEqual(["input_rejected", "input_rejected", "thread_diff", "thread_history_page", "thread_message_result"]);
  expect(room.of("input_rejected").map((m) => m.reason).sort()).toEqual(["no_pending_approval", "stop_failed"]);
  const since = JSON.stringify(room.messages.slice(shared));
  for (const text of ["Renamed in private", "private reply", "rm -rf build", "Clean the build"]) expect(since).not.toContain(text);
});

test("a room view left open is followed again once the thread is shared again", async () => {
  const { fake, session } = await fakeT3((fake) => fake.threads.set("thread-a", running("thread-a")));
  const { room, bridge } = await start(fake, session);
  // The room asks before anyone shared it: nothing is read.
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-a" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(fake.threadSubs).toEqual([]);
  await share(bridge, ["thread-a"]);
  await expect.poll(() => room.of("thread_items").length).toBe(1);
  expect(room.of("thread_items")[0]).toMatchObject({ threadRef: "thread-a", reset: true });
});

test("a history read on its way when sharing stops sends none of what it read", async () => {
  const { fake, session } = await fakeT3((fake) => {
    fake.threads.set("thread-a", running("thread-a"));
    fake.history.set("thread-a", [
      { id: "old-1", type: "assistant_message", ordinal: 1, text: "old private text", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "i1", type: "assistant_message", ordinal: 2, text: "newer", createdAt: "2026-11-01T00:01:00.000Z" },
    ]);
  });
  const { room, bridge } = await start(fake, session);
  await share(bridge, ["thread-a"]);
  let release!: () => void;
  fake.historyGate = new Promise<void>((resolve) => (release = resolve));
  room.deliver({ v: 1, type: "thread_history", threadRef: "thread-a", requestId: "h1", beforeItemId: "i1" });
  await expect.poll(() => fake.historyCursors.length).toBe(1);
  await share(bridge, []);
  release();
  await expect.poll(() => room.of("thread_history_page").length).toBe(1);
  expect(room.of("thread_history_page")[0]).toMatchObject({ items: [], error: expect.stringMatching(/isn't shared/) });
  expect(JSON.stringify(room.messages)).not.toContain("old private text");
});

test("a thread launched from the room stays shared whatever is picked, and isn't saved as picked", async () => {
  const { fake, session } = await fakeT3();
  const { room, bridge, file } = await start(fake, session);
  room.deliver({ v: 1, type: "start_thread", runId: "run-1", harness: "codex", startedBy: driver });
  await expect.poll(() => room.reports("uplink-room-run-1").length).toBeGreaterThan(0);
  const view = bridge.t3Threads();
  expect(view.threads).toMatchObject([{ id: "uplink-room-run-1", shared: true, fromRoom: true }]);
  // Leaving it out of a save doesn't stop it, and naming it doesn't save it.
  await share(bridge, []);
  await share(bridge, ["uplink-room-run-1"]);
  expect(JSON.parse(await readFile(file, "utf8")).threads).toEqual([]);
  fake.update({ ...fake.threads.get("uplink-room-run-1")!, status: "completed" });
  await expect.poll(() => room.reports("uplink-room-run-1").at(-1)?.state).toBe("done");
  expect(room.of("thread_closed")).toEqual([]);
});

test("a reconnect reports a shared thread again and keeps the others private", async () => {
  const { fake, session } = await fakeT3((fake) => {
    for (const id of ["picked", "other"]) fake.threads.set(id, running(id));
  });
  const { room, bridge } = await start(fake, session);
  await share(bridge, ["picked"]);
  await expect.poll(() => room.reports("picked").length).toBe(1);
  fake.dropConnections();
  await expect.poll(() => room.reports("picked").map((m) => m.state)).toEqual(["working", "unknown", "working"]);
  expect(room.about("other")).toEqual([]);
});

test("a reconnect to another T3 Code environment closes the run of a thread picked in the old one", async () => {
  const { fake, session } = await fakeT3((fake) => fake.threads.set("picked", running("picked")));
  const { room, bridge } = await start(fake, session);
  await share(bridge, ["picked"]);
  await expect.poll(() => room.reports("picked").length).toBe(1);
  // T3 Code comes back as another environment: the choice made in the old one shares nothing.
  fake.environmentId = "env-fake-2";
  fake.dropConnections();
  await expect.poll(() => bridge.t3Threads().environmentId).toBe("env-fake-2");
  expect(bridge.t3Threads().threads[0]).toMatchObject({ id: "picked", shared: false });
  // Unknown once, when the connection was lost, and closed, so it takes no more messages.
  expect(room.reports("picked").map((m) => m.state)).toEqual(["working", "unknown"]);
  await expect.poll(() => room.of("thread_closed")).toEqual([{ v: 1, type: "thread_closed", threadRef: "picked" }]);
});

test("a save that fails isn't kept: a new share waits for the retry, and a stop holds at once", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const { fake, session } = await fakeT3((fake) => {
    for (const id of ["a", "b"]) fake.threads.set(id, running(id));
  });
  const dir = await mkdtemp(join(tmpdir(), "uplink-t3-sharing-"));
  cleanups.push(async () => {
    await chmod(join(dir, "picks"), 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "picks"));
  const { room, bridge, file } = await start(fake, session, { dir, file: join(dir, "picks", "t3-threads.json") });
  await share(bridge, ["a"]);
  await expect.poll(() => room.reports("a").length).toBe(1);
  await chmod(join(dir, "picks"), 0o500);
  // Sharing b and stopping a, in one save that fails.
  await expect(share(bridge, ["b"])).rejects.toThrow(
    /^Couldn't save the choice on this computer \(.+\)\. Threads you stopped sharing are private now, but would be shared again after the bridge restarts\. Try again\.$/,
  );
  await expect.poll(() => room.reports("a").at(-1)?.state).toBe("unknown");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(room.about("b")).toEqual([]);
  const view = bridge.t3Threads();
  expect(view.revision).toBe(1);
  expect(view.threads.filter((t) => t.shared)).toEqual([]);
  expect(JSON.parse(await readFile(file, "utf8")).threads.map((t: { id: string }) => t.id)).toEqual(["a"]);
  // Another try while it still can't be written: a stays stopped, and nothing new is shared.
  await expect(share(bridge, ["a", "b"])).rejects.toThrow(/\. Nothing new is shared\. Try again\.$/);
  expect(bridge.t3Threads().threads.filter((t) => t.shared)).toEqual([]);
  // The retry, once the folder can be written again.
  await chmod(join(dir, "picks"), 0o700);
  const retried = await share(bridge, ["b"]);
  expect(retried.revision).toBe(2);
  await expect.poll(() => room.reports("b").length).toBe(1);
  expect(JSON.parse(await readFile(file, "utf8")).threads.map((t: { id: string }) => t.id)).toEqual(["b"]);
});

test("the local socket lists and saves the choice; unlinking forgets it", async () => {
  const { fake, session } = await fakeT3((fake) => fake.threads.set("picked", running("picked", "Ship the fix")));
  const { room, bridge, dir, file } = await start(fake, session);
  const path = socketPathFor(dir);
  const local = new LocalSocket(path, bridge);
  await local.start();
  cleanups.push(() => local.close());
  const view = (await localRequest(path, { type: "t3-threads" })) as T3SharingView;
  expect(view.threads[0]).toMatchObject({ id: "picked", title: "Ship the fix", shared: false });
  expect(t3ThreadsText(view)).toBe("private  picked  Ship the fix (Billing, working)");
  await expect(localRequest(path, { type: "t3-share", machineId: "machine-1", environmentId: "env-fake-1", revision: 0, threads: [42] })).rejects.toThrow(
    /Invalid T3 Code sharing request: threads/,
  );
  const saved = (await localRequest(path, { type: "t3-share", machineId: "machine-1", environmentId: "env-fake-1", revision: 0, threads: ["picked"] })) as T3SharingView;
  expect(t3ThreadsText(saved)).toBe("shared   picked  Ship the fix (Billing, working)");
  await expect.poll(() => room.reports("picked").length).toBe(1);
  await localRequest(path, { type: "unlink" });
  await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("without a session, `t3 thread list` shares only threads picked for any environment, so nothing saved", async () => {
  const reports: unknown[][] = [];
  const adapter = new T3CodeAdapter({ executable: join(import.meta.dirname, "tools/t3"), project: "/fake", pollMs: 10 });
  const handle = adapter.startBridge((...args) => reports.push(args), { launched: new Map(), shared: { environmentId: "env-fake-1", threads: ["working"] } });
  cleanups.push(async () => handle.close());
  expect(handle.local?.catalog()).toEqual({ state: "not_paired", threads: [] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(reports).toEqual([]);
});
