import { expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CLIENT_ID, fakeClerk } from "./fakeClerk";
import { addAgent, addTeammate, bridgeSays, callAsAgent, linkMachine, newRoom, newTeam, signIn, signInFromCli } from "./setup";

test("a person's CLI sign-in reaches only the teams they're in, and another person's sign-ins not at all", async () => {
  const clerk = await fakeClerk();
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", clerk.issuer);
  vi.stubEnv("CLERK_CLI_CLIENT_ID", CLIENT_ID);
  vi.stubGlobal("fetch", clerk.fetch);
  try {
    const t = newRoom();
    const { teamId } = await newTeam(t, "Julio");
    const pepe = await newTeam(t, "Pepe");
    const token = await signInFromCli(t, clerk, { subject: "user_Pepe", name: "Pepe", email: "pepe@example.com" });
    const julioToken = await signInFromCli(t, clerk, { subject: "user_Julio", name: "Julio", email: "julio@example.com" });
    const [julioSignIn] = (await callAsAgent(t, julioToken, "people.signIns")).result;

    expect(await callAsAgent(t, token, "channels.list", { teamId: pepe.teamId })).toMatchObject({ ok: true });
    const refused = await callAsAgent(t, token, "channels.list", { teamId });
    expect(refused).toMatchObject({ status: 403, error: { code: "forbidden", message: "You are not a member of this team." } });
    await expect(t.query(api.live.query, { key: token, fn: "channels.list", args: { teamId } })).rejects.toThrow(/not a member/);
    expect(await callAsAgent(t, token, "people.revokeSignIn", { signInId: julioSignIn.signInId })).toMatchObject({ status: 404, error: { code: "not_found" } });
    expect(await callAsAgent(t, julioToken, "people.me")).toMatchObject({ ok: true });
    // A made-up token in the sign-in format is refused like a revoked one.
    expect(await callAsAgent(t, `urs_${"0".repeat(48)}`, "people.me")).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

test("an agent key without the invite scope can't invite people", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Notetaker");

  const result = await callAsAgent(t, key, "invites.create", { email: "sam@example.com" });

  expect(result).toMatchObject({ status: 403, ok: false, error: { code: "forbidden" } });
  expect(result.error!.message).toMatch(/people.invite/);
});

test("an agent can't be given more rights than the person who added it", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  await addAgent(t, teamId, ana, "Ana's helper", ["room.read", "machines.manage"]);
  const helper = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Ana's helper")!;

  await expect(
    admin.as.mutation(api.members.setRole, { teamId, memberId: helper.memberId, role: "admin" }),
  ).rejects.toThrow(/more than Ana/);
});

test("only admins make people admins", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const sam = await addTeammate(t, teamId, admin, "Sam");

  await expect(ana.as.mutation(api.members.setRole, { teamId, memberId: sam.memberId, role: "admin" })).rejects.toThrow(/admin/i);
  await admin.as.mutation(api.members.setRole, { teamId, memberId: ana.memberId, role: "admin" });
  expect((await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Ana")).toMatchObject({ role: "admin" });
});

test("an admin agent can change a team machine's settings, and the log names its person", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId } = await linkMachine(t, teamId, admin, "team-box", { team: true });
  const { key } = await addAgent(t, teamId, admin, "Setup agent", ["room.read", "machines.manage"]);
  const agent = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Setup agent")!;
  await admin.as.mutation(api.members.setRole, { teamId, memberId: agent.memberId, role: "admin" });

  const changed = await callAsAgent(t, key, "machines.updateSettings", { machineId, slots: 1 });

  expect(changed).toMatchObject({ ok: true });
  const [entry] = await admin.as.query(api.activity.list, { teamId, target: machineId });
  expect(entry).toMatchObject({ action: "machine.settings_changed", actor: { name: "Setup agent", kind: "agent" }, accountable: { name: "Julio" } });
});

test("a revoked key fails on its next call", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { agentId, key } = await addAgent(t, teamId, admin, "Deploy bot");
  expect((await callAsAgent(t, key, "channels.list")).ok).toBe(true);
  const [keyRow] = await admin.as.query(api.agents.keys, { teamId, agentId });

  await admin.as.mutation(api.agents.revokeKey, { teamId, keyId: keyRow!.keyId });

  expect(await callAsAgent(t, key, "channels.list")).toMatchObject({ status: 401, ok: false });
});

