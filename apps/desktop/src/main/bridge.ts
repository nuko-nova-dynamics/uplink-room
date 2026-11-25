import { spawn, type ChildProcess } from "node:child_process";
import { readPairing, type PairingOnDisk } from "./pairGuard";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  installAppCommands,
  LINUX_DEFAULT_PATH,
  loginShellPath,
  macDefaultPath,
  readAppCommands,
  runOsascript,
  runPowerShell,
  type BridgeCliDeps,
} from "./bridgeCli";
import type { BridgeCli } from "./bridgeCliSpec";
import { addMcpServer, installAgentSkill, readAgentSetup, type AgentSetupDeps } from "./agentSetup";
import type { AgentSetup, McpAdded, McpHarness, SkillTarget } from "./agentSetupSpec";
import { homedir } from "node:os";
import { launcherCommand } from "./shellQuote";
import { app } from "electron";
import { bridgeHome } from "@uplink-room/bridge/config";
import { socketPathFor } from "@uplink-room/bridge/platform";
import { createConnection } from "node:net";
import { log } from "./log";
import { parseT3ThreadsView, t3BridgeError, type T3ShareRequest, type T3ThreadsView } from "./t3ThreadsSpec";
import { pipeToRotating, RotatingFile } from "./logFile";

/**
 * The bridge that ships inside the app (ADR 0002). The packaged app carries
 * the same bridge as the standalone CLI, bundled to `out/main/bridge.js`, and
 * runs it with its own Electron binary acting as Node (ELECTRON_RUN_AS_NODE),
 * so a person's own computer needs nothing else installed. The launchers in
 * `resources/bin` run it the same way from a terminal (`uplink-bridge`).
 */

const here = join(import.meta.dirname);
const bridgeScript = join(here, "bridge.js");

/** The folder holding the `uplink-bridge` launchers, in a packaged app. */
export function launcherDir(): string | undefined {
  if (!app.isPackaged) return undefined;
  const dir = join(process.resourcesPath, "bin");
  return existsSync(dir) ? dir : undefined;
}

/**
 * The command a person types to run the bundled bridge, for the pairing dialog: the launcher's
 * full path, quoted for this OS's shell, unless `onPath` says a terminal already runs this app's
 * launcher as plain `uplink-bridge` (main/bridgeCli.ts).
 */
export function bridgeCommand(onPath = false): string {
  const dir = launcherDir();
  if (!dir || onPath) return "uplink-bridge";
  const launcher = join(dir, process.platform === "win32" ? "uplink-bridge.cmd" : "uplink-bridge");
  return launcherCommand(launcher, process.platform);
}

/** What `uplink-bridge` on PATH looks at here, or null outside the installed app, which has no launcher. */
function cliDeps(): BridgeCliDeps | null {
  const dir = launcherDir();
  const platform = process.platform;
  if (!dir || (platform !== "darwin" && platform !== "win32" && platform !== "linux")) return null;
  return {
    platform,
    launcher: join(dir, platform === "win32" ? "uplink-bridge.cmd" : "uplink-bridge"),
    command: bridgeCommand,
    env: process.env,
    shellPath: () => loginShellPath(process.env),
    defaultPath: async () => (platform === "darwin" ? macDefaultPath() : LINUX_DEFAULT_PATH),
    linkDir: platform === "darwin" ? "/usr/local/bin" : "/usr/bin",
    osascript: runOsascript,
    powershell: (script, env) => runPowerShell(script, env),
    envKey: "Environment",
    exists: (path) => stat(path).then((s) => s.isFile(), () => false),
    appImage: platform === "linux" && Boolean(process.env["APPIMAGE"]),
  };
}

/**
 * Whether a new terminal runs this app's bridge as `uplink-bridge`, with `uplink` and `uplink-mcp`
 * in `tools` (ADR 0042), or null outside the installed app.
 */
export async function bridgeCliStatus(): Promise<BridgeCli | null> {
  const deps = cliDeps();
  return deps ? readAppCommands(deps) : null;
}

let installingCli: Promise<BridgeCli> | null = null;

/** Puts this app's launchers on PATH, all three in one step. Only a click on Add to PATH calls this. */
export function installBridgeCliOnPath(): Promise<BridgeCli> {
  const deps = cliDeps();
  if (!deps) return Promise.reject(new Error("Only the installed app carries the bridge"));
  installingCli ??= installAppCommands(deps)
    .then((status) => {
      const tools = Object.fromEntries((status.tools ?? []).map((t) => [t.name, t.state]));
      log.info("bridge", "uplink-bridge, uplink and uplink-mcp put on PATH", { state: status.state, ...tools, platform: status.platform });
      return status;
    })
    .finally(() => {
      installingCli = null;
    });
  return installingCli;
}

