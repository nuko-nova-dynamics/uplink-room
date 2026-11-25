/**
 * A task given to any agent in the roster (ADR 0044). An agent reached over A2A gets an A2A run, as
 * before; any other (Grok Bot at its routine webhook, an agent that checks in through the connector,
 * one with only a key) gets a run of harness "agent" that it reports on itself with runs.report.
 * The webhook sends run against a local fake webhook (tests/a2a/globalSetup.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { inject } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { setA2ATimingForTests } from "../convex/lib/a2a/timing";
import {
  addAgent,
  addTeammate,
  callAsAgent,
  newRoom,
  newTeam,
  type Person,
  type Room,
} from "./setup";
import { connected, sleep } from "./a2a/helpers";

const HOOK_KEY = "grk_live_given_runs_0001";

type Hook = { id: string; url: string };

async function fakeHook(): Promise<Hook> {
  const response = await fetch(`${inject("fakeAgents")}/webhooks`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return (await response.json()) as Hook;
}

async function callsOf(
  hook: Hook,
): Promise<{ headers: Record<string, string | undefined>; body: string }[]> {
  return (await (await fetch(`${inject("fakeAgents")}/webhooks/${hook.id}/calls`)).json()) as never;
}

/** Runs scheduled work (the send) until `read` gives a value `ok` accepts. */
async function until<T>(
  t: Room,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    await t.finishInProgressScheduledFunctions();
    last = await read();
    if (ok(last)) return last;
    await sleep(15);
  }
  throw new Error(`Timed out. Last value: ${JSON.stringify(last, null, 2)}`);
}

beforeEach(() => setA2ATimingForTests({ fast: true }));
afterEach(() => setA2ATimingForTests(undefined));

/**
 * Julio's team: Ana, a teammate; Grok Bot at a routine webhook, with a key; Duet, which joined
 * through the connector and checks in; and Keyed, an agent with only a key.
 */
async function rosterTeam() {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const grok = await addAgent(t, teamId, admin, "Grok Bot");
  const hook = await fakeHook();
  await admin.as.mutation(api.webhooks.set, {
    teamId,
    agentId: grok.agentId,
    url: hook.url,
    key: HOOK_KEY,
  });
  const duet = await addAgent(t, teamId, admin, "Duet");
  // As connectors.approve leaves it: the connection's agent and the key the room holds for it.
  await t.run(async (ctx) => {
    const key = await ctx.db
      .query("agentKeys")
      .filter((q) => q.eq(q.field("agentId"), duet.agentId))
      .first();
    const now = Date.now();
    await ctx.db.insert("connectors", {
      subject: "user_Julio",
      clientId: "claude",
      createdAt: now,
      lastSeenAt: now,
      teamId,
      agentId: duet.agentId,
      agentKeyId: key!._id,
      approvedAt: now,
    });
  });
  const keyed = await addAgent(t, teamId, admin, "Keyed", [
    "room.read",
    "messages.post",
    "runs.start",
  ]);
  const members = await admin.as.query(api.teams.members, { teamId });
  const memberOf = (name: string) => members.find((m) => m.name === name)!.memberId;
  return {
    t,
    teamId,
    admin,
    ana,
    hook,
    grok: { ...grok, memberId: memberOf("Grok Bot") },
    duet: { ...duet, memberId: memberOf("Duet") },
    keyed: { ...keyed, memberId: memberOf("Keyed") },
  };
}

async function give(
  person: Person,
  teamId: Id<"teams">,
  agentId: Id<"agents">,
  args: { taskId?: Id<"tasks">; prompt?: string } = {},
) {
  const { runId, terminalId } = await person.as.mutation(api.runs.start, {
    teamId,
    via: "agent",
    agentId,
    ...args,
  });
  expect(terminalId).toBeUndefined();
  return runId;
}

