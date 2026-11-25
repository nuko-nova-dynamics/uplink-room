/**
 * Delivering messages to live runs through their machine's bridge (ADR 0026, slice 4 of #139): the
 * room tells the bridge that messages wait for a run, and hands them over only when the run's hook
 * claims them, labelled and checked for the run's driver at that moment. A bridge from before this
 * gets nothing, and the message waits in the run's inbox.
 */
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, LIMITS, linkMachine, newLimitedRoom, newRoom, newTeam } from "./setup";

afterEach(() => {
  vi.useRealTimers();
});

/** Julio runs Claude Code (or `harness`) in a terminal on his machine, set to Drive; Ana is a teammate; #general. */
async function room(features: string[] = ["run_messages"], harness = "claude-code") {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp", { team: true });
  if (features.length) {
    await bridgeSays(t, token, { type: "bridge_features", features });
    await deliverySteps(t);
  }
  const { runId } = await julio.as.mutation(api.runs.start, { teamId, harness, machineId, access: "drive" });
  const run = await t.run(async (ctx) => ctx.db.get(runId as Id<"runs">));
  return { t, teamId, julio, ana, general: general!.channelId, machineId, token, runId: runId as Id<"runs">, terminalId: run!.terminalId! };
}

/** Runs the room's scheduled delivery steps (lib/runDelivery.ts) until none is left; a machine's own checks stay. */
async function deliverySteps(t: ReturnType<typeof newRoom>) {
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.startsWith("runDelivery:") && f.name !== "runDelivery:expireClaim" && (f.state.kind === "pending" || f.state.kind === "inProgress"),
      ),
    );
    if (!pending.length) return;
  }
  throw new Error("delivery steps still pending");
}

const notices = async (t: ReturnType<typeof newRoom>, token: string) => (await bridgeInbox(t, token)).filter((m) => m.type === "run_messages_waiting");

/** What a session's hook gets when the bridge claims the run's messages. */
const claim = (t: ReturnType<typeof newRoom>, token: string, terminalRef: string, how: "mid_task" | "next_turn" = "mid_task", reserve = 0) =>
  t.mutation(api.bridge.claimRunMessages, { token, terminalRef, how, reserve });

test("the bridge hears that messages wait, and the hook's claim hands them over labelled with who sent them and who answers for them", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  const messageId = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> release the model, I'm taking over` });
  // The notice carries no text: the room labels and checks a message only when it hands it over.
  expect(await notices(t, token)).toEqual([{ v: 1, type: "run_messages_waiting", source: { kind: "terminal", terminalId } }]);

  const handed = await claim(t, token, terminalId);
  expect(handed).toEqual({
    claimId: expect.any(String),
    more: false,
    deliveries: [
      {
        deliveryId: expect.any(String),
        messageId,
        place: "#general",
        text: "@Claude Code (Julio) release the model, I'm taking over",
        from: { memberId: ana.memberId, name: "Ana", kind: "person" },
        accountable: { memberId: ana.memberId, name: "Ana" },
        fromDriver: false,
        at: expect.any(Number),
      },
    ],
  });
  // Claimed, it waits for the hook's answer, and the next claim finds nothing.
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);
});

test("a bridge that doesn't name run_messages hears nothing and claims nothing, and the message waits in the run's inbox", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room([]);
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  expect(await notices(t, token)).toEqual([]);
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);
});

test("the hook's answer marks a claim delivered, and says how; another machine's bridge can neither claim nor answer", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  const other = await linkMachine(t, teamId, julio, "build-box");
  await bridgeSays(t, other.token, { type: "bridge_features", features: ["run_messages"] });
  expect((await claim(t, other.token, terminalId)).deliveries).toEqual([]);

  const { claimId, deliveries } = await claim(t, token, terminalId);
  const deliveryIds = deliveries.map((d) => d.deliveryId);
  await bridgeSays(t, other.token, { type: "run_message_result", claimId, deliveryIds, status: "delivered", how: "next_turn" });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);
  // An answer under another claim id changes nothing either.
  await bridgeSays(t, token, { type: "run_message_result", claimId: "not-this-claim", deliveryIds, status: "delivered", how: "next_turn" });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);

  await bridgeSays(t, token, { type: "run_message_result", claimId, deliveryIds, status: "delivered", how: "mid_task" });
  const inbox = await julio.as.query(api.runs.inbox, { teamId, runId });
  expect(inbox.waiting).toBe(0);
  expect(inbox.messages).toMatchObject([{ status: "delivered", how: "mid_task" }]);
});