/** The app's skill and MCP server for agents on this computer (main/agentSetup.ts), or null outside the installed app. */
function agentDeps(): AgentSetupDeps | null {
  const binDir = launcherDir();
  const platform = process.platform;
  if (!binDir || (platform !== "darwin" && platform !== "win32" && platform !== "linux")) return null;
  return {
    platform,
    binDir,
    appImage: platform === "linux" && Boolean(process.env["APPIMAGE"]),
    skills: join(process.resourcesPath, "skills"),
    env: { ...process.env, HOME: process.env["HOME"] || homedir() },
    shellPath: () => loginShellPath(process.env),
  };
}

export async function agentSetupStatus(): Promise<AgentSetup | null> {
  const deps = agentDeps();
  return deps ? readAgentSetup(deps) : null;
}

/** Copies the skill into a harness's skills folder. Only a click on Install calls this. */
export async function installAgentSkillFromApp(target: SkillTarget): Promise<AgentSetup> {
  const deps = agentDeps();
  if (!deps) throw new Error("Only the installed app carries the skill.");
  const setup = await installAgentSkill(deps, target);
  log.info("agent-setup", "uplink skill installed", { target });
  return setup;
}

/** Adds `uplink-mcp` to a harness with its own `mcp add`. Only a click on Add calls this. */
export async function addMcpServerFromApp(harness: McpHarness): Promise<McpAdded> {
  const deps = agentDeps();
  if (!deps) throw new Error("Only the installed app carries uplink-mcp.");
  const added = await addMcpServer(deps, harness);
  log.info("agent-setup", "uplink-mcp added", { harness });
  return added;
}

function paired(): boolean {
  try {
    const config = JSON.parse(readFileSync(join(bridgeHome(), "bridge.json"), "utf8")) as { token?: string };
    return Boolean(config.token);
  } catch {
    return false;
  }
}

/** This computer's pairing from bridge.json: paired, unpaired, or unknown when it can't be read (main/pairGuard.ts). */
export function currentPairing(): PairingOnDisk {
  return readPairing(() => readFileSync(join(bridgeHome(), "bridge.json"), "utf8"));
}

let child: ChildProcess | undefined;
/** True while `pairThisComputer` runs, so nothing starts the old pairing's bridge meanwhile. */
let pairing = false;

/** `bridge.log` in the app's logs folder, rotating at 5 MB while the bridge runs (main/logFile.ts). */
let bridgeLog: RotatingFile | null = null;

function runBridge(args: string[], log: string): ChildProcess {
  bridgeLog ??= new RotatingFile(app.getPath("logs"), log);
  const out = bridgeLog;
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const bin = launcherDir();
  if (bin) env["UPLINK_BRIDGE_BIN_DIR"] = bin;
  const started = spawn(process.execPath, [bridgeScript, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (started.stdout) pipeToRotating(started.stdout, out);
  if (started.stderr) pipeToRotating(started.stderr, out);
  return started;
}

/**
 * Starts the bundled bridge when this computer is paired. Only the packaged
 * app does this, so tests and development never touch a real pairing. If the
 * person already runs `uplink-bridge run` themselves, this one finds its
 * socket taken and exits, which the log records.
 */
export function startBridge(): void {
  if (!app.isPackaged || child || pairing || process.env["UPLINK_NO_BRIDGE"] || !paired()) return;
  const started = runBridge(["run"], "bridge.log");
  child = started;
  log.info("bridge", "started", { pid: started.pid });
  // A bridge stopped by force can exit after its replacement has started, so it may clear the
  // handle only while the handle still refers to it.
  started.once("exit", (code, signal) => {
    log[code === 0 || signal === "SIGTERM" ? "info" : "warn"]("bridge", "exited", { code, signal });
    if (child === started) child = undefined;
  });
}

/**
 * How many terminals the app's own bridge would end if the app quit now, or null when it can't
 * tell (the bridge didn't answer in time). A bridge the person runs themselves (`uplink-bridge run`)
 * isn't the app's and outlives it, so with no bridge of its own running the answer is 0.
 */
export function bridgeBusyTerminals(timeoutMs = 3_000): Promise<number | null> {
  const running = child;
  if (!running || running.exitCode !== null || running.signalCode !== null) return Promise.resolve(0);
  return new Promise((resolve) => {
    const socket = createConnection(socketPathFor(bridgeHome()));
    let buffer = "";
    const done = (value: number | null) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on("error", () => done(null));
    socket.on("connect", () => socket.write(JSON.stringify({ type: "busy" }) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const terminals = (JSON.parse(buffer.slice(0, end)) as { result?: { terminals?: unknown } }).result?.terminals;
        done(typeof terminals === "number" && Number.isInteger(terminals) && terminals >= 0 ? terminals : null);
      } catch {
        done(null);
      }
    });
    socket.on("end", () => done(null));
  });
}

/** Why a request to this computer's bridge failed: none listens, or it answered with a refusal. */
class BridgeRefused extends Error {}

/**
 * One request to this computer's bridge over its local socket, whoever started it (this app, or
 * `uplink-bridge run` in a terminal), answered as `{ result }` or `{ error }`.
 */
function localBridgeRequest(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPathFor(bridgeHome()));
    let buffer = "";
    let settled = false;
    const done = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(new BridgeRefused("The bridge on this computer didn't answer in time.")));
    socket.on("error", (error) => done(error));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return done(new BridgeRefused("The bridge's answer was too large."));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const answer = JSON.parse(buffer.slice(0, end)) as { result?: unknown; error?: unknown };
        if (typeof answer.error === "string") done(new BridgeRefused(answer.error));
        else done(null, answer.result);
      } catch {
        done(new BridgeRefused("The bridge's answer couldn't be read."));
      }
    });
    socket.on("end", () => done(new BridgeRefused("The bridge closed the request.")));
  });
}

