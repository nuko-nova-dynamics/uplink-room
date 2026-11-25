/**
 * Every HTTP route that reads a body from outside reads it as a stream with a byte cap and a
 * deadline (lib/requestBody.ts): Convex puts no limit on a request's size and gives an HTTP
 * action 64 MiB of memory ("HTTP Actions", Limits), so a body read whole could exhaust it. These
 * tests send bodies as streams and watch how much of each the route pulled.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CLIENT_ID as CLI_CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { newRoom, type Room } from "./setup";

const SITE = "https://some.convex.site";
const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;

let clerk: FakeClerk;

beforeEach(async () => {
  clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLI_CLIENT_ID);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("LIVEKIT_URL", "ws://127.0.0.1:7880");
  vi.stubEnv("LIVEKIT_API_KEY", "devkey");
  vi.stubEnv("LIVEKIT_API_SECRET", "secret-secret-secret-secret-secret");
  vi.stubEnv("GITHUB_APP_ID", "1");
  vi.stubEnv("GITHUB_APP_SLUG", "uplink-room-test");
  vi.stubEnv("GITHUB_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "unused");
  vi.stubGlobal("fetch", clerk.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A body of spaces sent in 64 KiB chunks: `total` bytes, endless with no total, or one chunk and then nothing ("stall"). */
function streamed(total: number | "endless" | "stall") {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (total === "stall" && state.pulled > 0) return new Promise<void>(() => {});
      if (typeof total === "number" && state.pulled >= total) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      state.pulled += CHUNK;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

async function connectorToken() {
  return clerk.accessToken({ subject: "user_Julio" }, { clientId: "https://claude.ai/oauth/mcp-client-metadata", resource: `${SITE}/mcp` });
}

/** The routes that read a body, each with the cap it allows and the headers that get it past its own checks first. */
async function routes(): Promise<{ path: string; cap: number; headers: Record<string, string> }[]> {
  return [
    {
      path: "/mcp",
      cap: MiB,
      headers: { authorization: `Bearer ${await connectorToken()}`, accept: "application/json, text/event-stream" },
    },
    { path: "/api/v1/call", cap: 16 * MiB, headers: { authorization: "Bearer urk_some_agent_key" } },
    { path: "/api/v1/cli-sign-in/token", cap: 64 * 1024, headers: {} },
    { path: "/hyperbeam/auth", cap: 64 * 1024, headers: { authorization: "Bearer browser-secret" } },
    { path: "/hyperbeam/timeout", cap: 64 * 1024, headers: { authorization: "Bearer browser-secret" } },
    { path: "/livekit/webhook", cap: MiB, headers: { authorization: "unsigned" } },
    { path: "/github/webhook", cap: 25 * MiB, headers: { "x-hub-signature-256": "sha256=00", "x-github-delivery": "1" } },
  ];
}

function post(t: Room, path: string, body: ReadableStream<Uint8Array> | string, headers: Record<string, string>) {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    ...(typeof body === "string" ? {} : { duplex: "half" }),
  } as RequestInit);
}

describe("request bodies", () => {
  test("a body larger than the route's cap gets 413, and the route stops reading it just past the cap", async () => {
    const t = newRoom();
    for (const route of await routes()) {
      const { body, state } = streamed(route.cap + 4 * CHUNK);
      const response = await post(t, route.path, body, route.headers);
      expect({ path: route.path, status: response.status }).toEqual({ path: route.path, status: 413 });
      expect(state.pulled, route.path).toBeLessThanOrEqual(route.cap + 2 * CHUNK);
      expect(state.cancelled, route.path).toBe(true);
    }
  });

  test("a body that never ends gets 413 once it passes the cap", async () => {
    const t = newRoom();
    const route = (await routes())[0]!;
    const { body, state } = streamed("endless");
    const response = await post(t, route.path, body, route.headers);
    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
  });

  test("a declared Content-Length over the cap gets 413 before any of the body is read", async () => {
    const t = newRoom();
    for (const route of await routes()) {
      const { body, state } = streamed("stall");
      const response = await post(t, route.path, body, { ...route.headers, "content-length": String(route.cap + 1) });
      expect({ path: route.path, status: response.status }).toEqual({ path: route.path, status: 413 });
      expect(state.pulled, route.path).toBeLessThanOrEqual(CHUNK);
    }
  });

  test("a body that stops arriving is given up after ten seconds with 408", async () => {
    const t = newRoom();
    const route = (await routes())[0]!;
    // The token is checked first, with real timers; the body is read after it.
    expect((await post(t, route.path, "{}", route.headers)).status).not.toBe(401);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { body, state } = streamed("stall");
    const pending = post(t, route.path, body, route.headers);
    await vi.waitFor(() => expect(state.pulled).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(state.cancelled).toBe(true);
  });

  test("a body under the cap still arrives whole", async () => {
    const t = newRoom();
    const text = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Claude", version: "1" }, pad: " ".repeat(900 * 1024) } });
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += CHUNK) controller.enqueue(bytes.slice(at, at + CHUNK));
        controller.close();
      },
    });
    const route = (await routes())[0]!;
    const response = await post(t, route.path, body, route.headers);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("uplink-room");
  });
});
