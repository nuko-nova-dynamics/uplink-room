/**
 * Joined runs (ADR 0027, ADR 0029 D8 and D13, slice 10 of #139): a Claude Code or Codex session that
 * wasn't started through Uplink Room joins a team with `uplink join`, as its signed-in person. It
 * becomes a live run named like any other, listed in runs.live while its heartbeat lasts, never in
 * anyone's Needs you, and acts only through its own run token.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CLIENT_ID, fakeClerk, type FakeClerk } from "./fakeClerk";
import { addTeammate, callAsAgent, newRoom, newTeam, signInFromCli, type Room } from "./setup";

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

/** Julio's team, with Pepe in it, signed in on his laptop's command line. */
async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const pepe = await addTeammate(t, teamId, julio, "Pepe");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const signIn = await signInFromCli(t, clerk, { subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" });
  return { t, teamId, julio, pepe, signIn, general: general!.channelId };
}

type JoinArgs = { teamId?: Id<"teams">; harness?: string; sessionRef?: string; title?: string; hearing?: string; open?: boolean };

/**
 * `uplink join --open`: the session joins the team with the person's CLI sign-in, open to the team,
 * as these tests of what the team sees and sends need. Pass open: undefined for a plain `uplink
 * join`, which starts closed (ADR 0044).
 */
async function join(t: Room, signIn: string, args: JoinArgs = {}) {
  return callAsAgent(t, signIn, "joined.start", { harness: "claude-code", sessionRef: "session-1", hearing: "mid_task", open: true, ...args });
}

test("a session joins a team as a live run of its person, named like any run and in nobody's Needs you", async () => {
  const { t, teamId, julio, pepe, signIn } = await room();

  const joined = await join(t, signIn, { teamId, title: "payments on Pepe's laptop" });
  expect(joined).toMatchObject({
    status: 200,
    ok: true,
    result: { token: expect.stringMatching(/^urj_[0-9a-f]{48}$/), label: "Claude Code (Pepe)", teamId, hearing: "mid_task" },
  });
  const { runId } = joined.result;

  const live = await julio.as.query(api.runs.live, { teamId });
  expect(live).toEqual([
    expect.objectContaining({
      runId,
      token: `<@run:${runId}>`,
      label: "Claude Code (Pepe)",
      harness: "claude-code",
      title: "payments on Pepe's laptop",
      via: "joined",
      driver: expect.objectContaining({ name: "Pepe" }),
      accountable: expect.objectContaining({ name: "Pepe" }),
      hearing: "mid_task",
      hearsYou: true,
    }),
  ]);
  expect(live[0]!.machine).toBeUndefined();

  // Live in the roster, and never waiting on anyone (D13): a joined run reports no state.
  const roster = await julio.as.query(api.teams.roster, { teamId });
  expect(roster).toContainEqual(expect.objectContaining({ kind: "harness", name: "claude-code", runs: 1, joined: 1 }));
  // The app shows it as joined: it has no terminal or thread to open.
  expect(await julio.as.query(api.runs.get, { teamId, runId })).toMatchObject({ joined: true });
  for (const who of [julio, pepe]) {
    const inbox = await who.as.query(api.inbox.get, { teamId, view: "team" });
    expect(inbox.needsYou).toEqual([]);
  }
});

test("a join without a team can only pair (D13): it is a run in no team, and only a CLI sign-in joins", async () => {
  const { t, teamId, pepe, signIn } = await room();
  const teamless = await join(t, signIn);
  expect(teamless).toMatchObject({ status: 200, result: { token: expect.stringMatching(/^urj_/), label: "Claude Code (Pepe)" } });
  expect(teamless.result.runId).toBeUndefined();
  expect(teamless.result.teamId).toBeUndefined();
  // It posts in no team's place: only in its Pairs.
  const posted = await callAsAgent(t, teamless.result.token, "joined.say", { in: "#general", text: "hello" });
  expect(posted).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(posted.error!.message).toMatch(/only pair/);
  expect(await callAsAgent(t, teamless.result.token, "joined.me", {})).toMatchObject({ result: { label: "Claude Code (Pepe)", pairs: [] } });

  // In the app there is no harness session to join.
  await expect(pepe.as.mutation(api.joined.start, { teamId, harness: "claude-code", sessionRef: "s", hearing: "none" })).rejects.toThrow(/uplink join/);
  expect(await pepe.as.query(api.runs.live, { teamId })).toEqual([]);
});

test("a plain uplink join starts closed: its person sees it, and for the rest of the team it isn't there (ADR 0044)", async () => {
  const { t, teamId, julio, pepe, signIn, general } = await room();
  const joined = await join(t, signIn, { teamId, title: "secret refactor", open: undefined });
  expect(joined.result).toMatchObject({ open: false });
  const { token, runId } = joined.result;
  expect((await callAsAgent(t, token, "joined.me")).result).toMatchObject({ runId, open: false });

  // Pepe and his agents see it; Julio, an admin, doesn't, anywhere.
  expect(await pepe.as.query(api.runs.live, { teamId })).toEqual([
    expect.objectContaining({ runId, open: false, title: "secret refactor" }),
  ]);
  expect(await julio.as.query(api.runs.live, { teamId })).toEqual([]);
  expect(await julio.as.query(api.teams.roster, { teamId })).not.toContainEqual(
    expect.objectContaining({ kind: "harness", name: "claude-code" }),
  );
  expect(
    JSON.stringify(await julio.as.query(api.inbox.get, { teamId, view: "team" })),
  ).not.toContain(runId);
  expect(JSON.stringify(await julio.as.query(api.runs.unfiled, { teamId }))).not.toContain(runId);
  expect(JSON.stringify(await julio.as.query(api.activity.list, { teamId }))).not.toContain(runId);
  await expect(julio.as.query(api.runs.get, { teamId, runId })).rejects.toThrow(/Not found/);
  await expect(julio.as.query(api.runs.inbox, { teamId, runId })).rejects.toThrow(/Not found/);
  await expect(julio.as.mutation(api.runs.stop, { teamId, runId })).rejects.toThrow(/Not found/);
  await expect(
    julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] }),
  ).rejects.toThrow(/Not found/);

  // Julio can't message it: naming it is refused, and its token in a message addresses nothing.
  await expect(
    julio.as.mutation(api.messages.post, {
      teamId,
      channelId: general,
      body: "status?",
      addressedRuns: [runId],
    }),
  ).rejects.toThrow(/Not found/);
  await expect(
    julio.as.mutation(api.messages.post, {
      teamId,
      channelId: general,
      body: "status?",
      mentionedRuns: [runId],
    }),
  ).rejects.toThrow(/Not found/);
  await julio.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: `<@run:${runId}> status?`,
  });
  const watch = () => t.query(api.live.query, { key: token, fn: "joined.waiting", args: {} });
  expect(await watch()).toEqual({ waiting: 0 });

  // Its person still can.
  await pepe.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: `<@run:${runId}> keep going`,
  });
  expect(await watch()).toEqual({ waiting: 1 });
  // A task is the team's, so a closed run is opened before it goes under one.
  await expect(
    pepe.as.mutation(api.runs.file, { teamId, runId, newTask: { title: "Refactor" } }),
  ).rejects.toThrow(/open it first/);
  // Nor can its person bring a teammate into a direct message with it.
  const { memberId: julioId } = await julio.as.query(api.members.me, { teamId });
  await expect(pepe.as.mutation(api.channels.openDirect, { teamId, memberIds: [julioId], runIds: [runId] })).rejects.toThrow(/closed/);
  // Nor through a run of Julio's, whose person the direct message would add.
  const julioSignIn = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
  const julios = (await join(t, julioSignIn, { teamId, sessionRef: "julio-session" })).result;
  await expect(pepe.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId, julios.runId] })).rejects.toThrow(/closed/);

  // Its name still counts: a second, open session of Pepe's is Claude Code 2 (Pepe) for everyone.
  const second = (await join(t, signIn, { teamId, sessionRef: "session-2" })).result;
  const forJulio = await julio.as.query(api.runs.live, { teamId });
  expect(forJulio).toContainEqual(expect.objectContaining({ runId: second.runId, label: "Claude Code 2 (Pepe)" }));
  expect(JSON.stringify(forJulio)).not.toContain(runId);
});

