/**
 * Grok Bot through its routine webhook (ADR 0028, slice 14 of #139). A person sets the webhook's
 * URL and key on an agent; a message that reaches that agent (a mention, a direct message, its own
 * thread) is POSTed there with `Authorization: Bearer <key>`, as docs.x.ai/grok-bot/
 * skills-routines-and-automations documents, and the message shows a delivery record: sent, or
 * failed with the reason (decision D17 of ADR 0029). These tests run the real send against a local
 * fake webhook (tests/a2a/globalSetup.ts).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { inject } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { setResolverForTests } from "../convex/lib/a2a/guardedFetch";
import { setWebhookTimeoutForTests } from "../convex/lib/webhookTiming";
import { addAgent, addTeammate, newRoom, newTeam, type Person, type Room } from "./setup";
import { sleep } from "./a2a/helpers";

const KEY = "grk_live_9f8e7d6c5b4a39281706";

type Hook = { id: string; url: string };
type HookCall = { headers: Record<string, string | undefined>; body: string };

async function fakeHook(options: { status?: number; body?: string; delayMs?: number; location?: string } = {}): Promise<Hook> {
  const response = await fetch(`${inject("fakeAgents")}/webhooks`, { method: "POST", body: JSON.stringify(options) });
  return (await response.json()) as Hook;
}

async function callsOf(hook: Hook): Promise<HookCall[]> {
  return (await (await fetch(`${inject("fakeAgents")}/webhooks/${hook.id}/calls`)).json()) as HookCall[];
}

/** Runs scheduled work (the send) until `read` gives a value `ok` accepts. */
async function until<T>(t: Room, read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
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

afterEach(() => {
  vi.unstubAllEnvs();
  setResolverForTests(undefined);
  setWebhookTimeoutForTests(undefined);
  vi.useRealTimers();
});

/** A team where Julio added Grok Bot and set its routine webhook, and Ana, a teammate. */
async function grokTeam(hookOptions: Parameters<typeof fakeHook>[0] = {}) {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const agentId = await admin.as.mutation(api.agents.add, { teamId, name: "Grok Bot", connection: "mcp" });
  const members = await admin.as.query(api.teams.members, { teamId });
  const grokMemberId = members.find((m) => m.name === "Grok Bot")!.memberId;
  const julioMemberId = members.find((m) => m.name === "Julio")!.memberId;
  const hook = await fakeHook(hookOptions);
  await admin.as.mutation(api.webhooks.set, { teamId, agentId, url: hook.url, key: KEY });
  const channels = await admin.as.query(api.channels.list, { teamId });
  const general = channels.find((c) => c.name === "general")!.channelId;
  return { t, teamId, admin, ana, agentId, grokMemberId, julioMemberId, hook, general };
}

async function deliveriesOf(person: Person, teamId: Id<"teams">, messageId: Id<"messages">) {
  const view = await person.as.query(api.messages.get, { teamId, messageId });
  return view!.deliveries;
}

/** Waits until every delivery on the message has settled (none still sending). */
function settled(t: Room, person: Person, teamId: Id<"teams">, messageId: Id<"messages">, count = 1) {
  return until(
    t,
    () => deliveriesOf(person, teamId, messageId),
    (d) => d.length === count && d.every((x) => x.status !== "sending"),
  );
}

describe("a message to Grok Bot goes to its routine webhook", () => {
  test("a mention is POSTed with the key as a bearer token, and the message shows it sent", async () => {
    const { t, teamId, ana, grokMemberId, hook, general } = await grokTeam();
    const messageId = await ana.as.mutation(api.messages.post, {
      teamId,
      channelId: general,
      body: `<@${grokMemberId}> what changed in payments this week?`,
    });

    const deliveries = await settled(t, ana, teamId, messageId);
    expect(deliveries).toEqual([
      expect.objectContaining({ to: expect.objectContaining({ memberId: grokMemberId, name: "Grok Bot" }), via: "webhook", status: "sent" }),
    ]);

    const [call] = await callsOf(hook);
    expect(call!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(call!.headers["content-type"]).toBe("application/json");
    expect(call!.headers["content-length"]).toBe(String(new TextEncoder().encode(call!.body).byteLength));
    const body = JSON.parse(call!.body);
    expect(body.message).toEqual(expect.objectContaining({ messageId, text: "@Grok Bot what changed in payments this week?" }));
    expect(body.from).toEqual(expect.objectContaining({ name: "Ana", kind: "person" }));
    expect(body.accountable).toEqual(expect.objectContaining({ name: "Ana", isYourPerson: false }));
    expect(body.place).toEqual(expect.objectContaining({ label: "#general", channelId: general }));
    expect(body.reply).toEqual({ tool: "messages_post", arguments: { channelId: general } });
    expect(body.instruction).toContain("messages_post");
  });
});

describe("which messages reach it (ADR 0026's hearing rules)", () => {
  test("a channel message that doesn't name it isn't sent; a direct message and a reply in its own thread are", async () => {
    const { t, teamId, ana, grokMemberId, hook, general } = await grokTeam();
    const quiet = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "lunch?" });
    await t.finishAllScheduledFunctions(() => {});
    expect(await deliveriesOf(ana, teamId, quiet)).toEqual([]);

    const direct = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [grokMemberId] })).channelId;
    const dm = await ana.as.mutation(api.messages.post, { teamId, channelId: direct, body: "summarize my week" });
    await settled(t, ana, teamId, dm);

    // Grok Bot answers at the top level of #general through its connector; a reply under it is its own thread.
    const answer = await t.run(async (ctx) =>
      ctx.db.insert("messages", { teamId, channelId: general, authorId: grokMemberId, format: "markdown", body: "Here's the summary.", mentionedTasks: [], mentionedRuns: [] }),
    );
    const reply = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "and last week?", replyTo: answer });
    await settled(t, ana, teamId, reply);

    const calls = await callsOf(hook);
    expect(calls.map((c) => JSON.parse(c.body).message.messageId)).toEqual([dm, reply]);
    const inThread = JSON.parse(calls[1]!.body);
    expect(inThread.place).toEqual(expect.objectContaining({ label: "a thread in #general", threadRootId: answer }));
    expect(inThread.reply.arguments).toEqual({ channelId: general, replyTo: answer });
    expect(JSON.parse(calls[0]!.body).place).toEqual(expect.objectContaining({ label: "a direct message", kind: "direct" }));
  });

  test("an agent's message reaches it only if the agent's key may start runs, and labels the person accountable", async () => {
    const { t, teamId, admin, grokMemberId, hook, general } = await grokTeam();
    const poster = await addAgent(t, teamId, admin, "Lookout");
    const starter = await addAgent(t, teamId, admin, "Scout", ["room.read", "messages.post", "runs.start"]);
    const call = (key: string) =>
      t.fetch("/api/v1/call", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ fn: "messages.post", args: { channelId: general, body: `<@${grokMemberId}> ping` } }),
      });
    const first = (await (await call(poster.key)).json()) as { result: Id<"messages"> };
    await t.finishAllScheduledFunctions(() => {});
    expect(await deliveriesOf(admin, teamId, first.result)).toEqual([]);

    const second = (await (await call(starter.key)).json()) as { result: Id<"messages"> };
    await settled(t, admin, teamId, second.result);
    const [sent] = await callsOf(hook);
    const body = JSON.parse(sent!.body);
    expect(body.from).toEqual(expect.objectContaining({ name: "Scout", kind: "agent" }));
    // Julio added both Scout and Grok Bot.
    expect(body.accountable).toEqual(expect.objectContaining({ name: "Julio", isYourPerson: true }));
    expect(body.instruction).toContain("Julio is the person who added you.");
  });

  test("its own message never goes back to it", async () => {
    const { t, teamId, admin, agentId, grokMemberId, hook, general } = await grokTeam();
    const { secret } = await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "connector", scopes: ["room.read", "messages.post", "runs.start"] });
    await t.fetch("/api/v1/call", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ fn: "messages.post", args: { channelId: general, body: `I am <@${grokMemberId}>` } }),
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(await callsOf(hook)).toEqual([]);
  });
});

