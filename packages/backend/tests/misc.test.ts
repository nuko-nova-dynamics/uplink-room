import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addAgent, bridgeInbox, bridgeSays, linkMachine, newRoom, newTeam } from "./setup";

test("whoever a machine belongs to stops sharing every terminal on it with one action", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Demo" });
  await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId });

  await admin.as.mutation(api.machines.stopSharing, { teamId, machineId });

  expect(await bridgeInbox(t, token)).toContainEqual({ v: 1, type: "stop_sharing" });
  expect(await admin.as.query(api.terminals.list, { teamId })).toEqual([]);
  await expect(admin.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId })).rejects.toThrow(/sharing is stopped/i);
});

test("a task's owner keeps one run, which closes the task", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { machineId } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Pick a logo" });
  const a = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId });
  await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });

  await admin.as.mutation(api.tasks.keepRun, { teamId, taskId, runId: a.runId });

  expect(await admin.as.query(api.tasks.get, { teamId, taskId })).toMatchObject({ keptRunId: a.runId, closedAt: expect.any(Number) });
  expect(await admin.as.query(api.tasks.board, { teamId })).toEqual([]);
});

test("Markdown and HTML files in a project are kept as text to render like messages", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });

  await admin.as.mutation(api.files.save, { teamId, projectId, name: "plan.md", content: "# Plan" });
  await admin.as.mutation(api.files.save, { teamId, projectId, name: "chart.html", content: "<h1>Chart</h1>" });

  const files = await admin.as.query(api.files.list, { teamId, projectId });
  expect(files).toMatchObject([
    { name: "chart.html", format: "html" },
    { name: "plan.md", format: "markdown" },
  ]);
  expect(await admin.as.query(api.files.get, { teamId, fileId: files[1]!.fileId })).toMatchObject({ content: "# Plan" });
});

test("the roster shows each agent with the most urgent state among its runs, or idle", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  await addAgent(t, teamId, admin, "Notetaker");
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Fix it" });
  const { terminalId } = await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId });
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "terminal", terminalId }, state: "waiting", prompt: { kind: "question", text: "Which?" } });

  const roster = await admin.as.query(api.teams.roster, { teamId });
  expect(roster).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "agent", name: "Notetaker", state: "idle" }),
      expect.objectContaining({ kind: "harness", name: "codex", state: "waiting" }),
    ]),
  );
});
