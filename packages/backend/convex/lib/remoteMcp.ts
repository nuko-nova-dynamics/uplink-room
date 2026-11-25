/**
 * The Room API as a remote MCP server (ADR 0028, ADR 0031): the connector a person adds in a
 * hosted assistant with this deployment's MCP URL, `<CONVEX_SITE_URL>/mcp`.
 *
 * Authorization follows the MCP specification (revision 2026-07-28, "Authorization"): the room is
 * an OAuth 2.1 resource server, Clerk is the authorization server. `GET
 * /.well-known/oauth-protected-resource/mcp` is the protected resource metadata (RFC 9728) naming
 * Clerk; a call without a token gets 401 with `WWW-Authenticate: Bearer resource_metadata=...`.
 * Every call's access token is checked here (lib/clerkTokens.ts verifyAccessToken): a JWT Clerk
 * signed for exactly this resource (RFC 8707, RFC 9068), issued to a client other than the
 * command line. The token is never passed on and never swapped for a token of the room's (decision
 * D16 of ADR 0029).
 *
 * The token names a person and an OAuth client; that pair is a connection (connectors.ts). Until
 * the person approves it in the app, every tool answers that it is waiting; once approved, each
 * tool call runs the Room API function as the connection's agent, with its agent key's hash, as
 * `/api/v1/call` does with an agent key, so every agent rule applies (ADR 0003).
 *
 * Transport: Streamable HTTP, POST only, a JSON body for every answer (no SSE, no sessions). The
 * MCP TypeScript SDK serves both protocol eras: revision 2026-07-28 (per-request metadata,
 * `server/discover`) through `createMcpHandler`, and the 2025 revisions (`initialize`) through its
 * web-standard transport, stateless, with JSON responses.
 */
import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import { CONNECTOR_INSTRUCTIONS, roomTool, toolName, type RoomFunctionInfo } from "@uplink-room/protocol/mcp";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { ConnectorCall } from "../connectors";
import { READS, returnedIds, SEEN_GRANULARITY_MS, waitingGivenRun } from "../connectors";
import { agentFunctionPath, argsJsonSchema, catalog, type CatalogEntry } from "./catalog";
import { isRoomRefusal } from "./errors";
import { TokenRejected, trustedIssuers, verifyAccessToken, type AccessTokenGrant } from "./clerkTokens";
import { sha256 } from "./crypto";
import { readText } from "./requestBody";

export const MCP_PATH = "/mcp";
export const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/** The Clerk scope a connector asks for: the room needs only who signed in (`sub`). */
const SCOPE = "openid";
/** The largest JSON-RPC message the endpoint reads. */
const MAX_BODY_BYTES = 1024 * 1024;

export type ConnectorConfig = {
  /** Clerk's issuer: the first instance in CLERK_JWT_ISSUER_DOMAIN, as `uplink login` uses (ADR 0030). */
  issuer: string;
  /** This deployment's MCP endpoint: the resource identifier, and the `aud` a token must carry. */
  resource: string;
  metadataUrl: string;
  /** OAuth clients whose tokens never act here, with why. */
  refusedClients: { clientId: string; why: string }[];
};

/** Null until the deployment has a Clerk issuer and a site URL (Convex sets CONVEX_SITE_URL). */
export function connectorConfig(): ConnectorConfig | null {
  const issuer = trustedIssuers()[0];
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
  if (!issuer || !site) return null;
  const cli = process.env.CLERK_CLI_CLIENT_ID?.trim();
  return {
    issuer,
    resource: `${site}${MCP_PATH}`,
    metadataUrl: `${site}${MCP_METADATA_PATH}`,
    // The command line's client asks for `openid profile email`, and its consent screen says
    // "Uplink Room command line": a token it got must never act as a connector (ADR 0030).
    refusedClients: cli ? [{ clientId: cli, why: "it was issued to the Uplink Room command line, not to a connector" }] : [],
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const NOT_CONFIGURED = {
  error: "not_configured",
  error_description: "This deployment doesn't take remote connectors: it has no Clerk issuer (CLERK_JWT_ISSUER_DOMAIN) or site URL.",
};

/** The protected resource metadata (RFC 9728, section 3.2). Served only at the path built from the resource. */
export function protectedResourceMetadata(): Response {
  const config = connectorConfig();
  if (!config) return json(503, NOT_CONFIGURED);
  return json(
    200,
    {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Uplink Room",
    },
    { "cache-control": "public, max-age=300" },
  );
}

/** A `WWW-Authenticate` parameter value: RFC 6750's quoted-string, without the characters it can't carry. */
function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, "'").replace(/[^\x20-\x7e]/g, "")}"`;
}

