/**
 * Pairs (ADR 0027, ADR 0029 D9 to D13, slice 11 of #139): a private conversation of 2 to 10 joined
 * runs and agents, plus their people, who may be in different teams or in none. A run makes a pair
 * code (`uplink pair`), its person passes it on, and another run joins with it (`uplink pair <code>`),
 * or an agent with its key. Each side sees only the pair.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { addAgent, addTeammate, callAsAgent, newLimitedRoom, newRoom, newTeam, signIn, signInFromCli, type Room } from "./setup";

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

/**
 * Julio, admin of Nuko Nova, and Pepe, in no team, each signed in on their own computer's command
 * line. They share no team.
 */
async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const julioSignIn = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
  const pepeSignIn = await signInFromCli(t, clerk, { subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" }, "pepe-laptop");
  return { t, teamId, julio, julioSignIn, pepeSignIn, general: general!.channelId };
}

/** `uplink join`: a session joins as a run of the sign-in's person, in a team or in none. */
async function join(t: Room, signIn: string, args: { teamId?: Id<"teams">; harness?: string; sessionRef?: string } = {}) {
  const joined = await callAsAgent(t, signIn, "joined.start", { harness: "claude-code", sessionRef: `session-${Math.random()}`, hearing: "mid_task", ...args });
  if (!joined.ok) throw new Error(`joined.start: ${joined.error?.message}`);
  return joined.result as { token: string; label: string; runId?: string };
}

/** Julio's run in Nuko Nova and Pepe's run in no team, in one Pair made with a code. */
async function paired() {
  const r = await room();
  const julioRun = await join(r.t, r.julioSignIn, { teamId: r.teamId });
  const pepeRun = await join(r.t, r.pepeSignIn);
  const made = await callAsAgent(r.t, julioRun.token, "joined.pairCode", {});
  const joined = await callAsAgent(r.t, pepeRun.token, "joined.pairJoin", { code: made.result.code });
  if (!joined.ok) throw new Error(`joined.pairJoin: ${joined.error?.message}`);
  return { ...r, julioRun, pepeRun, pairId: joined.result.pairId as string, code: made.result.code as string };
}

test("a run makes a pair code, a run of someone in no shared team joins with it, and each hears the other", async () => {
  const { t, teamId, julioSignIn, pepeSignIn } = await room();
  const julioRun = await join(t, julioSignIn, { teamId });
  // D13: a join without a team is allowed now, but only for pairing.
  const pepeRun = await join(t, pepeSignIn);
  expect(pepeRun).toMatchObject({ token: expect.stringMatching(/^urj_/), label: "Claude Code (Pepe)" });
  expect(pepeRun.runId).toBeUndefined();

  const made = await callAsAgent(t, julioRun.token, "joined.pairCode", {});
  expect(made).toMatchObject({ status: 200, result: { code: expect.stringMatching(/^[A-Z]{3,8}-\d{4}-[A-Z]{3,8}-\d{4}$/), expiresAt: expect.any(Number) } });
  expect(made.result.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
  expect(made.result.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);

  // The code is passed on however its person likes, and typed in any case.
  const joined = await callAsAgent(t, pepeRun.token, "joined.pairJoin", { code: made.result.code.toLowerCase() });
  expect(joined).toMatchObject({ status: 200, result: { pairId: made.result.pairId, label: "Claude Code (Pepe)" } });
  expect(joined.result.runs.map((r: { label: string }) => r.label).sort()).toEqual(["Claude Code (Julio)", "Claude Code (Pepe)"]);

  const said = await callAsAgent(t, julioRun.token, "joined.say", { in: "pair", text: "I'm on the API side; which schema are you using?" });
  expect(said).toMatchObject({ status: 200, result: { label: "Claude Code (Julio)", place: "a Pair with Pepe" } });

  expect(await callAsAgent(t, pepeRun.token, "joined.waiting", {})).toMatchObject({ result: { waiting: 1 } });
  const taken = await callAsAgent(t, pepeRun.token, "joined.take", { how: "mid_task" });
  expect(taken.result.messages).toEqual([
    expect.objectContaining({
      messageId: said.result.messageId,
      pairId: made.result.pairId,
      place: "a Pair with Julio",
      text: "I'm on the API side; which schema are you using?",
      from: expect.objectContaining({ name: "Julio", kind: "person", run: "Claude Code (Julio)" }),
      accountable: expect.objectContaining({ name: "Julio" }),
      fromDriver: false,
    }),
  ]);
  await callAsAgent(t, pepeRun.token, "joined.ack", { claimId: taken.result.claimId });
  expect(await callAsAgent(t, pepeRun.token, "joined.waiting", {})).toMatchObject({ result: { waiting: 0 } });

  // Pepe's run answers the message; it reaches Julio's run, and not Pepe's own.
  const answer = await callAsAgent(t, pepeRun.token, "joined.say", { replyTo: said.result.messageId, text: "v2, the one in main" });
  expect(answer).toMatchObject({ status: 200, result: { place: "a Pair with Julio" } });
  const back = await callAsAgent(t, julioRun.token, "joined.take", { how: "next_turn" });
  expect(back.result.messages).toEqual([
    expect.objectContaining({ messageId: answer.result.messageId, text: "v2, the one in main", from: expect.objectContaining({ name: "Pepe", run: "Claude Code (Pepe)" }) }),
  ]);
  expect((await callAsAgent(t, pepeRun.token, "joined.take", { how: "mid_task" })).result.messages).toEqual([]);
});

test("a pair code is a bearer secret: kept only as its hash, it works once, and not after 10 minutes", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const r = await room();
  const julioRun = await join(r.t, r.julioSignIn, { teamId: r.teamId });
  const pepeRun = await join(r.t, r.pepeSignIn);
  const pepeOther = await join(r.t, r.pepeSignIn, { harness: "codex" });
  const { code, pairId } = (await callAsAgent(r.t, julioRun.token, "joined.pairCode", {})).result;

  // The room keeps its SHA-256, never the code.
  const stored = await r.t.run(async (ctx) => JSON.stringify(await ctx.db.query("pairCodes").collect()));
  expect(stored).not.toContain(code);
  expect(stored).not.toContain(code.replaceAll("-", ""));

  // It works once: the second run that tries it gets the same answer as for a wrong code.
  expect(await callAsAgent(r.t, pepeRun.token, "joined.pairJoin", { code })).toMatchObject({ status: 200, result: { pairId } });
  const again = await callAsAgent(r.t, pepeOther.token, "joined.pairJoin", { code });
  expect(again).toMatchObject({ status: 404, error: { code: "not_found" } });
  expect(again.error!.message).toMatch(/wrong, was used already, or is more than 10 minutes old/);

  // A code older than 10 minutes doesn't work.
  const late = (await callAsAgent(r.t, julioRun.token, "joined.pairCode", {})).result.code;
  vi.setSystemTime(new Date("2026-11-05T12:10:01Z"));
  expect(await callAsAgent(r.t, pepeOther.token, "joined.pairJoin", { code: late })).toMatchObject({ status: 404, error: { code: "not_found" } });
  expect((await callAsAgent(r.t, pepeOther.token, "joined.me", {})).result.pairs).toEqual([]);
});

test("pair codes can't be guessed: after 10 wrong ones in an hour, no code works for that person until the hour is over", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const r = await room();
  const julioRun = await join(r.t, r.julioSignIn, { teamId: r.teamId });
  const pepeRun = await join(r.t, r.pepeSignIn);
  // The limit is the person's, not the session's: another session of Pepe's shares it.
  const pepeOther = await join(r.t, r.pepeSignIn, { harness: "codex" });

  for (let i = 0; i < 10; i++) {
    const guess = `RIVER-${String(1000 + i).padStart(4, "0")}-MAPLE-0000`;
    expect(await callAsAgent(r.t, i % 2 ? pepeRun.token : pepeOther.token, "joined.pairJoin", { code: guess })).toMatchObject({ status: 404 });
  }
  const { code } = (await callAsAgent(r.t, julioRun.token, "joined.pairCode", {})).result;
  const blocked = await callAsAgent(r.t, pepeRun.token, "joined.pairJoin", { code });
  expect(blocked).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(blocked.error!.message).toMatch(/Too many wrong pair codes/);
  // Malformed text counts as a wrong code too, and a refused attempt doesn't use the code up.
  vi.setSystemTime(new Date("2026-11-05T13:00:01Z"));
  const fresh = (await callAsAgent(r.t, julioRun.token, "joined.pairCode", {})).result.code;
  expect(await callAsAgent(r.t, pepeRun.token, "joined.pairJoin", { code: ` ${fresh.toLowerCase().replaceAll("-", " ")} ` })).toMatchObject({ status: 200 });
});

