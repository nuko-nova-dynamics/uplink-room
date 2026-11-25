import { isCommand } from "./process.ts";
import type { Adapter, RunUpdate } from "./types.ts";

/**
 * Hermes Agent in a terminal (ADR 0040). The bridge follows the terminal's session on the profile's
 * gateway (`hermesTerminal.ts`), so this adapter only names the tool. Its name is the room's harness
 * name, so a shared `hermes` terminal shows as a Hermes Agent run.
 */
export class HermesAdapter implements Adapter {
  name = "hermes-agent";
  executable = "hermes";
  matches(command: string) {
    return isCommand(command, "hermes");
  }
}

/**
 * The run state a session event on Hermes's gateway says (canonical events, Hermes v0.23.0): a turn
 * runs from `message.start` to `message.complete`, whose `outcome` says how it ended. An approval or
 * a question the agent asks waits for the person in the terminal: the room can't answer it yet.
 */
export function hermesEventUpdate(type: string, payload: Record<string, unknown>): RunUpdate | undefined {
  if (type === "message.start" || type === "tool.start" || type === "approval.settled" || type === "clarify.settled") return { state: "working" };
  if (type === "approval.request" || type === "clarify.request") return { state: "waiting", prompt: { kind: "question", text: `${promptText(type, payload)} Answer it in the terminal.` } };
  if (type === "message.complete") {
    const outcome = payload.outcome;
    if (outcome === "failed") return { state: "failed" };
    // A turn lost in a gateway crash: the room can't tell how it ended.
    if (outcome === "unknown") return { state: "unknown" };
    return { state: "done" };
  }
  return undefined;
}

function promptText(type: string, payload: Record<string, unknown>) {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  if (type === "clarify.request") return text(payload.question) ?? "Hermes Agent asks a question.";
  const description = text(payload.description);
  const command = text(payload.command);
  if (description && command) return `${description}: ${command}.`;
  return command ? `Allow ${command}?` : (description ?? "Hermes Agent asks to go on.");
}