const bridgeOff = (error: unknown) => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * This computer's T3 Code threads and which of them the room gets (Settings, Machines). Read from
 * the bridge on this computer only; nothing of it comes from, or goes to, the room.
 */
export async function readT3Threads(): Promise<T3ThreadsView> {
  try {
    return parseT3ThreadsView(await localBridgeRequest({ type: "t3-threads" }, 5_000));
  } catch (error) {
    if (bridgeOff(error)) return { state: "bridge_off" };
    return { state: "unavailable", error: t3BridgeError(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Shares exactly `request.threads` from this computer, as picked from the list `revision` names, in
 * the T3 Code environment it names. Throws the bridge's refusal (another pairing, another
 * environment, a changed list, a failed save), worded for the person.
 */
export async function shareT3Threads(request: T3ShareRequest): Promise<T3ThreadsView> {
  try {
    const view = parseT3ThreadsView(await localBridgeRequest({ type: "t3-share", ...request }, 20_000));
    log.info("t3-sharing", "threads shared from this computer saved", { shared: request.threads.length });
    return view;
  } catch (error) {
    if (bridgeOff(error)) throw new Error("The bridge isn't running on this computer, so nothing changed.");
    const message = t3BridgeError(error instanceof Error ? error.message : String(error));
    log.warn("t3-sharing", "saving threads shared from this computer failed", { error: message });
    throw new Error(message);
  }
}

/** Stops the bundled bridge. Resolves once its process has exited. */
export function stopBridge(): Promise<void> {
  const stopping = child;
  child = undefined;
  if (!stopping || stopping.exitCode !== null || stopping.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    // The bridge's own shutdown is bounded at a few seconds; past that, stop waiting on it.
    const force = setTimeout(() => stopping.kill("SIGKILL"), 10_000);
    stopping.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    stopping.kill("SIGTERM");
  });
}

/**
 * Pairs this computer with the room using a code from the pairing dialog,
 * then starts the bridge. The URL must be the Convex deployment the app
 * itself talks to, so a page can't point the bridge at another backend.
 *
 * The running bridge is stopped, and has exited, before the pairing writes
 * bridge.json, so its last cursor save can't land on the new pairing. (The
 * bridge also refuses to save over a pairing that isn't its own.) If pairing
 * fails, the previous pairing is untouched and its bridge starts again.
 */
export function pairThisComputer(code: string, url: string): Promise<void> {
  if (!/^[A-Za-z0-9-]{4,64}$/.test(code)) return Promise.reject(new Error("Invalid pairing code"));
  if (pairing) return Promise.reject(new Error("This computer is already being paired"));
  pairing = true;
  return (async () => {
    try {
      await stopBridge();
      await new Promise<void>((resolve, reject) => {
        const pair = runBridge(["pair", code, "--url", url], "bridge.log");
        pair.once("error", reject);
        pair.once("exit", (exitCode) =>
          exitCode === 0 ? resolve() : reject(new Error("Pairing failed. See bridge.log in the app's logs.")),
        );
      });
    } finally {
      pairing = false;
      startBridge();
    }
  })();
}
