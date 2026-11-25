import type { Prompt, ReportedRunState, RoomFile, RunMessageHow, RunSource, RuntimeMode, T3PairingState, ThreadItem } from "@uplink-room/protocol";
import type { T3ThreadState } from "../t3ShareSpec.ts";
export interface RunUpdate {
  state: ReportedRunState;
  prompt?: Prompt;
}
export interface AdapterContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  report(update: RunUpdate): void;
}
export interface AdapterHandle {
  close(): void;
  /** For adapters that run threads (T3 Code): launch, stop and answer them. */
  threads?: ThreadControl;
  /** For T3 Code: the threads on this machine, for the person here only, and which of them the room gets. */
  local?: T3Local;
}
/**
 * The threads a person on this machine may share (Settings, Machines, this computer). Read on the
 * machine only: the room never gets the list, only the threads picked from it.
 */
export interface T3Local {
  catalog(): T3Catalog;
  /** Shares exactly these threads, as picked for this T3 Code environment, at once. */
  share(selection: T3Selection): void;
}
/** Threads picked on this machine, for one T3 Code environment. A selection without one applies to any (tests). */
export interface T3Selection {
  environmentId?: string;
  threads: readonly string[];
}
export type { T3ThreadState };
export interface T3CatalogThread {
  id: string;
  title: string;
  projectId: string;
  /** The project's name in T3 Code, or its folder's. */
  project: string;
  projectRoot?: string;
  state: T3ThreadState;
  updatedAt?: string;
  /** The room gets it now. */
  shared: boolean;
  /** Launched for a room run: always shared, and ended only from the room or T3 Code. */
  fromRoom: boolean;
}
export interface T3Catalog {
  /** `ready` once T3 Code is connected and its threads are known. */
  state: "ready" | "connecting" | "needs_pairing" | "not_paired";
  environmentId?: string;
  threads: T3CatalogThread[];
}
/**
 * Why a run's messages didn't go into a thread (ADR 0037). `maybeSent`: T3 Code may have taken them
 * all the same (the request timed out, or the socket closed while it was out), so the room hears it
 * is unsure rather than that they wait again.
 */