test("a pair code has about 42.6 bits: two of 256 words and two groups of four digits, drawn evenly", async () => {
  const { PAIR_WORDS, newPairCode, canonicalPairCode } = await import("../convex/lib/pairs");
  expect(new Set(PAIR_WORDS).size).toBe(256);
  const codes = new Set(Array.from({ length: 2000 }, () => newPairCode()));
  expect(codes.size).toBe(2000);
  for (const code of codes) {
    expect(code).toMatch(/^[A-Z]{3,8}-\d{4}-[A-Z]{3,8}-\d{4}$/);
    expect(canonicalPairCode(code)).toBe(code);
  }
  expect(canonicalPairCode("river 4821 maple 0937")).toBe("RIVER-4821-MAPLE-0937");
  expect(canonicalPairCode("River4821Maple0937")).toBe("RIVER-4821-MAPLE-0937");
  expect(canonicalPairCode("RIVER-4821-MAPLE-093")).toBeNull();
  expect(canonicalPairCode("RIVER-4821-0937")).toBeNull();
  expect(canonicalPairCode("NOTAWORD-4821-MAPLE-0937")).toBeNull();
  expect(canonicalPairCode("4821-RIVER-0937-MAPLE")).toBeNull();
});

/** Ana, in her own team Acme, with an agent Icarus whose key has these scopes. */
async function anaWithAgent(t: Room, scopes = ["room.read", "messages.post", "pairs.join"]) {
  const ana = await signIn(t, "Ana");
  const acmeId: Id<"teams"> = await ana.as.mutation(api.teams.create, { name: "Acme" });
  const icarus = await addAgent(t, acmeId, ana, "Icarus", scopes);
  return { ana, acmeId, icarus };
}

test("an agent joins with a code its person passes on, hears everything there, and acts with its agent key (D11)", async () => {
  const p = await paired();
  const { ana, acmeId, icarus } = await anaWithAgent(p.t);

  // Without the pairs.join scope its key can't.
  const narrow = await addAgent(p.t, acmeId, ana, "Scout", ["room.read", "messages.post"]);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  const refused = await callAsAgent(p.t, narrow.key, "pairs.join", { code });
  expect(refused).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(refused.error!.message).toMatch(/pairs\.join/);

  // Ana passes the code on to Icarus, which joins; Ana becomes one of the Pair's people.
  const joined = await callAsAgent(p.t, icarus.key, "pairs.join", { code });
  expect(joined).toMatchObject({ status: 200, result: { pairId: p.pairId } });
  expect(joined.result.people.map((x: { name: string }) => x.name).sort()).toEqual(["Ana", "Julio", "Pepe"]);
  expect(joined.result.agents).toEqual([expect.objectContaining({ name: "Icarus", you: true })]);

  // What a run says reaches the agent: unread until it reads it.
  const said = await callAsAgent(p.t, p.pepeRun.token, "joined.say", { in: "pair", text: "Icarus, can you check the rate limits?" });
  expect((await callAsAgent(p.t, icarus.key, "pairs.list", {})).result).toEqual([expect.objectContaining({ pairId: p.pairId, unread: 1 })]);
  const read = await callAsAgent(p.t, icarus.key, "pairs.messages", { pairId: p.pairId });
  expect(read.result.messages.at(-1)).toMatchObject({
    messageId: said.result.messageId,
    body: "Icarus, can you check the rate limits?",
    from: { kind: "run", name: "Claude Code (Pepe)", person: { name: "Pepe" } },
  });
  // It can watch its Pairs live, as any query of its key's.
  expect(await p.t.query(api.live.query, { key: icarus.key, fn: "pairs.list", args: {} })).toEqual([expect.objectContaining({ pairId: p.pairId, unread: 1 })]);
  await callAsAgent(p.t, icarus.key, "pairs.markRead", { pairId: p.pairId });
  expect((await callAsAgent(p.t, icarus.key, "pairs.list", {})).result[0].unread).toBe(0);

  // What it says reaches every run, labelled as an agent's with Ana accountable.
  const answer = await callAsAgent(p.t, icarus.key, "pairs.post", { pairId: p.pairId, text: "Checked: 100 a minute." });
  expect(answer).toMatchObject({ status: 200, result: { messageId: expect.any(String) } });
  for (const run of [p.julioRun, p.pepeRun]) {
    const taken = await callAsAgent(p.t, run.token, "joined.take", { how: "mid_task" });
    expect(taken.result.messages.at(-1)).toMatchObject({
      messageId: answer.result.messageId,
      from: { name: "Icarus", kind: "agent" },
      accountable: { name: "Ana" },
      fromDriver: false,
    });
  }

  // It leaves; the Pair goes on, and its person stays one of the Pair's people.
  expect(await callAsAgent(p.t, icarus.key, "pairs.leave", { pairId: p.pairId })).toMatchObject({ status: 200 });
  expect(await callAsAgent(p.t, icarus.key, "pairs.messages", { pairId: p.pairId })).toMatchObject({ status: 404 });
  expect((await ana.as.query(api.pairs.list, {})).map((x) => x.pairId)).toEqual([p.pairId]);
});