test("its person opens a joined run to the team and closes it again, and joining again keeps what it was", async () => {
  const { t, teamId, julio, pepe, signIn } = await room();
  const { token, runId } = (await join(t, signIn, { teamId, open: undefined })).result;

  // uplink open: the session's own token opens it.
  expect((await callAsAgent(t, token, "joined.setOpen", { open: true })).result).toEqual({
    runId,
    open: true,
  });
  expect(await julio.as.query(api.runs.live, { teamId })).toEqual([
    expect.objectContaining({ runId, open: true, hearsYou: true }),
  ]);
  // Only its driver changes it.
  await expect(julio.as.mutation(api.runs.setOpen, { teamId, runId, open: false })).rejects.toThrow(
    /Only the run's driver/,
  );

  // Its person closes it from the app or the command line, and it's gone for Julio again.
  expect(await pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: false })).toEqual({
    runId,
    open: false,
  });
  expect(await julio.as.query(api.runs.live, { teamId })).toEqual([]);
  await expect(julio.as.mutation(api.runs.setOpen, { teamId, runId, open: true })).rejects.toThrow(
    /Not found/,
  );

  // Joining the same session again keeps it closed; with --open it opens.
  expect((await join(t, signIn, { teamId, open: undefined })).result).toMatchObject({
    runId,
    open: false,
  });
  expect((await join(t, signIn, { teamId, open: true })).result).toMatchObject({
    runId,
    open: true,
  });
  expect((await join(t, signIn, { teamId, open: undefined })).result).toMatchObject({
    runId,
    open: true,
  });

  // A direct message Julio opened with it while it was open no longer shows it.
  await pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: true });
  const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId;
  await pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: false });
  const listed = (await julio.as.query(api.channels.list, { teamId })).find((c: any) => c.channelId === dm) as any;
  expect(listed.runs).toEqual([]);
  expect(listed.name).not.toMatch(/Claude Code/);

  // A run filed under a task, which the team sees, stays open.
  await pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: true });
  await pepe.as.mutation(api.runs.file, { teamId, runId, newTask: { title: "Refactor" } });
  await expect(pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: false })).rejects.toThrow(/filed under a task/);
  await pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: true });
});

