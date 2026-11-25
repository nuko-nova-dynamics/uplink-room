import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addAgent, callAsAgent, listed, newRoom, newTeam } from "./setup";

test("a message posted with an agent key shows the agent as its author and who added it", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Deploy bot");
  const [general] = await admin.as.query(api.channels.list, { teamId });

  const posted = await callAsAgent(t, key, "messages.post", {
    channelId: general!.channelId,
    body: "Deployed **0.4.2**",
  });
  expect(posted).toMatchObject({ status: 200, ok: true });

  const messages = listed(await admin.as.query(api.messages.list, { teamId, channelId: general!.channelId }));
  expect(messages).toMatchObject([
    {
      body: "Deployed **0.4.2**",
      author: { name: "Deploy bot", kind: "agent", addedBy: { name: "Julio" } },
    },
  ]);
});

test("an agent holds at most 50 unrevoked keys; revoking one makes room for another", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { agentId } = await addAgent(t, teamId, admin, "Deploy bot");
  for (let i = 1; i < 50; i++) await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: `key ${i}` });
  await expect(admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "one too many" })).rejects.toThrow(
    "Deploy bot already has 50 keys. Revoke an old key before creating another.",
  );
  const [oldest] = await admin.as.query(api.agents.keys, { teamId, agentId });
  await admin.as.mutation(api.agents.revokeKey, { teamId, keyId: oldest!.keyId });
  expect(await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "replacement" })).toMatchObject({ scopes: expect.any(Array) });
});

test("an agent's key list has its keys in use and only its most recently revoked ones, however many it revoked", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { agentId } = await addAgent(t, teamId, admin, "Deploy bot");
  const [first] = await admin.as.query(api.agents.keys, { teamId, agentId });
  for (let i = 1; i <= 120; i++) {
    const { keyId } = await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: `old ${i}` });
    await admin.as.mutation(api.agents.revokeKey, { teamId, keyId });
  }
  await admin.as.mutation(api.agents.createKey, { teamId, agentId, name: "in use" });

  const keys = await admin.as.query(api.agents.keys, { teamId, agentId });
  const revokedLast = Array.from({ length: 20 }, (_, i) => `old ${101 + i}`);
  expect(keys.map((k) => k.name)).toEqual([first!.name, ...revokedLast, "in use"]);
  expect(keys.filter((k) => k.revokedAt === undefined).map((k) => k.name)).toEqual([first!.name, "in use"]);
});
