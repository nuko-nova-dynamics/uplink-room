import { installMcp, installSkill, skillDir, skillState, type Runner } from "@uplink-room/room-client/agentSetup";
import { mcpProgram, shQuote } from "@uplink-room/room-client/self";
import type { AgentSetup, McpAdded, McpHarness, SkillTarget } from "./agentSetupSpec";

/**
 * Settings, Command line's agent setup (ADR 0042), with the same functions as `uplink skills
 * install` and `uplink mcp install`: the skill comes from the app's `resources/skills`, and the MCP
 * server is the app's `uplink-mcp` launcher (main/bridge.ts fills in these deps). Nothing here
 * changes anything until a click asks.
 *
 * Every system call goes through `AgentSetupDeps`, so the tests run it against a temporary home and
 * a scripted harness, never this computer's own ~/.claude, ~/.agents or MCP settings.
 */
export type AgentSetupDeps = {
  platform: "darwin" | "win32" | "linux";
  /** The app's resources/bin. */
  binDir: string;
  /** Linux: running from an AppImage, which mounts in a new temporary folder on every launch. */
  appImage?: boolean;
  /** The folder holding `uplink/SKILL.md`. */
  skills: string;
  env: Record<string, string | undefined>;
  /** macOS and Linux: the PATH a new terminal has, where `claude`, `codex` and `hermes` usually are. */
  shellPath: () => Promise<string[] | null>;
  run?: Runner;
};

/** A path under the home folder, as `~/...`. */
function tilde(path: string, env: Record<string, string | undefined>): string {
  const home = env["HOME"] || env["USERPROFILE"];
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export async function readAgentSetup(d: AgentSetupDeps): Promise<AgentSetup> {
  const skill = async (target: SkillTarget) => ({ state: await skillState(target, d.skills, d.env), path: tilde(skillDir(target, d.env), d.env) });
  const [claude, codex] = await Promise.all([skill("claude"), skill("codex")]);
  return { platform: d.platform, skills: { claude, codex } };
}

export async function installAgentSkill(d: AgentSetupDeps, target: SkillTarget): Promise<AgentSetup> {
  await installSkill(target, d.skills, d.env);
  return readAgentSetup(d);
}

export async function addMcpServer(d: AgentSetupDeps, harness: McpHarness): Promise<McpAdded> {
  // The harness keeps the command it's given, and an AppImage's resources/bin is gone once it quits.
  if (d.appImage)
    throw new Error(
      "The AppImage opens from a new temporary folder each time, so a harness can't keep a path to its uplink-mcp. Install the .deb from uplinkroom.com/download to add it.",
    );
  // An app opened from the Dock or Finder has the system's short PATH; a terminal's finds the harness.
  const shell = d.platform === "win32" ? null : await d.shellPath();
  const env = shell ? { ...d.env, PATH: shell.join(":") } : d.env;
  const program = mcpProgram({ UPLINK_BIN_DIR: d.binDir }, d.platform);
  const { command } = await installMcp(harness, program, env, d.run);
  return { harness, command: command.map(shQuote).join(" ") };
}
