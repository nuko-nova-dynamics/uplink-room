import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { api, internal } from "../convex/_generated/api";
import { REVOCATIONS_PRUNE_BATCH, REVOKE_BATCH, REVOKE_MAX_TRIES, REVOKE_WINDOW_MS } from "../convex/calls";
import { isNotFound, setLiveKitRoomsForTests } from "../convex/lib/livekit";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, DAY, listed, newRoom, newTeam, type Room } from "./setup";

const LIVEKIT = { LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" };

beforeEach(() => {
  for (const [key, value] of Object.entries(LIVEKIT)) process.env[key] = value;
});
afterEach(() => {
  for (const key of Object.keys(LIVEKIT)) delete process.env[key];
});

const verify = (token: string) => new TokenVerifier(LIVEKIT.LIVEKIT_API_KEY, LIVEKIT.LIVEKIT_API_SECRET).verify(token);

/** A team with Julio (admin) and Ana, the #general channel, and a project "Reef Runner" with its channel. */
async function team() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const projectId = await julio.as.mutation(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  const channels = await julio.as.query(api.channels.list, { teamId });
  const general = channels.find((c) => c.name === "general")!.channelId;
  const reef = channels.find((c) => c.projectId === projectId)!.channelId;
  const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
  return { t, teamId, julio, julioId, ana, projectId, general, reef };
}

/**
 * Runs scheduled functions with fake timers, letting what is due finish (an action's own timers and
 * the mutation it calls included) before the clock moves to the next one, as happens live, where a
 * LiveKit try takes seconds and the next is half a minute away.
 */
async function drain(t: Room) {
  const busy = async () =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (f) => f.state.kind === "pending" || f.state.kind === "inProgress",
    );
  for (let i = 0; i < 5000; i++) {
    for (let j = 0; j < 4; j++) {
      vi.advanceTimersByTime(0);
      await t.finishInProgressScheduledFunctions();
    }
    const left = await busy();
    if (left.length === 0) return;
    if (!left.some((f) => f.state.kind === "inProgress")) vi.advanceTimersToNextTimer();
  }
  throw new Error("scheduled functions still pending");
}

/** The Notetaker with the scopes the spec gives it. */
async function notetaker(t: Room, teamId: Id<"teams">, person: Parameters<typeof addAgent>[2]) {
  const { agentId, key } = await addAgent(t, teamId, person, "Notetaker", ["room.read", "messages.post", "calls.join", "calls.notes"]);
  const members = await person.as.query(api.teams.members, { teamId });
  return { agentId, key, memberId: members.find((m) => m.name === "Notetaker")!.memberId };
}

test("joining a channel with no call starts one, and a second person joins the same call", async () => {
  const { teamId, julio, ana, reef } = await team();

  const first = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const second = await ana.as.mutation(api.calls.join, { teamId, channelId: reef });

  expect(second.callId).toBe(first.callId);
  expect(first.url).toBe(LIVEKIT.LIVEKIT_URL);
  const live = await ana.as.query(api.calls.live, { teamId });
  expect(live).toMatchObject([{ callId: first.callId, channelId: reef, participants: [{ name: "Julio" }, { name: "Ana" }] }]);
});

test("a person's token is for that call's room only, with this join as identity and no name", async () => {
  const { teamId, julio, julioId, reef } = await team();
  const { callId, participationId: julioIn, token } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });

  const claims = await verify(token);
  // One identity per join (member.participation), so a member on two devices doesn't knock the other out.
  expect(claims.sub).toBe(`${julioId}.${julioIn}`);
  expect(claims.name ?? "").toBe("");
  expect(claims.video).toMatchObject({ room: `call_${callId}`, roomJoin: true, canSubscribe: true, canPublish: true });
  expect(claims.video?.canPublishSources).toEqual(["microphone", "camera", "screen_share", "screen_share_audio"]);
  expect(claims.video?.roomAdmin).toBeFalsy();
  expect(claims.video?.roomCreate).toBeFalsy();
  expect((claims.exp ?? 0) - (claims.nbf ?? claims.iat ?? 0)).toBeLessThanOrEqual(10 * 60);
});

test("an agent needs the Join calls scope, joins over HTTP, and may publish only a microphone", async () => {
  const { t, teamId, julio, reef } = await team();
  const plain = await addAgent(t, teamId, julio, "Deploy bot");
  const denied = await callAsAgent(t, plain.key, "calls.join", { channelId: reef });
  expect(denied).toMatchObject({ status: 403, error: { code: "forbidden" } });

  const { key, memberId } = await notetaker(t, teamId, julio);
  const joined = await callAsAgent(t, key, "calls.join", { channelId: reef });
  expect(joined).toMatchObject({ status: 200, ok: true });
  const claims = await verify(joined.result.token);
  expect(claims.sub).toBe(`${memberId}.${joined.result.participationId}`);
  expect(claims.video?.canPublishSources).toEqual(["microphone"]);
  const live = await julio.as.query(api.calls.live, { teamId });
  expect(live[0]!.participants).toMatchObject([{ name: "Notetaker", kind: "agent", takesNotes: true }]);
});

test("the call ends when the last person leaves, and agents still in it are dropped", async () => {
  const { t, teamId, julio, ana, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const { participationId: anaIn } = await ana.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });

  await julio.as.mutation(api.calls.leave, { teamId, participationId: julioIn });
  expect((await ana.as.query(api.calls.get, { teamId, callId })).endedAt).toBeUndefined();
  await ana.as.mutation(api.calls.leave, { teamId, participationId: anaIn });

  const call = await julio.as.query(api.calls.get, { teamId, callId });
  expect(call.endedAt).toEqual(expect.any(Number));
  expect(call.participants).toEqual([]);
  expect(call.everyone.map((m) => m.name)).toEqual(["Julio", "Ana", "Notetaker"]);
  expect(await julio.as.query(api.calls.live, { teamId })).toEqual([]);

  // The next join starts a new call.
  const next = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  expect(next.callId).not.toBe(callId);
});

test("a participant whose heartbeat stops is dropped, ending the call if they were the last person", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, reef } = await team();
    const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
    const { participationId: anaIn } = await ana.as.mutation(api.calls.join, { teamId, channelId: reef });
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20_000);
      await t.finishInProgressScheduledFunctions();
      await julio.as.mutation(api.calls.heartbeat, { teamId, participationId: julioIn });
    }
    // Ana's app went quiet 80 seconds ago.
    expect((await julio.as.query(api.calls.get, { teamId, callId })).participants.map((p) => p.name)).toEqual(["Julio"]);
    await expect(ana.as.mutation(api.calls.heartbeat, { teamId, participationId: anaIn })).rejects.toThrow(/not in this call/i);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await julio.as.query(api.calls.get, { teamId, callId })).endedAt).toEqual(expect.any(Number));
  } finally {
    vi.useRealTimers();
  }
});

