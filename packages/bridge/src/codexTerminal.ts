/**
 * Messages from the room to Codex in one of this bridge's terminals (ADR 0026, ADR 0038). The
 * terminal's Codex runs on an app server of its own, which `uplink-bridge codex` starts and registers
 * here with its socket, so the bridge knows which server is this terminal's without guessing among the
 * person's other sessions. The session's thread is the one its hooks name (`session_id`); before any
 * hook, it is the one root thread the server has loaded, since only this terminal's Codex uses it.
 * A `/side` conversation's hooks name its own thread, an ephemeral fork Codex discards, so messages
 * keep going to the session's thread then.
 *
 * When the room says messages wait, the bridge claims them at once and puts them in: with `turn/steer`
 * during a turn (`mid_task`), which adds to it without stopping a running command (#138 test 2), or
 * with `turn/start` when the session is idle (`next_turn`). The room hears they were delivered only
 * once Codex took them; a claim Codex refused is put back and tried again after a pause, and one
 * whose call went unanswered is looked for in the thread, then delivered or unsure.
 */
import type { RunMessageHow } from "@uplink-room/protocol";
import { CodexAppServer, activeTurn, didNothing, startTurn, steerTurn } from "@uplink-room/protocol/codexAppServer";
import { drainer, type Step } from "@uplink-room/protocol/drain";
import type { Handed } from "./runMessages.ts";

/** What a Codex terminal needs from the bridge. */
export interface CodexHost {
  /**
   * Claims the messages waiting in the room for this terminal's run. Nothing when none wait, and
   * nothing when the room couldn't answer, in which case `waiting` still says they wait.
   */
  claim(how: RunMessageHow): Promise<Handed | undefined>;
  /**
   * Tells the room how a claim went, and `how` the messages went in when delivered. `unsure`: Codex
   * may have them, so the room hands them over once more at most, then fails them.
   */
  settle(ack: string, status: "delivered" | "released" | "unsure", how?: RunMessageHow): void;
  /** Whether messages wait for this run, as the room last said. */
  waiting(): boolean;
  /** A claim was put back, so its messages wait again. */
  waitAgain(): void;
  /** A turn of the session's thread failed. */
  failed(): void;
}

/** How long the bridge looks for a message in the thread after a call that went out unanswered. */
const ARRIVAL_WAIT_MS = 3000;

type Open = (socket: string, timeoutMs: number, events: { onNotification(method: string, params: unknown): void; onClose(): void }) => Promise<CodexAppServer>;

export class CodexTerminal {
  /** The terminal's own app server's socket. */
  readonly socket: string;
  /** Its process, which the bridge ends with the terminal if `uplink-bridge codex` couldn't. */
  readonly pid: number | undefined;
  /** The session's thread, once a hook named it or delivery found it. */
  thread?: string;
  private host: CodexHost;
  private open: Open;
  private connection?: Promise<CodexAppServer>;
  private closed = false;
  private delivery: { kick: () => void; stop: () => void };
  private sleep: (ms: number) => Promise<void>;

  constructor(
    socket: string,
    pid: number | undefined,
    host: CodexHost,
    open: Open = (path, timeoutMs, events) => CodexAppServer.open(path, timeoutMs, events),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ) {
    this.socket = socket;
    this.pid = pid;
    this.host = host;
    this.open = open;
    this.sleep = sleep;
    this.delivery = drainer(() => this.step(), sleep);
  }

  /**
   * A hook named the session's thread. The bridge follows it, so it hears a turn that fails, and
   * delivers what waits. A new thread (`/new`, `/resume`) replaces the old. Every hook calls this: a
   * thread can't be followed before its first message, so following is tried again until it works.
   */
  bind(thread: string) {
    if (this.closed) return;
    const changed = this.thread !== thread;
    this.thread = thread;
    this.remember(thread);
    void this.follow();
    if (changed) this.delivery.kick();
  }

  /** Messages wait in the room: deliver them. */
  kick() {
    if (!this.closed) this.delivery.kick();
  }

  close() {
    this.closed = true;
    this.delivery.stop();
    void this.connection?.then((server) => server.close()).catch(() => {});
    this.connection = undefined;
  }