/** 401 for a call with no token (RFC 6750 3, RFC 9728 5.1): where the metadata is, and the scope to ask for. */
function challenge(config: ConnectorConfig): Response {
  return json(
    401,
    { error: "unauthorized", error_description: "Sign in through the connector's settings: this endpoint takes an access token from Clerk." },
    { "www-authenticate": `Bearer resource_metadata=${quoted(config.metadataUrl)}, scope=${quoted(SCOPE)}` },
  );
}

/** 401 for a token that failed a check (RFC 6750 3.1, RFC 9068 4: `invalid_token`). */
function refusedToken(config: ConnectorConfig, why: string): Response {
  const description = `The room refused this access token: ${why}.`;
  return json(401, { error: "invalid_token", error_description: description }, {
    "www-authenticate": `Bearer error="invalid_token", error_description=${quoted(description)}, resource_metadata=${quoted(config.metadataUrl)}`,
  });
}

/**
 * Checked tokens, by their SHA-256, until they expire (decision D16): the same token on the next
 * call skips the JWKS fetch and the signature check. Only in this isolate's memory, so a miss just
 * checks again. Keyed with the config, so a changed setting checks again too.
 */
const checked = new Map<string, AccessTokenGrant>();
const CHECKED_MAX = 500;

async function checkToken(token: string, config: ConnectorConfig): Promise<AccessTokenGrant> {
  const key = `${config.issuer} ${config.resource} ${config.refusedClients.map((c) => c.clientId).join(",")} ${await sha256(token)}`;
  const now = Date.now();
  const hit = checked.get(key);
  if (hit && hit.expiresAt > now) return hit;
  checked.delete(key);
  const grant = await verifyAccessToken(token, config, now);
  if (checked.size >= CHECKED_MAX) {
    for (const [k, v] of checked) if (v.expiresAt <= now || checked.size >= CHECKED_MAX) checked.delete(k);
  }
  checked.set(key, grant);
  return grant;
}

/** RFC 6750 2.1: the token only from the `Authorization` header (the scheme is case-insensitive), never the query. */
function bearerToken(request: Request): string {
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1]! : "";
}

/**
 * Streamable HTTP, "Security & Endpoint": servers MUST validate `Origin`, and answer 403 to an
 * invalid one. Hosted assistants call from their servers, which send no Origin; a page in a
 * browser always sends one, and no web page is meant to call this endpoint, so any Origin is refused.
 */
function originAllowed(request: Request): boolean {
  return request.headers.get("origin") === null;
}

/** The client's own name, from `initialize` (2025 revisions) or the request's `_meta` (2026-07-28). */
function clientNameOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const params = (body as { params?: Record<string, unknown> }).params;
  if (!params || typeof params !== "object") return undefined;
  const legacy = (params.clientInfo as { name?: unknown; title?: unknown } | undefined) ?? undefined;
  const meta = params._meta as Record<string, unknown> | undefined;
  const modern = meta?.["io.modelcontextprotocol/clientInfo"] as { name?: unknown; title?: unknown } | undefined;
  for (const info of [legacy, modern]) {
    const name = typeof info?.title === "string" && info.title ? info.title : info?.name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return undefined;
}