test("a message waiting from a teammate when the run closes isn't handed over", async () => {
  const { t, teamId, julio, pepe, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const messageId = await julio.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: `<@run:${runId}> status?`,
  });
  await pepe.as.mutation(api.runs.setOpen, { teamId, runId, open: false });
  expect((await callAsAgent(t, token, "joined.take", { how: "mid_task" })).result.messages).toEqual(
    [],
  );
  expect((await pepe.as.query(api.runs.inbox, { teamId, runId })).messages).toEqual([
    expect.objectContaining({ messageId, status: "failed", error: "not_heard" }),
  ]);
});

test("a run token acts only as its run: it posts as the run, and reaches no other function", async () => {
  const { t, teamId, julio, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;

  const said = await callAsAgent(t, token, "joined.say", { in: "#general", text: "taking the payments migration" });
  expect(said).toMatchObject({ status: 200, result: { label: "Claude Code (Pepe)", place: "#general" } });
  const [posted] = (await julio.as.query(api.messages.list, { teamId, channelId: general })) as any[];
  expect(posted).toMatchObject({
    messageId: said.result.messageId,
    body: "taking the payments migration",
    author: expect.objectContaining({ name: "Pepe" }),
    asRun: { runId, label: "Claude Code (Pepe)" },
  });
  const reply = await callAsAgent(t, token, "joined.say", { replyTo: said.result.messageId, text: "done" });
  expect(reply).toMatchObject({ status: 200, result: { place: "a thread in #general" } });

  // The token reaches no team or account function, and the person's sign-in no run function.
  for (const fn of ["messages.post", "runs.live", "people.me"]) {
    expect(await callAsAgent(t, token, fn, { channelId: general, body: "x" })).toMatchObject({ status: 403, error: { code: "forbidden" } });
  }
  expect(await callAsAgent(t, signIn, "joined.say", { in: "#general", text: "x" })).toMatchObject({ status: 403, error: { code: "forbidden" } });
  await expect(t.query(api.live.query, { key: token, fn: "channels.list", args: {} })).rejects.toThrow(/only as its joined run/);
});

test("a joined run sends files with what it posts (ADR 0047), uploaded as its person's; a run in no team and no Pair has nowhere to send one", async () => {
  const { t, teamId, julio, signIn, general } = await room();
  const { token } = (await join(t, signIn, { teamId })).result;
  const upload = await callAsAgent(t, token, "joined.attachUrl", {});
  expect(upload).toMatchObject({ status: 200, result: { uploadUrl: expect.any(String), uploadId: expect.any(String) } });
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png bytes"], { type: "image/png" })));

  const said = await callAsAgent(t, token, "joined.say", {
    in: "#general",
    text: "",
    attachments: [{ uploadId: upload.result.uploadId, storageId, name: "chart.png" }],
  });
  expect(said).toMatchObject({ status: 200, result: { place: "#general" } });
  const [posted] = (await julio.as.query(api.messages.list, { teamId, channelId: general })) as any[];
  expect(posted).toMatchObject({ messageId: said.result.messageId, author: expect.objectContaining({ name: "Pepe" }), attachments: [{ name: "chart.png", kind: "image" }] });
  expect(await callAsAgent(t, token, "joined.say", { in: "#general", text: "" })).toMatchObject({ status: 400, error: { message: expect.stringMatching(/text or a file/) } });

  const teamless = await join(t, signIn, { teamId: undefined, sessionRef: "session-2" });
  // Once it is in a Pair, its uploads are for its Pairs (ADR 0048, tests/pairAttachments.test.ts).
  expect(await callAsAgent(t, teamless.result.token, "joined.attachUrl", {})).toMatchObject({ status: 404, error: { message: expect.stringMatching(/no team and no Pair/) } });
});

test("a message to a joined run waits in its inbox until the session takes it, labelled with who sent it", async () => {
  const { t, teamId, julio, pepe, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const watch = () => t.query(api.live.query, { key: token, fn: "joined.waiting", args: {} });
  expect(await watch()).toEqual({ waiting: 0 });

  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> pause the migration, I'm taking over` });
  expect(await watch()).toEqual({ waiting: 1 });

  const taken = await callAsAgent(t, token, "joined.take", { how: "mid_task" });
  expect(taken.result).toEqual({
    claimId: expect.any(String),
    waiting: 0,
    messages: [
      {
        deliveryId: expect.any(String),
        messageId,
        channelId: general,
        place: "#general",
        text: "@Claude Code (Pepe) pause the migration, I'm taking over",
        from: { memberId: expect.any(String), name: "Julio", kind: "person" },
        accountable: { memberId: expect.any(String), name: "Julio" },
        fromDriver: false,
        at: expect.any(Number),
      },
    ],
  });
  expect(await watch()).toEqual({ waiting: 0 });
  // Taken once: the next take finds nothing. Until the session says it has it, it is on its way.
  expect((await callAsAgent(t, token, "joined.take", { how: "next_turn" })).result.messages).toEqual([]);
  const driverView = async () => (await pepe.as.query(api.runs.inbox, { teamId, runId })).messages;
  expect(await driverView()).toEqual([expect.objectContaining({ messageId, status: "waiting" })]);

  // One the session couldn't show goes back, and waits again.
  expect((await callAsAgent(t, token, "joined.release", { claimId: taken.result.claimId })).result).toEqual({ released: 1 });
  expect(await watch()).toEqual({ waiting: 1 });

  // Once the session has it, it is delivered, how it was taken.
  const again = await callAsAgent(t, token, "joined.take", { how: "next_turn" });
  expect(await callAsAgent(t, token, "joined.ack", { claimId: again.result.claimId })).toMatchObject({ status: 200, result: { delivered: 1 } });
  expect(await driverView()).toEqual([expect.objectContaining({ messageId, status: "delivered", how: "next_turn" })]);
});

test("a joined run is the team's, so a message from a private channel never reaches it, even one that waited from before the rule (ADR 0039)", async () => {
  const { t, teamId, julio, pepe, signIn } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [pepe.memberId] });
  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the launch date is the 9th` });
  expect((await pepe.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ messageId, status: "failed", error: "visible_outside" }]);
  const page = (await pepe.as.query(api.messages.list, { teamId, channelId: launch, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(page.page.find((m) => m.system?.kind === "run").system.text).toBe("Claude Code (Pepe) is visible to people outside #launch, so it can't hear messages from here.");

  // A message that was already waiting for the run when the rule came is failed when the session takes it.
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  await t.run(async (ctx) => {
    await ctx.db.insert("runInbox", {
      teamId,
      runId: runId as Id<"runs">,
      messageId,
      channelId: launch,
      from: { memberId: julioId },
      accountableId: julioId,
      fromDriver: false,
      status: "waiting",
      at: Date.now(),
    });
  });
  expect((await callAsAgent(t, token, "joined.take", { how: "mid_task" })).result).toMatchObject({ messages: [], waiting: 0 });
  expect((await pepe.as.query(api.runs.inbox, { teamId, runId })).messages!.map((m) => [m.status, m.error])).toEqual([
    ["failed", "visible_outside"],
    ["failed", "visible_outside"],
  ]);
});

test("a direct message opened with a joined run reaches it, and says first that the whole team can see its output, while a private channel still can't (ADR 0039, 2026-11-05)", async () => {
  const { t, teamId, julio, pepe, signIn } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const channelId = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId;
  const listed = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId);
  expect(listed).toMatchObject({ runs: [{ runId, warning: "Claude Code (Pepe)'s output is visible to the whole team, so what you send here won't stay private." }] });
  await julio.as.mutation(api.messages.post, { teamId, channelId, body: "can you take the billing review?", acknowledgeWarning: true });
  // #launch mentions the same run: a private channel isn't one it was opened with.
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [pepe.memberId] });
  const mention = await julio.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the launch date is the 9th` });
  const taken = await callAsAgent(t, token, "joined.take", { how: "mid_task" });
  expect(taken.result.messages.map((m: { text: string }) => m.text)).toEqual(["can you take the billing review?"]);
  expect((await pepe.as.query(api.runs.inbox, { teamId, runId })).messages).toContainEqual(expect.objectContaining({ messageId: mention, status: "failed", error: "visible_outside" }));
});

