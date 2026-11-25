/**
 * The Room API over HTTP (ADR 0003). Agents call it with an agent key, people with a CLI sign-in's
 * token (ADR 0030), and a joined run with its own run token (ADR 0032), as
 * `Authorization: Bearer <key or token>`:
 *
 *   POST /api/v1/call   { "fn": "tasks.create", "args": { ... } }
 *   GET  /api/v1/functions
 *
 * `uplink login` makes a CLI sign-in with these two, which take no credential:
 *
 *   POST /api/v1/cli-sign-in         -> { issuer, clientId, scopes, nonce, expiresAt }
 *   POST /api/v1/cli-sign-in/token   { idToken, name } -> { token, signInId, expiresAt, person }
 *
 * The MCP server and the command-line tool are thin layers over these.
 *
 * Hosted assistants reach the Room API through the remote connector (ADR 0028, ADR 0031), with an
 * access token from Clerk:
 *
 *   POST /mcp                                     MCP over Streamable HTTP (lib/remoteMcp.ts)
 *   GET  /.well-known/oauth-protected-resource/mcp  its protected resource metadata (RFC 9728)
 *
 * Clerk tells the room when an account is deleted (ADR 0035):
 *
 *   POST /clerk/webhook   Clerk's `user.deleted`, signed by Svix
 */
import { httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { githubRoutes } from "./githubHttp";
import {
  accountFunctionPath,
  agentFunctionPath,
  argsJsonSchema,
  runFunctionPath,
  catalog,
  catalogEntry,
  ROOM_API_VERSION,
  type CatalogEntry,
} from "./lib/catalog";
import { CLI_SCOPES, cliSignInConfig, TokenRejected, verifyIdToken } from "./lib/clerkTokens";
import { handleMcp, MCP_METADATA_PATH, MCP_PATH, protectedResourceMetadata } from "./lib/remoteMcp";
import { isCliSignInToken, LAST_USED_GRANULARITY_MS } from "./cliSignIns";
import { waitingGivenRun } from "./connectors";
import { sha256 } from "./lib/crypto";
import { isRoomRefusal } from "./lib/errors";
import { CLERK_WEBHOOK_BODY_BYTES, CLERK_WEBHOOK_PATH, clerkWebhookKeys, deletedUser, verifyClerkWebhook } from "./lib/clerkWebhook";
import { readBody, readJsonObject, readText, type ReadBody } from "./lib/requestBody";
import { isRunToken } from "./lib/joinedRuns";
import { callIdFromRoom, liveKitConfig } from "./lib/livekit";
import { WebhookReceiver } from "livekit-server-sdk";
import { SCOPES } from "./lib/scopes";
import { contentDisposition, inlineDisposition } from "./lib/attachments";
// Each module registers its functions in the catalog when it loads.
import "./roomModules";

const http = httpRouter();

const STATUS: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  no_free_slot: 409,
  not_configured: 503,
  warning_required: 428,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json(status, { ok: false, error: { code, message } });
}

/** The credential in `Authorization: Bearer <credential>`, or "". */
function bearerOf(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

/** A Room API error (or an argument the validator refused) as its HTTP answer; other errors throw. */
function errorResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string; message?: string };
    const code = data.code ?? "invalid";
    return fail(STATUS[code] ?? 400, code, data.message ?? String(error.data));
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ArgumentValidationError") || message.includes("Validator")) {
    return fail(400, "invalid", message);
  }
  throw error;
}

/**
 * The largest body each route reads (lib/requestBody.ts reads it as a stream, with a deadline).
 * A Room API call carries at most a function's arguments, which Convex caps at 16 MiB; a sign-in
 * carries one ID token; the webhooks carry small events.
 */
const CALL_BODY_BYTES = 16 * 1024 * 1024;
const SIGN_IN_BODY_BYTES = 64 * 1024;
const HYPERBEAM_BODY_BYTES = 64 * 1024;
const LIVEKIT_BODY_BYTES = 1024 * 1024;

