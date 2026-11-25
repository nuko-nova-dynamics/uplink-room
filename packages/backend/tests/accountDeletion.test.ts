/**
 * Deleting an account (slice 15 of #139, ADR 0029 D10): Clerk's `user.deleted` webhook, signed by
 * Svix, ends the person's runs in their Pairs, their joined runs and CLI sign-ins, and their team
 * memberships. Their Pair messages stay as "A deleted account".
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CLIENT_ID, fakeClerk } from "./fakeClerk";
import type { Person, Room } from "./setup";
import { addAgent, addTeammate, bridgeInbox, callAsAgent, linkMachine, newLimitedRoom, newRoom, newTeam, signIn, signInFromCli } from "./setup";

/** Svix's own example ("Verifying Webhooks Manually", Example signatures). */
const SVIX_EXAMPLE = {
  secret: "whsec_plJ3nmyCDGBKInavdOK15jsl",
  payload: '{"event_type":"ping","data":{"success":true}}',
  id: "msg_loFOjxBNrRLzqYUf",
  timestamp: "1731705121",
  signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
};

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

beforeEach(() => {
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Signs as Svix does: base64 HMAC-SHA256 of `id.timestamp.body`, keyed with the secret's base64 part. */
async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

type Delivery = { id?: string; timestamp?: string; secret?: string; signature?: string; headers?: Record<string, string> };

/** Sends `body` to the room's Clerk webhook as Svix would, signed now unless told otherwise. */
async function deliver(t: Room, body: string, opts: Delivery = {}) {
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? (await sign(opts.secret ?? SECRET, id, timestamp, body));
  const response = await t.fetch("/clerk/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature, ...opts.headers },
    body,
  });
  const text = await response.text();
  let json: { ok?: boolean; result?: string; error?: { code: string; message: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, ...json };
}

/** Clerk's `user.deleted` event for `subject` ("Webhooks overview", Payload structure; `data` is a deleted object). */
function userDeleted(subject: string): string {
  return JSON.stringify({ data: { deleted: true, id: subject, object: "user" }, instance_id: "ins_test", object: "event", timestamp: Date.now(), type: "user.deleted" });
}

/** Whether the person can still use the app: a deleted account can't. */
async function canUseApp(person: Pick<Person, "as">): Promise<boolean> {
  try {
    await person.as.query(api.people.me, {});
    return true;
  } catch {
    return false;
  }
}

test("a delivery that isn't signed with the endpoint's secret, or whose body was changed, changes nothing", async () => {
  const t = newRoom();
  const pepe = await signIn(t, "Pepe");
  const body = userDeleted("user_Pepe");

  expect(await deliver(t, body, { secret: "whsec_dGhlIHdyb25nIHNlY3JldCwgMzIgYnl0ZXMgbG9uZyEh" })).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  // Signed over another body: the signature covers every byte.
  const id = "msg_tampered";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(SECRET, id, timestamp, userDeleted("user_Someone"));
  expect(await deliver(t, body, { id, timestamp, signature })).toMatchObject({ status: 401 });
  // Without a signature, or with one in a version Svix doesn't use.
  expect(await deliver(t, body, { signature: "" })).toMatchObject({ status: 400 });
  const v2 = (await sign(SECRET, id, timestamp, body)).replace(/^v1,/, "v2,");
  expect(await deliver(t, body, { id, timestamp, signature: v2 })).toMatchObject({ status: 401 });

  expect(await canUseApp(pepe)).toBe(true);
  expect(await deliver(t, body)).toMatchObject({ status: 200, result: "deleted" });
  expect(await canUseApp(pepe)).toBe(false);
});

test("a delivery whose timestamp is more than five minutes from the room's clock is refused, either way", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const t = newRoom();
  const pepe = await signIn(t, "Pepe");
  const body = userDeleted("user_Pepe");
  const now = Math.floor(Date.now() / 1000);

  // Correctly signed, but captured more than five minutes ago, or dated ahead.
  expect(await deliver(t, body, { timestamp: String(now - 301) })).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  expect(await deliver(t, body, { timestamp: String(now + 301) })).toMatchObject({ status: 401 });
  expect(await deliver(t, body, { timestamp: "soon" })).toMatchObject({ status: 400 });
  expect(await canUseApp(pepe)).toBe(true);
  // Within the five minutes, it's taken.
  expect(await deliver(t, body, { timestamp: String(now - 299) })).toMatchObject({ status: 200, result: "deleted" });
});

test("a deployment without CLERK_WEBHOOK_SIGNING_SECRET refuses Clerk's webhooks, and a body over 1 MiB is refused unread", async () => {
  const t = newRoom();
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "");
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 503, error: { code: "not_configured" } });
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", SECRET);
  expect(await deliver(t, JSON.stringify({ type: "user.updated", data: { id: "user_Pepe", bio: "x".repeat(1024 * 1024) } }))).toMatchObject({ status: 413 });
});

