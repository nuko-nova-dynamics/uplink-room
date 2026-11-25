/**
 * A small client for T3 Code's own client protocol: a paired bearer session, a WebSocket ticket,
 * and Effect RPC messages serialized as JSON over `/ws`.
 *
 * T3 Code's typed contracts (`@t3tools/contracts`, `@t3tools/client-runtime`) are private
 * workspace packages, not published, so the bridge speaks the wire format itself. Each shape here
 * was checked against T3 Code at commit 47f2c8d29e981c7723467efe137ee19e91df924e
 * (v0.1.7-nightly.20261102.4080) and the Effect RPC version it pinned, effect 4.0.5; commit 9e85538
 * pins effect 4.1.2, whose wire messages are the same:
 *
 * - Pairing exchange: `POST /oauth/token`, form-encoded token exchange
 *   (packages/contracts/src/auth.ts `AuthTokenExchangeRequest`, client-runtime
 *   authorization/remote.ts `bootstrapRemoteBearerSession`).
 * - Socket ticket: `POST /api/auth/websocket-ticket/rpc` with the bearer, falling back to the bare
 *   path on 404 (remote.ts `issueRemoteWebSocketTicket`); the socket is
 *   `/ws?wsTicket=…&orchestrationProtocol=2` (server ws.ts `hasCompatibleOrchestrationProtocol`,
 *   contracts environment.ts `ORCHESTRATION_PROTOCOL_VERSION`).
 * The pairing exchange, tickets, frames, `server.getConfig`'s `environment.environmentId`, the
 * shell, launch, approvals and both revocations were checked again live at commit
 * 9e85538535c8553901351112ab02dd1dd62db5ee (v0.1.8-nightly.20261104.4179) on 2026-11-04
 * (scripts/t3-live-check.ts); the orchestration protocol is still version 2.
 *
 * - Frames (effect src/rpc/RpcMessage.ts, RpcSerialization.ts `json`): the client sends
 *   `Request {id, tag, payload, headers}`, `Ack {requestId}` after each stream `Chunk`, and `Ping`;
 *   the server sends `Chunk {requestId, values}`, `Exit {requestId, exit}`, `Defect` and `Pong`.
 *   T3's server streams with acks enabled (`RpcServer.makeProtocolWithHttpEffectWebsocket`), so
 *   an un-acked stream stalls.
 */

/** The scopes the bridge asks for: reading threads, and launching, answering and stopping them. */
export const T3_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
export const T3_ORCHESTRATION_PROTOCOL = 2;

export interface T3Session {
  /** The T3 Code server's HTTP base URL, such as `http://127.0.0.1:3773`. */
  url: string;
  /** The bearer access token from pairing. Kept in the bridge's config folder, never sent to the room. */
  token: string;
  /**
   * When the session ends (ms), from the pairing's `expires_in`: 30 days by default. T3 Code gives a
   * bearer session no refresh, so after it the bridge needs pairing again. Absent for a pairing
   * saved before the bridge kept it.
   */
  expiresAt?: number;
}

export class T3Error extends Error {
  /** `t3_auth` for a rejected credential, `t3_unavailable` for a server that can't be reached. */
  reason: "t3_auth" | "t3_unavailable" | "rpc";
  /** The `_tag` of T3 Code's error, for an RPC failure. */
  tag?: string;
  constructor(reason: T3Error["reason"], message: string, tag?: string) {
    super(message);
    this.reason = reason;
    this.tag = tag;
  }
}

function endpoint(base: string, path: string) {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function post(url: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new T3Error("t3_unavailable", `T3 Code isn't reachable at ${url}: ${(error as Error).message}`);
  }
  return response;
}

