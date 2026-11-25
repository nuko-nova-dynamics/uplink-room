/**
 * A stand-in for a Hermes Agent v0.23.0 gateway (ADR 0040): the same-user control socket at
 * `$HERMES_HOME/gateway.sock` that answers `identify` and mints one-use `session-ticket`s, and the
 * loopback WebSocket (`/api/ws`, subprotocol `hermes-gateway-v1` beside the ticket) that speaks the
 * canonical session JSON-RPC. It answers with the shapes a real v0.23.0 gateway answered on
 * 2026-11-05 and records every call; tests set its sessions, push events, and make a call fail.
 */
import { createServer, type Server } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export type Call = { method: string; params: any };
type Session = { running: boolean; generation: number; prompts?: unknown[] };

export class FakeHermesGateway {
  calls: Call[] = [];
  /** Live sessions by id; any other id is `not_found`, as a provisional or ended one is. */
  sessions = new Map<string, Session>();
  /** A method to refuse with this reason (a JSON-RPC error whose message is the reason). */
  failing = new Map<string, string>();
  /** Methods the gateway takes, and then the connection closes before their answer. */
  dropAfter = new Set<string>();
  /** Runs when a call arrives, before the answer. */
  onCall?: (call: Call) => void;
  /** Submissions admitted, by `submission_id`: a repeat answers the same admission. */
  admitted = new Map<string, string>();
  tickets = new Set<string>();
  private control: Server;
  private wss: WebSocketServer;
  private subscribers = new Map<WebSocket, Set<string>>();
  readonly home: string;

  private constructor(home: string, control: Server, wss: WebSocketServer) {
    this.home = home;
    this.control = control;
    this.wss = wss;
  }

  static async listen(home: string): Promise<FakeHermesGateway> {
    let fake!: FakeHermesGateway;
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/api/ws",
      handleProtocols: (protocols) => (protocols.has("hermes-gateway-v1") ? "hermes-gateway-v1" : false),
      verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => {
        const offered = String(info.req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
        const ticket = offered.find((p) => p.startsWith("hermes-gateway-ticket."))?.slice("hermes-gateway-ticket.".length);
        // A ticket works once, as the real one does.
        return ticket !== undefined && fake.tickets.delete(ticket);
      },
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const control = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (!data.includes("\n")) return;
        const request = JSON.parse(data.split("\n")[0]!);
        socket.end(JSON.stringify(fake.answerControl(request)) + "\n");
      });
    });
    fake = new FakeHermesGateway(home, control, wss);
    wss.on("connection", (ws) => fake.accept(ws));
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(join(home, "gateway.sock"), resolve);
    });
    return fake;
  }

  private get origin() {
    const address = this.wss.address() as { port: number };
    return `http://127.0.0.1:${address.port}`;
  }

  private answerControl(request: { verb?: string; params?: any }) {
    if (request.verb === "identify")
      return {
        ok: true,
        protocol: 1,
        id: 1,
        result: {
          protocol: 1,
          state: "ready",
          api_origin: this.origin,
          instance_id: "inst-1",
          authority_epoch: 1,
          runtime_protocol: 1,
          served_profiles: [{ profile_id: this.home, home: this.home }],
          capabilities: ["session-authority-v1", "durable-admission-v1", "event-replay-v1"],
        },
      };
    if (request.verb === "session-ticket" && request.params?.instance_id === "inst-1" && request.params?.profile_id === this.home) {
      const ticket = `tkt-${this.tickets.size}-${Math.random().toString(36).slice(2)}`;
      this.tickets.add(ticket);
      return { ok: true, protocol: 1, id: 1, result: { ticket, expires_in_seconds: 30, instance_id: "inst-1", profile_id: this.home, runtime_protocol: 1 } };
    }
    return { ok: false, protocol: 1, id: 1, error: "PermissionError: invalid bootstrap parameters" };
  }

  private accept(ws: WebSocket) {
    this.subscribers.set(ws, new Set());
    ws.on("close", () => this.subscribers.delete(ws));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      const call = { method: frame.method, params: frame.params };
      this.calls.push(call);
      this.onCall?.(call);
      const answer = (body: object) => {
        if (this.dropAfter.has(call.method)) return ws.terminate();
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
      };
      const refused = this.failing.get(call.method);
      if (refused) return answer({ error: { code: 4000, message: refused, data: { reason: refused } } });
      const session = this.sessions.get(call.params?.session_id);
      if (call.method === "session.resume") {
        if (!session) return answer({ error: { code: 4001, message: "not_found", data: { reason: "not_found" } } });
        this.subscribers.get(ws)?.add(call.params.session_id);
        return answer({
          result: {
            session_id: call.params.session_id,
            stored_session_id: call.params.session_id,
            messages: [],
            running: session.running,
            execution_generation: session.generation,
            pending: [],
            prompts: session.prompts ?? [],
          },
        });
      }
      if (call.method === "session.steer") {
        if (!session || !session.running || session.generation !== call.params.execution_generation)
          return answer({ error: { code: 4002, message: "stale_generation", data: { reason: "stale_generation" } } });
        return answer({ result: { status: "queued", text: call.params.text, execution_generation: session.generation, authority_epoch: 1 } });
      }
      if (call.method === "image.attach") {
        // As Hermes's gateway does (tui_gateway methods_prompt.py): the image waits for the next prompt.
        if (!session) return answer({ error: { code: 4001, message: "not_found", data: { reason: "not_found" } } });
        return answer({ result: { attached: true, path: call.params.path, count: 1 } });
      }
      if (call.method === "prompt.submit") {
        if (!session) return answer({ error: { code: 4001, message: "not_found", data: { reason: "not_found" } } });
        const id = this.admitted.get(call.params.submission_id) ?? `adm-${this.admitted.size + 1}`;
        this.admitted.set(call.params.submission_id, id);
        return answer({ result: { admission_id: id, status: "queued", sequence: this.admitted.size, authority_epoch: 1 } });
      }
      answer({ error: { code: -32601, message: "method_not_found" } });
    });
  }

  /** Sends a session event to every connection following that session. */
  emit(sessionId: string, type: string, payload: object = {}, generation?: number) {
    const session = this.sessions.get(sessionId);
    const gen = generation ?? session?.generation;
    for (const [ws, followed] of this.subscribers)
      if (followed.has(sessionId))
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, execution_generation: gen, payload } }));
  }

  /** Starts a turn of a session: it runs from now with a new generation, as `message.start` says. */
  startTurn(sessionId: string) {
    const session = this.sessions.get(sessionId)!;
    session.running = true;
    session.generation += 1;
    this.emit(sessionId, "message.start");
  }

  endTurn(sessionId: string, outcome = "completed") {
    const session = this.sessions.get(sessionId)!;
    session.running = false;
    this.emit(sessionId, "message.complete", { text: "ok", outcome, status: "complete" });
  }

  of(method: string) {
    return this.calls.filter((call) => call.method === method);
  }

  connections() {
    return this.subscribers.size;
  }

  async close() {
    for (const ws of this.subscribers.keys()) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.control.close(() => resolve()));
    await rm(join(this.home, "gateway.sock"), { force: true });
  }
}