test("a private channel's message never reaches a team run whatever its driver, and the label follows the driver at hand-over", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ben.memberId] });
  // Sent while the run is busy and Julio drives: Ben's in #launch, Julio's own in #general.
  await ben.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the launch date is the 9th` });
  await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> wrap up` });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages!.map((m) => m.fromDriver)).toEqual([true, false]);

  // Julio passes the wheel to Ana, who isn't in #launch.
  await julio.as.mutation(api.terminals.passWheel, { teamId, terminalId, to: ana.memberId });
  const { deliveries } = await claim(t, token, terminalId);
  expect(deliveries.map((d) => [d.text, d.fromDriver])).toEqual([["@Claude Code (Ana) wrap up", false]]);
  expect(JSON.stringify(deliveries)).not.toContain("9th");
  const messages = (await ana.as.query(api.runs.inbox, { teamId, runId })).messages!;
  expect(messages.map((m) => [m.status, m.error, m.fromDriver])).toEqual([
    ["waiting", undefined, false],
    ["failed", "visible_outside", false],
  ]);
});

test("a private channel's message doesn't reach a run people outside the channel can watch: it fails at once, and the channel says why (ADR 0039)", async () => {
  const { t, teamId, julio, token, runId, terminalId } = await room();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ben.memberId] });
  // A team run: anyone in the team can watch its terminal, where Claude Code shows what its hooks hand it.
  const messageId = await ben.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the launch date is the 9th` });
  expect(await notices(t, token)).toEqual([]);
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ messageId, status: "failed", error: "visible_outside", place: "#launch" }]);
  const page = (await ben.as.query(api.messages.list, { teamId, channelId: launch, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(page.page.find((m) => m.system?.kind === "run").system.text).toBe("Claude Code (Julio) is visible to people outside #launch, so it can't hear messages from here.");

  // A run started from #launch is #launch's alone, so it hears what is said there.
  await t.run((ctx) => ctx.db.patch(runId, { directChannelId: launch }));
  await ben.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the press kit is ready` });
  expect((await claim(t, token, terminalId)).deliveries.map((d) => d.text)).toEqual(["@Claude Code (Julio) the press kit is ready"]);
});

test("a Codex terminal run follows the same rule: a private channel's message fails at routing and again at hand-over (ADR 0038, ADR 0039)", async () => {
  const { t, teamId, julio, token, runId, terminalId } = await room(["run_messages"], "codex");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ben.memberId] });
  // A team run: everyone in the team can watch the terminal where Codex shows what it was steered.
  const messageId = await ben.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the launch date is the 9th` });
  expect(await notices(t, token)).toEqual([]);
  expect((await claim(t, token, terminalId, "next_turn")).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ messageId, status: "failed", error: "visible_outside", place: "#launch" }]);
  const page = (await ben.as.query(api.messages.list, { teamId, channelId: launch, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(page.page.find((m) => m.system?.kind === "run").system.text).toBe("Codex (Julio) is visible to people outside #launch, so it can't hear messages from here.");

  // Started from #launch, it hears #launch; once its output can reach people outside, a message that waited fails at hand-over.
  await t.run((ctx) => ctx.db.patch(runId, { directChannelId: launch }));
  await ben.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@run:${runId}> the press kit is ready` });
  await t.run((ctx) => ctx.db.patch(runId, { directChannelId: undefined }));
  expect((await claim(t, token, terminalId, "next_turn")).deliveries).toEqual([]);
  const rows = await t.run(async (ctx) => ctx.db.query("runInbox").withIndex("by_run", (q) => q.eq("runId", runId)).collect());
  expect(rows.map((r) => [r.status, r.error])).toEqual([
    ["failed", "visible_outside"],
    ["failed", "visible_outside"],
  ]);
});

