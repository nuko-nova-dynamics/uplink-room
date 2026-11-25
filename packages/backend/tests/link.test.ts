/**
 * A person's Link (ADR 0049): the roster agent their Inbox talks to, through a direct message with
 * it. Setting it opens that direct message; a message the person writes there reaches the agent
 * with word that it is their Link and should start work itself. These run the real webhook send
 * against the local fake webhook (tests/a2a/globalSetup.ts), as webhooks.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { inject } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam, type Person, type Room } from "./setup";
import { callsOf, connected, until } from "./a2a/helpers";
import { setA2ATimingForTests } from "../convex/lib/a2a/timing";
import { listed } from "./setup";
import { sleep } from "./a2a/helpers";

type Hook = { id: string; url: string };

async function fakeHook(): Promise<Hook> {
  const response = await fetch(`${inject("fakeAgents")}/webhooks`, { method: "POST", body: "{}" });
  return (await response.json()) as Hook;
}

async function bodiesOf(hook: Hook): Promise<{ instruction: string; message: { messageId: string } }[]> {
  const calls = (await (await fetch(`${inject("fakeAgents")}/webhooks/${hook.id}/calls`)).json()) as { body: string }[];
  return calls.map((c) => JSON.parse(c.body));
}

/** Runs the scheduled sends until the message's deliveries have settled. */
async function sent(t: Room, person: Person, teamId: Id<"teams">, messageId: Id<"messages">) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    await t.finishInProgressScheduledFunctions();
    const view = await person.as.query(api.messages.get, { teamId, messageId });
    if (view!.deliveries.length > 0 && view!.deliveries.every((d) => d.status !== "sending")) return;
    await sleep(15);
  }
  throw new Error("The message wasn't sent in time.");
}

/** Julio's team with Grok Bot at a routine webhook, Ana, and an agent the room can't reach. */
async function linkTeam() {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const agentId = await admin.as.mutation(api.agents.add, { teamId, name: "Grok Bot", connection: "mcp" });
  await admin.as.mutation(api.agents.add, { teamId, name: "Unreached", connection: "mcp" });
  const hook = await fakeHook();
  await admin.as.mutation(api.webhooks.set, { teamId, agentId, url: hook.url, key: "grk_live_link" });
  const members = await admin.as.query(api.teams.members, { teamId });
  const grok = members.find((m) => m.name === "Grok Bot")!.memberId;
  const unreached = members.find((m) => m.name === "Unreached")!.memberId;
  return { t, teamId, admin, ana, grok, unreached, hook };
}

describe("members.setLink", () => {
  test("opens the direct message with the agent, which members.link returns until it's cleared", async () => {
    const { teamId, admin, grok } = await linkTeam();
    expect(await admin.as.query(api.members.link, { teamId })).toBeNull();

    const set = await admin.as.mutation(api.members.setLink, { teamId, agentMemberId: grok });
    const direct = (await admin.as.mutation(api.channels.openDirect, { teamId, memberIds: [grok] })).channelId;
    expect(set).toEqual({ channelId: direct });
    expect(await admin.as.query(api.members.link, { teamId })).toEqual({
      memberId: grok,
      agentId: expect.any(String),
      name: "Grok Bot",
      channelId: direct,
      reach: "webhook",
    });

    await admin.as.mutation(api.members.setLink, { teamId, agentMemberId: null });
    expect(await admin.as.query(api.members.link, { teamId })).toBeNull();
  });

  test("refuses an agent the room can't reach, and a person", async () => {
    const { teamId, admin, ana, unreached } = await linkTeam();
    await expect(admin.as.mutation(api.members.setLink, { teamId, agentMemberId: unreached })).rejects.toThrow(
      /can't reach Unreached/,
    );
    await expect(admin.as.mutation(api.members.setLink, { teamId, agentMemberId: ana.memberId })).rejects.toThrow(
      /Your Link is an agent/,
    );
  });
});

