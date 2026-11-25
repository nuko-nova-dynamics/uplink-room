/**
 * A Hermes Agent run in a bridge terminal (ADR 0040, slice 8 of #139). `hermes` (v0.23.0) runs every
 * session on its profile's gateway, and its classic CLI records which session each terminal runs in
 * a breadcrumb named after the terminal's tty. The bridge reads the breadcrumb for its own terminal,
 * attaches to that session on the gateway as one more client, reports the run's state from the
 * session's events, and puts the room's messages in: `session.steer` during a turn, `prompt.submit`
 * when idle. The run answers with a launcher the bridge writes for that terminal.
 */
import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_FEATURES, type BridgeMessage, type RoomMessage, type RunSaid, type RunSay } from "@uplink-room/protocol";
import type { RunDelivery, RunMessageClaim, RunMessageClaimRequest } from "@uplink-room/protocol/runMessages";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { LocalSocket } from "../src/localSocket.ts";
import { quoteCommand, socketPathFor } from "../src/platform.ts";
import { HermesAdapter } from "../src/adapters/hermes.ts";
import { FileServer } from "./tools/fileServer.ts";
import { FakeHermesGateway } from "./tools/fakeHermesGateway.ts";
import { hermesHome } from "../src/hermesGateway.ts";

/** A room that takes run messages and hands them over at a claim, as in codex.test.ts. */
class Room implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void;
  waiting: RunDelivery[] = [];
  claims: RunMessageClaimRequest[] = [];
  said: RunSay[] = [];
  send(message: BridgeMessage) {
    this.messages.push(message);
    return { features: [...ROOM_FEATURES] };
  }
  async say(request: RunSay): Promise<RunSaid> {
    this.said.push(request);
    return { messageId: "msg-new", label: "Hermes Agent (Julio)", place: request.replyTo ? "a thread in #payments" : (request.in ?? "") };
  }
  onMessage(handler: (message: RoomMessage) => void) {
    this.handler = handler;
  }
  async claimRunMessages(request: RunMessageClaimRequest): Promise<RunMessageClaim> {
    this.claims.push(request);
    const deliveries = this.waiting.splice(0);
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
const BRIDGE_CLI = [process.execPath, join(import.meta.dirname, "../src/bin.ts")];

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
 * A fake `hermes`: like Hermes's classic CLI it writes this terminal's breadcrumb, named after the
 * tty as `hermes_cli/terminal_breadcrumbs.py` names it (`/dev/ttys004` → `tty-dev-ttys004`), with the
 * session it runs, then waits. `crumb` holds the session id the breadcrumb names.
 */
async function fakeHermes(dir: string) {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const program = join(bin, "hermes");
  await writeFile(
    program,
    [
      "#!/bin/sh",
      't=$(tty)',
      `n=$(printf %s "\${t#/}" | tr -c 'A-Za-z0-9._-' '-')`,
      'mkdir -p "$HERMES_HOME/terminal-sessions"',
      `printf '{"session_id": "%s", "cwd": "/tmp", "ts": 1}' "$(cat "${join(dir, "crumb")}")" > "$HERMES_HOME/terminal-sessions/tty-$n"`,
      `exec ${quoteCommand([process.execPath, join(import.meta.dirname, "tools/term.mjs"), "idle"])}`,
      "",
    ].join("\n"),
  );
  await chmod(program, 0o755);
  return program;
}

/** A bridge with its local socket, a fake Hermes gateway, and a terminal `run-1` the room started with `hermes`. */
async function setup({ session = "sess-1", crumb = session }: { session?: string; crumb?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "uplink-hermes-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "hh");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const gateway = await FakeHermesGateway.listen(home);
  cleanups.push(() => gateway.close());
  gateway.sessions.set(session, { running: false, generation: 0 });
  await writeFile(join(dir, "crumb"), crumb);
  const program = await fakeHermes(dir);
  const room = new Room();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 2, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    adapters: [new HermesAdapter()],
    env: { HERMES_HOME: home },
    hermes: { dir: join(dir, "bridge-hermes"), bridgeCommand: BRIDGE_CLI, pollMs: 50 },
  });
  cleanups.push(() => bridge.close());
  const socketPath = socketPathFor(dir);
  const socket = new LocalSocket(socketPath, bridge);
  await socket.start();
  cleanups.push(() => socket.close());
  await bridge.start();
  room.deliver({ v: 1, type: "start_terminal", terminalId: "run-1", command: quoteCommand([program]), startedBy: driver, access: "suggest", usesSlot: false, cwd: dir });
  await expect.poll(() => room.of("terminal_started").length).toBe(1);
  return { room, bridge, dir, home, gateway, socketPath };
}

const states = (room: Room) => room.of("run_state_changed").map((m) => m.state);

// Hermes's gateway clients find it through a Unix control socket; the bridge leaves Windows out (ADR 0040).
const windows = process.platform === "win32";

