import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, callAsAgent, newLimitedRoom, newRoom, newTeam, signIn, signInFromCli, type Room } from "./setup";

const PEPE = { subject: "user_pepe", name: "Pepe", email: "pepe@example.com", picture: "https://img.example.com/pepe.png" };
const DAY = 86_400_000;
/** The person `newTeam` signs in, as Clerk would sign them in on the command line. */
const JULIO = { subject: "user_Julio", name: "Julio", email: "julio@example.com" };

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
  vi.useRealTimers();
});

async function post(t: Room, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...((await response.json()) as { ok: boolean; result?: any; error?: { code: string; message: string } }) };
}

test("a person signs in from the command line, and the room knows them with no team", async () => {
  const t = newRoom();

  const start = await post(t, "/api/v1/cli-sign-in", {});
  expect(start).toMatchObject({
    status: 200,
    ok: true,
    result: { issuer: clerk.issuer, clientId: CLIENT_ID, scopes: "openid profile email", nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
  });

  const idToken = await clerk.idToken(PEPE, { nonce: start.result.nonce });
  const before = Date.now();
  const signedIn = await post(t, "/api/v1/cli-sign-in/token", { idToken, name: "Pepe's laptop" });
  expect(signedIn).toMatchObject({
    status: 200,
    ok: true,
    result: { token: expect.stringMatching(/^urs_[0-9a-f]{48}$/), person: { name: "Pepe", email: "pepe@example.com" } },
  });
  const { token, signInId, expiresAt } = signedIn.result;
  expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY);

  const me = await callAsAgent(t, token, "people.me");
  expect(me).toMatchObject({ status: 200, ok: true });
  expect(me.result).toEqual({
    personId: expect.any(String),
    name: "Pepe",
    email: "pepe@example.com",
    avatarUrl: PEPE.picture,
    teams: [],
    signIn: { signInId, name: "Pepe's laptop", expiresAt },
  });
});

async function nonce(t: Room): Promise<string> {
  return (await post(t, "/api/v1/cli-sign-in", {})).result.nonce;
}

test("the room refuses an ID token that isn't Clerk's, for this command line, from a sign-in it started", async () => {
  const t = newRoom();
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, () => Promise<string>, RegExp][] = [
    ["signed with a key Clerk doesn't publish", async () => clerk.idToken(PEPE, { nonce: await nonce(t) }, { forged: true }), /signature/],
    ["for another application", async () => clerk.idToken(PEPE, { nonce: await nonce(t), aud: "some_other_app" }), /another application/],
    ["from another issuer", async () => clerk.idToken(PEPE, { nonce: await nonce(t), iss: "https://evil.test" }), /issued by/],
    ["expired", async () => clerk.idToken(PEPE, { nonce: await nonce(t), iat: now - 7200, exp: now - 3600 }), /expired/],
    ["claiming HS256", async () => clerk.idToken(PEPE, { nonce: await nonce(t) }, { header: { alg: "HS256" } }), /RS256/],
    ["with no nonce", async () => clerk.idToken(PEPE), /nonce/],
    ["with a nonce the room never gave", async () => clerk.idToken(PEPE, { nonce: "a".repeat(43) }), /already used|another deployment/],
    ["not a JWT", async () => "not-a-jwt", /JWT/],
  ];
  for (const [label, token, reason] of cases) {
    const refused = await post(t, "/api/v1/cli-sign-in/token", { idToken: await token(), name: "laptop" });
    expect(refused, label).toMatchObject({ status: 401, ok: false, error: { code: "unauthenticated" } });
    expect(refused.error!.message, label).toMatch(reason);
  }
  const people = await t.run(async (ctx) => ctx.db.query("people").collect());
  const signIns = await t.run(async (ctx) => ctx.db.query("cliSignIns").collect());
  expect({ people, signIns }).toEqual({ people: [], signIns: [] });
});

test("each sign-in's nonce makes one sign-in, within 15 minutes", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const t = newRoom();
  const idToken = await clerk.idToken(PEPE, { nonce: await nonce(t) });
  expect(await post(t, "/api/v1/cli-sign-in/token", { idToken })).toMatchObject({ status: 200, ok: true });
  expect(await post(t, "/api/v1/cli-sign-in/token", { idToken })).toMatchObject({ status: 401, error: { code: "unauthenticated" } });

  const late = await nonce(t);
  vi.advanceTimersByTime(15 * 60_000 + 1);
  const lateToken = await clerk.idToken(PEPE, { nonce: late });
  expect(await post(t, "/api/v1/cli-sign-in/token", { idToken: lateToken })).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
});