const WAITING = (label: string) =>
  `This connection is waiting for approval: open Uplink Room, go to Settings, Agents, and approve "${label}" there, choosing its team, its name and what it may do. Until then every tool answers with this message.`;
const ENDED = (why: string) =>
  `This connection ended in Uplink Room: ${why}. To connect again, the person removes it under Settings, Agents, and the next call asks for approval again.`;
const TOO_MANY =
  "Too many connections are waiting for approval in Uplink Room. Approve or remove some under Settings, Agents, then call again.";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The team functions, and the Pair functions an agent with `pairs.join` uses (ADR 0034), as tools.
 * Account functions are for people (ADR 0030), so a connector's agent never sees them.
 */
function teamFunctions(): CatalogEntry[] {
  return catalog().filter((entry) => entry.realm === "team" || entry.realm === "pair");
}

function toolFor(entry: CatalogEntry, call: ConnectorCall) {
  const info: RoomFunctionInfo = {
    name: entry.name,
    kind: entry.kind,
    realm: entry.realm,
    description: entry.description,
    scope: entry.scope,
    inputSchema: argsJsonSchema(entry.args, entry.argDocs, entry.realm),
  };
  const lacks = call.status === "approved" && !call.scopes.includes(entry.scope);
  // argsJsonSchema always builds an object schema.
  return roomTool(info, lacks ? { addedBy: call.addedBy } : undefined) as Tool;
}

/** A Room API error as the text of a tool error: its code first, as `uplink-mcp` writes it. */
function errorText(error: unknown, fn: string): string {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string; message?: string };
    return `${data.code ?? "invalid"}: ${data.message ?? String(error.data)}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ArgumentValidationError") || message.includes("Validator")) return `invalid: ${message}`;
  console.error(`remote MCP: ${fn} failed`, error);
  return `internal: The room couldn't run ${fn}. Try again; if it keeps failing, tell the person who approved this connection.`;
}

/** Runs one Room API function as the connection's agent, as `/api/v1/call` does with an agent key. */
async function runAsAgent(
  ctx: ActionCtx,
  call: Extract<ConnectorCall, { status: "approved" }>,
  entry: CatalogEntry,
  input: unknown,
): Promise<CallToolResult> {
  const args: Record<string, unknown> =
    input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  // The credential is the connection's, never the caller's.
  delete args.agentKeyHash;
  delete args.signInHash;
  // A Pair function runs outside every team.
  if (entry.realm === "pair") delete args.teamId;
  else if (args.teamId === undefined) args.teamId = call.teamId;
  const path = agentFunctionPath(entry.name);
  try {
    const result =
      entry.kind === "query"
        ? await ctx.runQuery(makeFunctionReference<"query">(path) as never, { ...args, agentKeyHash: call.agentKeyHash } as never)
        : await ctx.runMutation(makeFunctionReference<"mutation">(path) as never, { ...args, agentKeyHash: call.agentKeyHash } as never);
    // A refusal read nothing.
    const answer: unknown = result;
    if (isRoomRefusal(answer)) return toolError(`${answer.refused.code}: ${answer.refused.message}`);
    // An agent that checks in on its own schedule read messages: what waited on those is seen.
    if (call.waiting && (READS as readonly string[]).includes(entry.name)) {
      const messageIds = returnedIds(result);
      if (messageIds.length) await ctx.runMutation(internal.connectors.noteRead, { agentKeyHash: call.agentKeyHash, messageIds });
    }
    // So did reading a run given to it (ADR 0044).
    const givenRunId = waitingGivenRun(entry.name, result);
    if (givenRunId) await ctx.runMutation(internal.connectors.noteRunRead, { agentKeyHash: call.agentKeyHash, runId: givenRunId });
    // A function that returns nothing succeeded; "null" alone reads like a failure.
    return { content: [{ type: "text", text: result === null || result === undefined ? "ok" : JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return toolError(errorText(error, entry.name));
  }
}

/** One MCP server instance for one HTTP exchange, bound to this call's connection. */
function serverFor(ctx: ActionCtx, call: ConnectorCall, label: string): Server {
  const preface =
    call.status === "approved"
      ? ""
      : `${call.status === "ended" ? ENDED(call.why) : call.status === "too_many" ? TOO_MANY : WAITING(label)}\n\n`;
  const server = new Server(
    { name: "uplink-room", title: "Uplink Room", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: `${preface}${CONNECTOR_INSTRUCTIONS}` },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: teamFunctions().map((entry) => toolFor(entry, call)) }));
  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const entry = teamFunctions().find((e) => toolName(e.name) === name);
    if (!entry) return toolError(`not_found: No Room API function is exposed as the tool ${name}.`);
    if (call.status === "approved") return runAsAgent(ctx, call, entry, request.params.arguments);
    if (call.status === "ended") return toolError(ENDED(call.why));
    if (call.status === "too_many") return toolError(TOO_MANY);
    return toolError(WAITING(label));
  });
  return server;
}