describe("a message in the Link conversation", () => {
  test("reaches the agent told it is that person's Link; someone else's direct message with it doesn't", async () => {
    const { t, teamId, admin, ana, grok, hook } = await linkTeam();
    const set = await admin.as.mutation(api.members.setLink, { teamId, agentMemberId: grok });
    const mine = await admin.as.mutation(api.messages.post, {
      teamId,
      channelId: set!.channelId,
      body: "the checkout page crashes on Safari, can someone look",
    });
    await sent(t, admin, teamId, mine);
    const anas = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [grok] })).channelId;
    const hers = await ana.as.mutation(api.messages.post, { teamId, channelId: anas, body: "summarize my week" });
    await sent(t, ana, teamId, hers);

    const [toLink, toAna] = await bodiesOf(hook);
    expect(toLink!.message.messageId).toBe(mine);
    expect(toLink!.instruction).toContain("You are Julio's Link");
    expect(toLink!.instruction).toContain("tasks_create");
    expect(toLink!.instruction).toContain("runs_start");
    expect(toAna!.message.messageId).toBe(hers);
    expect(toAna!.instruction).not.toContain("Link");
  });
});

describe("review round 1 (ADR 0049)", () => {
  test("an A2A agent that takes work only from the person who added it can't be someone else's Link", async () => {
    const { t, teamId, admin, agentMemberId } = await connected({ sendWork: "accountable" });
    const ana = await addTeammate(t, teamId, admin, "Ana");
    await expect(ana.as.mutation(api.members.setLink, { teamId, agentMemberId })).rejects.toThrow(
      /can't take messages from you over A2A/,
    );
    // The roster says so to each person, so the Inbox offers it only to its person.
    const entry = async (who: Person) =>
      (await who.as.query(api.teams.roster, { teamId })).find((e) => e.kind === "agent" && e.memberId === agentMemberId);
    expect(await entry(ana)).toMatchObject({ takesYourWork: false });
    expect(await entry(admin)).toMatchObject({ takesYourWork: true });
    // The person who added it can.
    await admin.as.mutation(api.members.setLink, { teamId, agentMemberId });
    expect(await admin.as.query(api.members.link, { teamId })).toMatchObject({ reach: "a2a" });
  });

  test("another of the person's agents doesn't learn which agent is the Link or its direct message", async () => {
    const { t, teamId, admin, grok } = await linkTeam();
    await admin.as.mutation(api.members.setLink, { teamId, agentMemberId: grok });
    const { key } = await addAgent(t, teamId, admin, "Notetaker");
    const read = await callAsAgent(t, key, "members.link");
    expect(read).toMatchObject({ ok: true, result: null });
  });

  test("the Link is told to make the task the person's own", async () => {
    const { t, teamId, admin, grok, hook } = await linkTeam();
    const set = await admin.as.mutation(api.members.setLink, { teamId, agentMemberId: grok });
    const sentId = await admin.as.mutation(api.messages.post, { teamId, channelId: set!.channelId, body: "fix the export" });
    await sent(t, admin, teamId, sentId);
    const [body] = await bodiesOf(hook);
    const julio = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
    expect(body!.instruction).toContain(`ownerId ${julio}`);
  });
});

describe("review round 2 (ADR 0049)", () => {
  beforeEach(() => setA2ATimingForTests({ fast: true }));
  afterEach(() => setA2ATimingForTests(undefined));

  test("an A2A Link isn't offered thread proposals, and one it makes anyway is posted as an answer", async () => {
    const { t, teamId, admin, agentMemberId, fake } = await connected({ chat: true, name: "Icarus", agentName: "Icarus" });
    const set = await admin.as.mutation(api.members.setLink, { teamId, agentMemberId });
    const channelId = set!.channelId;
    await admin.as.mutation(api.messages.post, { teamId, channelId, body: "propose: the Q3 migration" });
    const rows = await until(
      t,
      async () => listed(await admin.as.query(api.messages.list, { teamId, channelId })),
      (r) => r.some((m) => m.author?.memberId === agentMemberId),
    );
    expect(rows.some((m) => m.a2a?.proposal)).toBe(false);
    const sent = (await callsOf(fake)).filter((c) => c.method === "SendMessage" || c.method === "SendStreamingMessage");
    expect(sent[0]!.params.message.metadata["uplink.room/capabilities"] ?? []).not.toContain("propose-thread");
  });
});

describe("review round 3 (ADR 0049)", () => {
  test("an agent reading the roster isn't offered itself as a task target", async () => {
    const { t, teamId, admin } = await linkTeam();
    const { key } = await addAgent(t, teamId, admin, "Notetaker");
    const read = await callAsAgent(t, key, "teams.roster");
    const rows = read.result as { kind: string; name: string; takesYourWork?: boolean }[];
    expect(rows.find((e) => e.name === "Notetaker")).toMatchObject({ takesYourWork: false });
    expect(rows.find((e) => e.name === "Grok Bot")).toMatchObject({ takesYourWork: true });
  });
});
