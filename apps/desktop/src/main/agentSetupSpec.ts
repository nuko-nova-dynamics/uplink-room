/**
 * Settings, Command line's agent setup (main/agentSetup.ts, ADR 0042): whether the `uplink` skill
 * is in Claude Code's and Codex's skills folders, and what adding `uplink-mcp` to a harness ran.
 * Types only, so the renderer, the gym and the tests share them.
 */

/** `missing`; `current`, as this app carries it; `outdated`, from an earlier version. */
export type SkillState = "missing" | "current" | "outdated";
export type SkillTarget = "claude" | "codex";
export type McpHarness = "claude" | "codex" | "hermes";

export const SKILL_TARGET_LABELS: Record<SkillTarget, string> = { claude: "Claude Code", codex: "Codex" };
export const MCP_HARNESS_LABELS: Record<McpHarness, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

export type AgentSetup = {
  platform: "darwin" | "win32" | "linux";
  /** Each harness's copy of the skill: its state and folder (`~` for the home folder). */
  skills: Record<SkillTarget, { state: SkillState; path: string }>;
};

/** What adding the MCP server ran, as a person would type it. */
export type McpAdded = { harness: McpHarness; command: string };
