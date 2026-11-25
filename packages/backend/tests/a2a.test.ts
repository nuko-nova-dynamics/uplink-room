/**
 * Outside agents over A2A (spec #8, ADR 0012), at the Room API seam and against
 * a local A2A 1.0 agent built on the official SDK (tests/a2a/fakeAgent.ts).
 */
import { afterEach, beforeEach, expect, onTestFinished, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { setA2ATimingForTests } from "../convex/lib/a2a/timing";
import { applyObservation } from "../convex/lib/a2a/runs";
import { addAgent, addTeammate, callAsAgent, newRoom, listed, newTeam, present, type Room } from "./setup";
import { callsOf, connected, fastTiming, runOf, setOptions, settled, sleep, spawn, until } from "./a2a/helpers";

beforeEach(() => setA2ATimingForTests({ fast: true }));
afterEach(() => setA2ATimingForTests(undefined));

test("connecting an agent's endpoint reads its Agent Card and keeps the token out of every answer", async () => {
  const { t, teamId, admin, agentId, fake, peer } = await connected({
    name: "Hermes on julio-mbp",
    streaming: true,
    bearer: "hermes-secret-token",
    token: "hermes-secret-token",
  });

  expect(peer).toMatchObject({
    status: "ready",
    cardUrl: fake.cardUrl,
    endpointUrl: fake.url,
    card: {
      name: "Hermes on julio-mbp",
      streaming: true,
      skills: [{ id: "chores", name: "Chores" }],
    },
    credential: { kind: "bearer", hint: "…oken" },
    cancel: "unknown",
    sendWork: "team",
  });
  // The card is public, so reading it sends no token.
  expect((await callsOf(fake)).length).toBe(0);

  const everything = JSON.stringify([
    peer,
    await admin.as.query(api.a2a.list, { teamId }),
    await admin.as.query(api.activity.list, { teamId }),
  ]);
  expect(everything).not.toContain("hermes-secret-token");
  const stored = await t.run(async (ctx) => ctx.db.query("a2aCredentials").collect());
  expect(JSON.stringify(stored)).not.toContain("hermes-secret-token");
  expect(agentId).toBeTruthy();
});

test("only registered origins: a card that points elsewhere, a 0.2-only card and URLs with credentials are refused", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const agentId = await admin.as.mutation(api.agents.add, {
    teamId,
    name: "Hermes",
    connection: "a2a",
  });

  const elsewhere = await spawn({ advertiseUrl: "http://127.0.0.1:9/" });
  await admin.as.mutation(api.a2a.connect, { teamId, agentId, cardUrl: elsewhere.url });
  const refused = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "failed",
  );
  expect(refused?.error).toMatch(/isn't the address you registered/i);

  const old = await spawn({ protocolVersion: "0.2" });
  await admin.as.mutation(api.a2a.update, { teamId, agentId, cardUrl: old.url });
  const tooOld = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "failed" && p.cardUrl === old.cardUrl,
  );
  expect(tooOld?.error).toBe("This agent speaks A2A 0.2; the room needs A2A 1.0 or 0.3.");

  await expect(
    admin.as.mutation(api.a2a.update, {
      teamId,
      agentId,
      cardUrl: "https://julio:pw@hermes.example.com/",
    }),
  ).rejects.toThrow(/without a user name or password/i);
  await expect(
    admin.as.mutation(api.a2a.update, { teamId, agentId, cardUrl: "ftp://hermes.example.com/" }),
  ).rejects.toThrow(/https/i);
});

test("only the person accountable for the agent, or an admin, connects it; agents can't", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const agentId = await admin.as.mutation(api.agents.add, {
    teamId,
    name: "Hermes",
    connection: "a2a",
  });
  const fake = await spawn();

  await expect(
    ana.as.mutation(api.a2a.connect, { teamId, agentId, cardUrl: fake.url }),
  ).rejects.toThrow(/accountable|admin/i);
  const helper = await addAgent(t, teamId, admin, "Helper", ["people.invite", "room.read"]);
  const viaKey = await callAsAgent(t, helper.key, "a2a.connect", { agentId, cardUrl: fake.url });
  expect(viaKey).toMatchObject({ ok: false, status: 403 });

  // Ana's own agent is hers to connect.
  const anasAgent = await ana.as.mutation(api.agents.add, {
    teamId,
    name: "OpenClaw",
    connection: "a2a",
  });
  await ana.as.mutation(api.a2a.connect, { teamId, agentId: anasAgent, cardUrl: fake.url });
});

test("a run on a task becomes an A2A task: Working, then Done with its artifact, and the roster follows", async () => {
  const { t, teamId, admin, agentId, agentMemberId, fake } = await connected({
    bearer: "tok",
    token: "tok",
    holdWork: true,
  });
  onTestFinished(() => setOptions(fake, { holdWork: false }));
  const taskId = await admin.as.mutation(api.tasks.create, {
    teamId,
    title: "Summarize the outage",
  });

  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    taskId,
    via: "a2a",
    agentId,
    prompt: "work: summarize it",
  });
  const working = await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
    15_000,
    true,
  );
  expect(working).toMatchObject({
    harness: "a2a",
    driver: { name: "Julio" },
    a2a: { agent: { name: "Hermes" }, externalState: "TASK_STATE_WORKING" },
  });
  const roster = await admin.as.query(api.teams.roster, { teamId });
  expect(roster.find((r) => r.kind === "agent" && r.memberId === agentMemberId)).toMatchObject({
    state: "working",
    runs: 1,
  });

  await setOptions(fake, { holdWork: false });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a).toMatchObject({
    externalState: "TASK_STATE_COMPLETED",
    following: false,
    artifacts: [
      {
        artifactId: "result",
        name: "Result",
        text: "Done: summarize it",
        urls: ["https://example.com/report.pdf"],
      },
    ],
  });
  expect(done.a2a?.taskId).toBeTruthy();
  expect(done.a2a?.contextId).toBeTruthy();
  // "Working on it" belonged to the Working status; Completed came without a message.
  expect(done.a2a?.lastMessage).toBeUndefined();

  const [send] = await callsOf(fake);
  expect(send).toMatchObject({
    method: "SendMessage",
    headers: {
      authorization: "Bearer tok",
      "a2a-version": "1.0",
      "content-type": "application/json",
    },
    params: {
      message: { role: "ROLE_USER", metadata: { uplinkRoom: { runId, taskId, from: "Julio" } } },
    },
  });
  expect(send!.params.message.parts[0].text).toMatch(/^work: summarize it\n/);
  expect(send!.params.message.parts[0].text).toContain("Summarize the outage");
  expect((await admin.as.query(api.a2a.runs, { teamId, agentId })).map((r) => r.runId)).toEqual([
    runId,
  ]);
  expect(
    (await admin.as.query(api.teams.roster, { teamId })).find(
      (r) => r.kind === "agent" && r.memberId === agentMemberId,
    ),
  ).toMatchObject({ state: "idle" });
});