test("nobody outside a Pair can find, read or write it: people, runs and agents all get not_found", async () => {
  const p = await paired();
  await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "the secret plan" });
  // Bo is signed in and in Julio's own team, but not in the Pair.
  const bo = await addTeammate(p.t, p.teamId, p.julio, "Bo");
  const boSignIn = await signInFromCli(p.t, clerk, { subject: "user_Bo", name: "Bo", email: "bo@example.com" });
  const boRun = await join(p.t, boSignIn, { teamId: p.teamId });
  const { icarus } = await anaWithAgent(p.t);

  for (const credential of [boSignIn, icarus.key]) {
    expect((await callAsAgent(p.t, credential, "pairs.list", {})).result).toEqual([]);
    for (const [fn, args] of [
      ["pairs.get", { pairId: p.pairId }],
      ["pairs.messages", { pairId: p.pairId }],
      ["pairs.post", { pairId: p.pairId, text: "let me in" }],
      ["pairs.markRead", { pairId: p.pairId }],
      ["pairs.leave", { pairId: p.pairId }],
    ] as const) {
      const answer = await callAsAgent(p.t, credential, fn, args);
      expect(answer.error?.code, `${fn} as ${credential.slice(0, 4)}`).toMatch(/not_found|invalid/);
    }
  }
  for (const fn of ["pairs.code", "pairs.end"]) expect(await callAsAgent(p.t, boSignIn, fn, { pairId: p.pairId })).toMatchObject({ status: 404 });
  await expect(bo.as.query(api.pairs.messages, { pairId: p.pairId })).rejects.toThrow(/No such Pair/);
  expect(await bo.as.query(api.pairs.list, {})).toEqual([]);

  // Bo's run can't post there, resume into it or read it either.
  expect(await callAsAgent(p.t, boRun.token, "joined.say", { in: p.pairId, text: "hi" })).toMatchObject({ status: 404 });
  expect(await callAsAgent(p.t, boRun.token, "joined.pairResume", { pairId: p.pairId })).toMatchObject({ status: 404 });
  expect((await callAsAgent(p.t, boRun.token, "joined.take", { how: "mid_task" })).result.messages).toEqual([]);
  // A pairId that isn't one is not found the same way.
  expect(await callAsAgent(p.t, boSignIn, "pairs.get", { pairId: "not-a-pair" })).toMatchObject({ status: 404 });
});

test("a run token from a Pair reaches no team function, and no team but its own run's", async () => {
  const p = await paired();
  // Pepe has a team of his own too, which Julio isn't in.
  const pepeApp = p.t.withIdentity({ subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" });
  await pepeApp.mutation(api.people.ensure, {});
  const pepeTeam = await pepeApp.mutation(api.teams.create, { name: "Pepe Labs" });
  const [pepeGeneral] = await pepeApp.query(api.channels.list, { teamId: pepeTeam });
  const teamMessage = await p.julio.as.mutation(api.messages.post, { teamId: p.teamId, channelId: p.general, body: "Nuko Nova only" });

  // Pepe's run joined in no team: its token reaches only run functions, and posts only in its Pairs.
  for (const fn of ["messages.post", "channels.list", "runs.live", "pairs.list", "pairs.post", "people.me"]) {
    const answer = await callAsAgent(p.t, p.pepeRun.token, fn, { teamId: p.teamId, channelId: p.general, body: "x", pairId: p.pairId, text: "x" });
    expect(answer, fn).toMatchObject({ status: 403, error: { code: "forbidden" } });
  }
  await expect(p.t.query(api.live.query, { key: p.pepeRun.token, fn: "pairs.messages", args: { pairId: p.pairId } })).rejects.toThrow(/only as its joined run/);
  expect(await callAsAgent(p.t, p.pepeRun.token, "joined.say", { in: p.general, text: "x" })).toMatchObject({ status: 403 });
  expect(await callAsAgent(p.t, p.pepeRun.token, "joined.say", { replyTo: teamMessage, text: "x" })).toMatchObject({ status: 403 });

  // Julio's run is in Nuko Nova: through the Pair it reaches nothing of Pepe's team.
  expect(await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: pepeGeneral!.channelId, text: "x" })).toMatchObject({ status: 404 });
  expect(await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "#general", text: "in my own team" })).toMatchObject({ status: 200, result: { place: "#general" } });
  expect((await pepeApp.query(api.messages.list, { teamId: pepeTeam, channelId: pepeGeneral!.channelId })) as unknown[]).toHaveLength(0);
});