test("a take hands over only whole messages that fit in one delivery, as the bridge's claims do, and says how many wait", async () => {
  const { t, teamId, julio, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  for (const word of ["first", "second"]) {
    await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> ${word} ${"x".repeat(5000)}` });
  }
  // Two 5,000-character messages don't fit in one 9,000-character delivery.
  const first = await callAsAgent(t, token, "joined.take", { how: "mid_task", reserve: 200 });
  expect(first.result.messages.map((m: { text: string }) => m.text.split(" ")[3])).toEqual(["first"]);
  expect(first.result.waiting).toBe(1);
  const second = await callAsAgent(t, token, "joined.take", { how: "mid_task", reserve: 200 });
  expect(second.result.messages.map((m: { text: string }) => m.text.split(" ")[3])).toEqual(["second"]);
  expect(second.result.waiting).toBe(0);
});

test("a message taken and never acknowledged waits again once its lease runs out, then fails as unsure", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { t, teamId, julio, pepe, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> ping` });
  const watch = () => t.query(api.live.query, { key: token, fn: "joined.waiting", args: {} });
  const status = async () => (await pepe.as.query(api.runs.inbox, { teamId, runId })).messages!.map((m) => [m.messageId, m.status, m.error]);
  // The lease runs out while heartbeats keep the run live.
  const expire = async () => {
    for (const ms of [60_000, 60_001]) {
      vi.advanceTimersByTime(ms);
      await t.finishInProgressScheduledFunctions();
      await callAsAgent(t, token, "joined.heartbeat");
    }
  };

  // The hook took it and died before its output reached the session: after the lease, it waits again.
  expect((await callAsAgent(t, token, "joined.take", { how: "mid_task" })).result.messages).toHaveLength(1);
  await expire();
  expect(await watch()).toEqual({ waiting: 1 });
  expect(await status()).toEqual([[messageId, "waiting", undefined]]);

  // A second take that is never acknowledged: the session may have it, so it fails rather than come a third time.
  const second = await callAsAgent(t, token, "joined.take", { how: "mid_task" });
  expect(second.result.messages).toHaveLength(1);
  await expire();
  expect(await watch()).toEqual({ waiting: 0 });
  expect(await status()).toEqual([[messageId, "failed", "unsure"]]);
  // A late acknowledgement of an expired lease changes nothing.
  expect((await callAsAgent(t, token, "joined.ack", { claimId: second.result.claimId })).result).toEqual({ delivered: 0 });
});