test("a deployment without the command line's client ID says it isn't set up", async () => {
  vi.stubEnv("CLERK_CLI_CLIENT_ID", "");
  const t = newRoom();
  for (const path of ["/api/v1/cli-sign-in", "/api/v1/cli-sign-in/token"]) {
    const answer = await post(t, path, { idToken: "x" });
    expect(answer).toMatchObject({ status: 503, ok: false, error: { code: "not_configured" } });
    expect(answer.error!.message).toMatch(/CLERK_CLI_CLIENT_ID/);
  }
});

test("with a CLI sign-in, team functions act as the person's member, as in the app", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const token = await signInFromCli(t, clerk, JULIO);
  const [general] = await admin.as.query(api.channels.list, { teamId });

  // One team: teamId can be left out.
  const me = await callAsAgent(t, token, "members.me");
  expect(me.result).toMatchObject({ name: "Julio", kind: "person", role: "admin", team: { teamId } });
  const posted = await callAsAgent(t, token, "messages.post", { channelId: general!.channelId, body: "From my terminal" });
  expect(posted).toMatchObject({ status: 200, ok: true });
  const [message] = (await admin.as.query(api.messages.list, { teamId, channelId: general!.channelId })) as any[];
  expect(message).toMatchObject({ body: "From my terminal", author: { name: "Julio", kind: "person" } });

  // Two teams: teamId is needed, and works for each.
  const second = await admin.as.mutation(api.teams.create, { name: "Side project" });
  const ambiguous = await callAsAgent(t, token, "channels.list");
  expect(ambiguous).toMatchObject({ status: 400, error: { code: "invalid" } });
  expect(ambiguous.error!.message).toMatch(/2 teams: pass teamId/);
  expect(await callAsAgent(t, token, "members.me", { teamId: second })).toMatchObject({ ok: true, result: { team: { name: "Side project" } } });

  const listed = await callAsAgent(t, token, "people.me");
  expect(listed.result.teams).toEqual([
    { teamId, name: "Nuko Nova", memberId: me.result.memberId, role: "admin" },
    { teamId: second, name: "Side project", memberId: expect.any(String), role: "admin" },
  ]);
});

test("a person in no team can use account functions only", async () => {
  const t = newRoom();
  const token = await signInFromCli(t, clerk, PEPE);
  const refused = await callAsAgent(t, token, "channels.list");
  expect(refused).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(refused.error!.message).toMatch(/aren't in a team/);
  expect(await callAsAgent(t, token, "people.me")).toMatchObject({ ok: true, result: { name: "Pepe", teams: [] } });
});

test("people.signIns lists each computer signed in, and revoking one stops it at once", async () => {
  const t = newRoom();
  const laptop = await signInFromCli(t, clerk, PEPE, "Pepe's laptop");
  const desktop = await signInFromCli(t, clerk, PEPE, "Pepe's desktop");

  const listed = await callAsAgent(t, laptop, "people.signIns");
  expect(listed.result).toEqual([
    { signInId: expect.any(String), name: "Pepe's desktop", prefix: desktop.slice(0, 8), createdAt: expect.any(Number), expiresAt: expect.any(Number), current: false },
    { signInId: expect.any(String), name: "Pepe's laptop", prefix: laptop.slice(0, 8), createdAt: expect.any(Number), lastUsedAt: expect.any(Number), expiresAt: expect.any(Number), current: true },
  ]);
  const [desktopRow, laptopRow] = listed.result;

  // The app sees the same list, as the person (slice 12's Settings), and revokes by id.
  const app = t.withIdentity({ subject: PEPE.subject, name: PEPE.name, email: PEPE.email });
  expect((await app.query(api.people.signIns, {})).map((s: { name: string }) => s.name)).toEqual(["Pepe's desktop", "Pepe's laptop"]);
  await app.mutation(api.people.revokeSignIn, { signInId: desktopRow.signInId });
  expect(await callAsAgent(t, desktop, "people.me")).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  expect(await callAsAgent(t, laptop, "people.me")).toMatchObject({ ok: true });
  await expect(app.mutation(api.people.revokeSignIn, {})).rejects.toThrow(/Pass signInId/);

  // Nobody else can revoke it, or learn it exists.
  const julio = await signIn(t, "Julio");
  await expect(julio.as.mutation(api.people.revokeSignIn, { signInId: laptopRow.signInId })).rejects.toThrow(/No such sign-in/);

  // Signing out revokes the sign-in the call came with.
  expect(await callAsAgent(t, laptop, "people.revokeSignIn")).toMatchObject({ ok: true, result: null });
  expect(await callAsAgent(t, laptop, "people.signIns")).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  expect(await app.query(api.people.signIns, {})).toEqual([]);
});

test("a CLI sign-in stops working 30 days after it was made", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const t = newRoom();
  const token = await signInFromCli(t, clerk, PEPE);
  vi.advanceTimersByTime(30 * DAY - 60_000);
  expect(await callAsAgent(t, token, "people.me")).toMatchObject({ ok: true });
  vi.advanceTimersByTime(60_000);
  const expired = await callAsAgent(t, token, "people.me");
  expect(expired).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  expect(expired.error!.message).toMatch(/uplink login/);
});

