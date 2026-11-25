/** Idempotency keys: a retried write lands once (lib/idempotency.ts). */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addAgent, callAsAgent, listed, newRoom, newTeam } from "./setup";

test("a write retried with the same idempotency key lands once; the key with other arguments is refused", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const [general] = await admin.as.query(api.channels.list, { teamId });
  const channelId = general!.channelId;
  const { key } = await addAgent(t, teamId, admin, "Reporter", ["room.read", "messages.post", "work.manage"]);

  const first = await callAsAgent(t, key, "messages.post", { channelId, body: "deploy is green", idempotencyKey: "k1" });
  const retry = await callAsAgent(t, key, "messages.post", { channelId, body: "deploy is green", idempotencyKey: "k1" });
  expect(retry.result).toBe(first.result);
  expect(listed(await admin.as.query(api.messages.list, { teamId, channelId })).filter((m) => m.body === "deploy is green")).toHaveLength(1);

  const other = await callAsAgent(t, key, "messages.post", { channelId, body: "deploy is red", idempotencyKey: "k1" });
  expect(other.error?.code).toBe("conflict");

  // The same key for another function is another write; each person's keys are their own.
  const task = await callAsAgent(t, key, "tasks.create", { title: "Check the deploy", idempotencyKey: "k1" });
  const taskAgain = await callAsAgent(t, key, "tasks.create", { title: "Check the deploy", idempotencyKey: "k1" });
  expect(taskAgain.result).toBe(task.result);
  expect((await admin.as.query(api.tasks.board, { teamId })).filter((c) => c.title === "Check the deploy")).toHaveLength(1);
  const mine = await admin.as.mutation(api.messages.post, { teamId, channelId, body: "deploy is green", idempotencyKey: "k1" });
  expect(mine).not.toBe(first.result);
});
