import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable, spawnExecutable } from "../platform.ts";

/**
 * Where the Rex CLI is. The desktop app starts its bridge with a GUI app's short PATH, which
 * usually lacks `~/.local/bin`, so two more places are tried: `~/.local/bin/rex`, and the CLI inside
 * Rex Beta.app (where `~/.local/bin/rex` pointed on the Mac this was checked on, 2026-11-04).
 * `UPLINK_REX` names another.
 */
export function rexExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.UPLINK_REX) return resolveExecutable(env.UPLINK_REX, env);
  return (
    resolveExecutable("rex", env) ??
    resolveExecutable(join(homedir(), ".local", "bin", "rex"), env) ??
    resolveExecutable("/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex", env)
  );
}

/**
 * The Rex server to use, given explicitly. Rex reads `REX_SERVER` only as a default: when the server
 * it names is gone, the CLI goes on to the computer's own Rex server (seen with Rex
 * 0.0.1793741575 on 2026-11-04), so a bridge set up for one server could act on another. `-S` names
 * the server outright, and the call fails instead.
 */
export function rexServerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.REX_SERVER ? ["-S", env.REX_SERVER] : [];
}

/** Why a Rex call failed, with what Rex printed on stderr. */
export class RexError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

/**
 * Runs one Rex CLI command and parses its JSON output. `--autostart=false` always goes first, so the
 * bridge never starts a Rex server itself, and `REX_SERVER` from `env` goes as `-S` (`rexServerArgs`).
 * Gives up after `timeoutMs` (default 10 seconds) or 4 MiB of output.
 */
export function rexJson(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawnExecutable(executable, ["--autostart=false", ...rexServerArgs(env), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new RexError("Rex didn't answer in time.", null));
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        child.kill();
        reject(new RexError("Rex wrote too much output.", null));
      } else out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new RexError(err.trim().split("\n")[0] || `rex exited with ${code}`, code));
      const text = Buffer.concat(out).toString("utf8").trim();
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** The command words that start this bridge's own CLI, for a Rex tab to run `rex-host` with. */
export function bridgeCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  // The desktop app's launcher runs its bundled bridge on Electron as Node (resources/bin).
  if (env.UPLINK_BRIDGE_BIN_DIR) {
    const launcher = resolveExecutable(join(env.UPLINK_BRIDGE_BIN_DIR, "uplink-bridge"), env);
    if (launcher) return [launcher];
  }
  const node = [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])];
  // Electron runs as Node only with this set, and bin.ts removes it from the bridge's own environment.
  return process.versions.electron ? ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", ...node] : node;
}
