import { expect, test } from "vitest";
import { claudeHooksSettings, withClaudeSettings } from "../src/claudeHooks.ts";
import { quoteArgument } from "../src/platform.ts";

test("the hooks run this bridge's own command in exec form, and on Windows uplink-bridge from PATH in the hook shell", () => {
  const posix = claudeHooksSettings(["/usr/local/bin/node", "/opt/uplink/bridge.mjs"], "darwin");
  expect(posix.hooks.PostToolUse).toEqual([
    { matcher: "*", hooks: [{ type: "command", command: "/usr/local/bin/node", args: ["/opt/uplink/bridge.mjs", "hook", "PostToolUse"], timeout: 30 }] },
  ]);
  expect(posix.hooks.Stop[0]!.hooks).toEqual([
    { type: "command", command: "/usr/local/bin/node", args: ["/opt/uplink/bridge.mjs", "hook", "Stop"], timeout: 30 },
    { type: "command", command: "/usr/local/bin/node", args: ["/opt/uplink/bridge.mjs", "inbox", "--wait"], asyncRewake: true, timeout: 604800 },
  ]);
  // A turn that ends in an API error fires StopFailure instead of Stop: it reports the turn failed
  // and arms the same waiter, so a message still wakes the session.
  expect(posix.hooks.StopFailure[0]!.hooks).toEqual([
    { type: "command", command: "/usr/local/bin/node", args: ["/opt/uplink/bridge.mjs", "hook", "StopFailure"], timeout: 30 },
    { type: "command", command: "/usr/local/bin/node", args: ["/opt/uplink/bridge.mjs", "inbox", "--wait"], asyncRewake: true, timeout: 604800 },
  ]);
  const windows = claudeHooksSettings(["C:\\Program Files\\Uplink Room\\resources\\bin\\uplink-bridge.cmd"], "win32");
  expect(windows.hooks.SessionStart[0]!.hooks).toEqual([{ type: "command", command: "uplink-bridge inbox --wait", asyncRewake: true, timeout: 604800 }]);
  // Only hooks: no setting of the person's is overridden, and approvals stay in the terminal.
  expect(Object.keys(posix)).toEqual(["hooks"]);
  expect(Object.keys(posix.hooks)).not.toContain("PermissionRequest");
});

// POSIX quoting; isCommand reads a command the way this machine's shell does.
test.skipIf(process.platform === "win32")("--settings goes right after the program word of a command that starts claude, and nowhere else", () => {
  const file = "/home/ana/.uplink-room/claude-hooks.json";
  expect(withClaudeSettings("claude", file, {}, "linux")).toBe(`claude --settings '${file}'`);
  expect(withClaudeSettings("'/opt/my tools/claude' '--model' 'x'", file, {}, "linux")).toBe(`'/opt/my tools/claude' --settings '${file}' '--model' 'x'`);
  expect(withClaudeSettings("claude -- 'fix it'", file, {}, "linux")).toBe(`claude --settings '${file}' -- 'fix it'`);
  expect(withClaudeSettings("codex", file, {}, "linux")).toBe("codex");
  expect(withClaudeSettings("echo claude", file, {}, "linux")).toBe("echo claude");
});

// PowerShell treats ‘ ’ ‚ ‛ as single quotes too (CharTraits.IsSingleQuote), so each is doubled.
const OBRIEN = "C:\\Users\\O’Brien‘s ‚x‛ 'y'\\.uplink-room\\claude-hooks.json";

test("a settings path with a curly apostrophe is quoted for PowerShell, which treats it as a quote", () => {
  expect(quoteArgument(OBRIEN, { UPLINK_BRIDGE_SHELL: "powershell.exe" }, "win32")).toBe(
    "'C:\\Users\\O’’Brien‘‘s ‚‚x‛‛ ''y''\\.uplink-room\\claude-hooks.json'",
  );
});

test.runIf(process.platform === "win32")("PowerShell reads such a quoted path back unchanged", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "uplink-quote-"));
  try {
    const out = join(dir, "out.txt");
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      const env = { ...process.env, UPLINK_BRIDGE_SHELL: shell };
      const script = `[IO.File]::WriteAllText(${quoteArgument(out, env, "win32")}, ${quoteArgument(OBRIEN, env, "win32")})`;
      const run = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
      if (run.error && shell === "pwsh.exe") continue; // PowerShell 7 isn't on every machine.
      expect(run.status).toBe(0);
      expect(await readFile(out, "utf8")).toBe(OBRIEN);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
