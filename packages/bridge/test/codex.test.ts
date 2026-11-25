/**
 * A Codex run in a bridge terminal (ADR 0038, slice 7 of #139): Codex's hooks report its state and
 * name its thread, its approvals go to the room, and the room's messages go into its session through
 * the terminal's own app server: `turn/steer` during a turn, `turn/start` when idle. The bridge claims
 * the messages, puts them in, and only then tells the room they were delivered.
 */
import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_FEATURES, type BridgeMessage, type RoomMessage, type RunSaid, type RunSay } from "@uplink-room/protocol";
import type { RunDelivery, RunMessageClaim, RunMessageClaimRequest } from "@uplink-room/protocol/runMessages";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { LocalSocket, localRequest } from "../src/localSocket.ts";
import { quoteCommand, socketPathFor } from "../src/platform.ts";
import { codexServerConfig } from "../src/codexHooks.ts";
import { relayRequest, relayedRequests } from "../src/codexRelay.ts";
import { FakeCodexServer } from "./tools/fakeCodexServer.ts";
import { FileServer } from "./tools/fileServer.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { codexRunsOwnServer } from "../src/codexSession.ts";

const term = (...args: string[]) => quoteCommand([process.execPath, join(import.meta.dirname, "tools/term.mjs"), ...args]);

/** A room that takes run messages and hands them over at a claim, as in runMessages.test.ts. */
class Room implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void;
  waiting: RunDelivery[] = [];
  claims: RunMessageClaimRequest[] = [];
  /** How many claims to fail first, as a room that can't be reached for a moment does. */
  claimFailures = 0;
  said: RunSay[] = [];
  /** Runs while a claim is out, before the room answers it. */
  onClaim?: () => Promise<void>;
  /** Puts released messages back to wait, as the room does; tests that hand them back themselves leave it off. */
  requeue = false;
  private claimed = new Map<string, RunDelivery>();
  send(message: BridgeMessage) {
    this.messages.push(message);
    if (this.requeue && message.type === "run_message_result" && message.status === "released")
      for (const id of message.deliveryIds) this.waiting.push(this.claimed.get(id)!);
    return { features: [...ROOM_FEATURES] };
  }
  async say(request: RunSay): Promise<RunSaid> {
    this.said.push(request);
    return { messageId: "msg-new", label: "Codex (Julio)", place: request.replyTo ? "a thread in #payments" : (request.in ?? "") };
  }
  onMessage(handler: (message: RoomMessage) => void) {
    this.handler = handler;
  }
  async claimRunMessages(request: RunMessageClaimRequest): Promise<RunMessageClaim> {
    this.claims.push(request);
    if (this.claimFailures > 0) {
      this.claimFailures--;
      throw new Error("The room didn't answer.");
    }
    await this.onClaim?.();
    const deliveries = this.waiting.splice(0);
    for (const delivery of deliveries) this.claimed.set(delivery.deliveryId, delivery);
    return { claimId: `claim-${this.claims.length}`, deliveries, more: false };
  }
  deliver(message: RoomMessage) {
    this.handler!(message);
  }
  post(delivery: RunDelivery, terminalId = "run-1") {
    this.waiting.push(delivery);
    this.deliver({ v: 1, type: "run_messages_waiting", source: { kind: "terminal", terminalId } });
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<BridgeMessage, { type: T }> => m.type === type);
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const driver = { memberId: "julio", name: "Julio" };
const SECRET = "terminal-secret-for-tests";

function message(deliveryId: string): RunDelivery {
  return {
    deliveryId,
    messageId: `msg-${deliveryId}`,
    place: "#payments",
    text: "release the 3D model",
    from: { memberId: "ana", name: "Ana", kind: "person" },
    accountable: { memberId: "ana", name: "Ana" },
    fromDriver: false,
    at: 1,
  };
}