test("an agent in a Pair reaches nothing of the other side's team, and the Pair shows no email, team or team id (D12)", async () => {
  const p = await paired();
  const { acmeId, icarus } = await anaWithAgent(p.t);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, icarus.key, "pairs.join", { code });
  await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "hello all" });

  // Its key stays in its own team: Julio's team is another team to it.
  for (const fn of ["channels.list", "runs.live", "teams.members", "tasks.board"]) {
    expect(await callAsAgent(p.t, icarus.key, fn, { teamId: p.teamId }), fn).toMatchObject({ status: 403, error: { code: "forbidden" } });
  }
  // Ids it sees in the Pair are the Pair's own: none names a member, a run or a team anywhere.
  const seen = JSON.stringify([
    (await callAsAgent(p.t, icarus.key, "pairs.list", {})).result,
    (await callAsAgent(p.t, icarus.key, "pairs.messages", { pairId: p.pairId })).result,
    (await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" })).result,
    (await callAsAgent(p.t, p.pepeRun.token, "joined.me", {})).result,
    await p.julio.as.query(api.pairs.list, {}),
  ]);
  const members = await p.julio.as.query(api.teams.members, { teamId: p.teamId });
  for (const secret of ["julio@example.com", "pepe@example.com", "ana@example.com", "Nuko Nova", "Acme", p.teamId, acmeId, p.julioRun.runId!, ...members.map((m) => m.memberId)]) {
    expect(seen).not.toContain(secret);
  }
  for (const id of JSON.parse(seen).flatMap((x: unknown) => JSON.stringify(x).match(/"(?:id|memberId)":"([^"]+)"/g) ?? [])) {
    const raw = id.split('"')[3];
    if (!raw) continue;
    const table = await p.t.run(async (ctx) =>
      (["pairPeople", "pairRuns", "pairAgents"] as const).find((name) => ctx.db.normalizeId(name, raw) !== null) ?? "other",
    );
    expect(table, raw).not.toBe("other");
  }
});

test("the people read and write a Pair in the app and with their sign-in, and what they write reaches every run", async () => {
  const p = await paired();
  await callAsAgent(p.t, p.pepeRun.token, "joined.say", { in: "pair", text: "schema v2 is in main" });

  // Julio in the app: the Pair, unread, then its messages.
  const [listed] = await p.julio.as.query(api.pairs.list, {});
  expect(listed).toMatchObject({ pairId: p.pairId, unread: 1, people: expect.arrayContaining([expect.objectContaining({ name: "Julio", you: true }), expect.objectContaining({ name: "Pepe" })]) });
  expect(listed!.runs.map((r) => r.label).sort()).toEqual(["Claude Code (Julio)", "Claude Code (Pepe)"]);
  const { messages } = await p.julio.as.query(api.pairs.messages, { pairId: p.pairId });
  expect(messages).toEqual([expect.objectContaining({ body: "schema v2 is in main", from: expect.objectContaining({ kind: "run", name: "Claude Code (Pepe)" }) })]);
  await p.julio.as.mutation(api.pairs.markRead, { pairId: p.pairId });
  expect((await p.julio.as.query(api.pairs.list, {}))[0]!.unread).toBe(0);

  // Julio writes in the app: both runs get it, his own labelled as from its driver.
  const posted = await p.julio.as.mutation(api.pairs.post, { pairId: p.pairId, text: "Pepe's run: please hold the deploy" });
  const toPepe = await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" });
  expect(toPepe.result.messages).toEqual([
    expect.objectContaining({ messageId: posted.messageId, from: expect.objectContaining({ name: "Julio", kind: "person" }), accountable: expect.objectContaining({ name: "Julio" }), fromDriver: false }),
  ]);
  const toJulio = await callAsAgent(p.t, p.julioRun.token, "joined.take", { how: "mid_task" });
  expect(toJulio.result.messages.map((m: { text: string; fromDriver: boolean }) => [m.text, m.fromDriver])).toEqual([
    ["schema v2 is in main", false],
    ["Pepe's run: please hold the deploy", true],
  ]);
  // His own message isn't unread for him; it is for Pepe, whose own run's message isn't.
  expect((await p.julio.as.query(api.pairs.list, {}))[0]!.unread).toBe(0);
  expect((await callAsAgent(p.t, p.pepeSignIn, "pairs.list", {})).result[0].unread).toBe(1);

  // Pepe writes with his CLI sign-in (no team needed).
  expect(await callAsAgent(p.t, p.pepeSignIn, "pairs.post", { pairId: p.pairId, text: "held" })).toMatchObject({ status: 200 });
});

test("a Pair belongs to its people: a run that ends leaves it, and its person's next run rejoins with --resume", async () => {
  const p = await paired();
  expect(await callAsAgent(p.t, p.pepeRun.token, "joined.leave", {})).toMatchObject({ status: 200 });
  const view = (await p.julio.as.query(api.pairs.list, {}))[0]!;
  expect(view.endedAt).toBeUndefined();
  expect(view.runs.map((r) => r.label)).toEqual(["Claude Code (Julio)"]);
  expect(view.people.map((x) => x.name).sort()).toEqual(["Julio", "Pepe"]);

  // Said while Pepe had no run: it waits for nobody, and Pepe reads it in the app.
  await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "while you were away" });
  const next = await join(p.t, p.pepeSignIn);
  const resumed = await callAsAgent(p.t, next.token, "joined.pairResume", {});
  expect(resumed).toMatchObject({ status: 200, result: { pairId: p.pairId, label: "Claude Code (Pepe)" } });
  const said = await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "welcome back" });
  expect((await callAsAgent(p.t, next.token, "joined.take", { how: "next_turn" })).result.messages).toEqual([
    expect.objectContaining({ messageId: said.result.messageId, text: "welcome back" }),
  ]);
  // Resuming again, or into a Pair you're not in, is refused.
  expect(await callAsAgent(p.t, next.token, "joined.pairResume", {})).toMatchObject({ status: 404 });
});

test("a Pair holds at most 10 runs and agents; a full Pair leaves the code unused", async () => {
  const p = await paired();
  const runs = [];
  for (let i = 0; i < 8; i++) runs.push(await join(p.t, p.pepeSignIn, { harness: `agent-${i}` }));
  for (const run of runs) {
    const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
    expect(await callAsAgent(p.t, run.token, "joined.pairJoin", { code })).toMatchObject({ status: 200 });
  }
  expect((await p.julio.as.query(api.pairs.list, {}))[0]!.runs).toHaveLength(10);
  const eleventh = await join(p.t, p.pepeSignIn, { harness: "agent-10" });
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  expect(await callAsAgent(p.t, eleventh.token, "joined.pairJoin", { code })).toMatchObject({ status: 409, error: { code: "conflict" } });
  // One leaves; the same code still works.
  await callAsAgent(p.t, runs[0]!.token, "joined.leave", {});
  expect(await callAsAgent(p.t, eleventh.token, "joined.pairJoin", { code })).toMatchObject({ status: 200 });
});