  /** The thread this connection follows (`thread/resume`), so it hears that thread's `turn/completed`. */
  private followed?: { connection: Promise<CodexAppServer>; thread: string };

  private async follow() {
    const thread = this.thread;
    if (!thread) return;
    try {
      const connection = this.server();
      if (this.followed?.connection === connection && this.followed.thread === thread) return;
      await (await connection).call("thread/resume", { threadId: thread, excludeTurns: true });
      this.followed = { connection, thread };
    } catch {
      // Not yet: Codex resumes a thread only after its first message, and the next hook tries again.
    }
  }

  /**
   * The thread's turn in progress, if one is. A thread that has had no message yet lists no turns
   * (Codex 0.166.0: "not materialized yet; thread/turns/list is unavailable before first user
   * message"), so its runtime status, which `thread/read` gives for any thread, says first whether
   * one runs.
   */
  private async running(server: CodexAppServer, thread: string): Promise<string | undefined> {
    const read = await this.read(server, thread);
    if (read?.status?.type !== "active") return undefined;
    return activeTurn(server, thread);
  }

  private async read(server: CodexAppServer, thread: string) {
    const read = (await server.call("thread/read", { threadId: thread })) as { thread?: { status?: { type?: string }; ephemeral?: boolean } } | null;
    return read?.thread;
  }

  /** The threads hooks named, the newest last, so a `/side` conversation's messages find the session's own. */
  private bound: string[] = [];

  private remember(thread: string) {
    this.bound = [...this.bound.filter((t) => t !== thread), thread].slice(-8);
  }

  /**
   * The thread the room's messages go to: the one hooks named, unless Codex keeps no history of it.
   * In Codex 0.166.0 that is a `/side` conversation, an ephemeral fork that Codex discards when the
   * person goes back (its hooks name it, not the session's thread), so its messages go to the
   * session's own thread instead: the newest one hooks named that keeps its history, which follows
   * `/new` and `/resume`, or the one `findThread` gives when no hook has named it yet.
   */
  private async target(server: CodexAppServer): Promise<string | undefined> {
    // A hook that names another thread later replaces this one.
    if (!this.thread) {
      this.thread = await this.findThread(server);
      if (this.thread) this.remember(this.thread);
    }
    const named = this.thread;
    if (!named) return undefined;
    if (!(await this.read(server, named))?.ephemeral) return named;
    for (const thread of this.bound.filter((t) => t !== named).reverse()) {
      // A side conversation Codex already discarded can't be read, so it isn't the session's.
      const read = await this.read(server, thread).catch(() => undefined);
      if (read && !read.ephemeral) return thread;
    }
    return this.findThread(server);
  }

