/**
 * A joined session at work (ADR 0027, ADR 0032): the Claude Code hooks `uplink join` adds, the keeper
 * it starts, and leaving. All of them call the room with the session's run token only.
 *
 * - The keeper (`uplink joined-keeper <key>`, started detached by `uplink join`) sends the run's
 *   heartbeat every 30 seconds, watches `joined.waiting` live and writes the count where the hooks
 *   read it, ends the run when the harness process exits, and for Codex puts each message into the
 *   session (codexAppServer.ts in the protocol package).
 * - The hooks (`uplink hook claude <event>`) find the session by the `session_id` Claude Code gives
 *   them. During a turn they take its waiting messages as `additionalContext`; while it is idle, the
 *   newest `Stop` or `SessionStart` waiter takes them and exits 2, so Claude Code wakes it.
 * - Leaving ends the run in the room, then takes out the hooks once no other joined session of the
 *   project uses them, stops the keeper and forgets the session's files.
 */
import { randomUUID } from "node:crypto";
import { RoomApiError, RoomClient } from "./client.ts";
import type { HookEvent } from "./claudeSettings.ts";
import { openCodexDeliverer, type CodexDeliverer } from "@uplink-room/protocol/codexAppServer";
import { drainer, type Step } from "@uplink-room/protocol/drain";
import type { Env } from "./config.ts";
import { releaseJoin } from "./joinedHooks.ts";
import {
  readJoined,
  readKeeperPid,
  readTurn,
  readWaiting,
  removeJoinedFiles,
  sessionKey,
  startedFromHarness,
  writeKeeperPid,
  writeTurn,
  writeWaiting,
  type JoinedSession,
} from "./joined.ts";
import { ancestors, isRunning } from "./processes.ts";
import { formatDeliveries, HINT_RESERVE, type Delivery } from "./runMessages.ts";

export type RunIo = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isRunning?: (pid: number) => boolean;
  /** Stops the keeper. Defaults to SIGTERM. */
  kill?: (pid: number) => void;
  /** For Codex sessions; defaults to the person's Codex app server. */
  codex?: (codexHome: string) => Promise<CodexDeliverer>;
  /** The live watch the keeper keeps open; defaults to RoomClient.watch. */
  watch?: (client: RoomClient, onUpdate: (waiting: number) => void, onError: (error: RoomApiError) => void) => () => void;
  /** This process's parents, nearest first; defaults to the system's process list (processes.ts). */
  parents?: () => Promise<number[]>;
};

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function runClient(session: JoinedSession, io: RunIo): RoomClient {
  return new RoomClient({ url: session.url, key: session.token, fetch: io.fetch });
}

/** Whether an error says the run token stopped working: the run ended, or its sign-in did. */
export function runEnded(error: unknown): boolean {
  return error instanceof RoomApiError && error.code === "unauthenticated";
}

/**
 * Forgets a joined session on this computer: its hooks (once no other joined session uses the same
 * ones in the same file), its keeper and its files. The room side is `joined.leave`, or already over.
 */
export async function forgetJoin(env: Env, key: string, session: JoinedSession, io: RunIo = {}): Promise<void> {
  // The session joined again since: that join is another keeper's and hooks', not this one's to forget.
  const current = await readJoined(env, key);
  if (current && current.token !== session.token) return;
  const keeper = await readKeeperPid(env, key);
  // Its hooks and its files, in one step under the settings file's lock (joinedHooks.ts). If the
  // file stays locked or can't be read, its own files still go.
  await releaseJoin(env, key, session).catch(() => removeJoinedFiles(env, key));
  stopKeeper(keeper, io);
}

/** Stops a joined session's keeper (`pid`, from its `.keeper` file), unless that is this process. */
export function stopKeeper(pid: number | undefined, io: RunIo = {}): void {
  if (!pid || pid === process.pid) return;
  try {
    (io.kill ?? ((p) => process.kill(p, "SIGTERM")))(pid);
  } catch {
    // Already gone.
  }
}

