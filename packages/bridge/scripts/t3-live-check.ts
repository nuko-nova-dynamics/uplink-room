/**
 * A live check of the bridge against a real T3 Code server that touches nothing of the person's
 * own T3 Code: an isolated `t3 serve` on a temporary data folder, a temporary HOME, its own port, and
 * a minimal environment (no T3CODE_* variables from the shell it runs in). Its only provider is the
 * scripted ACP agent in test/tools/scriptedAcp.mjs, so no model, login or network is used. `codex`,
 * `claude` and `gh` on its PATH are stubs that fail, so T3's title generation can't reach the local
 * Codex CLI. Everything is deleted at the end.
 *
 *   node scripts/t3-live-check.ts <out folder> [phase ...]
 *
 * Phases: `access` (ADR 0021: pairing status, thread access and the wheel, approvals, revoking in
 * Settings and with the CLI), `view` (ADR 0022: a thread's items, a diff, older history, and T3
 * Code's stream recorded to <out>/t3-thread-stream.json) and `messages` (ADR 0023: messages from the
 * room, one queued behind a busy turn, stopping a turn, and a question answered). Writes
 * <out>/<phase>.json: every bridge message and what the check saw.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ROOM_FEATURES, type BridgeMessage, type RoomMessage } from "@uplink-room/protocol";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { T3CodeAdapter } from "../src/adapters/t3code.ts";
import { T3Rpc, exchangePairingToken, type T3Session } from "../src/adapters/t3client.ts";

const run = promisify(execFile);
const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/t3-live-check.ts <out folder> [phase ...]");
const phases = process.argv.slice(3).length ? process.argv.slice(3) : ["access"];
const PORT = Number(process.env.T3_LIVE_PORT ?? 39781);
const url = `http://127.0.0.1:${PORT}`;
const agent = resolve(import.meta.dirname, "../test/tools/scriptedAcp.mjs");

await mkdir(out, { recursive: true });
const tmp = await mkdtemp(join(tmpdir(), "uplink-t3-live-"));
const home = join(tmp, "home");
const base = join(tmp, "base");
const repo = join(tmp, "repo");
const stub = join(tmp, "stub-bin");
for (const dir of [home, base, repo, stub]) await mkdir(dir, { recursive: true });
for (const tool of ["codex", "claude", "gh", "opencode"]) {
  await writeFile(join(stub, tool), "#!/bin/sh\necho 'stubbed for the isolated live check' >&2\nexit 1\n");
  await chmod(join(stub, tool), 0o755);
}
/** The isolated server's environment, built from scratch so nothing points at the person's own T3 Code. */
const env: NodeJS.ProcessEnv = {
  HOME: home,
  PATH: `${stub}:${process.env.PATH}`,
  TMPDIR: join(tmp, "t"),
  LANG: "en_US.UTF-8",
  USER: process.env.USER,
  SHELL: "/bin/sh",
  T3CODE_TELEMETRY_ENABLED: "false",
  OTEL_SDK_DISABLED: "true",
  SCRIPTED_ACP_LOG: join(tmp, "agent.log"),
};
await mkdir(env.TMPDIR!, { recursive: true });
const t3 = (...args: string[]) => run("t3", [...args, "--base-dir", base], { env }).then((r) => r.stdout);
await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
await writeFile(join(repo, "README.md"), "# Live check\n");
await run("git", ["-c", "user.email=live@example.com", "-c", "user.name=Live", "add", "."], { cwd: repo, env });
await run("git", ["-c", "user.email=live@example.com", "-c", "user.name=Live", "commit", "-qm", "start"], { cwd: repo, env });

