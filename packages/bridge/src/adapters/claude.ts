import { isCommand } from "./process.ts";
import type { Adapter, RunUpdate } from "./types.ts";
export class ClaudeCodeAdapter implements Adapter {
  name = "claude";
  executable = "claude";
  matches(command: string) {
    return isCommand(command, "claude");
  }
}
export interface HookPayload {
  /**
   * Set when the hook fires inside a subagent or an in-process teammate, which run the same hooks as
   * the main session (code.claude.com/docs/en/hooks, "Common input fields").
   */
  agent_id?: string;
  tool_name?: string;
  tool_input?: { command?: string };
  message?: string;
  notification_type?: string;
}
export function hookUpdate(event: string, payload: HookPayload): RunUpdate | undefined {
  if (event === "PermissionRequest")
    return {
      state: "waiting",
      prompt: {
        kind: "approval",
        text: payload.message ?? `Allow ${payload.tool_name ?? "this action"}?`,
        action: payload.tool_input?.command,
      },
    };
  if (event === "Stop") return { state: "done" };
  if (event === "StopFailure") return { state: "failed" };
  if (["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event))
    return { state: "working" };
  if (event === "Notification" && payload.notification_type === "idle_prompt")
    return {
      state: "waiting",
      prompt: { kind: "question", text: payload.message ?? "Claude Code needs its driver." },
    };
  return undefined;
}
export const hookDecision = (answer: "allow" | "deny") => ({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: answer } },
});