/** Ends the run in the room and forgets it here. A run that already ended is only forgotten. */
export async function leave(env: Env, key: string, session: JoinedSession, reason: "left" | "session_ended", io: RunIo = {}): Promise<void> {
  try {
    await runClient(session, io).call("joined.leave", { reason });
  } catch (error) {
    if (!runEnded(error)) throw error;
  } finally {
    await forgetJoin(env, key, session, io);
  }
}

/** What a take claimed: the messages, and the claim the session answers once it has them. */
export type Taken = { claimId: string; messages: Delivery[]; waiting: number };

/**
 * Takes the run's waiting messages (`joined.take`): claimed, not yet delivered. Undefined when
 * there are none, "failed" when the room couldn't be reached, "ended" when the run token stopped
 * working.
 */
export async function take(session: JoinedSession, how: "mid_task" | "next_turn", io: RunIo): Promise<Taken | "ended" | "failed" | undefined> {
  try {
    const result = (await runClient(session, io).call("joined.take", { how, reserve: HINT_RESERVE })) as Taken;
    return result.messages.length ? result : undefined;
  } catch (error) {
    return runEnded(error) ? "ended" : "failed";
  }
}

/**
 * Answers a take: "ack" once the messages are in front of the session (a hook's output written, a
 * channel's notification sent, Codex's steer or queue done), "release" when they can't be. If the
 * room can't be reached, the claim lapses after two minutes and the messages come once more.
 */
export async function settleTaken(session: JoinedSession, claimId: string, how: "ack" | "release", io: RunIo): Promise<void> {
  await runClient(session, io)
    .call(how === "ack" ? "joined.ack" : "joined.release", { claimId })
    .catch(() => {});
}

const ENDED_NOTE =
  "Uplink Room: this session's joined run ended (it left, its sign-in was revoked, someone stopped it, or its heartbeat stopped), so messages no longer reach it. `uplink join --team <team>` joins it again.";

/**
 * What a Claude Code hook prints: on stdout, JSON for Claude Code; on stderr, a waiter's wake text;
 * and its exit code. `ack`: to call once that output is written, which delivers its messages.
 */
export type HookAnswer = { code: number; stdout?: string; stderr?: string; ack?: () => Promise<void> };

type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
  /**
   * Set when the hook fires inside a subagent or an in-process teammate, which run the same hooks
   * with the parent's `session_id` (code.claude.com/docs/en/hooks, "Common input fields").
   */
  agent_id?: string;
};