test("a delivery signed as Svix's own example shows is accepted, and an event other than user.deleted changes nothing", async () => {
  vi.useFakeTimers({ now: Number(SVIX_EXAMPLE.timestamp) * 1000, toFake: ["Date"] });
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", SVIX_EXAMPLE.secret);
  const t = newRoom();
  expect(await sign(SVIX_EXAMPLE.secret, SVIX_EXAMPLE.id, SVIX_EXAMPLE.timestamp, SVIX_EXAMPLE.payload)).toBe(SVIX_EXAMPLE.signature);
  // Svix sends a list of signatures; one that matches is enough.
  const signature = `v1,bm9ldHUjKzFob2VudXRob2VodWUzMjRvdWVvdW9ldQo= ${SVIX_EXAMPLE.signature}`;
  expect(await deliver(t, SVIX_EXAMPLE.payload, { id: SVIX_EXAMPLE.id, timestamp: SVIX_EXAMPLE.timestamp, signature })).toMatchObject({
    status: 200,
    ok: true,
    result: "ignored",
  });
});

/** `uplink join`: a session joins as a run of the sign-in's person, in a team or in none. */
async function join(t: Room, signInToken: string, teamId?: Id<"teams">) {
  const joined = await callAsAgent(t, signInToken, "joined.start", { harness: "claude-code", sessionRef: `session-${Math.random()}`, hearing: "mid_task", ...(teamId ? { teamId } : {}) });
  if (!joined.ok) throw new Error(`joined.start: ${joined.error?.message}`);
  return joined.result as { token: string; label: string };
}

/**
 * Julio (admin) and Pepe in Nuko Nova, and Ana in Acme with her agent Icarus. Pepe added an agent
 * too, and is signed in on his laptop with a joined run in Nuko Nova and one in no team. Two Pairs:
 * the first has Julio's run, Pepe's teamless run, Icarus and Pepe's agent, so Julio, Pepe and Ana;
 * the second only Julio's run and Pepe's team run.
 */
