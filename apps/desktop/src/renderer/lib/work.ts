/**
 * Logic behind the work surfaces (Inbox, board, task panel, terminals) that needs no page, so it
 * can be tested on its own.
 */

import { withoutTerminalReplies } from "@uplink-room/protocol/terminalReplies";
import { ago, agoText, clock } from "./format";
import { STATE_META } from "./states";

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC = /\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
/** Bracketed paste's start and end markers, which a program asks for around pasted text. */
const PASTE_MARKS = /\x1b\[20[01]~/g;
/** The arrow keys, in normal and application cursor mode. */
const ARROW_KEYS = /\x1b[[O]([ABCD])/g;
/** Ctrl with a letter: ^A to ^Z, once Enter, Tab and newline have their own symbols. */
const CTRL_LETTER = /[\x01-\x1a]/g;
/** What's left of the C0 controls after that: shown as nothing. */
const OTHER_CONTROL = /[\x00\x1c-\x1f]/g;
/* eslint-enable no-control-regex */

/**
 * The last lines a terminal printed, as plain text, for a run card's preview. Escape sequences
 * (colors, cursor moves, titles) are dropped, and a carriage return keeps only what was written
 * after it, as the screen would show it. Blank lines don't count.
 */
export function outputTail(chunks: string[], count = 3): string[] {
  const text = chunks.join("").replace(OSC, "").replace(CSI, "").replace(ESC, "");
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const segments = raw.split("\r").filter((s) => s.length > 0);
    const line = (segments.at(-1) ?? "").replace(CONTROL, "").trimEnd();
    if (line.trim()) lines.push(line);
  }
  return lines.slice(-count);
}

export type InputEntry = {
  at: number;
  by: { memberId: string; name: string };
  data: string;
  suggestedBy?: { memberId: string; name: string } | undefined;
  /** "reply": the member's screen answering the program on its own. Absent on input from before replies were marked. */
  kind?: "typed" | "reply" | undefined;
};

/**
 * "Who typed what", one line per burst of typing: keystrokes the same person sent within
 * `gapMs` of each other join into one line, newest burst first, as the log is read. A sent
 * suggestion always stands on its own line, so who suggested it stays visible. A screen's own
 * replies never join typing: replies in a row join into one line of their own, however far apart.
 */
export function groupInput(newestFirst: InputEntry[], gapMs = 4000): InputEntry[] {
  const groups: InputEntry[] = [];
  // Walk oldest first so text joins in the order it was typed.
  for (const entry of [...newestFirst].reverse()) {
    const last = groups.at(-1);
    if (
      last &&
      !last.suggestedBy &&
      !entry.suggestedBy &&
      last.kind === entry.kind &&
      last.by.memberId === entry.by.memberId &&
      (entry.kind === "reply" || (entry.at - last.at <= gapMs && !last.data.endsWith("\r")))
    ) {
      groups[groups.length - 1] = { ...last, at: entry.at, data: last.data + entry.data };
    } else groups.push({ ...entry });
  }
  return groups.reverse();
}

const ARROWS: Record<string, string> = { A: "↑", B: "↓", C: "→", D: "←" };

/**
 * What a typed burst looks like in the log: Enter as ↵, Tab as ⇥, Backspace as ⌫, the arrow keys as
 * arrows, Escape as ⎋ and a Ctrl key as ^C. Pasted text shows without the markers a program asks for
 * around it. Input recorded before replies were marked (`legacy`) has the screen's own replies mixed
 * in with what was typed, and shows without them; newer typing shows whole, Shift+F3 included, since
 * its replies are recorded apart.
 */
export function showTyped(data: string, { legacy = false }: { legacy?: boolean } = {}): string {
  return (
    (legacy ? withoutTerminalReplies(data) : data)
      .replace(PASTE_MARKS, "")
      .replace(ARROW_KEYS, (_, key: string) => ARROWS[key]!)
      .replace(/\r\n?|\n/g, "↵")
      .replaceAll("\t", "⇥")
      .replaceAll("\u001b", "⎋")
      .replaceAll("\u007f", "⌫")
      .replace(CTRL_LETTER, (c) => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`)
      .replace(OTHER_CONTROL, "")
  );
}

/** A screen's own replies as the log shows them: the sequences as sent, with Escape as ⎋. */
export function showReply(data: string): string {
  return data.replaceAll("\u001b", "⎋").replaceAll("\u0007", "");
}

/**
 * Plain text for the reason codes a bridge reports when a thread or terminal doesn't start (protocol
 * `thread_start_failed`, `terminal_start_failed`).
 */
const START_FAIL_TEXT: Record<string, string> = {
  sharing_stopped: "Sharing is stopped on its machine.",
  owner_only:
    "Its machine's own limit is below Ask for control, so it takes runs only from whoever it belongs to and their agents.",
  t3_not_paired: "T3 Code isn't paired with the bridge on its machine.",
  t3_unavailable: "T3 Code isn't running on its machine.",
  t3_auth: "T3 Code refused the bridge's sign-in.",
  project_not_registered: "The repo isn't a project in T3 Code on its machine.",
  harness_disabled: "That harness is turned off in T3 Code.",
  mode_unsupported: "T3 Code can't run that harness this way.",
  launch_failed: "T3 Code couldn't start the thread.",
};

/**
 * Why a run failed, in words: the reason the room recorded, with a bridge's reason code turned
 * into a sentence and its own detail kept. Undefined when the room recorded none.
 */
export function failText(reason: string | undefined): string | undefined {
  if (!reason?.trim()) return undefined;
  const [code, ...rest] = reason.split(": ");
  const known = START_FAIL_TEXT[code!.trim()];
  if (!known) return reason;
  const detail = rest.join(": ").trim();
  return detail ? `${known} ${detail}` : known;
}

type RunLike = { state: string };

/**
 * The run whose state an Inbox row shows on its right edge. A row in Working shows its working run
 * (with the timer) even when an earlier attempt failed beside it, since Working is where the row
 * sits; the failed attempt is named in the reason line instead.
 */
export function rowRun<R extends RunLike>(
  section: "needsYou" | "working" | "offline" | "done",
  runs: R[],
): R | undefined {
  if (section === "working") return runs.find((r) => r.state === "working") ?? runs.find((r) => r.state === "unknown");
  // A row under Machine offline shows the run that waited or worked when its machine went away.
  if (section === "offline")
    return runs.find((r) => r.state === "waiting") ?? runs.find((r) => r.state === "working" || r.state === "unknown");
  return undefined;
}

/** "1 run failed", "2 runs failed": the attempts beside a row's working run that didn't make it. */
export function failedNote(runs: RunLike[]): string | undefined {
  const failed = runs.filter((r) => r.state === "failed").length;
  if (failed === 0) return undefined;
  return `${failed} of ${runs.length} runs failed`;
}

type RunTiming = {
  state: string;
  harness: string;
  terminalId?: string | undefined;
  spaceId?: string | undefined;
  joined?: boolean | undefined;
  startedAt: number;
  stateChangedAt: number;
  endedAt?: number | undefined;
};

/**
 * How long an answer counts as on its way. A delivered answer moves the run on at once (the bridge
 * reports Working); one still waiting on the same prompt after this didn't land.
 */
export const DELIVERY_MS = 15_000;

/**
 * Where a waiting run's last answer stands. "none": nothing has answered this prompt. "sending":
 * answered, and the machine hasn't moved on yet, so nobody answers it twice. "failed": answered,
 * but the run still waits on the same prompt well after; the bridge refused or lost the answer
 * (T3 refusing `runtime-request.respond` keeps the approval pending), so it can be answered again.
 */
export function answerState(
  run: { state: string; stateChangedAt: number; lastAnswer?: { at: number } | undefined },
  now: number,
): "none" | "sending" | "failed" {
  if (run.state !== "waiting" || !run.lastAnswer || run.lastAnswer.at < run.stateChangedAt) return "none";
  return now - run.lastAnswer.at < DELIVERY_MS ? "sending" : "failed";
}

/**
 * The terminal a run's preview may read, or `undefined`. A private run (ADR 0015: sent from a
 * conversation you aren't in) keeps its `terminalId` in views, but reading that terminal is
 * not_found for you, admins included, so nothing previews it.
 */
export function previewTerminal<T>(run: { private?: boolean; terminalId?: T | undefined } | undefined): T | undefined {
  return run && !run.private ? run.terminalId : undefined;
}

/**
 * A run's ticking timer: "04:12" under an hour, then "4h 51m", so a long run never reads like a
 * clock time ("4:51:14" next to "6:06 AM").
 */
export function runClock(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  return minutes < 60 ? clock(since, now) : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * How a run's state shows, the same on every surface (Inbox row, board chip, run card, run panel):
 * the icon's state, its words, and its time. A working or live run counts up from when it started,
 * so an answered approval doesn't reset its clock; a waiting run says how long it has waited; a
 * finished one says how long ago it ended. A run whose machine is offline can't be working as far
 * as anyone knows, so it says so instead of ticking.
 */
export function showRun(
  run: RunTiming,
  now: number,
  machineOffline = false,
  /** When the offline machine was last heard from. */
  seenAt?: number,
): {
  icon: "working" | "waiting" | "done" | "failed" | "stopped" | "unknown";
  /** An icon of its own where the state's icon would mislead: Live and Machine offline. */
  glyph?: "live" | "offline";
  label: string;
  time: string;
  /** A waiting run's machine is offline: it still waits, but no answer can reach it yet. */
  offline?: boolean;
  /** The time is a ticking timer (set in mono), not an age. */
  ticking?: boolean;
} {
  const state = run.state as "working" | "waiting" | "done" | "failed" | "stopped" | "unknown";
  // Waiting keeps its amber state, the strongest one (DESIGN.md); the offline machine is a note.
  // Nobody can answer a run whose machine is offline, so it isn't amber "needs you": it waits,
  // quietly, until the bridge is back.
  if (machineOffline && state === "waiting")
    return {
      icon: "unknown",
      glyph: "offline",
      label: "Waiting, machine offline",
      time: ago(run.stateChangedAt, now),
      offline: true,
    };
  // A run that was going when its machine went away says what it was doing, and since when.
  if (machineOffline && (state === "working" || state === "unknown"))
    return {
      icon: "unknown",
      glyph: "offline",
      label: `${state === "working" ? "Working" : stateLabel(run)}, machine offline`,
      time: ago(seenAt ?? run.stateChangedAt, now),
    };
  if (state === "working")
    return { icon: state, label: "Working", time: runClock(run.startedAt, now), ticking: true };
  if (state === "unknown") {
    const label = stateLabel(run);
    return label === "Live"
      ? { icon: state, glyph: "live", label, time: runClock(run.startedAt, now), ticking: true }
      : { icon: state, label, time: ago(run.stateChangedAt, now) };
  }
  if (state === "waiting") return { icon: state, label: "Waiting", time: ago(run.stateChangedAt, now) };
  return { icon: state, label: stateLabel(run), time: agoText(run.endedAt ?? run.stateChangedAt, now) };
}

/** When each machine's bridge was last heard from. */
export function lastSeen(
  machines: { machineId: string; lastSeenAt?: number | undefined }[] | undefined,
): Map<string, number> {
  const seen = new Map<string, number>();
  for (const m of machines ?? []) if (m.lastSeenAt !== undefined) seen.set(m.machineId, m.lastSeenAt);
  return seen;
}

/** "you and Hermes", "Ben Ito and Hermes": who a task waits on, you first. */
export function waitingNames(names: string[]): string {
  const sorted = [...names].sort((a, b) => Number(b === "you") - Number(a === "you"));
  if (sorted.length <= 1) return sorted.join("");
  return `${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}`;
}

/** The machines whose bridge is offline and that no run would wake (a stopped cloud machine wakes). */
export function offlineMachines(
  machines: { machineId: string; online: boolean; cloud?: { state: string } | undefined }[] | undefined,
): Set<string> {
  // A cloud machine that's stopped or starting says so itself; one that's running but whose bridge
  // isn't connected is offline like any other machine.
  return new Set(
    (machines ?? [])
      .filter((m) => !m.online && (!m.cloud || m.cloud.state === "running"))
      .map((m) => m.machineId),
  );
}

/**
 * A task's runs counted by state, most urgent first: "2 runs: 1 failed, 1 working", or
 * "2 runs done" when they agree. A task shows its most urgent state (GLOSSARY.md); this says what
 * every run is doing, so no one screen's choice of lead can contradict another's.
 */
export function stateSummary(runs: RunTiming[], offline: Set<string> = new Set()): string {
  const order = ["Waiting", "Failed", "Working", "Live", "Machine offline", "Status unknown", "Done", "Stopped"];
  const counts = new Map<string, number>();
  for (const run of runs) {
    const machineId = (run as { machine?: { machineId: string } | undefined }).machine?.machineId;
    const shown = showRun(run, 0, machineId !== undefined && offline.has(machineId));
    const label = shown.glyph === "offline" ? "Machine offline" : shown.label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const words = (label: string) => (label === "Machine offline" ? "on an offline machine" : label.toLowerCase());
  if (counts.size === 1) {
    const label = [...counts.keys()][0]!;
    return `${runs.length} runs ${words(label)}`;
  }
  return `${runs.length} runs: ${[...counts.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([label, n]) => `${n} ${words(label)}`)
    .join(", ")}`;
}

/** The board column a card sits in: a closed task (a run was kept) is done, whatever else ran. */
export function boardColumn<C extends string>(task: { column: C; closedAt?: number | undefined }): C | "done" {
  return task.closedAt !== undefined ? "done" : task.column;
}

/**
 * A run's state in words. A run in a plain shell or a Space is Unknown to the room, since nothing
 * there reports whether the work is going or done; while its terminal or Space is open it reads
 * "Live" instead of "Status unknown", which reads like a fault. An A2A run's Unknown stays as is:
 * there it means the room lost track of the agent (GLOSSARY.md, "Run state").
 */
export function stateLabel(run: {
  state: string;
  harness: string;
  terminalId?: string | undefined;
  spaceId?: string | undefined;
  /** A session that joined by itself (uplink join): it reports no state, so it is Live while it lasts (ADR 0032). */
  joined?: boolean | undefined;
}): string {
  if (run.state === "unknown" && (run.terminalId || run.spaceId || run.joined) && run.harness !== "a2a")
    return "Live";
  return STATE_META[run.state as keyof typeof STATE_META]?.label ?? run.state;
}

/** A line that is only a shell prompt (`~/app $`, `atlas-web %`, `root#`): no step to show. */
const PROMPT = /^\S{0,60}[ ]?[$%#>]\s*$/;

/**
 * A working run's current step for its Inbox row: the last line its terminal printed, unless the
 * terminal sits at a bare shell prompt, which says nothing about the work.
 */
export function currentStep(tail: string[] | undefined): string | undefined {
  const last = tail?.at(-1)?.trim();
  if (!last || PROMPT.test(last) || QUESTION.test(last)) return undefined;
  return last;
}

/** A harness's own question line (`? Codex wants to run …`): the room shows the approval itself. */
const QUESTION = /^[?✻>]\s/;
/** A shell prompt followed by the command typed at it (`~/website codex`): no step. */
const PROMPT_ECHO = /^[~/]\S*\s+\S+$/;
/** A harness's own prompt before its words (`codex> retrying…`). */
const HARNESS_PREFIX = /^[a-z][\w-]*>\s+/i;
/** A harness's own bullet or tree glyph at the start of a line (`● Read`, `⎿ 11 passed`). */
const BULLET = /^[●⎿•*✓✗]\s+/;

/**
 * A running run's step for its Inbox row: the last whole line its terminal printed, leaving out
 * bare prompts and the harness's own question lines. Once its approval was answered and nothing
 * new came, the answer is the step ("You allowed `rotate-keys --all`").
 */
export function stepLine(tail: string[] | undefined): string | undefined {
  const lines = dropTrailingPrompts(tail ?? []);
  const last = lines.at(-1)?.trim();
  if (!last || QUESTION.test(last) || PROMPT_ECHO.test(last)) return undefined;
  return last.replace(BULLET, "").replace(HARNESS_PREFIX, "");
}

/** Lines without the bare shell prompts at their end. */
export function dropTrailingPrompts(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && PROMPT.test(lines[end - 1]!.trim())) end--;
  return lines.slice(0, end);
}

/** A machine's T3 Code pairing as its bridge last reported it (ADR 0021). */
export type T3Pairing = {
  state: "connected" | "unreachable" | "needs_pairing";
  expiresAt?: number | undefined;
  reason?: "expired" | "refused" | undefined;
};

/** How soon before a T3 Code pairing ends the app says so. */
export const T3_PAIRING_WARN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The command that pairs a machine's bridge with T3 Code again. The bridge runs it by itself when it
 * has no session, when T3 refuses it, and 8 days before it ends, so the app shows it only when that
 * failed: T3 Code wasn't open, or its `t3` CLI isn't installed there.
 */
export const T3_PAIR_COMMAND = "uplink-bridge t3-pair";

/**
 * What a machine's T3 Code pairing means for its threads, in the app's words: a short chip, why,
 * and whether to show the pairing command (T3_PAIR_COMMAND) with what goes before and after it. Nothing for a
 * pairing that works and isn't ending soon.
 */
export function t3PairingText(
  t3: T3Pairing | undefined,
  now: number,
): { chip: string; why: string; pairAgain: boolean; before?: string; after?: string; needsYou: boolean } | undefined {
  if (!t3) return undefined;
  if (t3.state === "needs_pairing")
    return {
      chip: "T3 Code needs pairing again",
      why:
        t3.reason === "expired"
          ? `Its pairing with T3 Code ended${t3.expiresAt ? ` on ${new Date(t3.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""}.`
          : "T3 Code refused its pairing: it was revoked in T3 Code, or T3 Code was set up again.",
      pairAgain: true,
      before: "The bridge couldn't pair again by itself. Open T3 Code there and it tries again within 5 minutes.",
      after: "Until then its threads show Unknown.",
      needsYou: true,
    };
  if (t3.state === "unreachable")
    return {
      chip: "T3 Code isn't answering",
      why: "The bridge can't reach T3 Code. Open T3 Code on the machine; the bridge connects again on its own.",
      pairAgain: false,
      needsYou: false,
    };
  if (t3.expiresAt !== undefined && t3.expiresAt - now < T3_PAIRING_WARN_MS) {
    const left = Math.max(1, Math.ceil((t3.expiresAt - now) / (24 * 60 * 60 * 1000)));
    return {
      chip: `T3 Code pairing ends in ${left} day${left === 1 ? "" : "s"}`,
      why: "The bridge couldn't renew it by itself.",
      pairAgain: true,
      before: "Open T3 Code there so it can before then.",
      after: "The bridge picks that up when it next restarts.",
      needsYou: false,
    };
  }
  return undefined;
}