describe("what it carries", () => {
  test("recent history, bounded and with credentials taken out, as ADR 0024 sends it", async () => {
    const { t, teamId, ana, admin, grokMemberId, hook, general } = await grokTeam();
    await admin.as.mutation(api.messages.post, { teamId, channelId: general, body: "deploy with Authorization: Bearer abcDEF1234567890xyzTOKEN" });
    await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "x".repeat(1500) });
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> did the deploy work?` });
    await settled(t, ana, teamId, ask);
    const body = JSON.parse((await callsOf(hook))[0]!.body);
    expect(body.history.map((h: { author: string }) => h.author)).toEqual(["Julio", "Ana"]);
    expect(body.history[0].text).toContain("[redacted]");
    expect(body.history[0].text).not.toContain("abcDEF1234567890xyzTOKEN");
    expect(body.history[1].text.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(body.history)).not.toContain("did the deploy work");
  });
});

describe("a send that fails is recorded with its reason", () => {
  test("a refused key: failed, with what the webhook said and the key taken out", async () => {
    const { t, teamId, ana, grokMemberId, general } = await grokTeam({ status: 401, body: `invalid key ${KEY}` });
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> hi` });
    const [delivery] = await settled(t, ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toContain("HTTP 401");
    expect(delivery!.reason).toContain("current key");
    expect(delivery!.reason).not.toContain(KEY);
  });

  test("a redirect isn't followed", async () => {
    const { t, teamId, ana, grokMemberId, general } = await grokTeam({ status: 307, location: "https://elsewhere.example/hook" });
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> hi` });
    const [delivery] = await settled(t, ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toContain("redirect");
  });

  test("no answer before the deadline: failed, and not sent again", async () => {
    setWebhookTimeoutForTests(200);
    const { t, teamId, ana, grokMemberId, hook, general } = await grokTeam({ delayMs: 1500 });
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> hi` });
    const [delivery] = await settled(t, ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toContain("didn't answer");
    await sleep(50);
    expect(await callsOf(hook)).toHaveLength(1);
  });

  test("a webhook replaced before the send fails the old send instead of sending it to the new address", async () => {
    const { t, teamId, ana, admin, agentId, grokMemberId, hook, general } = await grokTeam();
    const other = await fakeHook();
    // The scheduled send waits on a fake clock, so the webhook is replaced before it runs.
    vi.useFakeTimers();
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> hi` });
    await admin.as.mutation(api.webhooks.set, { teamId, agentId, url: other.url, key: "grk_other_key_000000000" });
    vi.useRealTimers();
    const deliveryId = await t.run(async (ctx) => (await ctx.db.query("agentDeliveries").first())!._id);
    await t.action(internal.webhooksNode.send, { deliveryId });
    const [delivery] = await deliveriesOf(ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(await callsOf(hook)).toEqual([]);
    expect(await callsOf(other)).toEqual([]);
  });
});

describe("access is checked again just before the send", () => {
  test("removed from a private channel after the message was queued, it gets nothing, and the message says why", async () => {
    const { t, teamId, admin, grokMemberId, hook } = await grokTeam();
    const launch = await admin.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [grokMemberId] });
    // The scheduled send waits on a fake clock, so access changes before it runs.
    vi.useFakeTimers();
    const ask = await admin.as.mutation(api.messages.post, { teamId, channelId: launch, body: `<@${grokMemberId}> the launch date is secret` });
    await admin.as.mutation(api.channels.removeMember, { teamId, channelId: launch, memberId: grokMemberId });
    vi.useRealTimers();
    const deliveryId = await t.run(async (ctx) => (await ctx.db.query("agentDeliveries").first())!._id);
    await t.action(internal.webhooksNode.send, { deliveryId });
    const [delivery] = await deliveriesOf(admin, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toBe("Grok Bot can no longer see #launch, so the room didn't send this.");
    expect(await callsOf(hook)).toEqual([]);
  });

  test("its person's account deleted after the message was queued, before they have left the team, it gets nothing (ADR 0035)", async () => {
    const { t, teamId, ana, grokMemberId, hook, general } = await grokTeam();
    // The send and the deletion's later steps wait on a fake clock: Julio is still in the team.
    vi.useFakeTimers();
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> what shipped today?` });
    await t.mutation(internal.accounts.deleteFromClerk, { deliveryId: "msg_julio", subject: "user_Julio" });
    vi.useRealTimers();
    const deliveryId = await t.run(async (ctx) => (await ctx.db.query("agentDeliveries").first())!._id);
    await t.action(internal.webhooksNode.send, { deliveryId });
    const [delivery] = await deliveriesOf(ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toBe("The person accountable for Grok Bot deleted their account, so the room no longer sends it messages.");
    expect(await callsOf(hook)).toEqual([]);
  });
});

