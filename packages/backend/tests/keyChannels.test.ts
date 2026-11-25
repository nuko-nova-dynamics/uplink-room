/** ADR 0049: an agent key limited to some channels sees only them, and the tasks of their projects. */
import { expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { addAgent, callAsAgent, linkMachine, newRoom, newTeam } from "./setup";

test("a key limited to one channel reads and posts only there, and sees only that channel's project tasks", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const billing = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });
  const payroll = await admin.as.mutation(api.projects.create, { teamId, name: "Payroll", repos: [] });
  const projects = await admin.as.query(api.projects.list, { teamId });
  const billingChannel = projects.find((p) => p.projectId === billing)!.channelId;
  const payrollChannel = projects.find((p) => p.projectId === payroll)!.channelId;
  const billingTask = await admin.as.mutation(api.tasks.create, { teamId, projectId: billing, title: "Fix invoice totals" });
  const payrollTask = await admin.as.mutation(api.tasks.create, { teamId, projectId: payroll, title: "Run payroll" });
  await admin.as.mutation(api.tasks.create, { teamId, title: "Plan the offsite" });

  const { agentId, key } = await addAgent(t, teamId, admin, "Fixer", ["room.read", "messages.post", "work.manage"]);
  const keyId = (await admin.as.query(api.agents.keys, { teamId, agentId }))[0]!.keyId;
  await admin.as.mutation(api.agents.setKeyChannels, { teamId, keyId, channelIds: [billingChannel] });

  expect((await callAsAgent(t, key, "messages.post", { channelId: billingChannel, body: "on it" })).ok).toBe(true);
  const elsewhere = await callAsAgent(t, key, "messages.post", { channelId: payrollChannel, body: "hello" });
  expect(elsewhere.error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "messages.list", { channelId: payrollChannel })).error?.code).toBe("not_found");
  const listed = (await callAsAgent(t, key, "channels.list")).result as { channelId: string }[];
  expect(listed.map((c) => c.channelId)).toEqual([billingChannel]);

  // Tasks: only the billing project's, and none in no project unless the agent made it.
  const board = (await callAsAgent(t, key, "tasks.board")).result as { taskId: string }[];
  expect(board.map((c) => c.taskId)).toEqual([billingTask]);
  expect((await callAsAgent(t, key, "tasks.get", { taskId: payrollTask })).error?.code).toBe("not_found");
  const own = (await callAsAgent(t, key, "tasks.create", { title: "Notes from the fix" })).result as string;
  expect(((await callAsAgent(t, key, "tasks.board")).result as { taskId: string }[]).map((c) => c.taskId)).toEqual([billingTask, own]);

  const me = (await callAsAgent(t, key, "members.me")).result as { channelIds?: string[] };
  expect(me.channelIds).toEqual([billingChannel]);

  // Lifting the limit gives back every channel the person can see.
  await admin.as.mutation(api.agents.setKeyChannels, { teamId, keyId, channelIds: null });
  expect((await callAsAgent(t, key, "messages.post", { channelId: payrollChannel, body: "hello" })).ok).toBe(true);
});

test("a channel-limited key doesn't see runs, or their terminals, on tasks outside its channels", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const billing = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });
  const payroll = await admin.as.mutation(api.projects.create, { teamId, name: "Payroll", repos: [] });
  const billingChannel = (await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === billing)!.channelId;
  const payrollTask = await admin.as.mutation(api.tasks.create, { teamId, projectId: payroll, title: "Run payroll" });
  const billingTask = await admin.as.mutation(api.tasks.create, { teamId, projectId: billing, title: "Fix totals" });
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const hidden = await admin.as.mutation(api.runs.start, { teamId, taskId: payrollTask, harness: "claude-code", machineId });
  const seen = await admin.as.mutation(api.runs.start, { teamId, taskId: billingTask, harness: "claude-code", machineId });

  const { agentId, key } = await addAgent(t, teamId, admin, "Fixer", ["room.read", "messages.post"]);
  const keyId = (await admin.as.query(api.agents.keys, { teamId, agentId }))[0]!.keyId;
  await admin.as.mutation(api.agents.setKeyChannels, { teamId, keyId, channelIds: [billingChannel] });

  const live = (await callAsAgent(t, key, "runs.live")).result as { runId: string }[];
  expect(live.map((r) => r.runId)).toEqual([seen.runId]);
  expect((await callAsAgent(t, key, "runs.get", { runId: hidden.runId })).error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "terminals.read", { terminalId: hidden.terminalId })).error?.code).toBe("not_found");
  const terminals = (await callAsAgent(t, key, "terminals.list")).result as { terminalId: string }[];
  expect(terminals.map((x) => x.terminalId)).toEqual([seen.terminalId]);
  // Following a run it can't see by name tells it nothing, not even when the run last changed.
  expect((await callAsAgent(t, key, "runs.changes", { runIds: [hidden.runId] })).result).toEqual({ changes: [], cursor: 0, more: false });
});

