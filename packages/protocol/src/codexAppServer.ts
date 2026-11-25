/// <reference types="node" />
/**
 * Putting messages into a Codex session through Codex's app server (ADR 0026), shared by a joined
 * Codex run's keeper (room-client, ADR 0032) and the bridge's Codex terminals (bridge, ADR 0038).
 * Node only: the room and the desktop app never import it.
 *
 * As #138 test 2 did against Codex 0.166.0. Interactive `codex` starts a local app server that every
 * client of the person's Codex home shares, on a Unix control socket at
 * `$CODEX_HOME/app-server-control/app-server-control.sock`; `codex app-server --listen unix://PATH`
 * serves one on a socket of its own (learn.chatgpt.com/docs/app-server.md, "Unix socket": WebSocket
 * over that socket, with the standard HTTP Upgrade handshake; JSON-RPC 2.0 without the `jsonrpc`
 * header). During a turn the message goes in with `turn/steer`, which "appends user input to the
 * active in-flight turn" and needs its id as `expectedTurnId` (from `thread/turns/list`); it didn't
 * interrupt a running command in the test. Between turns `turn/start` starts one, or
 * `codex queue --thread <id> --message <text> --resume` queues it and resumes the session, which
 * started a turn within about 5 seconds (learn.chatgpt.com/docs/developer-commands.md).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export function codexHomeOf(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/** The app server's control socket in a Codex home. */