test("a direct reply finishes the run with the agent's message and no remote task", async () => {
  const { t, teamId, admin, agentId } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "reply: hello",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a).toMatchObject({ lastMessage: "You said hello", following: false });
  expect(done.a2a?.taskId).toBeUndefined();
  // A run with no task is unfiled, like a thread started straight in T3 Code.
  expect((await admin.as.query(api.runs.unfiled, { teamId })).map((r) => r.runId)).toContain(runId);
});

test("a streaming agent is followed over SSE", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ streaming: true, workMs: 100 });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "work: stream it",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: stream it" });
  const methods = (await callsOf(fake)).map((c) => c.method);
  expect(methods[0]).toBe("SendStreamingMessage");
  expect(methods).not.toContain("GetTask");
});

test("a question waits on the driver, and a reply goes back on the same task", async () => {
  const { t, teamId, admin, agentId, fake } = await connected();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { runId } = await ana.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "ask: Which branch should I use?",
  });

  const waiting = await settled(t, ana, teamId, runId, "waiting");
  expect(waiting.prompt).toMatchObject({ kind: "question", text: "Which branch should I use?" });
  const inbox = await ana.as.query(api.inbox.get, { teamId });
  expect(inbox.needsYou.map((row: { runId?: string }) => row.runId)).toContain(runId);
  // An approval answer is for terminals and threads; a question is answered with a reply.
  await expect(
    ana.as.mutation(api.inbox.answer, { teamId, runId, answer: "allow", promptId: "" }),
  ).rejects.toThrow();
  await expect(ana.as.mutation(api.runs.reply, { teamId, runId, text: "" })).rejects.toThrow(
    /needs text/i,
  );

  await ana.as.mutation(api.runs.reply, { teamId, runId, text: "main" });
  const done = await settled(t, ana, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Thanks: main" });
  const sends = (await callsOf(fake)).filter((c) => c.method === "SendMessage");
  expect(sends[1]!.params.message).toMatchObject({
    taskId: done.a2a!.taskId,
    contextId: done.a2a!.contextId,
  });
  // Once the task is done, a reply continues the conversation: a new task in the same A2A
  // context, as a run of its own, pointing back at the task before it (ADR 0024).
  const { runId: next } = await ana.as.mutation(api.runs.reply, { teamId, runId, text: "reply: more" });
  expect(next).not.toBe(runId);
  expect(await settled(t, ana, teamId, next, "done")).toMatchObject({ a2a: { lastMessage: "You said more", contextId: done.a2a!.contextId } });
  const third = (await callsOf(fake)).filter((c) => c.method === "SendMessage")[2]!;
  expect(third.params.message.contextId).toBe(done.a2a!.contextId);
  expect(third.params.message.taskId).toBeUndefined();
  expect(third.params.message.referenceTaskIds).toEqual([done.a2a!.taskId]);
});

test("a reply or a stop reaches a streaming agent at once, not when the held stream would end", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ streaming: true });
  // A stream window far longer than the test: only the wake check can end it.
  setA2ATimingForTests({ ...fastTiming(), streamWindowMs: 60_000, callTimeoutMs: 60_000 });
  // `live`: the test must not wait for the step holding the stream, as nothing does in production.
  const read = (runId: Id<"runs">) => () => runOf(t, admin, teamId, runId);
  const asked = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "ask: Which?",
  });
  await until(t, read(asked.runId), (r) => r.state === "waiting", 3_000, true);
  await sleep(100);
  await admin.as.mutation(api.runs.reply, { teamId, runId: asked.runId, text: "main" });
  await until(t, read(asked.runId), (r) => r.state === "done", 3_000, true);

  const slow = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: hold on",
  });
  await until(
    t,
    read(slow.runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
    3_000,
    true,
  );
  await sleep(100);
  await admin.as.mutation(api.runs.stop, { teamId, runId: slow.runId });
  await until(t, read(slow.runId), (r) => r.state === "stopped", 3_000, true);
  expect((await callsOf(fake)).map((c) => c.method)).toContain("SubscribeToTask");
});

test("failed, rejected and sign-in tasks map to Failed, Failed and Waiting", async () => {
  const { t, teamId, admin, agentId } = await connected();
  const failed = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "fail: disk full",
  });
  const rejected = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "reject: not my job",
  });
  const auth = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "auth: please",
  });

  expect(await settled(t, admin, teamId, failed.runId, "failed")).toMatchObject({
    failReason: "disk full",
    a2a: { externalState: "TASK_STATE_FAILED" },
  });
  expect(await settled(t, admin, teamId, rejected.runId, "failed")).toMatchObject({
    failReason: "Rejected: not my job",
    a2a: { externalState: "TASK_STATE_REJECTED" },
  });
  const waiting = await settled(t, admin, teamId, auth.runId, "waiting");
  expect(waiting.prompt?.text).toMatch(/sign in at its gateway.*Sign in to GitHub/s);
  await admin.as.mutation(api.runs.detach, { teamId, runId: auth.runId });
});

test("stopping asks the agent to cancel, and the run is Stopped only once the agent confirms", async () => {
  const { t, teamId, admin, agentId, fake } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: keep going",
  });
  await settled(t, admin, teamId, runId, "working");

  await admin.as.mutation(api.runs.stop, { teamId, runId });
  // Asking is not stopping: the run stays Working until the agent says Canceled.
  expect(await runOf(t, admin, teamId, runId)).toMatchObject({
    state: "working",
    a2a: { cancel: { status: "pending" } },
  });
  const stopped = await settled(t, admin, teamId, runId, "stopped");
  expect(stopped.a2a).toMatchObject({
    externalState: "TASK_STATE_CANCELED",
    cancel: { status: "canceled" },
    following: false,
  });
  expect((await callsOf(fake)).map((c) => c.method)).toContain("CancelTask");
  expect((await admin.as.query(api.a2a.get, { teamId, agentId }))?.cancel).toBe("supported");
});

test("an agent that can't cancel is never shown Stopped; the run can stop being followed instead", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    cancel: "unsupported",
    listTasks: false,
  });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: forever",
  });
  await settled(t, admin, teamId, runId, "working");

  await admin.as.mutation(api.runs.stop, { teamId, runId });
  const refused = await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.cancel?.status === "unsupported",
  );
  expect(refused.state).toBe("working");
  expect((await admin.as.query(api.a2a.get, { teamId, agentId }))?.cancel).toBe("unsupported");
  // Known now: the next stop is refused at once and points at detaching.
  await expect(admin.as.mutation(api.runs.stop, { teamId, runId })).rejects.toThrow(
    /can't be stopped from the room/i,
  );

  await admin.as.mutation(api.runs.detach, { teamId, runId });
  const detached = await runOf(t, admin, teamId, runId);
  expect(detached).toMatchObject({
    state: "unknown",
    a2a: { following: false, detached: { by: { name: "Julio" } } },
  });
  expect(detached.failReason).toMatch(/may still be running/i);
  const before = (await callsOf(fake)).length;
  await sleep(150);
  await t.finishInProgressScheduledFunctions();
  expect((await callsOf(fake)).length).toBe(before);
});