test("a direct message opened with a team run reaches it, and says first that the run's output is visible to the whole team (ADR 0039, 2026-11-05)", async () => {
  const { t, teamId, ana, token, runId, terminalId } = await room();
  const warning = "Claude Code (Julio)'s output is visible to the whole team, so what you send here won't stay private.";
  // Ana chose to message Julio's run, and the direct message tells her before she sends anything.
  const opened = await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] });
  expect(opened.warnings).toEqual([{ runId, label: "Claude Code (Julio)", warning, seenBy: "team" }]);
  const channelId = opened.channelId;
  const first = (await ana.as.query(api.messages.list, { teamId, channelId, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(first.page.map((m) => [m.system?.text, m.system?.tone])).toEqual([[warning, "info"]]);
  expect((await ana.as.query(api.channels.list, { teamId })).find((c) => c.channelId === channelId)).toMatchObject({ runs: [{ runId, label: "Claude Code (Julio)", warning, seenBy: "team" }] });
  expect((await ana.as.query(api.runs.live, { teamId })).find((r) => r.runId === runId)).toMatchObject({ visibleToTeam: true });

  // The app shows the warning by the message box, and says so when it sends.
  await ana.as.mutation(api.messages.post, { teamId, channelId, body: "the staging deploy is yours", acknowledgeWarning: true });
  expect((await claim(t, token, terminalId)).deliveries.map((d) => [d.text, d.place])).toEqual([["the staging deploy is yours", "a direct message"]]);

  // Opening it again adds no second line.
  expect((await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId).toBe(channelId);
  const again = (await ana.as.query(api.messages.list, { teamId, channelId, paginationOpts: { numItems: 10, cursor: null } })) as { page: any[] };
  expect(again.page.filter((m) => m.system?.text === warning)).toHaveLength(1);
});

test("an agent that only posts gets the warning from channels.openDirect, and its first post there is refused until it acknowledges it (ADR 0039, 2026-11-05)", async () => {
  const { t, teamId, julio, ana, token, runId, terminalId } = await room();
  const warning = "Claude Code (Julio)'s output is visible to the whole team, so what you send here won't stay private.";
  // A key with only messages.post can't call channels.list or messages.list, so the warning comes with what it calls.
  const { key } = await addAgent(t, teamId, ana, "Scout", ["messages.post"]);
  const opened = await callAsAgent(t, key, "channels.openDirect", { memberIds: [], runIds: [runId] });
  expect(opened).toMatchObject({ ok: true, result: { warnings: [{ runId, label: "Claude Code (Julio)", warning, seenBy: "team" }] } });
  const channelId = opened.result.channelId;
  // Its audit row still names the direct message it opened.
  const audited = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audited.find((a) => a.action === "api.channels.openDirect")).toMatchObject({ target: channelId, channelId });

  const refused = await callAsAgent(t, key, "messages.post", { channelId, body: "the staging password is hunter2" });
  expect(refused).toMatchObject({ ok: false, error: { code: "warning_required" } });
  expect(refused.error!.message).toContain(warning);
  expect(refused.error!.message).toContain("acknowledgeWarning: true");
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);

  expect(await callAsAgent(t, key, "messages.post", { channelId, body: "the release notes are ready", acknowledgeWarning: true })).toMatchObject({ ok: true });
  // Acknowledged once, by this sender: later posts go without it.
  expect(await callAsAgent(t, key, "messages.post", { channelId, body: "and the changelog" })).toMatchObject({ ok: true });
  expect((await claim(t, token, terminalId)).deliveries.map((d) => d.text)).toEqual(["the release notes are ready", "and the changelog"]);
  // Julio, in it as the run's person, hasn't acknowledged it here, so his own first post is refused the same way.
  await expect(julio.as.mutation(api.messages.post, { teamId, channelId, body: "hi" })).rejects.toThrow(/acknowledgeWarning: true/);
});