let server: ChildProcess | undefined;
const startServer = async () => {
  server = spawn("t3", ["serve", "--base-dir", base, "--port", String(PORT), "--host", "127.0.0.1", "--no-browser", repo], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  server.stderr?.on("data", (d) => (errors = (errors + String(d)).slice(-4000)));
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`${url}/api/auth/websocket-ticket/rpc`, { method: "POST" }).then(
      () => true,
      () => false,
    );
    if (up) return;
    await sleep(500);
  }
  throw new Error(`t3 serve didn't start: ${errors}`);
};
const stopServer = async () => {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((done) => server!.once("exit", done));
  server.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
};
function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}
async function until<T>(what: string, check: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}
/** A one-time pairing token for a session with `scopes` (all of them when empty). */
async function pairingToken(scopes: string[]) {
  const printed = await t3("auth", "pairing", "create", "--ttl", "5m", "--json", ...scopes.flatMap((s) => ["--scope", s]));
  return (JSON.parse(printed) as { credential: string }).credential;
}
/** A setup session with `scopes`, for the check's own calls; the bridge never holds one. */
async function setupSession(scopes: string[]): Promise<T3Session> {
  const response = await fetch(`${url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: await pairingToken(scopes),
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: scopes.join(" "),
      client_label: "Uplink Room live check setup",
      client_device_type: "bot",
    }).toString(),
  });
  if (!response.ok) throw new Error(`setup exchange: ${response.status} ${await response.text()}`);
  return { url, token: ((await response.json()) as { access_token: string }).access_token };
}

/** The room side: records what the bridge sends and answers as a room from ADR 0021 on. */
class RecordingRoom implements RoomLink {
  messages: (BridgeMessage & { at: number })[] = [];
  handler?: (message: RoomMessage) => void | Promise<void>;
  send(message: BridgeMessage) {
    this.messages.push({ ...message, at: Date.now() });
    return { features: [...ROOM_FEATURES] };
  }
  onMessage(handler: (message: RoomMessage) => void | Promise<void>) {
    this.handler = handler;
  }
  deliver(message: RoomMessage) {
    return this.handler!(message);
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m) => m.type === type) as unknown as Extract<BridgeMessage, { type: T }>[];
  }
}

const notes: string[] = [];
const note = (line: string) => {
  notes.push(line);
  console.log(line);
};
let bridge: Bridge | undefined;
try {
  await startServer();
  note(`isolated T3 Code ${(await run("t3", ["--version"], { env })).stdout.trim()} on ${url}`);
  // Setup only: an all-scope session adds the scripted provider. The bridge never holds it.
  const setup = await T3Rpc.connect(await setupSession(["orchestration:read", "settings:write", "providers:manage"]));
  await setup.request("server.updateSettings", {
    patch: {},
    providerInstanceMutation: {
      operation: "create",
      instanceId: "scripted",
      instance: {
        driver: "acpRegistry",
        displayName: "Scripted",
        config: { source: "local", commandPath: process.execPath, commandArgs: [agent], customModels: ["scripted-1"] },
      },
    },
  });
  await t3("project", "add", repo, "--title", "Live check").catch((error: Error) => note(`project add: ${error.message.split("\n")[0]}`));
  const providerReady = async () => {
    const config = (await setup.request("server.getConfig", {})) as { providers: { instanceId: string; status: string; models: unknown[] }[] };
    return config.providers.find((p) => p.instanceId === "scripted");
  };
  for (let i = 0; i < 60; i++) {
    const p = await providerReady();
    if (p && p.status !== "error" && p.models.length) break;
    await sleep(500);
  }
  note(`scripted provider: ${JSON.stringify(await providerReady())}`);

  let saved: T3Session = await exchangePairingToken(url, await pairingToken(["orchestration:read", "orchestration:operate"]));
  const room = new RecordingRoom();
  const driver = { memberId: "julio", name: "Julio" };
  const teammate = { memberId: "ana", name: "Ana" };
  bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "drive", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(tmp, "bridge-profiles"),
    linkedBy: driver.memberId,
    adapters: [
      new T3CodeAdapter({ session: saved, project: repo, retryMs: 1000, loadSession: async () => saved, sessionPollMs: 1000 }),
    ],
  });
  await bridge.start();
  const status = () => room.of("t3_status").at(-1);
  await until("t3_status connected", () => status()?.state === "connected");
  note(`t3_status: ${JSON.stringify(status())}`);

  if (phases.includes("messages")) {
    // ADR 0023: messages from the room, a message queued behind a busy turn, stopping a turn, and a question.
    await room.deliver({ v: 1, type: "start_thread", runId: "msg-1", harness: "scripted", startedBy: driver, cwd: repo, prompt: "hello" });
    const threadId = (await until("thread_bound", () => room.of("thread_bound").find((m) => m.runId === "msg-1"))).threadRef;
    const reports = () => room.of("run_state_changed").filter((m) => m.source.kind === "thread" && m.source.threadRef === threadId);
    const result = (id: string) => until(`thread_message_result ${id}`, () => room.of("thread_message_result").find((m) => m.messageId === id), 30_000);
    await until("first turn done", () => reports().find((m) => m.state === "done"), 60_000);
    const say = (messageId: string, text: string, from = driver) => room.deliver({ v: 1, type: "send_thread_message", threadRef: threadId, messageId, from, text });
    await say("m-other", "from a teammate", teammate);
    note(`a teammate's message: ${(await result("m-other")).error}`);
    const doneBefore = reports().filter((m) => m.state === "done").length;
    await say("m1", "Probe: a follow-up from the room");
    const r1 = await result("m1");
    note(`idle thread: ${r1.status}${r1.error ? ` (${r1.error})` : ""}`);
    if (r1.status === "failed") throw new Error(`message.dispatch failed: ${r1.error}`);
    await until("the follow-up's turn done", () => reports().filter((m) => m.state === "done").length > doneBefore, 60_000);
    await say("m2", "SLOW please");
    const r2 = await result("m2");
    note(`slow message: ${r2.status}${r2.error ? ` (${r2.error})` : ""}`);
    await until("working", () => reports().at(-1)?.state === "working", 30_000);
    await sleep(1500);
    await say("m3", "queued behind the slow one");
    const r3 = await result("m3");
    note(`while busy: ${r3.status}${r3.error ? ` (${r3.error})` : ""}`);
    await room.deliver({ v: 1, type: "interrupt_thread", threadRef: threadId, from: driver });
    const stopped = await until("stopped", () => reports().slice(-6).find((m) => m.state === "stopped"), 30_000).catch(() => undefined);
    note(`after interrupt_thread: ${stopped ? "reported stopped" : "the queued message's turn started at once"}; states since: ${reports().slice(-6).map((m) => m.state).join(" → ")}`);
    await sleep(6000);
    note(`after the queued message's turn: ${reports().slice(-4).map((m) => m.state).join(" → ")}`);
    // A question: the scripted agent asks with ACP's form elicitation.
    await say("m4", "ASK me");
    const asked = await until("a question", () => reports().find((m) => m.state === "waiting" && m.prompt?.kind === "question"), 60_000).catch(() => undefined);
    note(`question prompt: ${JSON.stringify(asked?.prompt)}`);
    if (asked?.prompt?.promptId && asked.prompt.questions?.length) {
      const q = asked.prompt.questions[0]!;
      await room.deliver({ v: 1, type: "answer_question", threadRef: threadId, from: teammate, promptId: asked.prompt.promptId, answers: { [q.id]: q.options[0]!.label } });
      note(`a teammate's answer: ${room.of("input_rejected").at(-1)?.reason}`);
      await room.deliver({ v: 1, type: "watch_thread", threadRef: threadId });
      await room.deliver({ v: 1, type: "answer_question", threadRef: threadId, from: driver, promptId: asked.prompt.promptId, answers: { [q.id]: q.options[0]!.label } });
      // The agent says what came back, so this is what reached it.
      const reply = await until(
        "the agent's reply to the answer",
        () => room.of("thread_items").flatMap((m) => m.items).findLast((i) => i.role === "assistant" && i.text?.includes("Question answer:") && !i.streaming),
        60_000,
      );
      note(`the agent got: ${reply.text?.slice(0, reply.text.indexOf(". ") + 1)}`);
      await room.deliver({ v: 1, type: "unwatch_thread", threadRef: threadId });
    }
    // What the agent got: the room's items for the thread, through the bridge.
    await room.deliver({ v: 1, type: "watch_thread", threadRef: threadId });
    await until("thread_items", () => room.of("thread_items").find((m) => m.threadRef === threadId && m.reset));
    const latest = new Map<string, import("@uplink-room/protocol").ThreadItem>();
    for (const batch of room.of("thread_items").filter((m) => m.threadRef === threadId)) for (const item of batch.items) latest.set(item.itemId, item);
    const shown = [...latest.values()].sort((a, b) => a.order - b.order);
    for (const item of shown.filter((i) => i.kind === "message" || i.kind === "request" || i.kind === "notice"))
      note(`  ${item.kind}${item.role ? `/${item.role}` : ""}${item.request ? `/${item.request}:${item.outcome ?? "pending"}` : ""}${item.messageRef ? ` [${item.messageRef}]` : ""}: ${(item.text ?? "").slice(0, 110).replaceAll("\n", " ")}`);
    await room.deliver({ v: 1, type: "unwatch_thread", threadRef: threadId });
    await writeFile(join(out, "messages.json"), JSON.stringify({ notes, messages: room.messages }, null, 2));
  }

  if (phases.includes("view")) {
    // ADR 0022: a thread's items through the real bridge, and T3 Code's own stream recorded.
    await room.deliver({ v: 1, type: "start_thread", runId: "view-1", harness: "scripted", startedBy: driver, cwd: repo, prompt: "APPROVE then PLAN and TOOLS" });
    const bound = await until("thread_bound", () => room.of("thread_bound").find((m) => m.runId === "view-1"));
    const threadId = bound.threadRef;
    const reports = () => room.of("run_state_changed").filter((m) => m.source.kind === "thread" && m.source.threadRef === threadId);
    // Record what T3 Code streams for this thread, from before the agent starts working.
    const recorder = await T3Rpc.connect(saved);
    const raw: unknown[] = [];
    const recording = recorder.subscribe("orchestration.subscribeThread", { threadId, acceptBoundedSnapshot: true }, (value) => raw.push(value));
    await room.deliver({ v: 1, type: "watch_thread", threadRef: threadId });
    const waiting = await until("an approval", () => reports().find((m) => m.state === "waiting" && m.prompt?.promptId), 60_000);
    await room.deliver({ v: 1, type: "answer_prompt", source: { kind: "thread", threadRef: threadId }, from: driver, promptId: waiting.prompt!.promptId!, answer: "allow" });
    await until("done", () => reports().find((m) => m.state === "done"), 60_000);
    await sleep(1500);
    const sent = room.of("thread_items").filter((m) => m.threadRef === threadId);
    const latest = new Map<string, import("@uplink-room/protocol").ThreadItem>();
    for (const batch of sent) for (const item of batch.items) latest.set(item.itemId, item);
    const kinds = [...latest.values()].sort((a, b) => a.order - b.order).map((i) => (i.kind === "tool" ? `tool:${i.tool}` : i.kind === "request" ? `request:${i.request}:${i.outcome ?? "pending"}` : i.kind));
    note(`thread_items: ${sent.length} messages, first reset ${sent[0]?.reset === true}; items now: ${kinds.join(", ")}`);
    const checkpoint = [...latest.values()].find((i) => i.kind === "checkpoint");
    note(`checkpoint: ${JSON.stringify(checkpoint)}`);
    if (checkpoint?.turn !== undefined) {
      await room.deliver({ v: 1, type: "thread_diff_request", threadRef: threadId, requestId: "diff-1", turn: checkpoint.turn });
      const diff = await until("thread_diff", () => room.of("thread_diff").find((m) => m.requestId === "diff-1"));
      note(`thread_diff for turn ${checkpoint.turn}: ${diff.error ?? diff.diff?.split("\n").slice(0, 2).join(" | ")}`);
    }
    // T3 Code's history route with a cursor naming an item: the items before it.
    const items = [...latest.values()].sort((a, b) => a.order - b.order);
    const last = items.at(-1)!;
    const cursor = Buffer.from(JSON.stringify({ v: 1, seq: 0, st: threadId, si: last.itemId, p: 0 })).toString("base64url");
    const history = await fetch(`${url}/api/orchestration/threads/${encodeURIComponent(threadId)}/history?cursor=${cursor}`, {
      headers: { authorization: `Bearer ${saved.token}`, "x-t3-orchestration-protocol": "2" },
    });
    const page = history.ok ? ((await history.json()) as { items: { item: { id: string } }[]; hasMoreHistory: boolean }) : undefined;
    note(`history before ${last.itemId}: HTTP ${history.status}, ${page ? `${page.items.length} items, last ${page.items.at(-1)?.item.id}, hasMoreHistory ${page.hasMoreHistory}` : await history.text()}`);
    await room.deliver({ v: 1, type: "thread_history", threadRef: threadId, requestId: "h-1", beforeItemId: last.itemId });
    const bridgePage = await until("thread_history_page", () => room.of("thread_history_page").find((m) => m.requestId === "h-1"));
    note(`bridge history page: ${bridgePage.error ?? `${bridgePage.items.length} items, older ${bridgePage.older}`}`);
    await room.deliver({ v: 1, type: "unwatch_thread", threadRef: threadId });
    recording.cancel();
    recorder.close();
    // The recorded stream, with this run's temporary paths taken out, for the replay test.
    const text = JSON.stringify(raw, null, 1).replaceAll(tmp, "/tmp/live").replaceAll(home, "/tmp/live/home");
    await writeFile(join(out, "t3-thread-stream.json"), text);
    note(`recorded ${raw.length} stream values`);
    await writeFile(join(out, "view.json"), JSON.stringify({ notes, messages: room.messages }, null, 2));
  }

  if (phases.includes("access")) {
    // Launched with Open on a machine that allows Drive: clamped, and the room told.
    await room.deliver({ v: 1, type: "start_thread", runId: "live-1", harness: "scripted", startedBy: driver, cwd: repo, prompt: "APPROVE the probe", access: "open" });
    const bound = await until("thread_bound", () => room.of("thread_bound")[0]);
    const access = await until("thread_access", () => room.of("thread_access")[0]);
    note(`bound ${bound.threadRef}; access clamped to ${access.access}`);
    const reports = () => room.of("run_state_changed").filter((m) => m.source.kind === "thread" && m.source.threadRef === bound.threadRef);
    const waiting = await until("an approval", () => reports().find((m) => m.state === "waiting" && m.prompt?.promptId), 60_000);
    note(`waiting: ${JSON.stringify(waiting.prompt)}`);
    await room.deliver({ v: 1, type: "thread_driver_changed", threadRef: bound.threadRef, driver: teammate });
    await room.deliver({ v: 1, type: "answer_prompt", source: { kind: "thread", threadRef: bound.threadRef }, from: driver, promptId: waiting.prompt!.promptId!, answer: "allow" });
    const refused = await until("not_driver", () => room.of("input_rejected").at(-1));
    note(`old driver's answer: ${refused.reason}`);
    await room.deliver({ v: 1, type: "answer_prompt", source: { kind: "thread", threadRef: bound.threadRef }, from: teammate, promptId: waiting.prompt!.promptId!, answer: "allow" });
    const done = await until("done", () => reports().find((m) => m.state === "done"), 60_000);
    note(`after the new driver's answer: ${done.state}; states ${reports().map((m) => m.state).join(" → ")}`);

    // Revoked in Settings → Sharing & access (POST /api/auth/clients/revoke): the socket closes at once.
    const sessions = JSON.parse(await t3("auth", "session", "list", "--json")) as { sessionId: string; label?: string; client?: { label?: string } }[];
    const ours = () => sessions.filter((s) => JSON.stringify(s).includes("Uplink Room bridge"));
    note(`bridge sessions listed: ${ours().length}`);
    const revokeIn = async (sessionId: string) => {
      const setupToken = (await setupSession(["access:read", "access:write"])).token;
      const response = await fetch(`${url}/api/auth/clients/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${setupToken}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      return `${response.status} ${await response.text()}`;
    };
    const first = ours().at(-1)!;
    note(`Settings revoke: ${await revokeIn(first.sessionId)}`);
    const refusedAt = Date.now();
    await until("needs_pairing", () => status()?.state === "needs_pairing", 30_000);
    note(`t3_status after the Settings revoke (${Date.now() - refusedAt} ms): ${JSON.stringify(status())}`);
    const ticketsBefore = room.of("t3_status").length;
    await sleep(4000);
    note(`status messages in 4 s while refused: ${room.of("t3_status").length - ticketsBefore}`);

    // Paired again while the bridge runs: it uses the new session without a restart.
    saved = await exchangePairingToken(url, await pairingToken(["orchestration:read", "orchestration:operate"]));
    const repairedAt = Date.now();
    await until("connected again", () => status()?.state === "connected", 30_000);
    note(`connected again ${Date.now() - repairedAt} ms after the new pairing was saved`);

    // Revoked with the CLI: the open socket keeps working until the server restarts.
    const listed = JSON.parse(await t3("auth", "session", "list", "--json")) as { sessionId: string }[];
    const current = listed.filter((s) => JSON.stringify(s).includes("Uplink Room bridge")).at(-1)!;
    note(`CLI revoke: ${(await t3("auth", "session", "revoke", current.sessionId)).trim()}`);
    await sleep(15_000);
    const probe = await T3Rpc.connect(saved).then(
      (s) => (s.close(), "a new socket was accepted"),
      (e: Error) => `a new socket was refused: ${e.message}`,
    );
    note(`15 s after the CLI revoke: status ${status()?.state}; ${probe}`);
    await room.deliver({ v: 1, type: "start_thread", runId: "live-2", harness: "scripted", startedBy: driver, cwd: repo, prompt: "hello after the CLI revoke" });
    // `thread_bound` goes before the launch reaches T3 Code, so only a report from the thread says it got there.
    const second = await until(
      "the second thread's report",
      () =>
        room.of("thread_start_failed").find((m) => m.runId === "live-2") ??
        room.of("run_state_changed").find((m) => m.source.kind === "thread" && m.source.threadRef === "uplink-room-live-2"),
      30_000,
    );
    note(`a launch over the open socket after the CLI revoke: ${second.type === "run_state_changed" ? `reported ${second.state}` : `failed: ${second.reason}`}`);
    await stopServer();
    await startServer();
    await until("needs_pairing after the restart", () => status()?.state === "needs_pairing", 60_000);
    note(`after T3 Code restarted: ${JSON.stringify(status())}`);
  }
  await writeFile(join(out, "access.json"), JSON.stringify({ notes, messages: room.messages }, null, 2));
  setup.close();
} finally {
  await bridge?.close().catch(() => {});
  await stopServer();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "notes.txt"), notes.join("\n") + "\n");
  await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
}