test("Room API callers can't overwrite an A2A run's state: only the adapter reports it", async () => {
  const { t, teamId, admin, agentId } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "ask: Which?",
  });
  await settled(t, admin, teamId, runId, "waiting");

  const boss = await addAgent(t, teamId, admin, "Boss", [
    "room.read",
    "runs.start",
    "approvals.answer",
    "work.manage",
  ]);
  expect(
    await callAsAgent(t, boss.key, "inbox.answer", { runId, answer: "allow", promptId: "" }),
  ).toMatchObject({ ok: false });
  // There is no Room API function for reporting an A2A run's state.
  expect(await callAsAgent(t, boss.key, "a2a.observe", { runId, state: "done" })).toMatchObject({
    ok: false,
    status: 404,
  });
  const stop = await callAsAgent(t, boss.key, "runs.stop", { runId });
  expect(stop).toMatchObject({ ok: true });
  // A stop is a cancel request; the run stays Waiting until the agent confirms.
  expect(await runOf(t, admin, teamId, runId)).toMatchObject({ state: "waiting" });
  await settled(t, admin, teamId, runId, "stopped");
});

test("observations are serialized: a stale or old report, or one after the end, changes nothing", async () => {
  const { t, teamId, admin, agentId } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "work: quick",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  const binding = await t.run(async (ctx) =>
    ctx.db
      .query("a2aBindings")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique(),
  );

  const late = await t.mutation(internal.a2aWorker.observed, {
    bindingId: binding!._id,
    lease: "not-the-lease",
    observation: {
      kind: "task",
      taskId: done.a2a!.taskId!,
      contextId: done.a2a!.contextId!,
      state: "TASK_STATE_WORKING",
      statusAt: Date.now(),
    },
  });
  expect(late).toBe("ignored");
  expect(await runOf(t, admin, teamId, runId)).toMatchObject({ state: "done" });
});

test("mentioning an A2A agent in a channel sends it the message as a new unfiled run", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected();
  const channelId = await admin.as.mutation(api.channels.create, { teamId, name: "ops" });
  const messageId = await admin.as.mutation(api.messages.post, {
    teamId,
    channelId,
    body: "reply: what's up?",
    mentionedAgents: [agentMemberId],
  });
  const [message] = listed(await admin.as.query(api.messages.list, { teamId, channelId }));
  expect(message).toMatchObject({ messageId, mentionedAgents: [agentMemberId] });
  expect(message!.mentionedRuns).toHaveLength(1);
  const runId = message!.mentionedRuns[0]!;
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done).toMatchObject({ a2a: { lastMessage: "You said what's up?" } });
  expect(done.taskId).toBeUndefined();
  const [send] = await callsOf(fake);
  expect(send!.params.message.metadata.uplinkRoom).toMatchObject({
    channelId,
    messageId,
    channel: "ops",
  });

  // An agent mentioning it needs runs.start; without it, the mention starts nothing.
  const poster = await addAgent(t, teamId, admin, "Poster", ["messages.post", "room.read"]);
  const posted = await callAsAgent(t, poster.key, "messages.post", {
    channelId,
    body: "reply: hi",
    mentionedAgents: [agentMemberId],
  });
  expect(posted).toMatchObject({ ok: true });
  const rows = listed(await admin.as.query(api.messages.list, { teamId, channelId }));
  // Hermes answered in the channel, as its own message naming the run (ADR 0024).
  expect(rows.find((m) => m.author.memberId === agentMemberId)).toMatchObject({ body: "You said what's up?", a2a: { runId } });
  expect(rows.find((m) => m.author.name === "Poster")!.mentionedRuns).toEqual([]);
});

test("an agent that takes work only from its person refuses everyone else", async () => {
  const { t, teamId, admin, agentId } = await connected({ sendWork: "accountable" });
  const ana = await addTeammate(t, teamId, admin, "Ana");
  await expect(
    ana.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: x" }),
  ).rejects.toThrow(/only from Julio/i);
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "reply: x",
  });
  await settled(t, admin, teamId, runId, "done");
});

test("a lost answer is matched to the agent's task by message id when it lists tasks, and is Unknown when it can't", async () => {
  const lists = await connected();
  const found = await lists.admin.as.mutation(api.runs.start, {
    teamId: lists.teamId,
    via: "a2a",
    agentId: lists.agentId,
    prompt: "drop: then work",
  });
  const done = await settled(lists.t, lists.admin, lists.teamId, found.runId, "done");
  expect(done.a2a?.taskId).toBeTruthy();
  const methods = (await callsOf(lists.fake)).map((c) => c.method);
  expect(methods.filter((m) => m === "SendMessage")).toHaveLength(1);
  expect(methods).toContain("ListTasks");

  const blind = await connected({ listTasks: false });
  const lost = await blind.admin.as.mutation(api.runs.start, {
    teamId: blind.teamId,
    via: "a2a",
    agentId: blind.agentId,
    prompt: "drop: maybe",
  });
  const unknown = await until(
    blind.t,
    () => runOf(blind.t, blind.admin, blind.teamId, lost.runId),
    (r) => r.a2a?.following === false,
  );
  expect(unknown.state).toBe("unknown");
  expect(unknown.failReason).toMatch(/not confirmed/i);
  // Never sent twice.
  expect((await callsOf(blind.fake)).filter((c) => c.method === "SendMessage")).toHaveLength(1);
});

test("a refused token fails the run and says so", async () => {
  const { t, teamId, admin, agentId } = await connected({ bearer: "right", token: "wrong" });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "work: x",
  });
  expect((await settled(t, admin, teamId, runId, "failed")).failReason).toBe(
    "Hermes's gateway refused the room's token (HTTP 401). Replace the token in Hermes's A2A settings.",
  );

  await admin.as.mutation(api.a2a.setCredential, {
    teamId,
    agentId,
    credential: { kind: "bearer", secret: "right" },
  });
  const again = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "reply: x",
  });
  await settled(t, admin, teamId, again.runId, "done");
});

test("disconnecting the endpoint, or removing the agent, stops following its runs", async () => {
  const { t, teamId, admin, agentId, agentMemberId } = await connected();
  const one = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: a",
  });
  await settled(t, admin, teamId, one.runId, "working");
  await admin.as.mutation(api.a2a.disconnect, { teamId, agentId });
  expect(await runOf(t, admin, teamId, one.runId)).toMatchObject({
    state: "unknown",
    a2a: { following: false },
  });
  await expect(
    admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: b" }),
  ).rejects.toThrow(/no A2A endpoint/i);

  const fake = await spawn();
  await admin.as.mutation(api.a2a.connect, { teamId, agentId, cardUrl: fake.url });
  await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "ready",
  );
  const two = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: c",
  });
  await settled(t, admin, teamId, two.runId, "working");
  await admin.as.mutation(api.members.remove, { teamId, memberId: agentMemberId });
  const after = await until(
    t,
    () => runOf(t, admin, teamId, two.runId),
    (r) => r.a2a?.following === false,
  );
  expect(after.state).toBe("unknown");
});

