/**
 * Messages to a run in a T3 Code thread (ADR 0026, slice 6 of #139): the room tells the thread's
 * bridge that messages wait, hands them over when the bridge claims them by the thread, and takes
 * what the run posts back through the bridge. Only a bridge that names `thread_run_messages` hears
 * about a thread's messages; an older one leaves them waiting in the run's inbox.
 */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeInbox, bridgeSays, LIMITS, linkMachine, newRoom, newTeam } from "./setup";

const THREAD_FEATURES = ["thread_driver", "thread_closed", "run_messages", "thread_run_messages"];

/** Julio's machine, whose bridge reports a Codex thread found in T3 Code; Ana is a teammate; #general. */
async function room(features: string[] = THREAD_FEATURES, state: "working" | "done" = "working") {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  await bridgeSays(t, token, { type: "bridge_features", features });
  const threadRef = "thread-codex";
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef }, state, title: "Fix billing", harness: "codex" });
  const runId = await t.run(async (ctx) =>
    (await ctx.db.query("runs").withIndex("by_machine_thread", (q) => q.eq("machineId", machineId).eq("threadRef", threadRef)).unique())!._id,
  );
  return { t, teamId, julio, ana, general: general!.channelId, machineId, token, runId: runId as Id<"runs">, threadRef };
}

const notices = async (t: ReturnType<typeof newRoom>, token: string) => (await bridgeInbox(t, token)).filter((m) => m.type === "run_messages_waiting");

const claim = (t: ReturnType<typeof newRoom>, token: string, threadRef: string, how: "mid_task" | "next_turn" = "next_turn") =>
  t.mutation(api.bridge.claimRunMessages, { token, threadRef, how, reserve: 0 });

test("a message to a thread run reaches a bridge that delivers into threads, which claims it by the thread", async () => {
  const { t, teamId, julio, ana, general, token, runId, threadRef } = await room();
  const messageId = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> the invoice totals are off by a cent` });
  expect(await notices(t, token)).toEqual([{ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef } }]);

  const handed = await claim(t, token, threadRef);
  expect(handed.deliveries).toEqual([
    expect.objectContaining({
      messageId,
      place: "#general",
      text: "@Codex (Julio) the invoice totals are off by a cent",
      from: { memberId: ana.memberId, name: "Ana", kind: "person" },
      fromDriver: false,
    }),
  ]);
  await bridgeSays(t, token, {
    type: "run_message_result",
    claimId: handed.claimId,
    deliveryIds: handed.deliveries.map((d) => d.deliveryId),
    status: "delivered",
    how: "mid_task",
  });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "delivered", how: "mid_task" }]);
});

test("a thread run hears a private place only while everyone who can see its thread is in it, checked again when the bridge claims (ADR 0039)", async () => {
  const { t, teamId, julio, ana, token, runId, threadRef } = await room();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ana.memberId, ben.memberId] });
  const inbox = async () => (await julio.as.query(api.runs.inbox, { teamId, runId })).messages!.map((m) => [m.text, m.status, m.error]);
  // Found in T3 Code, the thread's run is the team's: everyone in the team can open its thread.
  await ben.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the launch date is the 9th` });
  expect(await inbox()).toEqual([["@Codex (Julio) the launch date is the 9th", "failed", "visible_outside"]]);

  // Started from Julio and Ana's direct message, it is theirs alone, and both are in #launch.
  await t.run((ctx) => ctx.db.patch(runId, { directChannelId: dm }));
  await ana.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the press kit is ready` });
  expect((await inbox())[0]).toEqual(["@Codex (Julio) the press kit is ready", "waiting", undefined]);
  // Ana leaves #launch before the bridge claims: the thread would show #launch to someone outside it.
  await ana.as.mutation(api.channels.leave, { teamId, channelId: launch });
  expect((await claim(t, token, threadRef)).deliveries).toEqual([]);
  expect((await inbox())[0]).toEqual(["@Codex (Julio) the press kit is ready", "failed", "visible_outside"]);
});

test("a direct message opened with a team thread run reaches it, though the whole team can open its thread (ADR 0039, 2026-11-05)", async () => {
  const { t, teamId, ana, token, threadRef, runId } = await room();
  const channelId = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId;
  const first = (await ana.as.query(api.messages.list, { teamId, channelId, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(first.page.map((m) => m.system?.text)).toEqual(["Codex (Julio)'s output is visible to the whole team, so what you send here won't stay private."]);
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "the invoice totals are off by a cent", acknowledgeWarning: true });
  expect((await claim(t, token, threadRef)).deliveries.map((d) => [d.text, d.place])).toEqual([["the invoice totals are off by a cent", "a direct message"]]);
});

test("a bridge that delivers only to terminals hears nothing of a thread's messages, and runs.live says to update it", async () => {
  const { t, teamId, julio, ana, general, token, runId, threadRef } = await room(["thread_driver", "thread_closed", "run_messages"]);
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  expect(await notices(t, token)).toEqual([]);
  expect((await claim(t, token, threadRef)).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);
  const live = (await julio.as.query(api.runs.live, { teamId })).find((r) => r.runId === runId)!;
  expect(live).toMatchObject({ hearing: "unknown", hearingNote: "Update Uplink Room on julio-mbp so this run hears messages." });
});

test("a thread run answers a message as itself, and another machine's bridge can't post for it", async () => {
  const { t, teamId, julio, ana, general, token, runId, threadRef } = await room();
  const question = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> which invoice is off?` });
  const said = await t.mutation(api.bridge.runSay, { token, threadRef, replyTo: question, text: "INV-1042, rounding in the tax line." });
  expect(said).toEqual({ messageId: expect.any(String), label: "Codex (Julio)", place: "a thread in #general" });
  const message = await ana.as.query(api.messages.get, { teamId, messageId: said.messageId as Id<"messages"> });
  expect(message).toMatchObject({ replyTo: question, asRun: { runId, label: "Codex (Julio)" }, author: { name: "Julio" } });

  const other = await linkMachine(t, teamId, julio, "build-box");
  await expect(t.mutation(api.bridge.runSay, { token: other.token, threadRef, in: "#general", text: "hi" })).rejects.toThrow(/no live run/);
});