test("muting, the camera and screen share show to people outside the call", async () => {
  const { teamId, julio, ana, reef } = await team();
  const { participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.updateMedia, { teamId, participationId: julioIn, muted: true, screen: true });
  const [live] = await ana.as.query(api.calls.live, { teamId });
  expect(live!.participants).toMatchObject([{ name: "Julio", muted: true, camera: false, screen: true }]);
});

test("a signed participant_left webhook drops the participant at once; an unsigned one is rejected", async () => {
  const { t, teamId, julio, julioId, ana, reef } = await team();
  const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await ana.as.mutation(api.calls.join, { teamId, channelId: reef });

  const body = JSON.stringify({
    id: "EV_1",
    event: "participant_left",
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: `call_${callId}` },
    // LiveKit sends when the participant joined; the handler must accept it.
    participant: { identity: `${julioId}.${julioIn}`, joinedAt: String(Math.floor(Date.now() / 1000)), joinedAtMs: String(Date.now()) },
  });
  const unsigned = await t.fetch("/livekit/webhook", { method: "POST", headers: { "content-type": "application/webhook+json" }, body });
  expect(unsigned.status).toBe(401);
  expect((await ana.as.query(api.calls.get, { teamId, callId })).participants).toHaveLength(2);

  const signer = new AccessToken(LIVEKIT.LIVEKIT_API_KEY, LIVEKIT.LIVEKIT_API_SECRET);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  signer.sha256 = btoa(String.fromCharCode(...digest));
  const signed = await t.fetch("/livekit/webhook", {
    method: "POST",
    headers: { "content-type": "application/webhook+json", authorization: await signer.toJwt() },
    body,
  });
  expect(signed.status).toBe(200);
  expect((await ana.as.query(api.calls.get, { teamId, callId })).participants.map((p) => p.name)).toEqual(["Ana"]);
});

test("a webhook about one join leaves the member's other join in the call", async () => {
  const { t, teamId, julio, julioId, reef } = await team();
  const laptop = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const phone = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const body = JSON.stringify({
    id: "EV_2",
    event: "participant_left",
    room: { name: `call_${laptop.callId}` },
    participant: { identity: `${julioId}.${laptop.participationId}` },
  });
  const signer = new AccessToken(LIVEKIT.LIVEKIT_API_KEY, LIVEKIT.LIVEKIT_API_SECRET);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  signer.sha256 = btoa(String.fromCharCode(...digest));
  await t.fetch("/livekit/webhook", { method: "POST", headers: { authorization: await signer.toJwt() }, body });
  expect((await julio.as.query(api.calls.get, { teamId, callId: laptop.callId })).participants.map((p) => p.name)).toEqual(["Julio"]);
  await julio.as.mutation(api.calls.heartbeat, { teamId, participationId: phone.participationId });
  await expect(julio.as.mutation(api.calls.heartbeat, { teamId, participationId: laptop.participationId })).rejects.toThrow(/not in this call/i);
});

test("a stale leave removes only its own join, never a newer one on another device", async () => {
  const { teamId, julio, ana, reef } = await team();
  await ana.as.mutation(api.calls.join, { teamId, channelId: reef });
  const laptop = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  // The phone joins the same call before the laptop's (delayed) leave lands.
  const phone = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: laptop.participationId });

  const call = await julio.as.query(api.calls.get, { teamId, callId: phone.callId });
  expect(call.participants.map((p) => p.name)).toEqual(["Ana", "Julio"]);
  await julio.as.mutation(api.calls.heartbeat, { teamId, participationId: phone.participationId });
  // Leaving the same join twice is harmless.
  await julio.as.mutation(api.calls.leave, { teamId, participationId: laptop.participationId });
  expect((await julio.as.query(api.calls.get, { teamId, callId: phone.callId })).participants).toHaveLength(2);
});

test("a join can only be left, kept alive or updated by its own member", async () => {
  const { teamId, julio, ana, reef } = await team();
  const { participationId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await expect(ana.as.mutation(api.calls.leave, { teamId, participationId })).rejects.toThrow(/not yours|not found/i);
  await expect(ana.as.mutation(api.calls.heartbeat, { teamId, participationId })).rejects.toThrow(/not yours|not found/i);
  await expect(ana.as.mutation(api.calls.updateMedia, { teamId, participationId, muted: true })).rejects.toThrow(/not yours|not found/i);
});

test("a member on two devices stays in the call until both have left", async () => {
  const { teamId, julio, reef } = await team();
  const laptop = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const phone = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  expect(phone.callId).toBe(laptop.callId);
  await julio.as.mutation(api.calls.leave, { teamId, participationId: laptop.participationId });
  expect((await julio.as.query(api.calls.get, { teamId, callId: laptop.callId })).endedAt).toBeUndefined();
  await julio.as.mutation(api.calls.leave, { teamId, participationId: phone.participationId });
  expect((await julio.as.query(api.calls.get, { teamId, callId: laptop.callId })).endedAt).toEqual(expect.any(Number));
});

test("only someone in the call can ask an agent to join; the agent sees the invite until it joins", async () => {
  const { t, teamId, julio, ana, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });

  await expect(ana.as.mutation(api.calls.invite, { teamId, callId, memberId })).rejects.toThrow(/in the call/i);
  await julio.as.mutation(api.calls.invite, { teamId, callId, memberId });

  const invites = await callAsAgent(t, key, "calls.invitations");
  expect(invites.result).toMatchObject([{ callId, channelId: reef, invitedBy: { name: "Julio" } }]);
  await callAsAgent(t, key, "calls.join", { channelId: reef });
  expect((await callAsAgent(t, key, "calls.invitations")).result).toEqual([]);
});

test("pending invites clear when the call ends", async () => {
  const { t, teamId, julio, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.invite, { teamId, callId, memberId });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: julioIn });
  expect((await callAsAgent(t, key, "calls.invitations")).result).toEqual([]);
});

test("an agent can watch its invites live with its agent key", async () => {
  const { t, teamId, julio, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.invite, { teamId, callId, memberId });

  const invites = await t.query(api.live.query, { key, fn: "calls.invitations", args: {} });
  expect(invites).toMatchObject([{ callId }]);
  await expect(t.query(api.live.query, { key: "urk_wrong", fn: "calls.invitations", args: {} })).rejects.toThrow(/not valid/i);
  await expect(t.query(api.live.query, { key, fn: "calls.join", args: { channelId: reef } })).rejects.toThrow(/query/i);
});