test("a CLI sign-in's row is written when it expires, so no cached live result outlives it", async () => {
  // Convex reruns a cached query only when a document it read changes, never because time passed
  // (docs.convex.dev/understanding/best-practices, "Don't use Date.now() in queries"). So a live
  // watch with an expired sign-in stays answered from cache unless the sign-in's row changes.
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  const t = newRoom();
  const { teamId } = await newTeam(t);
  const token = await signInFromCli(t, clerk, JULIO);
  const row = () => t.run(async (ctx) => (await ctx.db.query("cliSignIns").collect())[0]);
  const watch = () => t.query(api.live.query, { key: token, fn: "channels.list", args: { teamId } });
  const fresh = await row();
  expect(await watch()).toEqual(expect.any(Array));

  vi.advanceTimersByTime(fresh!.expiresAt - Date.now() - 60_000);
  await t.finishInProgressScheduledFunctions();
  expect(await row()).toEqual(fresh);

  vi.advanceTimersByTime(60_000);
  await t.finishInProgressScheduledFunctions();
  expect(await row()).not.toEqual(fresh);
  await expect(watch()).rejects.toThrow(/expired or was revoked/);
});

/**
 * Julio signed in on the command line, with `runs` runs joined in Nuko Nova with that one sign-in:
 * one by `uplink join`, the rest copies of it, with nothing waiting.
 */
async function busySignIn(t: Room, runs: number) {
  const { teamId } = await newTeam(t);
  const token = await signInFromCli(t, clerk, JULIO);
  const joined = await callAsAgent(t, token, "joined.start", { harness: "claude-code", sessionRef: "session-1", hearing: "mid_task", teamId });
  await t.run(async (ctx) => {
    const { _id, _creationTime, ...session } = (await ctx.db.query("joinedSessions").first())!;
    const { _id: _runId, _creationTime: _runTime, ...run } = (await ctx.db.get(session.runId!))!;
    for (let i = 1; i < runs; i++) {
      const copy = await ctx.db.insert("runs", run);
      await ctx.db.insert("joinedSessions", { ...session, runId: copy, sessionRef: `session-copy-${i}`, hash: `copy-${i}` });
    }
  });
  const signInId = (await t.run(async (ctx) => (await ctx.db.query("cliSignIns").first())!._id)) as Id<"cliSignIns">;
  const liveRuns = () => t.run(async (ctx) => (await ctx.db.query("runs").collect()).filter((r) => r.endedAt === undefined).length);
  return { teamId, token, runToken: joined.result.token as string, signInId, liveRuns };
}