test("a direct message opened with a team run before the warning existed gets the warning line once, when opened again or posted in (ADR 0039, 2026-11-05)", async () => {
  const { t, teamId, julio, ana, runId } = await room();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const warning = "Claude Code (Julio)'s output is visible to the whole team, so what you send here won't stay private.";
  const refusal = "Claude Code (Julio) is visible to people outside this direct message, so it can't hear messages from here.";
  /** A direct message as one opened before the warning was: no warning line, only the old refusal. */
  const legacy = async (memberIds: Id<"members">[]) => {
    const { channelId } = await ana.as.mutation(api.channels.openDirect, { teamId, memberIds, runIds: [runId] });
    await t.run(async (ctx) => {
      for (const m of await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect()) await ctx.db.delete(m._id);
      for (const r of await ctx.db.query("channelRuns").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect()) {
        await ctx.db.replace(r._id, { teamId: r.teamId, channelId: r.channelId, runId: r.runId, addedBy: r.addedBy, addedAt: r.addedAt });
      }
      await ctx.db.insert("messages", {
        teamId,
        channelId,
        authorId: ana.memberId as Id<"members">,
        format: "markdown",
        body: "",
        mentionedTasks: [],
        mentionedRuns: [],
        system: { kind: "run", runId, text: refusal, tone: "warn" },
      });
    });
    return channelId;
  };
  const lines = async (channelId: Id<"channels">) =>
    ((await ana.as.query(api.messages.list, { teamId, channelId })) as any[]).map((m) => m.system?.text ?? m.body);

  // Opened again: the warning is added once, after the old refusal.
  const reopened = await legacy([]);
  await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] });
  await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] });
  expect(await lines(reopened)).toEqual([refusal, warning]);

  // Posted in first: the warning goes in before the message, and only once.
  const posted = await legacy([ben.memberId]);
  await ana.as.mutation(api.messages.post, { teamId, channelId: posted, body: "the deploy is yours", acknowledgeWarning: true });
  await ana.as.mutation(api.messages.post, { teamId, channelId: posted, body: "thanks" });
  expect(await lines(posted)).toEqual([refusal, warning, "the deploy is yours", "thanks"]);
});

test("a direct message the run wasn't opened with still follows the strict rule: addressing a team run there fails (ADR 0039)", async () => {
  const { t, teamId, julio, ana, token, runId, terminalId } = await room();
  const channelId = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  const messageId = await ana.as.mutation(api.messages.post, { teamId, channelId, body: `<@run:${runId}> the staging password is in 1Password` });
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ messageId, status: "failed", error: "visible_outside" }]);
  // The same in a direct message opened with another run: only the run it was opened with hears it.
  const { runId: other } = await ana.as.mutation(api.runs.start, { teamId, harness: "codex", machineId: (await linkMachine(t, teamId, ana, "ana-mbp")).machineId });
  const withOther = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [other] })).channelId;
  const aside = await julio.as.mutation(api.messages.post, { teamId, channelId: withOther, body: `<@run:${runId}> note to self`, acknowledgeWarning: true });
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages![0]).toMatchObject({ messageId: aside, status: "failed", error: "visible_outside" });
});

test("a run whose driver left the team gets nothing more, though its terminal is still open", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  await julio.as.mutation(api.terminals.passWheel, { teamId, terminalId, to: ana.memberId });
  await ben.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> the staging password moved` });
  // Ana leaves the team; members.remove doesn't end her terminal.
  await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
  const { deliveries } = await claim(t, token, terminalId);
  expect(deliveries).toEqual([]);
  // Only the run's driver and its person read the inbox's texts (D6), so read its row directly.
  const rows = await t.run(async (ctx) => ctx.db.query("runInbox").withIndex("by_run", (q) => q.eq("runId", runId)).collect());
  expect(rows.map((r) => [r.status, r.error])).toEqual([["failed", "driver_changed"]]);
});

test("a message its driver narrowed the run away from since it was sent isn't handed over", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  await julio.as.mutation(api.runs.setHears, { teamId, runId, hears: "driver" });
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "failed", error: "not_heard" }]);
});

test("a claim the bridge isn't sure reached the session goes once more, and then fails as unsure; one that didn't reach a hook waits again", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  const inbox = async () => (await julio.as.query(api.runs.inbox, { teamId, runId })).messages![0];
  const answer = async (status: "released" | "unsure") => {
    const { claimId, deliveries } = await claim(t, token, terminalId);
    expect(deliveries).toHaveLength(1);
    await bridgeSays(t, token, { type: "run_message_result", claimId, deliveryIds: deliveries.map((d) => d.deliveryId), status });
  };

  const heard = async () => (await notices(t, token)).length;
  let before = await heard();
  await answer("released");
  expect(await inbox()).toMatchObject({ status: "waiting" });
  // It waits again, and the bridge hears so.
  expect(await heard()).toBe(before + 1);
  before = await heard();
  await answer("unsure");
  expect(await inbox()).toMatchObject({ status: "waiting" });
  expect(await heard()).toBe(before + 1);
  await answer("unsure");
  expect(await inbox()).toMatchObject({ status: "failed", error: "unsure" });
  expect((await claim(t, token, terminalId)).deliveries).toEqual([]);
});

test("a claim nobody answers counts as unsure once it expires", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  vi.useFakeTimers();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> status?` });
  expect((await claim(t, token, terminalId)).deliveries).toHaveLength(1);
  vi.advanceTimersByTime(3 * 60 * 1000);
  await t.finishInProgressScheduledFunctions();
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "waiting" }]);
  expect((await claim(t, token, terminalId)).deliveries).toHaveLength(1);
  vi.advanceTimersByTime(3 * 60 * 1000);
  await t.finishInProgressScheduledFunctions();
  expect((await julio.as.query(api.runs.inbox, { teamId, runId })).messages).toMatchObject([{ status: "failed", error: "unsure" }]);
});

