import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { launcherCommand } from "./shellQuote";

const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

/** Each of PowerShell's single quotes in a Windows profile folder's name. */
const NAMES = ["D'Angelo", "D‘Angelo", "D’Angelo", "D‚Angelo", "D‛Angelo"];
const launcher = (name: string) => `C:\\Users\\${name}\\AppData\\Local\\Programs\\Uplink Room\\resources\\bin\\uplink-bridge.cmd`;

test("bridgeCommand's Windows form calls the launcher by its full path, every quote doubled", () => {
  expect(launcherCommand(launcher("D’Angelo"), "win32")).toBe(`& 'C:\\Users\\D’’Angelo\\AppData\\Local\\Programs\\Uplink Room\\resources\\bin\\uplink-bridge.cmd'`);
  expect(launcherCommand("/Applications/Uplink Room.app/Contents/Resources/bin/uplink-bridge", "darwin")).toBe(
    "'/Applications/Uplink Room.app/Contents/Resources/bin/uplink-bridge'",
  );
});

// One pwsh parses every command, and has time to start: under the whole suite's load a start takes seconds.
test.runIf(has("pwsh"))("PowerShell's parser reads the pair command as the call operator, the launcher's exact path, then its arguments", () => {
  const commands = NAMES.map((name) => `${launcherCommand(launcher(name), "win32")} pair JQJG-9PUM --url https://fleet-jaguar-632.convex.cloud`);
  // The commands reach pwsh as JSON in an environment variable, so nothing on the way can requote them.
  const script = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$results = foreach ($text in ($env:UPLINK_COMMANDS | ConvertFrom-Json)) {",
    "  $errors = $null",
    "  $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$errors)",
    "  $command = $ast.EndBlock.Statements[0].PipelineElements[0]",
    "  [pscustomobject]@{",
    "    errors = @($errors).Count",
    "    operator = $command.InvocationOperator.ToString()",
    "    elements = @($command.CommandElements | ForEach-Object { $_.Extent.Text })",
    "    launcher = $command.CommandElements[0].Value",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($results) -Compress -Depth 3",
  ].join("\n");
  const out = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, UPLINK_COMMANDS: JSON.stringify(commands) },
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as { errors: number; operator: string; elements: string[]; launcher: string }[];
  expect(parsed).toHaveLength(NAMES.length);
  NAMES.forEach((name, i) => {
    expect(parsed[i], name).toMatchObject({ errors: 0, operator: "Ampersand", launcher: launcher(name) });
    expect(parsed[i]!.elements.slice(1), name).toEqual(["pair", "JQJG-9PUM", "--url", "https://fleet-jaguar-632.convex.cloud"]);
  });
}, 30_000);
