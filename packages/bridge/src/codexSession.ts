/**
 * `uplink-bridge codex -- codex ARGS`: runs Codex in a shared terminal on an app server of its own
 * (ADR 0038). A terminal the bridge starts with `codex` runs through it, and in a terminal shared from
 * the machine the person can run it themselves.
 *
 * Since 0.157.0 interactive `codex` uses a background app server that every client of the person's
 * Codex home shares, and its hooks run inside that server, with the server's environment, not the
 * terminal's. Hooks given to `codex` with `-c` make it leave that server ("command-line configuration
 * overrides (-c, --enable, --disable, or --search) requires embedded mode", Codex 0.166.0's startup
 * warning), and then nothing outside the terminal can reach its session. So the wrapper starts
 * `codex app-server --listen unix://SOCK` itself, inside the terminal, with the bridge's hooks
 * (`codexHooks.ts`), and runs the terminal UI on it with `--remote unix://SOCK`
 * (learn.chatgpt.com/docs/app-server.md, "Connect the CLI terminal UI"):
 *
 * - The hooks run in that server, so they have this terminal's `UPLINK_TERMINAL_REF` and secret.
 * - The bridge knows the session's server, because the wrapper registers its socket, and nothing else
 *   uses it: no guessing among the person's other Codex sessions.
 * - The person's Codex home stays as it is: same config, sign-in and saved sessions, nothing written.
 *
 * The session isn't on Codex's shared background server, and its server ends with the terminal UI:
 * the wrapper stops it then. Commands that open no session (`codex exec`, `codex login`), or
 * pick their own server (`--remote`, `--no-daemon`), run unchanged, as does any command on Windows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "@uplink-room/protocol/codexAppServer";
import { codexServerConfig } from "./codexHooks.ts";
import { RELAY_ENV } from "./codexRelay.ts";
import { localRequest } from "./localSocket.ts";
import { quoteCommand } from "./platform.ts";

/** Codex 0.166.0's subcommands (`codex --help`). Only `resume` and `fork` open a session in the terminal UI. */
const SUBCOMMANDS = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update",
  "doctor", "sandbox", "debug", "apply", "a", "resume", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db", "unarchive",
  "fork", "cloud", "exec-server", "features", "help",
]);
const SESSION_SUBCOMMANDS = new Set(["resume", "fork"]);
/** Codex's global options that take a value (`codex --help`), so their value isn't read as a subcommand. */
const VALUED = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image", "-m", "--model",
  "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
/** Options that change the server's config, so the wrapper gives them to its server too. */
const SERVER_OPTIONS = new Set(["-c", "--config", "--enable", "--disable"]);

/** Whether `codex ARGS` opens a session the wrapper runs on its own server. */
export function codexRunsOwnServer(args: string[]): boolean {
  if (args.some((arg) => arg === "--no-daemon" || arg === "--remote" || arg.startsWith("--remote="))) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return true;
    if (["-h", "--help", "-V", "--version"].includes(arg)) return false;
    if (VALUED.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    // The first word that isn't an option: a subcommand, or the session's first prompt.
    return !SUBCOMMANDS.has(arg) || SESSION_SUBCOMMANDS.has(arg);
  }
  return true;
}

/** The person's options that change config, to give the server as well as the terminal UI. */
function serverOptions(args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (SERVER_OPTIONS.has(arg) && i + 1 < args.length) kept.push(arg, args[++i]!);
    else if (arg.startsWith("--config=") || arg.startsWith("--enable=") || arg.startsWith("--disable=") || arg === "--strict-config") kept.push(arg);
    else if (VALUED.has(arg)) i++;
  }
  return kept;
}

/** The command a terminal runs instead of `command`, a command line that starts `codex`. */
export function withCodexSession(command: string, bridge: string[], platform: NodeJS.Platform = process.platform): string {
  return `${quoteCommand([...bridge, "codex", "--"], {}, platform)} ${command}`;
}