test("a message waiting from someone the driver has since stopped hearing isn't handed over", async () => {
  const { t, teamId, julio, pepe, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  await pepe.as.mutation(api.runs.setHears, { teamId, runId, hears: "driver" });
  expect((await callAsAgent(t, token, "joined.take", { how: "mid_task" })).result.messages).toEqual([]);
  expect((await pepe.as.query(api.runs.inbox, { teamId, runId })).messages).toEqual([expect.objectContaining({ messageId, status: "failed", error: "not_heard" })]);
});

test("when a joined run ends, what waits for it or is on its way fails as run_ended, and a lapsed claim doesn't wait again", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { t, teamId, julio, pepe, signIn, general } = await room();
  const { token, runId } = (await join(t, signIn, { teamId })).result;
  const claimed = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> one` });
  expect((await callAsAgent(t, token, "joined.take", { how: "mid_task" })).result.messages).toHaveLength(1);
  const waiting = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> two` });
  expect(await callAsAgent(t, token, "joined.leave")).toMatchObject({ status: 200 });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const statuses = (await pepe.as.query(api.runs.inbox, { teamId, runId })).messages!.map((m) => [m.messageId, m.status, m.error]);
  expect(statuses).toEqual(
    expect.arrayContaining([
      [claimed, "failed", "run_ended"],
      [waiting, "failed", "run_ended"],
    ]),
  );
});