async function world() {
  const clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  const scout = await addAgent(t, teamId, pepe, "Scout", ["room.read", "messages.post", "pairs.join"]);
  const ana = await signIn(t, "Ana");
  const acmeId: Id<"teams"> = await ana.as.mutation(api.teams.create, { name: "Acme" });
  const icarus = await addAgent(t, acmeId, ana, "Icarus", ["room.read", "messages.post", "pairs.join"]);

  const julioSignIn = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
  const pepeSignIn = await signInFromCli(t, clerk, { subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" }, "pepe-laptop");
  const julioRun = await join(t, julioSignIn, teamId);
  const pepeTeamRun = await join(t, pepeSignIn, teamId);
  const pepeRun = await join(t, pepeSignIn);

  const code = async () => (await callAsAgent(t, julioRun.token, "joined.pairCode", {})).result.code as string;
  const first = await callAsAgent(t, pepeRun.token, "joined.pairJoin", { code: await code() });
  await callAsAgent(t, icarus.key, "pairs.join", { code: await code() });
  await callAsAgent(t, scout.key, "pairs.join", { code: await code() });
  await callAsAgent(t, pepeRun.token, "joined.say", { in: "pair", text: "from Pepe's run" });
  await callAsAgent(t, pepeSignIn, "pairs.post", { pairId: first.result.pairId, text: "from Pepe" });
  const second = (await callAsAgent(t, pepeTeamRun.token, "joined.pairCode", { new: true })).result;
  await callAsAgent(t, julioRun.token, "joined.pairJoin", { code: second.code });
  return { t, teamId, julio, pepe, ana, scout, icarus, julioRun, pepeSignIn, pepeRun, pepeTeamRun, firstPair: first.result.pairId as string, secondPair: second.pairId as string };
}

test("deleting an account ends the person's runs in their Pairs, their joined runs, CLI sign-ins and team memberships, and keeps their messages as A deleted account", async () => {
  const w = await world();
  expect(await deliver(w.t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  await w.t.finishAllScheduledFunctions(() => {});

  // The first Pair goes on with Julio and Ana: Pepe's run and agent left, his messages stay without his name.
  const pairs = await w.julio.as.query(api.pairs.list, {});
  const first = pairs.find((p) => p.pairId === w.firstPair)!;
  expect(first.endedAt).toBeUndefined();
  expect(first.people.map((p) => p.name).sort()).toEqual(["Ana", "Julio"]);
  expect(first.runs.map((r) => r.label)).toEqual(["Claude Code (Julio)"]);
  expect(first.agents.map((a) => a.name)).toEqual(["Icarus"]);
  const { messages } = await w.julio.as.query(api.pairs.messages, { pairId: w.firstPair });
  expect(messages.map((m) => [m.body, m.from.name])).toEqual([
    ["from Pepe's run", "A deleted account"],
    ["from Pepe", "A deleted account"],
  ]);
  // The second had only Julio and Pepe: fewer than two people are left, so it ended.
  expect(pairs.find((p) => p.pairId === w.secondPair)).toMatchObject({ endReason: "too_few_people" });

  // Nothing acts as Pepe any more: not the app, his CLI sign-in, his run tokens or the agent he added.
  expect(await canUseApp(w.pepe)).toBe(false);
  expect(await callAsAgent(w.t, w.pepeSignIn, "people.me", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(w.t, w.pepeRun.token, "joined.waiting", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(w.t, w.pepeTeamRun.token, "joined.waiting", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(w.t, w.scout.key, "members.me", {})).toMatchObject({ status: 403 });
  const again = (await callAsAgent(w.t, w.julioRun.token, "joined.pairCode", { pairId: w.firstPair })).result.code;
  expect(await callAsAgent(w.t, w.scout.key, "pairs.join", { code: again })).toMatchObject({ status: 403 });

  // He is no longer in Nuko Nova; Julio, still its admin, is.
  const roster = await w.julio.as.query(api.teams.members, { teamId: w.teamId });
  expect(roster.map((m) => m.name).sort()).toEqual(["Julio", "Scout"]);
  // The room keeps no email or picture for him (no function shows a deleted person, so this reads the row).
  const row = await w.t.run(async (ctx) => ctx.db.query("people").withIndex("by_subject", (q) => q.eq("subject", "user_Pepe")).unique());
  expect(row).toMatchObject({ name: "A deleted account", deletedAt: expect.any(Number) });
  expect(row!.email).toBeUndefined();
  expect(row!.avatarUrl).toBeUndefined();
});

test("an agent the deleted person added can't bring them back into a Pair, even before they have left their teams", async () => {
  const w = await world();
  const code = (await callAsAgent(w.t, w.julioRun.token, "joined.pairCode", { new: true })).result.code;
  // Hold back the scheduled steps that take Pepe out of his Pairs and teams.
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(w.t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  expect(await callAsAgent(w.t, w.scout.key, "pairs.join", { code })).toMatchObject({ status: 403 });
  vi.useRealTimers();
  await w.t.finishAllScheduledFunctions(() => {});
  const third = (await w.julio.as.query(api.pairs.list, {})).find((p) => ![w.firstPair, w.secondPair].includes(p.pairId))!;
  expect(third.people.map((p) => p.name)).toEqual(["Julio"]);
});

test("a delivery Svix sends again, or Clerk sends twice, changes nothing the second time", async () => {
  const w = await world();
  const id = "msg_2b4M0uFYQ2rLQsg0gRVixWCH1Ze";
  expect(await deliver(w.t, userDeleted("user_Pepe"), { id })).toMatchObject({ status: 200, result: "deleted" });
  await w.t.finishAllScheduledFunctions(() => {});
  const before = await w.julio.as.query(api.pairs.list, {});
  const activity = async () => (await w.julio.as.query(api.activity.list, { teamId: w.teamId })).length;
  const logged = await activity();

  // The same svix-id, signed again a minute later as a retry is: already applied, whatever it says.
  vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
  expect(await deliver(w.t, userDeleted("user_Ana"), { id })).toMatchObject({ status: 200, result: "duplicate" });
  expect(await canUseApp(w.ana)).toBe(true);
  // Another delivery for the account already deleted.
  expect(await deliver(w.t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "already_deleted" });
  await w.t.finishAllScheduledFunctions(() => {});
  expect(await w.julio.as.query(api.pairs.list, {})).toEqual(before);
  expect(await activity()).toBe(logged);

  // An account the room never saw: nothing to do, and Svix needn't retry.
  expect(await deliver(w.t, userDeleted("user_Nobody"))).toMatchObject({ status: 200, result: "unknown_person" });
});

test("a deleted person's team messages stay, under A deleted account, in the teams they were in and those they had already left", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  const sideId: Id<"teams"> = await julio.as.mutation(api.teams.create, { name: "Side project" });
  const pepeSide = await addTeammate(t, sideId, julio, "Pepe");
  const general = async (team: Id<"teams">) => (await julio.as.query(api.channels.list, { teamId: team })).find((c) => c.name === "general")!.channelId;
  await pepe.as.mutation(api.messages.post, { teamId, channelId: await general(teamId), body: "shipping today" });
  await pepe.as.mutation(api.messages.post, { teamId: sideId, channelId: await general(sideId), body: "side notes" });
  await julio.as.mutation(api.members.remove, { teamId: sideId, memberId: pepeSide.memberId });

  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(() => {});
  for (const team of [teamId, sideId]) {
    const page = (await julio.as.query(api.messages.list, { teamId: team, channelId: await general(team), cursor: null })) as {
      page: { body: string; author: { name: string } }[];
    };
    expect(page.page.filter((m) => m.author.name !== "Julio").map((m) => [m.body, m.author.name])).toEqual([
      [team === teamId ? "shipping today" : "side notes", "A deleted account"],
    ]);
  }
});

test("when a team's only admin deletes their account, the person who has been in it longest becomes its admin, and the activity log says so", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  // Julio's agent has been in the team longer than anyone, but an agent isn't a person.
  await addAgent(t, teamId, julio, "Hermes", ["room.read"]);
  await addTeammate(t, teamId, julio, "Pepe");
  const ana = await addTeammate(t, teamId, julio, "Ana");
  await addTeammate(t, teamId, julio, "Bo");
  // A team only Julio is in is left with no admin, and nobody in it.
  const otherId: Id<"teams"> = await julio.as.mutation(api.teams.create, { name: "Side project" });

  // Pepe joined before Ana, but his account is being deleted too: he is no longer someone to ask.
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  expect(await deliver(t, userDeleted("user_Julio"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();

  const roster = await ana.as.query(api.teams.members, { teamId });
  expect(roster.map((m) => [m.name, m.role])).toEqual([
    ["Hermes", "member"],
    ["Ana", "admin"],
    ["Bo", "member"],
  ]);
  const promoted = (await ana.as.query(api.activity.list, { teamId })).filter((e) => e.action === "member.role_changed");
  expect(promoted).toMatchObject([{ target: ana.memberId, details: { role: "admin", reason: "last_admin_deleted" }, actor: { name: "A deleted account" } }]);
  const left = await t.run(async (ctx) => (await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", otherId)).collect()).map((m) => [m.removedAt, m.role]));
  expect(left).toEqual([[expect.any(Number), "admin"]]);
});

test("when the only admin of a team of 2,050 people deletes their account, the person who joined first becomes admin, in a step that fits Convex's limits", async () => {
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  // 2,048 people joined after Ana.
  await t.run(async (ctx) => {
    for (let i = 0; i < 2048; i++) {
      const personId = await ctx.db.insert("people", { subject: `user_${i}`, name: `Person ${i}` });
      await ctx.db.insert("members", { teamId, kind: "person", personId, name: `Person ${i}`, role: "member" });
    }
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(t, userDeleted("user_Julio"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();

  const admins = await t.run(async (ctx) =>
    (await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId)).collect()).filter((m) => m.role === "admin" && m.removedAt === undefined),
  );
  expect(admins.map((m) => m._id)).toEqual([ana.memberId]);
  expect(await t.run(async (ctx) => (await ctx.db.query("accountDeletions").first())?.finishedAt)).toEqual(expect.any(Number));
}, 60_000);

test("when 4,500 deleted people joined a team before anyone who can be its admin, its only admin's deletion still hands it over, in steps that fit Convex's limits", async () => {
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 4500; i++) {
      const personId = await ctx.db.insert("people", { subject: `user_${i}`, name: "A deleted account", deletedAt: Date.now() });
      await ctx.db.insert("members", { teamId, kind: "person", personId, name: "A deleted account", role: "member" });
    }
  });
  const ana = await addTeammate(t, teamId, julio, "Ana");
  await addTeammate(t, teamId, julio, "Bo");

  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(t, userDeleted("user_Julio"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();

  const roster = await ana.as.query(api.teams.members, { teamId });
  expect(roster.filter((m) => m.role === "admin").map((m) => m.name)).toEqual(["Ana"]);
  expect(await t.run(async (ctx) => (await ctx.db.query("accountDeletions").first())?.finishedAt)).toEqual(expect.any(Number));
}, 60_000);

test("an account deleted while its first `uplink login` waits for the token exchange can't finish it, nor sign in through the app", async () => {
  const clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
  const t = newRoom();
  const post = async (path: string, body: unknown) => {
    const response = await t.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...((await response.json()) as { ok: boolean; result: any }) };
  };
  const user = { subject: "user_Nuevo", name: "Nuevo", email: "nuevo@example.com" };
  // Clerk issued the ID token for a first sign-in; the room has never seen this account.
  const { result } = await post("/api/v1/cli-sign-in", {});
  const idToken = await clerk.idToken(user, { nonce: result.nonce });

  expect(await deliver(t, userDeleted("user_Nuevo"))).toMatchObject({ status: 200, result: "unknown_person" });
  expect(await post("/api/v1/cli-sign-in/token", { idToken, name: "laptop" })).toMatchObject({ status: 401, ok: false });
  const app = t.withIdentity({ subject: "user_Nuevo", name: "Nuevo", email: "nuevo@example.com", emailVerified: true });
  await expect(app.mutation(api.people.ensure, {})).rejects.toThrow(/deleted/);
  expect(await canUseApp({ as: app })).toBe(false);
});

test("a deleted person's personal machines lose their bridge tokens at once and leave the team, their unused pairing codes stop working, and a team machine they linked stays", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  await julio.as.mutation(api.members.setRole, { teamId, memberId: pepe.memberId, role: "admin" });
  const laptop = await linkMachine(t, teamId, pepe, "pepe-laptop");
  const rack = await linkMachine(t, teamId, pepe, "rack", { team: true });
  const { code: personalCode } = await pepe.as.mutation(api.machines.createPairingCode, { teamId, name: "spare" });
  const { code: teamCode } = await pepe.as.mutation(api.machines.createPairingCode, { teamId, name: "spare rack", belongsToTeam: true });
  const pair = (code: string) => t.mutation(api.bridge.pair, { code, hostname: "spare.local", os: "darwin" });

  // Hold back the scheduled steps: from the moment the deletion lands, his laptop's token reads and
  // reports nothing, and his codes pair nothing.
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  await expect(bridgeInbox(t, laptop.token)).rejects.toThrow(/bridge token/);
  await expect(t.mutation(api.bridge.heartbeat, { token: laptop.token })).rejects.toThrow(/bridge token/);
  await expect(pair(personalCode)).rejects.toThrow(/pairing code/);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();

  // His laptop left the team and its token is gone; the rack is the team's and keeps working.
  await expect(bridgeInbox(t, laptop.token)).rejects.toThrow(/bridge token/);
  expect((await julio.as.query(api.machines.list, { teamId })).map((m) => m.name)).toEqual(["rack"]);
  await t.mutation(api.bridge.heartbeat, { token: rack.token });
  await expect(pair(teamCode)).rejects.toThrow(/pairing code/);
});

test("a deleted person's personal machine in a team an admin removed them from before removal unlinked machines is unlinked too", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  const laptop = await linkMachine(t, teamId, pepe, "pepe-laptop");
  // Removed before `members.remove` unlinked personal machines: his laptop stayed linked.
  await t.run((ctx) => ctx.db.patch(pepe.memberId, { removedAt: Date.now() }));
  expect((await julio.as.query(api.machines.list, { teamId })).map((m) => m.name)).toEqual(["pepe-laptop"]);

  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(() => {});
  expect(await julio.as.query(api.machines.list, { teamId })).toEqual([]);
  await expect(bridgeInbox(t, laptop.token)).rejects.toThrow(/bridge token/);
  const log = await julio.as.query(api.activity.list, { teamId });
  expect(log.filter((e) => e.action === "machine.unlinked").map((e) => e.details)).toEqual([{ reason: "account_deleted" }]);
});

test("a person removed from a team and let back in 1,400 times has every old membership renamed, in steps that fit Convex's limits", async () => {
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  await julio.as.mutation(api.members.remove, { teamId, memberId: pepe.memberId });
  // Each rejoin makes a new membership, and the removal before it leaves the old one behind.
  await t.run(async (ctx) => {
    const { _id, _creationTime, ...old } = (await ctx.db.get(pepe.memberId))!;
    for (let i = 1; i < 1400; i++) await ctx.db.insert("members", old);
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  vi.useRealTimers();

  const names = await t.run(async (ctx) => (await ctx.db.query("members").withIndex("by_person", (q) => q.eq("personId", pepe.personId)).collect()).map((m) => m.name));
  expect(names.length).toBe(1400);
  expect(names.filter((n) => n !== "A deleted account")).toEqual([]);
  expect(await t.run(async (ctx) => (await ctx.db.query("accountDeletions").first())?.finishedAt)).toEqual(expect.any(Number));
}, 60_000);

test("deleting an account whose sign-in joined 700 runs fits Convex's limits: it lands at once, and nothing acts as the person while the steps that end their runs go on", async () => {
  const clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  await addTeammate(t, teamId, julio, "Pepe");
  const scout = await addAgent(t, teamId, (await signIn(t, "Pepe")), "Scout", ["room.read"]);
  const signInToken = await signInFromCli(t, clerk, { subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" });
  const run = await join(t, signInToken, teamId);
  // 699 more runs joined in the team with the same sign-in, none with anything waiting.
  await t.run(async (ctx) => {
    const { _id, _creationTime, ...session } = (await ctx.db.query("joinedSessions").first())!;
    const { _id: _runId, _creationTime: _runTime, ...runFields } = (await ctx.db.get(session.runId!))!;
    for (let i = 0; i < 699; i++) {
      const copy = await ctx.db.insert("runs", runFields);
      await ctx.db.insert("joinedSessions", { ...session, runId: copy, sessionRef: `session-copy-${i}`, hash: `copy-${i}` });
    }
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  // Before any step after the first has run: not his sign-in, nor a run token, nor his agent.
  expect(await callAsAgent(t, signInToken, "people.me", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(t, run.token, "joined.waiting", {})).toMatchObject({ status: 401 });
  expect(await callAsAgent(t, scout.key, "members.me", {})).toMatchObject({ status: 403 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();

  const live = await t.run(async (ctx) => (await ctx.db.query("joinedSessions").collect()).filter((s) => s.endedAt === undefined).length);
  expect(live).toBe(0);
  expect((await julio.as.query(api.teams.members, { teamId })).map((m) => m.name).sort()).toEqual(["Julio", "Scout"]);
});

test("a person in 2,050 private channels leaves their team in steps that fit Convex's limits, and the channels go on without them", async () => {
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  const scout = await addAgent(t, teamId, pepe, "Scout", ["room.read"]);
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  for (let chunk = 0; chunk < 5; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 410; i++) {
        const channelId = await ctx.db.insert("channels", { teamId, name: `room-${chunk}-${i}`, kind: "private", createdBy: pepe.memberId });
        for (const memberId of [pepe.memberId, julioId]) await ctx.db.insert("channelMembers", { teamId, channelId, memberId, addedAt: Date.now() });
      }
    });
  }

  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "deleted" });
  await t.finishAllScheduledFunctions(() => {});
  expect((await julio.as.query(api.teams.members, { teamId })).map((m) => m.name).sort()).toEqual(["Julio", "Scout"]);
  expect(await callAsAgent(t, scout.key, "members.me", {})).toMatchObject({ status: 403 });
  const seats = await t.run(async (ctx) => ({
    pepe: (await ctx.db.query("channelMembers").withIndex("by_member", (q) => q.eq("memberId", pepe.memberId)).collect()).length,
    archived: (await ctx.db.query("channels").withIndex("by_team", (q) => q.eq("teamId", teamId)).collect()).filter((c) => c.archivedAt !== undefined).length,
  }));
  expect(seats).toEqual({ pepe: 0, archived: 0 });
}, 60_000);

test("a deletion whose steps stopped is started again by the cron after 10 minutes, or at once by Clerk sending it again", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["setTimeout", "Date"] });
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  await addTeammate(t, teamId, julio, "Pepe");
  await addTeammate(t, teamId, julio, "Ana");
  const roster = async () => (await julio.as.query(api.teams.members, { teamId })).map((m) => m.name).sort();
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ result: "deleted" });
  expect(await deliver(t, userDeleted("user_Ana"))).toMatchObject({ result: "deleted" });
  // Their next steps never run, as when one fails: Convex doesn't run a failed one again.
  await t.run(async (ctx) => {
    for (const f of await ctx.db.system.query("_scheduled_functions").collect()) if (f.state.kind === "pending") await ctx.scheduler.cancel(f._id);
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await roster()).toEqual(["Ana", "Julio", "Pepe"]);

  // Within 10 minutes the cron leaves them: their steps may still be going.
  vi.setSystemTime(Date.now() + 9 * 60_000);
  expect(await t.mutation(internal.accounts.resumeStalled, {})).toBe(0);
  // Pepe's deletion sent again from the Dashboard starts his at once.
  vi.setSystemTime(Date.now() + 2 * 60_000);
  expect(await deliver(t, userDeleted("user_Pepe"))).toMatchObject({ status: 200, result: "already_deleted" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await roster()).toEqual(["Ana", "Julio"]);
  // Ana's waits for the cron.
  expect(await t.mutation(internal.accounts.resumeStalled, {})).toBe(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await roster()).toEqual(["Julio"]);
  expect(await t.mutation(internal.accounts.resumeStalled, {})).toBe(0);
});

test("the daily prune forgets delivery ids after 7 days, and a later copy of the delivery still changes nothing", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const t = newRoom();
  await signIn(t, "Pepe");
  const id = "msg_kept_a_week";
  expect(await deliver(t, userDeleted("user_Pepe"), { id })).toMatchObject({ result: "deleted" });
  vi.setSystemTime(new Date("2026-11-12T11:00:00Z"));
  await t.mutation(internal.accounts.prune, {});
  expect(await deliver(t, userDeleted("user_Pepe"), { id })).toMatchObject({ result: "duplicate" });
  vi.setSystemTime(new Date("2026-11-12T13:00:00Z"));
  await t.mutation(internal.accounts.prune, {});
  expect(await deliver(t, userDeleted("user_Pepe"), { id })).toMatchObject({ result: "already_deleted" });
});


test("an admin invitation accepted between successor pages prevents an unnecessary promotion", async () => {
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { token } = await julio.as.mutation(api.invites.create, {
    teamId,
    email: "bo@example.com",
    role: "admin",
  });
  const bo = await signIn(t, "Bo");
  await t.run(async (ctx) => {
    for (let i = 0; i < 1000; i++) {
      const personId = await ctx.db.insert("people", {
        subject: `deleted_${i}`,
        name: "Deleted",
        deletedAt: Date.now(),
      });
      await ctx.db.insert("members", {
        teamId,
        kind: "person",
        personId,
        name: "Deleted",
        role: "member",
      });
    }
  });
  const ana = await addTeammate(t, teamId, julio, "Ana");
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  await deliver(t, userDeleted("user_Julio"));
  const deletion = await t.run((ctx) => ctx.db.query("accountDeletions").first());
  await t.mutation(internal.accounts.cleanUp, { deletionId: deletion!._id });
  expect(await t.run(async (ctx) => (await ctx.db.get(deletion!._id))?.successor?.cursor)).toEqual(
    expect.any(String),
  );
  await bo.as.mutation(api.invites.accept, { token });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (await ana.as.query(api.teams.members, { teamId }))
      .filter((m) => m.role === "admin")
      .map((m) => m.name),
  ).toEqual(["Bo"]);
  expect(
    (await ana.as.query(api.activity.list, { teamId })).filter(
      (e) => e.action === "member.role_changed",
    ),
  ).toEqual([]);
});