/**
 * A bridge with its local socket, a shared terminal `run-1` that the room started, and a fake app
 * server registered as that terminal's Codex, as `uplink-bridge codex` registers it.
 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "uplink-codex-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const room = new Room();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 2, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    terminalSecret: () => SECRET,
  });
  cleanups.push(() => bridge.close());
  const socketPath = socketPathFor(dir);
  const socket = new LocalSocket(socketPath, bridge);
  await socket.start();
  cleanups.push(() => socket.close());
  await bridge.start();
  room.deliver({ v: 1, type: "start_terminal", terminalId: "run-1", command: term("idle"), startedBy: driver, access: "suggest", usesSlot: false, cwd: dir });
  await expect.poll(() => room.of("terminal_started").length).toBe(1);
  const codex = await FakeCodexServer.listen(join(dir, "codex.sock"));
  cleanups.push(() => codex.close());
  const register = (secret = SECRET) =>
    localRequest(socketPath, { type: "codex-server", terminalId: "run-1", secret, socket: join(dir, "codex.sock") });
  const hook = (event: string, payload: object = {}, secret = SECRET) =>
    localRequest(socketPath, { type: "codex-hook", terminalId: "run-1", secret, event, payload: { session_id: "thr-1", hook_event_name: event, ...payload } });
  return { room, bridge, dir, socketPath, codex, register, hook };
}

const states = (room: Room) => room.of("run_state_changed").map((m) => m.state);

// The adapter runs Codex on a Unix-socket app server, which Windows doesn't have (ADR 0038):
// there a Codex terminal stays Unknown, as before, so these run on Linux and macOS.
const windows = process.platform === "win32";

test.skipIf(windows)("Codex's hooks report its run's state: Working during a turn, Done when it ends or is interrupted", async () => {
  const { room, register, hook } = await setup();
  await register();
  expect(await hook("SessionStart", { source: "startup" })).toEqual({});
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "Interrupt"]) expect(await hook(event)).toEqual({});
  // The terminal starts Unknown; SessionStart says nothing about a turn.
  expect(states(room)).toEqual(["unknown", "working", "working", "working", "done", "working", "done"]);
});

test.skipIf(windows)("a message to an idle session starts a turn with it on the session's thread, and the room hears it was delivered at the next turn", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("SessionStart", { source: "startup" });
  room.post(message("d1"));
  await expect.poll(() => codex.of("turn/start").length).toBe(1);
  const [start] = codex.of("turn/start");
  expect(start!.params.threadId).toBe("thr-1");
  expect(start!.params.input[0].text).toContain("Message msg-d1 in #payments, from Ana, a person.");
  expect(start!.params.input[0].text).toContain("uplink-bridge reply <message id>");
  expect(room.claims).toEqual([expect.objectContaining({ terminalRef: "run-1", how: "next_turn" })]);
  await expect
    .poll(() => room.of("run_message_result"))
    .toEqual([{ v: 1, type: "run_message_result", claimId: "claim-1", deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
  expect(room.of("run_hearing")).toEqual([{ v: 1, type: "run_hearing", source: { kind: "terminal", terminalId: "run-1" }, hearing: "mid_task" }]);
});

test.skipIf(windows)("a message's image goes into Codex as a localImage saved in the workspace, and its other files as paths (ADR 0043)", async () => {
  const { room, dir, codex, register, hook } = await setup();
  const files = await FileServer.start();
  cleanups.push(() => files.close());
  await register();
  await hook("SessionStart", { source: "startup" });
  room.post({ ...message("d1"), attachments: 2, files: [files.add("chart.png", "png-bytes", "image/png"), files.add("notes.txt", "a note", "text/plain")] });
  await expect.poll(() => codex.of("turn/start").length).toBe(1);
  const saved = join(dir, ".uplink-room", "files", "d1");
  const [start] = codex.of("turn/start");
  expect(start!.params.input.slice(1)).toEqual([{ type: "localImage", path: join(saved, "chart.png") }]);
  expect(start!.params.input[0].text).toContain(`Its 2 attached files were saved for this run at:\n- ${join(saved, "chart.png")}\n- ${join(saved, "notes.txt")}`);
  expect(start!.params.input[0].text).not.toContain(files.base);
  expect(await readFile(join(saved, "notes.txt"), "utf8")).toBe("a note");
  // Git leaves the folder alone.
  expect(await readFile(join(dir, ".uplink-room", ".gitignore"), "utf8")).toBe("*\n");
});

test.skipIf(windows)("during a turn a message joins it with turn/steer, so a running command goes on; one whose turn ended meanwhile starts the next", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("UserPromptSubmit", { turn_id: "turn-7" });
  codex.turn = { id: "turn-7", status: "inProgress" };
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "mid_task" }]);
  expect(codex.of("turn/steer").map((c) => c.params)).toEqual([
    { threadId: "thr-1", input: [{ type: "text", text: expect.stringContaining("Message msg-d1") }], expectedTurnId: "turn-7" },
  ]);
  expect(codex.of("turn/start")).toEqual([]);
  expect(room.claims.at(-1)).toMatchObject({ how: "mid_task" });

  // The turn ends after the bridge saw it running: the steer is refused, and the message starts a turn.
  codex.onCall = (call) => {
    if (call.method === "turn/steer") codex.turn = { id: "turn-7", status: "completed" };
  };
  room.post(message("d2"));
  await expect.poll(() => room.of("run_message_result").length).toBe(2);
  expect(room.of("run_message_result")[1]).toMatchObject({ deliveryIds: ["d2"], status: "delivered", how: "next_turn" });
  expect(codex.of("turn/start")).toHaveLength(1);
});

test.skipIf(windows)("a message Codex doesn't take goes back to wait, and the bridge tries again until Codex takes it", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("SessionStart", { source: "startup" });
  codex.failing.set("turn/start", "Server overloaded; retry later.");
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "released" }]);
  room.waiting.push(message("d1"));
  codex.failing.clear();
  await expect.poll(() => room.of("run_message_result").at(-1)).toMatchObject({ deliveryIds: ["d1"], status: "delivered", how: "next_turn" });
  expect(codex.of("turn/start").length).toBeGreaterThanOrEqual(2);
});

test.skipIf(windows)("a message Codex took whose answer never came back is found in the thread and reported delivered, never put in a second time", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("UserPromptSubmit", { turn_id: "turn-7" });
  codex.turn = { id: "turn-7", status: "inProgress" };
  // Codex takes the steer, then the connection closes before its answer; it lists the message a moment later.
  codex.dropAfter.add("turn/steer");
  codex.listsAfterMs = 600;
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result"), { timeout: 5000 }).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "mid_task" }]);
  expect(codex.of("turn/steer")).toHaveLength(1);
  expect(codex.of("turn/start")).toEqual([]);
  expect(codex.items.map((item) => item.content[0]!.text)).toEqual([expect.stringContaining("Message msg-d1")]);
});

test.skipIf(windows)("a message the bridge can't tell Codex took is reported unsure, so the room hands it over once more at most, and not released again and again", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("SessionStart", { source: "startup" });
  // The connection closes with the start unanswered, and nothing in the thread says it arrived.
  codex.dropBefore.add("turn/start");
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result"), { timeout: 6000 }).toMatchObject([{ deliveryIds: ["d1"], status: "unsure" }]);
  expect(codex.of("turn/start")).toHaveLength(1);
  // The room hands it over again, and this time Codex answers.
  codex.dropBefore.clear();
  room.waiting.push(message("d1"));
  await expect.poll(() => room.of("run_message_result").at(-1), { timeout: 5000 }).toMatchObject({ deliveryIds: ["d1"], status: "delivered", how: "next_turn" });
  expect(codex.of("turn/start")).toHaveLength(2);
});

test.skipIf(windows)("a claim the room couldn't answer is tried again, so an idle session still gets the message without waiting for another", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("SessionStart", { source: "startup" });
  room.claimFailures = 1;
  room.post(message("d1"));
  await expect
    .poll(() => room.of("run_message_result"), { timeout: 5000 })
    .toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
  expect(room.claims).toHaveLength(2);
  expect(codex.of("turn/start")).toHaveLength(1);
});

test.skipIf(windows)("a session that hasn't had a turn yet gets its message on the one root thread its server has loaded", async () => {
  const { room, codex, register } = await setup();
  // Its thread has no first message yet, so Codex lists no turns for it.
  codex.materialized = false;
  codex.threads = [
    { id: "thr-sub", parentThreadId: "thr-main", createdAt: 3 },
    { id: "thr-main", parentThreadId: null, createdAt: 2 },
  ];
  await register();
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ status: "delivered", how: "next_turn" }]);
  expect(codex.of("turn/start").map((c) => c.params.threadId)).toEqual(["thr-main"]);
});

test.skipIf(windows)("a message during a /side conversation, which Codex keeps no history of and discards, goes to the session's own thread", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("UserPromptSubmit", { turn_id: "turn-1" });
  await hook("Stop", { turn_id: "turn-1" });
  // The person opens /side: an ephemeral fork, whose hooks name it, with a turn running.
  codex.threads.push({ id: "thr-side", parentThreadId: null, createdAt: 2, ephemeral: true });
  codex.threadTurns.set("thr-side", { id: "turn-s", status: "inProgress" });
  await hook("UserPromptSubmit", { session_id: "thr-side", turn_id: "turn-s" });
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
  expect(codex.of("turn/start").map((c) => c.params.threadId)).toEqual(["thr-1"]);
  expect(codex.of("turn/steer")).toEqual([]);
});

test.skipIf(windows)("a message claimed while the person switches threads with /new or /resume goes to the thread they switched to", async () => {
  const { room, codex, register, hook } = await setup();
  room.requeue = true;
  await register();
  await hook("SessionStart", { source: "startup" });
  codex.threads.push({ id: "thr-2", parentThreadId: null, createdAt: 2 });
  // The person runs /new while the room answers the claim: the new thread's first hook binds it.
  room.onClaim = async () => {
    room.onClaim = undefined;
    await hook("SessionStart", { session_id: "thr-2", source: "startup" });
  };
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result").at(-1)).toMatchObject({ deliveryIds: ["d1"], status: "delivered", how: "next_turn" });
  expect(codex.of("turn/start").map((c) => c.params.threadId)).toEqual(["thr-2"]);
  // The claim taken for the old thread went back to the room first.
  expect(room.of("run_message_result").map((r) => r.status)).toEqual(["released", "delivered"]);
});

test.skipIf(windows)("after the person switches threads, a message during a /side conversation goes to the thread they switched to, not the one before", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("SessionStart", { source: "startup" });
  // Thread thr-1 gets a message.
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered" }]);
  codex.turn = { ...codex.turn, status: "completed" };
  // The person runs /new, which gets no message, then opens /side from it with a turn running.
  codex.threads.push({ id: "thr-2", parentThreadId: null, createdAt: 2 });
  await hook("SessionStart", { session_id: "thr-2", source: "startup" });
  codex.threads.push({ id: "thr-side", parentThreadId: null, createdAt: 3, ephemeral: true });
  codex.threadTurns.set("thr-side", { id: "turn-s", status: "inProgress" });
  await hook("UserPromptSubmit", { session_id: "thr-side", turn_id: "turn-s" });
  room.post(message("d2"));
  await expect.poll(() => room.of("run_message_result").length).toBe(2);
  expect(room.of("run_message_result")[1]).toMatchObject({ deliveryIds: ["d2"], status: "delivered", how: "next_turn" });
  expect(codex.of("turn/start").map((c) => c.params.threadId)).toEqual(["thr-1", "thr-2"]);
});

test.skipIf(windows)("a turn that fails reports the run Failed, which no Codex hook says", async () => {
  const { room, codex, register, hook } = await setup();
  await register();
  await hook("UserPromptSubmit", { turn_id: "turn-1" });
  // The bridge follows the thread as soon as a hook names it.
  await expect.poll(() => codex.of("thread/resume").length).toBe(1);
  codex.notify("turn/completed", { threadId: "thr-other", turn: { id: "turn-9", status: "failed" } });
  codex.notify("turn/completed", { threadId: "thr-1", turn: { id: "turn-1", status: "failed", error: { message: "model not allowed" } } });
  await expect.poll(() => states(room).at(-1)).toBe("failed");
  expect(states(room)).toEqual(["unknown", "working", "failed"]);
});

test.skipIf(windows)("an approval Codex asks for goes to the room, and the driver's answer comes back as Codex's decision", async () => {
  const { room, register, hook } = await setup();
  await register();
  const asked = hook("PermissionRequest", { turn_id: "turn-1", tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Delete the build folder?" } });
  await expect.poll(() => room.of("run_state_changed").at(-1)?.state).toBe("waiting");
  const waiting = room.of("run_state_changed").at(-1)!;
  expect(waiting.prompt).toEqual({ kind: "approval", text: "Delete the build folder?", action: "rm -rf build", promptId: expect.any(String) });
  // Another approval asked meanwhile, by a command running beside the first, waits in Codex's own prompt.
  expect(await hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "git push" } })).toEqual({});
  room.deliver({ v: 1, type: "answer_prompt", source: { kind: "terminal", terminalId: "run-1" }, from: driver, promptId: waiting.prompt!.promptId!, answer: "allow" });
  expect(await asked).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  expect(states(room).at(-1)).toBe("working");
});

test.skipIf(windows)("a command running beside one that waits on an approval leaves the approval in the room, and its hooks still post what the sandbox kept", async () => {
  const { room, register, hook } = await setup();
  await register();
  const asked = hook("PermissionRequest", { turn_id: "turn-1", tool_name: "Bash", tool_input: { command: "git push" } });
  await expect.poll(() => room.of("run_state_changed").at(-1)?.state).toBe("waiting");
  const waiting = room.of("run_state_changed").at(-1)!;
  // Another command runs meanwhile: its hooks fire, and it relays a reply from inside the sandbox.
  const output = { output: relayRequest(SECRET, { replyTo: "msg-d1", text: "pushing now" }), exit_code: 0 };
  expect(await hook("PreToolUse", { turn_id: "turn-1", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({});
  expect(await hook("PostToolUse", { turn_id: "turn-1", tool_name: "Bash", tool_response: output })).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
  expect(room.said).toEqual([{ terminalRef: "run-1", replyTo: "msg-d1", text: "pushing now" }]);
  // The room still shows the approval, and the driver's answer still reaches Codex.
  expect(room.of("run_state_changed").at(-1)).toEqual(waiting);
  room.deliver({ v: 1, type: "answer_prompt", source: { kind: "terminal", terminalId: "run-1" }, from: driver, promptId: waiting.prompt!.promptId!, answer: "allow" });
  expect(await asked).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  expect(states(room).at(-1)).toBe("working");
});

test.skipIf(windows)("an approval nobody answers before Codex gives up on its hook goes back to Codex's own prompt, never to a decision", async () => {
  const { room, socketPath, register } = await setup();
  await register();
  // Codex ends a hook at its timeout; the hook's connection closes with it.
  const asked = localRequest(
    socketPath,
    { type: "codex-hook", terminalId: "run-1", secret: SECRET, event: "PermissionRequest", payload: { session_id: "thr-1", tool_name: "Bash", tool_input: { command: "make deploy" } } },
    { timeoutMs: 300 },
  );
  await expect(asked).rejects.toThrow("timed out");
  await expect.poll(() => room.of("run_state_changed").at(-1)?.prompt).toEqual({ kind: "question", text: "Allow Bash? Answer it in the terminal." });
});

test.skipIf(windows)("a reply that Codex's sandbox kept from the bridge is posted by the terminal's PostToolUse hook, once, and only with the terminal's signature", async () => {
  const { room, register, hook } = await setup();
  await register();
  const signed = relayRequest(SECRET, { replyTo: "msg-d1", text: "done, releasing the model" });
  const output = { output: `Codex's sandbox keeps this command from the bridge.\n${signed}\n`, exit_code: 0 };
  expect(await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: 'uplink-bridge reply msg-d1 "done, releasing the model"' }, tool_response: output })).toEqual({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Uplink Room: posted as Codex (Julio) in a thread in #payments (message msg-new)." },
  });
  expect(room.said).toEqual([{ terminalRef: "run-1", replyTo: "msg-d1", text: "done, releasing the model" }]);
  // The same output read again (cat of a log) posts nothing more, nor does a request another secret signed.
  expect(await hook("PostToolUse", { tool_name: "Bash", tool_response: output })).toEqual({});
  expect(await hook("PostToolUse", { tool_name: "Bash", tool_response: relayRequest("another-terminal", { in: "#general", text: "hi" }) })).toEqual({});
  expect(room.said).toHaveLength(1);
  // A relayed message that quotes a T3 Code thread's run key reaches the room with the key hidden (ADR 0037).
  const quoting = relayRequest(SECRET, { in: "#general", text: "it said --key urt_0123456789abcdefABCDEF-_0123456789" });
  await hook("PostToolUse", { tool_name: "Bash", tool_response: { output: quoting, exit_code: 0 } });
  expect(room.said.at(-1)).toEqual({ terminalRef: "run-1", in: "#general", text: "it said --key urt_[hidden]" });
});

/** Runs the bridge's CLI as Codex runs a hook or the agent runs a command: in the terminal's environment. */
function cli(args: string[], env: Record<string, string>, input = "") {
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/bin.ts"), ...args], {
    env: { ...process.env, UPLINK_NO_TELEMETRY: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test.skipIf(windows)("the codex-hook command answers Codex with JSON, and with no bridge to reach answers {} at once, so Codex asks for an approval itself", async () => {
  const { room, socketPath, register } = await setup();
  await register();
  const env = { UPLINK_TERMINAL_REF: "run-1", UPLINK_TERMINAL_SECRET: SECRET, UPLINK_BRIDGE_SOCKET: socketPath };
  expect(await cli(["codex-hook", "Stop"], env, JSON.stringify({ session_id: "thr-1", hook_event_name: "Stop" }))).toMatchObject({ code: 0, stdout: "{}\n" });
  await expect.poll(() => states(room).at(-1)).toBe("done");
  const gone = { ...env, UPLINK_BRIDGE_SOCKET: join(tmpdir(), "uplink-no-bridge-here.sock") };
  expect(await cli(["codex-hook", "PermissionRequest"], gone, JSON.stringify({ tool_name: "Bash" }))).toMatchObject({ code: 0, stdout: "{}\n" });
});

test.skipIf(process.platform === "win32")(
  "say and reply from inside Codex's sandbox, which refuses the bridge's socket, print a request the terminal's hook can post",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "uplink-sandbox-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    // A socket nobody may connect to refuses as Codex's sandbox does, with a permission error.
    const path = join(dir, "bridge.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    await chmod(path, 0o000);
    const env = { UPLINK_TERMINAL_REF: "run-1", UPLINK_TERMINAL_SECRET: SECRET, UPLINK_BRIDGE_SOCKET: path };
    const replied = await cli(["reply", "msg-d1", "done,", "releasing the model"], { ...env, UPLINK_CODEX_RELAY: "1" });
    expect(replied.code).toBe(0);
    expect(relayedRequests(SECRET, replied.stdout)).toEqual([{ nonce: expect.any(String), replyTo: "msg-d1", text: "done, releasing the model" }]);
    // Outside a Codex terminal the same failure is an error.
    expect((await cli(["say", "--in", "#payments", "hi"], env)).code).toBe(1);
  },
);

/**
 * A bridge whose terminal `run-1` the room starts with `codex --model gpt-6-luna`, with the fake
 * `codex` (tools/codex.mjs) first on its PATH and `env` for it.
 */
async function codexTerminal(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "uplink-codexrun-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "codex"), `#!${process.execPath}\nimport(${JSON.stringify(join(import.meta.dirname, "tools/codex.mjs"))});\n`);
  await chmod(join(dir, "bin", "codex"), 0o755);
  const logFile = join(dir, "codex.log");
  const room = new Room();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 2, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_CODEX_LOG: logFile, UPLINK_NO_TELEMETRY: "1", ...env },
    adapters: [new CodexAdapter()],
    codex: { bridgeCommand: BRIDGE_CLI },
  });
  cleanups.push(() => bridge.close());
  const socket = new LocalSocket(socketPathFor(dir), bridge);
  await socket.start();
  cleanups.push(() => socket.close());
  await bridge.start();
  room.deliver({ v: 1, type: "start_terminal", terminalId: "run-1", harness: "codex", command: "codex --model gpt-6-luna", startedBy: driver, access: "suggest", usesSlot: false });
  const output = () => room.of("terminal_output").map((m) => m.data).join("");
  const entries = async () => (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { room, output, entries };
}