/** An oversized (413), late (408) or broken (400) body as the Room API's answer, with the code `invalid`. */
function bodyRefused(body: Extract<ReadBody, { ok: false }>): Response {
  return fail(body.status, "invalid", body.message);
}

const NOT_CONFIGURED =
  "This deployment doesn't take command-line sign-ins yet: CLERK_CLI_CLIENT_ID isn't set (ADR 0030). Use an agent key: uplink login --key <agent key>.";

http.route({
  path: `/api/${ROOM_API_VERSION}/functions`,
  method: "GET",
  handler: httpAction(async () =>
    json(200, {
      version: ROOM_API_VERSION,
      scopes: SCOPES,
      functions: catalog().map((f) => ({
        name: f.name,
        kind: f.kind,
        realm: f.realm,
        description: f.description,
        scope: f.scope,
        inputSchema: argsJsonSchema(f.args, f.argDocs, f.realm),
      })),
    }),
  ),
});

/** A function's result as the Room API's answer: a refusal it returned (lib/errors.ts) is an error. */
function answer(result: unknown): Response {
  if (isRoomRefusal(result)) return fail(STATUS[result.refused.code] ?? 400, result.refused.code, result.refused.message);
  return json(200, { ok: true, result: result ?? null });
}

/** Runs a function as the internal Convex function `path`, with `args` that already carry the credential. */
async function runFunction(ctx: ActionCtx, entry: CatalogEntry, path: string, args: Record<string, unknown>): Promise<unknown> {
  return entry.kind === "query"
    ? await ctx.runQuery(makeFunctionReference<"query">(path) as never, args as never)
    : await ctx.runMutation(makeFunctionReference<"mutation">(path) as never, args as never);
}

