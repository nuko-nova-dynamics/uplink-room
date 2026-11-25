import { api } from "@uplink-room/backend/api";
import { convexTest } from "convex-test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import schema from "../../backend/convex/schema";
import { CLIENT_ID, fakeClerk, type ClerkUser, type FakeClerk } from "../../backend/tests/fakeClerk";

/**
 * A new folder in the temp directory, removed when the test that made it finishes, so test runs
 * don't fill the CI runners' temp folders (#65).
 */
export async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// The backend's own modules, so convex-test runs the real functions and the real HTTP router.
const modules = import.meta.glob([
  "../../backend/convex/**/*.ts",
  "../../backend/convex/**/*.js",
  "!../../backend/convex/**/*.d.ts",
]);

export const SITE_URL = "https://room.test";

export type Backend = ReturnType<typeof newBackend>;

export function newBackend() {
  return convexTest(schema, modules);
}

/**
 * A `fetch` that sends every request to the backend's HTTP router. A POST to an upload URL
 * (Convex file storage) stores the bytes the way that endpoint does and answers { storageId }.
 */
export function fetchTo(t: Backend): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/storage/upload")) {
      const blob = new Blob([await request.arrayBuffer()], { type: request.headers.get("content-type") ?? "" });
      const storageId = await t.run(async (ctx) => ctx.storage.store(blob));
      return new Response(JSON.stringify({ storageId }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return t.fetch(url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" ? {} : { body: await request.text() }),
    });
  };
}

/** A team with an admin, an agent that admin added, and the agent's key. */
export async function newTeamWithAgent(t: Backend, scopes?: string[]) {
  const admin = t.withIdentity({
    subject: "user_julio",
    name: "Julio",
    email: "julio@example.com",
  });
  await admin.mutation(api.people.ensure, {});
  const teamId = await admin.mutation(api.teams.create, { name: "Nuko Nova" });
  const agentId = await admin.mutation(api.agents.add, {
    teamId,
    name: "Deploy bot",
    connection: "http",
  });
  const { secret } = await admin.mutation(api.agents.createKey, {
    teamId,
    agentId,
    name: "test",
    ...(scopes ? { scopes } : {}),
  });
  const [general] = await admin.query(api.channels.list, { teamId });
  return { admin, teamId, key: secret, generalId: general!.channelId };
}

/** messages.list called without a cursor: the older list form, oldest first. */
export function listed<T>(result: T[] | { page: T[] }): T[] {
  if (!Array.isArray(result)) throw new Error("messages.list without a cursor should return a list");
  return result;
}

/** Links a machine to the team as the admin's, with a bridge that has registered. Returns its bridge token. */
export async function linkMachine(t: Backend, admin: Awaited<ReturnType<typeof newTeamWithAgent>>["admin"], teamId: string) {
  const { code } = await admin.mutation(api.machines.createPairingCode, { teamId: teamId as never, name: "macbook" });
  const { token, machineId } = await t.mutation(api.bridge.pair, { code, hostname: "macbook.local", os: "darwin" });
  const limits = { mostOpenAccess: "open", slots: 2, longestProfileMs: 86_400_000 } as const;
  await bridgeSays(t, token, { type: "register_machine", hostname: "macbook.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits });
  return { token, machineId: machineId as string };
}

/** The bridge reports messages to the room, as `uplink-bridge run` does. */
export async function bridgeSays(t: Backend, token: string, ...messages: Record<string, unknown>[]) {
  await t.mutation(api.bridge.send, { token, messages: messages.map((m) => ({ v: 1, ...m })) as never });
}

/** The real `fetch`, for a fake browser following a redirect to the command line's loopback address. */
const realFetch = globalThis.fetch;

/**
 * A fake Clerk that the room trusts (CLERK_JWT_ISSUER_DOMAIN, CLERK_CLI_CLIENT_ID) and reaches for its
 * keys (a stubbed global `fetch`), as a deployment set up for `uplink login` is (ADR 0030).
 */
export async function useFakeClerk(): Promise<FakeClerk> {
  const clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  return clerk;
}

/** A `fetch` for the command line: the room's router at SITE_URL, and the fake Clerk at its issuer. */
export function fetchToRoomAndClerk(t: Backend, clerk: FakeClerk): typeof fetch {
  const room = fetchTo(t);
  return async (input, init) => {
    const url = new URL(new Request(input, init).url);
    return url.origin === new URL(clerk.issuer).origin ? clerk.fetch(input, init) : room(input, init);
  };
}

/**
 * The person's browser: `user` signs in to Clerk at the authorize URL and approves (or denies), and
 * the browser follows Clerk's redirect to the command line's loopback address (RFC 8252).
 */
export function browserFor(clerk: FakeClerk, user: ClerkUser, decision: "approve" | "deny" = "approve") {
  const opened: string[] = [];
  const open = async (url: string) => {
    opened.push(url);
    const redirect = await clerk.authorize(url, user, decision);
    await realFetch(redirect);
  };
  return { open, opened };
}

/**
 * Julio, signed in from the command line (`uplink login`) and in two teams: Nuko Nova, and Side
 * project, where a machine is linked. With two teams, a team function needs `teamId` (ADR 0030).
 */
export async function personInTwoTeams(t: Backend) {
  const { admin, teamId, generalId } = await newTeamWithAgent(t);
  const sideTeamId = await admin.mutation(api.teams.create, { name: "Side project" });
  const [sideGeneral] = await admin.query(api.channels.list, { teamId: sideTeamId });
  const { token: bridgeToken, machineId } = await linkMachine(t, admin, sideTeamId);
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-two-teams-");
  const { main } = await import("../src/cli.ts");
  const { readSavedConfig } = await import("../src/config.ts");
  await main(["login", "--url", SITE_URL], {
    fetch: fetchToRoomAndClerk(t, clerk),
    stdout: () => {},
    stderr: () => {},
    env: { UPLINK_HOME: home },
    openBrowser: browserFor(clerk, { subject: "user_julio", name: "Julio", email: "julio@example.com" }).open,
  });
  const { signIn } = await readSavedConfig({ UPLINK_HOME: home });
  if (!signIn) throw new Error("uplink login saved no sign-in");
  return { admin, teamId, generalId, sideTeamId: sideTeamId as string, sideGeneralId: sideGeneral!.channelId as string, bridgeToken, machineId, signIn, home, clerk };
}
