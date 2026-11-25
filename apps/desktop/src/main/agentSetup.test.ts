import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { addMcpServer, installAgentSkill, readAgentSetup, type AgentSetupDeps } from "./agentSetup";

/**
 * Settings, Command line's skill and MCP rows (ADR 0042), against a temporary home and a scripted
 * harness: nothing here touches this computer's own ~/.claude, ~/.agents or MCP settings.
 */
const SKILLS = resolve(import.meta.dirname, "../../../../packages/room-client/skills");
const BIN = "/Applications/Uplink Room.app/Contents/Resources/bin";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function deps(extra: Partial<AgentSetupDeps> = {}): Promise<AgentSetupDeps & { home: string }> {
  const home = await mkdtemp(join(tmpdir(), "uplink-agents-"));
  homes.push(home);
  return { platform: "darwin", binDir: BIN, skills: SKILLS, env: { HOME: home, PATH: "/usr/bin:/bin" }, shellPath: async () => null, home, ...extra };
}

test("the skill rows read each harness's folder, and Install copies the app's skill there", async () => {
  const d = await deps();
  expect(await readAgentSetup(d)).toEqual({
    platform: "darwin",
    skills: { claude: { state: "missing", path: join("~", ".claude", "skills", "uplink") }, codex: { state: "missing", path: join("~", ".agents", "skills", "uplink") } },
  });
  const after = await installAgentSkill(d, "codex");
  expect(after.skills).toMatchObject({ claude: { state: "missing" }, codex: { state: "current" } });
  expect(await readFile(join(d.home, ".agents", "skills", "uplink", "SKILL.md"), "utf8")).toBe(await readFile(join(SKILLS, "uplink", "SKILL.md"), "utf8"));
});

test("Add runs the harness's own mcp add with the app's uplink-mcp, on the PATH a new terminal has", async () => {
  const seen: { words: string[]; path: string | undefined }[] = [];
  const d = await deps({
    shellPath: async () => ["/Users/ana/.local/bin", "/opt/homebrew/bin", "/usr/bin"],
    run: async (words, env) => {
      seen.push({ words, path: env["PATH"] });
      return { code: 0, output: "" };
    },
  });
  expect(await addMcpServer(d, "claude")).toEqual({
    harness: "claude",
    command: `claude mcp add --scope user uplink -- '${BIN}/uplink-mcp'`,
  });
  expect(seen).toEqual([
    { words: ["claude", "mcp", "remove", "--scope", "user", "uplink"], path: "/Users/ana/.local/bin:/opt/homebrew/bin:/usr/bin" },
    { words: ["claude", "mcp", "add", "--scope", "user", "uplink", "--", `${BIN}/uplink-mcp`], path: "/Users/ana/.local/bin:/opt/homebrew/bin:/usr/bin" },
  ]);
  // A harness that isn't installed says so.
  const missing = await deps({
    run: async () => {
      throw new Error("hermes isn't installed here: it isn't on PATH.");
    },
  });
  await expect(addMcpServer(missing, "hermes")).rejects.toThrow("hermes isn't installed here");
  // An AppImage's launcher lives in a mount that's gone after it quits, so it registers nothing.
  let ran = false;
  const appImage = await deps({ platform: "linux", appImage: true, run: async () => ((ran = true), { code: 0, output: "" }) });
  await expect(addMcpServer(appImage, "claude")).rejects.toThrow("Install the .deb");
  expect(ran).toBe(false);
});