/** The connection for this token, recorded as seen (at most hourly) or as new. */
async function connectionFor(ctx: ActionCtx, grant: AccessTokenGrant, clientName: string | undefined): Promise<ConnectorCall> {
  const found: ConnectorCall = await ctx.runQuery(internal.connectors.forCall, { subject: grant.subject, clientId: grant.clientId });
  const stale =
    found.status === "new" ||
    found.status === "too_many" ||
    Date.now() - found.lastSeenAt >= SEEN_GRANULARITY_MS ||
    (found.status === "pending" && !found.clientName && clientName !== undefined);
  if (!stale) return found;
  return await ctx.runMutation(internal.connectors.arrive, {
    subject: grant.subject,
    clientId: grant.clientId,
    ...(clientName ? { clientName } : {}),
  });
}

/** Serves the 2025 revisions statelessly with JSON answers, so the call finishes before the action returns. */
async function serveLegacy(server: Server, request: Request, parsedBody: unknown): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** `POST /mcp` (and GET and DELETE, which get 405 once authorized). */
export async function handleMcp(ctx: ActionCtx, request: Request): Promise<Response> {
  const config = connectorConfig();
  if (!config) return json(503, NOT_CONFIGURED);
  if (!originAllowed(request)) {
    return json(403, { jsonrpc: "2.0", error: { code: -32000, message: "This origin may not call the room's MCP endpoint." } });
  }

  const token = bearerToken(request);
  if (!token) return challenge(config);
  let grant: AccessTokenGrant;
  try {
    grant = await checkToken(token, config);
  } catch (error) {
    if (error instanceof TokenRejected) return refusedToken(config, error.message);
    throw error;
  }

  if (request.method !== "POST") {
    // No sessions and no standalone SSE stream (Streamable HTTP, "Backward Compatibility").
    return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: send each message as a POST." } }, { allow: "POST" });
  }
  const body = await readText(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return json(body.status, { jsonrpc: "2.0", error: { code: -32000, message: body.message } });
  const text = body.text;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    parsedBody = undefined;
  }
  // The SDK reads the body again unless it gets parsedBody, so it gets a fresh request either way.
  const forward = new Request(request.url, { method: "POST", headers: request.headers, body: text });

  const clientName = clientNameOf(parsedBody);
  const call = await connectionFor(ctx, grant, clientName);
  const label = (call.status === "pending" && call.clientName) || clientName || grant.clientId;
  const factory = () => serverFor(ctx, call, label);

  if (await isLegacyRequest(forward, parsedBody)) return serveLegacy(factory(), forward, parsedBody);
  const modern = createMcpHandler(factory, { legacy: "reject", responseMode: "json", keepAliveMs: 0 });
  try {
    return await modern.fetch(forward, parsedBody === undefined ? undefined : { parsedBody });
  } finally {
    await modern.close().catch(() => {});
  }
}