test("the Notetaker writes the transcript, posts call notes in the channel and proposes tasks", async () => {
  const { t, teamId, julio, julioId, ana, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });

  const added = await callAsAgent(t, key, "calls.addTranscript", {
    callId,
    lines: [
      { speakerId: julioId, text: "Ana, can you take the save slot bug?", at: Date.now() },
      { speakerId: julioId, text: "  ", at: Date.now() },
    ],
  });
  expect(added).toMatchObject({ ok: true });
  const transcript = await ana.as.query(api.calls.transcript, { teamId, callId });
  expect(transcript.lines).toMatchObject([{ speaker: { name: "Julio" }, text: "Ana, can you take the save slot bug?" }]);

  await julio.as.mutation(api.calls.leave, { teamId, participationId: julioIn });
  const notes = await callAsAgent(t, key, "calls.postNotes", { callId, body: "## Call notes\n- Save slot bug goes to Ana" });
  expect(notes).toMatchObject({ ok: true });
  const proposed = await callAsAgent(t, key, "calls.propose", {
    callId,
    tasks: [{ title: "Fix the save slot bug", ownerId: ana.memberId }],
  });
  expect(proposed).toMatchObject({ ok: true });

  const messages = listed(await ana.as.query(api.messages.list, { teamId, channelId: reef }));
  expect(messages.at(-1)).toMatchObject({ author: { name: "Notetaker", kind: "agent" }, body: expect.stringContaining("Save slot bug") });
  const call = await ana.as.query(api.calls.get, { teamId, callId });
  expect(call.notesMessageId).toBe(messages.at(-1)!.messageId);
  expect(call.proposals).toMatchObject([{ title: "Fix the save slot bug", owner: { name: "Ana" }, status: "pending", proposedBy: { name: "Notetaker" } }]);
  expect(memberId).toBeDefined();
});

test("someone who wasn't in the call can't add to its transcript or propose tasks", async () => {
  const { t, teamId, julio, julioId, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });

  const lines = await callAsAgent(t, key, "calls.addTranscript", { callId, lines: [{ speakerId: julioId, text: "hi", at: Date.now() }] });
  expect(lines).toMatchObject({ status: 403 });
  const tasks = await callAsAgent(t, key, "calls.propose", { callId, tasks: [{ title: "Anything" }] });
  expect(tasks).toMatchObject({ status: 403 });
});

test("accepting a proposed task creates a Not started task in the channel's project, owned by the suggested owner", async () => {
  const { t, teamId, julio, ana, projectId, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });
  const { result: [proposalId] } = await callAsAgent(t, key, "calls.propose", {
    callId,
    tasks: [{ title: "Fix the save slot bug", description: "From the standup", ownerId: ana.memberId }],
  });

  const taskId = await julio.as.mutation(api.calls.acceptProposal, { teamId, proposalId });
  const board = await julio.as.query(api.tasks.board, { teamId, projectId });
  expect(board).toMatchObject([{ taskId, title: "Fix the save slot bug", owner: { name: "Ana" }, column: "not_started", runs: [] }]);
  await expect(ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId })).rejects.toThrow(/already/i);
  expect((await julio.as.query(api.calls.get, { teamId, callId })).proposals).toMatchObject([{ status: "accepted", taskId, answeredBy: { name: "Julio" } }]);
});

test("the Inbox lists proposed tasks that need you: yours as suggested owner, or from a call you were in when none is", async () => {
  const { t, teamId, julio, ana, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });
  const {
    result: [anas, nobodys],
  } = await callAsAgent(t, key, "calls.propose", {
    callId,
    tasks: [{ title: "Fix the save slot bug", ownerId: ana.memberId }, { title: "Order the new monitors" }],
  });
  // A private channel's call: its proposals stay with its members, in Team too.
  const secret = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [] });
  const { callId: secretCall } = await julio.as.mutation(api.calls.join, { teamId, channelId: secret });
  await julio.as.mutation(api.calls.propose, { teamId, callId: secretCall, tasks: [{ title: "Plan the launch" }] });

  const titles = async (who: typeof julio, view?: "team") =>
    (await who.as.query(api.inbox.get, { teamId, ...(view ? { view } : {}) })).proposals.map((p) => p.title);
  // Julio was in both calls: the reef one with no owner, and the launch one. Ana's is hers though she wasn't in the call.
  expect(await titles(julio)).toEqual(["Plan the launch", "Order the new monitors"]);
  expect(await titles(ana)).toEqual(["Fix the save slot bug"]);
  expect(await titles(ana, "team")).toEqual(["Fix the save slot bug", "Order the new monitors"]);
  const [row] = (await ana.as.query(api.inbox.get, { teamId })).proposals;
  expect(row).toMatchObject({ proposalId: anas, callId, channelId: reef, where: "#reef-runner", owner: { name: "Ana" }, proposedBy: { name: "Notetaker" } });
  expect(row!.channelProjectId).toBeDefined();

  await ana.as.mutation(api.calls.acceptProposal, { teamId, proposalId: anas! });
  await julio.as.mutation(api.calls.dismissProposal, { teamId, proposalId: nobodys! });
  expect(await titles(ana)).toEqual([]);
  expect(await titles(julio)).toEqual(["Plan the launch"]);
});

test("an agent reading its person's Inbox sees no proposal from a channel its person left", async () => {
  const { t, teamId, julio, ana } = await team();
  const scout = await addAgent(t, teamId, ana, "Scout", ["room.read"]);
  const scoutId = (await ana.as.query(api.teams.members, { teamId })).find((m) => m.name === "Scout")!.memberId;
  const launch = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ana.memberId, scoutId] });
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: launch });
  await ana.as.mutation(api.calls.join, { teamId, channelId: launch });
  await julio.as.mutation(api.channels.removeMember, { teamId, channelId: launch, memberId: ana.memberId });
  await julio.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Plan the secret launch" }] });

  expect((await ana.as.query(api.inbox.get, { teamId })).proposals).toEqual([]);
  const person = await callAsAgent(t, scout.key, "inbox.get", { view: "person" });
  expect(person.result.proposals).toEqual([]);
});

test("a proposal from a channel whose project was archived asks where when accepted", async () => {
  const { t, teamId, julio, projectId, reef } = await team();
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.propose, { teamId, callId, tasks: [{ title: "Ship the demo" }] });
  expect((await julio.as.query(api.inbox.get, { teamId })).proposals[0]!.channelProjectId).toBe(projectId);

  await julio.as.mutation(api.projects.archive, { teamId, projectId });
  expect((await julio.as.query(api.inbox.get, { teamId })).proposals[0]!.channelProjectId).toBeUndefined();
  expect(t).toBeDefined();
});