test("revoking a sign-in whose sessions joined 700 runs fits Convex's limits: it stops at once, and its runs end in steps", async () => {
  const t = newLimitedRoom();
  const busy = await busySignIn(t, 700);
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await callAsAgent(t, busy.token, "people.revokeSignIn", {})).toMatchObject({ ok: true });
  // Before the steps after the first have run, neither the sign-in nor a run token works.
  expect(await callAsAgent(t, busy.token, "people.me", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(t, busy.runToken, "joined.waiting", {})).toMatchObject({ status: 401 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await busy.liveRuns()).toBe(0);
});

test("a sign-in whose sessions joined 700 runs expires within Convex's limits, and its runs end in steps", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["setTimeout", "Date"] });
  const t = newLimitedRoom();
  const busy = await busySignIn(t, 700);
  vi.setSystemTime(Date.now() + 30 * DAY + 60_000);
  await t.mutation(internal.cliSignIns.expire, { signInId: busy.signInId });
  expect(await callAsAgent(t, busy.runToken, "joined.waiting", {})).toMatchObject({ status: 401 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await busy.liveRuns()).toBe(0);
});

/**
 * Each of the sign-in's joined sessions has been in `pairs` Pairs before, runs that have since left
 * them, as a session that pairs all day leaves behind.
 */
async function withPairHistory(t: Room, pairs: number) {
  const sessions = await t.run(async (ctx) => ctx.db.query("joinedSessions").collect());
  for (let at = 0; at < sessions.length; at += 10) {
    await t.run(async (ctx) => {
      const pairId = await ctx.db.insert("pairs", { createdBy: sessions[0]!.personId, createdAt: Date.now(), seq: 0, endedAt: Date.now() });
      for (const session of sessions.slice(at, at + 10)) {
        for (let i = 0; i < pairs; i++) {
          await ctx.db.insert("pairRuns", { pairId, sessionId: session._id, personId: session.personId, harness: "claude-code", joinedAt: 0, endedAt: 1 });
        }
      }
    });
  }
}

test("revoking a sign-in whose 100 sessions have each been in 320 Pairs before stops it for good, and its runs still end in steps", async () => {
  const t = newLimitedRoom();
  const busy = await busySignIn(t, 100);
  await withPairHistory(t, 320);
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await callAsAgent(t, busy.token, "people.revokeSignIn", {})).toMatchObject({ ok: true });
  expect(await callAsAgent(t, busy.token, "people.me", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(t, busy.runToken, "joined.waiting", {})).toMatchObject({ status: 401 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await busy.liveRuns()).toBe(0);
}, 60_000);

test("a sign-in whose 100 sessions have each been in 320 Pairs before expires for good, and its runs still end in steps", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["setTimeout", "Date"] });
  const t = newLimitedRoom();
  const busy = await busySignIn(t, 100);
  await withPairHistory(t, 320);
  vi.setSystemTime(Date.now() + 30 * DAY + 60_000);
  await t.mutation(internal.cliSignIns.expire, { signInId: busy.signInId });
  expect(await t.run(async (ctx) => (await ctx.db.get(busy.signInId))?.expired)).toBe(true);
  expect(await callAsAgent(t, busy.runToken, "joined.waiting", {})).toMatchObject({ status: 401 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await busy.liveRuns()).toBe(0);
}, 60_000);

test("an agent key can't call account functions", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Deploy bot");
  const refused = await callAsAgent(t, key, "people.me");
  expect(refused).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(refused.error!.message).toMatch(/members.me/);
});

test("a CLI sign-in watches Room API queries live, account and team ones", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const token = await signInFromCli(t, clerk, JULIO);

  expect(await t.query(api.live.query, { key: token, fn: "people.me", args: {} })).toMatchObject({ name: "Julio", teams: [{ teamId }] });
  const channels = (await t.query(api.live.query, { key: token, fn: "channels.list", args: {} })) as { name: string }[];
  expect(channels.map((c) => c.name)).toEqual((await admin.as.query(api.channels.list, { teamId })).map((c) => c.name));

  await callAsAgent(t, token, "people.revokeSignIn");
  await expect(t.query(api.live.query, { key: token, fn: "people.me", args: {} })).rejects.toThrow(/expired or was revoked/);
});

