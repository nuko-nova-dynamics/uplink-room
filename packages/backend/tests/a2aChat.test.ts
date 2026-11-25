/**
 * Talking with an A2A agent in chat (ADR 0024), against local agents on the official SDK
 * (tests/a2a/fakeAgent.ts): one conversation per place, the agent's context kept and reused, its
 * answers posted where it was called, writing while it works, failures as lines, and threads it
 * proposes. Julio's case from #general is the first test.
 */
import { afterEach, beforeEach, expect, onTestFinished, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { setA2ATimingForTests } from "../convex/lib/a2a/timing";
import { addAgent, addTeammate, bridgeSays, callAsAgent, linkMachine, listed, present, type Person, type Room } from "./setup";
import { callsOf, connected, setOptions, settled, sleep, spawn, until } from "./a2a/helpers";

beforeEach(() => setA2ATimingForTests({ fast: true }));
afterEach(() => setA2ATimingForTests(undefined));

async function general(person: Person, teamId: Id<"teams">): Promise<Id<"channels">> {
  const found = (await person.as.query(api.channels.list, { teamId })).find((c) => c.name === "general");
  return found ? (found.channelId as Id<"channels">) : await person.as.mutation(api.channels.create, { teamId, name: "general" });
}

type Row = ReturnType<typeof listed<any>>[number];

/** The channel's top level, oldest first, once `ok` holds. */
async function channelOnce(t: Room, person: Person, teamId: Id<"teams">, channelId: Id<"channels">, ok: (rows: Row[]) => boolean) {
  return until(t, async () => listed(await person.as.query(api.messages.list, { teamId, channelId })), ok);
}

const sends = async (fake: Parameters<typeof callsOf>[0]) =>
  (await callsOf(fake)).filter((c) => c.method === "SendMessage" || c.method === "SendStreamingMessage");

test("Julio's case: \"@Icarus hey there\" in #general gets a plain answer under it, and a follow-up continues the same context", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const channelId = await general(admin, teamId);
  const hey = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });

  // While it works, Icarus shows as writing in #general.
  const writing = await admin.as.query(api.channels.whoIsTyping, { teamId, channelId });
  expect(writing).toEqual([expect.objectContaining({ member: expect.objectContaining({ name: "Icarus" }), working: true })]);

  let rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const answer = rows.find((m) => m.author.memberId === agentMemberId)!;
  // A plain message in the channel, right under the question: not a thread, not only a chip.
  expect(answer.body).toBe("Icarus here. You said: “hey there”.");
  expect(answer.replyTo).toBeUndefined();
  expect(rows.map((m) => m.messageId)).toEqual([hey, answer.messageId]);
  const question = rows[0]!;
  expect(question.a2aRuns).toHaveLength(1);
  expect(answer.a2a?.runId).toBe(question.a2aRuns[0]);
  // The run is still the unit of tracking: Done. Its answer was read in chat, so it settled itself
  // instead of waiting in Julio's Inbox.
  expect(await settled(t, admin, teamId, answer.a2a!.runId, "done")).toMatchObject({ harness: "a2a", a2a: { externalState: "TASK_STATE_COMPLETED" } });
  expect(JSON.stringify((await admin.as.query(api.inbox.get, { teamId })).done)).not.toContain(answer.a2a!.runId);
  expect(await admin.as.query(api.channels.whoIsTyping, { teamId, channelId })).toEqual([]);
  // The answer came as the status message and as an artifact (as Hermes sends it): posted once.
  expect(rows.filter((m) => m.author.memberId === agentMemberId)).toHaveLength(1);

  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "I asked it about X yesterday too." });
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> and what about X?` });
  rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  const second = rows.at(-1)!;
  expect(second.author.memberId).toBe(agentMemberId);
  expect(second.body).toBe("Icarus here. You said: “and what about X?”. Earlier you said: “hey there”. I can see 3 earlier messages.");
  expect(second.a2a!.runId).not.toBe(answer.a2a!.runId);

  const [first, next] = await sends(fake);
  const firstRun = await admin.as.query(api.runs.get, { teamId, runId: answer.a2a!.runId });
  // The second message starts a new task in the agent's same context, pointing at the last task.
  expect(first!.params.message.contextId).toBeUndefined();
  expect(next!.params.message).toMatchObject({ contextId: firstRun.a2a!.contextId, referenceTaskIds: [firstRun.a2a!.taskId] });
  expect(next!.params.message.taskId).toBeUndefined();
  // The recent messages in #general went with it, as a second text part and in the metadata: until
  // Icarus has answered in a context the room sent, the room can't count on it keeping one.
  expect(next!.params.message.parts[1].text).toMatch(/^Earlier in #general, since you last heard from it/);
  expect(next!.params.message.parts[1].text).toContain("Ana: I asked it about X yesterday too.");
  expect(next!.params.message.parts[1].text).toContain("Icarus (you): Icarus here. You said: “hey there”.");
  expect(next!.params.message.metadata.uplinkRoom.history).toContainEqual(expect.objectContaining({ author: "Ana", text: "I asked it about X yesterday too." }));
  expect(next!.params.message.metadata["uplink.room/capabilities"]).toEqual(["propose-thread"]);

  // It did keep it: from now on, only what came since it last heard, without its own messages.
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "Also Y." });
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> and Y?` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 3);
  const third = (await sends(fake))[2]!;
  expect(third.params.message.contextId).toBe(firstRun.a2a!.contextId);
  expect(third.params.message.metadata.uplinkRoom.history).toEqual([expect.objectContaining({ author: "Ana", text: "Also Y." })]);
});

test("an agent that ignores the context the room sends still has the conversation, from the history", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", ignoreContext: true });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> and what about X?` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  // A fresh context each time: it doesn't remember, but it saw the earlier messages.
  expect(rows.at(-1)!.body).toBe("Icarus here. You said: “and what about X?”. I can see 2 earlier messages.");
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> and Y?` });
  const later = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 3);
  // It never answers in the context the room sent, so it gets the recent messages every time.
  expect(later.at(-1)!.body).toBe("Icarus here. You said: “and Y?”. I can see 4 earlier messages.");
  const [, next] = await sends(fake);
  expect(next!.params.message.parts[1].text).toContain("Julio: @Icarus hey there");
  expect(next!.params.message.parts[1].text).toContain("Icarus (you): Icarus here. You said: “hey there”.");
  // It reads, in text, how to propose a thread: its metadata isn't read by an LLM agent such as Hermes.
  expect(next!.params.message.parts[0].text).toContain("uplink.room/propose-thread: <a short title>");
});

test("an agent that refuses the context the room sends gets the message once more without it, and answers", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  // As if the gateway restarted and lost its contexts.
  await setOptions(fake, { rejectContext: true });
  const forgetful = await t.run(async (ctx) => (await ctx.db.query("a2aConversations").first())!);
  await t.run(async (ctx) => ctx.db.patch(forgetful._id, { contextId: "a-context-it-forgot" }));
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> still there?` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  expect(rows.at(-1)!.body).toMatch(/^Icarus here\. You said: “still there\?”/);
  const [, refused, again] = await sends(fake);
  expect(refused!.params.message.contextId).toBe("a-context-it-forgot");
  expect(again!.params.message.contextId).toBeUndefined();
  // The same message: refused, it took nothing, so this isn't a second delivery.
  expect(again!.params.message.messageId).toBe(refused!.params.message.messageId);
  // The fresh context starts empty, so the place's recent messages go with it again.
  expect(again!.params.message.parts[1].text).toContain("Julio: @Icarus hey there");
  expect(rows.some((m) => m.system)).toBe(false);
});