export function controlSocket(codexHome: string): string {
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

export function hasControlSocket(codexHome: string): boolean {
  return existsSync(controlSocket(codexHome));
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** What a connection that stays open hears besides its answers. */
export type CodexEvents = {
  /** A notification, such as `turn/completed`, for a thread this connection follows (`thread/resume`). */
  onNotification?(method: string, params: unknown): void;
  /** The connection closed, from either side. */
  onClose?(): void;
};

/** How long a call waits for its answer. */
export const CALL_TIMEOUT_MS = 30_000;

/**
 * Why a call failed. `refused`: Codex answered it with an error, so it did nothing. `unsent`: the
 * connection had closed before the call went out. `unknown`: it went out and no answer came, in
 * time or before the connection closed, so Codex may or may not have done it.
 */
export class CodexCallError extends Error {
  readonly outcome: "refused" | "unsent" | "unknown";
  constructor(message: string, outcome: CodexCallError["outcome"]) {
    super(message);
    this.outcome = outcome;
  }
}

/** Whether a call that failed certainly did nothing in Codex: it was refused, or never sent. */
export function didNothing(error: unknown): boolean {
  return error instanceof CodexCallError && error.outcome !== "unknown";
}

/** A JSON-RPC connection to Codex's app server over its control socket. */
export class CodexAppServer {
  #socket: Socket;
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #next = 1;
  #pending = new Map<number, Pending>();
  #events: CodexEvents;
  #closed = false;

  private constructor(socket: Socket, events: CodexEvents) {
    this.#socket = socket;
    this.#events = events;
  }

  /** True once the connection has closed; a closed connection takes no calls. */
  get closed(): boolean {
    return this.#closed;
  }

  #userAgent?: string;

  /** The server's name and version, as `initialize` answered (`codex_cli_rs/0.166.0 …`). */
  get userAgent(): string | undefined {
    return this.#userAgent;
  }

  /**
   * Connects and upgrades to WebSocket, then sends `initialize` and `initialized`. `timeoutMs` bounds
   * the handshake; after it the connection stays open until `close`, and each call has its own timeout.
   */
  static async open(socketPath: string, timeoutMs = 5000, events: CodexEvents = {}): Promise<CodexAppServer> {
    const socket = connect(realpathSync(socketPath));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Codex's app server didn't answer.")));
    const server = new CodexAppServer(socket, events);
    await new Promise<void>((resolve, reject) => {
      let head = Buffer.alloc(0);
      // Closing the socket also ends its timeout, so a close before the answer has to fail it.
      const onClose = () => reject(new Error("Codex's app server closed the connection before it answered."));
      const onData = (data: Buffer) => {
        head = Buffer.concat([head, data]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        socket.off("close", onClose);
        if (!head.subarray(0, end).toString().startsWith("HTTP/1.1 101")) {
          reject(new Error(`Codex's app server refused the connection: ${head.subarray(0, end).toString().split("\r\n")[0]}`));
          return;
        }
        socket.on("data", (more: Buffer) => server.#read(more));
        server.#read(head.subarray(end + 4));
        resolve();
      };
      socket.once("error", reject);
      socket.once("close", onClose);
      socket.on("data", onData);
      socket.once("connect", () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
    });
    socket.on("error", (error) => server.#failAll(new CodexCallError(error.message, "unknown")));
    socket.on("close", () => {
      server.#closed = true;
      server.#failAll(new CodexCallError("Codex's app server closed the connection before it answered.", "unknown"));
      server.#events.onClose?.();
    });
    const init = (await server.call("initialize", { clientInfo: { name: "uplink_room", title: "Uplink Room", version: "1" } }, timeoutMs)) as { userAgent?: unknown } | null;
    if (typeof init?.userAgent === "string") server.#userAgent = init.userAgent;
    server.#send({ method: "initialized", params: {} });
    socket.setTimeout(0);
    return server;
  }

  call(method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new CodexCallError("Codex's app server closed the connection.", "unsent"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexCallError(`Codex's app server didn't answer ${method}.`, "unknown"));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }

  close(): void {
    this.#socket.end();
    this.#socket.destroy();
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(message: unknown): void {
    this.#frame(1, Buffer.from(JSON.stringify(message)));
  }

  /** A client frame: final, masked (RFC 6455, section 5.3). */
  #frame(opcode: number, data: Buffer): void {
    const mask = randomBytes(4);
    const length = data.length;
    const head =
      length < 126
        ? Buffer.from([0x80 | opcode, 0x80 | length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
          : (() => {
              const b = Buffer.alloc(10);
              b[0] = 0x80 | opcode;
              b[1] = 0x80 | 127;
              b.writeBigUInt64BE(BigInt(length), 2);
              return b;
            })();
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
    this.#socket.write(Buffer.concat([head, mask, body]));
  }

  #read(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const fin = (this.#buffer[0]! & 0x80) !== 0;
      const opcode = this.#buffer[0]! & 0x0f;
      let length = this.#buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.#buffer.length < offset + length) return;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      if (opcode === 9) this.#frame(10, payload);
      else if (opcode === 8) this.#socket.end();
      else if (opcode === 1 || opcode === 0) {
        this.#fragments.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.#fragments).toString();
          this.#fragments = [];
          this.#message(text);
        }
      }
    }
  }

  #message(text: string): void {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    // A notification has a method and no id. A request from the server (an approval) has both: the
    // person's terminal answers those, so this connection leaves them alone.
    if (typeof message.method === "string") {
      if (message.id === undefined) this.#events.onNotification?.(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new CodexCallError(message.error.message ?? JSON.stringify(message.error), "refused"));
    else pending.resolve(message.result);
  }
}

/** The thread's turn in progress, if one is: the newest turn, when its status is `inProgress`. */
export async function activeTurn(server: CodexAppServer, threadId: string): Promise<string | undefined> {
  await server.call("thread/resume", { threadId, excludeTurns: true });
  const listed = (await server.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })) as {
    data?: { id?: string; status?: string }[];
  } | null;
  const turn = listed?.data?.[0];
  return turn?.id && turn.status === "inProgress" ? turn.id : undefined;
}

/**
 * A message's input items: its text, then each image as a `localImage` (Codex app-server v2
 * `UserInput`, checked with `codex app-server generate-json-schema` on Codex 0.166.0), which Codex
 * reads from the path and gives the model as an image (ADR 0043).
 */
function inputOf(text: string, images: string[] = []) {
  return [{ type: "text", text }, ...images.map((path) => ({ type: "localImage", path }))];
}

/** Adds the text, and any images by path, to the thread's turn in progress, which must be `turnId`. */
export async function steerTurn(server: CodexAppServer, threadId: string, turnId: string, text: string, images?: string[]): Promise<void> {
  await server.call("turn/steer", { threadId, input: inputOf(text, images), expectedTurnId: turnId });
}

/** Starts a turn in an idle thread with the text, and any images by path, as its input, with the thread's own settings. */
export async function startTurn(server: CodexAppServer, threadId: string, text: string, images?: string[]): Promise<void> {
  await server.call("turn/start", { threadId, input: inputOf(text, images) });
}

/** Runs `codex queue --thread <id> --message <text> --resume` with this Codex home. */
export function queueWithCodex(codexHome: string, threadId: string, text: string, codex = "codex"): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      codex,
      ["queue", "--thread", threadId, "--message", text, "--resume"],
      { env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export type CodexDeliverer = {
  /** Whether a turn is running in the thread, and its id. */
  activeTurn(threadId: string): Promise<string | undefined>;
  steer(threadId: string, turnId: string, text: string): Promise<void>;
  queue(threadId: string, text: string): Promise<void>;
  close(): void;
};

/** The deliverer for a Codex home: its app server, and `codex queue`. */
export async function openCodexDeliverer(codexHome: string): Promise<CodexDeliverer> {
  const server = await CodexAppServer.open(controlSocket(codexHome));
  return {
    activeTurn: (threadId) => activeTurn(server, threadId),
    steer: (threadId, turnId, text) => steerTurn(server, threadId, turnId, text),
    queue: (threadId, text) => queueWithCodex(codexHome, threadId, text),
    close: () => server.close(),
  };
}
