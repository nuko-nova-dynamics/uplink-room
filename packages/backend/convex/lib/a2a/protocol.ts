/**
 * A small A2A client over the JSON-RPC binding (a2a-protocol.org, spec
 * 1.0.0, sections 3, 4, 8 and 9; read 2026-11-02). It runs in Convex actions
 * (the A2A worker, ADR 0012), never in a mutation.
 *
 * It speaks only what the room needs: reading an Agent Card, SendMessage,
 * SendStreamingMessage, GetTask, ListTasks, CancelTask and SubscribeToTask,
 * with `A2A-Version: 1.0` on every call. Hermes and OpenClaw both serve A2A
 * 1.0 over JSON-RPC. An agent that only answers A2A 0.3 gets the 0.3 names and
 * shapes, without the header (dialect.ts, ADR 0018). Every response is read with
 * a size limit and a deadline, and redirects are refused, so a peer can't send
 * the room (and its token) somewhere else. Requests go through a `Transport`: in
 * production the guarded one (guardedFetch.ts), which checks each connection's
 * address.
 */
import { endpointRefusal } from "./peerUrl";
import { dialectOf, type Dialect } from "./dialect";

export const A2A_VERSION = "1.0";

/** How a request leaves: fetch-like, with no redirects followed. */
export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

/** JSON-RPC and A2A error codes (spec 5.4, and JSON-RPC 2.0). */
export const RPC = {
  internalError: -32603,
  methodNotFound: -32601,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
  versionNotSupported: -32009,
} as const;

const MAX_CARD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;

export type Credential =
  | { kind: "bearer"; secret: string }
  | { kind: "header"; name: string; secret: string };

export type Endpoint = { url: string; tenant?: string };

export type ParsedCard = {
  name: string;
  description: string;
  version: string;
  /** The A2A version the chosen interface names, such as "1.0" or "0.3.0". */
  protocolVersion: string;
  endpoint: Endpoint;
  streaming: boolean;
  pushNotifications: boolean;
  skills: { id: string; name: string }[];
  /** The security schemes the card names, in plain words. */
  security: { name: string; kind: string; detail?: string }[];
  /** True when the card lists security requirements. */
  needsCredential: boolean;
  documentationUrl?: string;
};

/**
 * A failed call. `ambiguous` is true when the request may have reached the
 * agent and been acted on (a lost connection, a timeout, a server fault), so a
 * send must be reconciled with the agent before anything is sent again.
 */
export class A2ACallError extends Error {
  readonly kind: "rpc" | "http" | "network" | "protocol";
  readonly code: number | undefined;
  readonly status: number | undefined;
  readonly ambiguous: boolean;
  /** For a JSON-RPC error: the agent's own message, less an empty tail. */
  readonly said: string | undefined;
  constructor(
    message: string,
    opts: {
      kind: A2ACallError["kind"];
      code?: number;
      status?: number;
      ambiguous: boolean;
      said?: string;
    },
  ) {
    super(message);
    this.kind = opts.kind;
    this.code = opts.code;
    this.status = opts.status;
    this.ambiguous = opts.ambiguous;
    this.said = opts.said;
  }
  /**
   * The agent doesn't offer this method or feature, and said so plainly. A "method not found" that
   * comes with an HTTP 5xx may come after the agent took the request, so it doesn't count: a send
   * falls back to another method only when nothing can have arrived.
   */
  get unsupported(): boolean {
    return (
      this.kind === "rpc" &&
      !this.ambiguous &&
      (this.code === RPC.methodNotFound || this.code === RPC.unsupportedOperation)
    );
  }
}

function headers(
  credential: Credential | null,
  accept: string,
  dialect: Dialect,
): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept,
    // A 0.3 client sends no version: an agent reads a missing one as 0.3 (spec 3.6.2).
    ...(dialect === "1.0" ? { "a2a-version": A2A_VERSION } : {}),
  };
  if (credential?.kind === "bearer") h["authorization"] = `Bearer ${credential.secret}`;
  if (credential?.kind === "header") h[credential.name.toLowerCase()] = credential.secret;
  return h;
}

/**
 * A deadline for a whole request (connect, headers and body), which also ends
 * when `outer` aborts. `done` stops the timer; `outer` still ends it after.
 */