test("past Hermes's turn limit the agent refuses the context: the room starts a fresh one, and nothing fails", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", maxTurns: 2 });
  const channelId = await general(admin, teamId);
  for (const [n, body] of ["one", "two", "three"].entries()) {
    await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> ${body}` });
    await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === n + 1);
  }
  const rows = listed(await admin.as.query(api.messages.list, { teamId, channelId }));
  expect(rows.at(-1)!.body).toMatch(/^Icarus here\. You said: “three”/);
  expect(rows.some((m) => m.system)).toBe(false);
  const all = await sends(fake);
  expect(all).toHaveLength(4);
  // The third went in the old context, was rejected at once, and went again in a fresh one.
  expect(all[2]!.params.message.contextId).toBe(all[1]!.params.message.contextId);
  expect(all[3]!.params.message.contextId).toBeUndefined();
  expect(all[3]!.params.message.parts[1].text).toContain("Julio: @Icarus one");
  expect(rows.at(-1)!.body).toContain("I can see");
  const run = await admin.as.query(api.runs.get, { teamId, runId: rows.at(-1)!.a2a!.runId });
  expect(run).toMatchObject({ state: "done" });
});

test("a message sent while the agent's task is open goes to that task, once, and starts no new run", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", workMs: 900 });
  const channelId = await general(admin, teamId);
  const first = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> long: the tide report` });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: first })).a2aRuns[0]!;
  await until(t, () => admin.as.query(api.runs.get, { teamId, runId }), (r) => r.a2a?.externalState === "TASK_STATE_WORKING");
  const also = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> add the charts too` });
  expect(present(await admin.as.query(api.messages.get, { teamId, messageId: also })).a2aRuns).toEqual([runId]);
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  expect(rows.some((m) => m.system)).toBe(false);
  expect(rows.find((m) => m.author.memberId === agentMemberId)!.body).toBe("Done with the tide report. While I worked you also said: “add the charts too”.");
  const run = await settled(t, admin, teamId, runId, "done");
  const followUps = (await sends(fake)).filter((c) => c.params.message.parts[0].text.startsWith("@Icarus add the charts too"));
  expect(followUps).toHaveLength(1);
  expect(followUps[0]!.params.message.taskId).toBe(run.a2a!.taskId);
  expect((await admin.as.query(api.a2a.runs, { teamId, agentId: run.a2a!.agent.agentId as Id<"agents"> })).length).toBe(1);
});

test("a message sent before the agent answered the first waits for it, and goes on in the same context when that ends", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "reply: hello" });
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "and again" });
  const rows = await channelOnce(t, admin, teamId, dm, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  expect(rows.filter((m) => m.author.memberId === agentMemberId).map((m) => m.body)).toEqual([
    "You said hello",
    "Icarus here. You said: “and again”. Earlier you said: “reply: hello”. I can see 1 earlier messages.",
  ]);
  // The second waited for the first answer, then went in the context that answer came in.
  const [one, two] = await sends(fake);
  const conversation = await t.run(async (ctx) => (await ctx.db.query("a2aConversations").first())!);
  expect(one!.params.message.contextId).toBeUndefined();
  expect(two!.params.message.contextId).toBe(conversation.contextId);
  expect(conversation.contextId).toBeTruthy();
  // Each message points at the run it went to.
  const mine = rows.filter((m) => m.author.memberId !== agentMemberId);
  expect(new Set(mine.map((m) => m.a2aRuns[0])).size).toBe(2);
});

test("in a thread the agent answers in the thread; a reply under its own message reaches it without a mention", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const channelId = await general(admin, teamId);
  const root = await ana.as.mutation(api.messages.post, { teamId, channelId, body: "Release notes for Thursday?" });
  await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: root, body: `<@${agentMemberId}> draft them` });
  const replies = await until(t, () => admin.as.query(api.messages.replies, { teamId, messageId: root }), (r) => r.some((m) => m.author.memberId === agentMemberId));
  expect(replies.at(-1)).toMatchObject({ author: { name: "Icarus" }, replyTo: root, body: expect.stringContaining("You said: “draft them”") });
  // Nothing at the top level.
  expect(listed(await admin.as.query(api.messages.list, { teamId, channelId })).some((m) => m.author.memberId === agentMemberId)).toBe(false);
  // Without a mention, a reply in someone else's thread isn't for the agent.
  const quiet = await ana.as.mutation(api.messages.post, { teamId, channelId, replyTo: root, body: "Thanks!" });
  expect(present(await ana.as.query(api.messages.get, { teamId, messageId: quiet })).a2aRuns).toEqual([]);

  // Its own message's thread is its own: a reply there goes to it.
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });
  const top = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const own = top.find((m) => m.author.memberId === agentMemberId)!;
  const followUp = await ana.as.mutation(api.messages.post, { teamId, channelId, replyTo: own.messageId, body: "Can you say more?" });
  expect(present(await ana.as.query(api.messages.get, { teamId, messageId: followUp })).a2aRuns).toHaveLength(1);
  const inOwn = await until(t, () => ana.as.query(api.messages.replies, { teamId, messageId: own.messageId }), (r) => r.some((m) => m.author.memberId === agentMemberId));
  expect(inOwn.at(-1)!.body).toContain("You said: “Can you say more?”");
});

test("in a direct message a question shows as the agent's message, and answering it in the DM finishes the same task", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ name: "Icarus", agentName: "Icarus" });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  const asked = await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "ask: Which branch?" });
  let rows = await channelOnce(t, admin, teamId, dm, (r) => r.some((m) => m.author.memberId === agentMemberId));
  expect(rows.at(-1)).toMatchObject({ body: "Which branch?", author: { name: "Icarus" } });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).a2aRuns[0]!;
  expect(await admin.as.query(api.runs.get, { teamId, runId })).toMatchObject({ state: "waiting" });
  // Not writing while it waits for you.
  expect(await admin.as.query(api.channels.whoIsTyping, { teamId, channelId: dm })).toEqual([]);
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "main" });
  rows = await channelOnce(t, admin, teamId, dm, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  expect(rows.at(-1)!.body).toBe("Thanks: main");
  const done = await settled(t, admin, teamId, runId, "done");
  expect((await sends(fake))[1]!.params.message.taskId).toBe(done.a2a!.taskId);
});

test("a failure, a refusal and a rejected message each show as a short line in the chat with the run", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> fail: disk full` });
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> reject: not my job` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.system).length === 2);
  const lines = rows.filter((m) => m.system).map((m) => m.system);
  expect(lines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "run", text: "Icarus couldn't finish: disk full", tone: "warn" }),
      expect.objectContaining({ kind: "run", text: "Icarus declined: not my job", tone: "warn" }),
    ]),
  );
  const inbox = JSON.stringify(await admin.as.query(api.inbox.get, { teamId }));
  for (const line of lines) {
    const runId = (line as { runId: Id<"runs"> }).runId;
    expect((await admin.as.query(api.runs.get, { teamId, runId })).state).toBe("failed");
    // A failure isn't settled by its line: it stays in the Inbox for someone to look at.
    expect(inbox).toContain(runId);
  }
});

test("the agent proposes its own thread: Yes moves its work under the message that started it, in the same conversation", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const channelId = await general(admin, teamId);
  const trigger = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the Q3 migration` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal));
  const proposal = rows.find((m) => m.a2a?.proposal)!;
  expect(proposal).toMatchObject({
    body: "This looks like it should be its own thread. Want me to open it?",
    a2a: { proposal: { status: "pending", title: "the Q3 migration", triggerMessageId: trigger, canDecide: true } },
  });
  expect(proposal.a2a!.proposal!.expiresAt - proposal.postedAt).toBeGreaterThanOrEqual(29_000);
  // Only whoever asked, the run's driver or an admin answers it.
  const seen = present(await ana.as.query(api.messages.get, { teamId, messageId: proposal.messageId }));
  expect(seen.a2a!.proposal!.canDecide).toBe(false);
  await expect(ana.as.mutation(api.messages.answerProposal, { teamId, messageId: proposal.messageId, open: true })).rejects.toThrow(/Only whoever wrote/);

  await admin.as.mutation(api.messages.answerProposal, { teamId, messageId: proposal.messageId, open: true });
  const thread = await until(t, () => admin.as.query(api.messages.replies, { teamId, messageId: trigger }), (r) => r.some((m) => m.author.memberId === agentMemberId));
  expect(thread.at(-1)!.body).toBe("In the thread: the plan for the Q3 migration.");
  expect(present(await admin.as.query(api.messages.get, { teamId, messageId: proposal.messageId })).a2a!.proposal).toMatchObject({ status: "accepted", decidedBy: { name: "Julio" } });
  // The answer went on the agent's same task, saying Yes in its metadata.
  const answer = (await sends(fake))[1]!;
  expect(answer.params.message.metadata["uplink.room/thread-decision"]).toEqual({ open: true, byTimeout: false });
  // The thread is the agent's own now: a reply there reaches it without a mention.
  const more = await ana.as.mutation(api.messages.post, { teamId, channelId, replyTo: trigger, body: "Include the rollback plan." });
  expect(present(await ana.as.query(api.messages.get, { teamId, messageId: more })).a2aRuns).toHaveLength(1);
});