http.route({
  path: `/api/${ROOM_API_VERSION}/call`,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const key = bearerOf(request);
    if (!key) {
      return fail(401, "unauthenticated", "Send an agent key, or a CLI sign-in's token from `uplink login`, as `Authorization: Bearer <key>`.");
    }

    const body = await readJsonObject<{ fn?: unknown; args?: unknown }>(request, { maxBytes: CALL_BODY_BYTES });
    if (!body.ok) return bodyRefused(body);
    const payload = body.value;
    if (!payload) return fail(400, "invalid", "The body must be JSON: { fn, args }.");
    if (typeof payload.fn !== "string") return fail(400, "invalid", "Missing `fn`.");
    const entry = catalogEntry(payload.fn);
    if (!entry) return fail(404, "not_found", `No Room API function named ${payload.fn}.`);
    const args: Record<string, unknown> = { ...(payload.args as Record<string, unknown> | undefined) };

    // A joined run's own token (ADR 0032): its run functions, and nothing else.
    if (isRunToken(key)) {
      if (entry.realm !== "run") {
        return fail(
          403,
          "forbidden",
          `A run token acts only as its joined run (joined.* run functions: uplink inbox, say, reply, leave), so it can't call ${entry.name}. The person's own commands use their sign-in from \`uplink login\`.`,
        );
      }
      try {
        return answer(await runFunction(ctx, entry, runFunctionPath(entry.name), { ...args, runTokenHash: await sha256(key) }));
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (entry.realm === "run") {
      return fail(
        403,
        "forbidden",
        `${entry.name} acts as a joined run, with that run's token: run it as \`uplink inbox\`, \`uplink say\` or \`uplink reply\` in a session that ran \`uplink join\`.`,
      );
    }

    // A person's CLI sign-in (ADR 0030): account functions, or team functions as their member.
    if (isCliSignInToken(key)) {
      const signInHash = await sha256(key);
      try {
        const signIn = await ctx.runQuery(internal.cliSignIns.forCall, {
          signInHash,
          needsTeam: entry.realm === "team" && args.teamId === undefined,
        });
        // Checked here too: the query's answer may be a cached one.
        if (signIn.expiresAt <= Date.now()) {
          return fail(401, "unauthenticated", "This sign-in expired. Run `uplink login` to sign in again.");
        }
        if (entry.realm === "team" && args.teamId === undefined) args.teamId = signIn.teamId;
        // Any call the sign-in authenticates is a use, so it's noted first, whatever the function answers.
        if (signIn.lastUsedAt === undefined || Date.now() - signIn.lastUsedAt >= LAST_USED_GRANULARITY_MS) {
          await ctx.runMutation(internal.cliSignIns.touch, { signInId: signIn.signInId });
        }
        const path = entry.realm === "account" || entry.realm === "pair" ? accountFunctionPath(entry.name) : agentFunctionPath(entry.name);
        return answer(await runFunction(ctx, entry, path, { ...args, signInHash }));
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (entry.realm === "account") {
      return fail(
        403,
        "forbidden",
        `${entry.name} is for a person signed in with \`uplink login\`, not for an agent key. An agent learns who it is with members.me.`,
      );
    }
    const agentKeyHash = await sha256(key);
    // A Pair function (ADR 0034): outside every team, so the key's own checks are all there is.
    if (entry.realm === "pair") {
      try {
        return answer(await runFunction(ctx, entry, agentFunctionPath(entry.name), { ...args, agentKeyHash }));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const keyTeam = await ctx.runQuery(internal.agents.teamForKey, { agentKeyHash });
    if (!keyTeam) return fail(401, "unauthenticated", "This agent key is not valid or was revoked.");
    if (args.teamId === undefined) args.teamId = keyTeam;

    try {
      const result = await runFunction(ctx, entry, agentFunctionPath(entry.name), { ...args, agentKeyHash });
      // A refusal read nothing.
      if (isRoomRefusal(result)) return answer(result);
      // An agent that checks in read a run given to it (ADR 0044): what waited there is seen.
      const givenRunId = waitingGivenRun(entry.name, result);
      if (givenRunId) await ctx.runMutation(internal.connectors.noteRunRead, { agentKeyHash, runId: givenRunId });
      return answer(result);
    } catch (error) {
      return errorResponse(error);
    }
  }),
});

/**
 * `uplink login`, first step (ADR 0030): where to sign in (the Clerk instance and the command
 * line's OAuth client ID) and a nonce for Clerk to put in the ID token, good for 15 minutes.
 */
http.route({
  path: `/api/${ROOM_API_VERSION}/cli-sign-in`,
  method: "POST",
  handler: httpAction(async (ctx) => {
    const config = cliSignInConfig();
    if (!config) return fail(503, "not_configured", NOT_CONFIGURED);
    const { nonce, expiresAt } = await ctx.runMutation(internal.cliSignIns.begin, {});
    return json(200, { ok: true, result: { issuer: config.issuer, clientId: config.clientId, scopes: CLI_SCOPES, nonce, expiresAt } });
  }),
});

/**
 * `uplink login`, last step: Clerk's ID token for the person who signed in becomes a CLI sign-in.
 * The token comes back once; the room keeps only its hash.
 */
http.route({
  path: `/api/${ROOM_API_VERSION}/cli-sign-in/token`,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const config = cliSignInConfig();
    if (!config) return fail(503, "not_configured", NOT_CONFIGURED);
    const read = await readJsonObject<{ idToken?: unknown; name?: unknown }>(request, { maxBytes: SIGN_IN_BODY_BYTES });
    if (!read.ok) return bodyRefused(read);
    const body = read.value;
    if (!body || typeof body.idToken !== "string") return fail(400, "invalid", "The body must be JSON: { idToken, name }.");
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";

    let claims;
    try {
      claims = await verifyIdToken(body.idToken, { issuer: config.issuer, audience: config.clientId });
    } catch (error) {
      if (error instanceof TokenRejected) {
        return fail(401, "unauthenticated", `The room couldn't accept this sign-in: ${error.message}. Run \`uplink login\` again.`);
      }
      throw error;
    }
    if (typeof claims.nonce !== "string" || !claims.nonce) {
      return fail(401, "unauthenticated", "The room couldn't accept this sign-in: it has no nonce. Run `uplink login` again.");
    }
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    try {
      const result = await ctx.runMutation(internal.cliSignIns.finish, {
        nonce: claims.nonce,
        subject: claims.sub,
        name: text(claims.name),
        email: text(claims.email),
        avatarUrl: text(claims.picture),
        signInName: name || "Command line",
      });
      return json(200, { ok: true, result });
    } catch (error) {
      return errorResponse(error);
    }
  }),
});

// The remote connector (ADR 0031). GET and DELETE get 401 without a token, and 405 with one.
http.route({ path: MCP_METADATA_PATH, method: "GET", handler: httpAction(async () => protectedResourceMetadata()) });
for (const method of ["POST", "GET", "DELETE"] as const) {
  http.route({ path: MCP_PATH, method, handler: httpAction(async (ctx, request) => handleMcp(ctx, request)) });
}

/**
 * Message attachments (spec #63, ADR 0015, ADR 0016):
 *
 *   GET /attachments/<token>/<name>         a team channel's attachment, as a download
 *   GET /attachments/grant/<token>/<name>   any attachment, through a link from messages.attachmentLink
 *   GET /attachments/pair/<token>/<name>    a Pair message's file, through a link from pairs.attachmentLink
 *                                           or joined.download (ADR 0048)
 *
 * The first token is the attachment's own random one; a deleted message's links stop working, and
 * an attachment in a direct message or private channel has none. A grant works for one member for
 * a few minutes, and only while they can still see the channel. Everything is served with `nosniff`
 * and a CSP that runs nothing; a file that isn't an image or a PDF only ever as a download, as
 * `application/octet-stream`.
 */
http.route({
  pathPrefix: "/attachments/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const parts = new URL(request.url).pathname.slice("/attachments/".length).split("/");
    const missing = () => new Response("No such attachment.", { status: 404, headers: { "content-type": "text/plain" } });
    if (parts[0] === "grant" || parts[0] === "pair") {
      const token = parts[1] ?? "";
      if (!/^[0-9a-f]{64}$/.test(token)) return missing();
      const tokenHash = await sha256(token);
      const grant =
        parts[0] === "pair"
          ? await ctx.runQuery(internal.pairs.attachmentGrant, { tokenHash })
          : await ctx.runQuery(internal.messages.attachmentGrant, { tokenHash });
      // The time is checked here, in the action: the query's answer may be a cached one.
      if (!grant || !grant.allowed || grant.expiresAt <= Date.now()) return missing();
      const blob = await ctx.storage.get(grant.storageId);
      if (!blob) return missing();
      const show = !grant.download && grant.kind !== "file";
      return new Response(blob, {
        status: 200,
        headers: {
          "content-type": grant.kind === "file" ? "application/octet-stream" : grant.contentType,
          "content-disposition": show ? inlineDisposition(grant.name) : contentDisposition(grant.name),
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          // The app's PDF viewer fetches the bytes; the link itself is the credential.
          "access-control-allow-origin": "*",
        },
      });
    }
    const token = parts[0] ?? "";
    if (!/^[0-9a-f]{64}$/.test(token)) return missing();
    const attachment = await ctx.runQuery(internal.messages.attachmentForDownload, { token });
    if (!attachment) return missing();
    const blob = await ctx.storage.get(attachment.storageId);
    if (!blob) return missing();
    return new Response(blob, {
      status: 200,
      headers: {
        "content-type": attachment.kind === "file" ? "application/octet-stream" : attachment.contentType,
        "content-disposition": contentDisposition(attachment.name),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }),
});

/**
 * Webhooks from Hyperbeam (spec #7, ADR 0006). Each shared browser has its own
 * secret, which Hyperbeam sends as the bearer token; it identifies the browser.
 *
 *   POST /hyperbeam/auth     { user_id, userdata: { ticket } }  ->  { authorized }
 *   POST /hyperbeam/timeout  { session_id, type }
 */

http.route({
  path: "/hyperbeam/auth",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const bearer = bearerOf(request);
    if (!bearer) return json(401, { authorized: false });
    const read = await readJsonObject<{ user_id?: unknown; userdata?: { ticket?: unknown } | null }>(request, {
      maxBytes: HYPERBEAM_BODY_BYTES,
    });
    if (!read.ok) return json(read.status, { authorized: false });
    if (!read.value) return json(400, { authorized: false });
    const body = read.value;
    const ticket = typeof body.userdata?.ticket === "string" ? body.userdata.ticket : "";
    const result = await ctx.runMutation(internal.browsers.admit, {
      secretHash: await sha256(bearer),
      providerUserId: typeof body.user_id === "string" ? body.user_id : "",
      ticket: ticket ? await sha256(ticket) : "",
    });
    if (result === "unknown") return json(401, { authorized: false });
    return json(200, { authorized: result === "admitted" });
  }),
});

http.route({
  path: "/hyperbeam/timeout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const bearer = bearerOf(request);
    if (!bearer) return json(401, {});
    const read = await readJsonObject<{ type?: unknown }>(request, { maxBytes: HYPERBEAM_BODY_BYTES });
    if (!read.ok) return json(read.status, {});
    const body = read.value ?? {};
    const known = await ctx.runMutation(internal.browsers.timeoutReported, {
      secretHash: await sha256(bearer),
      type: typeof body.type === "string" ? body.type : "",
    });
    return json(known ? 200 : 401, {});
  }),
});

