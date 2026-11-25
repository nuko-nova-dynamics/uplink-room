/**
 * Which names a Claude Code session knows this tool's channel server by (ADR 0032), so `uplink join`
 * uses the channel only when the session's `--dangerously-load-development-channels` names that
 * server, not when it names another one (code.claude.com/docs/en/channels-reference: the flag takes
 * `server:<name>` and `plugin:<name>@<marketplace>` entries, and loads only those).
 *
 * The name is the one the person gave the server in Claude Code's MCP config: `--mcp-config` files or
 * JSON on the command line (only those with `--strict-mcp-config`), else `~/.claude.json` (user
 * scope `mcpServers`, local scope `projects[<folder>].mcpServers`; in `$CLAUDE_CONFIG_DIR` when that
 * is set) and the project's `.mcp.json` (code.claude.com/docs/en/mcp, "MCP installation scopes").
 * A server is this tool's channel when it runs `uplink-mcp` (or the room client's `src/mcp.ts`) with
 * `--channel`, or with `UPLINK_MCP_CHANNEL=1` in its environment.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Env } from "./config.ts";

type ServerEntry = { command?: unknown; args?: unknown; env?: unknown };

const UPLINK_MCP = /(^|[\\/])uplink-mcp(\.cmd|\.exe|\.[cm]?[jt]s)?$/i;
const SOURCE_MCP = /room-client[\\/]src[\\/]mcp\.ts$/;

function isUplinkChannel(entry: ServerEntry): boolean {
  const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((w): w is string => typeof w === "string");
  if (!words.some((word) => UPLINK_MCP.test(word) || SOURCE_MCP.test(word))) return false;
  const env = entry.env && typeof entry.env === "object" ? (entry.env as Record<string, unknown>) : {};
  return words.includes("--channel") || env.UPLINK_MCP_CHANNEL === "1";
}

function addNames(servers: unknown, names: Set<string>): void {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && isUplinkChannel(entry as ServerEntry)) names.add(name);
  }
}

function parse(text: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(file: string): Promise<Record<string, any> | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parse(text);
}

/**
 * The names of the MCP servers that run this tool's channel in a session started in `folders` (its
 * primary working directory first, then the repository root), with these `--mcp-config` values.
 */
export async function uplinkChannelNames(env: Env, folders: string[], launch: { mcpConfigs: string[]; strictMcp: boolean }): Promise<Set<string>> {
  const names = new Set<string>();
  for (const config of launch.mcpConfigs) {
    const json = config.trim().startsWith("{") ? parse(config) : await readJson(isAbsolute(config) || !folders[0] ? config : join(folders[0], config));
    addNames(json?.mcpServers, names);
  }
  if (launch.strictMcp) return names;
  const dirs = new Set(folders);
  for (const folder of folders) {
    const real = await realpath(folder).catch(() => undefined);
    if (real) dirs.add(real);
  }
  const claudeJson = await readJson(join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"));
  addNames(claudeJson?.mcpServers, names);
  for (const dir of dirs) {
    addNames(claudeJson?.projects?.[dir]?.mcpServers, names);
    addNames((await readJson(join(dir, ".mcp.json")))?.mcpServers, names);
  }
  return names;
}

/** Whether a development channels flag's entries name one of these servers (`server:<name>`). */
export function namesChannel(devChannels: string[], names: Set<string>): boolean {
  return devChannels.some((entry) => entry.startsWith("server:") && names.has(entry.slice("server:".length)));
}