function context(event: string, text: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`;
}

/**
 * One Claude Code hook (claudeSettings.ts). It never blocks the session or fails it: a room that
 * can't be reached, or a session that never joined, answers nothing and exits 0.
 */
export async function claudeHook(event: HookEvent, input: HookInput, env: Env, io: RunIo = {}): Promise<HookAnswer> {
  if (!input.session_id) return { code: 0 };
  // A subagent's hook: what it takes would reach only the subagent, and its tool calls say nothing
  // about the main session's turn (a background subagent works while the session is idle).
  if (typeof input.agent_id === "string" && input.agent_id !== "") return { code: 0 };
  const key = sessionKey("claude-code", input.session_id);
  const session = await readJoined(env, key);
  if (!session) return { code: 0 };
  // Only the session's own Claude Code runs its hooks: anything else can name its session_id too.
  if (!(await startedFromHarness(session, io.parents ?? (() => ancestors())))) return { code: 0 };
  const name = input.hook_event_name ?? "PostToolUse";

  if (event === "session-end") {
    await leave(env, key, session, "session_ended", io).catch(() => {});
    return { code: 0 };
  }
  // The project's hooks stay while any session there uses them, so a session that joined with
  // --channel or --no-hooks runs them too: it takes nothing through them.
  if (session.via !== "hooks") return { code: 0 };

  if (event === "post-tool-use" || event === "user-prompt-submit") {
    const turn = await readTurn(env, key);
    await writeTurn(env, key, { ...turn, turn: "working" });
    // The keeper's count saves a call to the room after every tool call; with no keeper yet, ask.
    if ((await readWaiting(env, key)) === 0) return { code: 0 };
    const taken = await take(session, event === "post-tool-use" ? "mid_task" : "next_turn", io);
    if (taken === "ended") {
      await forgetJoin(env, key, session, io);
      return { code: 0, stdout: context(name, ENDED_NOTE) };
    }
    if (!taken || taken === "failed") return { code: 0 };
    return { code: 0, stdout: context(name, formatDeliveries(taken.messages)), ack: () => settleTaken(session, taken.claimId, "ack", io) };
  }

  return wait(env, key, session, event === "session-start" && input.source === "compact", io);
}

/** How often an idle session's waiter looks for messages, and for a newer waiter. */
export const WAIT_POLL_MS = 500;
/** How often a waiter asks the room itself when the keeper hasn't written a count. */
const NO_COUNT_POLL_MS = 5000;

/**
 * An idle session's waiter (`Stop`, `SessionStart`, run with `asyncRewake`). It waits until a
 * message comes while the session is idle, then takes it and exits 2 with the text on stderr, which
 * Claude Code shows the session and wakes it with. A newer waiter replaces it (only the newest
 * waits), and it exits 0 when the session leaves or its harness exits. `keepTurn`: a SessionStart
 * from compaction, which Claude Code also fires mid-turn, so it doesn't mark the session idle.
 */
async function wait(env: Env, key: string, session: JoinedSession, keepTurn: boolean, io: RunIo): Promise<HookAnswer> {
  const sleep = io.sleep ?? sleepFor;
  const running = io.isRunning ?? isRunning;
  const clock = io.now ?? Date.now;
  const waiterId = randomUUID();
  const turn = await readTurn(env, key);
  await writeTurn(env, key, { turn: keepTurn ? turn.turn : "idle", waiterId });
  let asked = -Infinity;
  for (;;) {
    const now = await readTurn(env, key);
    if (now.waiterId !== waiterId) return { code: 0 };
    const current = await readJoined(env, key);
    if (!current || current.token !== session.token) return { code: 0 };
    if (session.harnessPid !== undefined && !running(session.harnessPid)) return { code: 0 };
    const waiting = await readWaiting(env, key);
    // Without the keeper's count, the room itself is asked, at most every few seconds.
    const ask = waiting === undefined ? clock() - asked >= NO_COUNT_POLL_MS : waiting > 0;
    if (now.turn === "idle" && ask) {
      asked = clock();
      const taken = await take(session, "next_turn", io);
      if (taken === "ended") {
        await forgetJoin(env, key, session, io);
        return { code: 0 };
      }
      if (taken && taken !== "failed") return { code: 2, stderr: `${formatDeliveries(taken.messages)}\n`, ack: () => settleTaken(session, taken.claimId, "ack", io) };
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** How often the keeper checks that the harness process still runs. */
export const PROCESS_POLL_MS = 2000;

/**
 * How long the keeper keeps a run live when `uplink join` found no harness process to watch: with
 * nothing to tell it the session ended, it would send heartbeats forever. The join says so.
 */
export const UNWATCHED_MS = 12 * 60 * 60 * 1000;

/**
 * The keeper of a joined session (`uplink joined-keeper <key>`): the run's heartbeat, the live count
 * of its waiting messages, the end of the run when the harness exits (or UNWATCHED_MS after the join
 * when no harness process was found), and Codex delivery. Returns when the run ends; `stop` ends it
 * early (tests).
 */
export async function keep(env: Env, key: string, io: RunIo = {}, stop?: AbortSignal): Promise<"left" | "ended" | "session_ended" | "unwatched" | "stopped"> {
  const session = await readJoined(env, key);
  if (!session) return "left";
  const sleep = io.sleep ?? sleepFor;
  const running = io.isRunning ?? isRunning;
  const now = io.now ?? Date.now;
  await writeKeeperPid(env, key, process.pid);
  const client = runClient(session, io);
  let ended = false;
  let waiting = 0;

  /**
   * One step of Codex delivery: one take, put into the session. "more" while a take leaves some
   * waiting (more than 20), "retry" when Codex's app server or the room can't be reached, or Codex
   * refused them (they were put back), so a burst or a short failure doesn't wait for another update.
   */
  const codexStep = async (): Promise<Step> => {
    if (session.via !== "codex" || ended || waiting === 0 || !session.codexHome) return "done";
    const codex = await (io.codex ?? openCodexDeliverer)(session.codexHome);
    try {
      const turnId = await codex.activeTurn(session.sessionRef);
      const taken = await take(session, turnId ? "mid_task" : "next_turn", io);
      if (taken === "ended") {
        ended = true;
        return "done";
      }
      if (taken === "failed") return "retry";
      if (!taken) return "done";
      const text = formatDeliveries(taken.messages);
      try {
        if (turnId) {
          try {
            await codex.steer(session.sessionRef, turnId, text);
          } catch {
            // The turn ended between the two calls: queue it for the next one.
            await codex.queue(session.sessionRef, text);
          }
        } else await codex.queue(session.sessionRef, text);
      } catch {
        await settleTaken(session, taken.claimId, "release", io);
        return "retry";
      }
      // Codex has them.
      await settleTaken(session, taken.claimId, "ack", io);
      return taken.waiting > 0 ? "more" : "done";
    } finally {
      codex.close();
    }
  };
  const codexDelivery = drainer(codexStep, sleep);

  const watch =
    io.watch ??
    ((c: RoomClient, onUpdate: (n: number) => void, onError: (e: RoomApiError) => void) =>
      c.watch("joined.waiting", {}, (result) => onUpdate((result as { waiting: number }).waiting), onError));
  // One write of the count at a time, and at most one more after it with the newest count: an older
  // count never lands last, and a burst of updates is one or two writes, not one per update.
  let writing: Promise<void> | undefined;
  let dirty = false;
  const writeCount = () => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = (async () => {
      // Wait for the rest of a burst, so the first write already has the newest count.
      await null;
      do {
        dirty = false;
        await writeWaiting(env, key, waiting).catch(() => {});
      } while (dirty);
      writing = undefined;
    })();
  };
  const unwatch = watch(
    client,
    (n) => {
      waiting = n;
      writeCount();
      codexDelivery.kick();
    },
    (error) => {
      if (runEnded(error)) ended = true;
    },
  );

  let lastBeat = now();
  let reason: "left" | "ended" | "session_ended" | "unwatched" | "stopped" = "stopped";
  try {
    for (;;) {
      if (stop?.aborted) break;
      if (ended) {
        reason = "ended";
        break;
      }
      const current = await readJoined(env, key);
      if (!current || current.token !== session.token) {
        reason = "left";
        break;
      }
      if (session.harnessPid !== undefined && !running(session.harnessPid)) {
        reason = "session_ended";
        break;
      }
      if (session.harnessPid === undefined && now() - session.joinedAt >= UNWATCHED_MS) {
        reason = "unwatched";
        break;
      }
      if (now() - lastBeat >= session.heartbeatMs) {
        lastBeat = now();
        try {
          await client.call("joined.heartbeat");
        } catch (error) {
          if (runEnded(error)) ended = true;
        }
      }
      await sleep(Math.min(PROCESS_POLL_MS, session.heartbeatMs));
    }
  } finally {
    unwatch();
    codexDelivery.stop();
    await client.close();
    // A count still being written would make the session's files again after they are removed.
    await writing;
  }
  if (reason === "session_ended") await leave(env, key, session, "session_ended", io).catch(() => {});
  // The keeper leaves for a session it couldn't watch: as `uplink leave` would.
  if (reason === "unwatched") await leave(env, key, session, "left", io).catch(() => {});
  if (reason === "ended") await forgetJoin(env, key, session, io);
  return reason;
}