const BRIDGE_CLI = [process.execPath, join(import.meta.dirname, "../src/bin.ts")];

test.skipIf(process.platform === "win32")(
  "a terminal the bridge starts with codex runs it on an app server of its own with the bridge's hooks, which reach this bridge; the server stops with the session",
  async () => {
    const { room, output, entries } = await codexTerminal();
    await expect.poll(output).toContain("tui ready");
    const [server, tui] = await entries();
    // The room still sees the command it asked for, run by the Codex adapter.
    expect(room.of("terminal_started")[0]).toMatchObject({ title: "codex --model gpt-6-luna", tool: "codex" });
    expect(server.args.slice(0, 2)).toEqual(["app-server", "--listen"]);
    expect(server.args.slice(3)).toEqual(codexServerConfig(BRIDGE_CLI).values.flatMap((value) => ["-c", value]));
    expect(server.env).toEqual({ UPLINK_TERMINAL_REF: "run-1", UPLINK_CODEX_RELAY: "1" });
    expect(tui.args).toEqual(["--remote", server.args[2], "--model", "gpt-6-luna"]);

    // A turn in the session runs the hooks, which reach this bridge as the terminal.
    room.deliver({ v: 1, type: "input", terminalId: "run-1", from: driver, data: "go\r" });
    await expect.poll(output).toContain("turn done");
    expect(states(room)).toEqual(["unknown", "working", "done"]);
    // A message then goes into the session's thread, which the hooks named.
    room.post(message("d1"));
    await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
    await expect.poll(async () => (await entries()).filter((e) => e.role === "turn").at(-1)?.text).toContain("Message msg-d1");

    // Quitting Codex stops its server, and ends the terminal.
    room.deliver({ v: 1, type: "input", terminalId: "run-1", from: driver, data: "quit\r" });
    await expect.poll(() => room.of("terminal_ended").length).toBe(1);
    await expect.poll(async () => (await entries()).some((e) => e.role === "server-stopped")).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "a Codex that hashes hooks differently from this bridge still runs its hooks: the server reports the hashes it trusts by, and starts again with them",
  async () => {
    const { room, output, entries } = await codexTerminal({ FAKE_CODEX_HASHING: "other" });
    await expect.poll(output, { timeout: 5000 }).toContain("tui ready");
    room.deliver({ v: 1, type: "input", terminalId: "run-1", from: driver, data: "go\r" });
    await expect.poll(output).toContain("turn done");
    expect(states(room)).toEqual(["unknown", "working", "done"]);
    const servers = (await entries()).filter((e) => e.role === "server");
    expect(servers).toHaveLength(2);
    expect(output()).not.toContain("Uplink Room:");
  },
);

test.skipIf(process.platform === "win32")(
  "a Codex whose trust in the bridge's hooks can't be checked runs without the room, and the terminal says so",
  async () => {
    const { room, output, entries } = await codexTerminal({ FAKE_CODEX_NO_HOOKS_LIST: "1" });
    await expect.poll(output, { timeout: 5000 }).toContain("plain codex");
    expect(output()).toMatch(/Uplink Room: .*hooks.*without the room/s);
    await expect.poll(async () => (await entries()).some((e) => e.role === "server-stopped")).toBe(true);
    expect((await entries()).filter((e) => e.role === "tui")).toEqual([]);
    expect(states(room)).toEqual(["unknown"]);
  },
);

test.skipIf(process.platform === "win32")(
  "a terminal that closes while Codex's app server is still starting stops that server too, so none is left running",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "uplink-codexstart-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "codex"), `#!${process.execPath}\nimport(${JSON.stringify(join(import.meta.dirname, "tools/codex.mjs"))});\n`);
    await chmod(join(dir, "bin", "codex"), 0o755);
    const logFile = join(dir, "codex.log");
    const wrapper = spawn(process.execPath, [...BRIDGE_CLI.slice(1), "codex", "--", join(dir, "bin", "codex")], {
      env: {
        ...process.env,
        UPLINK_NO_TELEMETRY: "1",
        UPLINK_TERMINAL_REF: "run-1",
        UPLINK_TERMINAL_SECRET: SECRET,
        UPLINK_BRIDGE_SOCKET: join(dir, "no-bridge.sock"),
        FAKE_CODEX_LOG: logFile,
        FAKE_CODEX_START_DELAY_MS: "60000",
      },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => wrapper.on("exit", (code) => resolve(code)));
    // The server runs, and hasn't opened its socket yet.
    const serverPid = async () => {
      const lines = await readFile(logFile, "utf8").catch(() => "");
      return lines.trim() ? lines.trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.role === "server")?.pid : undefined;
    };
    await expect.poll(serverPid, { timeout: 10_000 }).toBeTypeOf("number");
    const pid = (await serverPid()) as number;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    cleanups.push(async () => void (alive() && process.kill(pid, "SIGKILL")));
    wrapper.kill("SIGHUP");
    await expect.poll(alive, { timeout: 5000 }).toBe(false);
    // The wrapper ends as the hangup would have ended it.
    expect(await exited).toBe(129);
  },
);

test("codex commands that don't open a session, or that pick their own server, run unchanged", () => {
  for (const args of [["exec", "fix it"], ["login"], ["--no-daemon"], ["--remote", "ws://127.0.0.1:4500"], ["-m", "x", "mcp", "list"], ["--version"]])
    expect(codexRunsOwnServer(args)).toBe(false);
  for (const args of [[], ["fix the tests"], ["-m", "gpt-6-luna", "-c", "model_reasoning_effort=\"low\""], ["resume", "--last"], ["-s", "read-only", "fork"]])
    expect(codexRunsOwnServer(args)).toBe(true);
});

test("a relayed say carries the files the command read (ADR 0047), and one naming files wrongly posts nothing", () => {
  const files = [{ path: "/work/render.png", size: 9, sha256: "a".repeat(64) }];
  expect(relayedRequests(SECRET, relayRequest(SECRET, { in: "#general", text: "", files }))).toEqual([
    { nonce: expect.any(String), in: "#general", text: "", files },
  ]);
  const wrong = relayRequest(SECRET, { in: "#general", text: "", files: [{ path: "/work/render.png", size: 9, sha256: "nope" }] });
  expect(relayedRequests(SECRET, wrong)).toEqual([]);
});