describe("a send the room lost track of", () => {
  /** A message to Grok Bot whose send and deadline check are held on a fake clock. */
  async function held() {
    const team = await grokTeam();
    vi.useFakeTimers();
    const ask = await team.ana.as.mutation(api.messages.post, { teamId: team.teamId, channelId: team.general, body: `<@${team.grokMemberId}> hi` });
    const deliveryId = await team.t.run(async (ctx) => (await ctx.db.query("agentDeliveries").first())!._id);
    return { ...team, ask, deliveryId };
  }

  test("started but never settled: past the deadline it is unconfirmed, and nothing is sent again", async () => {
    const { t, teamId, ana, hook, ask, deliveryId } = await held();
    // The send action started its attempt, then died before it could record how it went.
    expect((await t.mutation(internal.webhooks.request, { deliveryId })).kind).toBe("send");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const [delivery] = await deliveriesOf(ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toBe("Unconfirmed: it may have reached Grok Bot. The room lost track of the send, so it doesn't send it again.");
    expect(await callsOf(hook)).toEqual([]);
  });

  test("never started before the deadline: it says it wasn't sent, and a late send action sends nothing", async () => {
    const { t, teamId, ana, hook, ask, deliveryId } = await held();
    await t.mutation(internal.webhooks.checkSending, { deliveryId });
    vi.useRealTimers();
    await t.action(internal.webhooksNode.send, { deliveryId });
    const [delivery] = await deliveriesOf(ana, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toBe("The room couldn't start this send in time, so it wasn't sent.");
    expect(await callsOf(hook)).toEqual([]);
  });

  test("a send that settled is left alone by the deadline check", async () => {
    const { t, teamId, ana, hook, grokMemberId, general } = await grokTeam();
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> hi` });
    await settled(t, ana, teamId, ask);
    const deliveryId = await t.run(async (ctx) => (await ctx.db.query("agentDeliveries").first())!._id);
    await t.mutation(internal.webhooks.checkSending, { deliveryId });
    const [delivery] = await deliveriesOf(ana, teamId, ask);
    expect(delivery!.status).toBe("sent");
    expect(await callsOf(hook)).toHaveLength(1);
  });
});

describe("outbound guards, as for A2A (ADR 0012)", () => {
  test("only public https URLs are taken", async () => {
    vi.stubEnv("A2A_ALLOW_INSECURE_PEERS", "0");
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const agentId = await admin.as.mutation(api.agents.add, { teamId, name: "Grok Bot", connection: "mcp" });
    for (const url of ["http://grok.example.com/hook", "https://127.0.0.1/hook", "https://10.1.2.3/hook", "https://router.local/hook", "https://user:pw@grok.example.com/hook", "https://x.convex.site/hook"]) {
      await expect(admin.as.mutation(api.webhooks.set, { teamId, agentId, url, key: KEY })).rejects.toThrow();
    }
  });

  test("a name that resolves to a private address is refused when the send connects", async () => {
    vi.stubEnv("A2A_ALLOW_INSECURE_PEERS", "0");
    setResolverForTests(async () => [{ address: "10.0.0.5", family: 4 }]);
    const t = newRoom();
    const { teamId, admin } = await newTeam(t);
    const agentId = await admin.as.mutation(api.agents.add, { teamId, name: "Grok Bot", connection: "mcp" });
    const members = await admin.as.query(api.teams.members, { teamId });
    const grok = members.find((m) => m.name === "Grok Bot")!.memberId;
    await admin.as.mutation(api.webhooks.set, { teamId, agentId, url: "https://hooks.grok.example/run/1", key: KEY });
    const general = (await admin.as.query(api.channels.list, { teamId })).find((c) => c.name === "general")!.channelId;
    const ask = await admin.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grok}> hi` });
    const [delivery] = await settled(t, admin, teamId, ask);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.reason).toContain("10.0.0.5");
  });

  test("only the person accountable for the agent, or an admin, sets its webhook", async () => {
    const { teamId, ana, agentId } = await grokTeam();
    await expect(ana.as.mutation(api.webhooks.set, { teamId, agentId, url: "https://grok.example.com/hook", key: KEY })).rejects.toThrow(/accountable/);
  });
});

describe("the key", () => {
  test("is never readable back: queries show only its last four characters", async () => {
    const { t, teamId, ana, admin, agentId, grokMemberId, general } = await grokTeam({ status: 500, body: KEY });
    const ask = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `<@${grokMemberId}> hi` });
    await settled(t, ana, teamId, ask);
    const webhook = await admin.as.query(api.webhooks.get, { teamId, agentId });
    expect(webhook).toEqual(expect.objectContaining({ hint: `…${KEY.slice(-4)}` }));
    const everything = JSON.stringify([
      webhook,
      await ana.as.query(api.webhooks.get, { teamId, agentId }),
      await ana.as.query(api.messages.get, { teamId, messageId: ask }),
      await ana.as.query(api.messages.list, { teamId, channelId: general }),
      await admin.as.query(api.teams.members, { teamId }),
      await admin.as.query(api.activity.list, { teamId }),
    ]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(KEY.slice(0, 12));
  });
});