describe("runs.start via 'agent'", () => {
  test("for a webhook agent: a run it reports on, a delivery, and one POST of the task", async () => {
    const { t, teamId, ana, hook, grok } = await rosterTeam();
    const taskId = await ana.as.mutation(api.tasks.create, {
      teamId,
      title: "Tidy the changelog",
      description: "Group the entries by area.",
    });
    const runId = await give(ana, teamId, grok.agentId, { taskId });

    const run = await ana.as.query(api.runs.get, { teamId, runId });
    expect(run).toMatchObject({
      harness: "agent",
      state: "unknown",
      taskId,
      title: "Tidy the changelog",
      driver: expect.objectContaining({ memberId: ana.memberId }),
      canReply: true,
      given: {
        agent: { memberId: grok.memberId, agentId: grok.agentId, name: "Grok Bot" },
        reach: "webhook",
        delivery: { status: "sending" },
        messages: [
          expect.objectContaining({
            kind: "start",
            from: expect.objectContaining({ name: "Ana" }),
          }),
        ],
      },
    });
    expect(run.a2a).toBeUndefined();
    expect(run.given!.messages[0]!.text).toBe(
      'Group the entries by area.\n\n---\nSent from Uplink Room by Ana for the task "Tidy the changelog".',
    );

    const sent = await until(
      t,
      () => ana.as.query(api.runs.get, { teamId, runId }),
      (r) => r.given?.delivery?.status !== "sending",
    );
    expect(sent.given!.delivery).toEqual({ status: "sent" });
    const calls = await callsOf(hook);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${HOOK_KEY}`);
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({
      type: "uplink-room.task",
      task: { taskId, title: "Tidy the changelog", description: "Group the entries by area." },
      run: { runId },
      prompt: run.given!.messages[0]!.text,
      from: { memberId: ana.memberId, name: "Ana", kind: "person" },
      accountable: { memberId: ana.memberId, name: "Ana", isYourPerson: false },
      you: { memberId: grok.memberId, name: "Grok Bot" },
      replies: [],
      report: { tool: "runs_report", arguments: { runId } },
    });
    expect(body.instruction).toContain("runs_report");
    expect(body.message).toBeUndefined();
  });

  test("for an agent that checks in: the delivery waits, its own Inbox lists the run, and reading it marks it seen", async () => {
    const { t, teamId, ana, duet } = await rosterTeam();
    const taskId = await ana.as.mutation(api.tasks.create, {
      teamId,
      title: "Draft the release note",
    });
    const runId = await give(ana, teamId, duet.agentId, {
      taskId,
      prompt: "Two paragraphs, plain words.",
    });

    const run = await ana.as.query(api.runs.get, { teamId, runId });
    expect(run.given).toMatchObject({ reach: "checks_in", delivery: { status: "waiting" } });
    await t.finishAllScheduledFunctions(() => {});

    const inbox = await callAsAgent(t, duet.key, "inbox.get", {});
    expect(inbox.ok).toBe(true);
    expect(inbox.result.working.map((r: { taskId?: string }) => r.taskId)).toEqual([taskId]);
    expect(inbox.result.personView).toMatch(/runs\.report/);

    const read = await callAsAgent(t, duet.key, "runs.get", { runId });
    expect(read.result.given.messages[0].text).toMatch(/^Two paragraphs, plain words\./);
    expect((await ana.as.query(api.runs.get, { teamId, runId })).given!.delivery).toEqual({
      status: "seen",
    });
  });

  test("for an agent with only a key: reach none, and the delivery waits for it", async () => {
    const { teamId, ana, keyed } = await rosterTeam();
    const runId = await give(ana, teamId, keyed.agentId, { prompt: "Check the build on main" });
    const run = await ana.as.query(api.runs.get, { teamId, runId });
    expect(run).toMatchObject({ harness: "agent", title: "Check the build on main" });
    expect(run.taskId).toBeUndefined();
    expect(run.given).toMatchObject({ reach: "none", delivery: { status: "waiting" } });
  });

  test("for an A2A agent: an A2A run, as via 'a2a'", async () => {
    const { teamId, admin, agentId } = await connected();
    const { runId } = await admin.as.mutation(api.runs.start, {
      teamId,
      via: "agent",
      agentId,
      prompt: "Summarize the open PRs",
    });
    const run = await admin.as.query(api.runs.get, { teamId, runId });
    expect(run.harness).toBe("a2a");
    expect(run.given).toBeUndefined();
    expect(run.a2a).toMatchObject({ agent: expect.objectContaining({ agentId }) });
  });

  test("refuses an agent giving itself work, a closed task, and a private task the agent can't see", async () => {
    const { t, teamId, admin, ana, grok, keyed } = await rosterTeam();
    const self = await callAsAgent(t, keyed.key, "runs.start", {
      via: "agent",
      agentId: keyed.agentId,
      prompt: "Do it",
    });
    expect(self.ok).toBe(false);
    expect(self.error!.message).toMatch(/can't send work to itself/);

    const closed = await ana.as.mutation(api.tasks.create, { teamId, title: "Done already" });
    await t.run(async (ctx) => ctx.db.patch(closed, { closedAt: Date.now() }));
    await expect(give(ana, teamId, grok.agentId, { taskId: closed })).rejects.toThrow(
      /This task is closed/,
    );

    const direct = (
      await ana.as.mutation(api.channels.openDirect, {
        teamId,
        memberIds: [await memberIdOf(admin, teamId, "Julio")],
      })
    ).channelId;
    const secret = await ana.as.mutation(api.tasks.create, { teamId, title: "Between us" });
    await t.run(async (ctx) => ctx.db.patch(secret, { directChannelId: direct }));
    await expect(give(ana, teamId, grok.agentId, { taskId: secret })).rejects.toThrow(
      /Grok Bot isn't in this direct message/,
    );

    await expect(give(ana, teamId, grok.agentId, {})).rejects.toThrow(/needs text/);
  });
});

async function memberIdOf(person: Person, teamId: Id<"teams">, name: string) {
  return (await person.as.query(api.teams.members, { teamId })).find((m) => m.name === name)!
    .memberId;
}

describe("runs.report", () => {
  test("only the run's agent reports; it sets the state and the line, and waiting lands in the sender's Needs you", async () => {
    const { t, teamId, ana, admin, duet, keyed } = await rosterTeam();
    const taskId = await ana.as.mutation(api.tasks.create, {
      teamId,
      title: "Rename the settings page",
    });
    const runId = await give(ana, teamId, duet.agentId, { taskId });

    await expect(
      ana.as.mutation(api.runs.report, { teamId, runId, state: "working" }),
    ).rejects.toThrow(/Only the agent a run was given to reports on it/);
    const other = await callAsAgent(t, keyed.key, "runs.report", { runId, state: "working" });
    expect(other.error).toMatchObject({ code: "forbidden" });

    const working = await callAsAgent(t, duet.key, "runs.report", {
      runId,
      state: "working",
      message: "Reading the page",
    });
    expect(working.result).toEqual({ runId, state: "working" });
    let run = await ana.as.query(api.runs.get, { teamId, runId });
    expect(run).toMatchObject({
      state: "working",
      given: { lastMessage: { text: "Reading the page" }, delivery: { status: "seen" } },
    });

    const noQuestion = await callAsAgent(t, duet.key, "runs.report", { runId, state: "waiting" });
    expect(noQuestion.error).toMatchObject({ code: "invalid" });
    await callAsAgent(t, duet.key, "runs.report", {
      runId,
      state: "waiting",
      message: "Settings or Preferences?",
    });
    run = await ana.as.query(api.runs.get, { teamId, runId });
    expect(run).toMatchObject({
      state: "waiting",
      prompt: { kind: "question", text: "Settings or Preferences?" },
    });
    const inbox = await ana.as.query(api.inbox.get, { teamId });
    expect(inbox.needsYou.map((r) => r.taskId)).toEqual([taskId]);
    expect(inbox.needsYou[0]!.reason).toBe("Settings or Preferences?");
    // The admin isn't its driver: it isn't waiting on him.
    expect((await admin.as.query(api.inbox.get, { teamId })).needsYou).toEqual([]);

    await ana.as.mutation(api.runs.reply, { teamId, runId, text: "Preferences" });
    const read = await callAsAgent(t, duet.key, "runs.get", { runId });
    expect(read.result.given.messages.map((m: { kind: string; text: string }) => m.kind)).toEqual([
      "start",
      "reply",
    ]);
    expect(read.result.given.messages[1]).toMatchObject({
      text: "Preferences",
      from: expect.objectContaining({ name: "Ana" }),
    });

    await callAsAgent(t, duet.key, "runs.report", {
      runId,
      state: "done",
      message: "Renamed it to Preferences",
    });
    run = await ana.as.query(api.runs.get, { teamId, runId });
    expect(run).toMatchObject({
      state: "done",
      canReply: false,
      endedAt: expect.any(Number),
      given: { lastMessage: { text: "Renamed it to Preferences" } },
    });
    expect(run.prompt).toBeUndefined();
    const late = await callAsAgent(t, duet.key, "runs.report", { runId, state: "working" });
    expect(late.error).toMatchObject({ code: "conflict" });
  });

  test("a stopped run is stopped at once and refuses a later report with who stopped it", async () => {
    const { t, teamId, ana, grok } = await rosterTeam();
    const runId = await give(ana, teamId, grok.agentId, { prompt: "Look at the flaky test" });
    expect(await ana.as.mutation(api.runs.stop, { teamId, runId })).toEqual({
      runId,
      state: "stopped",
    });
    expect((await ana.as.query(api.runs.get, { teamId, runId })).state).toBe("stopped");
    const late = await callAsAgent(t, grok.key, "runs.report", {
      runId,
      state: "done",
      message: "Fixed",
    });
    expect(late.error).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("stopped by Ana"),
    });
    // The send queued before the stop doesn't go.
    await t.finishAllScheduledFunctions(() => {});
    expect((await ana.as.query(api.runs.get, { teamId, runId })).given!.delivery).toMatchObject({
      status: "failed",
    });
  });
});

describe("runs.reply on a given run", () => {
  test("a webhook agent is POSTed the task again with the replies", async () => {
    const { t, teamId, ana, hook, grok } = await rosterTeam();
    const runId = await give(ana, teamId, grok.agentId, {
      prompt: "Find why invoices round wrong",
    });
    await until(
      t,
      () => callsOf(hook),
      (c) => c.length === 1,
    );
    await callAsAgent(t, grok.key, "runs.report", {
      runId,
      state: "waiting",
      message: "Which currency?",
    });

    expect(await ana.as.mutation(api.runs.reply, { teamId, runId, text: "EUR" })).toEqual({
      runId,
    });
    const calls = await until(
      t,
      () => callsOf(hook),
      (c) => c.length === 2,
    );
    const body = JSON.parse(calls[1]!.body);
    expect(body).toMatchObject({
      type: "uplink-room.task",
      run: { runId },
      prompt: expect.stringMatching(/^Find why invoices round wrong/),
      replies: [
        { from: { memberId: ana.memberId, name: "Ana" }, text: "EUR", at: expect.any(String) },
      ],
      report: { tool: "runs_report", arguments: { runId } },
    });
    expect(body.task).toBeUndefined();
  });

  test("only who may steer the run replies", async () => {
    const { t, teamId, admin, ana, keyed } = await rosterTeam();
    const ben = await addTeammate(t, teamId, admin, "Ben");
    const runId = await give(ana, teamId, keyed.agentId, { prompt: "Check the build" });
    await expect(ben.as.mutation(api.runs.reply, { teamId, runId, text: "hi" })).rejects.toThrow(
      /Only the run's driver/,
    );
    expect((await ben.as.query(api.runs.get, { teamId, runId })).canReply).toBe(false);
  });
});

test("the roster gives each agent its agentId and reach", async () => {
  const { teamId, ana, grok, duet, keyed } = await rosterTeam();
  await give(ana, teamId, grok.agentId, { prompt: "Look at the logs" });
  const roster = await ana.as.query(api.teams.roster, { teamId });
  const agents = roster.filter((r) => r.kind === "agent");
  expect(agents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Grok Bot",
        agentId: grok.agentId,
        reach: "webhook",
        state: "unknown",
        runs: 1,
      }),
      expect.objectContaining({
        name: "Duet",
        agentId: duet.agentId,
        reach: "checks_in",
        state: "idle",
      }),
      expect.objectContaining({ name: "Keyed", agentId: keyed.agentId, state: "idle" }),
    ]),
  );
  expect(agents.find((a) => a.name === "Keyed")!.reach).toBeUndefined();
  // A given run isn't listed as a harness.
  expect(roster.filter((r) => r.kind === "harness")).toEqual([]);
});