function deadline(timeoutMs: number, outer?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuter = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onOuter, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    seconds: Math.round(timeoutMs / 1000),
    done: () => clearTimeout(timer),
    release: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}
type Deadline = ReturnType<typeof deadline>;

function cutOff(d: Deadline): A2ACallError {
  return new A2ACallError(
    d.timedOut()
      ? `The agent didn't finish answering within ${d.seconds} seconds.`
      : "The answer was cut off.",
    { kind: "network", ambiguous: true },
  );
}

/** Reads at most `max` bytes of a body as text before the deadline, or fails. */
async function readBounded(response: Response, max: number, d: Deadline): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const stop = () => {
    reader.cancel().catch(() => {});
  };
  if (d.signal.aborted) stop();
  else d.signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw d.signal.aborted
          ? cutOff(d)
          : new A2ACallError("The connection to the agent broke while it answered.", {
              kind: "network",
              ambiguous: true,
            });
      }
      if (d.signal.aborted) throw cutOff(d);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) {
        throw new A2ACallError(`The agent's answer is larger than ${Math.round(max / 1024)} KB.`, {
          kind: "protocol",
          ambiguous: true,
        });
      }
      chunks.push(chunk.value);
    }
  } finally {
    d.signal.removeEventListener("abort", stop);
    stop();
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function parseJson(text: string): { result?: unknown; error?: unknown } | null {
  try {
    const json: unknown = JSON.parse(text);
    return json && typeof json === "object"
      ? (json as { result?: unknown; error?: unknown })
      : null;
  } catch {
    return null;
  }
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/** Sends a request under a deadline. Nothing was sent when an address is refused. */
async function send(
  transport: Transport,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  d: Deadline,
): Promise<Response> {
  try {
    return await transport(url, { ...init, signal: d.signal });
  } catch (error) {
    if ((error as { blocked?: boolean }).blocked) {
      throw new A2ACallError((error as Error).message, { kind: "http", ambiguous: false });
    }
    throw new A2ACallError(
      d.timedOut()
        ? `The agent didn't answer within ${d.seconds} seconds.`
        : d.signal.aborted
          ? "Stream closed."
          : `Couldn't reach the agent: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "network", ambiguous: true },
    );
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function securityKind(scheme: Record<string, unknown>): { kind: string; detail?: string } {
  // The spec's JSON (a one-of object), the official JS SDK's serialization ({ scheme: { $case, value } }),
  // and A2A 0.3's OpenAPI shape ({ type, scheme }) all name the same things.
  const inner = (
    scheme["scheme"] && typeof scheme["scheme"] === "object" ? scheme["scheme"] : null
  ) as { $case?: string; value?: Record<string, unknown> } | null;
  const entries: [string, Record<string, unknown>][] = inner?.$case
    ? [[inner.$case, inner.value ?? {}]]
    : (Object.entries(scheme).filter(([, v]) => v && typeof v === "object") as [
        string,
        Record<string, unknown>,
      ][]);
  const [name, value] = entries[0] ?? [String(scheme["type"] ?? "unknown"), scheme];
  switch (name) {
    case "httpAuthSecurityScheme":
    case "http": {
      const s = str(value["scheme"]) ?? "bearer";
      return { kind: s.toLowerCase() === "bearer" ? "bearer" : `http ${s}` };
    }
    case "apiKeySecurityScheme":
    case "apiKey": {
      const where = str(value["location"]) ?? str(value["in"]) ?? "header";
      return {
        kind: where === "header" ? "header" : `api key in ${where}`,
        ...(str(value["name"]) ? { detail: str(value["name"])! } : {}),
      };
    }
    case "oauth2SecurityScheme":
    case "oauth2":
      return { kind: "oauth2" };
    case "openIdConnectSecurityScheme":
    case "openIdConnect":
      return { kind: "openid" };
    case "mtlsSecurityScheme":
    case "mutualTLS":
      return { kind: "mtls" };
    default:
      return { kind: name };
  }
}

const isJsonRpc = (transport: unknown) => String(transport ?? "").toUpperCase() === "JSONRPC";

/**
 * The interface the room uses from a card's interfaces: the first JSON-RPC 1.x one, else the
 * first JSON-RPC 0.3 one (ADR 0018). Throws, saying why, when there is none.
 */
function chooseInterface(interfaces: Record<string, unknown>[]): Record<string, unknown> {
  const version = (i: Record<string, unknown>) => String(i["protocolVersion"] ?? "");
  const v1 = interfaces.filter((i) => /^1(\.|$)/.test(version(i)));
  const v03 = interfaces.filter((i) => dialectOf(version(i)) === "0.3");
  const chosen =
    v1.find((i) => isJsonRpc(i["protocolBinding"])) ??
    v03.find((i) => isJsonRpc(i["protocolBinding"]));
  if (chosen) return chosen;
  const offered = [...v1, ...v03];
  if (offered.length > 0) {
    throw new Error(
      `This agent offers A2A only over ${[...new Set(offered.map((i) => String(i["protocolBinding"])))].join(", ")}; the room speaks JSON-RPC.`,
    );
  }
  const versions = [...new Set(interfaces.map((i) => String(i["protocolVersion"] ?? "?")))].join(
    ", ",
  );
  throw new Error(`This agent speaks A2A ${versions}; the room needs A2A 1.0 or 0.3.`);
}

/**
 * An A2A 0.3 card names its endpoint at the top: `url`, served over `preferredTransport`
 * (JSON-RPC when absent), with other transports in `additionalInterfaces`.
 */
function legacyInterface(card: Record<string, unknown>): Record<string, unknown> {
  const version = str(card["protocolVersion"]);
  if (!version) {
    throw new Error(
      "The Agent Card lists no interfaces (supportedInterfaces), so the room can't tell how to reach the agent.",
    );
  }
  if (dialectOf(version) !== "0.3") {
    throw new Error(`This agent speaks A2A ${version}; the room needs A2A 1.0 or 0.3.`);
  }
  const preferred = str(card["preferredTransport"]) ?? "JSONRPC";
  const others = Array.isArray(card["additionalInterfaces"])
    ? (card["additionalInterfaces"] as Record<string, unknown>[])
    : [];
  const url = isJsonRpc(preferred)
    ? str(card["url"])
    : str(others.find((i) => isJsonRpc(i["transport"]))?.["url"]);
  if (!url) {
    throw new Error(
      `This agent offers A2A ${version} only over ${preferred}; the room speaks JSON-RPC.`,
    );
  }
  return { url, protocolVersion: version, protocolBinding: "JSONRPC" };
}

/**
 * Parses an Agent Card (spec 4.4) and picks the interface the room uses: the first JSON-RPC 1.x
 * one, else a JSON-RPC 0.3 one, from `supportedInterfaces` or from a 0.3 card's own fields.
 */
export function parseCard(json: unknown, cardUrl: string): ParsedCard {
  if (!json || typeof json !== "object")
    throw new Error("That address doesn't serve an Agent Card.");
  const card = json as Record<string, unknown>;
  const interfaces = Array.isArray(card["supportedInterfaces"])
    ? (card["supportedInterfaces"] as Record<string, unknown>[])
    : [];
  const chosen = interfaces.length ? chooseInterface(interfaces) : legacyInterface(card);
  const protocolVersion = (str(chosen["protocolVersion"]) ?? "1.0").slice(0, 20);
  const url = str(chosen["url"]);
  if (!url) throw new Error("The Agent Card's JSON-RPC interface has no URL.");
  const refusal = endpointRefusal(cardUrl, url);
  if (refusal) throw new Error(refusal);
  const capabilities = (card["capabilities"] ?? {}) as Record<string, unknown>;
  const schemes = (card["securitySchemes"] ?? {}) as Record<string, Record<string, unknown>>;
  const requirements = Array.isArray(card["securityRequirements"])
    ? card["securityRequirements"]
    : Array.isArray(card["security"])
      ? card["security"]
      : [];
  const skills = Array.isArray(card["skills"]) ? (card["skills"] as Record<string, unknown>[]) : [];
  // Tenants came with A2A 1.0.
  const tenant = dialectOf(protocolVersion) === "1.0" ? str(chosen["tenant"]) : undefined;
  return {
    name: (str(card["name"]) ?? "Unnamed agent").slice(0, 120),
    description: (str(card["description"]) ?? "").slice(0, 1000),
    version: (str(card["version"]) ?? "").slice(0, 40),
    protocolVersion,
    endpoint: { url, ...(tenant ? { tenant } : {}) },
    streaming: capabilities["streaming"] === true,
    pushNotifications: capabilities["pushNotifications"] === true,
    skills: skills.slice(0, 20).map((s) => ({
      id: (str(s["id"]) ?? "").slice(0, 80),
      name: (str(s["name"]) ?? str(s["id"]) ?? "").slice(0, 120),
    })),
    security: Object.entries(schemes)
      .slice(0, 10)
      .map(([name, scheme]) => ({ name: name.slice(0, 80), ...securityKind(scheme ?? {}) })),
    needsCredential: requirements.length > 0,
    ...(str(card["documentationUrl"])
      ? { documentationUrl: str(card["documentationUrl"])!.slice(0, 500) }
      : {}),
  };
}

/** Reads and parses the Agent Card at `cardUrl`. It is public, so no credential is sent. */
export async function fetchCard(
  transport: Transport,
  cardUrl: string,
  timeoutMs: number,
): Promise<ParsedCard> {
  const d = deadline(timeoutMs);
  let body: string;
  try {
    const response = await send(
      transport,
      cardUrl,
      { method: "GET", headers: { accept: "application/json", "a2a-version": A2A_VERSION } },
      d,
    );
    if (isRedirect(response)) {
      throw new Error(
        "The address redirects somewhere else, which the room doesn't follow. Register the address the card is served from.",
      );
    }
    if (!response.ok)
      throw new Error(`Reading the Agent Card failed with HTTP ${response.status}.`);
    body = await readBounded(response, MAX_CARD_BYTES, d);
  } catch (error) {
    throw error instanceof A2ACallError
      ? new Error(`Couldn't read the Agent Card. ${error.message}`)
      : error;
  } finally {
    d.release();
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("That address doesn't serve an Agent Card (the answer isn't JSON).");
  }
  return parseCard(json, cardUrl);
}

function rpcBody(method: string, params: Record<string, unknown>, endpoint: Endpoint): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params: endpoint.tenant ? { tenant: endpoint.tenant, ...params } : params,
  });
}