async function failure(response: Response, what: string): Promise<never> {
  const body = await response.text().catch(() => "");
  const reason = response.status === 401 || response.status === 403 ? "t3_auth" : "t3_unavailable";
  throw new T3Error(reason, `${what} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
}

/**
 * Exchanges a one-time pairing token (`t3 auth pairing create`) for a bearer session with the
 * bridge's scopes.
 */
export async function exchangePairingToken(
  url: string,
  credential: string,
  now = Date.now(),
): Promise<T3Session & { scope: string; expiresIn: number; expiresAt: number }> {
  const response = await post(endpoint(url, "oauth/token"), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: T3_SCOPES.join(" "),
      client_label: "Uplink Room bridge",
      client_device_type: "bot",
    }).toString(),
  });
  if (!response.ok) await failure(response, "Pairing with T3 Code");
  const result = (await response.json()) as { access_token: string; token_type: string; scope: string; expires_in: number };
  if (result.token_type !== "Bearer") throw new T3Error("t3_auth", `T3 Code issued a ${result.token_type} token; the bridge needs a Bearer one.`);
  return {
    url,
    token: result.access_token,
    scope: result.scope,
    expiresIn: result.expires_in,
    expiresAt: now + result.expires_in * 1000,
  };
}

async function socketTicket(session: T3Session): Promise<string> {
  const headers = { authorization: `Bearer ${session.token}` };
  let response = await post(endpoint(session.url, "api/auth/websocket-ticket/rpc"), { headers });
  // A server older than ticket audiences has only the bare path.
  if (response.status === 404) response = await post(endpoint(session.url, "api/auth/websocket-ticket"), { headers });
  if (!response.ok) await failure(response, "Getting a T3 Code socket ticket");
  return ((await response.json()) as { ticket: string }).ticket;
}

type Exit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: { _tag: string; error?: unknown; defect?: unknown }[] };
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onValue?(value: unknown): void;
}

function exitError(exit: Extract<Exit, { _tag: "Failure" }>): T3Error {
  const fail = exit.cause.find((c) => c._tag === "Fail")?.error as { _tag?: string; message?: string } | undefined;
  if (fail) {
    const reason = fail._tag === "EnvironmentAuthorizationError" ? "t3_auth" : "rpc";
    return new T3Error(reason, fail.message ?? fail._tag ?? "T3 Code refused the request", fail._tag);
  }
  const defect = exit.cause.find((c) => c._tag === "Die")?.defect;
  return new T3Error("rpc", typeof defect === "string" ? defect : "T3 Code's request ended without a result");
}

/** One WebSocket connection to a T3 Code server. */
export class T3Rpc {
  private socket: WebSocket;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private closedHandlers: ((error: Error) => void)[] = [];
  private closed = false;
  private pinger?: ReturnType<typeof setInterval>;
  private lastFrame = Date.now();
  /** Applied to each frame's text before it is parsed (`BridgeEvents.redact`). */
  private filter: (raw: string) => string;
  private constructor(socket: WebSocket, filter: (raw: string) => string = (raw) => raw) {
    this.socket = socket;
    this.filter = filter;
  }
  static async connect(session: T3Session, options: { pingMs?: number; filter?: (raw: string) => string } = {}): Promise<T3Rpc> {
    const ticket = await socketTicket(session);
    const url = new URL(endpoint(session.url, "ws"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", String(T3_ORCHESTRATION_PROTOCOL));
    const socket = new WebSocket(url);
    const rpc = new T3Rpc(socket, options.filter);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new T3Error("t3_unavailable", `Couldn't open T3 Code's socket at ${session.url}`)),
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => rpc.receive(String(event.data)));
    socket.addEventListener("close", () => rpc.end(new T3Error("t3_unavailable", "T3 Code's socket closed")));
    socket.addEventListener("error", () => rpc.end(new T3Error("t3_unavailable", "T3 Code's socket failed")));
    const pingMs = options.pingMs ?? 10000;
    rpc.pinger = setInterval(() => {
      // Three missed pings: the server went quiet.
      if (Date.now() - rpc.lastFrame > pingMs * 3) rpc.close();
      else rpc.write({ _tag: "Ping" });
    }, pingMs);
    rpc.pinger.unref?.();
    return rpc;
  }
  private write(message: unknown) {
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private receive(data: string) {
    this.lastFrame = Date.now();
    let decoded: unknown;
    try {
      decoded = JSON.parse(this.filter(data));
    } catch {
      return;
    }
    for (const message of (Array.isArray(decoded) ? decoded : [decoded]) as {
      _tag: string;
      requestId?: string | number;
      values?: unknown[];
      exit?: Exit;
      defect?: unknown;
    }[]) {
      const id = message.requestId === undefined ? undefined : String(message.requestId);
      const entry = id === undefined ? undefined : this.pending.get(id);
      if (message._tag === "Chunk" && entry && id !== undefined) {
        for (const value of message.values ?? []) entry.onValue?.(value);
        this.write({ _tag: "Ack", requestId: id });
      } else if (message._tag === "Exit" && entry && id !== undefined) {
        this.pending.delete(id);
        if (message.exit?._tag === "Success") entry.resolve(message.exit.value);
        else if (message.exit) entry.reject(exitError(message.exit));
      } else if (message._tag === "Defect") {
        this.end(new T3Error("rpc", `T3 Code reported a protocol defect: ${JSON.stringify(message.defect).slice(0, 300)}`));
      }
    }
  }
  private send(tag: string, payload: unknown, entry: Pending): string | undefined {
    if (this.closed) {
      entry.reject(new T3Error("t3_unavailable", "T3 Code's socket is closed"));
      return undefined;
    }
    const id = String(this.nextId++);
    this.pending.set(id, entry);
    this.write({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }
  /** One request and its result. */
  request(tag: string, payload: unknown, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== undefined) this.pending.delete(id);
        reject(new T3Error("t3_unavailable", `T3 Code didn't answer ${tag} in time`));
      }, timeoutMs);
      timer.unref?.();
      const id = this.send(tag, payload, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  /** A stream: `onValue` gets each value until the stream ends; the promise settles when it does. */
  stream(tag: string, payload: unknown, onValue: (value: unknown) => void): Promise<void> {
    return this.subscribe(tag, payload, onValue).done;
  }
  /**
   * A stream that can be ended from this side: `cancel` sends Effect RPC's `Interrupt` for it
   * (effect src/rpc/RpcMessage.ts `InterruptEncoded`), stops its values and settles `done`.
   */
  subscribe(tag: string, payload: unknown, onValue: (value: unknown) => void): { done: Promise<void>; cancel(): void } {
    let id: string | undefined;
    let settle!: () => void;
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      id = this.send(tag, payload, { resolve: () => resolve(), reject, onValue }) ?? undefined;
    });
    return {
      done,
      cancel: () => {
        if (id === undefined || !this.pending.has(id)) return;
        this.pending.delete(id);
        this.write({ _tag: "Interrupt", requestId: id });
        settle();
      },
    };
  }
  onClose(handler: (error: Error) => void) {
    if (this.closed) handler(new T3Error("t3_unavailable", "T3 Code's socket is closed"));
    else this.closedHandlers.push(handler);
  }
  private end(error: Error) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const handler of this.closedHandlers.splice(0)) handler(error);
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
  close() {
    this.end(new T3Error("t3_unavailable", "Closed by the bridge"));
  }
}
