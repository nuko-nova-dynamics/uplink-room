import { hostname, platform } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { RUN_SAY_FILES_MAX, type Access, type RunSaid } from "@uplink-room/protocol";
import { Bridge } from "./bridge.ts";
import { ACK_FIELD } from "./runMessages.ts";
import { ConvexLink } from "./convexLink.ts";
import { bridgeHome, loadConfig, updateConfig, validateLimits, type BridgeConfig } from "./config.ts";
import { LocalSocket, bridgeRunning, localRequest } from "./localSocket.ts";
import { quoteCommand, socketPathFor } from "./platform.ts";
import { defaultAdapters } from "./adapters/index.ts";
import type { T3SharingView } from "./t3Sharing.ts";
import { T3_DEFAULT_URL, pairWithT3 } from "./adapters/t3pair.ts";
import { spacesOption } from "./spaces/setup.ts";
import { consoleCleanup, startHolder } from "./terminal.ts";
import { reportError, setTelemetryMachine } from "./telemetry/sentry.ts";
import { runRexHost } from "./rex/host.ts";
import { bridgeCommand, rexExecutable, rexJson } from "./rex/rexCli.ts";
import { ROOM_SESSION } from "./rex/tabs.ts";
import { readStdin } from "./stdin.ts";
import { runCodexSession } from "./codexSession.ts";
import { RELAY_ENV, relayRequest } from "./codexRelay.ts";
import { describeRunFile } from "./runFiles.ts";
import { installService, serviceActive, serviceStatus, uninstallService } from "./service.ts";

function flag(args: string[], name: string) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
/**
 * A wrapper's own options (`rex-open`, `rex-host`) are only those before `--`; everything after it is
 * the command it runs, whose `--cwd` or `--command` is the command's, never the wrapper's.
 */
export function atSeparator(args: string[]): { own: string[]; words: string[] } {
  const index = args.indexOf("--");
  return index < 0 ? { own: args, words: [] } : { own: args.slice(0, index), words: args.slice(index + 1) };
}

/** `rex-host`'s options: `[--socket S] [--terminal ID] [--user-shell] [--no-color] [--command LINE | -- WORDS...]`. */
export function rexHostArgs(args: string[], socketPath: string) {
  const { own, words } = atSeparator(args);
  return {
    socketPath: flag(own, "--socket") ?? socketPath,
    terminalId: flag(own, "--terminal"),
    command: flag(own, "--command") ?? (words.length ? quoteCommand(words) : undefined),
    userShell: own.includes("--user-shell"),
    noColor: own.includes("--no-color"),
  };
}

function forgetPairing(config: BridgeConfig) {
  delete config.token;
  delete config.machineId;
  delete config.teamId;
  delete config.belongsTo;
  delete config.linkedBy;
  delete config.afterSeq;
}
/**
 * Removes what the bridge kept for a pairing: the threads the room launched and who drives them
 * (`threads.json`), the T3 Code threads picked to share (`t3-threads.json`), and every profile. A
 * new pairing is a new machine in the room, possibly in another team, so none of it may carry over.
 * The T3 Code session belongs to the machine and stays.
 */
async function forgetPairingFiles(home: string) {
  await rm(join(home, "threads.json"), { force: true });
  await rm(join(home, "t3-threads.json"), { force: true });
  await rm(join(home, "profiles"), { recursive: true, force: true });
}
/**
 * A Codex hook's input, small enough for the local socket: a tool's output can be large, and the
 * bridge needs only the requests `say` and `reply` printed in it (`codexRelay.ts`).
 */