/** An agent's message without a dangling ": " or other separator at its end. */
export function trimTail(text: string): string {
  return text.trim().replace(/[\s:;,]+$/u, "");
}

function rpcError(error: unknown, status: number): A2ACallError {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "number" ? e.code : undefined;
  // Kept as the agent wrote it, less an empty tail ("method not found: " named no method), and
  // whole: it is cut only when saved, after the room's token is taken out of it (redact.ts). The
  // answer it came in is already read with a size limit.
  const said = typeof e.message === "string" ? trimTail(e.message) : "";
  const message = said || "The agent returned an error.";
  if (status === 401 || status === 403) return httpRefusal(status);
  // A server fault may come after the agent stored the message: only reconciling can tell.
  return new A2ACallError(message, {
    kind: "rpc",
    ...(code !== undefined ? { code } : {}),
    status,
    ambiguous: status >= 500 || code === RPC.internalError,
    ...(said ? { said } : {}),
  });
}

function httpRefusal(status: number): A2ACallError {
  return new A2ACallError(`The agent's gateway refused the room's credentials (${status}).`, {
    kind: "http",
    status,
    ambiguous: false,
  });
}

/** One JSON-RPC call; returns its `result`. The deadline covers the whole answer. */
export async function call(
  transport: Transport,
  endpoint: Endpoint,
  credential: Credential | null,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  dialect: Dialect = "1.0",
): Promise<unknown> {
  const d = deadline(timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await send(
      transport,
      endpoint.url,
      {
        method: "POST",
        headers: headers(credential, "application/json", dialect),
        body: rpcBody(method, params, endpoint),
      },
      d,
    );
    if (isRedirect(response)) {
      throw new A2ACallError(
        "The agent's gateway redirected the room elsewhere, which the room doesn't follow.",
        {
          kind: "http",
          status: response.status,
          ambiguous: false,
        },
      );
    }
    text = await readBounded(response, MAX_RESPONSE_BYTES, d);
  } finally {
    d.release();
  }
  const json = parseJson(text);
  if (json && json.error !== undefined) throw rpcError(json.error, response.status);
  if (response.status === 401 || response.status === 403) throw httpRefusal(response.status);
  if (!response.ok) {
    throw new A2ACallError(`The agent's gateway answered HTTP ${response.status}.`, {
      kind: "http",
      status: response.status,
      ambiguous: response.status >= 500,
    });
  }
  if (!json || !("result" in json)) {
    throw new A2ACallError("The agent's answer isn't a JSON-RPC result.", {
      kind: "protocol",
      ambiguous: true,
    });
  }
  return json.result;
}

