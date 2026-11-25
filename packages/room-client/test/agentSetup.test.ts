/**
 * How the tool runs itself from source and from the desktop app's launchers (self.ts), and
 * `uplink skills install` and `uplink mcp install` (agentSetup.ts), against temporary homes and a
 * scripted harness: nothing here touches this computer's own ~/.claude, ~/.agents or MCP config.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { skillState, type Runner } from "../src/agentSetup.ts";
import { claudeHooks } from "../src/claudeSettings.ts";
import { main } from "../src/cli.ts";
import { hookProgram, keeperProgram, mcpProgram, skillsSource } from "../src/self.ts";
import { tempDir } from "./support.ts";

const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

async function run(argv: string[], env: Record<string, string>, runner?: Runner) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { env, stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), ...(runner ? { run: runner } : {}) });
  return { code, stdout, stderr };
}

test("from source the tool runs as node and its own files; from the app, as the launchers beside it", () => {
  expect(hookProgram({}, "darwin")).toEqual({ exec: [process.execPath, ...process.execArgv, fileURLToPath(new URL("../src/cli.ts", import.meta.url))] });
  expect(mcpProgram({}, "linux")).toEqual([process.execPath, fileURLToPath(new URL("../src/mcp.ts", import.meta.url))]);
  expect(skillsSource({})).toBe(SKILLS);

  const mac = { UPLINK_BIN_DIR: "/Applications/Uplink Room.app/Contents/Resources/bin" };
  expect(hookProgram(mac, "darwin")).toEqual({ exec: ["/Applications/Uplink Room.app/Contents/Resources/bin/uplink"] });
  expect(mcpProgram(mac, "darwin")).toEqual(["/Applications/Uplink Room.app/Contents/Resources/bin/uplink-mcp"]);
  expect(skillsSource(mac, "darwin")).toBe("/Applications/Uplink Room.app/Contents/Resources/skills");
  // The keeper runs the same script on the same runtime, never the source file.
  const keeper = keeperProgram(mac);
  expect(keeper.words[0]).toBe(process.execPath);
  expect(keeper.words.at(-1)).toBe(process.argv[1]);

  // Windows: the .cmd starts only through cmd, and Claude Code's hook shell (Git Bash) runs the
  // extensionless launcher by a forward-slashed path. %~dp0 leaves a trailing backslash.
  const win = { UPLINK_BIN_DIR: "C:\\Users\\Ana\\AppData\\Local\\Programs\\Uplink Room\\resources\\bin\\" };
  expect(mcpProgram(win, "win32")).toEqual(["cmd", "/c", "C:\\Users\\Ana\\AppData\\Local\\Programs\\Uplink Room\\resources\\bin\\uplink-mcp.cmd"]);
  expect(skillsSource(win, "win32")).toBe("C:\\Users\\Ana\\AppData\\Local\\Programs\\Uplink Room\\resources\\skills");
  const shell = hookProgram(win, "win32");
  expect(shell).toEqual({ shell: "'C:/Users/Ana/AppData/Local/Programs/Uplink Room/resources/bin/uplink'" });
  const hooks = claudeHooks(shell, "C:\\Users\\Ana\\.uplink-room");
  expect(hooks.Stop![0]!.hooks[0]).toEqual({
    type: "command",
    command: "'C:/Users/Ana/AppData/Local/Programs/Uplink Room/resources/bin/uplink' hook claude stop --home 'C:\\Users\\Ana\\.uplink-room'",
    timeout: 604800,
    asyncRewake: true,
  });
});

test("uplink skills install copies the skill for Claude Code and Codex into the home it's given, and again over an older copy", async () => {
  const home = await tempDir("uplink-skills-");
  const env = { HOME: home, USERPROFILE: home };
  const claude = join(home, ".claude", "skills", "uplink");
  const codex = join(home, ".agents", "skills", "uplink");
  expect(await skillState("claude", SKILLS, env)).toBe("missing");

  const only = await run(["skills", "install", "--claude"], env);
  expect(only).toMatchObject({ code: 0, stderr: "" });
  expect(only.stdout).toContain(`for Claude Code in ${claude}`);
  const skill = await readFile(join(claude, "SKILL.md"), "utf8");
  expect(skill).toBe(await readFile(join(SKILLS, "uplink", "SKILL.md"), "utf8"));
  expect(skill).toMatch(/^---\nname: uplink\ndescription: Use when the user asks to talk to, message, pair with/);
  expect(await skillState("claude", SKILLS, env)).toBe("current");
  expect(await skillState("codex", SKILLS, env)).toBe("missing");

  // An older copy is replaced, with nothing of it left over.
  await writeFile(join(claude, "SKILL.md"), "old\n");
  await mkdir(join(claude, "references"));
  await writeFile(join(claude, "references", "old.md"), "old\n");
  expect(await skillState("claude", SKILLS, env)).toBe("outdated");
  const both = await run(["skills", "install"], env);
  expect(both.code).toBe(0);
  expect(both.stdout).toContain(`for Codex in ${codex}`);
  expect(await skillState("claude", SKILLS, env)).toBe("current");
  expect(await skillState("codex", SKILLS, env)).toBe("current");
  await expect(readFile(join(claude, "references", "old.md"))).rejects.toThrow();

  // Claude Code reads personal skills from CLAUDE_CONFIG_DIR when it is set.
  const config = join(home, "profile-a");
  const profiled = await run(["skills", "install", "--claude"], { ...env, CLAUDE_CONFIG_DIR: config });
  expect(profiled.stdout).toContain(`for Claude Code in ${join(config, "skills", "uplink")}`);
  expect(await skillState("claude", SKILLS, { ...env, CLAUDE_CONFIG_DIR: config })).toBe("current");
});

// The paths below are a Mac's and Linux's: on Windows the tool registers `cmd /c ...uplink-mcp.cmd`
// instead, which the first test checks through mcpProgram.
test.skipIf(process.platform === "win32")("uplink mcp install runs each harness's own remove, then add, with this tool's MCP server", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (words) => {
    calls.push(words);
    return words.includes("remove") ? { code: 1, output: "No MCP server named uplink" } : { code: 0, output: "" };
  };
  const env = { UPLINK_BIN_DIR: "/opt/Uplink Room/resources/bin" };
  const server = "/opt/Uplink Room/resources/bin/uplink-mcp";

  expect((await run(["mcp", "install", "claude"], env, runner)).code).toBe(0);
  expect(await run(["mcp", "install", "codex", "--channel"], env, runner)).toMatchObject({ code: 0 });
  const hermes = await run(["mcp", "install", "hermes"], env, runner);
  expect(hermes.stdout).toContain(`Added uplink-mcp to Hermes: hermes mcp add uplink --command '${server}'`);
  expect(calls).toEqual([
    ["claude", "mcp", "remove", "--scope", "user", "uplink"],
    ["claude", "mcp", "add", "--scope", "user", "uplink", "--", server],
    ["codex", "mcp", "remove", "uplink"],
    ["codex", "mcp", "add", "uplink", "--", server, "--channel"],
    ["hermes", "mcp", "remove", "uplink"],
    ["hermes", "mcp", "add", "uplink", "--command", server],
  ]);

  // From source, Hermes gets node as the command and the script as its --args.
  calls.length = 0;
  await run(["mcp", "install", "hermes"], {}, runner);
  expect(calls[1]).toEqual(["hermes", "mcp", "add", "uplink", "--command", process.execPath, "--args", fileURLToPath(new URL("../src/mcp.ts", import.meta.url))]);

  // A failed add, a missing harness and an unknown one each exit 1 and say why.
  const failed = await run(["mcp", "install", "claude"], env, async (words) => (words.includes("add") ? { code: 1, output: "line 1\nInvalid scope" } : { code: 0, output: "" }));
  expect(failed).toMatchObject({ code: 1, stderr: "error: claude mcp add failed (exit 1): line 1 Invalid scope\n" });
  const missing = await run(["mcp", "install", "codex"], env, async () => {
    throw new Error("codex isn't installed here: it isn't on PATH.");
  });
  expect(missing).toMatchObject({ code: 1, stderr: "error: codex isn't installed here: it isn't on PATH.\n" });
  expect(await run(["mcp", "install", "cursor"], env, runner)).toMatchObject({ code: 1, stderr: "usage: The harness is one of claude, codex, hermes.\n" });
});
