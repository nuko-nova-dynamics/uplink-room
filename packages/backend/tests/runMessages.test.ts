/**
 * Messages to live runs (ADR 0026, ADR 0029): which messages a run hears, its inbox, who reads the
 * inbox's texts, who may message it, and the inbox's bound. Delivery to the machine is slice 4 of
 * #139; here every message waits in the inbox.
 */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, linkMachine, newRoom, newTeam, present } from "./setup";

/** Julio runs Claude Code on his machine; Ana and Ben are teammates; #general. */
async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const { machineId } = await linkMachine(t, teamId, julio, "julio-mbp");
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  return { t, teamId, julio, julioId, ana, ben, general: general!.channelId, machineId, runId: runId as Id<"runs"> };
}

test("a message that addresses a run waits in its inbox, labelled with who sent it; only the driver reads its text", async () => {
  const { teamId, julio, ana, ben, general, runId } = await room();
  const messageId = await ana.as.mutation(api.messages.post, {
    teamId,
    channelId: general,
    body: `<@run:${runId}> release the model, I'm taking over`,
  });
  // A message that doesn't address it doesn't reach it.
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "lunch?" });

  const inbox = await julio.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox).toMatchObject({ runId, label: "Claude Code (Julio)", waiting: 1 });
  expect(inbox.messages).toEqual([
    expect.objectContaining({
      messageId,
      channelId: general,
      place: "#general",
      text: "@Claude Code (Julio) release the model, I'm taking over",
      from: { member: expect.objectContaining({ name: "Ana" }) },
      accountable: expect.objectContaining({ name: "Ana" }),
      fromDriver: false,
      status: "waiting",
    }),
  ]);

  // Anyone else sees that it got messages, not what they say.
  const outside = await ben.as.query(api.runs.inbox, { teamId, runId });
  expect(outside).toMatchObject({ runId, waiting: 1 });
  expect(outside.messages).toBeUndefined();
  expect(present(await ana.as.query(api.messages.get, { teamId, messageId })).addressedRuns).toEqual([{ runId, label: "Claude Code (Julio)" }]);
});

/** A message the run posted as itself, as `uplink-bridge say` will (slice 5): stored under its driver. */
async function postedByRun(r: Awaited<ReturnType<typeof room>>, body: string) {
  return r.t.run(async (ctx) =>
    ctx.db.insert("messages", {
      teamId: r.teamId,
      channelId: r.general,
      authorId: r.julioId,
      format: "markdown",
      body,
      mentionedTasks: [],
      mentionedRuns: [],
      asRun: { runId: r.runId, label: "Claude Code (Julio)" },
      seq: 900,
    }),
  );
}

const inboxIds = async (r: Awaited<ReturnType<typeof room>>) =>
  (await r.julio.as.query(api.runs.inbox, { teamId: r.teamId, runId: r.runId })).messages!.map((m) => m.messageId);

test("in a thread a run hears replies that name it, and every reply under a message it posted", async () => {
  const r = await room();
  const { teamId, ana, general, runId } = r;
  const root = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "plan for the release" });
  const quiet = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "first", replyTo: root });
  const named = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> second`, replyTo: root });

  const own = await postedByRun(r, "I'll take the build step");
  const under = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "thanks, go ahead", replyTo: own });

  const ids = await inboxIds(r);
  expect(ids).toContain(named);
  expect(ids).toContain(under);
  expect(ids).not.toContain(quiet);
  expect(ids).not.toContain(root);
});

test("a run whose driver narrowed it hears only the driver and their agents; anyone else is told in the place", async () => {
  const r = await room();
  const { t, teamId, julio, ana, general, runId } = r;
  await julio.as.mutation(api.runs.setHears, { teamId, runId, hears: "driver" });
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> stop please` });
  const builder = await addAgent(t, teamId, julio, "Builder", ["room.read", "messages.post"]);
  const fromBuilder = await callAsAgent(t, builder.key, "messages.post", { channelId: general, body: `<@run:${runId}> tests pass` });
  expect(fromBuilder).toMatchObject({ ok: true });

  const inbox = await julio.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox.messages!.map((m) => [m.messageId, m.fromDriver])).toEqual([[fromBuilder.result, true]]);
  const page = (await ana.as.query(api.messages.list, { teamId, channelId: general, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  const line = page.page.find((m) => m.system?.kind === "run");
  expect(line.system.text).toBe("Claude Code (Julio) takes messages only from Julio and their agents, so it didn't get this.");
});

test("messaging a run needs only messages.post, and its inbox holds at most 50 waiting messages", async () => {
  const r = await room();
  const { t, teamId, julio, ana, general, runId } = r;
  const { key } = await addAgent(t, teamId, ana, "Scout", ["room.read", "messages.post"]);
  for (let i = 0; i < 50; i++) {
    expect(await callAsAgent(t, key, "messages.post", { channelId: general, body: `<@run:${runId}> ping ${i}` })).toMatchObject({ ok: true });
  }
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> one too many` });
  const inbox = await julio.as.query(api.runs.inbox, { teamId, runId, limit: 100 });
  expect(inbox.waiting).toBe(50);
  expect(inbox.messages).toHaveLength(50);
  expect(inbox.messages![0]).toMatchObject({ from: { member: { name: "Scout" } }, accountable: { name: "Ana" }, fromDriver: false });
  const page = (await ana.as.query(api.messages.list, { teamId, channelId: general, paginationOpts: { numItems: 5, cursor: null } })) as { page: any[] };
  expect(page.page.find((m) => m.system?.kind === "run").system.text).toBe("Claude Code (Julio) isn't taking messages: 50 are already waiting for it.");
});

test("a message to a run doesn't banner its driver unless it also mentions them (D19)", async () => {
  const r = await room();
  const { teamId, julio, julioId, ana, general, runId } = r;
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  const own = await postedByRun(r, "build is green");
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "nice", replyTo: own });
  expect(await julio.as.query(api.messages.addressed, { teamId })).toEqual([]);

  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${julioId}> your <@run:${runId}> is done` });
  expect((await julio.as.query(api.messages.addressed, { teamId })).map((a) => a.preview)).toEqual(["@Julio your @Claude Code (Julio) is done"]);
});

test("a reply to a run's message in a thread its driver started doesn't banner the driver (D19)", async () => {
  const r = await room();
  const { t, teamId, julio, julioId, ana, general, runId } = r;
  const root = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "who takes the build?" });
  // The run answers in Julio's thread, stored under Julio as its driver.
  const own = await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      teamId,
      channelId: general,
      authorId: julioId,
      format: "markdown",
      body: "I'll take it",
      replyTo: root,
      mentionedTasks: [],
      mentionedRuns: [],
      asRun: { runId, label: "Claude Code (Julio)" },
      seq: 900,
    }),
  );
  const reply = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "thanks", replyTo: own });
  expect(await inboxIds(r)).toContain(reply);
  expect(await julio.as.query(api.messages.addressed, { teamId })).toEqual([]);

  // A reply to Julio's own message in his thread still reaches him.
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "me too", replyTo: root });
  expect((await julio.as.query(api.messages.addressed, { teamId })).map((a) => a.reason)).toEqual(["reply"]);
});