export class ThreadDeliveryError extends Error {
  maybeSent: boolean;
  constructor(message: string, maybeSent: boolean) {
    super(message);
    this.maybeSent = maybeSent;
  }
}
/** Why a thread didn't start, reported to the room as `thread_start_failed`. */
export class ThreadStartError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}
export interface ThreadControl {
  /**
   * Launches a thread for a room run. Calls `bind` with the thread's id before the launch reaches
   * the tool, so the room binds the run before any report names that thread. Throws
   * `ThreadStartError`.
   */
  start(
    request: { runId: string; harness: string; repo?: string; cwd?: string; prompt?: string; runtimeMode?: RuntimeMode },
    bind: (threadRef: string) => Promise<void>,
  ): Promise<void>;
  /**
   * Sets what the thread's agent may do without asking (ADR 0043). Throws when the tool refuses it,
   * or the thread's provider doesn't take the mode.
   */
  setMode?(threadRef: string, mode: RuntimeMode): Promise<void>;
  /** Stops a thread by its id, or by the run id it was launched for. */
  stop(threadRef: string): Promise<void>;
  /**
   * Answers the approval a thread waits on, once. Returns why it can't: `stale_prompt` (an
   * earlier approval), `no_pending_approval`, or `answer_failed` (the answer didn't reach the tool,
   * and the approval still waits for one).
   */
  answer(
    threadRef: string,
    promptId: string,
    answer: "allow" | "deny",
  ): Promise<"stale_prompt" | "no_pending_approval" | "answer_failed" | undefined>;
  /**
   * Follows a thread's conversation (ADR 0022): `send` gets its newest items first (`reset`), then
   * each change, until `unwatch`. Following goes on across lost connections.
   */
  watch?(threadRef: string, send: (update: ThreadUpdate) => void): void;
  unwatch?(threadRef: string): void;
  /**
   * Whether the room may follow, message or control this thread: one it launched, or one picked on
   * this machine. Every other method refuses any other thread, so this is only to skip work early.
   */
  shares?(threadRef: string): boolean;
  /** The items before `beforeItemId`, oldest first, and whether there are more before them. */
  history?(threadRef: string, beforeItemId: string): Promise<{ items: ThreadItem[]; older: boolean }>;
  /** One turn's diff, cut to THREAD_ITEM_LIMITS.turnDiff bytes. */
  diff?(threadRef: string, turn: number): Promise<{ diff: string; cut: boolean }>;
  /**
   * Sends a message into the thread (ADR 0023): it starts a turn, or waits behind the one in
   * progress (`queued`). The same `messageId` is sent once. `wanted` is asked right before the
   * message is sent, after its files moved: once it says no, nothing is sent and this throws.
   */
  send?(threadRef: string, message: { messageId: string; text: string; files?: RoomFile[]; wanted?: () => boolean }): Promise<"sent" | "queued">;
  /** Stops the turn in progress. Returns false when none is. */
  interrupt?(threadRef: string): Promise<boolean>;
  /**
   * Sends a run's messages from the room into the thread (ADR 0026, ADR 0037): into the turn in
   * progress (`mid_task`) only where the thread's provider steers a turn without stopping a running
   * tool, otherwise at its next turn (`next_turn`: after the turn in progress, or starting one). The
   * same `id` is sent once. `wanted` is asked right before the message is sent: once it says no
   * (the run was stopped meanwhile), nothing is sent. `files` go in as the message's attachments, all
   * or none (ADR 0043): one that can't be handed over fails the delivery before anything is sent.
   * Throws `ThreadDeliveryError`.
   */
  deliver?(
    threadRef: string,
    delivery: { id: string; text: string; files?: RoomFile[]; wanted?: () => boolean },
  ): Promise<RunMessageHow>;
  /** Answers the question the thread waits on, once, like `answer`. */
  answerQuestion?(
    threadRef: string,
    promptId: string,
    answers: Record<string, string | string[]>,
  ): Promise<"stale_prompt" | "no_pending_question" | "answer_failed" | "invalid_answer" | undefined>;
}
/** A followed thread's change: items added or changed, items gone, and for `reset` the first batch. */
export interface ThreadUpdate {
  items: ThreadItem[];
  removed?: string[];
  reset?: boolean;
  older?: boolean;
}
/** What the bridge saved across restarts and passes to an adapter each time it starts one. */
export interface BridgeSaved {
  /** Threads launched for room runs: run id → thread id. */
  launched: ReadonlyMap<string, string>;
  /** The threads picked on this machine to share (t3Sharing.ts), when any were saved for this pairing. */
  shared?: T3Selection;
}
/** Where the T3 Code pairing stands, as the room's `t3_status` says it (ADR 0021). */
export interface T3Status {
  state: T3PairingState;
  expiresAt?: number;
  reason?: "expired" | "refused";
  environmentId?: string;
}
/** What an adapter's machine-wide side tells the bridge besides run reports. */
export interface BridgeEvents {
  /** The T3 Code pairing changed state. */
  t3Status?(status: T3Status): void;
  /** T3 Code archived or deleted a thread the adapter reported (ADR 0026). */
  threadClosed?(threadRef: string): void;
  /** How a thread's run hears messages, from what T3 Code says its provider's turns do (ADR 0037). */
  threadHearing?(threadRef: string, hearing: "mid_task" | "between_turns"): void;
  /** A thread's permission mode, and the modes its provider takes, when the bridge first sees it and on each change (ADR 0043). */
  threadMode?(threadRef: string, mode: RuntimeMode, modes: RuntimeMode[] | undefined): void;
  /**
   * Hides the bridge's run keys (ADR 0037) in what T3 Code sends, as it arrives: before the adapter
   * reads or cuts any of it, so no trim can leave a key's secret without the prefix that marks it.
   */
  redact?(raw: string): string;
}
export interface Adapter {
  name: string;
  executable: string;
  matches(command: string): boolean;
  start?(context: AdapterContext): AdapterHandle;
  startBridge?(
    report: (
      source: RunSource,
      update: RunUpdate,
      info?: { title?: string; harness?: string; repo?: string },
    ) => void,
    saved?: BridgeSaved,
    events?: BridgeEvents,
  ): AdapterHandle;
}
/**
 * Maps a program-status record (OSC 7501, as herdr and Rex keep it) to a run update. A blocked record
 * asking for permission is an approval only where the tool can take an answer from the room
 * (`answerable`); Rex documents no way to send one back, so its approvals are questions, answered by
 * typing in the terminal.
 */
export function programStatus(
  record: { state?: string; msg?: string; kind?: string } | null | undefined,
  options: { answerable?: boolean } = {},
): RunUpdate {
  if (record?.state === "blocked")
    return {
      state: "waiting",
      prompt: {
        kind: record.kind === "permission" && options.answerable !== false ? "approval" : "question",
        text:
          (record.msg || "This run needs its driver.") +
          (options.answerable === false ? " Answer it in the terminal." : ""),
      },
    };
  const state = { working: "working", done: "done", error: "failed" }[record?.state ?? ""];
  return { state: (state as ReportedRunState) || "unknown" };
}
