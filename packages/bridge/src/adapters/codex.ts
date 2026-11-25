import { isCommand } from "./process.ts";
import type { Adapter, RunUpdate } from "./types.ts";

/**
 * Codex in a terminal (ADR 0038). A terminal the bridge starts with `codex` runs it on an app server
 * of its own with the bridge's hooks (`codexHooks.ts`, `uplink-bridge codex`); the hooks report the
 * run's state through `codex-hook`, so this adapter only names the tool.
 */
export class CodexAdapter implements Adapter {
  name = "codex";
  executable = "codex";
  matches(command: string) {
    return isCommand(command, "codex");
  }
}

/**
 * A Codex hook's input (learn.chatgpt.com/docs/hooks.md, "Common input fields" and each event's
 * table). `session_id` is the session's thread; a subagent's hooks carry its parent's.
 */
export interface CodexHookPayload {
  session_id?: string;
  turn_id?: string;
  source?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; description?: unknown };
  tool_response?: unknown;
}

/**
 * The run state a Codex hook says. A turn runs from `UserPromptSubmit` to `Stop`, or to `Interrupt`
 * when the person stops it; `PermissionRequest` waits for an approval. Codex fires no hook when a turn
 * fails (checked with Codex 0.166.0: only `SessionStart` and `UserPromptSubmit` fired for a turn that
 * failed with "model not allowed"), so Failed comes from the app server's `turn/completed` instead.
 */
export function codexHookUpdate(event: string, payload: CodexHookPayload): RunUpdate | undefined {
  if (event === "PermissionRequest") {
    const input = payload.tool_input ?? {};
    const command = typeof input.command === "string" ? input.command : undefined;
    const description = typeof input.description === "string" && input.description ? input.description : undefined;
    return {
      state: "waiting",
      prompt: { kind: "approval", text: description ?? `Allow ${payload.tool_name ?? "this action"}?`, ...(command ? { action: command } : {}) },
    };
  }
  if (event === "Stop" || event === "Interrupt") return { state: "done" };
  if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") return { state: "working" };
  return undefined;
}