/**
 * Splits Server-Sent Events into their data payloads. Lines may end with CRLF,
 * LF or CR, and a CRLF may be split across network chunks.
 */
export function createSseParser() {
  let buffer = "";
  let pendingCR = false;
  const events = (): string[] => {
    const out: string[] = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  };
  return {
    /** At the end of the stream: a CR held back to see whether an LF follows is a line break after all. */
    end(): string[] {
      if (pendingCR) buffer += "\n";
      pendingCR = false;
      return events();
    },
    push(text: string): string[] {
      let next = (pendingCR ? "\r" : "") + text;
      pendingCR = next.endsWith("\r");
      if (pendingCR) next = next.slice(0, -1);
      buffer += next.replace(/\r\n?/g, "\n");
      if (buffer.length > MAX_EVENT_BYTES) {
        throw new A2ACallError("An event from the agent is too large.", {
          kind: "protocol",
          ambiguous: true,
        });
      }
      return events();
    },
  };
}

/**
 * A streaming call (SendStreamingMessage or SubscribeToTask): yields each
 * StreamResponse (spec 3.2.3) from the Server-Sent Events, until the agent
 * closes the stream or `signal` aborts it.
 */
export async function* stream(
  transport: Transport,
  endpoint: Endpoint,
  credential: Credential | null,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  connectTimeoutMs: number,
  dialect: Dialect = "1.0",
): AsyncGenerator<unknown> {
  // Until the stream opens, a deadline covers connecting, the headers and any non-stream body.
  const d = deadline(connectTimeoutMs, signal);
  let response: Response;
  try {
    response = await send(
      transport,
      endpoint.url,
      {
        method: "POST",
        headers: headers(credential, "text/event-stream", dialect),
        body: rpcBody(method, params, endpoint),
      },
      d,
    );
    if (isRedirect(response)) {
      throw new A2ACallError(
        "The agent's gateway redirected the room elsewhere, which the room doesn't follow.",
        {
          kind: "http",
          status: response.status,
          ambiguous: false,
        },
      );
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      // An error comes back as a plain JSON-RPC response.
      const text = await readBounded(response, MAX_RESPONSE_BYTES, d);
      const json = parseJson(text);
      if (json?.error !== undefined) throw rpcError(json.error, response.status);
      if (response.status === 401 || response.status === 403) throw httpRefusal(response.status);
      throw new A2ACallError(`The agent didn't open a stream (HTTP ${response.status}).`, {
        kind: "protocol",
        status: response.status,
        ambiguous: response.status >= 500 || response.ok,
      });
    }
  } catch (error) {
    d.release();
    throw error;
  }
  // Open: from here only `signal` (the stream window, a reply or a stop) ends it.
  d.done();
  if (!response.body) {
    d.release();
    return;
  }
  const reader = response.body.getReader();
  const stop = () => {
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal.aborted) return;
        throw new A2ACallError("The stream from the agent broke.", {
          kind: "network",
          ambiguous: true,
        });
      }
      const datas = chunk.done
        ? [...parser.push(decoder.decode()), ...parser.end()]
        : parser.push(decoder.decode(chunk.value, { stream: true }));
      for (const data of datas) {
        let json: { result?: unknown; error?: unknown };
        try {
          json = JSON.parse(data) as typeof json;
        } catch {
          throw new A2ACallError("The agent sent an event that isn't JSON.", {
            kind: "protocol",
            ambiguous: true,
          });
        }
        if (json.error !== undefined) throw rpcError(json.error, 200);
        if (json.result !== undefined) yield json.result;
      }
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener("abort", stop);
    d.release();
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
}