/**
 * LiveKit's webhooks (ADR 0007). They make leaving a call immediate when an app
 * or agent disconnects without calling `calls.leave`; without them the
 * heartbeat drops it within a minute. LiveKit signs each one with the API key.
 */
http.route({
  path: "/livekit/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const config = liveKitConfig();
    if (!config) return fail(404, "not_found", "Calls aren't set up on this deployment.");
    const read = await readText(request, { maxBytes: LIVEKIT_BODY_BYTES });
    if (!read.ok) return bodyRefused(read);
    const body = read.text;
    let event: Awaited<ReturnType<WebhookReceiver["receive"]>>;
    try {
      event = await new WebhookReceiver(config.apiKey, config.apiSecret).receive(
        body,
        request.headers.get("authorization") ?? undefined,
      );
    } catch {
      return fail(401, "unauthenticated", "This webhook isn't signed by LiveKit.");
    }
    const callId = event.room?.name ? callIdFromRoom(event.room.name) : null;
    if (!callId) return json(200, { ok: true });
    if (event.event === "participant_left" || event.event === "participant_connection_aborted") {
      const participant = event.participant;
      // The identity names one join, so that join (and no other) ends. No timestamps needed.
      if (participant?.identity) {
        await ctx.runMutation(internal.calls.liveKitParticipantLeft, { callId, identity: participant.identity });
      }
    } else if (event.event === "room_finished") {
      await ctx.runMutation(internal.calls.liveKitRoomFinished, { callId });
    }
    return json(200, { ok: true });
  }),
});