test("any of its people ends a Pair: its runs and agents leave, its codes stop working, and its people can still read it", async () => {
  const p = await paired();
  const { icarus } = await anaWithAgent(p.t);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, icarus.key, "pairs.join", { code });
  const pending = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result.code;
  await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "wrapping up" });

  // An agent can't end it; Pepe, one of its people, can, from the command line with no team.
  expect(await callAsAgent(p.t, icarus.key, "pairs.end", { pairId: p.pairId })).toMatchObject({ status: 403 });
  expect(await callAsAgent(p.t, p.pepeSignIn, "pairs.end", { pairId: p.pairId })).toMatchObject({ status: 200 });
  await p.t.finishInProgressScheduledFunctions();

  const [ended] = await p.julio.as.query(api.pairs.list, {});
  expect(ended).toMatchObject({ pairId: p.pairId, endReason: "ended", runs: [], agents: [] });
  expect((await p.julio.as.query(api.pairs.messages, { pairId: p.pairId })).messages.map((m) => m.body)).toEqual(["wrapping up"]);
  await expect(p.julio.as.mutation(api.pairs.post, { pairId: p.pairId, text: "more" })).rejects.toThrow(/ended/);
  expect(await callAsAgent(p.t, p.julioRun.token, "joined.say", { in: "pair", text: "x" })).toMatchObject({ status: 404 });
  // What waited for Pepe's run there can't reach it now.
  expect((await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" })).result.messages).toEqual([]);
  const other = await join(p.t, p.pepeSignIn, { harness: "codex" });
  expect(await callAsAgent(p.t, other.token, "joined.pairJoin", { code: pending })).toMatchObject({ status: 404 });
  expect(await callAsAgent(p.t, other.token, "joined.pairResume", {})).toMatchObject({ status: 404 });
  expect(await callAsAgent(p.t, icarus.key, "pairs.list", {})).toMatchObject({ result: [] });
});

test("leaving a team changes nothing about a person's Pairs (D10)", async () => {
  const p = await paired();
  const bo = await addTeammate(p.t, p.teamId, p.julio, "Bo");
  const boSignIn = await signInFromCli(p.t, clerk, { subject: "user_Bo", name: "Bo", email: "bo@example.com" });
  const boRun = await join(p.t, boSignIn, { teamId: p.teamId });
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, boRun.token, "joined.pairJoin", { code });

  await p.julio.as.mutation(api.members.remove, { teamId: p.teamId, memberId: bo.memberId });
  // Bo is still one of the Pair's people, reads it, and his next run, in no team, rejoins it.
  expect((await bo.as.query(api.pairs.list, {})).map((x) => x.pairId)).toEqual([p.pairId]);
  await bo.as.mutation(api.pairs.post, { pairId: p.pairId, text: "still here" });
  const teamless = await join(p.t, boSignIn);
  expect(await callAsAgent(p.t, teamless.token, "joined.pairResume", {})).toMatchObject({ status: 200, result: { pairId: p.pairId } });
});

test("deleting an account takes the person's runs and agents out, keeps their messages as A deleted account, and ends a Pair left with one person", async () => {
  const p = await paired();
  const { ana, icarus } = await anaWithAgent(p.t);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, icarus.key, "pairs.join", { code });
  await callAsAgent(p.t, p.pepeRun.token, "joined.say", { in: "pair", text: "from Pepe's run" });
  await callAsAgent(p.t, p.pepeSignIn, "pairs.post", { pairId: p.pairId, text: "from Pepe" });
  // A second Pair of only Pepe and Julio.
  const second = (await callAsAgent(p.t, p.pepeRun.token, "joined.pairCode", { new: true })).result;
  await callAsAgent(p.t, p.julioRun.token, "joined.pairJoin", { code: second.code });

  const pepeId = await p.t.run(async (ctx) => (await ctx.db.query("people").withIndex("by_subject", (q) => q.eq("subject", "user_Pepe")).unique())!._id);
  expect(await p.t.mutation(internal.pairs.forgetPerson, { personId: pepeId })).toEqual({ pairs: 2, ended: 1, more: false });
  await p.t.finishAllScheduledFunctions(() => {});

  // The first Pair goes on with Julio and Ana: Pepe's run left, his messages stay without his name.
  const pairs = await p.julio.as.query(api.pairs.list, {});
  const first = pairs.find((x) => x.pairId === p.pairId)!;
  expect(first.endedAt).toBeUndefined();
  expect(first.people.map((x) => x.name).sort()).toEqual(["Ana", "Julio"]);
  expect(first.runs.map((r) => r.label)).toEqual(["Claude Code (Julio)"]);
  const { messages } = await p.julio.as.query(api.pairs.messages, { pairId: p.pairId });
  expect(messages.map((m) => [m.body, m.from.name])).toEqual([
    ["from Pepe's run", "A deleted account"],
    ["from Pepe", "A deleted account"],
  ]);
  expect(JSON.stringify(messages)).not.toContain("Pepe)");
  // The second had only Pepe and Julio: it ended.
  expect(pairs.find((x) => x.pairId === second.pairId)).toMatchObject({ endReason: "too_few_people" });
  // Ana's agent is still there; deleting Ana's account would take it out.
  await p.t.mutation(internal.pairs.forgetPerson, { personId: ana.personId });
  expect(await callAsAgent(p.t, icarus.key, "pairs.list", {})).toMatchObject({ result: [] });
  expect((await p.julio.as.query(api.pairs.list, {})).find((x) => x.pairId === p.pairId)).toMatchObject({ endReason: "too_few_people" });
});

test("the hourly prune deletes pair codes a day after they expire, and failure counts whose hour is over", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const r = await room();
  const julioRun = await join(r.t, r.julioSignIn, { teamId: r.teamId });
  const pepeRun = await join(r.t, r.pepeSignIn);
  await callAsAgent(r.t, julioRun.token, "joined.pairCode", {});
  await callAsAgent(r.t, pepeRun.token, "joined.pairJoin", { code: "RIVER-0000-MAPLE-0000" });
  const count = () => r.t.run(async (ctx) => [(await ctx.db.query("pairCodes").collect()).length, (await ctx.db.query("pairCodeFailures").collect()).length]);

  vi.setSystemTime(new Date("2026-11-05T13:30:00Z"));
  await r.t.mutation(internal.pairs.prune, {});
  expect(await count()).toEqual([1, 0]);
  vi.setSystemTime(new Date("2026-11-06T12:11:00Z"));
  await r.t.mutation(internal.pairs.prune, {});
  expect(await count()).toEqual([0, 0]);
});