test("No keeps the answer where it was; nobody answering in time counts as Yes; a proposal in text works too", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the logo` });
  let rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal));
  await admin.as.mutation(api.messages.answerProposal, { teamId, messageId: rows.find((m) => m.a2a?.proposal)!.messageId, open: false });
  rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.body === "Here: the plan for the logo."));
  expect(rows.find((m) => m.body === "Here: the plan for the logo.")!.replyTo).toBeUndefined();

  // An agent that answers only text proposes with its first line; nobody answers within 30 seconds.
  const trigger = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose-line: the budget` });
  rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.a2a?.proposal).length === 2);
  const textual = rows.filter((m) => m.a2a?.proposal).at(-1)!;
  expect(textual).toMatchObject({ body: "Shall I take this to a thread?", a2a: { proposal: { title: "the budget", status: "pending" } } });
  await t.mutation(internal.a2aWorker.proposalTimeout, { messageId: textual.messageId });
  const thread = await until(t, () => admin.as.query(api.messages.replies, { teamId, messageId: trigger }), (r) => r.some((m) => m.author.memberId === agentMemberId));
  expect(thread.at(-1)!.body).toBe("Thread it is: the plan for the budget.");
  const decided = present(await admin.as.query(api.messages.get, { teamId, messageId: textual.messageId })).a2a!.proposal!;
  expect(decided.status).toBe("accepted");
  expect(decided.decidedBy).toBeUndefined();
});