  /** One connection, kept open to hear `turn/completed`, and opened again after it closes. */
  private server(): Promise<CodexAppServer> {
    if (this.closed) return Promise.reject(new Error("This terminal ended."));
    if (!this.connection) {
      const opening = this.open(this.socket, 5000, {
        onNotification: (method, params) => this.notification(method, params),
        onClose: () => {
          if (this.connection === opening) this.connection = undefined;
        },
      });
      this.connection = opening;
      opening.catch(() => {
        if (this.connection === opening) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private notification(method: string, params: unknown) {
    const completed = params as { threadId?: string; turn?: { status?: string } } | undefined;
    if (method === "turn/completed" && completed?.threadId === this.thread && completed?.turn?.status === "failed") this.host.failed();
  }

  /** Before any hook: the root thread the session's server has loaded, the newest if there are several. */
  private async findThread(server: CodexAppServer): Promise<string | undefined> {
    const loaded = (await server.call("thread/loaded/list", {})) as { data?: string[] } | null;
    let found: { id: string; createdAt: number } | undefined;
    for (const id of loaded?.data ?? []) {
      const read = (await server.call("thread/read", { threadId: id })) as { thread?: { parentThreadId?: string | null; ephemeral?: boolean; createdAt?: number } } | null;
      const thread = read?.thread;
      if (!thread || thread.parentThreadId || thread.ephemeral) continue;
      if (!found || (thread.createdAt ?? 0) > found.createdAt) found = { id, createdAt: thread.createdAt ?? 0 };
    }
    return found?.id;
  }

  /**
   * One delivery: a claim, put into the session. "retry" when Codex couldn't be reached or didn't
   * take it. A call that went out with no answer (it timed out, or the connection closed) may have
   * gone in, so the bridge looks for the message in the thread before it says how it went: delivered
   * when it's there, and otherwise unsure, which the room hands over once more at most, never released
   * to be put in again and again.
   */
  private async step(): Promise<Step> {
    if (this.closed || !this.host.waiting()) return "done";
    const server = await this.server();
    const thread = await this.target(server);
    // No thread yet: the session's first hook names it and delivers.
    if (!thread || this.closed) return "done";
    const named = this.thread;
    const turn = await this.running(server, thread);
    const handed = await this.host.claim(turn ? "mid_task" : "next_turn");
    // Nothing handed while messages still wait: the room couldn't answer the claim, so try again.
    if (!handed) return this.host.waiting() ? "retry" : "done";
    if (this.closed) {
      this.host.settle(handed.ack, "released");
      return "done";
    }
    // The person switched threads (`/new`, `/resume`) while the room answered: the claim goes back,
    // and the next step puts it into the thread they switched to.
    if (this.thread !== named) {
      this.host.settle(handed.ack, "released");
      this.host.waitAgain();
      return "more";
    }
    const put = await this.put(server, thread, turn, handed.text, handed.images);
    const status = put.status === "unknown" ? ((await this.arrived(thread, handed.text)) ? "delivered" : "unsure") : put.status;
    if (status !== "delivered") {
      this.host.settle(handed.ack, status);
      this.host.waitAgain();
      return "retry";
    }
    this.host.settle(handed.ack, "delivered", put.how);
    // The thread has had a message now, so it can be followed.
    void this.follow();
    return this.host.waiting() ? "more" : "done";
  }

  /**
   * Puts the text into the thread: into `turn` with `turn/steer`, or as a new turn. Only a call Codex
   * refused (or that never went out) moves on to the other; "unknown" when one went out unanswered.
   */
  private async put(
    server: CodexAppServer,
    thread: string,
    turn: string | undefined,
    text: string,
    images?: string[],
  ): Promise<{ status: "delivered" | "released" | "unknown"; how: RunMessageHow }> {
    const attempt = async (how: RunMessageHow, call: () => Promise<void>) => {
      try {
        await call();
        return { status: "delivered" as const, how };
      } catch (error) {
        return { status: didNothing(error) ? ("released" as const) : ("unknown" as const), how };
      }
    };
    if (turn) {
      const steered = await attempt("mid_task", () => steerTurn(server, thread, turn, text, images));
      // Refused: the turn ended between the two calls, so the message starts the next one.
      if (steered.status !== "released") return steered;
    }
    const started = await attempt("next_turn", () => startTurn(server, thread, text, images));
    if (started.status !== "released") return started;
    // Refused: a turn started between the two calls (the person typed), which the message joins.
    const running = await this.running(server, thread).catch(() => undefined);
    if (!running || running === turn) return started;
    return attempt("mid_task", () => steerTurn(server, thread, running, text, images));
  }

  /**
   * Whether the text is a message of the user's in one of the thread's newest turns, which says Codex
   * took it. Codex 0.166.0 lists a started or steered message about half a second after it took it, so
   * the bridge looks for up to ARRIVAL_WAIT_MS.
   */
  private async arrived(thread: string, text: string): Promise<boolean> {
    for (const end = Date.now() + ARRIVAL_WAIT_MS; ; ) {
      if (await this.listed(thread, text)) return true;
      if (this.closed || Date.now() >= end) return false;
      await this.sleep(500);
    }
  }

  private async listed(thread: string, text: string): Promise<boolean> {
    try {
      const listed = (await (await this.server()).call("thread/turns/list", { threadId: thread, limit: 3, sortDirection: "desc", itemsView: "full" })) as {
        data?: { items?: { type?: string; content?: { type?: string; text?: string }[] }[] }[];
      } | null;
      return (listed?.data ?? []).some((turn) =>
        (turn.items ?? []).some((item) => item.type === "userMessage" && (item.content ?? []).some((part) => part.type === "text" && part.text === text)),
      );
    } catch {
      // The server can't say, as for a thread that keeps no history: unsure.
      return false;
    }
  }
}
