/**
 * Setting up an agent harness to use this tool (ADR 0042): the `uplink` skill copied into Claude
 * Code's or Codex's personal skills folder (`uplink skills install`), and `uplink-mcp` registered
 * with a harness's own `mcp add` (`uplink mcp install`). The desktop app's Settings, Command line
 * calls the same functions.
 *
 * - Claude Code reads personal skills from `~/.claude/skills/<name>/SKILL.md`
 *   (code.claude.com/docs/en/skills, "Where skills live").
 * - Codex reads a user's skills from `$HOME/.agents/skills` (developers.openai.com/codex/skills,
 *   "Where Codex loads local skills").
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./config.ts";

export const SKILL_NAME = "uplink";

export type SkillTarget = "claude" | "codex";
export const SKILL_TARGETS: SkillTarget[] = ["claude", "codex"];
export const SKILL_TARGET_NAMES: Record<SkillTarget, string> = { claude: "Claude Code", codex: "Codex" };

/** The person's home folder: HOME (USERPROFILE on Windows) when set, so tests and scratch homes work. */
export function homeOf(env: Env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Where a harness reads this skill from: Claude Code's from CLAUDE_CONFIG_DIR when that is set. */
export function skillDir(target: SkillTarget, env: Env): string {
  if (target === "codex") return join(homeOf(env), ".agents", "skills", SKILL_NAME);
  return join(env.CLAUDE_CONFIG_DIR || join(homeOf(env), ".claude"), "skills", SKILL_NAME);
}

/**
 * Whether the skill is there: `missing`, `current` (every file this tool carries is there as it
 * carries it), or `outdated` (a file differs or is missing, such as one from an earlier version).
 */
export type SkillState = "missing" | "current" | "outdated";

async function files(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await files(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export async function skillState(target: SkillTarget, source: string, env: Env): Promise<SkillState> {
  const dest = skillDir(target, env);
  const there = await readFile(join(dest, "SKILL.md")).catch(() => undefined);
  if (!there) return "missing";
  const from = join(source, SKILL_NAME);
  for (const rel of await files(from)) {
    const [a, b] = await Promise.all([readFile(join(from, rel)), readFile(join(dest, rel)).catch(() => undefined)]);
    if (!b || !a.equals(b)) return "outdated";
  }
  return "current";
}

/**
 * Copies the skill from `source` (the folder holding `uplink/`) into the harness's folder,
 * replacing an earlier copy of it. Returns where it went.
 */
export async function installSkill(target: SkillTarget, source: string, env: Env): Promise<string> {
  const from = join(source, SKILL_NAME);
  await readFile(join(from, "SKILL.md")).catch(() => {
    throw new Error(`The skill isn't at ${from}.`);
  });
  const dest = skillDir(target, env);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(from, dest, { recursive: true });
  return dest;
}

export type McpHarness = "claude" | "codex" | "hermes";
export const MCP_HARNESSES: McpHarness[] = ["claude", "codex", "hermes"];
export const MCP_HARNESS_NAMES: Record<McpHarness, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

/**
 * The harness's own commands that register `program` (self.ts `mcpProgram`) as the stdio MCP server
 * `name`: an earlier one by that name is removed first, so installing again replaces it. Claude
 * Code's goes in the user scope, so every project has it (`claude mcp add --scope user`).
 */
export function mcpCommands(harness: McpHarness, program: string[], name = "uplink"): { remove: string[]; add: string[] } {
  switch (harness) {
    case "claude":
      return { remove: ["claude", "mcp", "remove", "--scope", "user", name], add: ["claude", "mcp", "add", "--scope", "user", name, "--", ...program] };
    case "codex":
      return { remove: ["codex", "mcp", "remove", name], add: ["codex", "mcp", "add", name, "--", ...program] };
    case "hermes":
      return {
        remove: ["hermes", "mcp", "remove", name],
        // --args must be the last option (hermes mcp add --help).
        add: ["hermes", "mcp", "add", name, "--command", program[0]!, ...(program.length > 1 ? ["--args", ...program.slice(1)] : [])],
      };
  }
}

/** A word for cmd's command line: quoted when it holds a space or a character cmd reads. */
export function cmdQuote(word: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(word) ? word : `"${word.replaceAll('"', '""')}"`;
}

export type Ran = { code: number; output: string };
export type Runner = (words: string[], env: Env) => Promise<Ran>;

/** Runs a command without a shell, with no input, and returns its exit code and what it printed. */
export const runCommand: Runner = (words, env) =>
  new Promise((resolve, reject) => {
    const options = { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[], windowsHide: true };
    // `claude` and `codex` from npm are .cmd shims on Windows, which only cmd starts. Node hands a
    // shell command line to `cmd /d /s /c "..."` as is, so each word is quoted here.
    const child =
      process.platform === "win32"
        ? spawn(words.map(cmdQuote).join(" "), [], { ...options, shell: true })
        : spawn(words[0]!, words.slice(1), options);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error(`${words[0]} isn't installed here: it isn't on PATH.`) : error),
    );
    child.once("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });

/**
 * Registers `uplink-mcp` with the harness. Removing an earlier registration may fail (there was
 * none); adding must succeed. Returns the add command, as a person would type it.
 */
export async function installMcp(harness: McpHarness, program: string[], env: Env, run: Runner = runCommand): Promise<{ command: string[]; output: string }> {
  const { remove, add } = mcpCommands(harness, program);
  await run(remove, env).catch((error: Error) => {
    // A missing harness fails here first; anything else can't stop the add.
    if (/isn't installed/.test(error.message)) throw error;
  });
  const result = await run(add, env);
  if (result.code !== 0) throw new Error(`${add.slice(0, 3).join(" ")} failed (exit ${result.code})${result.output ? `: ${result.output.split("\n").slice(-3).join(" ")}` : "."}`);
  return { command: add, output: result.output };
}