/** A folder only this user can use, for the session's socket: short, since a Unix socket's path is limited. */
async function socketFolder(): Promise<string> {
  const uid = process.getuid?.();
  const folder = join(tmpdir(), `uplink-codex-${uid ?? "user"}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
    throw new Error(`${folder} isn't a private folder of this user's.`);
  return folder;
}

/** Runs a program in the terminal and resolves with its exit code, as a shell reports one. */
function run(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: "inherit", env });
    // Codex's terminal UI decides what Ctrl+C does; a closing terminal or a kill ends it too.
    const ignore = () => {};
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const hangup = forward("SIGHUP");
    const terminate = forward("SIGTERM");
    process.on("SIGINT", ignore);
    process.on("SIGHUP", hangup);
    process.on("SIGTERM", terminate);
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGHUP", hangup);
      process.off("SIGTERM", terminate);
      resolve(code);
    };
    child.on("error", (error) => {
      console.error(`Couldn't start ${program}: ${error.message}`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? 128 + (signal ? signalNumber(signal) : 0)));
  });
}

const signalNumber = (signal: NodeJS.Signals) => ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 })[signal as string] ?? 0;

/**
 * Until the returned function is called, a signal that ends the wrapper (a closing terminal, a kill,
 * Ctrl+C) runs `cleanUp` first, then ends it with the code a shell reports for that signal.
 */
