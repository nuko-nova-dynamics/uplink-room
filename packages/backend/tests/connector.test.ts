/**
 * The remote MCP connector (ADR 0028, ADR 0031): a hosted assistant signs in with Clerk, waits for
 * its person to approve it in the app, then acts as an agent through an agent key the room holds.
 * These tests drive `/mcp` over HTTP the way an MCP client does, with access tokens a fake Clerk
 * signs as the real development instance does (tests/fakeClerk.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CLIENT_ID as CLI_CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { addAgent, bridgeSays, linkMachine, newRoom, newTeam, signIn, signInFromCli, type Room } from "./setup";

const SITE = "https://some.convex.site";
const RESOURCE = `${SITE}/mcp`;
const METADATA = `${SITE}/.well-known/oauth-protected-resource/mcp`;
/** The OAuth client a hosted assistant registered with Clerk (DCR), or its CIMD URL. */
const CLAUDE = "https://claude.ai/oauth/mcp-client-metadata";
const GROK = "grok_dcr_client";
/** The person newTeam signs in, as Clerk knows them. */
const JULIO = { subject: "user_Julio" };

let clerk: FakeClerk;

beforeEach(async () => {
  clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLI_CLIENT_ID);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubGlobal("fetch", clerk.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Era = "legacy" | "modern";
type Rpc = { status: number; headers: Headers; body: any };

const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";

/** One JSON-RPC request to `/mcp`, as an MCP client of either era sends it. */
async function rpc(
  t: Room,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  opts: { era?: Era; headers?: Record<string, string>; clientName?: string } = {},
): Promise<Rpc> {
  const era = opts.era ?? "legacy";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
  };
  let body: Record<string, unknown>;
  if (era === "modern") {
    headers["mcp-protocol-version"] = MODERN;
    headers["mcp-method"] = method;
    if (method === "tools/call") headers["mcp-name"] = String(params.name);
    body = {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: opts.clientName ?? "modern-client", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
  } else {
    if (method !== "initialize") headers["mcp-protocol-version"] = LEGACY;
    body = { jsonrpc: "2.0", id: 1, method, params };
  }
  const response = await t.fetch("/mcp", { method: "POST", headers: { ...headers, ...opts.headers }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

/** The legacy handshake's first request, carrying the client's name. */
function initialize(t: Room, token: string, clientName = "Claude") {
  return rpc(t, token, "initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } });
}

/** Calls a Room API function through the connector and returns MCP's CallToolResult. */
async function callTool(t: Room, token: string, name: string, args: Record<string, unknown> = {}, era: Era = "legacy") {
  const answer = await rpc(t, token, "tools/call", { name, arguments: args }, { era });
  expect(answer.status).toBe(200);
  const result = answer.body.result as { isError?: boolean; content: { type: string; text: string }[] };
  const text = result.content.map((c) => c.text).join("\n");
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

function connectorToken(subject: string, clientId = CLAUDE, claims: Record<string, unknown> = {}) {
  return clerk.accessToken({ subject }, { clientId, resource: RESOURCE }, claims);
}

async function generalChannel(as: Awaited<ReturnType<typeof signIn>>["as"], teamId: Id<"teams">) {
  const channels = await as.query(api.channels.list, { teamId });
  return channels.find((c) => c.name === "general")!.channelId;
}

describe("discovery", () => {
  test("the protected resource metadata names the resource and Clerk (RFC 9728)", async () => {
    const t = newRoom();
    const response = await t.fetch("/.well-known/oauth-protected-resource/mcp", { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [clerk.issuer],
      scopes_supported: ["openid"],
      bearer_methods_supported: ["header"],
      resource_name: "Uplink Room",
    });
  });

  test("a request with no token gets 401 and the metadata's address", async () => {
    const t = newRoom();
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await t.fetch("/mcp", { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}", scope="openid"`);
    }
  });

  test("a deployment without Clerk configured says so", async () => {
    vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "");
    const t = newRoom();
    const response = await t.fetch("/.well-known/oauth-protected-resource/mcp", { method: "GET" });
    expect(response.status).toBe(503);
  });

  test("a browser page on another origin is refused (Streamable HTTP: Origin)", async () => {
    const t = newRoom();
    const answer = await rpc(t, await connectorToken(JULIO.subject), "tools/list", {}, { headers: { origin: "https://evil.example" } });
    expect(answer.status).toBe(403);
  });
});

describe("approval", () => {
  test("until the person approves it, every tool says so, and the app lists it as waiting", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject);

    const init = await initialize(t, token, "Claude");
    expect(init.status).toBe(200);
    expect(init.body.result.instructions).toContain("waiting for approval");
    const tools = (await rpc(t, token, "tools/list")).body.result.tools as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["messages_post", "members_me", "tasks_board"]));
    // Account functions are for people; local-only tools belong to uplink-mcp.
    expect(tools.map((tool) => tool.name)).not.toContain("people_me");
    expect(tools.map((tool) => tool.name)).not.toContain("run_in_terminal");

    const channelId = await generalChannel(admin.as, teamId);
    const call = await callTool(t, token, "messages_post", { channelId, body: "hi from the connector" });
    expect(call.isError).toBe(true);
    expect(call.text).toContain("waiting for approval");
    expect(call.text).toContain("Settings, Agents");

    const waiting = await admin.as.query(api.connectors.list, {});
    expect(waiting).toEqual([expect.objectContaining({ clientId: CLAUDE, clientName: "Claude", status: "pending" })]);
    // Nothing was posted.
    const messages = await admin.as.query(api.messages.list, { teamId, channelId });
    expect(JSON.stringify(messages)).not.toContain("hi from the connector");
  });

  test("approved, it acts as an agent the person answers for, with room.read and messages.post only", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject);
    await initialize(t, token, "Claude");
    const [pending] = await admin.as.query(api.connectors.list, {});

    const approved = await admin.as.mutation(api.connectors.approve, { teamId, connectorId: pending!.connectorId, name: "Claude Duet" });
    expect(approved.scopes).toEqual(["room.read", "messages.post"]);

    const me = await callTool(t, token, "members_me");
    expect(me.isError).toBe(false);
    expect(me.json()).toMatchObject({ name: "Claude Duet", kind: "agent", addedBy: { name: "Julio" } });

    const channelId = await generalChannel(admin.as, teamId);
    const posted = await callTool(t, token, "messages_post", { channelId, body: "Checked in." });
    expect(posted.isError).toBe(false);

    // work.manage isn't one of its scopes: the room refuses, as for any agent key (ADR 0005).
    const task = await callTool(t, token, "tasks_create", { title: "Not mine to make" });
    expect(task.isError).toBe(true);
    expect(task.text).toMatch(/^forbidden: .*work\.manage/);

    // Its tools say which scopes its key lacks, as uplink-mcp's do.
    const tools = (await rpc(t, token, "tools/list")).body.result.tools as { name: string; description: string }[];
    expect(tools.find((tool) => tool.name === "tasks_create")!.description).toContain("your key lacks it, and Julio, who added you, can add it");

    // The app lists it approved, in the team it chose.
    expect(await admin.as.query(api.connectors.list, {})).toEqual([
      expect.objectContaining({
        status: "approved",
        team: { teamId, name: "Nuko Nova" },
        agent: expect.objectContaining({ name: "Claude Duet" }),
      }),
    ]);
  });

  test("the person can raise its scopes when approving, and the modern protocol revision works too", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject, GROK);
    const discover = await rpc(t, token, "server/discover", {}, { era: "modern", clientName: "Grok Bot" });
    expect(discover.status).toBe(200);
    expect(discover.body.result.supportedVersions).toContain(MODERN);

    const [pending] = await admin.as.query(api.connectors.list, {});
    expect(pending).toMatchObject({ clientId: GROK, clientName: "Grok Bot", status: "pending" });
    await admin.as.mutation(api.connectors.approve, {
      teamId,
      connectorId: pending!.connectorId,
      name: "Grok Bot",
      scopes: ["room.read", "messages.post", "work.manage"],
    });
    const task = await callTool(t, token, "tasks_create", { title: "Draft the launch notes" }, "modern");
    expect(task.isError).toBe(false);
  });

  test("its person deleting their account ends it at once, before they have left the team (ADR 0035)", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject);
    await initialize(t, token);
    const [pending] = await admin.as.query(api.connectors.list, {});
    await admin.as.mutation(api.connectors.approve, { teamId, connectorId: pending!.connectorId, name: "Claude" });
    expect((await callTool(t, token, "members_me")).isError).toBe(false);

    // The deletion's later steps wait on a fake clock: Julio is still in the team. The access token
    // Clerk issued before the deletion still checks out.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await t.mutation(internal.accounts.deleteFromClerk, { deliveryId: "msg_julio", subject: JULIO.subject });
    const after = await callTool(t, token, "members_me");
    expect(after.isError).toBe(true);
    expect(after.text).toContain("ended");
    expect(after.text).toContain("deleted their account");
  });

  test("revoking its key stops it at once; removing it lets it ask again", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject);
    await initialize(t, token);
    const [pending] = await admin.as.query(api.connectors.list, {});
    const { keyId } = await admin.as.mutation(api.connectors.approve, { teamId, connectorId: pending!.connectorId, name: "Claude" });
    expect((await callTool(t, token, "members_me")).isError).toBe(false);

    await admin.as.mutation(api.agents.revokeKey, { teamId, keyId });
    const after = await callTool(t, token, "members_me");
    expect(after.isError).toBe(true);
    expect(after.text).toContain("ended");
    expect(await admin.as.query(api.connectors.list, {})).toEqual([expect.objectContaining({ status: "ended" })]);

    await admin.as.mutation(api.connectors.remove, { connectorId: pending!.connectorId });
    expect((await callTool(t, token, "members_me")).text).toContain("waiting for approval");
    expect(await admin.as.query(api.connectors.list, {})).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  test("removing an approved connector revokes its key", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject);
    await initialize(t, token);
    const [pending] = await admin.as.query(api.connectors.list, {});
    const { agentId } = await admin.as.mutation(api.connectors.approve, { teamId, connectorId: pending!.connectorId, name: "Claude" });

    await admin.as.mutation(api.connectors.remove, { connectorId: pending!.connectorId });
    const keys = await admin.as.query(api.agents.keys, { teamId, agentId });
    expect(keys).toEqual([expect.objectContaining({ revokedAt: expect.any(Number) })]);
    expect((await callTool(t, token, "members_me")).text).toContain("waiting for approval");
  });

  test("only the person who signed the connector in can approve it, and only as a person", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const pepe = await signIn(t, "Pepe");
    const pepeTeam = await pepe.as.mutation(api.teams.create, { name: "Pepe's" });
    await initialize(t, await connectorToken(JULIO.subject));
    const [pending] = await admin.as.query(api.connectors.list, {});

    // Pepe sees no connector of Julio's, and can't approve it into his own team.
    expect(await pepe.as.query(api.connectors.list, {})).toEqual([]);
    await expect(
      pepe.as.mutation(api.connectors.approve, { teamId: pepeTeam, connectorId: pending!.connectorId, name: "Mine now" }),
    ).rejects.toThrow(/No such connection/);

    // An agent can't approve one either, even with people.invite (ADR 0003: a person adds every agent).
    const { key } = await addAgent(t, teamId, admin, "Chief of staff", ["room.read", "people.invite"]);
    const byAgent = await t.fetch("/api/v1/call", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ fn: "connectors.approve", args: { connectorId: pending!.connectorId, name: "x" } }),
    });
    expect(byAgent.status).toBe(403);
    expect(await admin.as.query(api.connectors.list, {})).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  test("a person can't approve one into a team they aren't in", async () => {
    const t = newRoom();
    const { admin } = await newTeam(t);
    const pepe = await signIn(t, "Pepe");
    const pepeTeam = await pepe.as.mutation(api.teams.create, { name: "Pepe's" });
    await initialize(t, await connectorToken(JULIO.subject));
    const [pending] = await admin.as.query(api.connectors.list, {});
    await expect(
      admin.as.mutation(api.connectors.approve, { teamId: pepeTeam, connectorId: pending!.connectorId, name: "x" }),
    ).rejects.toThrow(/not a member/);
  });
});