test("the room's token never reaches chat: an answer that holds it is posted cleaned", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ bearer: "secret-token-1234567890", token: "secret-token-1234567890", name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> leak: 10` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const said = rows.find((m) => m.author.memberId === agentMemberId)!;
  expect(said.body).toBe("pppppppppp[redacted] end");
  expect(JSON.stringify(await t.run(async (ctx) => ctx.db.query("messages").collect()))).not.toContain("secret-token-1234567890");
});

test("a file the agent sends as bytes is attached to its answer, with its links listed", async () => {
  // Hold completion until the room has recorded progress.
  const { t, teamId, admin, agentMemberId, fake } = await connected({ name: "Icarus", agentName: "Icarus", holdWork: true });
  onTestFinished(() => setOptions(fake, { holdWork: false }));
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> file: tide-notes.txt` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const answer = rows.find((m) => m.author.memberId === agentMemberId)!;
  expect(answer.body).toBe("Here is tide-notes.txt.");
  expect(answer.attachments).toEqual([expect.objectContaining({ name: "tide-notes.txt", kind: "file", size: 11 })]);

  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> work: the report` });
  await until(t, async () => listed(await admin.as.query(api.messages.list, { teamId, channelId })),
    (rows) => rows.some((m) => m.body === "Working on it"), 15_000, true);
  await setOptions(fake, { holdWork: false });
  const later = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.body.startsWith("Done: the report")));
  // Its progress came first, as its own message; the answer lists the artifact's link.
  expect(later.filter((m) => m.author.memberId === agentMemberId).map((m) => m.body).slice(1)).toEqual([
    "Working on it",
    "Done: the report\n\n- [report.pdf](https://example.com/report.pdf)",
  ]);
});

test("history comes only from the place, and replying on a finished chat run posts in its place and continues it", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const other = await admin.as.mutation(api.channels.create, { teamId, name: "random" });
  await admin.as.mutation(api.messages.post, { teamId, channelId: other, body: "the secret plan" });
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: "Morning." });
  const hey = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const [first] = await sends(fake);
  expect(first!.params.message.parts[1].text).toContain("Julio: Morning.");
  expect(JSON.stringify(first!.params.message)).not.toContain("secret plan");

  // The run panel's reply box, after the run is Done: a chat message in #general that continues the context.
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: hey })).a2aRuns[0]!;
  const done = await settled(t, admin, teamId, runId, "done");
  expect(done.a2a!.replies).toBe("conversation");
  const { runId: next } = await admin.as.mutation(api.runs.reply, { teamId, runId, text: "one more thing" });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  expect(rows.at(-2)).toMatchObject({ body: `<@${agentMemberId}> one more thing`, a2aRuns: [next] });
  expect(rows.at(-1)!.body).toContain("Earlier you said: “hey there”");
});

test("an A2A 0.3 agent's conversation goes on in its context too, with the history as a second text part in 0.3's shape", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ serve: "0.3", name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> reply: hi` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> reply: again` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId).length === 2);
  expect(rows.at(-1)!.body).toBe("You said again");
  const [first, second] = (await callsOf(fake)).filter((c) => c.method === "message/send");
  const conversation = await t.run(async (ctx) => (await ctx.db.query("a2aConversations").first())!);
  expect(first!.params.message.contextId).toBeUndefined();
  expect(second!.params.message).toMatchObject({ kind: "message", role: "user", contextId: conversation.contextId });
  expect(second!.params.message.parts[1]).toMatchObject({ kind: "text", text: expect.stringContaining("Earlier in #general") });
});

// ---------- review fixes (PR #130) ----------

const isAgent = (agentMemberId: Id<"members">) => (m: Row) => m.author.memberId === agentMemberId;
const decisionOf = (c: { params: any }) => c.params.message.metadata?.["uplink.room/thread-decision"];

test("runs.reply on a chat run posts in chat only for a key that may post there; a task run's reply needs only runs.start", async () => {
  const { t, teamId, admin, agentId, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const hey = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: hey })).a2aRuns[0]!;
  await settled(t, admin, teamId, runId, "done");
  // An agent accountable to Julio may steer his run, but its key can't post messages.
  const helper = await addAgent(t, teamId, admin, "Helper", ["room.read", "runs.start"]);
  const refused = await callAsAgent(t, helper.key, "runs.reply", { runId, text: "one more thing" });
  expect(refused).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining('"messages.post" scope') } });
  expect(listed(await admin.as.query(api.messages.list, { teamId, channelId })).some((m) => m.body.includes("one more thing"))).toBe(false);
  // A run on a task isn't in chat: a reply goes to the agent's task with runs.start alone.
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Pick a branch" });
  const { runId: taskRun } = await admin.as.mutation(api.runs.start, { teamId, taskId, via: "a2a", agentId, prompt: "ask: Which branch?" });
  await settled(t, admin, teamId, taskRun, "waiting");
  expect(await callAsAgent(t, helper.key, "runs.reply", { runId: taskRun, text: "main" })).toMatchObject({ ok: true, result: { runId: taskRun } });
  expect((await settled(t, admin, teamId, taskRun, "done")).a2a!.artifacts[0]!.text).toBe("Thanks: main");
});

test("a direct Message answer's files are attached to it, with its text or alone", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ name: "Icarus", agentName: "Icarus" });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "reply-file: tide-notes.txt" });
  let rows = await channelOnce(t, admin, teamId, dm, (r) => r.some(isAgent(agentMemberId)));
  expect(rows.find(isAgent(agentMemberId))).toMatchObject({
    body: "Here is tide-notes.txt.",
    attachments: [expect.objectContaining({ name: "tide-notes.txt", kind: "file", size: 11 })],
  });
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "reply-file-only: chart.txt" });
  rows = await channelOnce(t, admin, teamId, dm, (r) => r.filter(isAgent(agentMemberId)).length === 2);
  expect(rows.at(-1)).toMatchObject({ body: "", attachments: [expect.objectContaining({ name: "chart.txt", size: 11 })] });
  // Not "answered without any text": the file is the answer.
  expect(rows.some((m) => m.system)).toBe(false);
});

test("an artifact link whose name isn't valid percent-encoding is listed as written, and the answer is posted", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const asked = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> link: report-100%.pdf` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some(isAgent(agentMemberId)));
  expect(rows.find(isAgent(agentMemberId))!.body).toBe("Here is the link.\n\n- [report-100%.pdf](https://example.com/files/report-100%.pdf)");
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).a2aRuns[0]!;
  expect(await settled(t, admin, teamId, runId, "done")).toMatchObject({ a2a: { externalState: "TASK_STATE_COMPLETED" } });
});

test("a reply the agent takes into a new task of its own goes on as a run on the same room task", async () => {
  const { t, teamId, admin, agentId } = await connected({ name: "Icarus", agentName: "Icarus", ignoreTaskId: true, workMs: 50 });
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Pick a branch" });
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, taskId, via: "a2a", agentId, prompt: "ask: Which branch?" });
  await settled(t, admin, teamId, runId, "waiting");
  // Hermes opens a task for every message, so the answer to its question comes back as a new task.
  await admin.as.mutation(api.runs.reply, { teamId, runId, text: "work: main" });
  const runs = await until(t, () => admin.as.query(api.a2a.runs, { teamId, agentId }), (r) => r.length === 2 && r[0]!.state === "done");
  expect(runs[0]).toMatchObject({ taskId, a2a: { artifacts: [expect.objectContaining({ text: "Done: main" })] } });
  expect(runs[1]).toMatchObject({ runId, taskId });
});