test("the same session joining again in no team keeps its Pairs, and joining a team leaves them", async () => {
  const p = await paired();
  const sessionRef = "pepe-session";
  const first = await join(p.t, p.pepeSignIn, { sessionRef });
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, first.token, "joined.pairJoin", { code });

  const again = await join(p.t, p.pepeSignIn, { sessionRef });
  expect(await callAsAgent(p.t, first.token, "joined.me", {})).toMatchObject({ status: 401 });
  expect((await callAsAgent(p.t, again.token, "joined.me", {})).result.pairs.map((x: { pairId: string }) => x.pairId)).toEqual([p.pairId]);

  // Pepe has a team now, and the session joins it: as a team run it is a new join, outside the Pair.
  const pepeApp = p.t.withIdentity({ subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" });
  const pepeTeam = await pepeApp.mutation(api.teams.create, { name: "Pepe Labs" });
  const teamed = await join(p.t, p.pepeSignIn, { sessionRef, teamId: pepeTeam });
  expect((await callAsAgent(p.t, teamed.token, "joined.me", {})).result.pairs).toEqual([]);
  expect(await callAsAgent(p.t, teamed.token, "joined.pairResume", {})).toMatchObject({ status: 200, result: { pairId: p.pairId } });
});

test("a person whose sign-in gave an email and no name shows in a Pair as Someone, never as the email (D12)", async () => {
  const p = await paired();
  // Clerk sent no name, so the room keeps the email as the person's name (lib/people.ts).
  const noNameSignIn = await signInFromCli(p.t, clerk, { subject: "user_NoName", name: "", email: "no.name@example.com" });
  const run = await join(p.t, noNameSignIn);
  expect(run.label).toBe("Claude Code (Someone)");
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  expect(await callAsAgent(p.t, run.token, "joined.pairJoin", { code })).toMatchObject({ status: 200 });
  await callAsAgent(p.t, run.token, "joined.say", { in: "pair", text: "hi from a nameless run" });
  await callAsAgent(p.t, noNameSignIn, "pairs.post", { pairId: p.pairId, text: "hi from the person" });

  const [view] = await p.julio.as.query(api.pairs.list, {});
  expect(view!.people.map((x) => x.name).sort()).toEqual(["Julio", "Pepe", "Someone"]);
  expect(view!.runs.map((r) => r.label).sort()).toEqual(["Claude Code (Julio)", "Claude Code (Pepe)", "Claude Code (Someone)"]);
  const seen = JSON.stringify([
    view,
    await p.julio.as.query(api.pairs.messages, { pairId: p.pairId }),
    (await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" })).result,
    (await callAsAgent(p.t, run.token, "joined.me", {})).result,
    (await callAsAgent(p.t, run.token, "joined.say", { in: "pair", text: "again" })).result,
    // The labels a message keeps are stored with it.
    await p.t.run(async (ctx) => ctx.db.query("pairMessages").collect()),
  ]);
  expect(seen).not.toContain("no.name");
  expect(seen).not.toContain("example.com");
});

test("an agent's Pair actions are in its team's activity log only for those in the Pair", async () => {
  const p = await paired();
  const { ana, acmeId, icarus } = await anaWithAgent(p.t);
  const ben = await addTeammate(p.t, acmeId, ana, "Ben");
  // A wrong code, then the right one; then it posts and reads.
  await callAsAgent(p.t, icarus.key, "pairs.join", { code: "RIVER-0000-MAPLE-0000" });
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  expect(await callAsAgent(p.t, icarus.key, "pairs.join", { code })).toMatchObject({ status: 200 });
  await callAsAgent(p.t, icarus.key, "pairs.post", { pairId: p.pairId, text: "hello" });
  await callAsAgent(p.t, icarus.key, "pairs.markRead", { pairId: p.pairId });
  await callAsAgent(p.t, icarus.key, "pairs.leave", { pairId: p.pairId });

  // Ana, accountable for Icarus and one of the Pair's people, sees what her agent did.
  const anaSees = await ana.as.query(api.activity.list, { teamId: acmeId });
  expect(anaSees.filter((e) => e.action.startsWith("api.pairs.")).map((e) => e.action).sort()).toEqual([
    "api.pairs.join",
    "api.pairs.join",
    "api.pairs.leave",
    "api.pairs.markRead",
    "api.pairs.post",
  ]);
  // Ben, her teammate outside the Pair, sees nothing of it: not that it exists, nor when it's busy.
  const benSees = await ben.as.query(api.activity.list, { teamId: acmeId });
  expect(benSees.filter((e) => e.action.startsWith("api.pairs."))).toEqual([]);
  expect(JSON.stringify(benSees)).not.toContain(p.pairId);
  expect(await ben.as.query(api.activity.list, { teamId: acmeId, target: p.pairId })).toEqual([]);
});

/** People who joined a Pair earlier and whose runs left it; `removed`: since deleted their accounts. */
async function earlierPeople(t: Room, pairId: string, count: number, opts: { removed?: boolean } = {}) {
  await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("pairs", pairId)!;
    for (let i = 0; i < count; i++) {
      const personId = await ctx.db.insert("people", { subject: `user_earlier_${Math.random()}`, name: `${opts.removed ? "Gone" : "Earlier"} ${i}` });
      await ctx.db.insert("pairPeople", { pairId: id, personId, joinedAt: Date.now(), readSeq: 0, ...(opts.removed ? { removedAt: Date.now() } : {}) });
    }
  });
}

test("a Pair's roster shows every one of its people however many came and went, and holds at most 20", async () => {
  const p = await paired();
  // Five whose accounts are gone, then 17 still in it whose runs left: 19 people with Julio and Pepe.
  await earlierPeople(p.t, p.pairId, 5, { removed: true });
  await earlierPeople(p.t, p.pairId, 17);
  const boSignIn = await signInFromCli(p.t, clerk, { subject: "user_Bo", name: "Bo", email: "bo@example.com" });
  const boRun = await join(p.t, boSignIn);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  expect(await callAsAgent(p.t, boRun.token, "joined.pairJoin", { code })).toMatchObject({ status: 200 });
  await callAsAgent(p.t, boRun.token, "joined.leave", {});

  // Bo's run left, and Bo is still one of the Pair's people, so everyone sees Bo there.
  const [view] = await p.julio.as.query(api.pairs.list, {});
  expect(view!.people).toHaveLength(20);
  expect(view!.people.map((x) => x.name)).toEqual(expect.arrayContaining(["Julio", "Pepe", "Bo"]));
  // Nobody whose account is gone.
  expect(view!.people.map((x) => x.name)).not.toContain("Gone 0");

  // A 21st person can't join, and the code is left unused; another run of someone in it can.
  const cySignIn = await signInFromCli(p.t, clerk, { subject: "user_Cy", name: "Cy", email: "cy@example.com" });
  const cyRun = await join(p.t, cySignIn);
  const next = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result.code;
  expect(await callAsAgent(p.t, cyRun.token, "joined.pairJoin", { code: next })).toMatchObject({ status: 409, error: { code: "conflict" } });
  const boAgain = await join(p.t, boSignIn);
  expect(await callAsAgent(p.t, boAgain.token, "joined.pairJoin", { code: next })).toMatchObject({ status: 200 });
});