test("in a channel with no project, accepting asks which project, or no project", async () => {
  const { t, teamId, julio, projectId, general } = await team();
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: general });
  const [first, second] = await julio.as.mutation(api.calls.propose, {
    teamId,
    callId,
    tasks: [{ title: "Order the new monitors" }, { title: "Write the release notes" }],
  });

  await expect(julio.as.mutation(api.calls.acceptProposal, { teamId, proposalId: first! })).rejects.toThrow(/which project/i);
  const noProject = await julio.as.mutation(api.calls.acceptProposal, { teamId, proposalId: first!, projectId: null });
  const inProject = await julio.as.mutation(api.calls.acceptProposal, { teamId, proposalId: second!, projectId, title: "Write the 0.5 release notes" });

  expect((await julio.as.query(api.tasks.get, { teamId, taskId: noProject })).projectId).toBeUndefined();
  expect(await julio.as.query(api.tasks.get, { teamId, taskId: inProject })).toMatchObject({ projectId, title: "Write the 0.5 release notes", owner: { name: "Julio" } });
  expect(t).toBeDefined();
});

test("dismissing a proposed task needs the Manage work scope for an agent, and can't be undone into a task", async () => {
  const { t, teamId, julio, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });
  const { result: [proposalId] } = await callAsAgent(t, key, "calls.propose", { callId, tasks: [{ title: "Rewrite everything in Rust" }] });

  expect(await callAsAgent(t, key, "calls.dismissProposal", { proposalId })).toMatchObject({ status: 403 });
  await julio.as.mutation(api.calls.dismissProposal, { teamId, proposalId });
  await expect(julio.as.mutation(api.calls.acceptProposal, { teamId, proposalId })).rejects.toThrow(/already/i);
});

test("transcripts are deleted 30 days after the call ends; the notes stay", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const { t, teamId, julio, julioId, reef } = await team();
    const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
    await julio.as.mutation(api.calls.addTranscript, { teamId, callId, lines: [{ speakerId: julioId, text: "Ship it Friday", at: Date.now() }] });
    await julio.as.mutation(api.calls.leave, { teamId, participationId: julioIn });
    await julio.as.mutation(api.calls.postNotes, { teamId, callId, body: "Ship it Friday." });

    vi.advanceTimersByTime(29 * DAY);
    await t.mutation(internal.calls.pruneTranscripts, {});
    expect((await julio.as.query(api.calls.transcript, { teamId, callId })).lines).toHaveLength(1);

    vi.advanceTimersByTime(2 * DAY);
    await t.mutation(internal.calls.pruneTranscripts, {});
    const transcript = await julio.as.query(api.calls.transcript, { teamId, callId });
    expect(transcript).toMatchObject({ lines: [], deleted: true });
    const messages = listed(await julio.as.query(api.messages.list, { teamId, channelId: reef }));
    expect(messages.at(-1)!.body).toBe("Ship it Friday.");
  } finally {
    vi.useRealTimers();
  }
});

test("without LiveKit configured, joining a call fails with a clear message", async () => {
  const { teamId, julio, reef } = await team();
  delete process.env.LIVEKIT_API_SECRET;
  await expect(julio.as.mutation(api.calls.join, { teamId, channelId: reef })).rejects.toThrow(/aren't set up/i);
  expect(await julio.as.query(api.calls.live, { teamId })).toEqual([]);
});

test("an archived channel can't hold a call", async () => {
  const { teamId, julio, projectId, reef } = await team();
  await julio.as.mutation(api.projects.archive, { teamId, projectId });
  await expect(julio.as.mutation(api.calls.join, { teamId, channelId: reef })).rejects.toThrow(/archived/i);
});

test("a channel lists its calls, with who started each and everyone who was in it", async () => {
  const { teamId, julio, ana, reef, general } = await team();
  const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const { participationId: anaIn } = await ana.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: julioIn });
  await ana.as.mutation(api.calls.leave, { teamId, participationId: anaIn });
  const calls = await julio.as.query(api.calls.list, { teamId, channelId: reef });
  expect(calls).toMatchObject([{ callId, startedBy: { name: "Julio" }, endedAt: expect.any(Number), everyone: [{ name: "Julio" }, { name: "Ana" }] }]);
  expect(await julio.as.query(api.calls.list, { teamId, channelId: general })).toEqual([]);
});

test("a transcript batch sent again with the same line keys is added once", async () => {
  const { t, teamId, julio, julioId, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });
  const lines = [
    { speakerId: julioId, text: "Ship it Friday", at: 1, key: "u-1" },
    { speakerId: julioId, text: "And the release notes", at: 2, key: "u-2" },
  ];
  expect((await callAsAgent(t, key, "calls.addTranscript", { callId, lines })).result).toEqual({ added: 2 });
  // The Notetaker's upload timed out after the room took it, so it sends the batch again with one more line.
  const again = await callAsAgent(t, key, "calls.addTranscript", {
    callId,
    lines: [...lines, { speakerId: julioId, text: "Done", at: 3, key: "u-3" }],
  });
  expect(again.result).toEqual({ added: 1 });
  const transcript = await julio.as.query(api.calls.transcript, { teamId, callId });
  expect(transcript.lines.map((l) => l.text)).toEqual(["Ship it Friday", "And the release notes", "Done"]);
});

test("a channel's calls say whether each has a transcript, even when no notes were posted", async () => {
  const { teamId, julio, julioId, reef } = await team();
  const first = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.addTranscript, { teamId, callId: first.callId, lines: [{ speakerId: julioId, text: "Ship it", at: 1 }] });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: first.participationId });
  const second = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: second.participationId });

  const calls = await julio.as.query(api.calls.list, { teamId, channelId: reef });
  expect(calls.map((c) => [c.callId, c.hasTranscript, c.notesMessageId])).toEqual([
    [second.callId, false, undefined],
    [first.callId, true, undefined],
  ]);
});

test("joining a named call fails once it has ended, and never starts a new call", async () => {
  const { t, teamId, julio, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId, participationId: julioIn } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  expect(await callAsAgent(t, key, "calls.join", { channelId: reef, callId })).toMatchObject({ ok: true });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: julioIn });

  const late = await callAsAgent(t, key, "calls.join", { channelId: reef, callId });
  expect(late).toMatchObject({ status: 409, error: { code: "conflict" } });
  expect(await julio.as.query(api.calls.live, { teamId })).toEqual([]);
  expect(await julio.as.query(api.calls.list, { teamId, channelId: reef })).toHaveLength(1);
});