describe("token confusion (ADR 0031): only an access token Clerk issued for this resource, to a connector", () => {
  async function refused(t: Room, token: string, reason: RegExp) {
    const answer = await rpc(t, token, "tools/list");
    expect(answer.status).toBe(401);
    const challenge = answer.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${METADATA}"`);
    expect(challenge).toMatch(reason);
  }

  test("a CLI sign-in's token and an agent key are refused", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const cli = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
    const { key } = await addAgent(t, teamId, admin, "Lookout");
    await refused(t, cli, /isn't an access token/);
    await refused(t, key, /isn't an access token/);
  });

  test("Clerk's ID token and an access token issued to the command line are refused", async () => {
    const t = newRoom();
    await refused(t, await clerk.idToken({ subject: JULIO.subject, name: "Julio", email: "julio@example.com" }), /at\+jwt/);
    // Even when the command line's client asked for this resource: its consent screen named the command line.
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLI_CLIENT_ID, resource: RESOURCE }), /command line/);
  });

  test("a token for another resource, for no resource, or for several is refused", async () => {
    const t = newRoom();
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE }), /another resource/);
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: "https://other.example/mcp" }), /another resource/);
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE }, { aud: [RESOURCE, "https://other.example/mcp"] }), /another resource/);
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: `${RESOURCE}/` }), /another resource/);
    // A one-element list naming this resource is the same audience.
    const listed = await clerk.accessToken(JULIO, { clientId: CLAUDE }, { aud: [RESOURCE] });
    expect((await rpc(t, listed, "tools/list")).status).toBe(200);
  });

  test("forged, foreign, expired and malformed tokens are refused", async () => {
    const t = newRoom();
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, {}, { forged: true }), /signature/);
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, { iss: "https://evil.example" }), /issued by/);
    const past = Math.floor(Date.now() / 1000) - 7200;
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, { exp: past, iat: past - 60 }), /expired/);
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, {}, { header: { alg: "none" } }), /RS256/);
    await refused(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, { client_id: undefined }), /client/);
    await refused(t, "a.b.c", /isn't a JWT/);
  });

  test("a token in the query string is never read", async () => {
    const t = newRoom();
    const token = await connectorToken(JULIO.subject);
    const response = await t.fetch(`/mcp?access_token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("a token issued to another client, or for another person, never reaches an approved connector's agent", async () => {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    await signIn(t, "Pepe");
    await initialize(t, await connectorToken(JULIO.subject, CLAUDE));
    const [pending] = await admin.as.query(api.connectors.list, {});
    await admin.as.mutation(api.connectors.approve, { teamId, connectorId: pending!.connectorId, name: "Claude" });

    // Julio's token from another client is its own connection, waiting for approval.
    const other = await callTool(t, await connectorToken(JULIO.subject, GROK), "members_me");
    expect(other.text).toContain("waiting for approval");
    // Pepe's token from the same client is Pepe's connection, not Julio's.
    const pepes = await callTool(t, await connectorToken("user_Pepe", CLAUDE), "members_me");
    expect(pepes.text).toContain("waiting for approval");
    expect(await admin.as.query(api.connectors.list, {})).toHaveLength(2);
  });
});

describe("Clerk's keys (JWKS): fetched rarely, whatever callers send", () => {
  /** A token naming this deployment's Clerk issuer and a `kid` Clerk never published, signed by nobody. */
  function forgedWithKid(kid: string) {
    return clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, {}, { forged: true, header: { kid } });
  }

  test("forged tokens with made-up key IDs fetch the keys once, one after another or all at once", async () => {
    const t = newRoom();
    for (let i = 0; i < 5; i++) {
      const answer = await rpc(t, await forgedWithKid(`ins_forged_${i}`), "tools/list");
      expect(answer.status).toBe(401);
    }
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => forgedWithKid(`ins_burst_${i}`)));
    const answers = await Promise.all(tokens.map((token) => rpc(t, token, "tools/list")));
    expect(answers.map((a) => a.status)).toEqual(tokens.map(() => 401));
    expect(clerk.keyFetches).toBe(1);
  });

  test("a token with the wrong typ, issuer or algorithm, or no JWT at all, is refused before any fetch", async () => {
    const t = newRoom();
    await rpc(t, await clerk.idToken({ subject: JULIO.subject, name: "Julio", email: "julio@example.com" }), "tools/list");
    await rpc(t, await connectorToken(JULIO.subject, CLAUDE, { iss: "https://evil.example" }), "tools/list");
    await rpc(t, await clerk.accessToken(JULIO, { clientId: CLAUDE, resource: RESOURCE }, {}, { header: { alg: "HS256" } }), "tools/list");
    await rpc(t, "not-a-jwt", "tools/list");
    await rpc(t, "a.b.c", "tools/list");
    expect(clerk.keyFetches).toBe(0);
  });

  test("callers that arrive together before the keys are known share one fetch", async () => {
    const t = newRoom();
    const tokens = await Promise.all(["user_A", "user_B", "user_C", "user_D"].map((subject) => connectorToken(subject)));
    const answers = await Promise.all(tokens.map((token) => rpc(t, token, "tools/list")));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(clerk.keyFetches).toBe(1);
  });

  test("a rotated key is fetched once the refetch interval has passed, and the keys again after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = newRoom();
    expect((await rpc(t, await connectorToken(JULIO.subject), "tools/list")).status).toBe(200);
    await clerk.rotate();
    const rotated = await connectorToken("user_Rotated");
    // Just after a fetch, an unknown key ID doesn't fetch again.
    expect((await rpc(t, rotated, "tools/list")).status).toBe(401);
    expect(clerk.keyFetches).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);
    expect((await rpc(t, await connectorToken("user_Rotated2"), "tools/list")).status).toBe(200);
    expect(clerk.keyFetches).toBe(2);
    // Known keys come from the cache until it is five minutes old (Clerk's own JWKS cache TTL).
    expect((await rpc(t, await connectorToken("user_Again"), "tools/list")).status).toBe(200);
    expect(clerk.keyFetches).toBe(2);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await rpc(t, await connectorToken("user_Later"), "tools/list")).status).toBe(200);
    expect(clerk.keyFetches).toBe(3);
  });

  test("a JWKS fetch that never answers is given up after five seconds, and the callers waiting on it share it", async () => {
    const t = newRoom();
    clerk.stallKeys(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tokens = await Promise.all(["user_A", "user_B", "user_C"].map((subject) => connectorToken(subject)));
    const pending = Promise.all(tokens.map((token) => rpc(t, token, "tools/list")));
    await vi.waitFor(() => expect(clerk.keyFetches).toBe(1));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(clerk.keyFetches).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    const answers = await pending;
    expect(answers.map((a) => a.status)).toEqual([401, 401, 401]);
    expect(answers[0]!.headers.get("www-authenticate")).toMatch(/couldn't reach/);
    expect(clerk.keyFetches).toBe(1);
  });

  test("the command line's sign-in and the connector share the keys", async () => {
    const t = newRoom();
    await newTeam(t);
    await signInFromCli(t, clerk, { subject: JULIO.subject, name: "Julio", email: "julio@example.com" });
    expect((await rpc(t, await connectorToken(JULIO.subject), "tools/list")).status).toBe(200);
    expect(clerk.keyFetches).toBe(1);
  });
});

describe("an agent that checks in on its own schedule (slice 14 of #139)", () => {
  /** Claude Duet joined through the connector and approved: it has no A2A endpoint and no webhook. */
  async function duetTeam() {
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const token = await connectorToken(JULIO.subject);
    await initialize(t, token, "Claude");
    const [pending] = await admin.as.query(api.connectors.list, {});
    const { memberId, agentId } = await admin.as.mutation(api.connectors.approve, { teamId, connectorId: pending!.connectorId, name: "Claude Duet" });
    const channelId = await generalChannel(admin.as, teamId);
    return { t, teamId, admin, token, memberId, agentId, channelId };
  }

  test("the roster and member list mark it, and a message to it waits until it reads the place, then shows seen", async () => {
    const { t, teamId, admin, token, memberId, channelId } = await duetTeam();
    const members = await admin.as.query(api.teams.members, { teamId });
    expect(members.find((m) => m.memberId === memberId)!.reach).toBe("checks_in");
    const roster = await admin.as.query(api.teams.roster, { teamId });
    expect(roster.find((r) => r.kind === "agent" && r.memberId === memberId)).toMatchObject({ reach: "checks_in" });

    const ask = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${memberId}> book the offsite` });
    const before = await admin.as.query(api.messages.get, { teamId, messageId: ask });
    expect(before!.deliveries).toEqual([expect.objectContaining({ via: "check_in", status: "waiting", to: expect.objectContaining({ name: "Claude Duet" }) })]);

    // Reading another place leaves it waiting.
    const direct = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [memberId] })).channelId;
    expect((await callTool(t, token, "messages_list", { channelId: direct })).isError).toBe(false);
    expect((await admin.as.query(api.messages.get, { teamId, messageId: ask }))!.deliveries[0]!.status).toBe("waiting");

    expect((await callTool(t, token, "messages_list", { channelId })).isError).toBe(false);
    const after = await admin.as.query(api.messages.get, { teamId, messageId: ask });
    expect(after!.deliveries).toEqual([expect.objectContaining({ status: "seen" })]);
  });

  test("a reply in a thread is seen once it reads that thread, or answers in it", async () => {
    const { t, teamId, admin, token, memberId, channelId } = await duetTeam();
    const root = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "plans" });
    const first = await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: root, body: `<@${memberId}> which hotel?` });
    await callTool(t, token, "messages_list", { channelId });
    expect((await admin.as.query(api.messages.get, { teamId, messageId: first }))!.deliveries[0]!.status).toBe("waiting");
    await callTool(t, token, "messages_replies", { messageId: root });
    expect((await admin.as.query(api.messages.get, { teamId, messageId: first }))!.deliveries[0]!.status).toBe("seen");

    const second = await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: root, body: `<@${memberId}> and dinner?` });
    expect((await callTool(t, token, "messages_post", { channelId, replyTo: root, body: "On it." })).isError).toBe(false);
    expect((await admin.as.query(api.messages.get, { teamId, messageId: second }))!.deliveries[0]!.status).toBe("seen");
  });

  /** The status of the delivery to the agent on each message. */
  async function statuses(admin: Awaited<ReturnType<typeof duetTeam>>["admin"], teamId: Id<"teams">, ids: Id<"messages">[]) {
    return Promise.all(ids.map(async (messageId) => (await admin.as.query(api.messages.get, { teamId, messageId }))!.deliveries[0]!.status));
  }

  test("reading one page marks only the messages on it", async () => {
    const { t, teamId, admin, token, memberId, channelId } = await duetTeam();
    const older = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${memberId}> first` });
    const newer = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${memberId}> second` });
    const page = await callTool(t, token, "messages_list", { channelId, cursor: null, limit: 1 });
    expect(page.json().page.map((m: { messageId: string }) => m.messageId)).toEqual([newer]);
    expect(await statuses(admin, teamId, [older, newer])).toEqual(["waiting", "seen"]);
  });

  test("reading what is addressed to it marks only what it returned, not other places", async () => {
    const { t, teamId, admin, token, memberId, channelId } = await duetTeam();
    const inGeneral = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${memberId}> in general` });
    const direct = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [memberId] })).channelId;
    const inDirect = await admin.as.mutation(api.messages.post, { teamId, channelId: direct, body: "in a direct message" });
    const read = await callTool(t, token, "messages_addressed", { limit: 1 });
    expect(read.json().map((m: { messageId: string }) => m.messageId)).toEqual([inDirect]);
    expect(await statuses(admin, teamId, [inGeneral, inDirect])).toEqual(["waiting", "seen"]);
  });

  test("reading a thread by one reply's id marks every reply it returned", async () => {
    const { t, teamId, admin, token, memberId, channelId } = await duetTeam();
    const root = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "plans" });
    const first = await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: root, body: `<@${memberId}> which hotel?` });
    const second = await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: root, body: `<@${memberId}> and dinner?` });
    expect((await callTool(t, token, "messages_replies", { messageId: second })).isError).toBe(false);
    expect(await statuses(admin, teamId, [first, second])).toEqual(["seen", "seen"]);
  });

  test("many waiting replies in one thread don't keep a reply in another thread waiting when it answers there", async () => {
    const { t, teamId, admin, token, memberId, channelId } = await duetTeam();
    const busy = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "busy thread" });
    for (let i = 0; i < 100; i++) {
      await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: busy, body: `<@${memberId}> ping ${i}` });
    }
    const quiet = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "quiet thread" });
    const ask = await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: quiet, body: `<@${memberId}> one question` });
    expect((await callTool(t, token, "messages_post", { channelId, replyTo: quiet, body: "Answered." })).isError).toBe(false);
    expect(await statuses(admin, teamId, [ask])).toEqual(["seen"]);
  });

  test("a run it drives posting in a place leaves what waits for the agent there unseen", async () => {
    const { t, teamId, admin, memberId, channelId } = await duetTeam();
    const ask = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${memberId}> book the offsite` });
    const { machineId, token: bridgeToken } = await linkMachine(t, teamId, admin, "julio-mbp", { team: true });
    const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId, access: "drive" });
    const terminalId = (await t.run(async (ctx) => ctx.db.get(runId as Id<"runs">)))!.terminalId!;
    await bridgeSays(t, bridgeToken, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude", access: "drive" });
    // Julio hands the wheel to Claude Duet; the run it now drives posts in #general.
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("runs").collect()).find((r) => r._id === runId)!;
      await ctx.db.patch(run._id, { driverId: memberId });
      await ctx.db.patch(terminalId, { driverId: memberId });
    });
    await t.mutation(api.bridge.runSay, { token: bridgeToken, terminalRef: terminalId, in: "#general", text: "Build is green." });
    expect(await statuses(admin, teamId, [ask])).toEqual(["waiting"]);
  });

  test("a run it drives that mentions it leaves the message waiting for it", async () => {
    const { t, teamId, admin, memberId } = await duetTeam();
    const { machineId, token: bridgeToken } = await linkMachine(t, teamId, admin, "julio-mbp", { team: true });
    const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId, access: "drive" });
    const terminalId = (await t.run(async (ctx) => ctx.db.get(runId as Id<"runs">)))!.terminalId!;
    await bridgeSays(t, bridgeToken, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude", access: "drive" });
    await t.run(async (ctx) => {
      await ctx.db.patch(runId as Id<"runs">, { driverId: memberId });
      await ctx.db.patch(terminalId, { driverId: memberId });
    });
    // Stored under Claude Duet (ADR 0029 D2), but Claude Duet didn't write it.
    const { messageId } = await t.mutation(api.bridge.runSay, { token: bridgeToken, terminalRef: terminalId, in: "#general", text: `<@${memberId}> the build is green` });
    expect(await statuses(admin, teamId, [messageId as Id<"messages">])).toEqual(["waiting"]);
  });

  test("with a routine webhook it is reached there instead", async () => {
    const { teamId, admin, agentId, memberId } = await duetTeam();
    await admin.as.mutation(api.webhooks.set, { teamId, agentId, url: "https://hooks.example.com/routine/1", key: "grk_test_key_123456789" });
    const members = await admin.as.query(api.teams.members, { teamId });
    expect(members.find((m) => m.memberId === memberId)!.reach).toBe("webhook");
    expect(await admin.as.query(api.webhooks.get, { teamId, agentId })).toMatchObject({ url: "https://hooks.example.com/routine/1", hint: "…6789" });
  });
});
