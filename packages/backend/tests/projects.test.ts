import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { listed, newRoom, newTeam } from "./setup";

test("a project gets its own channel next to its board, and lists its repos", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);

  const projectId = await admin.as.mutation(api.projects.create, {
    teamId,
    name: "Billing",
    repos: ["github.com/nuko/billing"],
  });

  const [project] = await admin.as.query(api.projects.list, { teamId });
  expect(project).toMatchObject({ projectId, name: "Billing", repos: ["github.com/nuko/billing"] });
  const channels = await admin.as.query(api.channels.list, { teamId });
  expect(channels).toContainEqual(
    expect.objectContaining({ channelId: project!.channelId, name: "billing", projectId }),
  );
});

test("archiving a project keeps its channel history", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: [] });
  const [project] = await admin.as.query(api.projects.list, { teamId });
  await admin.as.mutation(api.messages.post, { teamId, channelId: project!.channelId, body: "Kickoff notes" });

  await admin.as.mutation(api.projects.rename, { teamId, projectId, name: "Payments" });
  await admin.as.mutation(api.projects.archive, { teamId, projectId });

  expect(await admin.as.query(api.projects.list, { teamId })).toEqual([]);
  const history = listed(await admin.as.query(api.messages.list, { teamId, channelId: project!.channelId }));
  expect(history.map((m) => m.body)).toEqual(["Kickoff notes"]);
});