test("a task's runs name their conversation: a reply after the agent finished shares it, another run started on the task has its own", async () => {
  const { t, teamId, admin, agentId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Bayview tides" });
  const { runId: first } = await admin.as.mutation(api.runs.start, { teamId, taskId, via: "a2a", agentId, prompt: "hey there" });
  const done = await settled(t, admin, teamId, first, "done");
  expect(done.a2a!.conversationId).toBeDefined();
  const { runId: next } = await admin.as.mutation(api.runs.reply, { teamId, runId: first, text: "and tomorrow?" });
  expect(next).not.toBe(first);
  const { runId: other } = await admin.as.mutation(api.runs.start, { teamId, taskId, via: "a2a", agentId, prompt: "hey again" });
  const runs = (await admin.as.query(api.tasks.get, { teamId, taskId }))!.runs;
  const conversationOf = (runId: Id<"runs">) => runs.find((r) => r.runId === runId)!.a2a!.conversationId;
  expect(conversationOf(next)).toBe(done.a2a!.conversationId);
  expect(conversationOf(other)).toBeDefined();
  expect(conversationOf(other)).not.toBe(done.a2a!.conversationId);
});

test("after the agent's address changes, a message sent during its open task goes to the new address", async () => {
  const { t, teamId, admin, agentId, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", workMs: 3_000 });
  const channelId = await general(admin, teamId);
  const first = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> long: the tide report` });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: first })).a2aRuns[0]!;
  await until(t, () => admin.as.query(api.runs.get, { teamId, runId }), (r) => r.a2a?.externalState === "TASK_STATE_WORKING");
  const moved = await spawn({ chat: true, name: "Icarus" });
  await admin.as.mutation(api.a2a.update, { teamId, agentId, cardUrl: moved.url });
  await until(t, () => admin.as.query(api.a2a.get, { teamId, agentId }), (p) => p?.status === "ready" && p.endpointUrl === moved.url);
  const next = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> hey there` });
  const [nextRun] = present(await admin.as.query(api.messages.get, { teamId, messageId: next })).a2aRuns;
  // A new run at the new address, not a message queued on the run the room stops following.
  expect(nextRun).toBeDefined();
  expect(nextRun).not.toBe(runId);
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.body.startsWith("Icarus here. You said: “hey there”.")));
  expect((await sends(moved)).map((c) => c.params.message.parts[0].text.split("\n")[0])).toEqual(["@Icarus hey there"]);
  expect((await sends(fake)).some((c) => c.params.message.parts[0].text.startsWith("@Icarus hey there"))).toBe(false);
});

test("stopping or detaching a run takes its pending thread proposal with it: the wait running out starts nothing", async () => {
  const { t, teamId, admin, agentId, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const proposalNo = async (n: number) =>
    (await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.a2a?.proposal).length === n)).filter((m) => m.a2a?.proposal).at(-1)!;
  const proposalNow = async (messageId: Id<"messages">) => present(await admin.as.query(api.messages.get, { teamId, messageId })).a2a!.proposal;

  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the logo` });
  const stopped = await proposalNo(1);
  await admin.as.mutation(api.runs.stop, { teamId, runId: stopped.a2a!.runId });
  expect(await proposalNow(stopped.messageId)).toMatchObject({ status: "canceled", reason: "No thread opened: Julio stopped the run.", canDecide: false });
  await settled(t, admin, teamId, stopped.a2a!.runId, "stopped");
  await t.mutation(internal.a2aWorker.proposalTimeout, { messageId: stopped.messageId });

  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the budget` });
  const detached = await proposalNo(2);
  await admin.as.mutation(api.runs.detach, { teamId, runId: detached.a2a!.runId });
  expect(await proposalNow(detached.messageId)).toMatchObject({ status: "canceled", reason: "No thread opened: the room stopped following the run." });
  await t.mutation(internal.a2aWorker.proposalTimeout, { messageId: detached.messageId });

  // Neither wait started the conversation again: two messages went to the agent, in two runs.
  await sleep(300);
  await t.finishInProgressScheduledFunctions();
  expect(await sends(fake)).toHaveLength(2);
  expect(await admin.as.query(api.a2a.runs, { teamId, agentId })).toHaveLength(2);
});

test("a reply whose answer was lost, that the agent took into a new task of its own, is found in the context and followed", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ name: "Icarus", agentName: "Icarus", ignoreTaskId: true, workMs: 50 });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "ask: Which branch?" });
  await channelOnce(t, admin, teamId, dm, (r) => r.some(isAgent(agentMemberId)));
  // Sent to the open task, taken into a new one, and the HTTP answer cut off before it arrived.
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "drop: main" });
  const rows = await channelOnce(t, admin, teamId, dm, (r) => r.some((m) => m.body.startsWith("Done: main")));
  // Not "It may not have your last message": the room found it, and sent nothing twice.
  expect(rows.some((m) => m.system)).toBe(false);
  expect((await sends(fake)).filter((c) => c.params.message.parts[0].text.startsWith("drop: main"))).toHaveLength(1);
  expect((await callsOf(fake)).some((c) => c.method === "ListTasks" && c.params.contextId)).toBe(true);
});

test("a reply the agent rejects past its turn limit, in a new task of its own, goes once more in a fresh context", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", ignoreTaskId: true, maxTurns: 1 });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "ask: Which branch?" });
  await channelOnce(t, admin, teamId, dm, (r) => r.some(isAgent(agentMemberId)));
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "main" });
  const rows = await channelOnce(t, admin, teamId, dm, (r) => r.some((m) => m.body.startsWith("Icarus here. You said: “main”.")));
  // Not "Icarus declined: Anti-loop protection …".
  expect(rows.some((m) => m.system)).toBe(false);
  const mains = (await sends(fake)).filter((c) => c.params.message.parts[0].text.startsWith("main"));
  expect(mains).toHaveLength(2);
  expect(mains[0]!.params.message.contextId).toBeTruthy();
  expect(mains[1]!.params.message.contextId).toBeUndefined();
});

test("answering a thread proposal sends the agent work: a key without runs.start can't, one with it can", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const helper = await addAgent(t, teamId, admin, "Helper", ["room.read", "runs.start", "messages.post"]);
  const { secret: postOnly } = await admin.as.mutation(api.agents.createKey, { teamId, agentId: helper.agentId, name: "post-only", scopes: ["room.read", "messages.post"] });
  expect(await callAsAgent(t, helper.key, "messages.post", { channelId, body: `<@${agentMemberId}> propose: the logo` })).toMatchObject({ ok: true });
  const proposal = (await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal))).find((m) => m.a2a?.proposal)!;
  // Helper wrote the message it would open under, but this key can't send work.
  const refused = await callAsAgent(t, postOnly, "messages.answerProposal", { messageId: proposal.messageId, open: true });
  expect(refused).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining('"runs.start" scope') } });
  expect(present(await admin.as.query(api.messages.get, { teamId, messageId: proposal.messageId })).a2a!.proposal!.status).toBe("pending");
  expect(await callAsAgent(t, helper.key, "messages.answerProposal", { messageId: proposal.messageId, open: false })).toMatchObject({ ok: true, result: { open: false } });
});