test("one process at a time holds an agent's call lease; another takes it once the holder stops renewing", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const { t, teamId, julio } = await team();
    const { key } = await notetaker(t, teamId, julio);
    const claim = (holder: string) => callAsAgent(t, key, "calls.claimLease", { holder });

    // leaseMs lets the holder time the lease on its own clock.
    expect((await claim("process-a")).result).toMatchObject({ held: true, leaseMs: 45_000 });
    expect((await claim("process-b")).result).toMatchObject({ held: false });
    vi.advanceTimersByTime(30_000);
    expect((await claim("process-a")).result).toMatchObject({ held: true }); // renewed
    vi.advanceTimersByTime(30_000);
    expect((await claim("process-b")).result).toMatchObject({ held: false });

    // Process A crashes: no renewals. Its lease runs out and B takes it.
    vi.advanceTimersByTime(46_000);
    expect((await claim("process-b")).result).toMatchObject({ held: true });
    expect((await claim("process-a")).result).toMatchObject({ held: false });
    // A stale release from A can't free B's lease.
    await callAsAgent(t, key, "calls.releaseLease", { holder: "process-a" });
    expect((await claim("process-c")).result).toMatchObject({ held: false });
    await callAsAgent(t, key, "calls.releaseLease", { holder: "process-b" });
    expect((await claim("process-c")).result).toMatchObject({ held: true });
  } finally {
    vi.useRealTimers();
  }
});

test("people don't take call leases; leases are for agents' processes", async () => {
  const { teamId, julio } = await team();
  await expect(julio.as.mutation(api.calls.claimLease, { teamId, holder: "x" })).rejects.toThrow(/agent/i);
});

test("pruning goes on past one batch of 100 calls until every due transcript is gone", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const { t, teamId, julio, julioId, reef } = await team();
    const callIds: Id<"calls">[] = [];
    for (let i = 0; i < 101; i++) {
      const { callId, participationId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
      await julio.as.mutation(api.calls.addTranscript, { teamId, callId, lines: [{ speakerId: julioId, text: `line ${i}`, at: i }] });
      await julio.as.mutation(api.calls.leave, { teamId, participationId });
      callIds.push(callId);
    }
    vi.advanceTimersByTime(31 * DAY);
    await t.mutation(internal.calls.pruneTranscripts, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => (await ctx.db.query("transcriptLines").collect()).length);
    expect(left).toBe(0);
    const last = await julio.as.query(api.calls.transcript, { teamId, callId: callIds.at(-1)! });
    expect(last).toMatchObject({ lines: [], deleted: true });
  } finally {
    vi.useRealTimers();
  }
});

test("proposed tasks sent again with the same keys are proposed once", async () => {
  const { t, teamId, julio, reef } = await team();
  const { key } = await notetaker(t, teamId, julio);
  const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await callAsAgent(t, key, "calls.join", { channelId: reef });
  const tasks = [
    { title: "Fix the save slot bug", key: "s1-0" },
    { title: "Investigate the CI failure", key: "s1-1" },
  ];
  const first = await callAsAgent(t, key, "calls.propose", { callId, tasks });
  // The answer was lost, so the Notetaker sends the same proposals again.
  const again = await callAsAgent(t, key, "calls.propose", { callId, tasks });
  expect(again.result).toEqual(first.result);
  const call = await julio.as.query(api.calls.get, { teamId, callId });
  expect(call.proposals.map((p) => p.title)).toEqual(["Fix the save slot bug", "Investigate the CI failure"]);
});

test("a member on two devices shows camera and screen if either has them on, and muted only if both are muted", async () => {
  const { teamId, julio, ana, reef } = await team();
  const laptop = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.updateMedia, { teamId, participationId: laptop.participationId, camera: true, screen: true });
  const phone = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.updateMedia, { teamId, participationId: phone.participationId, muted: true });
  const seen = async () => (await ana.as.query(api.calls.live, { teamId }))[0]!.participants;
  expect(await seen()).toMatchObject([{ name: "Julio", muted: false, camera: true, screen: true }]);

  await julio.as.mutation(api.calls.updateMedia, { teamId, participationId: laptop.participationId, muted: true, camera: false });
  expect(await seen()).toMatchObject([{ name: "Julio", muted: true, camera: false, screen: true }]);
  await julio.as.mutation(api.calls.leave, { teamId, participationId: laptop.participationId });
  expect(await seen()).toMatchObject([{ name: "Julio", muted: true, camera: false, screen: false }]);
});

test("an agent's unfinished calls: live calls it joined but isn't in, and ended ones with a transcript and no notes", async () => {
  const { t, teamId, julio, julioId, general, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const unfinished = async () => (await callAsAgent(t, key, "calls.unfinished")).result;

  // Reef: the Notetaker joins when asked, hears a line, then crashes (the room drops its join).
  const reefCall = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.invite, { teamId, callId: reefCall.callId, memberId });
  const noteIn = (await callAsAgent(t, key, "calls.join", { channelId: reef, callId: reefCall.callId })).result;
  await callAsAgent(t, key, "calls.addTranscript", { callId: reefCall.callId, lines: [{ speakerId: julioId, text: "Ship it Friday.", at: Date.now(), key: "l1" }] });
  expect(await unfinished()).toEqual([]); // still in it
  await callAsAgent(t, key, "calls.leave", { participationId: noteIn.participationId });
  expect(await unfinished()).toMatchObject([{ callId: reefCall.callId, channelId: reef, ended: false }]);

  // General: asked but never joined (still pending), so it's not unfinished.
  const generalCall = await julio.as.mutation(api.calls.join, { teamId, channelId: general });
  await julio.as.mutation(api.calls.invite, { teamId, callId: generalCall.callId, memberId });

  // Reef ends while the Notetaker is gone: it has a transcript and no notes.
  await julio.as.mutation(api.calls.leave, { teamId, participationId: reefCall.participationId });
  expect(await unfinished()).toMatchObject([{ callId: reefCall.callId, ended: true }]);
  await callAsAgent(t, key, "calls.postNotes", { callId: reefCall.callId, body: "Ship Friday." });
  await callAsAgent(t, key, "calls.propose", { callId: reefCall.callId, tasks: [] });
  expect(await unfinished()).toEqual([]);
});

test("an ended call with notes but no proposals is still unfinished, until calls.propose runs, even with no tasks", async () => {
  const { t, teamId, julio, julioId, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const unfinished = async () => (await callAsAgent(t, key, "calls.unfinished")).result;
  const call = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.invite, { teamId, callId: call.callId, memberId });
  const noteIn = (await callAsAgent(t, key, "calls.join", { channelId: reef, callId: call.callId })).result;
  await callAsAgent(t, key, "calls.addTranscript", { callId: call.callId, lines: [{ speakerId: julioId, text: "Ship it Friday.", at: Date.now(), key: "l1" }] });
  await callAsAgent(t, key, "calls.leave", { participationId: noteIn.participationId });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: call.participationId });

  // The Notetaker posted the notes, then stopped before it proposed the tasks.
  await callAsAgent(t, key, "calls.postNotes", { callId: call.callId, body: "Ship Friday." });
  expect(await unfinished()).toMatchObject([{ callId: call.callId, ended: true }]);
  await callAsAgent(t, key, "calls.propose", { callId: call.callId, tasks: [] });
  expect(await unfinished()).toEqual([]);

  // A call finished before the room recorded proposing (notes and proposals, no mark) isn't redone.
  await t.run(async (ctx) => ctx.db.patch(call.callId, { proposedAt: undefined }));
  expect(await unfinished()).toMatchObject([{ callId: call.callId }]);
  await callAsAgent(t, key, "calls.propose", { callId: call.callId, tasks: [{ title: "Ship it", key: "k1" }] });
  await t.run(async (ctx) => ctx.db.patch(call.callId, { proposedAt: undefined }));
  expect(await unfinished()).toEqual([]);
});

