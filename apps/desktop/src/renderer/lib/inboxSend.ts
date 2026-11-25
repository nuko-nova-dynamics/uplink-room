import type { MachineRow } from "./api";
import { machineBlock } from "./machinePick";

/**
 * A message sent from the Inbox's box starts work at once, as T3 Code starts a thread on Enter: it
 * becomes a task, and a thread in T3 Code starts on it with the message as its first prompt. No
 * dialog asks for a title, a machine or a harness first.
 */

/** What the thread runs. */
export const INBOX_HARNESS = "claude-code";

/** Longest task title taken from a message; a longer first line is cut at a word. */
const TITLE_MAX = 80;

/**
 * Where the thread starts: a machine that can take a run now and whose bridge has T3 Code connected,
 * one whose bridge found Claude Code (`claude` in its tools) before one that didn't, and your own
 * first. Undefined when none can, and the message is kept as a task to start later.
 */
export function threadMachine(
  machines: readonly MachineRow[],
  mineOn: (machine: MachineRow) => boolean,
): MachineRow | undefined {
  const open = machines.filter(
    (m) => m.t3?.state === "connected" && machineBlock(m, mineOn(m)) === null,
  );
  const claude = open.filter((m) => m.tools.includes("claude"));
  const best = claude.length ? claude : open;
  return best.find(mineOn) ?? best[0];
}

/** The task's title: the message's first line, cut at a word to fit. */
export function taskTitle(message: string): string {
  const line = message.trim().split("\n")[0]!.trim();
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