test("deleting a pending thread proposal cancels it and tells the agent no thread opened; its next proposal shows", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the logo` });
  const proposal = (await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal))).find((m) => m.a2a?.proposal)!;
  await admin.as.mutation(api.messages.delete, { teamId, messageId: proposal.messageId });
  // The agent's task waited on the answer: it gets one, and answers here.
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.body === "Here: the plan for the logo."));
  const told = (await sends(fake)).find(decisionOf)!;
  expect(decisionOf(told)).toEqual({ open: false, byTimeout: false });
  expect(told.params.message.parts[0].text).toMatch(/^No thread: your proposal was deleted\. Answer here in #general\./);
  // The conversation takes a new proposal.
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the budget` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal?.title === "the budget" && m.a2a.proposal.status === "pending"));
});

test("deleting the message a thread proposal would open under cancels it, and the agent hears no thread opened", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const trigger = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose: the logo` });
  const proposal = (await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal))).find((m) => m.a2a?.proposal)!;
  await admin.as.mutation(api.messages.delete, { teamId, messageId: trigger });
  // The wait running out afterwards opens nothing.
  await t.mutation(internal.a2aWorker.proposalTimeout, { messageId: proposal.messageId });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.body === "Here: the plan for the logo."));
  expect(present(await admin.as.query(api.messages.get, { teamId, messageId: proposal.messageId })).a2a!.proposal).toMatchObject({
    status: "canceled",
    reason: "No thread opened: the message it would open under was deleted.",
  });
  expect((await sends(fake)).filter(decisionOf).map(decisionOf)).toEqual([{ open: false, byTimeout: false }]);
});

// ---------- review fixes, last round (PR #130) ----------

/** A step's lease, as one mid-call holds it: no other step takes the run until `letGo`. */
const IN_FLIGHT = "in-flight";
async function hold(t: Room, runId: Id<"runs">): Promise<Id<"a2aBindings">> {
  return t.run(async (ctx) => {
    const binding = (await ctx.db.query("a2aBindings").withIndex("by_run", (q) => q.eq("runId", runId)).unique())!;
    // wakeRequested ends the step that holds a stream open now.
    await ctx.db.patch(binding._id, { lease: { token: IN_FLIGHT, until: Date.now() + 60_000 }, wakeRequested: true });
    return binding._id;
  });
}
const letGo = (t: Room, bindingId: Id<"a2aBindings">) => t.mutation(internal.a2aWorker.release, { bindingId, lease: IN_FLIGHT });

async function slowRun(t: Room, admin: Person, teamId: Id<"teams">, channelId: Id<"channels">, agentMemberId: Id<"members">) {
  const asked = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> slow: the migration` });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).a2aRuns[0]!;
  const run = await until(t, () => admin.as.query(api.runs.get, { teamId, runId }), (r) => r.a2a?.externalState === "TASK_STATE_WORKING");
  return { runId, taskId: run.a2a!.taskId! };
}

test("a thread proposal that comes in after someone asked to stop the run isn't shown, and nothing starts again", async () => {
  const { t, teamId, admin, agentId, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const { runId, taskId } = await slowRun(t, admin, teamId, channelId, agentMemberId);
  // Julio presses Stop while the agent's answer is on its way, and that answer proposes a thread.
  const bindingId = await hold(t, runId);
  await admin.as.mutation(api.runs.stop, { teamId, runId });
  const answer = { kind: "task" as const, taskId, state: "TASK_STATE_INPUT_REQUIRED", message: "This looks like it should be its own thread. Want me to open it?", proposal: { title: "the migration" } };
  expect(await t.mutation(internal.a2aWorker.observed, { bindingId, lease: IN_FLIGHT, observation: answer })).toBe("changed");
  expect(listed(await admin.as.query(api.messages.list, { teamId, channelId })).some((m) => m.a2a?.proposal)).toBe(false);
  // The stop goes on; nothing waits to open a thread and send the agent work.
  await letGo(t, bindingId);
  await settled(t, admin, teamId, runId, "stopped");
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.system?.text === "Icarus stopped, as asked."));
  expect(rows.some((m) => m.a2a?.proposal)).toBe(false);
  expect(await sends(fake)).toHaveLength(1);
  expect(await admin.as.query(api.a2a.runs, { teamId, agentId })).toHaveLength(1);
});

test("messages waiting on a run when someone stops it aren't sent, before or after the agent confirms the stop: a line says so", async () => {
  // The agent takes the cancel request at once and confirms it a moment later.
  const { t, teamId, admin, agentId, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", cancelAsync: true });
  const channelId = await general(admin, teamId);
  const { runId } = await slowRun(t, admin, teamId, channelId, agentMemberId);
  // A follow-up waits to go to the open task when Julio stops the run.
  const bindingId = await hold(t, runId);
  const also = await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> and the rollback plan` });
  expect(present(await admin.as.query(api.messages.get, { teamId, messageId: also })).a2aRuns).toEqual([runId]);
  await admin.as.mutation(api.runs.stop, { teamId, runId });
  await letGo(t, bindingId);
  await settled(t, admin, teamId, runId, "stopped");
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.system?.text === "A message waiting for Icarus wasn't sent: Julio stopped the run."));
  await sleep(200);
  await t.finishInProgressScheduledFunctions();
  // Neither sent to the task being stopped nor carried over to a new one.
  expect((await sends(fake)).some((c) => c.params.message.parts[0].text.includes("rollback plan"))).toBe(false);
  expect(await admin.as.query(api.a2a.runs, { teamId, agentId })).toHaveLength(1);
});

test("a reply the agent answers with a new, finished task holding a file is posted with the file attached", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ name: "Icarus", agentName: "Icarus", ignoreTaskId: true, blocking: true });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "ask: Which notes?" });
  await channelOnce(t, admin, teamId, dm, (r) => r.some(isAgent(agentMemberId)));
  // Hermes opens a new task for every message; the send's answer is that task, finished, with a file as bytes.
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "file: tide-notes.txt" });
  const rows = await channelOnce(t, admin, teamId, dm, (r) => r.some((m) => m.body === "Here is tide-notes.txt."));
  expect(rows.find((m) => m.body === "Here is tide-notes.txt.")!.attachments).toEqual([expect.objectContaining({ name: "tide-notes.txt", kind: "file", size: 11 })]);
});

test("a reply whose answer was lost, found in the context as a new task holding a file, is posted with the file attached", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ name: "Icarus", agentName: "Icarus", ignoreTaskId: true });
  const dm = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId] })).channelId;
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "ask: Which notes?" });
  await channelOnce(t, admin, teamId, dm, (r) => r.some(isAgent(agentMemberId)));
  await admin.as.mutation(api.messages.post, { teamId, channelId: dm, body: "drop: file: tide-notes.txt" });
  const rows = await channelOnce(t, admin, teamId, dm, (r) => r.some((m) => m.body === "Here is tide-notes.txt."));
  expect(rows.find((m) => m.body === "Here is tide-notes.txt.")!.attachments).toEqual([expect.objectContaining({ name: "tide-notes.txt", kind: "file", size: 11 })]);
  // Found through the context's tasks, not sent again.
  expect((await callsOf(fake)).some((c) => c.method === "ListTasks" && c.params.contextId)).toBe(true);
  expect((await sends(fake)).filter((c) => c.params.message.parts[0].text.startsWith("drop: file:"))).toHaveLength(1);
});

test("deleting the progress message the agent edits after its tenth doesn't break following it: progress goes on in a new one", async () => {
  const { t, teamId, admin, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const channelId = await general(admin, teamId);
  const { runId, taskId } = await slowRun(t, admin, teamId, channelId, agentMemberId);
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.body === "Working on it"));
  const bindingId = await hold(t, runId);
  const progress = (message: string) =>
    t.mutation(internal.a2aWorker.observed, { bindingId, lease: IN_FLIGHT, observation: { kind: "task", taskId, state: "TASK_STATE_WORKING", message } });
  // "Working on it" was the first of ten progress messages; from the eleventh on, the tenth is edited.
  for (let n = 2; n <= 10; n++) await progress(`Step ${n}`);
  const tenth = listed(await admin.as.query(api.messages.list, { teamId, channelId })).find((m) => m.body === "Step 10")!;
  await admin.as.mutation(api.messages.delete, { teamId, messageId: tenth.messageId });
  expect(await progress("Step 11")).toBe("changed");
  expect(await progress("Step 12")).toBe("changed");
  const said = listed(await admin.as.query(api.messages.list, { teamId, channelId })).filter(isAgent(agentMemberId)).map((m) => m.body);
  expect(said).toEqual(["Working on it", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Step ${n}`), "Step 12"]);
  await letGo(t, bindingId);
  await admin.as.mutation(api.runs.stop, { teamId, runId });
  await settled(t, admin, teamId, runId, "stopped");
});