// --- Review fixes (#47) ---

test("changing an endpoint's address deletes its token, so the old gateway's token never reaches the new one", async () => {
  const { t, teamId, admin, agentId } = await connected({
    bearer: "token-for-a",
    token: "token-for-a",
  });
  const other = await spawn();
  await admin.as.mutation(api.a2a.update, { teamId, agentId, cardUrl: other.url });
  const peer = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "ready",
  );
  expect(peer?.credential).toBeNull();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "reply: hi",
  });
  await settled(t, admin, teamId, runId, "done");
  expect((await callsOf(other)).map((c) => c.headers.authorization)).toEqual([undefined]);
});

test("a run started at one address is never followed or canceled at another", async () => {
  const { t, teamId, admin, agentId, fake } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: here",
  });
  await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
  );
  const other = await spawn();
  await admin.as.mutation(api.a2a.update, { teamId, agentId, cardUrl: other.url });
  await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "ready",
  );
  const after = await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.following === false,
  );
  expect(after.state).toBe("unknown");
  expect(after.failReason).toMatch(/address changed/i);
  expect(await callsOf(other)).toEqual([]);
  expect((await callsOf(fake)).map((c) => c.method)).not.toContain("CancelTask");
});

test("a gateway that answers a subscription with one unchanged snapshot is not resubscribed at once", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    streaming: true,
    subscribeSnapshotOnly: true,
  });
  setA2ATimingForTests({ ...fastTiming(), streamWindowMs: 100 });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: quiet",
  });
  await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
  );
  const subscribes = async () =>
    (await callsOf(fake)).filter((c) => c.method === "SubscribeToTask").length;
  await until(t, subscribes, (n) => n >= 1, 3_000);
  const start = await subscribes();
  await sleep(600);
  // Backing off (10, 20, 40 ms here) allows about 15 in 600 ms; resubscribing at once allows hundreds.
  expect((await subscribes()) - start).toBeLessThan(30);
  await admin.as.mutation(api.runs.detach, { teamId, runId });
});

test("a subscription whose JSON answer never finishes is cut at the call deadline", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    streaming: true,
    stallSubscribe: true,
  });
  setA2ATimingForTests({ ...fastTiming(), streamWindowMs: 100, callTimeoutMs: 300 });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: stall",
  });
  const methods = async () => (await callsOf(fake)).map((c) => c.method);
  await until(t, methods, (m) => m.includes("GetTask"), 4_000, true);
  await admin.as.mutation(api.runs.detach, { teamId, runId });
});

test("appends to two artifacts in one commit interval extend both", async () => {
  const { t, teamId, admin, agentId } = await connected({ streaming: true });
  setA2ATimingForTests({ ...fastTiming(), streamCommitMs: 1_000 });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "chunks: go",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts.map((a) => [a.artifactId, a.text])).toEqual([
    ["a", "a1a2"],
    ["b", "b1b2"],
  ]);
});

test("a lost answer found finished through ListTasks keeps its artifacts, even past the first page", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ workMs: 0, listPadPages: 2 });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "drop: quick",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: quick" });
  const lists = (await callsOf(fake)).filter((c) => c.method === "ListTasks");
  expect(lists).toHaveLength(3);
  expect(lists[0]!.params).toMatchObject({ includeArtifacts: true });
});

test("a lost answer found finished without artifacts is kept as a match: a failed full read is retried alone, not searched for again", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    workMs: 0,
    listWithoutArtifacts: true,
    failGetTask: 1,
  });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "drop: whole",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: whole" });
  const calls = await callsOf(fake);
  expect(calls.filter((c) => c.method === "ListTasks")).toHaveLength(1);
  expect(calls.filter((c) => c.method === "GetTask")).toHaveLength(2);
  expect((await bindingOf(t, runId))!.reconcile).toBeUndefined();
});

test("a lost answer's task found by a search but gone when read ends the run as Unknown, without searching again", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    workMs: 0,
    listWithoutArtifacts: true,
    getTaskNotFound: true,
  });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "drop: expired",
  });
  const run = await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.following === false,
  );
  expect(run.state).toBe("unknown");
  expect(run.failReason).toMatch(/no longer has this task/);
  expect((await callsOf(fake)).filter((c) => c.method === "ListTasks")).toHaveLength(1);
});

test("an internal error after the agent took the message is reconciled, not treated as refused", async () => {
  const { t, teamId, admin, agentId, fake } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "err500: then work",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: then work" });
  const methods = (await callsOf(fake)).map((c) => c.method);
  expect(methods.filter((m) => m === "SendMessage")).toHaveLength(1);
  // An unclear answer is never followed by the same message in A2A 0.3's names (ADR 0018).
  expect(methods).not.toContain("message/send");
});

test("a task with a blank description sends its title", async () => {
  const { t, teamId, admin, agentId, fake } = await connected();
  const taskId = await admin.as.mutation(api.tasks.create, {
    teamId,
    title: "reply: from the title",
    description: "   ",
  });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    taskId,
    via: "a2a",
    agentId,
  });
  await settled(t, admin, teamId, runId, "done");
  expect((await callsOf(fake))[0]!.params.message.parts[0].text).toMatch(
    /^reply: from the title\n/,
  );
});

test("a card address that redirects is refused, wherever it points", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const agentId = await admin.as.mutation(api.agents.add, {
    teamId,
    name: "Hermes",
    connection: "a2a",
  });
  const target = await spawn();
  const redirecting = await spawn({ cardRedirect: target.cardUrl });
  await admin.as.mutation(api.a2a.connect, { teamId, agentId, cardUrl: redirecting.url });
  const peer = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "failed",
  );
  expect(peer?.error).toMatch(/redirects/i);
});

// --- Robustness fixes (#48) ---

const bindingOf = (t: Room, runId: Id<"runs">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("a2aBindings")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique(),
  );

test("a whole-task snapshot with no artifacts clears the earlier ones", async () => {
  const { t, teamId, admin, agentId } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: x",
  });
  await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
  );
  const binding = (await bindingOf(t, runId))!;
  await t.run(async (ctx) => {
    await ctx.db.patch(binding._id, {
      artifacts: [{ artifactId: "old", text: "out of date", urls: [] }],
    });
    const fresh = (await ctx.db.get(binding._id))!;
    await applyObservation(
      ctx,
      fresh,
      {
        kind: "task",
        taskId: fresh.taskId!,
        state: "TASK_STATE_WORKING",
        artifacts: [],
        snapshot: true,
      },
      "Hermes",
    );
  });
  expect((await bindingOf(t, runId))!.artifacts).toEqual([]);
  await admin.as.mutation(api.runs.detach, { teamId, runId });
});