test("an ended call nobody spoke in isn't unfinished", async () => {
  const { t, teamId, julio, reef } = await team();
  const { key, memberId } = await notetaker(t, teamId, julio);
  const call = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  await julio.as.mutation(api.calls.invite, { teamId, callId: call.callId, memberId });
  await callAsAgent(t, key, "calls.join", { channelId: reef, callId: call.callId });
  await julio.as.mutation(api.calls.leave, { teamId, participationId: call.participationId });
  expect((await callAsAgent(t, key, "calls.unfinished")).result).toEqual([]);
});

test("removing a member takes them out of every call: their joins end, LiveKit disconnects them, and they get no new token", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana, reef } = await team();
  const removed: { room: string; identity: string; before: number }[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (room, identity, before) => {
      removed.push({ room, identity, before });
      return "removed";
    },
  });
  try {
    await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
    const julioId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!.memberId;
    const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
    const inReef = await ana.as.mutation(api.calls.join, { teamId, channelId: reef });
    const inDm = await ana.as.mutation(api.calls.join, { teamId, channelId: dm });

    await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
    // Her joins end with the removal itself.
    const live = await julio.as.query(api.calls.live, { teamId });
    expect(live.find((c) => c.callId === inReef.callId)!.participants.map((p) => p.memberId)).toEqual([julioId]);
    // The direct message's call had only Ana left in it, so it ended.
    expect(live.some((c) => c.callId === inDm.callId)).toBe(false);
    await drain(t);
    expect(removed.map((r) => [r.room, r.identity]).sort()).toEqual(
      [
        [`call_${inReef.callId}`, `${ana.memberId}.${inReef.participationId}`],
        [`call_${inDm.callId}`, `${ana.memberId}.${inDm.participationId}`],
      ].sort(),
    );
    expect(removed.every((r) => r.before > 0)).toBe(true);
    await expect(ana.as.mutation(api.calls.join, { teamId, channelId: reef })).rejects.toThrow(/not a member/);
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
});

test("call notes reach people as a post does: a direct message's members and channels set to all; posting them again stays quiet", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, reef } = await team();
    const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
    const inDm = await julio.as.mutation(api.calls.join, { teamId, channelId: dm });
    await julio.as.mutation(api.calls.postNotes, { teamId, callId: inDm.callId, body: "Notes: ship Friday" });
    await ana.as.mutation(api.channels.setNotify, { teamId, channelId: reef, level: "all" });
    const inReef = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
    await julio.as.mutation(api.calls.postNotes, { teamId, callId: inReef.callId, body: "Notes: reef art pass" });
    await drain(t);
    expect((await ana.as.query(api.messages.addressed, { teamId })).map((a) => [a.reason, a.preview])).toEqual([
      ["all", "Notes: reef art pass"],
      ["direct", "Notes: ship Friday"],
    ]);

    // The Notetaker's second post replaces the notes without a new banner.
    await julio.as.mutation(api.calls.postNotes, { teamId, callId: inReef.callId, body: "Notes: reef art pass, with owners" });
    await drain(t);
    expect(await ana.as.query(api.messages.addressed, { teamId })).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("removing a member revokes every join they had in a call that hasn't ended, however long ago it was dropped here", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana, reef, general } = await team();
  const revoked: string[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (_room, identity) => {
      revoked.push(identity);
      return "removed";
    },
  });
  try {
    // Julio's call in #reef goes on; Ana's call in #general ended.
    const live = await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
    const ended = await ana.as.mutation(api.calls.join, { teamId, channelId: general });
    await ana.as.mutation(api.calls.leave, { teamId, participationId: ended.participationId });
    // Half an hour ago Ana's heartbeat stopped in each, so each join was dropped here; her media
    // connection to #reef's room may still be up.
    const now = Date.now();
    const [inLive, inEnded] = await t.run(async (ctx) => {
      const base = { memberId: ana.memberId, kind: "person" as const, takesNotes: false, muted: false, camera: false, screen: false };
      const old = { joinedAt: now - 40 * 60_000, lastSeenAt: now - 30 * 60_000, leftAt: now - 30 * 60_000 };
      return [
        await ctx.db.insert("callParticipations", { ...base, ...old, callId: live.callId }),
        await ctx.db.insert("callParticipations", { ...base, ...old, callId: ended.callId }),
      ];
    });

    await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
    await drain(t);

    const identity = (id: string) => `${ana.memberId}.${id}`;
    expect(revoked).toContain(identity(inLive));
    // In a call that ended, a join older than a token's life can't come back.
    expect(revoked).not.toContain(identity(inEnded));
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
});

test("a LiveKit removal that fails for a moment is tried again with backoff and a fresh revokeTokenTs, until LiveKit confirms it", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana, reef, general } = await team();
  const tries: { identity: string; before: number; at: number }[] = [];
  let reefFailures = 2;
  const identities: Record<string, string> = {};
  setLiveKitRoomsForTests({
    removeParticipant: async (_room, identity, before) => {
      tries.push({ identity, before, at: Date.now() });
      if (identity === identities["reef"] && reefFailures-- > 0) throw new Error("503 Service Unavailable");
      if (identity === identities["general"]) throw new Error("request timed out");
      return identity === identities["dm"] ? "absent" : "removed";
    },
  });
  try {
    await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
    const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
    for (const [name, channelId] of [["reef", reef], ["dm", dm], ["general", general]] as const) {
      const join = await ana.as.mutation(api.calls.join, { teamId, channelId });
      identities[name] = `${ana.memberId}.${join.participationId}`;
    }

    await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
    await drain(t);

    const of = (name: string) => tries.filter((x) => x.identity === identities[name]);
    // Two transient failures, then removed: 30 s, then 60 s between tries, each with its own time.
    const reefTries = of("reef");
    expect(reefTries).toHaveLength(3);
    expect(reefTries[1]!.at - reefTries[0]!.at).toBeGreaterThanOrEqual(30_000);
    expect(reefTries[2]!.at - reefTries[1]!.at).toBeGreaterThanOrEqual(60_000);
    expect(reefTries.every((x) => x.before === x.at)).toBe(true);
    // LiveKit said it isn't there: confirmed absent after one try.
    expect(of("dm")).toHaveLength(1);
    // Never confirmed: tried until the limit, then given up.
    expect(of("general")).toHaveLength(REVOKE_MAX_TRIES);
    const rows = await t.run((ctx) => ctx.db.query("callRevocations").collect());
    const state = (name: string) => rows.find((r) => r.identity === identities[name])!.state;
    expect([state("reef"), state("dm"), state("general")]).toEqual(["removed", "absent", "gaveUp"]);

    // How the real adapter tells "not there" from "try again".
    expect(isNotFound({ code: "not_found", status: 404 })).toBe(true);
    expect(isNotFound({ code: "unavailable", status: 503 })).toBe(false);
    expect(isNotFound(new Error("request timed out"))).toBe(false);
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
});

