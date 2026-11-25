/**
 * Refusals answered, not thrown (ADR 0046, lib/refusals.ts): a refusal the room makes by design is
 * a returned value to callers that take one, so Convex doesn't report it to Sentry as an uncaught
 * exception. Real errors still throw, and callers that don't ask still get the thrown error.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../convex/_generated/api";
import { sha256 } from "../convex/lib/crypto";
import { roomError } from "../convex/lib/errors";
import { ACCEPTS_REFUSALS, answerMutation, answerQuery } from "../convex/lib/refusals";
import { CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { callAsAgent, modules, newRoom, newTeam, signIn, signInFromCli } from "./setup";

/** The flag the app, the bridge and room-client send. It isn't in the functions' declared types. */
const accepts = { [ACCEPTS_REFUSALS]: true } as const;

let clerk: FakeClerk;

beforeEach(async () => {
  clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("a refusal code is answered; not_configured, other ConvexErrors and plain errors still throw", async () => {
  await expect(answerQuery(async () => Promise.reject(roomError("forbidden", "No.")))).resolves.toEqual({
    refused: { code: "forbidden", message: "No." },
    thrown: true,
  });
  await expect(answerQuery(async () => Promise.reject(roomError("not_configured", "Set it.")))).rejects.toThrow(ConvexError);
  await expect(answerQuery(async () => Promise.reject(new ConvexError("a bare string")))).rejects.toThrow(ConvexError);
  await expect(answerQuery(async () => Promise.reject(new TypeError("a bug")))).rejects.toThrow(TypeError);
});

test("a mutation answers a refusal it throws before writing, and throws one after a write so the write rolls back", async () => {
  const t = newRoom();
  const before = await t.run(async (ctx) => answerMutation(ctx, async () => Promise.reject(roomError("not_found", "Gone."))));
  expect(before).toEqual({ refused: { code: "not_found", message: "Gone." }, thrown: true });

  await expect(
    t.run(async (ctx) =>
      answerMutation(ctx, async () => {
        await ctx.db.insert("teams", { name: "Half made", createdAt: Date.now() });
        throw roomError("conflict", "Changed meanwhile.");
      }),
    ),
  ).rejects.toThrow(/Changed meanwhile/);
  expect(await t.run(async (ctx) => (await ctx.db.query("teams").collect()).map((team) => team.name))).toEqual([]);
});

test("a person's query and mutation answer a refusal only when the caller sends acceptsRefusals", async () => {
  const t = newRoom();
  const { teamId } = await newTeam(t);
  const outsider = await signIn(t, "Ana");

  await expect(outsider.as.query(api.channels.list, { teamId })).rejects.toThrow(/not a member/);
  expect(await outsider.as.query(api.channels.list, { teamId, ...accepts } as never)).toEqual({
    refused: { code: "forbidden", message: "You are not a member of this team." },
    thrown: true,
  });
  expect(await outsider.as.mutation(api.projects.create, { teamId, name: "Theirs", ...accepts } as never)).toMatchObject({
    refused: { code: "forbidden" },
    thrown: true,
  });
});

test("an invite that isn't valid is answered to the app that asks (UPLINK-ROOM-BACKEND-5's path)", async () => {
  const t = newRoom();
  const ana = await signIn(t, "Ana");
  await expect(ana.as.mutation(api.invites.accept, { token: "not-a-token" })).rejects.toThrow(/isn't valid/);
  expect(await ana.as.mutation(api.invites.accept, { token: "not-a-token", ...accepts } as never)).toMatchObject({
    refused: { code: "invalid" },
    thrown: true,
  });
});

test("a refusal returned on purpose (a wrong pair code, which pairs.join counts) stays a value with no thrown mark", async () => {
  const t = newRoom();
  const ana = await signIn(t, "Ana");
  const wrong = { refused: { code: "not_found", message: expect.stringMatching(/pair code is wrong/) } };
  // As before, without the flag; and the same with it, so the app shows its own message for it.
  const plain = await ana.as.mutation(api.pairs.join, { code: "RIVER-0000-MAPLE-0000" });
  const flagged = await ana.as.mutation(api.pairs.join, { code: "RIVER-0000-MAPLE-0000", ...accepts } as never);
  expect(plain).toEqual(wrong);
  expect(flagged).toEqual(wrong);
  expect(flagged).not.toHaveProperty("thrown");
});

test("live:query answers an ended run's token to a watcher that asks, and throws it to one that doesn't (UPLINK-ROOM-BACKEND-8)", async () => {
  const t = newRoom();
  const { teamId } = await newTeam(t);
  const cli = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
  const joined = await callAsAgent(t, cli, "joined.start", { teamId, harness: "claude-code", sessionRef: "s1", hearing: "mid_task" });
  const { token } = joined.result;
  expect(await callAsAgent(t, token, "joined.leave")).toMatchObject({ status: 200 });

  const watch = { key: token, fn: "joined.waiting", args: {} };
  await expect(t.query(api.live.query, watch)).rejects.toThrow(/ended/);
  expect(await t.query(api.live.query, { ...watch, ...accepts } as never)).toMatchObject({
    refused: { code: "unauthenticated", message: expect.stringMatching(/ended/) },
    thrown: true,
  });
});

test("an internal Room API mutation answers its refusal, so the HTTP endpoint's call isn't an exception (UPLINK-ROOM-BACKEND-7)", async () => {
  const t = newRoom();
  const { teamId } = await newTeam(t);
  const cli = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
  const { token } = (await callAsAgent(t, cli, "joined.start", { teamId, harness: "claude-code", sessionRef: "s1", hearing: "mid_task" })).result;

  expect(await t.mutation(internal.joined.pairResumeByRun, { runTokenHash: await sha256(token) })).toEqual({
    refused: { code: "not_found", message: "You're in no live Pair this run could rejoin. uplink pair makes a code for a new one." },
    thrown: true,
  });
  // Over HTTP it is the same 404 as before.
  expect(await callAsAgent(t, token, "joined.pairResume", {})).toMatchObject({ status: 404, error: { code: "not_found" } });
});

test("every public function takes acceptsRefusals, so a client that sends it on every call never fails validation", async () => {
  const missing: string[] = [];
  let checked = 0;
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes("/_generated/")) continue;
    const module = (await load()) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(module)) {
      const registered = fn as { isPublic?: boolean; isQuery?: boolean; isMutation?: boolean; isAction?: boolean; exportArgs?: () => string };
      if (!registered?.isPublic || !(registered.isQuery || registered.isMutation || registered.isAction)) continue;
      checked++;
      const args = JSON.parse(registered.exportArgs!()) as { type: string; value?: Record<string, unknown> };
      if (args.type !== "object" || !args.value || !(ACCEPTS_REFUSALS in args.value)) missing.push(`${path}:${name}`);
    }
  }
  // The person functions of every Room API module, plus the hand-written ones (people.ensure, live.query...).
  expect(checked).toBeGreaterThan(100);
  expect(missing).toEqual([]);
});
