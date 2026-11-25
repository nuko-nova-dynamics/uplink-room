/**
 * Hermes Agent in one of this bridge's terminals (ADR 0040). The terminal's `hermes` runs its session
 * on the profile's gateway and records it in a breadcrumb named after the terminal's tty; the bridge,
 * which owns that tty, reads it and attaches to the session as one more gateway client. The breadcrumb
 * first names a provisional id the gateway doesn't know, then the session once it exists (Hermes
 * v0.23.0, 2026-11-05), and a new one after `/new` or `/resume`, so the bridge keeps reading it.
 *
 * The session's events give the run's state. When the room says messages wait, the bridge claims them
 * at once and puts them in: with `session.steer` during a turn (`mid_task`), which Hermes hands the
 * agent after the next tool call without stopping one, or with `prompt.submit` (`next_turn`), which
 * on the gateway always queues: it starts a turn on an idle session and waits behind a running one,
 * never stopping it. A steer the turn ends without using becomes the session's next turn.
 */
import type { RunMessageHow } from "@uplink-room/protocol";
import { drainer, type Step } from "@uplink-room/protocol/drain";
import type { RunUpdate } from "./adapters/types.ts";
import { hermesEventUpdate } from "./adapters/hermes.ts";
import { HermesRefusal, breadcrumbFile, openHermesGateway, readBreadcrumb, type HermesConnection, type HermesEvent, type HermesEvents } from "./hermesGateway.ts";
import type { Handed } from "./runMessages.ts";

/** What a Hermes terminal needs from the bridge. */
export interface HermesHost {
  /** Claims the messages waiting for this terminal's run; nothing when none wait or the room can't answer. */
  claim(how: RunMessageHow): Promise<Handed | undefined>;
  /** Tells the room how a claim went. `unsure`: Hermes may have them. */
  settle(ack: string, status: "delivered" | "released" | "unsure", how?: RunMessageHow): void;
  waiting(): boolean;
  waitAgain(): void;
  report(update: RunUpdate): void;
  /** The run hears messages now: the bridge follows its session. */
  heard(): void;
}

type Open = (home: string, events: HermesEvents) => Promise<HermesConnection>;

export interface HermesTerminalOptions {
  home: string;
  /** The terminal's tty, such as `/dev/ttys004`. */
  tty: string;
  host: HermesHost;
  open?: Open;
  /** How often the breadcrumb is read again; 1 second by default. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class HermesTerminal {
  readonly breadcrumb: string;
  /** The session the bridge follows, once the gateway knew the breadcrumb's id. */
  session?: string;
  private home: string;
  private host: HermesHost;
  private open: Open;
  private connection?: Promise<HermesConnection>;
  private running = false;
  private generation = 0;
  private closed = false;
  private reading?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private pollMs: number;
  private delivery: { kick: () => void; stop: () => void };