/**
 * Clerk's webhooks (ADR 0035), signed by Svix with the endpoint's signing secret
 * (lib/clerkWebhook.ts). The room acts on `user.deleted` only: the person's account is deleted
 * (accounts.ts). Every other verified event is answered 200 and ignored. A 2xx tells Svix to stop
 * retrying; anything else, including an error thrown here, makes it try again later.
 */
http.route({
  path: CLERK_WEBHOOK_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const keys = await clerkWebhookKeys();
    if (!keys) return fail(503, "not_configured", "This deployment doesn't take Clerk's webhooks: CLERK_WEBHOOK_SIGNING_SECRET isn't set.");
    const read = await readBody(request, { maxBytes: CLERK_WEBHOOK_BODY_BYTES });
    if (!read.ok) return bodyRefused(read);
    const check = await verifyClerkWebhook(keys, request.headers, read.bytes, Date.now());
    if (!check.ok) return fail(check.status, check.status === 401 ? "unauthenticated" : "invalid", check.message);
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return fail(400, "invalid", "The body isn't JSON.");
    }
    const subject = deletedUser(event);
    if (!subject) return json(200, { ok: true, result: "ignored" });
    const result = await ctx.runMutation(internal.accounts.deleteFromClerk, { deliveryId: check.id, subject });
    return json(200, { ok: true, result });
  }),
});

// GitHub: the connect flow's pages and the App's webhooks (ADR 0020).
githubRoutes(http);

export default http;
