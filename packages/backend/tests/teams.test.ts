import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addAgent, newRoom, newTeam } from "./setup";

test("whoever creates a team is its admin, and the team starts with #general", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);

  const members = await admin.as.query(api.teams.members, { teamId });
  expect(members).toMatchObject([{ name: "Julio", kind: "person", role: "admin" }]);

  const channels = await admin.as.query(api.channels.list, { teamId });
  expect(channels.map((c) => c.name)).toEqual(["general"]);
});

test("the member list carries an agent's id, so its keys can be listed for agents added elsewhere", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { agentId } = await addAgent(t, teamId, admin, "Hermes");

  const members = await admin.as.query(api.teams.members, { teamId });

  expect(members.find((m) => m.name === "Hermes")).toMatchObject({ kind: "agent", agentId });
  expect(members.find((m) => m.name === "Julio")?.agentId).toBeUndefined();
  const keys = await admin.as.query(api.agents.keys, { teamId, agentId });
  expect(keys).toHaveLength(1);
});