test("a claim hands over as many messages as fit in one delivery, oldest first, and says more wait", async () => {
  const { t, teamId, ana, general, token, runId, terminalId } = await room();
  for (const n of [1, 2, 3]) await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> ${String(n).repeat(4000)}` });
  const first = await claim(t, token, terminalId);
  expect(first.deliveries.map((d) => d.text.at(-1))).toEqual(["1", "2"]);
  expect(first.more).toBe(true);
  // The bridge keeps room for its own lines: then only one fits.
  const second = await claim(t, token, terminalId, "mid_task", 4000);
  expect(second.deliveries.map((d) => d.text.at(-1))).toEqual(["3"]);
  expect(second.more).toBe(false);
});

test("the inbox's bound of 50 counts claimed messages as well as waiting ones, since a claim nobody answers comes back", async () => {
  const { t, teamId, ana, general, token, runId, terminalId } = await room();
  for (let i = 0; i < 30; i++) await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> ping ${i}` });
  expect((await claim(t, token, terminalId)).deliveries).toHaveLength(30);
  for (let i = 30; i < 51; i++) await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> ping ${i}` });
  const open = await t.run(async (ctx) =>
    (await ctx.db.query("runInbox").collect()).filter((row) => row.runId === runId).map((row) => row.status),
  );
  expect(open.filter((s) => s === "claimed")).toHaveLength(30);
  expect(open.filter((s) => s === "waiting")).toHaveLength(20);
  const page = (await ana.as.query(api.messages.list, { teamId, channelId: general, paginationOpts: { numItems: 5, cursor: null } })) as { page: any[] };
  expect(page.page.find((m) => m.system?.kind === "run").system.text).toBe("Claude Code (Julio) isn't taking messages: 50 are already waiting for it.");
});

test("a claim says more wait when messages wait past the 50 it reads, though all it read fit", async () => {
  const { t, teamId, ana, general, token, runId, terminalId } = await room();
  for (let i = 0; i < 50; i++) await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> ping ${i}` });
  const first = await claim(t, token, terminalId);
  expect(first.deliveries).toHaveLength(50);
  // 50 newer ones wait as the first claim's 50 come back (an inbox filled before the bound counted claims).
  await t.run(async (ctx) => {
    const row = (await ctx.db.get(first.deliveries[0]!.deliveryId as Id<"runInbox">))!;
    const { _id, _creationTime, claim: _claim, ...rest } = row;
    for (let i = 0; i < 50; i++) await ctx.db.insert("runInbox", { ...rest, status: "waiting", at: row.at + 1 + i });
  });
  await bridgeSays(t, token, { type: "run_message_result", claimId: first.claimId, deliveryIds: first.deliveries.map((d) => d.deliveryId), status: "released" });
  const second = await claim(t, token, terminalId);
  expect(second.deliveries).toHaveLength(50);
  expect(second.more).toBe(true);
  const third = await claim(t, token, terminalId);
  expect(third.deliveries).toHaveLength(50);
  expect(third.more).toBe(false);
});