test("the function list marks account functions, which take no teamId and need no agent scope", async () => {
  const t = newRoom();
  const { functions } = (await (await t.fetch("/api/v1/functions")).json()) as {
    functions: { name: string; realm: string; scope: string; inputSchema: { properties: Record<string, unknown> } }[];
  };
  const byName = new Map(functions.map((f) => [f.name, f]));
  for (const name of ["people.me", "people.signIns", "people.revokeSignIn"]) {
    expect(byName.get(name), name).toMatchObject({ realm: "account", scope: "account" });
    expect(Object.keys(byName.get(name)!.inputSchema.properties), name).not.toContain("teamId");
  }
  expect(byName.get("members.me")).toMatchObject({ realm: "team", scope: "room.read" });
  expect(Object.keys(byName.get("members.me")!.inputSchema.properties)).toContain("teamId");
});

test("sign-ins nobody finished are deleted, and ended sign-ins 30 days after they expire", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const t = newRoom();
  await nonce(t);
  await signInFromCli(t, clerk, PEPE);
  const rows = () =>
    t.run(async (ctx) => ({
      requests: (await ctx.db.query("cliSignInRequests").collect()).length,
      signIns: (await ctx.db.query("cliSignIns").collect()).length,
    }));
  expect(await rows()).toEqual({ requests: 1, signIns: 1 });

  vi.advanceTimersByTime(15 * 60_000 + 1);
  await t.mutation(internal.cliSignIns.prune, {});
  expect(await rows()).toEqual({ requests: 0, signIns: 1 });

  vi.advanceTimersByTime(59 * DAY);
  await t.mutation(internal.cliSignIns.prune, {});
  expect(await rows()).toEqual({ requests: 0, signIns: 1 });
  vi.advanceTimersByTime(2 * DAY);
  await t.mutation(internal.cliSignIns.prune, {});
  expect(await rows()).toEqual({ requests: 0, signIns: 0 });
});

test("pruning many ended sign-ins goes in steps within a transaction's writes, and deletes a sign-in only after all its joined sessions", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  const t = newRoom();
  await signInFromCli(t, clerk, PEPE);
  // Three ended sign-ins of Pepe's, each with 1,500 sessions that joined with it: 4,503 rows to
  // delete, more than one step writes (Convex allows 16,000 writes in a transaction).
  await t.run(async (ctx) => {
    const first = (await ctx.db.query("cliSignIns").first())!;
    const signIns = [first._id];
    for (const n of [2, 3]) signIns.push(await ctx.db.insert("cliSignIns", { ...first, _id: undefined, _creationTime: undefined, hash: `h${n}`, prefix: `urs_000${n}` } as never));
    for (const signInId of signIns) {
      for (let i = 0; i < 1500; i++) {
        await ctx.db.insert("joinedSessions", {
          personId: first.personId,
          signInId,
          hash: `${signInId}-${i}`,
          prefix: "urj_0000",
          harness: "claude-code",
          sessionRef: `s-${i}`,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          endedAt: Date.now(),
          endReason: "signed_out",
        });
      }
    }
  });
  const rows = () =>
    t.run(async (ctx) => {
      const sessions = await ctx.db.query("joinedSessions").collect();
      const orphans = [];
      for (const session of sessions) if (!(await ctx.db.get(session.signInId))) orphans.push(session._id);
      return { signIns: (await ctx.db.query("cliSignIns").collect()).length, sessions: sessions.length, orphans: orphans.length };
    });

  vi.advanceTimersByTime(61 * DAY);
  await t.mutation(internal.cliSignIns.prune, {});
  const afterOne = await rows();
  expect(afterOne.sessions).toBeGreaterThan(0);
  expect(afterOne.orphans).toBe(0);

  // The next steps were scheduled, and finish the job.
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await rows()).toEqual({ signIns: 0, sessions: 0, orphans: 0 });
});

test("a CLI sign-in keeps what the app knows about the person and Clerk's ID token leaves out", async () => {
  const t = newRoom();
  const app = t.withIdentity({ subject: "user_ana", name: "Ana", email: "ana@example.com", pictureUrl: "https://img.example.com/ana.png" });
  await app.mutation(api.people.ensure, {});
  // Clerk's ID token has no picture when it has none to send.
  const token = await signInFromCli(t, clerk, { subject: "user_ana", name: "Ana Díaz", email: "ana@example.com" });
  expect((await callAsAgent(t, token, "people.me")).result).toMatchObject({
    name: "Ana Díaz",
    email: "ana@example.com",
    avatarUrl: "https://img.example.com/ana.png",
  });
});