test.skipIf(windows)("the session's events on Hermes's gateway report the run's state: Working in a turn, Waiting on an approval, Done or Failed at its end", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").map((c) => c.params.session_id)).toContain("sess-1");
  expect(room.of("terminal_started")[0]).toMatchObject({ tool: "hermes-agent" });
  gateway.startTurn("sess-1");
  gateway.emit("sess-1", "tool.start", { tool_name: "terminal" });
  gateway.emit("sess-1", "approval.request", { prompt_id: "p1", command: "rm -rf build", description: "recursive delete", choices: ["once", "deny"] });
  gateway.emit("sess-1", "approval.settled", { prompt_id: "p1" });
  gateway.endTurn("sess-1");
  gateway.startTurn("sess-1");
  gateway.endTurn("sess-1", "failed");
  await expect.poll(() => states(room)).toEqual(["unknown", "working", "working", "waiting", "working", "done", "working", "failed"]);
  // The room can't answer a Hermes approval yet: the person answers it in the terminal.
  expect(room.of("run_state_changed")[3]!.prompt).toEqual({ kind: "question", text: "recursive delete: rm -rf build. Answer it in the terminal." });
  expect(room.of("run_hearing")).toEqual([{ v: 1, type: "run_hearing", source: { kind: "terminal", terminalId: "run-1" }, hearing: "mid_task" }]);
});

test.skipIf(windows)("a message to an idle session starts a turn with prompt.submit, and the room hears it was delivered at the next turn", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toEqual([{ v: 1, type: "run_message_result", claimId: "claim-1", deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
  expect(room.claims).toEqual([expect.objectContaining({ terminalRef: "run-1", how: "next_turn" })]);
  const [submit] = gateway.of("prompt.submit");
  expect(submit!.params).toMatchObject({ session_id: "sess-1", submission_id: "claim-1" });
  expect(submit!.params.text).toContain("Message msg-d1 in #payments, from Ana, a person.");
  // The reply hint names the terminal's own launcher, not `uplink-bridge` on PATH.
  expect(submit!.params.text).toMatch(/This run can answer a message with: '[^']*\/bridge-hermes\/[^']+\/uplink-bridge' reply <message id> "text"\./);
  expect(gateway.of("session.steer")).toEqual([]);
});

test.skipIf(windows)("during a turn a message goes in with session.steer, so the turn goes on; one whose turn ended meanwhile starts the next with prompt.submit", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  gateway.startTurn("sess-1");
  await expect.poll(() => states(room)).toContain("working");
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "mid_task" }]);
  expect(gateway.of("session.steer").map((c) => c.params)).toEqual([
    { session_id: "sess-1", execution_generation: 1, text: expect.stringContaining("Message msg-d1") },
  ]);
  expect(gateway.of("prompt.submit")).toEqual([]);
  expect(room.claims.at(-1)).toMatchObject({ how: "mid_task" });

  // The turn ends after the bridge saw it running: the gateway refuses the steer, and the message starts a turn.
  gateway.onCall = (call) => {
    if (call.method === "session.steer") gateway.sessions.get("sess-1")!.running = false;
  };
  room.post(message("d2"));
  await expect.poll(() => room.of("run_message_result").length).toBe(2);
  expect(room.of("run_message_result")[1]).toMatchObject({ deliveryIds: ["d2"], status: "delivered", how: "next_turn" });
  expect(gateway.of("prompt.submit")).toHaveLength(1);
});

test.skipIf(windows)("a message's image is attached with image.attach before its prompt, even during a turn, which a steer can't carry (ADR 0043)", async () => {
  const { room, dir, gateway } = await setup();
  const files = await FileServer.start();
  cleanups.push(() => files.close());
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  gateway.startTurn("sess-1");
  await expect.poll(() => states(room)).toContain("working");
  room.post({ ...message("d1"), attachments: 1, files: [files.add("chart.png", "png-bytes", "image/png")] });
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered" }]);
  const path = join(dir, ".uplink-room", "files", "d1", "chart.png");
  expect(gateway.of("session.steer")).toEqual([]);
  expect(gateway.calls.filter((c) => c.method === "image.attach" || c.method === "prompt.submit").map((c) => c.method)).toEqual(["image.attach", "prompt.submit"]);
  expect(gateway.of("image.attach")[0]!.params).toEqual({ session_id: "sess-1", path });
  expect(gateway.of("prompt.submit")[0]!.params.text).toContain(`- ${path}`);
});

test.skipIf(windows)("Hermes's commands answer with the terminal's launcher, which posts as the terminal's run", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  room.post(message("d1"));
  await expect.poll(() => gateway.of("prompt.submit").length).toBe(1);
  const launcher = /answer a message with: '([^']+)' reply/.exec(gateway.of("prompt.submit")[0]!.params.text)![1]!;
  // Hermes runs the command in its gateway, without the terminal's UPLINK_* variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("UPLINK_")));
  const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(launcher, ["reply", "msg-d1", "released it"], { env });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => resolve({ code, stdout }));
  });
  expect(out.code).toBe(0);
  expect(room.said).toEqual([{ terminalRef: "run-1", text: "released it", replyTo: "msg-d1" }]);
});