test("a thread run stays live between turns while T3 Code lists the thread, and stops taking messages and posting once it's closed", async () => {
  const { t, teamId, julio, ana, general, token, runId, threadRef } = await room(THREAD_FEATURES, "done");
  expect((await julio.as.query(api.runs.live, { teamId })).map((r) => r.runId)).toEqual([runId]);
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> one more thing` });
  expect((await claim(t, token, threadRef)).deliveries).toHaveLength(1);
  expect(await t.mutation(api.bridge.runSay, { token, threadRef, in: "#general", text: "On it." })).toMatchObject({ label: "Codex (Julio)" });

  await bridgeSays(t, token, { type: "thread_closed", threadRef });
  expect(await julio.as.query(api.runs.live, { teamId })).toEqual([]);
  await expect(t.mutation(api.bridge.runSay, { token, threadRef, in: "#general", text: "late" })).rejects.toThrow(/no live run/);
});

test("messages that waited while the bridge restarted are noticed once it reports the thread again", async () => {
  const { t, teamId, julio, ana, general, token, runId, threadRef } = await room(THREAD_FEATURES, "done");
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> are you there?` });
  // The bridge stopped before it claimed the message, and handled everything the room had sent it.
  await t.mutation(api.bridge.ack, { token, upToSeq: Number.MAX_SAFE_INTEGER });
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: ["t3code"], limits: LIMITS });
  await bridgeSays(t, token, { type: "bridge_features", features: THREAD_FEATURES });
  // Until the new bridge process reports the thread, the run isn't live, so nothing is noticed for it.
  expect(await notices(t, token)).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);

  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef }, state: "done", title: "Fix billing", harness: "codex" });
  expect(await notices(t, token)).toEqual([{ v: 1, type: "run_messages_waiting", source: { kind: "thread", threadRef } }]);
  expect((await claim(t, token, threadRef)).deliveries.map((d) => d.text)).toEqual(["@Codex (Julio) are you there?"]);
});

test("a thread run's bridge says how it hears messages: mid-task for a harness T3 Code steers cleanly, between turns otherwise", async () => {
  const { t, teamId, julio, token, runId, threadRef } = await room();
  const live = async () => (await julio.as.query(api.runs.live, { teamId })).find((r) => r.runId === runId)!;
  expect(await live()).toMatchObject({ hearing: "unknown" });
  expect((await live()).hearingNote).toBeUndefined();
  await bridgeSays(t, token, { type: "run_hearing", source: { kind: "thread", threadRef }, hearing: "between_turns" });
  expect(await live()).toMatchObject({ hearing: "between_turns" });
});