test("after many replies the reply form stays, and each new question notifies again", async () => {
  const { t, teamId, admin, agentId } = await connected();
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "ask: Question 1?",
  });
  let run = await settled(t, admin, teamId, runId, "waiting");
  for (let n = 2; n <= 23; n++) {
    const before = run.stateChangedAt;
    await sleep(2);
    await admin.as.mutation(api.runs.reply, { teamId, runId, text: `again ${n}` });
    run = await until(
      t,
      () => runOf(t, admin, teamId, runId),
      (r) => r.prompt?.text === `Question ${n}?` && r.a2a?.messages.at(-1)?.status === "sent",
    );
    // A new question while still Waiting is a change: it notifies and un-settles.
    expect(run.stateChangedAt, `question ${n}`).toBeGreaterThan(before);
  }
  // The start message is kept however many replies there were, so its delivery still reads as sent.
  expect(run.a2a?.delivery).toBe("sent");
  expect(run.a2a?.messages.length).toBeLessThanOrEqual(10);
  const binding = (await bindingOf(t, runId))!;
  expect(binding.outbox[0]!.kind).toBe("start");
  expect(binding.outbox.length).toBeLessThanOrEqual(21);
  await admin.as.mutation(api.runs.detach, { teamId, runId });
});

test("a card naming another interface or tenant resets what the room learned about cancel and listing", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    cancel: "unsupported",
    listTasks: false,
  });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "slow: x",
  });
  await until(
    t,
    () => runOf(t, admin, teamId, runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
  );
  await admin.as.mutation(api.runs.stop, { teamId, runId });
  await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.cancel === "unsupported",
  );
  await t.run(async (ctx) => {
    const peer = await ctx.db
      .query("a2aPeers")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .unique();
    await ctx.db.patch(peer!._id, { listTasks: "unsupported" });
  });
  await setOptions(fake, { tenant: "replacement" });
  await admin.as.mutation(api.a2a.recheck, { teamId, agentId });
  const peer = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status === "ready" && p.cancel !== "unsupported",
  );
  expect(peer).toMatchObject({ cancel: "unknown", listTasks: "unknown" });
});

test("looking for a lost message reads one ListTasks page per step and keeps its place between steps", async () => {
  const { t, teamId, admin, agentId } = await connected({
    workMs: 0,
    listPadPages: 2,
    listDelayMs: 150,
  });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "drop: paged",
  });
  // Saved between steps: the next page's token, so a restarted step goes on from there.
  const saved = await until(
    t,
    () => bindingOf(t, runId),
    (b) => b?.reconcile?.pageToken === "pad-1",
    6_000,
    true,
  );
  expect(saved?.reconcile).toMatchObject({ pages: 1 });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: paged" });
  expect((await bindingOf(t, runId))!.reconcile).toBeUndefined();
});

test("an A2A agent in a direct message gets each message as a run, and only the DM's members see its texts", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const channelId = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;

  const first = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "reply: hello there" });
  const second = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "reply: and again" });
  const runs = [];
  for (const messageId of [first, second]) {
    const message = present(await admin.as.query(api.messages.get, { teamId, messageId }));
    expect(message.mentionedRuns).toHaveLength(1);
    runs.push(message.mentionedRuns[0]!);
  }
  const done = await settled(t, admin, teamId, runs[0]!, "done");
  expect(done).toMatchObject({ title: "Direct message from Julio", private: false, a2a: { lastMessage: "You said hello there" } });
  const [send] = await callsOf(fake);
  expect(send!.params.message.metadata.uplinkRoom).toMatchObject({ channelId, channel: "direct message" });
  expect(JSON.stringify(send!.params.message)).toContain("in a direct message");

  // Ana isn't in the DM: she sees the run, without what was said.
  const seen = await ana.as.query(api.runs.get, { teamId, runId: runs[0]! });
  expect(seen).toMatchObject({ title: "Direct message from Julio", private: true, a2a: { artifacts: [] } });
  expect(seen.a2a!.lastMessage).toBeUndefined();
  expect(seen.a2a!.messages.every((m) => m.text === "")).toBe(true);
});

test("work sent to an agent from a direct message is the Markdown as written, with mentions as names", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const channelId = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId, ana.memberId] })).channelId;
  const body = `reply: run \`pnpm test -- __init__\` for <@${ana.memberId}>\n\n\`\`\`sh\nls   -la\n\`\`\`\nSee [the log](https://ci.example.com/run/7).`;
  const messageId = await admin.as.mutation(api.messages.post, { teamId, channelId, body });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId })).mentionedRuns[0]!;
  await settled(t, admin, teamId, runId, "done");
  const [send] = await callsOf(fake);
  const text = (send!.params.message.parts as { text?: string }[]).map((p) => p.text ?? "").join("");
  expect(text).toContain("reply: run `pnpm test -- __init__` for @Ana\n\n```sh\nls   -la\n```\nSee [the log](https://ci.example.com/run/7).");
});

test("only a direct message's members can act on a run sent from it; others see it without its texts or errors", async () => {
  const { t, teamId, admin, agentMemberId } = await connected();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const helper = await addAgent(t, teamId, admin, "Helper", ["room.read", "runs.start", "messages.post"]);
  const channelId = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  const messageId = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "ask: which deploy key?" });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId })).mentionedRuns[0]!;
  await settled(t, admin, teamId, runId, "waiting");

  // An agent accountable to the same person, but not in the direct message, can't steer it.
  const attempts: [string, Record<string, unknown>][] = [
    ["runs.reply", { runId, text: "use the old key" }],
    ["runs.stop", { runId }],
    ["runs.detach", { runId }],
  ];
  for (const [fn, args] of attempts) {
    const refused = await callAsAgent(t, helper.key, fn, args);
    expect(refused, fn).toMatchObject({ status: 404, error: { code: "not_found" } });
  }
  await expect(ana.as.mutation(api.runs.stop, { teamId, runId })).rejects.toThrow(/Not found/);

  // Gateway errors, a cancel error and a detach reason stay with the direct message.
  await t.run(async (ctx) => {
    const binding = (await ctx.db.query("a2aBindings").withIndex("by_run", (q) => q.eq("runId", runId)).unique())!;
    await ctx.db.patch(binding._id, {
      lastError: "gateway said: which deploy key? (secret-ish)",
      outbox: binding.outbox.map((e) => ({ ...e, error: "refused: which deploy key?" })),
      cancel: { requestedAt: Date.now(), by: binding.outbox[0]!.by, status: "failed", error: "cancel failed: which deploy key?" },
      detached: { at: Date.now(), reason: "agent said: which deploy key?" },
    });
  });
  const seen = await ana.as.query(api.runs.get, { teamId, runId });
  expect(seen).toMatchObject({ private: true });
  expect(JSON.stringify(seen)).not.toContain("which deploy key");
  const viaAgent = await callAsAgent(t, helper.key, "runs.get", { runId });
  expect(viaAgent).toMatchObject({ ok: true, result: { private: true } });
  expect(JSON.stringify(viaAgent.result)).not.toContain("which deploy key");
  const team = await ana.as.query(api.inbox.get, { teamId, view: "team" });
  expect(JSON.stringify(team)).not.toContain("which deploy key");
  // The members still see all of it.
  expect(JSON.stringify(await admin.as.query(api.runs.get, { teamId, runId }))).toContain("which deploy key");
});

