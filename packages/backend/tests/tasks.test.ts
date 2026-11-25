import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addAgent, callAsAgent, newRoom, newTeam } from "./setup";

test("a task can be written down before its first run, owned by whoever created it", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });

  const taskId = await admin.as.mutation(api.tasks.create, { teamId, projectId, title: "Fix invoice totals" });

  const board = await admin.as.query(api.tasks.board, { teamId, projectId });
  expect(board).toMatchObject([
    { taskId, title: "Fix invoice totals", state: "not_started", column: "not_started", owner: { name: "Julio" }, runs: [] },
  ]);
});

test("a task can't be given an agent as owner", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { agentId } = await addAgent(t, teamId, admin, "Hermes");
  const members = await admin.as.query(api.teams.members, { teamId });
  const hermes = members.find((m) => m.name === "Hermes")!;

  await expect(
    admin.as.mutation(api.tasks.create, { teamId, title: "Plan Q1", ownerId: hermes.memberId }),
  ).rejects.toThrow(/owner must be a person/i);
  expect(agentId).toBeDefined();
});

test("a task an agent creates is owned by the person accountable for the agent", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Chief of staff", ["room.read", "work.manage"]);

  const created = await callAsAgent(t, key, "tasks.create", { title: "Triage inbox" });
  expect(created.ok).toBe(true);

  const [task] = await admin.as.query(api.tasks.board, { teamId });
  expect(task).toMatchObject({ title: "Triage inbox", owner: { name: "Julio", kind: "person" } });
});