test("removing a member also revokes the joins that ended within a token's life, in batches, and not older ones", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana, general } = await team();
  const revoked: string[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (_room, identity) => {
      revoked.push(identity);
      return "absent";
    },
  });
  try {
    // Ana was in a call in her direct message with Julio, and left it.
    const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
    await julio.as.mutation(api.calls.join, { teamId, channelId: dm });
    const left = await ana.as.mutation(api.calls.join, { teamId, channelId: dm });
    await ana.as.mutation(api.calls.leave, { teamId, participationId: left.participationId });
    // A call in #general that has ended.
    const over = await ana.as.mutation(api.calls.join, { teamId, channelId: general });
    await ana.as.mutation(api.calls.leave, { teamId, participationId: over.participationId });
    // More short joins than one step takes, and one in the ended call that ended before a token's life.
    const now = Date.now();
    const { recent, old } = await t.run(async (ctx) => {
      const base = { callId: left.callId, memberId: ana.memberId, kind: "person" as const, takesNotes: false, muted: false, camera: false, screen: false };
      const recent = [];
      for (let i = 0; i < REVOKE_BATCH + 5; i++) {
        recent.push(await ctx.db.insert("callParticipations", { ...base, joinedAt: now - 60_000, lastSeenAt: now - 30_000, leftAt: now - 30_000 }));
      }
      const old = await ctx.db.insert("callParticipations", {
        ...base,
        callId: over.callId,
        joinedAt: now - REVOKE_WINDOW_MS - 120_000,
        lastSeenAt: now - REVOKE_WINDOW_MS - 60_000,
        leftAt: now - REVOKE_WINDOW_MS - 60_000,
      });
      return { recent, old };
    });
    vi.advanceTimersByTime(5 * 60_000);

    await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
    await drain(t);

    const identity = (id: string) => `${ana.memberId}.${id}`;
    expect(revoked).toContain(identity(left.participationId));
    expect(revoked.filter((r) => recent.map(identity).includes(r))).toHaveLength(REVOKE_BATCH + 5);
    expect(revoked).not.toContain(identity(old));
    expect(new Set(revoked).size).toBe(revoked.length);
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
});

test("leaving or being removed from a private channel takes you out of its call: LiveKit disconnects you, and you get no new token", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, julioId, ana, reef } = await team();
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const removed: { room: string; identity: string }[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (room, identity) => {
      removed.push({ room, identity });
      return "removed";
    },
  });
  try {
    const channelId = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ana.memberId, ben.memberId] });
    await julio.as.mutation(api.calls.join, { teamId, channelId });
    const anaJoin = await ana.as.mutation(api.calls.join, { teamId, channelId });
    const benJoin = await ben.as.mutation(api.calls.join, { teamId, channelId });
    // Ana is in another call too; that one isn't touched.
    const anaInReef = await ana.as.mutation(api.calls.join, { teamId, channelId: reef });

    await julio.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ana.memberId });
    await ben.as.mutation(api.channels.leave, { teamId, channelId });
    const live = await julio.as.query(api.calls.live, { teamId });
    expect(live.find((c) => c.callId === anaJoin.callId)!.participants.map((p) => p.memberId)).toEqual([julioId]);
    expect(live.find((c) => c.callId === anaInReef.callId)!.participants.map((p) => p.memberId)).toEqual([ana.memberId]);
    await drain(t);
    expect(removed.map((r) => [r.room, r.identity]).sort()).toEqual(
      [
        [`call_${anaJoin.callId}`, `${ana.memberId}.${anaJoin.participationId}`],
        [`call_${benJoin.callId}`, `${ben.memberId}.${benJoin.participationId}`],
      ].sort(),
    );
    for (const gone of [ana, ben]) {
      await expect(gone.as.mutation(api.calls.join, { teamId, channelId })).rejects.toThrow(/Not found/);
      await expect(gone.as.mutation(api.calls.heartbeat, { teamId, participationId: anaJoin.participationId })).rejects.toThrow();
    }
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
});

test("finished call revocations are deleted a week after they were queued, a batch at a time; pending and recent ones stay (#73)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, general } = await team();
    const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: general });
    const queue = (state: "pending" | "removed" | "absent" | "gaveUp", identity: string) =>
      t.run(async (ctx) => {
        await ctx.db.insert("callRevocations", { memberId: ana.memberId, callId, identity, state, tries: 1, nextAt: Date.now() });
      });
    // More finished ones than one step deletes, from eight days ago, and one still pending.
    await t.run(async (ctx) => {
      for (let i = 0; i < REVOCATIONS_PRUNE_BATCH + 20; i++) {
        const state = (["removed", "absent", "gaveUp"] as const)[i % 3]!;
        await ctx.db.insert("callRevocations", { memberId: ana.memberId, callId, identity: `old.${i}`, state, tries: 1, nextAt: Date.now() });
      }
    });
    await queue("pending", "old.pending");
    vi.advanceTimersByTime(8 * DAY);
    await queue("removed", "new.removed");
    await queue("gaveUp", "new.gaveUp");
    await queue("pending", "new.pending");

    await t.mutation(internal.calls.pruneRevocations, {});
    expect(await t.run(async (ctx) => (await ctx.db.query("callRevocations").collect()).length)).toBe(20 + 4);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => (await ctx.db.query("callRevocations").collect()).map((r) => r.identity));
    expect(left.sort()).toEqual(["new.gaveUp", "new.pending", "new.removed", "old.pending"]);
  } finally {
    vi.useRealTimers();
  }
});