function endOnSignal(cleanUp: () => Promise<void>): () => void {
  const signals: NodeJS.Signals[] = ["SIGHUP", "SIGTERM", "SIGINT"];
  const handlers = signals.map((signal) => {
    const handler = () => void cleanUp().finally(() => process.exit(128 + signalNumber(signal)));
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/** Waits for the server's socket, or for the server to exit first. */
async function serverReady(socket: string, server: ChildProcess, waitMs: number): Promise<boolean> {
  const exited = new Promise<false>((resolve) => server.once("exit", () => resolve(false)));
  const started = (async () => {
    for (const end = Date.now() + waitMs; Date.now() < end; ) {
      if (existsSync(socket)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })();
  return Promise.race([started, exited]);
}

/**
 * Whether the server will run the bridge's hooks, which it says in `hooks/list`: each listed under
 * its key, enabled, and trusted. `hashes`, when every hook is listed but some aren't trusted, are the
 * ones it would trust them by (`currentHash`), for a Codex that hashes hooks differently from the
 * bridge. `codex` names the server, as `initialize` answered.
 */
async function hookTrust(
  socket: string,
  keys: Record<string, string>,
): Promise<{ trusted: boolean; problem?: string; hashes?: Record<string, string>; codex?: string }> {
  let server: CodexAppServer | undefined;
  try {
    server = await CodexAppServer.open(socket, 5000);
    const codex = server.userAgent;
    const listed = (await server.call("hooks/list", {}, 15_000)) as {
      data?: { hooks?: { key?: string; currentHash?: string; trustStatus?: string; enabled?: boolean }[] }[];
    } | null;
    const hooks = listed?.data?.flatMap((entry) => entry.hooks ?? []) ?? [];
    const hashes: Record<string, string> = {};
    const unlisted: string[] = [];
    const off: string[] = [];
    const untrusted: string[] = [];
    for (const [event, key] of Object.entries(keys)) {
      const hook = hooks.find((entry) => entry.key === key);
      if (typeof hook?.currentHash !== "string") unlisted.push(event);
      else {
        hashes[event] = hook.currentHash;
        if (hook.enabled === false) off.push(event);
        else if (hook.trustStatus !== "trusted") untrusted.push(event);
      }
    }
    if (unlisted.length) return { trusted: false, codex, problem: `it didn't load them (${unlisted.join(", ")}; are hooks turned off?)` };
    if (off.length) return { trusted: false, codex, problem: `they're turned off in /hooks (${off.join(", ")})` };
    if (untrusted.length) return { trusted: false, codex, problem: `it doesn't trust them (${untrusted.join(", ")})`, hashes };
    return { trusted: true, codex };
  } catch (error) {
    return { trusted: false, ...(server?.userAgent ? { codex: server.userAgent } : {}), problem: `it couldn't list its hooks (${(error as Error).message})` };
  } finally {
    server?.close();
  }
}

/** Ends the server and the MCP servers it started (its process group), at once if it won't stop. */
async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null || server.pid === undefined) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-server.pid!, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
  if (!stopped) signal("SIGKILL");
}

export interface CodexSessionOptions {
  /** The bridge's socket, as the terminal names it. */
  bridgeSocket: string;
  /** The words that start this bridge's CLI, for the hooks. */
  bridge: string[];
  env?: NodeJS.ProcessEnv;
  /** How long Codex's app server has to open its socket. */
  startMs?: number;
}

/** Runs `codex ARGS` (`words`) in this terminal as the module comment says, and resolves with its exit code. */
export async function runCodexSession(words: string[], options: CodexSessionOptions): Promise<number> {
  const [program, ...args] = words;
  if (!program) throw new Error("Usage: uplink-bridge codex -- codex [ARGS]");
  const env = options.env ?? process.env;
  const terminalId = env.UPLINK_TERMINAL_REF;
  const secret = env.UPLINK_TERMINAL_SECRET;
  if (!terminalId || !secret || process.platform === "win32" || !codexRunsOwnServer(args)) return run(program, args, env);
  let socket: string;
  try {
    socket = join(await socketFolder(), `${createHash("sha256").update(terminalId).digest("hex").slice(0, 16)}.sock`);
    await rm(socket, { force: true });
  } catch (error) {
    console.error(`Uplink Room: ${(error as Error).message} So this Codex session won't hear the room's messages.`);
    return run(program, args, env);
  }
  const given = serverOptions(args);
  const register = (request: Record<string, unknown>) =>
    localRequest(options.bridgeSocket, { type: "codex-server", terminalId, secret, ...request }, { timeoutMs: 5000 }).catch(() => {});
  // The server running now, and whether the bridge has heard of it.
  let current: ChildProcess | undefined;
  let registered = false;
  const cleanUp = async () => {
    if (current) await stopServer(current);
    if (registered) await register({ ended: true });
    registered = false;
    await rm(socket, { force: true }).catch(() => {});
  };
  // From the server's start, a closing terminal or a kill stops it before the wrapper ends, except
  // while the terminal UI runs: that takes the signal (`run`), and the wrapper stops the server after.
  let release = endOnSignal(cleanUp);
  const start = async (hashes?: Record<string, string>) => {
    const config = codexServerConfig(options.bridge, { given, ...(hashes ? { hashes } : {}) });
    // Its own process group, so Ctrl+C in a program Codex starts doesn't reach it; the wrapper ends it.
    const child = (current = spawn(program, ["app-server", "--listen", `unix://${socket}`, ...given, ...config.values.flatMap((value) => ["-c", value])], {
      env: { ...env, [RELAY_ENV]: "1" },
      stdio: "ignore",
      detached: true,
    }));
    child.on("error", () => {});
    const ready = await serverReady(socket, child, options.startMs ?? 15_000);
    return { ready, trust: ready ? await hookTrust(socket, config.keys) : undefined };
  };
  let server = await start();
  if (server.trust?.hashes) {
    // This Codex hashes hooks differently from the bridge: start it again with the hashes it trusts by.
    await stopServer(current!);
    await rm(socket, { force: true });
    server = await start(server.trust.hashes);
  }
  if (!server.ready || !server.trust?.trusted) {
    await cleanUp();
    release();
    console.error(
      server.ready
        ? `Uplink Room: ${server.trust?.codex ?? "This Codex"} won't run the bridge's hooks: ${server.trust?.problem}. So this session runs without the room: it won't report its state, send approvals to the room, or hear the room's messages.`
        : "Uplink Room: Codex's app server didn't start, so this session runs without the room's messages.",
    );
    return run(program, args, env);
  }
  registered = true;
  await register({ socket, pid: current!.pid });
  release();
  let code: number;
  try {
    code = await run(program, ["--remote", `unix://${socket}`, ...args], env);
  } finally {
    release = endOnSignal(cleanUp);
    await cleanUp();
    release();
  }
  return code;
}