test("when a new bridge process registers, the old terminal's waiting and claimed messages fail, saying its terminal ended", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  vi.useFakeTimers();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> one` });
  expect((await claim(t, token, terminalId)).deliveries).toHaveLength(1);
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> two` });
  // The bridge had started the terminal and handled everything the room sent it.
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude", access: "drive" });
  await t.mutation(api.bridge.ack, { token, upToSeq: Number.MAX_SAFE_INTEGER });
  // It crashed with one message in hand and one waiting; its new process ends the last one's terminals.
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: LIMITS });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const messages = (await julio.as.query(api.runs.inbox, { teamId, runId })).messages!;
  expect(messages.map((m) => [m.status, m.error])).toEqual([
    ["failed", "run_ended"],
    ["failed", "run_ended"],
  ]);
});

test("a run whose turn ended in an API error is still live while its terminal is open, and still gets its messages", async () => {
  const { t, teamId, julio, ana, general, token, runId, terminalId } = await room();
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: terminalId, title: "claude", tool: "claude", access: "drive" });
  // Claude Code's StopFailure hook: the turn failed, the session waits for its next prompt.
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "failed" });
  expect((await julio.as.query(api.runs.live, { teamId })).map((r) => r.runId)).toEqual([runId]);
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> try again?` });
  expect((await claim(t, token, terminalId, "next_turn")).deliveries.map((d) => d.text)).toEqual(["@Claude Code (Julio) try again?"]);
});

test("runs.live says how a run hears messages, and says to update a bridge that can't deliver them", async () => {
  const { t, teamId, julio, token, runId, terminalId } = await room();
  const live = async () => (await julio.as.query(api.runs.live, { teamId })).find((r) => r.runId === runId)!;
  expect(await live()).toMatchObject({ hearing: "unknown" });
  expect((await live()).hearingNote).toBeUndefined();
  await bridgeSays(t, token, { type: "run_hearing", source: { kind: "terminal", terminalId }, hearing: "mid_task" });
  expect(await live()).toMatchObject({ hearing: "mid_task" });

  const old = await room([]);
  const oldLive = (await old.julio.as.query(api.runs.live, { teamId: old.teamId })).find((r) => r.runId === old.runId)!;
  expect(oldLive).toMatchObject({ hearing: "unknown", hearingNote: "Update Uplink Room on julio-mbp so this run hears messages." });
});

test("a bridge that says it takes run messages hears about those that waited for it", async () => {
  const { t, teamId, ana, general, token, runId, terminalId } = await room([]);
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> one` });
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@run:${runId}> two` });
  await bridgeSays(t, token, { type: "bridge_features", features: ["thread_driver", "run_messages"] });
  await deliverySteps(t);
  expect(await notices(t, token)).toEqual([{ v: 1, type: "run_messages_waiting", source: { kind: "terminal", terminalId } }]);
  expect((await claim(t, token, terminalId)).deliveries.map((d) => d.text)).toEqual(["@Claude Code (Julio) one", "@Claude Code (Julio) two"]);
});

test("a bridge that names run_messages on a machine with many live terminals hears about each one's messages, within a transaction's limits", async () => {
  const t = newLimitedRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp", { team: true });
  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId: general!.channelId, body: "hello" });
  const julioId = (await julio.as.query(api.teams.mine, {}))[0]!.memberId as Id<"members">;
  // 1,100 live terminals, each with a run that has a message waiting: more than one transaction can read.
  for (let chunk = 0; chunk < 11; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        const terminalId = await ctx.db.insert("terminals", { teamId, machineId, startedBy: julioId, driverId: julioId, access: "drive", usesSlot: false, title: "claude", tool: "claude", status: "live", outputSeq: 0 });
        const runId = await ctx.db.insert("runs", { teamId, harness: "claude-code", machineId, terminalId, driverId: julioId, startedBy: julioId, state: "working", stateChangedAt: 0 });
        await ctx.db.patch(terminalId, { runId });
        await ctx.db.insert("runInbox", { teamId, runId, messageId, channelId: general!.channelId, from: { memberId: julioId }, accountableId: julioId, fromDriver: true, status: "waiting", at: 0 });
      }
    });
  }
  await bridgeSays(t, token, { type: "bridge_features", features: ["run_messages"] });
  await deliverySteps(t);
  const notices = await t.run(async (ctx) =>
    (await ctx.db.query("bridgeOutbox").collect()).filter((row) => row.machineId === machineId && (row.message as { type: string }).type === "run_messages_waiting"),
  );
  expect(notices).toHaveLength(1100);
}, 60_000);