// ---------- agents' answers reach other agents and runs (ADR 0026) ----------

test("an agent's answer that names a run lands in the run's inbox, and one that names another agent sends it to that agent", async () => {
  const { t, teamId, admin, agentId, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  // Icarus may hand other agents work: one of its keys has runs.start (ADR 0012).
  await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "room", scopes: ["room.read", "messages.post", "runs.start"] });
  const muse = await spawn({ chat: true, name: "Muse" });
  const museId = await admin.as.mutation(api.agents.add, { teamId, name: "Muse", connection: "a2a" });
  await admin.as.mutation(api.a2a.connect, { teamId, agentId: museId, cardUrl: muse.url });
  await until(t, () => admin.as.query(api.a2a.get, { teamId, agentId: museId }), (p) => p?.status === "ready");
  const museMemberId = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Muse")!.memberId;
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const channelId = await general(admin, teamId);

  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> mention: run:${runId}` });
  let rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const toRun = rows.find((m) => m.author.memberId === agentMemberId)!;
  expect(toRun).toMatchObject({ body: `<@run:${runId}> over to you.`, addressedRuns: [{ runId, label: "Claude Code (Julio)" }] });
  const inbox = await admin.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox.messages).toEqual([
    expect.objectContaining({
      messageId: toRun.messageId,
      text: "@Claude Code (Julio) over to you.",
      from: { member: expect.objectContaining({ name: "Icarus" }) },
      // Julio added Icarus, so Julio answers for it, and he is this run's driver.
      accountable: expect.objectContaining({ name: "Julio" }),
      fromDriver: true,
    }),
  ]);

  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> mention: ${museMemberId}` });
  rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === museMemberId));
  const toMuse = rows.find((m) => m.body === `<@${museMemberId}> over to you.`)!;
  expect(toMuse.a2aRuns).toHaveLength(1);
  const museAnswer = rows.find((m) => m.author.memberId === museMemberId)!;
  expect(museAnswer.body).toMatch(/^Muse here\. You said: “over to you\.”/);
  const museSends = (await callsOf(muse)).filter((c) => c.method === "SendMessage" || c.method === "SendStreamingMessage");
  expect(museSends).toHaveLength(1);
});

test("a thread proposal that names a run reaches the run's inbox, as anything else the agent says does", async () => {
  const { t, teamId, admin, agentId, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "room", scopes: ["room.read", "messages.post"] });
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const channelId = await general(admin, teamId);

  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> propose-mention: run:${runId}` });
  const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.a2a?.proposal));
  const proposal = rows.find((m) => m.a2a?.proposal)!;
  expect(proposal).toMatchObject({ addressedRuns: [{ runId, label: "Claude Code (Julio)" }] });
  const inbox = await admin.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox.messages!.map((m) => m.messageId)).toEqual([proposal.messageId]);
});

/** Icarus, connected with no key, a live run of Julio's, #general, and Icarus's answers there. */
async function icarusAndRun() {
  const c = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const { t, teamId, admin, agentMemberId } = c;
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const channelId = await general(admin, teamId);
  const answer = async () => {
    await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> mention: run:${runId}` });
    const rows = await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
    return rows.find((m) => m.author.memberId === agentMemberId)!;
  };
  const inbox = async () => (await admin.as.query(api.runs.inbox, { teamId, runId })).messages!;
  return { ...c, runId, answer, inbox };
}

test("an agent's answer that names a run reaches it only if one of the agent's keys may post messages (D3)", async () => {
  const { runId, answer, inbox } = await icarusAndRun();
  // Icarus has no key at all: its answer is posted, and names the run as text only.
  expect(await answer()).toMatchObject({ body: `<@run:${runId}> over to you.`, addressedRuns: [] });
  expect(await inbox()).toEqual([]);
});

test("an agent's valid key is found however many keys it has revoked", async () => {
  const { t, teamId, admin, agentId, runId, answer, inbox } = await icarusAndRun();
  await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "room", scopes: ["room.read", "messages.post"] });
  // Revoked keys made after it come first in a read of all its keys by agent: past 50 the valid one was missed.
  await t.run(async (ctx) => {
    const agent = (await ctx.db.get(agentId))!;
    const [valid] = await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", agentId)).collect();
    await ctx.db.delete(valid!._id);
    for (let i = 0; i < 60; i++) {
      await ctx.db.insert("agentKeys", {
        teamId,
        agentId,
        name: `old ${i}`,
        hash: `revoked-${i}`,
        prefix: "ur_old",
        scopes: ["room.read", "messages.post"],
        createdBy: agent.addedBy,
        createdAt: Date.now(),
        revokedAt: Date.now(),
      });
    }
    const { _id: _ignored, _creationTime: _time, ...rest } = valid!;
    await ctx.db.insert("agentKeys", rest);
  });
  const message = await answer();
  expect(message.addressedRuns).toEqual([{ runId, label: "Claude Code (Julio)" }]);
  expect((await inbox()).map((m) => m.messageId)).toEqual([message.messageId]);
});