test("an A2A agent mentioned in a private channel gets a run that only the channel's members can read or act on", async () => {
  const { t, teamId, admin, agentId, agentMemberId, fake } = await connected();
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const channelId = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [agentMemberId] });
  const messageId = await ana.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> reply: the launch code` });
  const runId = present(await ana.as.query(api.messages.get, { teamId, messageId })).mentionedRuns[0]!;
  const done = await settled(t, ana, teamId, runId, "done");
  expect(done).toMatchObject({ title: "Message from Ana in a private channel", private: false });
  const [send] = await callsOf(fake);
  expect(send!.params.message.metadata.uplinkRoom).toMatchObject({ channelId, channel: "launch" });
  expect(JSON.stringify(send!.params.message)).toContain("in #launch");

  // Julio is the team's admin, and isn't in it: the run is listed for him without its texts.
  const seen = await admin.as.query(api.runs.get, { teamId, runId });
  expect(seen).toMatchObject({ title: "Message from Ana in a private channel", private: true });
  expect(JSON.stringify(seen)).not.toContain("launch code");
  expect(JSON.stringify(await admin.as.query(api.inbox.get, { teamId, view: "team" }))).not.toContain("launch code");
  await expect(admin.as.mutation(api.runs.stop, { teamId, runId })).rejects.toThrow(/Not found/);
  await expect(admin.as.mutation(api.inbox.settle, { teamId, runId })).rejects.toThrow(/Not found/);

  // A task from the channel's call can go only to an agent in it.
  const outsider = await admin.as.mutation(api.agents.add, { teamId, name: "Outsider", connection: "a2a" });
  const taskId = await t.run(async (ctx) => {
    const ownerId = (await ctx.db.query("members").collect()).find((m) => m.name === "Ana")!._id;
    return ctx.db.insert("tasks", { teamId, title: "Ship the launch page", ownerId, createdBy: ownerId, directChannelId: channelId });
  });
  await expect(ana.as.mutation(api.runs.start, { teamId, taskId, via: "a2a", agentId: outsider })).rejects.toThrow(/isn't in #launch/);
  const { runId: taskRun } = await ana.as.mutation(api.runs.start, { teamId, taskId, via: "a2a", agentId });
  expect(await admin.as.query(api.runs.get, { teamId, runId: taskRun })).toMatchObject({ title: "A run from a private channel", private: true });
});

test("an agent taken out of a private channel gets nothing more from it: no queued message, no reply (P5)", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected();
  const channelId = await admin.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [agentMemberId] });

  // A message queued for the agent, and the agent taken out before the worker sends it.
  const queued = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> reply: the launch code` });
  const queuedRun = present(await admin.as.query(api.messages.get, { teamId, messageId: queued })).mentionedRuns[0]!;
  await admin.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: agentMemberId });
  const stopped = await settled(t, admin, teamId, queuedRun, "unknown");
  expect(stopped.a2a?.following).toBe(false);
  await sleep(200);
  await t.finishInProgressScheduledFunctions();
  expect((await callsOf(fake)).filter((c) => JSON.stringify(c.params).includes("launch code"))).toEqual([]);

  // A run that reached the agent: once it's out of the channel, replies to it are refused.
  await admin.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [agentMemberId] });
  const asked = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "ask: which deploy key?", mentionedMembers: [agentMemberId] });
  const askedRun = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).mentionedRuns[0]!;
  await settled(t, admin, teamId, askedRun, "waiting");
  await t.run(async (ctx) => {
    // Out of the channel without the removal path (as by a direct edit): the worker and replies still refuse.
    const row = await ctx.db.query("channelMembers").withIndex("by_channel_member", (q) => q.eq("channelId", channelId).eq("memberId", agentMemberId)).unique();
    await ctx.db.delete(row!._id);
  });
  await expect(admin.as.mutation(api.runs.reply, { teamId, runId: askedRun, text: "the old key" })).rejects.toThrow(/isn't in the conversation/);
  // And the worker's next step stops following it, before anything else is sent.
  const detached = await until(
    t,
    () => admin.as.query(api.runs.get, { teamId, runId: askedRun }),
    (r) => r.a2a?.following === false,
  );
  expect(detached.a2a?.detached?.reason).toMatch(/isn't in the conversation this run came from/);
}, 20_000);