function codexHookInput(input: string): Record<string, unknown> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
  if (payload.tool_response !== undefined && input.length > 256 * 1024)
    payload.tool_response = JSON.stringify(payload.tool_response).match(/uplink-bridge-request:[A-Za-z0-9_.-]+/g)?.join("\n") ?? "";
  if (typeof payload.tool_input === "object" && JSON.stringify(payload.tool_input).length > 64 * 1024) payload.tool_input = {};
  return payload;
}
/** Writes to a stream and resolves once the write is done, so what follows comes after it. */
function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(text, (error) => (error ? reject(error) : resolve())));
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const home = bridgeHome();
  const socketPath = process.env.UPLINK_BRIDGE_SOCKET ?? socketPathFor(home);
  // A command run inside a shared terminal acts as that terminal with its id and the secret the
  // bridge put in its environment; the bridge refuses either without the other (ADR 0026).
  const secret = process.env.UPLINK_TERMINAL_SECRET;
  if (command === "hook") {
    const event = rest[0];
    if (!event || !process.env.UPLINK_TERMINAL_REF)
      throw new Error("A hook must run inside a shared terminal");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error("Hook input is too large");
    }
    const terminalId = process.env.UPLINK_TERMINAL_REF;
    let ack: unknown;
    try {
      const { [ACK_FIELD]: claimId, ...result } = (await localRequest(socketPath, {
        type: "hook",
        terminalId,
        secret,
        event,
        payload: input ? JSON.parse(input) : {},
      })) as Record<string, unknown>;
      ack = claimId;
      await write(process.stdout, JSON.stringify(result) + "\n");
    } catch {
      // A lost bridge must never turn an approval into an allow decision.
      if (event === "PermissionRequest") {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: event,
              decision: { behavior: "deny", message: "The bridge is unavailable." },
            },
          }) + "\n",
        );
        // Any other hook answers nothing: these run after every tool call (ADR 0026), and a bridge
        // that's gone must not put an error in front of the session each time.
      } else process.stdout.write("{}\n");
      return;
    }
    // Only now that Claude Code has the run's messages does the bridge tell the room they arrived (ADR 0026).
    if (typeof ack === "string") await localRequest(socketPath, { type: "ack", terminalId, secret, claimId: ack }).catch(() => {});
    return;
  }
  if (command === "say" || command === "reply") {
    // A run posts as itself (ADR 0026), so the agent holds no room key. In a terminal the bridge
    // shares, the bridge knows the terminal by UPLINK_TERMINAL_REF and its secret. In a T3 Code
    // thread, the command gives the run key and socket a delivery's last lines named (`--key`,
    // `--socket`, ADR 0037), and T3CODE_THREAD_ID, when T3 Code set it, must name the key's thread.
    // `say` needs a place and `reply` a message to answer, so a run never posts by surprise (D5).
    // `--file PATH`, as many as 10 times, sends files with the message (ADR 0047).
    const usage = `${
      command === "say" ? 'Usage: uplink-bridge say --in "#place" "text"' : 'Usage: uplink-bridge reply <messageId> "text"'
    }, with --file PATH for each file to send, and in a T3 Code thread also --key KEY --socket SOCKET.`;
    let words = rest;
    /** Takes an option and its value out of the words, wherever it is. */
    const option = (name: string) => {
      const at = words.indexOf(name);
      if (at < 0) return undefined;
      const value = words[at + 1];
      words = [...words.slice(0, at), ...words.slice(at + 2)];
      if (!value) throw new Error(`${name} needs a value. ${usage}`);
      return value;
    };
    const key = option("--key");
    const socket = option("--socket") ?? socketPath;
    const paths: string[] = [];
    for (let path = option("--file"); path !== undefined; path = option("--file")) paths.push(path);
    if (paths.length > RUN_SAY_FILES_MAX) throw new Error(`A message can carry at most ${RUN_SAY_FILES_MAX} files. ${usage}`);
    const terminalId = process.env.UPLINK_TERMINAL_REF;
    if (!key && !terminalId)
      throw new Error(
        `uplink-bridge ${command} posts as a run on this machine: inside a terminal the bridge shares, or in a T3 Code thread with --key and --socket from the last lines of a message the run got. ${usage}`,
      );
    let place: string | undefined;
    let replyTo: string | undefined;
    if (command === "say") {
      place = option("--in");
      if (!place) throw new Error(`Say where to post. ${usage}`);
    } else {
      [replyTo, ...words] = words;
      if (!replyTo) throw new Error(`Say which message to answer. ${usage}`);
    }
    let text = words.join(" ");
    // The text can come on stdin instead, for a message of several lines.
    if (!text.trim() && !process.stdin.isTTY) text = await readStdin(process.stdin);
    if (!text.trim() && !paths.length) throw new Error(`A message needs text or a file. ${usage}`);
    // The command reads each file itself, so the bridge sends only bytes it could read (runFiles.ts).
    const files = await Promise.all(paths.map((path) => describeRunFile(path)));
    const where = { text, ...(place ? { in: place } : {}), ...(replyTo ? { replyTo } : {}), ...(files.length ? { files } : {}) };
    const thread = process.env.T3CODE_THREAD_ID;
    let said: RunSaid;
    try {
      said = (await localRequest(
        socket,
        key ? { type: "say", key, ...(thread ? { threadId: thread } : {}), ...where } : { type: "say", terminalId, secret, ...where },
      )) as RunSaid;
    } catch (error) {
      // Codex's sandbox keeps a terminal's commands from the bridge's socket (a permission error):
      // the terminal's PostToolUse hook, outside the sandbox, posts the signed request instead (ADR
      // 0038). Only a terminal's say relays; a T3 Code thread's key has no hook to post it.
      const code = (error as NodeJS.ErrnoException).code;
      if (!key && process.env[RELAY_ENV] === "1" && secret && (code === "EPERM" || code === "EACCES")) {
        console.log(
          "Codex's sandbox keeps this command from reaching the bridge, so this terminal's Codex hook posts the message when the command ends and says how it went:\n" +
            relayRequest(secret, where),
        );
        return;
      }
      throw error;
    }
    console.log(`Posted as ${said.label} in ${said.place} (message ${said.messageId}).`);
    return;
  }
  if (command === "codex-hook") {
    // A Codex hook in a shared terminal (ADR 0038): Codex writes the event's JSON on stdin and reads
    // JSON from stdout. A bridge that can't be reached changes nothing: `{}`, so Codex goes on, and
    // asks for an approval in the terminal itself.
    const event = rest[0];
    const terminalId = process.env.UPLINK_TERMINAL_REF;
    if (!event || !terminalId) throw new Error("A Codex hook must run inside a shared terminal");
    const payload = codexHookInput(await readStdin(process.stdin));
    let result: unknown = {};
    try {
      result = await localRequest(socketPath, { type: "codex-hook", terminalId, secret, event, payload }, { timeoutMs: event === "PermissionRequest" ? 0 : 60_000 });
    } catch {
      result = {};
    }
    await write(process.stdout, JSON.stringify(result ?? {}) + "\n");
    return;
  }
  if (command === "codex") {
    // Codex in this terminal, on an app server of its own with the bridge's hooks (ADR 0038):
    // `codex [ARGS]` runs `codex ARGS`, and `codex -- PROGRAM ARGS` runs that program as Codex.
    const command = rest.includes("--") ? atSeparator(rest).words : ["codex", ...rest];
    process.exitCode = await runCodexSession(command, { bridgeSocket: socketPath, bridge: bridgeCommand() });
    return;
  }
  if (command === "inbox") {
    // An idle Claude Code session's waiter (ADR 0026): its Stop and SessionStart hooks run this with
    // `asyncRewake`, and exit code 2 wakes the session with what this prints on stderr
    // (code.claude.com/docs/en/hooks, "Command hook fields"). It waits until a message for this
    // terminal's run arrives, the terminal ends, or a newer waiter takes over (exit 0, no wake).
    const terminalId = process.env.UPLINK_TERMINAL_REF;
    if (!rest.includes("--wait") || !terminalId) throw new Error("Usage: uplink-bridge inbox --wait, inside a shared terminal");
    // Which hook started it, from the input Claude Code writes on stdin: a Stop ends a turn, and a
    // SessionStart can come mid-turn, when Claude Code compacts.
    let event: string | undefined;
    if (!process.stdin.isTTY) {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 1024 * 1024) break;
      }
      try {
        event = (JSON.parse(input) as { hook_event_name?: unknown }).hook_event_name as string | undefined;
      } catch {
        // No input: the event stays unknown, and the session counts as idle.
      }
    }
    let text: string | undefined;
    let ack: string | undefined;
    try {
      ({ text, ack } = (await localRequest(socketPath, { type: "inbox-wait", terminalId, secret, ...(typeof event === "string" ? { event } : {}) }, { timeoutMs: 0 })) as {
        text?: string;
        ack?: string;
      });
    } catch {
      // No bridge: nothing to wait for.
    }
    if (!text) process.exit(0);
    // Writes both before telling the bridge, and exits only then: on macOS a pipe write finishes
    // later, and exiting at once would cut a long message. Claude Code shows stderr; the line on
    // stdout keeps its check for a Stop hook whose file is missing from reading a message that
    // mentions one as a failed hook.
    await write(process.stderr, text + "\n");
    await write(process.stdout, "Uplink Room delivered messages for this run.\n");
    if (ack) await localRequest(socketPath, { type: "ack", terminalId, secret, claimId: ack }).catch(() => {});
    process.exit(2);
  }
  if (command === "rex-host") {
    // Runs inside a Rex tab (ADR 0019), with or without a bridge, so it needs no pairing.
    process.exit(await runRexHost(rexHostArgs(rest, socketPath)));
  }
  if (command === "rex-open") {
    // Opens a shareable Rex tab: one whose program runs through rex-host. It needs no bridge yet.
    const rex = rexExecutable();
    if (!rex) throw new Error("Rex's CLI isn't on this machine (looked for rex on PATH and in ~/.local/bin).");
    const { own, words } = atSeparator(rest);
    const cwd = flag(own, "--cwd") ?? process.cwd();
    const title = flag(own, "--title") ?? (words[0] ?? "Shell");
    const host = [
      ...bridgeCommand(),
      "rex-host",
      "--socket",
      socketPath,
      ...(words.length ? ["--command", quoteCommand(words)] : []),
    ];
    // Beside the tab this runs in, else in the "Uplink Room" session (made when it's missing).
    const session = flag(own, "--session") ?? process.env.REX_SESSION;
    const listed = (await rexJson(rex, ["ls", "--json"])) as { sessions?: { session_id: string; label?: string }[] };
    const room = listed?.sessions?.find((s) => s.label?.toLowerCase() === ROOM_SESSION.toLowerCase());
    const target = session ?? room?.session_id;
    const opened = (await (target
      ? rexJson(rex, ["window", "new", "-s", target, title, "-c", cwd, "--interactive", "--json", "--", ...host])
      : rexJson(rex, ["new", ROOM_SESSION, "-c", cwd, "--window", title, "--interactive", "--json", "--", ...host]))) as {
      block_ids?: string[];
      initial_windows?: { block_ids?: string[] }[];
    };
    const block = opened?.block_ids?.[0] ?? opened?.initial_windows?.[0]?.block_ids?.[0];
    console.log(
      `Opened Rex tab ${block ?? ""}. Share it in Uplink Room (Settings, Machines) or with uplink-bridge share-rex ${block ?? "TAB"}.`,
    );
    return;
  }
  let config = await loadConfig(home);
  switch (command) {
    case "pair": {
      const code = rest[0];
      const url = flag(rest, "--url");
      if (!code || !url) throw new Error("Usage: uplink-bridge pair <code> --url <convex url>");
      // A running bridge keeps its pairing, profiles and threads in memory, so pairing under it
      // would mix two pairings. Checked before the code is used, so a refused pair can be retried.
      // The desktop app stops its bridge, and waits for it to exit, before it pairs.
      if (await bridgeRunning(socketPath))
        throw new Error(
          "A bridge is running with this config. Stop it first (end uplink-bridge run, quit the Uplink Room app, or systemctl --user stop uplink-bridge), then pair again.",
        );
      const paired = await ConvexLink.pair(url, { code, hostname: hostname(), os: platform() });
      await forgetPairingFiles(home);
      await updateConfig(home, (saved) => {
        // Every pairing field is replaced, so a re-pairing never keeps a previous machine's identity.
        forgetPairing(saved);
        Object.assign(saved, paired, { belongsTo: paired.belongsTo, linkedBy: paired.linkedBy, url, afterSeq: 0 });
      });
      console.log("Machine paired. Run uplink-bridge run to share terminals.");
      return;
    }
    case "run": {
      if (!config.url || !config.token) throw new Error("Pair this machine first.");
      await mkdir(home, { recursive: true, mode: 0o700 });
      // A running bridge saves only the fields it changes, re-reading bridge.json each time, and
      // pairing state only while the file still holds its own token. So a `pair` (or the app's
      // re-pairing) that replaces the file while this bridge still runs is never undone by a
      // cursor save, and `t3-pair` isn't lost either.
      const token = config.token;
      let saving = Promise.resolve();
      const save = (change: (saved: BridgeConfig) => void, pairing = true) => {
        saving = saving.then(async () => {
          await updateConfig(home, change, pairing ? { token } : {});
        });
        return saving;
      };
      let bridge: Bridge;
      let local: LocalSocket;
      setTelemetryMachine(config.belongsTo ?? config.linkedBy, config.machineId);
      const fail = (error: unknown) => {
        console.error("The bridge lost its room link. Sharing has stopped.");
        void Promise.all([shutdown(), reportError(error)]).finally(() => {
          process.exitCode = 1;
        });
      };
      const link = new ConvexLink(config.url, config.token, {
        afterSeq: config.afterSeq,
        onCursor: async (seq) => {
          config.afterSeq = seq;
          await save((saved) => void (saved.afterSeq = seq));
        },
        onError: fail,
      });
      bridge = new Bridge({
        link,
        limits: config.limits,
        profilesDir: join(home, "profiles"),
        adapters: defaultAdapters(process.platform, config.t3, async () => (await loadConfig(home)).t3, async () => {
          // Pairs with this machine's T3 Code by itself, so nobody has to run t3-pair here.
          // Only T3 Code's own local address: a session that t3-pair pointed elsewhere (another port,
          // perhaps a tunnel to another machine) is never sent this machine's token.
          const before = (await loadConfig(home)).t3;
          const url = before?.url ?? T3_DEFAULT_URL;
          if (url !== T3_DEFAULT_URL) return undefined;
          try {
            const session = await pairWithT3({ url });
            // A t3-pair that saved its own session meanwhile wins: the bridge reads that one instead.
            let kept = true;
            await save((saved) => {
              if (saved.t3?.token !== before?.token) return void (kept = false);
              saved.t3 = { url: session.url, token: session.token, expiresAt: session.expiresAt };
            }, false);
            if (!kept) return undefined;
            console.log(`Paired with T3 Code at ${session.url} until ${new Date(session.expiresAt).toLocaleString()}.`);
            return { url: session.url, token: session.token, expiresAt: session.expiresAt };
          } catch (error) {
            console.log(`Couldn't pair with T3 Code by itself: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          }
        }),
        onError: fail,
        belongsTo: config.belongsTo,
        linkedBy: config.linkedBy,
        threadsFile: join(home, "threads.json"),
        t3SharingFile: join(home, "t3-threads.json"),
        ...(config.machineId === undefined
          ? {}
          : { pairing: { machineId: config.machineId, teamId: config.teamId } }),
        afterSeq: config.afterSeq,
        spaces: spacesOption(),
        rex: { executable: rexExecutable() },
        // Hooks for the terminals it starts with `claude`, in its own folder (ADR 0026).
        claudeHooks: { file: join(home, "claude-hooks.json") },
        // Codex on an app server of its own, with the bridge's hooks, in the terminals it starts with `codex` (ADR 0038).
        codex: {},
        // Hermes Agent's session followed on its gateway, with a launcher per terminal to post as its run (ADR 0040).
        hermes: { dir: join(home, "hermes") },
        // Where it saved files for runs, so it removes old ones a run it never saw end left (ADR 0043).
        roomFilesIndex: join(home, "room-files.json"),
        dropToken: async () => {
          forgetPairing(config);
          await save(forgetPairing);
        },
      });
      local = new LocalSocket(socketPath, bridge, async (limits) => {
        config.limits = limits;
        // The machine's limits aren't part of a pairing, so they're saved whatever the token.
        await save((saved) => void (saved.limits = limits), false);
      });
      let closing: Promise<void> | undefined;
      const shutdown = () =>
        (closing ??= (async () => {
          await local.close();
          // The bridge reports its terminals as ended before the link closes.
          await bridge.close();
          await link.close();
        })());
      // On Windows, each terminal is recorded, so a later bridge can end the console hosts this one
      // leaves if it dies with terminals open; this one ends those earlier bridges left (#66).
      const consoles = join(home, "consoles");
      if (process.platform === "win32") {
        consoleCleanup.recordIn(consoles);
        // Both holders start now, where their start stalls nothing, so the first terminal's console
        // host can be bound while its shell is still alive.
        startHolder();
      }
      try {
        await local.start();
        await bridge.start();
      } catch (error) {
        await shutdown();
        throw error;
      }
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      console.log("Bridge running.");
      if (process.platform === "win32") void consoleCleanup.sweep(consoles).catch(() => {});
      return;
    }
    case "rex-tabs": {
      const { tabs } = (await localRequest(socketPath, { type: "rex-tabs" })) as {
        tabs: { tabRef: string; session: string; title: string; command: string; terminalRef?: string }[];
      };
      if (!tabs.length) console.log("No shareable Rex tabs. Open one with uplink-bridge rex-open -- COMMAND.");
      for (const tab of tabs)
        console.log(`${tab.tabRef}  ${tab.session} / ${tab.title}  ${tab.command}${tab.terminalRef ? "  (shared)" : ""}`);
      return;
    }
    case "share-rex": {
      const target = rest.find((word, i) => !word.startsWith("--") && rest[i - 1] !== "--access");
      if (!target) throw new Error("Usage: uplink-bridge share-rex <tab> [--access watch|suggest|drive|open]");
      const access = flag(rest, "--access");
      const result = await localRequest(socketPath, { type: "share-rex", target, ...(access ? { access } : {}) });
      console.log(`Sharing Rex tab ${result.localRef}`);
      return;
    }
    case "unshare-rex": {
      const target = rest[0];
      if (!target) throw new Error("Usage: uplink-bridge unshare-rex <tab>");
      await localRequest(socketPath, { type: "unshare-rex", target });
      console.log("Stopped sharing that Rex tab. It keeps running in Rex.");
      return;
    }
    case "share": {
      const index = rest.indexOf("--");
      const words = index >= 0 ? rest.slice(index + 1) : rest;
      const result = await localRequest(socketPath, {
        type: "share",
        command: words.length ? quoteCommand(words) : undefined,
        cwd: process.cwd(),
      });
      console.log(`Sharing terminal ${result.localRef}`);
      return;
    }
    case "limits": {
      if (rest.length) {
        const access = flag(rest, "--most-open-access");
        const slots = flag(rest, "--slots");
        const duration = flag(rest, "--longest-profile-ms");
        const overrides = {
          ...(access === undefined ? {} : { mostOpenAccess: access as Access }),
          ...(slots === undefined ? {} : { slots: Number(slots) }),
          ...(duration === undefined ? {} : { longestProfileMs: Number(duration) }),
        };
        try {
          await localRequest(socketPath, { type: "limits", limits: validateLimits({ ...config.limits, ...overrides }) });
        } catch (error) {
          if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
          await updateConfig(home, (saved) => void (saved.limits = validateLimits({ ...saved.limits, ...overrides })));
        }
        config = await loadConfig(home);
      }
      console.log(JSON.stringify(config.limits, null, 2));
      return;
    }
    case "t3-pair": {
      // T3 Code's pairing: a one-time token, exchanged for a bearer session with only the scopes
      // the bridge needs. Without --token, mint one with the local t3 CLI (it lasts five minutes).
      // A running bridge does the same by itself when it has no session or T3 refuses its one.
      const url = flag(rest, "--url") ?? T3_DEFAULT_URL;
      const token = flag(rest, "--token");
      const baseDir = flag(rest, "--base-dir");
      const session = await pairWithT3({ url, ...(token ? { token } : {}), ...(baseDir ? { baseDir } : {}) });
      // Only this field, re-read from disk: a running bridge may have saved its cursor meanwhile.
      await updateConfig(
        home,
        (saved) => void (saved.t3 = { url: session.url, token: session.token, expiresAt: session.expiresAt }),
      );
      console.log(
        `Paired with T3 Code at ${url} (${session.scope}) until ${new Date(session.expiresAt).toLocaleString()}. A running bridge picks it up within 30 seconds if T3 Code refused its old pairing; otherwise restart uplink-bridge run to use it.`,
      );
      return;
    }
    case "t3-threads": {
      const view = (await localRequest(socketPath, { type: "t3-threads" }, { timeoutMs: 10_000 })) as T3SharingView;
      console.log(t3ThreadsText(view));
      return;
    }
    case "t3-share":
    case "t3-unshare": {
      if (!rest.length) throw new Error(`Usage: uplink-bridge ${command} <thread id> [...]`);
      const view = (await localRequest(socketPath, { type: "t3-threads" }, { timeoutMs: 10_000 })) as T3SharingView;
      if (view.state !== "ready" || !view.environmentId || !view.machineId) throw new Error(t3ThreadsText(view));
      const picked = new Set([...view.threads.filter((t) => t.shared && !t.fromRoom).map((t) => t.id), ...view.missing.map((t) => t.id)]);
      for (const id of rest) {
        if (command === "t3-unshare" && view.threads.some((t) => t.id === id && t.fromRoom))
          throw new Error(`${id} was started from the room, so it stays shared. End it from the room or in T3 Code.`);
        if (command === "t3-share") picked.add(id);
        else picked.delete(id);
      }
      const next = (await localRequest(
        socketPath,
        { type: "t3-share", machineId: view.machineId, environmentId: view.environmentId, revision: view.revision, threads: [...picked] },
        { timeoutMs: 30_000 },
      )) as T3SharingView;
      console.log(t3ThreadsText(next));
      return;
    }
    case "service": {
      const sub = rest[0];
      if (sub === "install") {
        if (!config.url || !config.token) throw new Error("Pair this machine first: uplink-bridge pair <code> --url <convex url>.");
        // A bridge started by hand holds the socket, and a second one beside it would share nothing.
        if ((await bridgeRunning(socketPath)) && !(await serviceActive()))
          throw new Error("A bridge is already running here (uplink-bridge run, or the Uplink Room app). Stop it, then install the service.");
        await installService({ linger: !rest.includes("--no-linger"), ...(process.env.UPLINK_BRIDGE_HOME ? { bridgeHome: home } : {}) });
        return;
      }
      if (sub === "uninstall") return void (await uninstallService());
      if (sub === "status") return void (await serviceStatus());
      throw new Error("Usage: uplink-bridge service install [--no-linger] | uninstall | status");
    }
    case "stop-sharing":
      await localRequest(socketPath, { type: "stop-sharing" });
      console.log("Sharing stopped.");
      return;
    case "unlink": {
      try {
        // The running bridge deletes its profiles and threads.json itself.
        await localRequest(socketPath, { type: "unlink" });
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        await forgetPairingFiles(home);
      }
      await updateConfig(home, forgetPairing);
      console.log("Machine unlinked.");
      return;
    }
    default:
      console.log(
        "Usage: uplink-bridge pair <code> --url <url> | service install [--no-linger] | service uninstall | service status | t3-pair [--url <t3 url>] [--token <pairing token>] [--base-dir <t3 data dir>] | run | share [-- cmd] | codex [ARGS] | codex -- PROGRAM [ARGS] | hook <event> | codex-hook <event> | inbox --wait | say [--key K --socket S] --in <place> <text> | reply [--key K --socket S] <messageId> <text> | limits [--most-open-access watch|suggest|drive|open --slots N --longest-profile-ms N] | t3-threads | t3-share <thread id>... | t3-unshare <thread id>... | stop-sharing | unlink | rex-open [--session S] [--cwd DIR] [--title T] [-- cmd] | rex-tabs | share-rex <tab> [--access level] | unshare-rex <tab> | rex-host [--command C | -- cmd]",
      );
  }
}
/** `t3-threads`' answer as lines: shared threads first, each with its id to pass to `t3-share` or `t3-unshare`. */
export function t3ThreadsText(view: T3SharingView): string {
  if (view.state === "sharing_stopped") return "Sharing is stopped on this machine. Restart the bridge to share again.";
  if (view.state === "no_t3") return "This bridge has no T3 Code adapter.";
  if (view.state === "not_paired" || view.state === "needs_pairing") return "The bridge isn't paired with T3 Code on this machine: uplink-bridge t3-pair.";
  if (view.state === "connecting") return "The bridge is connecting to T3 Code. Is T3 Code open?";
  const lines = [...view.threads]
    .sort((a, b) => Number(b.shared) - Number(a.shared) || a.project.localeCompare(b.project) || a.title.localeCompare(b.title))
    .map((t) => `${t.fromRoom ? "room   " : t.shared ? "shared " : "private"}  ${t.id}  ${t.title} (${t.project}, ${t.state})`);
  for (const t of view.missing) lines.push(`shared   ${t.id}  ${t.title ?? "Not in T3 Code's list now"}${t.project ? ` (${t.project})` : ""}`);
  if (view.otherEnvironment) lines.push(`${view.otherEnvironment} thread(s) were picked in another T3 Code environment and aren't shared here.`);
  return lines.length ? lines.join("\n") : "T3 Code has no threads on this machine.";
}
/** Prints a failed command's reason the way the CLI reports it. */
export function failureReason(error: unknown) {
  return (
    (error as { data?: { message?: string } }).data?.message ??
    (error instanceof Error ? error.message : String(error))
  );
}
