/**
 * A stand-in for Codex's app server on a Unix socket (learn.chatgpt.com/docs/app-server.md): the
 * HTTP Upgrade to WebSocket, then JSON-RPC without the `jsonrpc` header. It answers the calls the
 * bridge makes with the shapes Codex 0.166.0 answered them in on 2026-11-05, records every call, and
 * can push notifications. The tests set its threads and turn, and make a call fail.
 */
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export type Call = { method: string; params: any };

export class FakeCodexServer {
  calls: Call[] = [];
  /** Loaded threads, as `thread/loaded/list` and `thread/read` give them. */
  threads: { id: string; parentThreadId?: string | null; createdAt: number; ephemeral?: boolean }[] = [{ id: "thr-1", parentThreadId: null, createdAt: 1 }];
  /**
   * Turns of threads other than the session's, such as a `/side` conversation's. An ephemeral one
   * (`ephemeral: true` above) keeps no history: Codex 0.166.0 refuses `thread/turns/list` for it.
   */
  threadTurns = new Map<string, FakeCodexServer["turn"]>();
  /**
   * False for a thread before its first message: Codex 0.166.0 then refuses `thread/resume` ("no
   * rollout found for thread id …") and `thread/turns/list` ("thread … is not materialized yet").
   */
  materialized = true;
  /** The newest turn of every thread. */
  turn: { id: string; status: "inProgress" | "completed" | "interrupted" | "failed" } = { id: "turn-0", status: "completed" };
  /** That turn's items: the user's messages, started with it or steered into it. */
  items: { type: "userMessage"; id: string; content: { type: "text"; text: string }[] }[] = [];
  /**
   * How long after taking a message `thread/turns/list` shows it. Codex 0.166.0 listed a started or
   * steered message about half a second after taking it (2026-11-05).
   */
  listsAfterMs = 0;
  /** A method to answer with this error message instead. */
  failing = new Map<string, string>();
  /** Methods Codex takes, and then the connection closes before their answer, as a server that stalls or exits does. */
  dropAfter = new Set<string>();
  /** Methods whose connection closes before Codex takes them. */
  dropBefore = new Set<string>();
  /** Runs when a call arrives, before the answer (a test can change the turn meanwhile). */
  onCall?: (call: Call) => void | Promise<void>;
  /** The answer to `hooks/list`; without it the method is unknown, as in a Codex that lacks it. */
  hooksList?: () => unknown;
  private sockets = new Set<Socket>();
  private server: Server;
  private constructor(server: Server) {
    this.server = server;
  }

  static listen(path: string): Promise<FakeCodexServer> {
    let fake!: FakeCodexServer;
    const server = createServer((socket) => fake.accept(socket));
    fake = new FakeCodexServer(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve(fake));
    });
  }

  of(method: string) {
    return this.calls.filter((call) => call.method === method);
  }

  /** A notification to every connection, such as `turn/completed`. */
  notify(method: string, params: unknown) {
    for (const socket of this.sockets) send(socket, { method, params });
  }

  /** Closes every connection, as an app server that exits does. */
  drop() {
    for (const socket of this.sockets) socket.destroy();
  }

  async close() {
    this.drop();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket) {
    socket.on("error", () => {});
    let head = Buffer.alloc(0);
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, data]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(head.subarray(0, end).toString())?.[1] ?? "";
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        buffer = head.subarray(end + 4);
      } else buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (buffer.length < 2) return;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1]! & 0x80) !== 0;
        const total = offset + (masked ? 4 : 0) + length;
        if (buffer.length < total) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
        const body = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
        if (mask) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
        buffer = buffer.subarray(total);
        void this.handle(socket, JSON.parse(body.toString()));
      }
    });
  }

  private async handle(socket: Socket, message: { id?: number; method?: string; params?: any }) {
    if (!message.method || message.id === undefined) return;
    const call = { method: message.method, params: message.params ?? {} };
    this.calls.push(call);
    await this.onCall?.(call);
    if (this.dropBefore.has(call.method)) return socket.destroy();
    const error = this.failing.get(call.method);
    if (error) return send(socket, { id: message.id, error: { code: -32600, message: error } });
    let answer: { result: unknown } | { error: { code: number; message: string } };
    try {
      answer = { result: this.answer(call) };
    } catch (refused) {
      answer = { error: { code: -32600, message: (refused as Error).message } };
    }
    if (this.dropAfter.has(call.method)) return socket.destroy();
    send(socket, { id: message.id, ...answer });
  }

  private record(item: FakeCodexServer["items"][number]) {
    if (this.listsAfterMs) setTimeout(() => this.items.push(item), this.listsAfterMs);
    else this.items.push(item);
  }

  private userMessage(params: any) {
    const text = params.input?.[0]?.text ?? "";
    return { type: "userMessage" as const, id: `item-${this.calls.length}`, content: [{ type: "text" as const, text }] };
  }

  private turnOf(threadId: string) {
    return this.threadTurns.get(threadId) ?? this.turn;
  }

  private status(threadId: string) {
    return this.turnOf(threadId).status === "inProgress" ? { type: "active", activeFlags: [] } : { type: "idle" };
  }

  private ephemeral(threadId: string) {
    return this.threads.find((t) => t.id === threadId)?.ephemeral === true;
  }

  private answer({ method, params }: Call): unknown {
    switch (method) {
      case "initialize":
        return { userAgent: "codex-fake", platformFamily: "unix", platformOs: "macos" };
      case "hooks/list":
        if (!this.hooksList) throw new Error("unknown variant `hooks/list`");
        return this.hooksList();
      case "thread/loaded/list":
        return { data: this.threads.map((t) => t.id), nextCursor: null };
      case "thread/read": {
        const thread = this.threads.find((t) => t.id === params.threadId);
        return { thread: { ...thread, ephemeral: this.ephemeral(params.threadId), threadSource: "user", status: this.status(params.threadId) } };
      }
      case "thread/resume":
        if (!this.materialized || this.ephemeral(params.threadId)) throw new Error(`no rollout found for thread id ${params.threadId}`);
        return { thread: { id: params.threadId, status: this.status(params.threadId) } };
      case "thread/turns/list":
        if (this.ephemeral(params.threadId)) throw new Error("ephemeral threads do not support thread/turns/list");
        if (!this.materialized) throw new Error(`thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
        return { data: [{ ...this.turn, items: params.itemsView === "notLoaded" ? [] : this.items }], nextCursor: null, backwardsCursor: null };
      case "turn/steer":
        if (this.turn.status !== "inProgress" || params.expectedTurnId !== this.turn.id) throw new Error("no active turn to steer");
        this.record(this.userMessage(params));
        return { turnId: this.turn.id };
      case "turn/start":
        this.materialized = true;
        this.turn = { id: `turn-${this.calls.length}`, status: "inProgress" };
        this.items = [];
        this.record(this.userMessage(params));
        return { turn: { ...this.turn, items: [], error: null } };
      default:
        return {};
    }
  }
}

/** A server frame: final, text, unmasked. */
function send(socket: Socket, message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  if (!socket.destroyed) socket.write(Buffer.concat([head, body]));
}
