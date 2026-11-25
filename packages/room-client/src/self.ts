/**
 * How this tool runs itself again: the Claude Code hooks `uplink join` writes, the keeper it starts,
 * the MCP server `uplink mcp install` registers, and the skill `uplink skills install` copies
 * (ADR 0042).
 *
 * - From source, it is Node with `src/cli.ts` or `src/mcp.ts`, and the skills are in `skills/`.
 * - Inside the desktop app, the launchers in the app's `resources/bin` (`uplink`, `uplink-mcp`) run
 *   the bundled copy on the app's Electron as Node and set `UPLINK_BIN_DIR` to their folder. Electron
 *   runs as Node only with `ELECTRON_RUN_AS_NODE=1`, which a hook's or an MCP client's environment
 *   doesn't have, so they run the launcher. The skills are in `resources/skills`.
 */
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./config.ts";

const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));
const MCP_PATH = fileURLToPath(new URL("./mcp.ts", import.meta.url));
const SOURCE_SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

/** The app's launcher folder when the app's launcher started this process, else undefined. */
export function launcherDir(env: Env): string | undefined {
  return env.UPLINK_BIN_DIR || undefined;
}

/** A launcher in that folder: the extensionless shell script, or `<name>.cmd` with `cmd`. */
function launcher(dir: string, name: string, platform: NodeJS.Platform, cmd = false): string {
  return platform === "win32" ? win32.join(dir, cmd ? `${name}.cmd` : name) : posix.join(dir, name);
}

/**
 * What a hook runs to reach this tool. `exec`: words for exec form (`command` and `args`, no
 * shell). `shell`: a command line for Claude Code's hook shell, on Windows inside the app, where
 * exec form can't start a `.cmd` and Electron needs the launcher; Claude Code runs it in Git Bash,
 * which runs the extensionless launcher (it handles MINGW), given with forward slashes.
 */
export type HookProgram = { exec: string[] } | { shell: string };

export function hookProgram(env: Env, platform: NodeJS.Platform = process.platform): HookProgram {
  const dir = launcherDir(env);
  if (!dir) return { exec: [process.execPath, ...process.execArgv, CLI_PATH] };
  if (platform === "win32") return { shell: shQuote(launcher(dir, "uplink", platform).replaceAll("\\", "/")) };
  return { exec: [launcher(dir, "uplink", platform)] };
}

/**
 * How `uplink join` starts the keeper, detached: this same program on this same runtime. Inside the
 * app that is the app's Electron with the bundled script, so it needs `ELECTRON_RUN_AS_NODE`, which
 * the entry point took out of its own environment (cli.ts) so nothing else it starts inherits it.
 */
export function keeperProgram(env: Env): { words: string[]; env: Env } {
  const script = launcherDir(env) && process.argv[1] ? process.argv[1] : CLI_PATH;
  return {
    words: [process.execPath, ...process.execArgv, script],
    env: process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
  };
}

/**
 * The words an MCP client runs for `uplink-mcp`. On Windows the app's launcher is a `.cmd`, which a
 * client starts through `cmd /c` (as Claude Code's docs say for `npx` on Windows).
 */
export function mcpProgram(env: Env, platform: NodeJS.Platform = process.platform): string[] {
  const dir = launcherDir(env);
  if (!dir) return [process.execPath, MCP_PATH];
  if (platform === "win32") return ["cmd", "/c", launcher(dir, "uplink-mcp", platform, true)];
  return [launcher(dir, "uplink-mcp", platform)];
}

/** The folder holding the skills this tool installs (`<name>/SKILL.md`). */
export function skillsSource(env: Env, platform: NodeJS.Platform = process.platform): string {
  const dir = launcherDir(env);
  if (!dir) return SOURCE_SKILLS;
  const path = platform === "win32" ? win32 : posix;
  return path.join(path.dirname(path.resolve(dir)), "skills");
}

/** A word quoted for a POSIX shell. */
export function shQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
