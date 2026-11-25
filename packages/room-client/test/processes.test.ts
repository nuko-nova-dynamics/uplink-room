/**
 * The harness process a joined session runs under (processes.ts, ADR 0032): found through the
 * process list on every platform, Windows included, so the keeper ends the run when it exits and
 * only processes it started act as the session.
 */
import { expect, test } from "vitest";
import { ancestors, claudeLaunch, findHarnessProcess, windowsProcessTable } from "../src/processes.ts";

/** What Get-CimInstance Win32_Process gives, as ConvertTo-Json writes it. */
const WINDOWS = JSON.stringify([
  { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null },
  { ProcessId: 100, ParentProcessId: 4, Name: "WindowsTerminal.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\WindowsTerminal.exe"' },
  { ProcessId: 200, ParentProcessId: 100, Name: "claude.exe", CommandLine: '"C:\\Users\\pepe\\.local\\bin\\claude.exe" --setting-sources project' },
  { ProcessId: 300, ParentProcessId: 200, Name: "bash.exe", CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "uplink inbox"' },
  { ProcessId: 400, ParentProcessId: 300, Name: "node.exe", CommandLine: "node C:\\uplink\\src\\cli.ts inbox" },
  {
    ProcessId: 500,
    ParentProcessId: 100,
    Name: "node.exe",
    CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\pepe\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
  },
  { ProcessId: 510, ParentProcessId: 500, Name: "codex-x86_64-pc-windows-msvc.exe", CommandLine: "codex-x86_64-pc-windows-msvc.exe" },
  { ProcessId: 520, ParentProcessId: 510, Name: "pwsh.exe", CommandLine: "pwsh -Command uplink inbox" },
]);

test("on Windows the harness is found in the process list: Claude Code's own program, and Codex under its npm launcher", async () => {
  const table = windowsProcessTable(async () => WINDOWS);
  const claude = await findHarnessProcess("claude-code", 300, table);
  expect(claude).toMatchObject({ pid: 200 });
  expect(claudeLaunch(claude!.args).settingSources).toEqual(["project"]);
  expect(await findHarnessProcess("codex", 520, table)).toMatchObject({ pid: 510 });
  expect(await ancestors(400, table)).toEqual([400, 300, 200, 100, 4]);
});

test.runIf(process.platform === "win32")("on Windows this process's own parents come from the system's process list", async () => {
  const parents = await ancestors();
  expect(parents[0]).toBe(process.ppid);
  expect(parents.length).toBeGreaterThan(1);
  // The test runner is node, so a node process is above this one.
  const node = await findHarnessProcess("node");
  expect(parents).toContain(node!.pid);
});