test.skipIf(windows)("the bridge removes the terminal's launcher when the terminal ends", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  room.post(message("d1"));
  await expect.poll(() => gateway.of("prompt.submit").length).toBe(1);
  const launcher = /answer a message with: '([^']+)' reply/.exec(gateway.of("prompt.submit")[0]!.params.text)![1]!;
  await readFile(launcher);
  room.deliver({ v: 1, type: "stop_terminal", terminalId: "run-1" });
  await expect.poll(() => room.of("terminal_ended").length).toBe(1);
  await expect.poll(() => readFile(launcher).then(() => "there", () => "gone")).toBe("gone");
});

test.skipIf(windows)("the bridge follows the session the terminal's breadcrumb names: past a provisional id, and to a new session after /new", async () => {
  // Hermes's classic CLI first records an id the gateway doesn't know, then the session once it exists.
  const { room, gateway, home } = await setup({ session: "sess-1", crumb: "20261105_211320_b0e068" });
  await expect.poll(() => gateway.of("session.resume").map((c) => c.params.session_id)).toContain("20261105_211320_b0e068");
  const [name] = await readdir(join(home, "terminal-sessions"));
  const crumb = join(home, "terminal-sessions", name!);
  expect(name).toMatch(/^tty-dev-/);
  await writeFile(crumb, JSON.stringify({ session_id: "sess-1" }));
  await expect.poll(() => gateway.of("session.resume").map((c) => c.params.session_id)).toContain("sess-1");
  // A received resume call precedes the bridge applying its answer. Wait for attachment.
  await expect.poll(() => room.of("run_hearing").length).toBeGreaterThan(0);
  gateway.startTurn("sess-1");
  await expect.poll(() => states(room)).toEqual(["unknown", "working"]);

  // `/new`: the breadcrumb names a new session; the old one's events say nothing about this run now.
  gateway.sessions.set("sess-2", { running: false, generation: 0 });
  await writeFile(crumb, JSON.stringify({ session_id: "sess-2" }));
  await expect.poll(() => gateway.of("session.resume").map((c) => c.params.session_id)).toContain("sess-2");
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
  expect(gateway.of("prompt.submit").map((c) => c.params.session_id)).toEqual(["sess-2"]);
  // The old session's turn ends, then the new one's starts: only the new one's counts.
  gateway.endTurn("sess-1");
  gateway.startTurn("sess-2");
  await expect.poll(() => states(room)).toEqual(["unknown", "working", "working"]);
});

test.skipIf(windows)("a message posted before the session exists waits, and goes in once the bridge follows the session", async () => {
  const { room, gateway, home } = await setup({ session: "sess-1", crumb: "provisional" });
  room.post(message("d1"));
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(1);
  expect(gateway.of("prompt.submit")).toEqual([]);
  const [name] = await readdir(join(home, "terminal-sessions"));
  await writeFile(join(home, "terminal-sessions", name!), JSON.stringify({ session_id: "sess-1" }));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
});

test.skipIf(windows)("a submit whose answer was lost is asked again with the same submission id, so the message goes in once", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  // The gateway admits the first submit, then the connection closes before its answer.
  gateway.onCall = (call) => {
    if (call.method === "prompt.submit") gateway.dropAfter[gateway.of("prompt.submit").length === 1 ? "add" : "delete"]("prompt.submit");
  };
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "delivered", how: "next_turn" }]);
  expect(gateway.of("prompt.submit").map((c) => c.params.submission_id)).toEqual(["claim-1", "claim-1"]);
  expect(gateway.admitted.size).toBe(1);
});

test.skipIf(windows)("a message Hermes refuses goes back to wait, and the bridge tries again", async () => {
  const { room, gateway } = await setup();
  await expect.poll(() => gateway.of("session.resume").length).toBeGreaterThan(0);
  gateway.failing.set("prompt.submit", "queue_full");
  room.post(message("d1"));
  await expect.poll(() => room.of("run_message_result")).toMatchObject([{ deliveryIds: ["d1"], status: "released" }]);
  room.waiting.push(message("d1"));
  gateway.failing.clear();
  await expect.poll(() => room.of("run_message_result").at(-1), { timeout: 5000 }).toMatchObject({ deliveryIds: ["d1"], status: "delivered", how: "next_turn" });
});

test("a terminal's hermes uses HERMES_HOME, else the profile its command names, else the sticky active profile, else ~/.hermes", async () => {
  const home = await mkdtemp(join(tmpdir(), "uplink-hermes-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".hermes");
  expect(hermesHome({ HERMES_HOME: "/elsewhere" }, "hermes -p coder", home)).toBe("/elsewhere");
  expect(hermesHome({}, "hermes", home)).toBe(root);
  expect(hermesHome({}, "hermes -p coder", home)).toBe(join(root, "profiles", "coder"));
  expect(hermesHome({}, "hermes --profile=coder", home)).toBe(join(root, "profiles", "coder"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "active_profile"), "writer\n");
  expect(hermesHome({}, "hermes", home)).toBe(join(root, "profiles", "writer"));
  expect(hermesHome({}, "hermes -p default", home)).toBe(root);
});