test("an agent's file link that records no key, from before links did, serves nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const [general] = await admin.as.query(api.channels.list, { teamId });
  const { key } = await addAgent(t, teamId, admin, "Reader", ["room.read", "messages.post"]);
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["hello"], { type: "text/plain" })));
  const agentMember = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Reader")!.memberId;
  const tokenHash = await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", { teamId, channelId: general!.channelId, authorId: agentMember, format: "markdown", body: "file", mentionedTasks: [], mentionedRuns: [] });
    const attachmentId = await ctx.db.insert("attachments", { teamId, channelId: general!.channelId, messageId, position: 0, storageId, name: "a.txt", kind: "file", contentType: "text/plain", size: 5, token: "t" });
    await ctx.db.insert("attachmentGrants", { attachmentId, memberId: agentMember, tokenHash: "old", download: true, expiresAt: Date.now() + 60_000 });
    return "old";
  });
  expect(key).toBeTruthy();
  expect(await t.query(internal.messages.attachmentGrant, { tokenHash })).toMatchObject({ allowed: false });
});

test("a channel-limited key reaches only the files, and their comments, of its channels' projects", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const billing = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });
  const payroll = await admin.as.mutation(api.projects.create, { teamId, name: "Payroll", repos: [] });
  const billingChannel = (await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === billing)!.channelId;
  const seenDoc = await admin.as.mutation(api.files.save, { teamId, projectId: billing, name: "totals.md", content: "# Totals" });
  const hiddenDoc = await admin.as.mutation(api.files.save, { teamId, projectId: payroll, name: "salaries.md", content: "# Salaries" });
  const hiddenComment = await admin.as.mutation(api.comments.add, { teamId, fileId: hiddenDoc, body: "Check row 3", pin: { kind: "file" } });

  const { agentId, key } = await addAgent(t, teamId, admin, "Fixer", ["room.read", "messages.post", "work.manage"]);
  const keyId = (await admin.as.query(api.agents.keys, { teamId, agentId }))[0]!.keyId;
  // The agent learned the payroll IDs before its key was narrowed.
  expect((await callAsAgent(t, key, "files.get", { fileId: hiddenDoc })).ok).toBe(true);
  await admin.as.mutation(api.agents.setKeyChannels, { teamId, keyId, channelIds: [billingChannel] });

  expect((await callAsAgent(t, key, "files.get", { fileId: seenDoc })).ok).toBe(true);
  expect((await callAsAgent(t, key, "files.get", { fileId: hiddenDoc })).error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "files.edit", { fileId: hiddenDoc, content: "# Changed", baseVersion: 1 })).error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "comments.list", { fileId: hiddenDoc })).error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "comments.reply", { commentId: hiddenComment, body: "Done" })).error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "comments.resolve", { commentId: hiddenComment })).error?.code).toBe("not_found");
  expect((await callAsAgent(t, key, "comments.add", { fileId: seenDoc, body: "Looks right", pin: { kind: "file" } })).ok).toBe(true);
});

test("an agent's file link stops working once its key loses room.read", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const [general] = await admin.as.query(api.channels.list, { teamId });
  const { agentId } = await addAgent(t, teamId, admin, "Reader", ["room.read", "messages.post"]);
  const keyId = (await admin.as.query(api.agents.keys, { teamId, agentId }))[0]!.keyId;
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["hello"], { type: "text/plain" })));
  const agentMember = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Reader")!.memberId;
  const tokenHash = await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", { teamId, channelId: general!.channelId, authorId: agentMember, format: "markdown", body: "file", mentionedTasks: [], mentionedRuns: [] });
    const attachmentId = await ctx.db.insert("attachments", { teamId, channelId: general!.channelId, messageId, position: 0, storageId, name: "a.txt", kind: "file", contentType: "text/plain", size: 5, token: "t" });
    await ctx.db.insert("attachmentGrants", { attachmentId, memberId: agentMember, agentKeyId: keyId, tokenHash: "h", download: true, expiresAt: Date.now() + 60_000 });
    return "h";
  });
  expect(await t.query(internal.messages.attachmentGrant, { tokenHash })).toMatchObject({ allowed: true });
  await admin.as.mutation(api.agents.setKeyScopes, { teamId, keyId, scopes: ["messages.post"] });
  expect(await t.query(internal.messages.attachmentGrant, { tokenHash })).toMatchObject({ allowed: false });
});