  constructor(options: HermesTerminalOptions) {
    this.home = options.home;
    this.breadcrumb = breadcrumbFile(options.home, options.tty);
    this.host = options.host;
    this.open = options.open ?? openHermesGateway;
    this.pollMs = options.pollMs ?? 1000;
    this.delivery = drainer(() => this.step(), options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())));
  }

  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  /** Messages wait in the room: deliver them. */
  kick() {
    if (!this.closed) this.delivery.kick();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.delivery.stop();
    void this.connection?.then((connection) => connection.close()).catch(() => {});
    this.connection = undefined;
  }

  /**
   * Reads the breadcrumb, and follows the session it names when that's new or the connection closed.
   * One read at a time: a caller during a read waits for that one.
   */
  private poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.reading ??= (async () => {
      try {
        const id = await readBreadcrumb(this.breadcrumb);
        if (id !== this.session || !this.connection) {
          this.session = undefined;
          if (id) await this.attach(id);
        }
      } finally {
        this.reading = undefined;
      }
    })());
  }

  /** One connection, opened again after it closes. */
  private server(): Promise<HermesConnection> {
    if (this.closed) return Promise.reject(new Error("This terminal ended."));
    if (!this.connection) {
      const opening = this.open(this.home, {
        onEvent: (event) => this.event(event),
        onClose: () => {
          if (this.connection === opening) {
            this.connection = undefined;
            this.session = undefined;
          }
        },
      });
      this.connection = opening;
      opening.catch(() => {
        if (this.connection === opening) {
          this.connection = undefined;
          this.session = undefined;
        }
      });
    }
    return this.connection;
  }

  /**
   * Follows a session: `session.resume` subscribes this connection to its events and says whether a
   * turn runs. An id the gateway doesn't know yet (the breadcrumb's provisional one), or no gateway
   * yet, is tried again at the next read.
   */
  private async attach(id: string) {
    let snapshot: any;
    let connection: HermesConnection;
    try {
      connection = await this.server();
      snapshot = await connection.call("session.resume", { session_id: id, omit_messages: true });
    } catch {
      return;
    }
    if (this.closed || !this.connection || connection !== await this.connection) return;
    this.session = id;
    this.running = snapshot?.running === true;
    if (typeof snapshot?.execution_generation === "number") this.generation = snapshot.execution_generation;
    const prompt = Array.isArray(snapshot?.prompts) ? snapshot.prompts[0] : undefined;
    const update = prompt ? hermesEventUpdate(prompt.kind === "clarify" ? "clarify.request" : "approval.request", prompt) : this.running ? { state: "working" as const } : undefined;
    if (update) this.host.report(update);
    this.host.heard();
    this.delivery.kick();
  }

  private event(event: HermesEvent) {
    if (this.closed || !this.session || event.session_id !== this.session) return;
    if (typeof event.execution_generation === "number") this.generation = event.execution_generation;
    const payload = event.payload ?? {};
    if (event.type === "message.start") this.running = true;
    if (event.type === "message.complete") this.running = false;
    if (event.type === "session.info" && typeof payload.running === "boolean") this.running = payload.running;
    // The gateway dropped this connection's place in the session's events: follow it again.
    if (event.type === "session.replay_gap") {
      this.session = undefined;
      return void this.poll();
    }
    const update = hermesEventUpdate(event.type, payload);
    if (update) this.host.report(update);
  }

  /**
   * One delivery: a claim, put into the session. "retry" when Hermes couldn't be reached or didn't take
   * it; the room hears "unsure" only when a call went out and its answer never came.
   */
  private async step(): Promise<Step> {
    if (this.closed || !this.host.waiting()) return "done";
    // The session the breadcrumb names now, so a message never goes to the one `/new` left.
    await this.poll();
    const session = this.session;
    // No session yet: following one delivers what waits.
    if (!session) return "done";
    const connection = await this.server();
    const running = this.running;
    const generation = this.generation;
    const handed = await this.host.claim(running ? "mid_task" : "next_turn");
    if (!handed) return this.host.waiting() ? "retry" : "done";
    await this.poll();
    if (this.closed || session !== this.session || !this.connection || connection !== await this.connection) {
      this.host.settle(handed.ack, "released");
      return this.closed ? "done" : "more";
    }
    const put = await this.put(connection, session, running, generation, handed);
    if (put.status !== "delivered") {
      this.host.settle(handed.ack, put.status);
      this.host.waitAgain();
      return "retry";
    }
    this.host.settle(handed.ack, "delivered", put.how);
    return this.host.waiting() ? "more" : "done";
  }

  private async put(
    connection: HermesConnection,
    session: string,
    running: boolean,
    generation: number,
    handed: Handed,
  ): Promise<{ status: "delivered" | "released" | "unsure"; how?: RunMessageHow }> {
    // A steer takes text only: a delivery with images waits for the next turn, where they go in with
    // `image.attach` (Hermes tui_gateway methods_prompt.py), each by the path it was saved at (ADR 0043).
    if (running && !handed.images?.length) {
      try {
        const steered = await connection.call("session.steer", { session_id: session, execution_generation: generation, text: handed.text });
        if (steered?.status === "queued") return { status: "delivered", how: "mid_task" };
        // Rejected: the turn can't take it now, so it starts the next one.
      } catch (error) {
        // Refused (the turn ended meanwhile): it starts the next one. No answer: it may be in.
        if (!(error instanceof HermesRefusal)) return { status: "unsure" };
      }
    }
    // An image Hermes doesn't take stays a path in the text, which still names where it was saved.
    for (const path of handed.images ?? []) await connection.call("image.attach", { session_id: session, path }).catch(() => undefined);
    // The claim's id is the submission's: a submit repeated after a lost answer is the same admission.
    const submit = (to: HermesConnection) => to.call("prompt.submit", { session_id: session, text: handed.text, submission_id: handed.ack });
    try {
      await submit(connection);
      return { status: "delivered", how: "next_turn" };
    } catch (error) {
      if (error instanceof HermesRefusal) return { status: "released" };
    }
    // The answer was lost: ask again on a new connection, which the gateway answers with the same admission.
    try {
      const again = await this.server();
      await again.call("session.resume", { session_id: session, omit_messages: true });
      await submit(again);
      return { status: "delivered", how: "next_turn" };
    } catch {
      return { status: "unsure" };
    }
  }
}
