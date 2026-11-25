// A stand-in `codex` for the bridge's tests (ADR 0038). Each run appends a JSON line to FAKE_CODEX_LOG.
//
//   codex app-server --listen unix://SOCK -c ...   serve the fake app server on SOCK, list the hooks its
//                                                  -c values give with `hooks/list` as Codex 0.166.0 does,
//                                                  and run the trusted ones as Codex runs them (the
//                                                  command in `sh -c`, the event's JSON on stdin)
//   codex --remote unix://SOCK ARGS...             the terminal UI on that server: write "tui ready",
//                                                  then for each line typed run a turn (UserPromptSubmit,
//                                                  then Stop), and exit at "quit"
//   codex OTHER...                                 write "plain codex" and its arguments, and exit
//
// FAKE_CODEX_HASHING=other makes the server hash hooks differently from the bridge, as a later Codex
// might; FAKE_CODEX_NO_HOOKS_LIST=1 makes it lack `hooks/list`; FAKE_CODEX_START_DELAY_MS delays its socket.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CodexAppServer } from "@uplink-room/protocol/codexAppServer";
import { FakeCodexServer } from "./fakeCodexServer.ts";
import { overridesIn, sessionFlags } from "./codexConfig.ts";
import { codexHookHash } from "../../src/codexHooks.ts";

const args = process.argv.slice(2);
const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + "\n");
const pick = (names) => Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
const label = (event) => event.replace(/[A-Z]/g, (letter, at) => (at ? "_" : "") + letter.toLowerCase());

/** The session-flags hooks as `hooks/list` reports them, with their hash and whether `hooks.state` trusts it. */
function listHooks(hooks) {
  const listed = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === "state" || !Array.isArray(groups)) continue;
    groups.forEach((group, g) =>
      (group.hooks ?? []).forEach((handler, h) => {
        const key = `/<session-flags>/config.toml:${label(event)}:${g}:${h}`;
        let currentHash = codexHookHash(event, { command: handler.command, timeout: handler.timeout, matcher: group.matcher });
        if (process.env.FAKE_CODEX_HASHING === "other") currentHash = "sha256:" + createHash("sha256").update(`other ${currentHash}`).digest("hex");
        const trusted = hooks.state?.[key]?.trusted_hash;
        const trustStatus = trusted === currentHash ? "trusted" : trusted ? "modified" : "untrusted";
        listed.push({ key, eventName: label(event), handlerType: "command", command: handler.command, source: "sessionFlags", enabled: true, currentHash, trustStatus });
      }),
    );
  }
  return listed;
}

if (args[0] === "app-server") {
  const socket = args[args.indexOf("--listen") + 1].slice("unix://".length);
  const hooks = listHooks(sessionFlags(overridesIn(args)).hooks ?? {});
  const run = (event, more = {}) => {
    let stdout = "";
    for (const hook of hooks.filter((h) => h.eventName === label(event) && h.trustStatus === "trusted")) {
      const done = spawnSync("/bin/sh", ["-c", hook.command], { input: JSON.stringify({ session_id: "thr-1", hook_event_name: event, ...more }), encoding: "utf8" });
      stdout += done.stdout;
    }
    return stdout;
  };
  process.on("SIGTERM", () => {
    log({ role: "server-stopped" });
    process.exit(0);
  });
  log({ role: "server", pid: process.pid, args, env: pick(["UPLINK_TERMINAL_REF", "UPLINK_CODEX_RELAY"]) });
  // A server slow to open its socket, as Codex is while it loads.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CODEX_START_DELAY_MS ?? 0)));
  const server = await FakeCodexServer.listen(socket);
  if (process.env.FAKE_CODEX_NO_HOOKS_LIST !== "1") server.hooksList = () => ({ data: [{ cwd: process.cwd(), hooks, warnings: [], errors: [] }] });
  server.onCall = (call) => {
    if (call.method === "fake/turn" || call.method === "turn/start") {
      run("UserPromptSubmit", { turn_id: "turn-1", prompt: call.params.text ?? call.params.input?.[0]?.text });
      log({ role: "turn", text: call.params.text ?? call.params.input?.[0]?.text, stop: run("Stop", { turn_id: "turn-1" }) });
      server.turn = { id: "turn-1", status: "completed" };
    }
  };
} else if (args[0] === "--remote") {
  const socket = args[1].slice("unix://".length);
  log({ role: "tui", args });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("tui ready\n");
  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "quit") process.exit(0);
      const server = await CodexAppServer.open(socket);
      await server.call("fake/turn", { text: line });
      server.close();
      process.stdout.write("turn done\n");
    }
  });
} else {
  log({ role: "plain", args });
  process.stdout.write(`plain codex ${JSON.stringify(args)}\n`);
}
