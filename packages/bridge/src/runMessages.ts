/**
 * Messages from the room to a run in one of this bridge's terminals (ADR 0026): what the bridge
 * knows about the terminal's inbox. The messages themselves stay in the room until a hook of the
 * session claims them (`bridge:claimRunMessages`), so the room labels them and checks the run's
 * driver at that moment, and a bridge that stops loses none. Claude Code takes them through its
 * hooks: a `PostToolUse` hook returns them as `additionalContext` during a turn, and a `Stop` (or
 * `SessionStart`, or `StopFailure`) hook with `asyncRewake` waits for them while the session is
 * idle and wakes it (`uplink-bridge inbox --wait`, see `claudeHooks.ts`). Codex takes them through
 * the terminal's own app server, which the bridge claims for at once (`codexTerminal.ts`, ADR 0038).
 * The text the run reads is `formatRunMessages` in the protocol package, which the room also packs
 * a claim with.
 */
import { randomBytes } from "node:crypto";

/**
 * What the bridge hands a hook: the text to write for Claude Code, and the claim it acknowledges.
 * `images` are the paths of the images the messages carried, saved in the run's workspace (ADR
 * 0041), for a harness that takes images with a message (Codex's `localImage`, Hermes's `image.attach`).
 */
export type Handed = { text: string; ack: string; images?: string[] };

/**
 * The field of a hook's answer, over the local socket, that names the claim to acknowledge once the
 * hook has written the rest for Claude Code. The CLI removes it before writing.
 */
export const ACK_FIELD = "uplinkAck";

/** A claim the bridge keeps for the run (ADR 0043): whether the room still counts it the bridge's, and stopping its renewals. */
export type ClaimHold = { held: () => boolean; stop: () => void };

export class RunInbox {
  /** The room said messages wait for this run; cleared when a claim leaves none. */
  waiting = false;
  /** Counts the room's notices, so a claim that started before one doesn't clear `waiting`. */
  notices = 0;
  /** True between a turn's end and the next one's start: a message then goes to the waiter. */
  idle = true;
  /** The `inbox --wait` hook that wakes the session, while one waits. */
  waiter?: (handed: Handed | undefined) => void;
  /** A claim for the waiter is in flight. */
  waking = false;
  /** Whether the room has heard how this run hears messages. */
  heard = false;
  /**
   * A claim whose files are saved (ADR 0043), held in the room until a hook or the waiter takes it.
   * A Claude Code hook never waits on a download: the files move outside it, and the next hook
   * hands over the claim once they are in.
   */
  ready?: { handed: Handed; hold: ClaimHold };
  /** A claim's files moving outside any hook, until they are in and the claim is `ready`. */
  saving?: Promise<void>;
  /** Serializes claims from before the room RPC until acquisition completes. */
  acquiring?: Promise<void>;
  /** A claim the bridge asked for when the room said messages wait, before any hook asked. */
  prefetching = false;
}

/**
 * How a run in a bridge terminal answers (ADR 0026): it posts as itself, so it never holds a key.
 * Each delivery ends with it once the room takes `uplink-bridge say` and `reply` (`run_say`), and
 * says how to send files with them (ADR 0047).
 */
export const ANSWER_HINT =
  'This run can answer a message with: uplink-bridge reply <message id> "text". It can post in a place with: uplink-bridge say --in "#place" "text". To send files or images with it, add --file PATH for each, up to 10.';

/**
 * How a Hermes Agent run in a bridge terminal answers (ADR 0040): Hermes runs the agent's commands in
 * its gateway, outside the terminal's environment, so the delivery names the launcher the bridge
 * wrote for that terminal, which carries the terminal's identity.
 */
export function launcherAnswerHint(launcher: string): string {
  return `This run can answer a message with: ${launcher} reply <message id> "text". It can post in a place with: ${launcher} say --in "#place" "text". To send files or images with it, add --file PATH for each, up to 10.`;
}