test("an agent still lists its Pair after leaving 200 newer ones", async () => {
  const p = await paired();
  const { icarus } = await anaWithAgent(p.t);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, icarus.key, "pairs.join", { code });
  // Then 200 Pairs it joined and left, each newer than the one it is still in.
  await p.t.run(async (ctx) => {
    const { agentId, memberId, teamId, personId } = (await ctx.db.query("pairAgents").collect())[0]!;
    for (let i = 0; i < 200; i++) {
      const pairId = await ctx.db.insert("pairs", { createdBy: personId, createdAt: Date.now(), seq: 0 });
      await ctx.db.insert("pairAgents", { pairId, agentId, memberId, teamId, personId, joinedAt: Date.now(), readSeq: 0, leftAt: Date.now() });
    }
  });
  const listed = await callAsAgent(p.t, icarus.key, "pairs.list", {});
  expect(listed.result.map((x: { pairId: string }) => x.pairId)).toEqual([p.pairId]);
});

test("deleting an account counts every person left in a Pair, not only its first rows", async () => {
  const p = await paired();
  await earlierPeople(p.t, p.pairId, 20, { removed: true });
  const boSignIn = await signInFromCli(p.t, clerk, { subject: "user_Bo", name: "Bo", email: "bo@example.com" });
  const boRun = await join(p.t, boSignIn);
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await callAsAgent(p.t, boRun.token, "joined.pairJoin", { code });

  const pepeId = await p.t.run(async (ctx) => (await ctx.db.query("people").withIndex("by_subject", (q) => q.eq("subject", "user_Pepe")).unique())!._id);
  await p.t.mutation(internal.pairs.forgetPerson, { personId: pepeId });
  await p.t.finishAllScheduledFunctions(() => {});
  // Julio and Bo are left: the Pair goes on.
  const [view] = await p.julio.as.query(api.pairs.list, {});
  expect(view!.endedAt).toBeUndefined();
  expect(view!.people.map((x) => x.name).sort()).toEqual(["Bo", "Julio"]);
});

test("deleting the account of someone in 1,500 ended Pairs fits Convex's limits, in steps that resume where they stopped", async () => {
  const t = newLimitedRoom();
  const [pepe, julio] = await t.run(async (ctx) => [
    await ctx.db.insert("people", { subject: "user_Pepe", name: "Pepe" }),
    await ctx.db.insert("people", { subject: "user_Julio", name: "Julio" }),
  ]);
  for (let chunk = 0; chunk < 5; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const pairId = await ctx.db.insert("pairs", { createdBy: pepe, createdAt: Date.now(), seq: 0, endedAt: Date.now(), endReason: "ended" });
        for (const personId of [pepe, julio]) await ctx.db.insert("pairPeople", { pairId, personId, joinedAt: Date.now(), readSeq: 0 });
      }
    });
  }
  await t.run(async (ctx) => ctx.db.insert("pairCodeFailures", { personId: pepe, windowStart: Date.now(), failures: 3 }));
  const left = () =>
    t.run(async (ctx) => (await ctx.db.query("pairPeople").withIndex("by_person_removed", (q) => q.eq("personId", pepe).eq("removedAt", undefined)).collect()).length);

  // The first step commits on its own; the rest wait in scheduled steps.
  await t.mutation(internal.pairs.forgetPerson, { personId: pepe });
  expect(await left()).toBeLessThan(1500);
  expect(await left()).toBeGreaterThan(0);
  // A step that failed, or a deletion started again, picks up where the last one stopped.
  await t.mutation(internal.pairs.forgetPerson, { personId: pepe });
  await t.finishAllScheduledFunctions(() => {});
  expect(await left()).toBe(0);
  expect(await t.run(async (ctx) => (await ctx.db.query("pairPeople").withIndex("by_person_removed", (q) => q.eq("personId", julio).eq("removedAt", undefined)).collect()).length)).toBe(1500);
  expect(await t.run(async (ctx) => ctx.db.query("pairCodeFailures").collect())).toEqual([]);
});

// ---------- the app's side (slice 12 of #139) ----------

test("a person makes a Pair in the app, with no run and no team, and its code lets someone's run join", async () => {
  const { t, pepeSignIn } = await room();
  // Ruth is signed in to the app and in no team.
  const ruth = await signIn(t, "Ruth");
  const made = await ruth.as.mutation(api.pairs.create, {});
  expect(made).toMatchObject({ pairId: expect.any(String), runs: [], agents: [], people: [expect.objectContaining({ name: "Ruth", you: true })] });
  const { code } = await ruth.as.mutation(api.pairs.code, { pairId: made.pairId });

  const pepeRun = await join(t, pepeSignIn);
  expect(await callAsAgent(t, pepeRun.token, "joined.pairJoin", { code })).toMatchObject({ status: 200, result: { pairId: made.pairId } });
  const [listed] = await ruth.as.query(api.pairs.list, {});
  expect(listed).toMatchObject({ pairId: made.pairId, runs: [expect.objectContaining({ label: "Claude Code (Pepe)" })] });
  // An agent can't make one: a Pair belongs to people.
  const { icarus } = await anaWithAgent(t);
  expect(await callAsAgent(t, icarus.key, "pairs.create", {})).toMatchObject({ status: 403 });
});

