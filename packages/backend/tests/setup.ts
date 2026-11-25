/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import type { ClerkUser, FakeClerk } from "./fakeClerk";

export const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

export function newRoom() {
  return convexTest(schema, modules);
}

/** A room that enforces Convex's per-function limits (4,096 index ranges, 32,000 documents read). */
export function newLimitedRoom() {
  return convexTest({ schema, modules, transactionLimits: true });
}

export type Room = ReturnType<typeof newRoom>;

/** Signs a person in and records them, as the app does after Clerk sign-in, with a verified email. */
export async function signIn(t: Room, name: string, email = `${name.toLowerCase()}@example.com`, emailVerified = true) {
  const as = t.withIdentity({ subject: `user_${name}`, name, email, emailVerified });
  const personId = await as.mutation(api.people.ensure, {});
  return { as, personId, name };
}

export type Person = Awaited<ReturnType<typeof signIn>>;

/** A team with an admin. */
export async function newTeam(t: Room, adminName = "Julio") {
  const admin = await signIn(t, adminName);
  const teamId: Id<"teams"> = await admin.as.mutation(api.teams.create, { name: "Nuko Nova" });
  return { teamId, admin };
}

/** Calls the Room API over HTTP with an agent key, as the MCP server and CLI do. */
export async function callAsAgent(
  t: Room,
  key: string,
  fn: string,
  args: Record<string, unknown> = {},
) {
  const response = await t.fetch("/api/v1/call", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  const body = (await response.json()) as
    | { ok: true; result: unknown }
    | { ok: false; error: { code: string; message: string } };
  return { status: response.status, ...body } as { status: number; ok: boolean; result?: any; error?: { code: string; message: string } };
}

/**
 * Signs `user` in from the command line, as `uplink login` does (ADR 0030), against a fake Clerk
 * that the stubbed `fetch` reaches and that CLERK_JWT_ISSUER_DOMAIN and CLERK_CLI_CLIENT_ID name.
 * Returns the CLI sign-in's token.
 */
export async function signInFromCli(t: Room, clerk: FakeClerk, user: ClerkUser, name = "laptop"): Promise<string> {
  const post = async (path: string, body: unknown) =>
    (await (
      await t.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    ).json()) as { ok: boolean; result: any; error?: { message: string } };
  const start = await post("/api/v1/cli-sign-in", {});
  if (!start.ok) throw new Error(`cli-sign-in: ${start.error?.message}`);
  const done = await post("/api/v1/cli-sign-in/token", { idToken: await clerk.idToken(user, { nonce: start.result.nonce }), name });
  if (!done.ok) throw new Error(`cli-sign-in/token: ${done.error?.message}`);
  return done.result.token;
}

/** Adds an agent for `person` and creates a key with these scopes. */
export async function addAgent(
  t: Room,
  teamId: Id<"teams">,
  person: Person,
  name: string,
  scopes?: string[],
) {
  const agentId = await person.as.mutation(api.agents.add, { teamId, name, connection: "http" });
  const { secret } = await person.as.mutation(api.agents.createKey, {
    teamId,
    agentId,
    name: "test",
    ...(scopes ? { scopes } : {}),
  });
  return { agentId, key: secret };
}

export const DAY = 24 * 60 * 60 * 1000;

/** The machine's own limits, as a bridge reports them. */
export const LIMITS = { mostOpenAccess: "open", slots: 2, longestProfileMs: 30 * DAY } as const;

/** Pairs a bridge for `person` (a personal machine, unless `team` is set) and registers it. */
export async function linkMachine(
  t: Room,
  teamId: Id<"teams">,
  person: Person,
  name: string,
  opts: { team?: boolean; limits?: { mostOpenAccess: "watch" | "suggest" | "drive" | "open"; slots: number; longestProfileMs: number } } = {},
) {
  const { code } = await person.as.mutation(api.machines.createPairingCode, {
    teamId,
    name,
    ...(opts.team ? { belongsToTeam: true } : {}),
  });
  const { token, machineId } = await t.mutation(api.bridge.pair, { code, hostname: `${name}.local`, os: "darwin" });
  await t.mutation(api.bridge.send, {
    token,
    messages: [
      { v: 1, type: "register_machine", hostname: `${name}.local`, os: "darwin", bridgeVersion: "0.1.0", tools: ["tmux", "claude-code"], limits: opts.limits ?? LIMITS },
    ],
  });
  return { machineId: machineId as Id<"machines">, token };
}

/** What the room has sent this bridge so far. */
export async function bridgeInbox(t: Room, token: string, afterSeq = 0) {
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq });
  return messages.map((m) => m.message);
}

/** Invites a person and has them join the team. */
export async function addTeammate(t: Room, teamId: Id<"teams">, admin: Person, name: string) {
  const { token } = await admin.as.mutation(api.invites.create, { teamId, email: `${name.toLowerCase()}@example.com` });
  const person = await signIn(t, name);
  await person.as.mutation(api.invites.accept, { token });
  const members = await admin.as.query(api.teams.members, { teamId });
  const memberId = members.find((m) => m.name === name)!.memberId;
  return { ...person, memberId };
}

/** A bridge reports a message to the room. */
export async function bridgeSays(t: Room, token: string, ...messages: any[]) {
  await t.mutation(api.bridge.send, { token, messages: messages.map((m) => ({ v: 1, ...m })) });
}

/**
 * Asks for an upload URL as `person`, then stores bytes the way the POST to that URL would.
 * Returns what files.addUpload needs.
 */
export async function upload(
  t: Room,
  person: { as: Person["as"] },
  teamId: Id<"teams">,
  bytes: number | string,
  type: string,
) {
  const { uploadId } = await person.as.mutation(api.files.uploadUrl, { teamId });
  const body = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([body], { type })));
  return { uploadId, storageId };
}

/** messages.list called without a cursor: the older list form, oldest first. */
export function listed<T>(result: T[] | { page: T[] }): T[] {
  if (!Array.isArray(result)) throw new Error("messages.list without a cursor should return a list");
  return result;
}

/** A value the test knows is there (messages.get and messages.around return null for a message you can't see). */
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** Runs scheduled functions (with real timers) until none is pending, such as a message's fan-out. */
export async function settleScheduled(t: Room) {
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.state.kind === "pending" || f.state.kind === "inProgress",
      ),
    );
    if (pending.length === 0) return;
  }
  throw new Error("scheduled functions still pending");
}