/**
 * A run in a T3 Code thread proves itself with a run key (ADR 0037): T3 Code gives the bridge no way
 * to tell which thread a command came from, and puts `T3CODE_THREAD_ID` in only some harnesses'
 * environments, where any process could set it. The bridge makes a key for each delivery into a
 * thread and puts it in the delivery's last lines, so it reaches only that thread's conversation.
 * The key posts only as that thread's run, and works while its thread's turn runs and for
 * RUN_KEY_MS after the turn ends (or after it was made, whichever is later), and never past
 * RUN_KEY_MAX_MS after it was made. Once it lapses it stays lapsed, whatever the thread does later.
 * The bridge keeps keys in memory only: a restart ends them, and the next delivery brings a new one.
 */
export const RUN_KEY_PREFIX = "urt_";
/** How long a run key works after its thread's turn ends, or after it was made if later: one hour (ADR 0029 D7). */
export const RUN_KEY_MS = 60 * 60 * 1000;
/** The longest a run key works, however long its thread keeps working: 12 hours after it was made. */
export const RUN_KEY_MAX_MS = 12 * 60 * 60 * 1000;
/** A thread keeps its newest keys only: the run answers with the key from its newest message. */
export const RUN_KEYS_PER_THREAD = 8;
/** At most this many keys across all of the bridge's threads; past it the oldest go first. */
export const RUN_KEYS_MAX = 256;
/** A run key, or anything shaped like one, in text the bridge sends the room. */
const RUN_KEY = /urt_[A-Za-z0-9_-]{8,}/g;
/** What stands for a run key in text the room gets. */
export const HIDDEN_RUN_KEY = "urt_[hidden]";
/** What stands for a live key's secret part, seen without its prefix. */
export const HIDDEN_SECRET = "[hidden]";

/** A run key the bridge gave a thread run in a delivery. */
interface MadeKey {
  /** T3 Code's id for the thread, which the room's thread run has once its launch is bound. */
  threadId: string;
  madeAt: number;
  /** When it stops working at the latest: RUN_KEY_MAX_MS after it was made, never later. */
  expiresAt: number;
  /** It lapsed while its thread was idle, and stays lapsed. */
  lapsed?: true;
}

/**
 * The run keys this bridge gave thread runs, and what hides them in anything it sends the room.
 * A thread's conversation shows the delivery that gave a key and the commands that used it, and
 * the room shows a thread to everyone who can see its run, so no key may leave: not whole, not cut
 * by a trim to its secret part, not quoted by the run in what it posts.
 */