const liveIds = async (r: Awaited<ReturnType<typeof room>>) =>(await r.julio.as.query(api.runs.live, { teamId: r.teamId })).map((run) => run.runId);

test("a joined run stays live while its heartbeat comes, and ends two minutes after the last one", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  const r = await room();
  const { token, runId } = (await join(r.t, r.signIn, { teamId: r.teamId })).result;
  const watch = () => r.t.query(api.live.query, { key: token, fn: "joined.waiting", args: {} });

  for (let i = 0; i < 6; i++) {
    vi.advanceTimersByTime(30_000);
    await r.t.finishInProgressScheduledFunctions();
    expect(await callAsAgent(r.t, token, "joined.heartbeat")).toMatchObject({ status: 200, result: { heartbeatMs: 30_000 } });
  }
  vi.advanceTimersByTime(60_000);
  await r.t.finishInProgressScheduledFunctions();
  expect(await liveIds(r)).toEqual([runId]);

  vi.advanceTimersByTime(60_001);
  await r.t.finishInProgressScheduledFunctions();
  expect(await liveIds(r)).toEqual([]);
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "done", endedAt: expect.any(Number) });
  const after = await callAsAgent(r.t, token, "joined.heartbeat");
  expect(after).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  expect(after.error!.message).toMatch(/uplink join/);
  await expect(watch()).rejects.toThrow(/ended/);
});

