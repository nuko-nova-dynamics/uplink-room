/**
 * The Claude Code hooks the bridge installs for a terminal it starts with `claude` (ADR 0026): a
 * settings file in the bridge's own folder, passed with `--settings`, which adds hooks for that
 * session only and never touches the person's own settings. Hooks from `--settings` merge with
 * theirs (code.claude.com/docs/en/hooks: "Hook entries merge across settings levels rather than
 * replacing each other"; docs/en/cli-reference: `--settings`).
 *
 * - `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`: report Working, and hand the run its
 *   waiting messages as `additionalContext` (`uplink-bridge hook EVENT`).
 * - `Stop`: report Done; and a waiter, `uplink-bridge inbox --wait`, run with `asyncRewake`, which
 *   exits 2 with the messages when one arrives, so Claude Code wakes the idle session with them.
 * - `StopFailure`, which Claude Code fires instead of `Stop` when a turn ends in an API error: report
 *   Failed, and the same waiter. Claude Code ignores a `StopFailure` hook's output, but an
 *   `asyncRewake` hook started from it still wakes the session when it exits 2 (checked with
 *   Claude Code 2.1.318 on 2026-11-05, a `model_not_found` error).
 * - `SessionStart`: the same waiter, so a session that hasn't finished a turn yet can be woken too.
 *
 * The waiter's timeout is long on purpose. Claude Code enforces a hook's `timeout` on `asyncRewake`
 * hooks (600 seconds by default), and once a waiter ends nothing starts another until a turn ends,
 * so a session idle longer than the timeout would stop hearing messages (#138, test 6). Claude Code
 * 2.1.318 doesn't cap the value: it passes `timeout * 1000` to a JavaScript timer, whose limit is
 * 2^31 - 1 ms (about 24.8 days), so the waiter stays under that.
 *
 * No `PermissionRequest` hook: approvals stay in the terminal for a session the bridge started this
 * way, as they were before it installed hooks.
 */
import { quoteArgument } from "./platform.ts";
import { isCommand } from "./adapters/process.ts";

/** How long an idle session's waiter waits, in seconds: 7 days, well under the timer's limit. */
export const WAITER_TIMEOUT_S = 7 * 24 * 60 * 60;
/**
 * The other hooks answer at once, and never wait on a message's files, which the bridge saves
 * outside them (ADR 0043); this only bounds a bridge that stopped answering.
 */
const HOOK_TIMEOUT_S = 30;

type Platform = NodeJS.Platform;

/**
 * One hook that runs this bridge's CLI with `args`. On macOS and Linux it runs in exec form (the
 * `command` and `args` fields), with the exact words that started this bridge, so the hook reaches
 * it even when `uplink-bridge` on PATH is another install. On Windows exec form can't start the
 * app's `.cmd` launcher, so it runs `uplink-bridge` in Claude Code's hook shell, found on the PATH
 * the bridge gives its terminals (README, Operating systems).
 */
function hook(bridge: string[], args: string[], platform: Platform, extra: Record<string, unknown> = {}) {
  const run = platform === "win32" ? { command: ["uplink-bridge", ...args].join(" ") } : { command: bridge[0]!, args: [...bridge.slice(1), ...args] };
  return { type: "command", ...run, ...extra };
}

/** The settings file's contents: only `hooks`, so no setting of the person's is overridden. */
export function claudeHooksSettings(bridge: string[], platform: Platform = process.platform) {
  const call = (event: string) => hook(bridge, ["hook", event], platform, { timeout: HOOK_TIMEOUT_S });
  const waiter = hook(bridge, ["inbox", "--wait"], platform, { asyncRewake: true, timeout: WAITER_TIMEOUT_S });
  return {
    hooks: {
      SessionStart: [{ hooks: [waiter] }],
      UserPromptSubmit: [{ hooks: [call("UserPromptSubmit")] }],
      PostToolUse: [{ matcher: "*", hooks: [call("PostToolUse")] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [call("PostToolUseFailure")] }],
      Stop: [{ hooks: [call("Stop"), waiter] }],
      // A turn that ends in an API error fires StopFailure instead of Stop (code.claude.com/docs/en/hooks).
      StopFailure: [{ hooks: [call("StopFailure"), waiter] }],
    },
  };
}

/** The program word at the start of a command line: `claude`, `'/opt/bin/claude'`, `& 'C:\x\claude.exe'`. */
const PROGRAM = /^\s*(?:&\s*)?(?:'(?:[^']|'\\'')*'|"[^"]*"|[^\s'"]+)/;

/**
 * A command that starts Claude Code, with `--settings FILE` after its program word, or the command
 * unchanged when it doesn't start `claude`.
 */
export function withClaudeSettings(command: string, file: string, env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform) {
  if (!isCommand(command, "claude")) return command;
  const program = PROGRAM.exec(command)?.[0];
  if (!program) return command;
  return `${program} --settings ${quoteArgument(file, env, platform)}${command.slice(program.length)}`;
}