export class RunKeys {
  /** Every key held, oldest first, so the ones past RUN_KEY_MAX_MS are always at the front. */
  private keys = new Map<string, MadeKey>();
  /** Each thread's keys, oldest first, by T3 Code's id for the thread. */
  private byThread = new Map<string, Set<string>>();
  /** Threads at work (true), and when each other one last stopped working (ms), by T3 Code's id. */
  private working = new Map<string, true | number>();
  /** Matches the secret part of every key held, built again once they change. */
  private secrets: RegExp | null | undefined = null;
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  /**
   * A new key for a thread's run. The keys past RUN_KEY_MAX_MS go first, then the thread's oldest
   * past RUN_KEYS_PER_THREAD, then the bridge's oldest past RUN_KEYS_MAX: each step reads only the
   * keys it drops, never all of them.
   */
  make(threadId: string): string {
    const now = this.now();
    for (const [key, made] of this.keys) {
      if (now < made.expiresAt) break;
      this.drop(key);
    }
    let own = this.byThread.get(threadId);
    if (!own) this.byThread.set(threadId, (own = new Set()));
    for (const key of own) {
      if (own.size < RUN_KEYS_PER_THREAD) break;
      this.drop(key);
    }
    for (const key of this.keys.keys()) {
      if (this.keys.size < RUN_KEYS_MAX) break;
      this.drop(key);
    }
    const key = `${RUN_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    this.keys.set(key, { threadId, madeAt: now, expiresAt: now + RUN_KEY_MAX_MS });
    own.add(key);
    this.secrets = undefined;
    return key;
  }
  /** The thread a key posts for, or why it can't: the bridge never gave it, or it expired. */
  check(key: unknown): { threadId: string } | "unknown" | "expired" {
    const made = typeof key === "string" ? this.keys.get(key) : undefined;
    if (!made) return "unknown";
    if (!this.works(made)) {
      this.drop(key as string);
      return "expired";
    }
    return { threadId: made.threadId };
  }
  /** Forgets a key, such as one in a delivery T3 Code didn't take. */
  drop(key: string) {
    const made = this.keys.get(key);
    if (!made) return;
    this.keys.delete(key);
    const own = this.byThread.get(made.threadId);
    own?.delete(key);
    if (own && !own.size) this.byThread.delete(made.threadId);
    this.secrets = undefined;
  }
  /** Forgets a thread T3 Code archived or deleted: its keys and whether it works. */
  forget(threadId: string) {
    for (const key of this.byThread.get(threadId) ?? []) this.drop(key);
    this.working.delete(threadId);
  }
  /**
   * Records whether a thread works now, or since when it hasn't: a key lasts while its thread works.
   * A thread that starts working again doesn't bring back a key that lapsed while it was idle.
   */
  threadWorks(threadId: string, working: boolean) {
    const was = this.working.get(threadId);
    if (working) {
      if (was !== true)
        for (const key of this.byThread.get(threadId) ?? []) {
          const made = this.keys.get(key)!;
          if (!this.works(made)) made.lapsed = true;
        }
      this.working.set(threadId, true);
    } else if (was === true) this.working.set(threadId, this.now());
  }
  /** Forgets every key and thread: sharing stopped, so none posts any more, and the adapters report afresh. */
  clear() {
    this.keys.clear();
    this.byThread.clear();
    this.working.clear();
    this.secrets = undefined;
  }
  /** `text` with every run key hidden, and the secret part of each key held wherever it shows. */
  hide(text: string): string {
    let out = text.includes(RUN_KEY_PREFIX) ? text.replace(RUN_KEY, HIDDEN_RUN_KEY) : text;
    const secrets = this.secretPattern();
    if (secrets) out = out.replace(secrets, HIDDEN_SECRET);
    return out;
  }
  /** `value` with every run key hidden in its strings, as `hide` does. */
  hideIn<T>(value: T): T {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const hidden = this.hide(json);
    return hidden === json ? value : (JSON.parse(hidden) as T);
  }
  private works(made: MadeKey): boolean {
    if (made.lapsed || this.now() >= made.expiresAt) return false;
    const working = this.working.get(made.threadId);
    if (working === true) return true;
    return this.now() - Math.max(made.madeAt, working ?? 0) < RUN_KEY_MS;
  }
  private secretPattern(): RegExp | null {
    if (this.secrets === undefined) {
      // A key's secret is base64url, so nothing in it needs escaping.
      const parts = [...this.keys.keys()].map((key) => key.slice(RUN_KEY_PREFIX.length));
      this.secrets = parts.length ? new RegExp(parts.join("|"), "g") : null;
    }
    return this.secrets;
  }
}

/**
 * The closing lines of a delivery into a T3 Code thread: the exact commands that post as this run,
 * with this bridge's own command and socket, since a thread's agent runs commands with T3 Code's
 * environment rather than a bridge terminal's PATH and `UPLINK_BRIDGE_SOCKET`.
 */
export function threadAnswerHint(command: string, socket: string, key: string): string {
  const run = (verb: string) => `${command} ${verb} --socket ${socket} --key ${key}`;
  return (
    `This run can answer a message with: ${run("reply")} <message id> "text". ` +
    `It can post in a place with: ${run("say")} --in "#place" "text". To send files or images with it, add --file PATH for each, up to 10. ` +
    "The key is this run's own: it works while this thread's turn runs and for an hour after, 12 hours at most."
  );
}