test("a person joins a Pair with a code from the app, and wrong codes count against them as a run's do", async () => {
  const p = await paired();
  const ruth = await signIn(p.t, "Ruth");
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;

  const joined = await ruth.as.mutation(api.pairs.join, { code: code.toLowerCase() });
  expect(joined).toMatchObject({ pairId: p.pairId });
  expect((joined as { people: { name: string }[] }).people.map((x) => x.name).sort()).toEqual(["Julio", "Pepe", "Ruth"]);
  // She reads from now on, and writes there; the code is used.
  await ruth.as.mutation(api.pairs.post, { pairId: p.pairId, text: "Hi, I'm Pepe's reviewer" });
  expect((await callAsAgent(p.t, p.pepeRun.token, "joined.take", { how: "mid_task" })).result.messages.at(-1)).toMatchObject({ from: { name: "Ruth", kind: "person" } });
  const sam = await signIn(p.t, "Sam");
  // A refusal is returned, not thrown, so the count of wrong codes is kept.
  expect(await sam.as.mutation(api.pairs.join, { code })).toEqual({ refused: { code: "not_found", message: expect.stringMatching(/wrong, was used already, or is more than 10 minutes old/) } });
  for (let i = 0; i < 9; i++) await sam.as.mutation(api.pairs.join, { code: "RIVER-0000-MAPLE-0000" });
  const fresh = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result.code;
  expect(await sam.as.mutation(api.pairs.join, { code: fresh })).toEqual({ refused: { code: "forbidden", message: expect.stringMatching(/^Too many wrong pair codes: no pair code works for you for \d+ more minutes?\.$/) } });
  // Someone already in it is told so, and the code is left for another.
  await expect(ruth.as.mutation(api.pairs.join, { code: fresh })).rejects.toThrow(/already in that Pair/);
});

test("a person leaves a Pair: their runs leave with them, they read it no more, and a Pair left with one person ends", async () => {
  const p = await paired();
  const ruth = await signIn(p.t, "Ruth");
  const { code } = (await callAsAgent(p.t, p.julioRun.token, "joined.pairCode", {})).result;
  await ruth.as.mutation(api.pairs.join, { code });

  // Pepe leaves from the command line: his run is out, the Pair goes on with Julio and Ruth.
  expect(await callAsAgent(p.t, p.pepeSignIn, "pairs.leave", { pairId: p.pairId })).toMatchObject({ status: 200 });
  const [view] = await p.julio.as.query(api.pairs.list, {});
  expect(view!.endedAt).toBeUndefined();
  expect(view!.people.map((x) => x.name).sort()).toEqual(["Julio", "Ruth"]);
  expect(view!.runs.map((r) => r.label)).toEqual(["Claude Code (Julio)"]);
  expect(await callAsAgent(p.t, p.pepeSignIn, "pairs.messages", { pairId: p.pairId })).toMatchObject({ status: 404 });
  expect(await callAsAgent(p.t, p.pepeRun.token, "joined.pairResume", {})).toMatchObject({ status: 404 });

  // Ruth leaves in the app: one person is left, so the Pair ends, and Julio still reads it.
  await ruth.as.mutation(api.pairs.leave, { pairId: p.pairId });
  expect(await ruth.as.query(api.pairs.list, {})).toEqual([]);
  expect((await p.julio.as.query(api.pairs.list, {}))[0]).toMatchObject({ pairId: p.pairId, endReason: "too_few_people", runs: [] });
});

test("a person makes at most 10 Pairs an hour and has at most 20 open that they made, from the app or a run; ending one makes room", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date"] });
  const { t, pepeSignIn } = await room();
  const ruth = await signIn(t, "Ruth");
  const made: string[] = [];
  for (let i = 0; i < 10; i++) made.push((await ruth.as.mutation(api.pairs.create, {})).pairId);
  await expect(ruth.as.mutation(api.pairs.create, {})).rejects.toThrow(/at most 10 Pairs an hour/);
  vi.setSystemTime(new Date("2026-11-05T13:00:01Z"));
  for (let i = 0; i < 10; i++) made.push((await ruth.as.mutation(api.pairs.create, {})).pairId);
  vi.setSystemTime(new Date("2026-11-05T14:00:02Z"));
  await expect(ruth.as.mutation(api.pairs.create, {})).rejects.toThrow(/20 open Pairs/);
  // Ending one of them makes room for another.
  await ruth.as.mutation(api.pairs.end, { pairId: made[0]! });
  expect(await ruth.as.mutation(api.pairs.create, {})).toMatchObject({ pairId: expect.any(String) });

  // A run's uplink pair makes Pairs for its person under the same limits.
  const pepeRun = await join(t, pepeSignIn);
  for (let i = 0; i < 10; i++) expect(await callAsAgent(t, pepeRun.token, "joined.pairCode", { new: true })).toMatchObject({ status: 200 });
  expect(await callAsAgent(t, pepeRun.token, "joined.pairCode", { new: true })).toMatchObject({ status: 409, error: { message: expect.stringMatching(/at most 10 Pairs an hour/) } });
});

test("the app pages through every Pair of a person's, however many, newest first", async () => {
  const t = newRoom();
  const ruth = await signIn(t, "Ruth");
  const ruthId = await t.run(async (ctx) => (await ctx.db.query("people").collect()).find((p) => p.name === "Ruth")!._id);
  const ids = await t.run(async (ctx) => {
    const made: string[] = [];
    for (let i = 0; i < 130; i++) {
      const pairId = await ctx.db.insert("pairs", { createdBy: ruthId, createdAt: Date.now(), seq: 0, endedAt: Date.now(), endReason: "ended" });
      await ctx.db.insert("pairPeople", { pairId, personId: ruthId, joinedAt: Date.now(), readSeq: 0 });
      made.push(pairId);
    }
    return made;
  });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: { page: { pairId: string }[]; isDone: boolean; continueCursor: string } = await ruth.as.query(api.pairs.listPage, { paginationOpts: { numItems: 50, cursor } });
    seen.push(...page.page.map((p) => p.pairId));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(seen).toEqual([...ids].reverse());
  // The oldest is read on its own, as the app opens one.
  expect(await ruth.as.query(api.pairs.get, { pairId: ids[0]! })).toMatchObject({ pairId: ids[0] });
});

test("the app pages through a Pair's messages, newest first, back to the first", async () => {
  const { t } = await room();
  const ruth = await signIn(t, "Ruth");
  const { pairId } = await ruth.as.mutation(api.pairs.create, {});
  for (let i = 1; i <= 120; i++) await ruth.as.mutation(api.pairs.post, { pairId, text: `message ${i}` });
  const seqs: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: { page: { seq: number }[]; isDone: boolean; continueCursor: string } = await ruth.as.query(api.pairs.messagesPage, { pairId, paginationOpts: { numItems: 50, cursor } });
    seqs.push(...page.page.map((m) => m.seq));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(seqs).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
  // Without paging, it is the newest 50, oldest first, as before.
  expect((await ruth.as.query(api.pairs.messages, { pairId })).messages.map((m) => m.seq)[0]).toBe(71);
});