test("when a stream is refused, the plain send that follows is checked again: an agent taken out meanwhile gets nothing (H4)", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ streaming: true, streamUnsupportedAfterMs: 800 });
  const channelId = await admin.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [agentMemberId] });
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> reply: the launch code` });
  // The stream is on its way and will be refused; the agent is taken out before the answer comes.
  await until(t, () => callsOf(fake), (calls) => calls.some((c) => c.method === "SendStreamingMessage"), 6_000, true);
  await admin.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: agentMemberId });
  await sleep(1_500);
  await t.finishInProgressScheduledFunctions();
  expect((await callsOf(fake)).filter((c) => c.method === "SendMessage")).toEqual([]);
}, 20_000);

// --- A2A 0.3 (ADR 0018) ---

test("an honest A2A 0.3 agent gets work in 0.3's names and shapes, without the 1.0 header, and is followed to Done", async () => {
  const { t, teamId, admin, agentId, fake, peer } = await connected({
    serve: "0.3",
    bearer: "tok",
    token: "tok",
    workMs: 100,
  });
  expect(peer).toMatchObject({
    status: "ready",
    card: { protocolVersion: "0.3.0" },
    protocol: { speaks: "0.3", declared: "0.3", learned: false },
  });

  const work = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: tally it" });
  const done = await settled(t, admin, teamId, work.runId, "done");
  expect(done.a2a).toMatchObject({
    externalState: "TASK_STATE_COMPLETED",
    artifacts: [{ name: "Result", text: "Done: tally it", urls: ["https://example.com/report.pdf"] }],
  });

  // A question waits on the driver, and the reply goes back on the same task.
  const ask = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "ask: Which tide table?" });
  const waiting = await settled(t, admin, teamId, ask.runId, "waiting");
  expect(waiting.prompt).toMatchObject({ kind: "question", text: "Which tide table?" });
  await admin.as.mutation(api.runs.reply, { teamId, runId: ask.runId, text: "Bayview" });
  const answered = await settled(t, admin, teamId, ask.runId, "done");
  expect(answered.a2a?.artifacts[0]).toMatchObject({ text: "Thanks: Bayview" });

  const calls = await callsOf(fake);
  expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["message/send", "tasks/get"]));
  expect(calls.every((c) => c.headers["a2a-version"] === undefined)).toBe(true);
  const [first] = calls;
  expect(first!.params).toMatchObject({
    message: { kind: "message", role: "user", parts: [{ kind: "text" }] },
    configuration: { blocking: false },
  });
  const reply = calls.filter((c) => c.method === "message/send").at(-1)!;
  expect(reply.params.message).toMatchObject({ taskId: answered.a2a?.taskId, parts: [{ kind: "text", text: "Bayview" }] });
});

test("a streaming A2A 0.3 agent is followed over message/stream, and stopping it asks tasks/cancel", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ serve: "0.3", streaming: true, workMs: 100 });
  const work = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: stream it" });
  const done = await settled(t, admin, teamId, work.runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: stream it" });

  const slow = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "slow: keep going" });
  await until(
    t,
    () => runOf(t, admin, teamId, slow.runId),
    (r) => r.a2a?.externalState === "TASK_STATE_WORKING",
    15_000,
    true,
  );
  await admin.as.mutation(api.runs.stop, { teamId, runId: slow.runId });
  const stopped = await until(
    t,
    () => runOf(t, admin, teamId, slow.runId),
    (r) => r.state === "stopped",
    15_000,
    true,
  );
  expect(stopped.a2a?.externalState).toBe("TASK_STATE_CANCELED");
  const methods = (await callsOf(fake)).map((c) => c.method);
  expect(methods.filter((m) => m === "message/stream")).toHaveLength(2);
  expect(methods).toContain("tasks/cancel");
  expect(methods.some((m) => /^[A-Z]/.test(m))).toBe(false);
});

test("a card that promises 1.0 but answers only 0.3: the send that wasn't found is asked once in 0.3, arrives once, and 0.3 is spoken from then on", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({
    serve: "0.3",
    card: "1.0",
    streaming: true,
    bearer: "tok",
    token: "tok",
    workMs: 100,
  });
  const first = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: one" });
  const done = await settled(t, admin, teamId, first.runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: one" });

  const calls = await callsOf(fake);
  const sends = calls.filter((c) => /message|Message/.test(c.method));
  // The stream and the plain send weren't found, so nothing was taken; the 0.3 send took it, once.
  expect(sends.map((c) => c.method)).toEqual(["SendStreamingMessage", "SendMessage", "message/send"]);
  const ids = sends.map((c) => c.params.message.messageId);
  expect(new Set(ids).size).toBe(1);
  expect(sends[2]!.headers["a2a-version"]).toBeUndefined();
  expect((await admin.as.query(api.a2a.get, { teamId, agentId }))?.protocol).toEqual({
    speaks: "0.3",
    declared: "1.0",
    learned: true,
  });

  // Learned: the next run goes straight to 0.3, streaming as the card offers.
  const before = calls.length;
  const second = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: two" });
  await settled(t, admin, teamId, second.runId, "done");
  const next = (await callsOf(fake)).slice(before).map((c) => c.method);
  expect(next[0]).toBe("message/stream");
  expect(next.some((m) => /^[A-Z]/.test(m))).toBe(false);
});

test("an agent that answers neither version's send fails the run in words that name both methods, and nothing is sent again", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ refuseAll: true });
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: x" });
  const failed = await settled(t, admin, teamId, runId, "failed");
  expect(failed.failReason).toBe(
    "Hermes doesn't answer SendMessage, the A2A 1.0 method its Agent Card promises, or message/send from A2A 0.3. It said: “method not found”. Check that the address on its Agent Card is its A2A endpoint.",
  );
  expect(failed.a2a?.delivery).toBe("failed");
  await t.finishAllScheduledFunctions(() => {});
  expect((await callsOf(fake)).map((c) => c.method)).toEqual(["SendMessage", "message/send"]);
  expect((await admin.as.query(api.a2a.get, { teamId, agentId }))?.protocol.learned).toBe(false);
});

// --- Check connection ---

test("Check connection makes one harmless call that needs the token, and says whether it was taken", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ bearer: "right", token: "right" });
  const check = async () => {
    await admin.as.mutation(api.a2a.checkConnection, { teamId, agentId });
    return until(
      t,
      () => admin.as.query(api.a2a.get, { teamId, agentId }),
      (p) => p?.connection?.status !== "checking",
    );
  };
  expect((await check())?.connection).toMatchObject({
    status: "ok",
    dialect: "1.0",
    by: { name: "Julio" },
    summary: "Hermes answered GetTask over A2A 1.0 and took the room's token.",
  });
  const [call] = await callsOf(fake);
  expect(call).toMatchObject({ method: "GetTask", headers: { authorization: "Bearer right", "a2a-version": "1.0" } });
  expect(call!.params.id).toMatch(/^uplink-room-connection-check-/);

  await admin.as.mutation(api.a2a.setCredential, { teamId, agentId, credential: { kind: "bearer", secret: "wrong" } });
  expect((await check())?.connection).toMatchObject({
    status: "failed",
    summary: "Hermes's gateway refused the room's token (HTTP 401). Replace the token.",
  });
  // A refused token is the same in either version, so it isn't asked again in 0.3.
  expect((await callsOf(fake)).map((c) => c.method)).toEqual(["GetTask", "GetTask"]);

  const ana = await addTeammate(t, teamId, admin, "Ana");
  await expect(ana.as.mutation(api.a2a.checkConnection, { teamId, agentId })).rejects.toThrow(/accountable|admin/i);
});

test("Check connection finds an agent that answers only 0.3 behind a 1.0 card, and the room speaks 0.3 to it from then on", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ serve: "0.3", card: "1.0" });
  await admin.as.mutation(api.a2a.checkConnection, { teamId, agentId });
  const peer = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.connection?.status !== "checking",
  );
  expect(peer?.connection).toMatchObject({
    status: "ok",
    dialect: "0.3",
    summary:
      "Hermes answered tasks/get over A2A 0.3 without a token. Its Agent Card says A2A 1.0, so the room speaks A2A 0.3 to it from now on.",
  });
  expect(peer?.protocol).toEqual({ speaks: "0.3", declared: "1.0", learned: true });
  expect((await callsOf(fake)).map((c) => c.method)).toEqual(["GetTask", "tasks/get"]);

  const { runId } = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "reply: hi" });
  expect((await settled(t, admin, teamId, runId, "done")).a2a?.lastMessage).toBe("You said hi");
  expect((await callsOf(fake)).map((c) => c.method).slice(2)).toEqual(["message/send"]);
});

// --- Codex review, round 1 (PR #119) ---

test("an error that echoes the request's headers never saves the room's token: not in a check, a run's reason or its errors", async () => {
  const secret = "hermes-echo-secret-7f3a91";
  const { t, teamId, admin, agentId } = await connected({ bearer: secret, token: secret, echoHeaders: true });
  await admin.as.mutation(api.a2a.checkConnection, { teamId, agentId });
  const peer = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.connection?.status !== "checking",
  );
  expect(peer?.connection).toMatchObject({ status: "failed" });
  expect(peer?.connection?.summary).toMatch(/"authorization":"\[redacted\]"/);

  const { runId } = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: x" });
  const failed = await settled(t, admin, teamId, runId, "failed");
  expect(failed.failReason).toMatch(/^Hermes didn't take the work: invalid params; your headers were/);
  expect(failed.failReason).toContain("[redacted]");

  const shown = JSON.stringify([
    peer,
    failed,
    await admin.as.query(api.a2a.list, { teamId }),
    await admin.as.query(api.a2a.runs, { teamId, agentId }),
  ]);
  const stored = JSON.stringify(
    await t.run(async (ctx) => [
      await ctx.db.query("a2aPeers").collect(),
      await ctx.db.query("a2aBindings").collect(),
      await ctx.db.query("runs").collect(),
    ]),
  );
  expect(shown).not.toContain(secret);
  expect(stored).not.toContain(secret);
});

test("a send answered HTTP 500 with \"method not found\" may have arrived: it is looked for, never sent again another way", async () => {
  for (const streaming of [true, false]) {
    const { t, teamId, admin, agentId, fake } = await connected({ streaming, workMs: 100 });
    const { runId } = await admin.as.mutation(api.runs.start, {
      teamId,
      via: "a2a",
      agentId,
      prompt: "missing500: then work",
    });
    const done = await settled(t, admin, teamId, runId, "done");
    expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: then work" });
    const methods = (await callsOf(fake)).map((c) => c.method);
    // One send, then the search for it: no plain send after the stream, no send in A2A 0.3.
    expect(methods.filter((m) => /message/i.test(m))).toEqual([streaming ? "SendStreamingMessage" : "SendMessage"]);
    expect(methods).toContain("ListTasks");
  }
});

test("a send tried in the other version whose answer is lost is looked for in that version, and the room learns it", async () => {
  // The card names A2A 0.3; the gateway answers only 1.0.
  const { t, teamId, admin, agentId, fake } = await connected({ card: "0.3", workMs: 100 });
  const { runId } = await admin.as.mutation(api.runs.start, {
    teamId,
    via: "a2a",
    agentId,
    prompt: "drop: then work",
  });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: then work" });
  const methods = (await callsOf(fake)).map((c) => c.method);
  expect(methods.filter((m) => /message/i.test(m))).toEqual(["message/send", "SendMessage"]);
  expect(methods).toContain("ListTasks");
  expect((await admin.as.query(api.a2a.get, { teamId, agentId }))?.protocol).toEqual({
    speaks: "1.0",
    declared: "0.3",
    learned: true,
  });
});

test("a connection check still running when the card names another version can't bring back what the room learned", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ serve: "0.3", getTaskDelayMs: 1_500 });
  const get = () => admin.as.query(api.a2a.get, { teamId, agentId });
  await admin.as.mutation(api.a2a.checkConnection, { teamId, agentId });
  await until(t, () => callsOf(fake), (calls) => calls.some((c) => c.method === "tasks/get"), 15_000, true);
  // While the check waits on its answer, the agent's card starts naming A2A 1.0 and is read again.
  await setOptions(fake, { card: "1.0" });
  await admin.as.mutation(api.a2a.recheck, { teamId, agentId });
  await until(t, get, (p) => p?.card?.protocolVersion === "1.0", 15_000, true);
  // The check's answer (0.3 answered) arrives now.
  await t.finishInProgressScheduledFunctions();
  const peer = await get();
  expect(peer?.protocol).toEqual({ speaks: "1.0", declared: "1.0", learned: false });
  expect(peer?.connection).toBeNull();
});

test("a connection check's late result for an old address never removes the check made at the new one", async () => {
  const { t, teamId, admin, agentId, fake } = await connected({ getTaskDelayMs: 2_500 });
  const get = () => admin.as.query(api.a2a.get, { teamId, agentId });
  await admin.as.mutation(api.a2a.checkConnection, { teamId, agentId });
  await until(t, () => callsOf(fake), (calls) => calls.some((c) => c.method === "GetTask"), 15_000, true);
  const moved = await spawn();
  await admin.as.mutation(api.a2a.update, { teamId, agentId, cardUrl: moved.url });
  await until(t, get, (p) => p?.status === "ready" && p.cardUrl === moved.cardUrl, 15_000, true);
  await admin.as.mutation(api.a2a.checkConnection, { teamId, agentId });
  await until(t, get, (p) => p?.connection?.status === "ok", 15_000, true);
  // The first check's answer, about the old address, arrives now.
  await t.finishInProgressScheduledFunctions();
  expect((await get())?.connection).toMatchObject({
    status: "ok",
    summary: "Hermes answered GetTask over A2A 1.0 without a token.",
  });
  expect((await callsOf(moved)).map((c) => c.method)).toEqual(["GetTask"]);
});

// --- Codex review, round 2 (PR #119) ---

test("a token streamed in pieces is taken out once its pieces are joined, in 2 pieces and in 3", async () => {
  for (const pieces of [2, 3]) {
    const secret = `split-secret-${pieces}-0123456789abcdef`;
    const { t, teamId, admin, agentId } = await connected({ streaming: true, bearer: secret, token: secret });
    const { runId } = await admin.as.mutation(api.runs.start, {
      teamId,
      via: "a2a",
      agentId,
      prompt: `split: ${pieces}`,
    });
    const done = await settled(t, admin, teamId, runId, "done");
    expect(done.a2a?.artifacts[0]?.text).toBe("token: [redacted] end");
    const stored = JSON.stringify(await t.run(async (ctx) => ctx.db.query("a2aBindings").collect()));
    expect(stored).not.toContain(secret);
  }
});

test("text is cut only after the token is out of it: an error and a question that run past the limit keep no part of it", async () => {
  const secret = "cut-secret-0123456789abcdefABCDEF";
  // An error whose token straddles where the room used to cut the agent's words (500), and the cut of saved errors (600).
  for (const at of [490, 560]) {
    const { t, teamId, admin, agentId } = await connected({ bearer: secret, token: secret, echoTokenAt: at });
    const { runId } = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: x" });
    const failed = await settled(t, admin, teamId, runId, "failed");
    expect(failed.failReason).toMatch(/^Hermes didn't take the work: p+/);
    expect(failed.failReason).not.toContain(secret.slice(0, 6));
  }
  // A question whose token straddles the 4,000-character limit of what the agent reports.
  const { t, teamId, admin, agentId } = await connected({ bearer: secret, token: secret });
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "leak: 3990" });
  const waiting = await settled(t, admin, teamId, runId, "waiting");
  expect(waiting.a2a?.lastMessage).toMatch(/^p{3990}/);
  expect(JSON.stringify([waiting.prompt, waiting.a2a?.lastMessage])).not.toContain(secret.slice(0, 6));
});

test("a stream refused for its version goes once in the other version, still streaming, and the room learns it", async () => {
  // The card names A2A 0.3 and offers streaming; the gateway answers only 1.0, and says so (-32009).
  const { t, teamId, admin, agentId, fake } = await connected({ card: "0.3", streaming: true, workMs: 100 });
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, via: "a2a", agentId, prompt: "work: stream it" });
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a?.artifacts[0]).toMatchObject({ text: "Done: stream it" });
  const methods = (await callsOf(fake)).map((c) => c.method);
  expect(methods.filter((m) => /message/i.test(m))).toEqual(["message/stream", "SendStreamingMessage"]);
  expect((await admin.as.query(api.a2a.get, { teamId, agentId }))?.protocol).toEqual({
    speaks: "1.0",
    declared: "0.3",
    learned: true,
  });
});