test("leaving a private channel revokes every join past one batch: a newer live join, and recent ones behind others (P6)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana, general } = await team();
  const removed: string[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (_room, identity) => {
      removed.push(identity);
      return "removed";
    },
  });
  try {
    const channelId = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ana.memberId] });
    // An ended call in #launch that Ana left a minute ago, behind 60 joins elsewhere that ended earlier.
    const { callId: earlier, participationId: earlierJoin } = await ana.as.mutation(api.calls.join, { teamId, channelId });
    await ana.as.mutation(api.calls.leave, { teamId, participationId: earlierJoin });
    const { callId: elsewhere } = await julio.as.mutation(api.calls.join, { teamId, channelId: general });
    const now = Date.now();
    const join = (callId: Id<"calls">, leftAt?: number) =>
      t.run((ctx) =>
        ctx.db.insert("callParticipations", {
          callId, memberId: ana.memberId, kind: "person", takesNotes: false, joinedAt: now - 120_000, lastSeenAt: now,
          ...(leftAt !== undefined ? { leftAt } : {}), muted: false, camera: false, screen: false,
        }),
      );
    for (let i = 0; i < 60; i++) await join(elsewhere, now - 120_000 + i);
    await t.run((ctx) => ctx.db.patch(earlierJoin, { leftAt: now - 30_000 }));
    expect((await julio.as.query(api.calls.get, { teamId, callId: earlier })).endedAt).toEqual(expect.any(Number));

    // The live call in #launch: 200 old joins of Ana's from before, then her live one.
    await julio.as.mutation(api.calls.join, { teamId, channelId });
    const live = (await julio.as.query(api.calls.live, { teamId })).find((c) => c.channelId === channelId)!.callId;
    for (let i = 0; i < 200; i++) await join(live, now - 3 * 60 * 60 * 1000);
    const { participationId: liveJoin } = await ana.as.mutation(api.calls.join, { teamId, channelId });

    await ana.as.mutation(api.channels.leave, { teamId, channelId });
    await drain(t);
    // Her live join ended, though 200 others came before it in the call.
    expect((await t.run((ctx) => ctx.db.get(liveJoin)))!.leftAt).toEqual(expect.any(Number));
    expect(removed).toContain(`${ana.memberId}.${liveJoin}`);
    expect(removed).toContain(`${ana.memberId}.${earlierJoin}`);
    // Her joins elsewhere are left alone.
    expect(removed.filter((identity) => identity.startsWith(`${ana.memberId}.`)).length).toBe(202);
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
}, 60_000);

test("a removal still being swept leaves alone the join of someone added back in the meantime (M4)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana } = await team();
  const removed: string[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (_room, identity) => {
      removed.push(identity);
      return "removed";
    },
  });
  try {
    const channelId = await julio.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ana.memberId] });
    await julio.as.mutation(api.calls.join, { teamId, channelId });
    const { callId } = await ana.as.mutation(api.calls.join, { teamId, channelId });
    // More of Ana's joins than one step takes, so the sweep goes on in a later step.
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("callParticipations", {
          callId, memberId: ana.memberId, kind: "person", takesNotes: false, joinedAt: Date.now(), lastSeenAt: Date.now(),
          leftAt: Date.now() - 3 * 60 * 60 * 1000, muted: false, camera: false, screen: false,
        });
      }
    });
    await julio.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: ana.memberId });
    // Before the sweep's next step runs (the clock stays still, so it hasn't started), Ana is
    // added back and joins again.
    expect((await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).some((f) => f.name.includes("revokeChannelJoins") && f.state.kind === "pending")).toBe(true);
    await julio.as.mutation(api.channels.addMembers, { teamId, channelId, memberIds: [ana.memberId] });
    const { participationId: again } = await ana.as.mutation(api.calls.join, { teamId, channelId });
    // The sweep's remaining steps run now (they are due at once); the clock doesn't move.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(0);
      await t.finishInProgressScheduledFunctions();
    }
    expect((await t.run((ctx) => ctx.db.get(again)))!.leftAt).toBeUndefined();
    const queued = await t.run((ctx) => ctx.db.query("callRevocations").collect());
    expect(queued.map((r) => r.identity)).not.toContain(`${ana.memberId}.${again}`);
    await drain(t);
    expect(removed).not.toContain(`${ana.memberId}.${again}`);
    expect(removed.filter((identity) => identity.startsWith(`${ana.memberId}.`)).length).toBe(61);
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
}, 60_000);

test("removing a member from the team revokes every join in a call that hasn't ended, past 200 in one call (M5)", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z") });
  const { t, teamId, julio, ana, general } = await team();
  const removed: string[] = [];
  setLiveKitRoomsForTests({
    removeParticipant: async (_room, identity) => {
      removed.push(identity);
      return "removed";
    },
  });
  try {
    const { callId } = await julio.as.mutation(api.calls.join, { teamId, channelId: general });
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert("callParticipations", {
          callId, memberId: ana.memberId, kind: "person", takesNotes: false, joinedAt: Date.now(), lastSeenAt: Date.now(),
          leftAt: Date.now() - 3 * 60 * 60 * 1000, muted: false, camera: false, screen: false,
        });
      }
    });
    await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
    await drain(t);
    expect(removed.filter((identity) => identity.startsWith(`${ana.memberId}.`)).length).toBe(230);
  } finally {
    setLiveKitRoomsForTests(undefined);
    vi.useRealTimers();
  }
}, 60_000);

test("narrowing an agent's key to other channels takes it out of the calls it is in (ADR 0049)", async () => {
  const { t, teamId, julio, general, reef } = await team();
  const { agentId, key } = await notetaker(t, teamId, julio);
  await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  expect(await callAsAgent(t, key, "calls.join", { channelId: reef })).toMatchObject({ ok: true });
  const keyId = (await julio.as.query(api.agents.keys, { teamId, agentId }))[0]!.keyId;

  await julio.as.mutation(api.agents.setKeyChannels, { teamId, keyId, channelIds: [general] });

  const [live] = await julio.as.query(api.calls.live, { teamId });
  expect(live!.participants.map((p) => p.name)).toEqual(["Julio"]);
  expect(await callAsAgent(t, key, "calls.join", { channelId: reef })).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("revoking an agent's key, or taking calls.join from it, takes it out of the calls it is in", async () => {
  const { t, teamId, julio, reef } = await team();
  const { agentId, key } = await notetaker(t, teamId, julio);
  await julio.as.mutation(api.calls.join, { teamId, channelId: reef });
  const keyId = (await julio.as.query(api.agents.keys, { teamId, agentId }))[0]!.keyId;
  const inCall = async () => ((await julio.as.query(api.calls.live, { teamId }))[0]?.participants ?? []).map((p) => p.name).sort();

  expect(await callAsAgent(t, key, "calls.join", { channelId: reef })).toMatchObject({ ok: true });
  await julio.as.mutation(api.agents.setKeyScopes, { teamId, keyId, scopes: ["room.read", "messages.post"] });
  expect(await inCall()).toEqual(["Julio"]);

  await julio.as.mutation(api.agents.setKeyScopes, { teamId, keyId, scopes: ["room.read", "messages.post", "calls.join"] });
  expect(await callAsAgent(t, key, "calls.join", { channelId: reef })).toMatchObject({ ok: true });
  expect(await inCall()).toEqual(["Julio", "Notetaker"]);
  await julio.as.mutation(api.agents.revokeKey, { teamId, keyId });
  expect(await inCall()).toEqual(["Julio"]);
});