test("revoking the sign-in a session joined with kills its token at once, and its run ends in the step after", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  const r = await room();
  const { token, runId } = (await join(r.t, r.signIn, { teamId: r.teamId })).result;
  await callAsAgent(r.t, r.signIn, "people.revokeSignIn");
  expect(await callAsAgent(r.t, token, "joined.take", { how: "mid_task" })).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  await r.t.finishAllScheduledFunctions(vi.runAllTimers);
  // Ended by the revocation's step, not by its heartbeat stopping.
  expect(await r.t.run(async (ctx) => (await ctx.db.query("joinedSessions").collect()).map((j) => j.endReason))).toEqual(["signed_out"]);
  expect(await liveIds(r)).toEqual([]);
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId })).toMatchObject({ state: "done" });
});

test("leaving, or someone stopping the run, ends it and its token", async () => {
  const r = await room();
  const first = (await join(r.t, r.signIn, { teamId: r.teamId })).result;
  expect(await callAsAgent(r.t, first.token, "joined.leave")).toMatchObject({ status: 200 });
  expect(await liveIds(r)).toEqual([]);
  expect(await callAsAgent(r.t, first.token, "joined.me")).toMatchObject({ status: 401 });

  const second = (await join(r.t, r.signIn, { teamId: r.teamId, sessionRef: "session-2" })).result;
  expect(await liveIds(r)).toEqual([second.runId]);
  // The team's admin stops it from the app.
  await r.julio.as.mutation(api.runs.stop, { teamId: r.teamId, runId: second.runId });
  expect(await liveIds(r)).toEqual([]);
  expect(await r.julio.as.query(api.runs.get, { teamId: r.teamId, runId: second.runId })).toMatchObject({ state: "stopped" });
  expect(await callAsAgent(r.t, second.token, "joined.heartbeat")).toMatchObject({ status: 401 });
});

test("the same session joining again keeps its run with a new token; in another team its old run ends", async () => {
  const r = await room();
  const first = (await join(r.t, r.signIn, { teamId: r.teamId })).result;
  const again = (await join(r.t, r.signIn, { teamId: r.teamId, hearing: "none" })).result;
  expect(again).toMatchObject({ runId: first.runId, label: "Claude Code (Pepe)", hearing: "none" });
  expect(again.token).not.toBe(first.token);
  expect(await callAsAgent(r.t, first.token, "joined.me")).toMatchObject({ status: 401 });
  expect(await callAsAgent(r.t, again.token, "joined.me")).toMatchObject({ status: 200, result: { runId: first.runId, hearing: "none" } });

  // A second session of the same harness is numbered, as any run is.
  const other = (await join(r.t, r.signIn, { teamId: r.teamId, sessionRef: "session-2" })).result;
  expect(other.label).toBe("Claude Code 2 (Pepe)");

  const side = await r.pepe.as.mutation(api.teams.create, { name: "Side project" });
  const moved = (await join(r.t, r.signIn, { teamId: side })).result;
  expect(moved.runId).not.toBe(first.runId);
  expect(await liveIds(r)).toEqual([other.runId]);
});