test("in a direct message a run gets an agent's progress too, and an answer that repeats it isn't lost to it", async () => {
  const { t, teamId, admin, agentId, agentMemberId } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "room", scopes: ["room.read", "messages.post"] });
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const channelId = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId], runIds: [runId] })).channelId;

  const asked = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "progress: Totals match the ledger.", acknowledgeWarning: true });
  const a2aRunId = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).a2aRuns[0]!;
  await settled(t, admin, teamId, a2aRunId, "done");
  const fromIcarus = listed(await admin.as.query(api.messages.list, { teamId, channelId })).filter((m) => m.author.memberId === agentMemberId && !m.system);
  // Shown once: the answer said nothing new.
  expect(fromIcarus.map((m) => m.body)).toEqual(["Totals match the ledger."]);
  // The run got Julio's message and Icarus's, each once.
  const inbox = (await admin.as.query(api.runs.inbox, { teamId, runId })).messages!;
  expect(inbox.map((m) => m.messageId).sort()).toEqual([asked, fromIcarus[0]!.messageId].sort());
});

test("an agent's message past Hermes's turn limit stays refused: the room retries a fresh context only for a person (D18)", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus", maxTurns: 1 });
  const { key } = await addAgent(t, teamId, admin, "Builder", ["room.read", "messages.post", "runs.start"]);
  const channelId = await general(admin, teamId);
  expect(await callAsAgent(t, key, "messages.post", { channelId, body: `<@${agentMemberId}> one` })).toMatchObject({ ok: true });
  await channelOnce(t, admin, teamId, channelId, (r) => r.some((m) => m.author.memberId === agentMemberId));
  const second = await callAsAgent(t, key, "messages.post", { channelId, body: `<@${agentMemberId}> two` });
  const runId = present(await admin.as.query(api.messages.get, { teamId, messageId: second.result })).a2aRuns[0]!;

  expect(await settled(t, admin, teamId, runId, "failed")).toMatchObject({ failReason: expect.stringMatching(/^Rejected: Anti-loop protection/) });
  // Sent once in the old context, and not again in a fresh one.
  expect(await sends(fake)).toHaveLength(2);
});

test("a reply from an A2A run's panel in a direct message reaches the live run there too, and its agent once", async () => {
  const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const { runId: liveRun } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  const channelId = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [agentMemberId], runIds: [liveRun] })).channelId;

  const asked = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "hey there", acknowledgeWarning: true });
  const a2aRun = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).a2aRuns[0]!;
  await settled(t, admin, teamId, a2aRun, "done");

  // The run panel's reply box: posted in the direct message as Julio's message, as messages.post would.
  const { runId: next } = await admin.as.mutation(api.runs.reply, { teamId, runId: a2aRun, text: "one more thing" });
  const reply = listed(await admin.as.query(api.messages.list, { teamId, channelId })).find((m) => m.body === "one more thing")!;
  expect(reply.a2aRuns).toEqual([next]);
  const inbox = (await admin.as.query(api.runs.inbox, { teamId, runId: liveRun })).messages!;
  expect(inbox.map((m) => m.messageId)).toContain(reply.messageId);
  await settled(t, admin, teamId, next, "done");
  // Icarus got the first message and the reply, each once.
  expect(await sends(fake)).toHaveLength(2);
});

// A run Icarus drives posts under Icarus (ADR 0029 D2), but Icarus didn't write it: the run can
// reach Icarus, and its message isn't one of Icarus's own.

/** Icarus with a key that may post and send work, driving a live Claude Code run on Julio's machine. */
async function runIcarusDrives() {
  const c = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
  const { t, teamId, admin, agentId, agentMemberId } = c;
  await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "room", scopes: ["room.read", "messages.post", "runs.start"] });
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp", { team: true });
  const { runId } = await admin.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId, access: "drive" });
  const terminalId = (await t.run(async (ctx) => ctx.db.get(runId as Id<"runs">)))!.terminalId!;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude", access: "drive" });
  await t.run(async (ctx) => {
    await ctx.db.patch(runId as Id<"runs">, { driverId: agentMemberId });
    await ctx.db.patch(terminalId, { driverId: agentMemberId });
  });
  const channelId = await general(admin, teamId);
  const say = async (text: string, replyTo?: string) =>
    (await t.mutation(api.bridge.runSay, { token, terminalRef: terminalId, text, ...(replyTo ? { replyTo } : { in: "#general" }) })).messageId as Id<"messages">;
  return { ...c, channelId, say };
}

test("a run that mentions the agent driving it reaches the agent, sent as from the run", async () => {
  const { t, teamId, admin, agentMemberId, fake, say } = await runIcarusDrives();
  const asked = await say(`<@${agentMemberId}> is the model free?`);
  const [a2aRunId] = present(await admin.as.query(api.messages.get, { teamId, messageId: asked })).a2aRuns;
  expect(a2aRunId).toBeDefined();
  await settled(t, admin, teamId, a2aRunId!, "done");
  expect((await sends(fake))[0]!.params.message.parts[0].text).toContain("Sent from Uplink Room by Claude Code (Icarus) in #general.");
});

test("a reply under a run's message goes to the run, not to the agent driving it", async () => {
  const { teamId, admin, fake, channelId, say } = await runIcarusDrives();
  const said = await say("Build is green.");
  const reply = await admin.as.mutation(api.messages.post, { teamId, channelId, replyTo: said, body: "Thanks, ship it." });
  expect(present(await admin.as.query(api.messages.get, { teamId, messageId: reply })).a2aRuns).toEqual([]);
  expect(await sends(fake)).toEqual([]);
});

test("what a run said goes to the agent driving it as the run's, even once the agent keeps its context", async () => {
  const { t, teamId, admin, agentMemberId, fake, channelId, say } = await runIcarusDrives();
  for (const [i, body] of ["hey there", "and X?"].entries()) {
    await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> ${body}` });
    await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId && !m.asRun).length === i + 1);
  }
  await say("Build is green.");
  await admin.as.mutation(api.messages.post, { teamId, channelId, body: `<@${agentMemberId}> anything new?` });
  await channelOnce(t, admin, teamId, channelId, (r) => r.filter((m) => m.author.memberId === agentMemberId && !m.asRun).length === 3);
  // Icarus remembers its own answers, but the run's message isn't one of them, nor is it Icarus's.
  expect((await sends(fake))[2]!.params.message.metadata.uplinkRoom.history).toEqual([
    expect.objectContaining({ author: "Claude Code (Icarus)", text: "Build is green." }),
  ]);
});