test("an agent answers an approval only with the scope, and only what its person could answer", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, ana, "ana-laptop");
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Ship it" });
  const { runId, terminalId } = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "terminal", terminalId },
    state: "waiting",
    prompt: { kind: "approval", text: "Deploy?", action: "deploy 0.4.2", hardToUndo: true },
  });
  const plain = await addAgent(t, teamId, ana, "Plain helper", ["room.read"]);
  const chief = await addAgent(t, teamId, ana, "Chief of staff", ["room.read", "approvals.answer"]);
  const sams = await addAgent(t, teamId, await addTeammate(t, teamId, julio, "Sam"), "Sam's chief", ["room.read", "approvals.answer"]);

  expect(await callAsAgent(t, plain.key, "inbox.answer", { runId, answer: "allow", promptId: "" })).toMatchObject({ status: 403 });
  expect(await callAsAgent(t, sams.key, "inbox.answer", { runId, answer: "allow", promptId: "" })).toMatchObject({ status: 403 });
  expect(await callAsAgent(t, chief.key, "inbox.answer", { runId, answer: "allow", promptId: "" })).toMatchObject({ ok: true });

  const run = await ana.as.query(api.runs.get, { teamId, runId });
  expect(run.lastAnswer).toMatchObject({ answer: "allow", action: "deploy 0.4.2", by: { name: "Chief of staff", addedBy: { name: "Ana" } } });
});

test("a bridge can't put a member of another team into this team's activity log", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { token } = await linkMachine(t, teamId, julio, "julio-mbp");
  const bea = await signIn(t, "Bea");
  const otherTeam = await bea.as.mutation(api.teams.create, { name: "Elsewhere" });
  const [beaMember] = await bea.as.query(api.teams.members, { teamId: otherTeam });

  await bridgeSays(t, token, { type: "input_rejected", terminalId: "pty-1", memberId: beaMember!.memberId, reason: "not_driver" });

  const log = await julio.as.query(api.activity.list, { teamId });
  expect(log.find((e) => e.action === "terminal.input_rejected_by_bridge")).toMatchObject({ actor: { name: "Julio" } });
  expect(JSON.stringify(log)).not.toContain("Bea");
});

test("every change an agent makes is in the activity log with the agent and its person, once", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const { key } = await addAgent(t, teamId, admin, "Chief of staff", ["room.read", "work.manage"]);
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Plan Q1" });

  expect(await callAsAgent(t, key, "tasks.update", { taskId, title: "Plan Q1 and Q2" })).toMatchObject({ ok: true });
  expect(await callAsAgent(t, key, "tasks.update", { taskId, ownerId: ana.memberId })).toMatchObject({ ok: true });

  const log = await admin.as.query(api.activity.list, { teamId, target: taskId });
  expect(log.map((e) => e.action)).toEqual(["task.owner_changed", "api.tasks.update"]);
  for (const entry of log) {
    expect(entry).toMatchObject({ actor: { name: "Chief of staff", kind: "agent" }, accountable: { name: "Julio" } });
  }
});

test("an agent outside a direct message with a run gets not_found for it, and can't read the run's inbox texts", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId } = await linkMachine(t, teamId, ana, "ana-mbp");
  const { runId } = await ana.as.mutation(api.runs.start, { teamId, harness: "claude-code", machineId });
  // A run from Julio and Ana's direct message, so it may hear a direct message they're both in (ADR 0039).
  const theirs = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  await t.run((ctx) => ctx.db.patch(runId as Id<"runs">, { directChannelId: theirs }));
  const channelId = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [], runIds: [runId] })).channelId;
  await julio.as.mutation(api.messages.post, { teamId, channelId, body: "the deploy key is in the vault" });
  const { key } = await addAgent(t, teamId, julio, "Scout", ["room.read", "messages.post"]);

  expect(await callAsAgent(t, key, "messages.list", { channelId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(await callAsAgent(t, key, "messages.post", { channelId, body: "hi" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  const inbox = await callAsAgent(t, key, "runs.inbox", { runId });
  expect(inbox.result).toMatchObject({ runId, waiting: 1 });
  expect(inbox.result.messages).toBeUndefined();
  expect(JSON.stringify(inbox.result)).not.toContain("vault");
});
