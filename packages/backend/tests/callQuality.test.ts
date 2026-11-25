/**
 * Call quality (issue #87, ADR 0017): a channel's voice quality through the Room API, who may
 * change it, and the team's limit on it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { cameraAllowed, effectiveCamera, effectiveShare, effectiveVoice, shareAllowed, voiceAllowed } from "../convex/lib/callQuality";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam } from "./setup";

const LIVEKIT = { LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" };
beforeEach(() => {
  for (const [key, value] of Object.entries(LIVEKIT)) process.env[key] = value;
});
afterEach(() => {
  for (const key of Object.keys(LIVEKIT)) delete process.env[key];
});

/** Julio (admin) and Ana, #general, Ana's private #launch with Ben, and Ana and Ben's direct message. */
async function team() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const general = (await julio.as.query(api.channels.list, { teamId })).find((c) => c.name === "general")!.channelId;
  const launch = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [ben.memberId] });
  const dm = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [ben.memberId] })).channelId;
  return { t, teamId, julio, ana, ben, general, launch, dm };
}

const row = async (who: { as: { query: Function } }, teamId: string, channelId: string) =>
  ((await who.as.query(api.channels.list, { teamId })) as { channelId: string; callQuality: string; callQualityChosen: string }[]).find(
    (c) => c.channelId === channelId,
  );

test("a channel's calls start at standard; in a team channel only admins change it, live for everyone", async () => {
  const { teamId, julio, ana, general } = await team();
  expect(await row(ana, teamId, general)).toMatchObject({ callQuality: "standard", callQualityChosen: "standard" });
  expect(await julio.as.query(api.teams.settings, { teamId })).toMatchObject({ callQualityLimit: "none" });

  await expect(ana.as.mutation(api.channels.setCallQuality, { teamId, channelId: general, quality: "music" })).rejects.toThrow(
    /Only admins can change a team channel's call quality/,
  );
  await julio.as.mutation(api.channels.setCallQuality, { teamId, channelId: general, quality: "music" });
  expect(await row(ana, teamId, general)).toMatchObject({ callQuality: "music", callQualityChosen: "music" });

  // Joining tells the app (or an agent's LiveKit client) what to publish its microphone with.
  const joined = await ana.as.mutation(api.calls.join, { teamId, channelId: general });
  expect(joined.callQuality).toBe("music");
  const activity = await julio.as.query(api.activity.list, { limit: 10, teamId });
  expect(activity.map((e) => e.action)).toContain("channel.call_quality");
});

test("in a private channel or a direct message any member changes it, and nobody outside can", async () => {
  const { teamId, julio, ana, ben, launch, dm } = await team();
  await ben.as.mutation(api.channels.setCallQuality, { teamId, channelId: launch, quality: "high" });
  expect(await row(ana, teamId, launch)).toMatchObject({ callQuality: "high" });
  await ana.as.mutation(api.channels.setCallQuality, { teamId, channelId: dm, quality: "music" });
  expect(await row(ben, teamId, dm)).toMatchObject({ callQuality: "music" });

  // Julio is the team's admin but in neither: they stay invisible to him.
  for (const channelId of [launch, dm]) {
    await expect(julio.as.mutation(api.channels.setCallQuality, { teamId, channelId, quality: "standard" })).rejects.toThrow(/not found/i);
  }
});

test("the team's limit refuses choices above it and caps channels set higher, until it goes back up", async () => {
  const { teamId, julio, ana, general, dm } = await team();
  await ana.as.mutation(api.channels.setCallQuality, { teamId, channelId: dm, quality: "music" });

  await expect(ana.as.mutation(api.teams.setCallQualityLimit, { teamId, limit: "high" })).rejects.toThrow(/Only admins/);
  await julio.as.mutation(api.teams.setCallQualityLimit, { teamId, limit: "high" });
  expect(await ana.as.query(api.teams.settings, { teamId })).toMatchObject({ callQualityLimit: "high" });

  // Above the limit: refused with the reason, and the direct message set earlier is capped, not rewritten.
  await expect(julio.as.mutation(api.channels.setCallQuality, { teamId, channelId: general, quality: "music" })).rejects.toThrow(
    "Music is above your team's limit (High). An admin can change the limit in Settings, Calls.",
  );
  expect(await row(ana, teamId, dm)).toMatchObject({ callQuality: "high", callQualityChosen: "music" });
  expect((await ana.as.mutation(api.calls.join, { teamId, channelId: dm })).callQuality).toBe("high");

  await julio.as.mutation(api.teams.setCallQualityLimit, { teamId, limit: "standard" });
  expect(await row(ana, teamId, dm)).toMatchObject({ callQuality: "standard", callQualityChosen: "music" });
  await expect(ana.as.mutation(api.channels.setCallQuality, { teamId, channelId: dm, quality: "high" })).rejects.toThrow(/above your team's limit \(Standard\)/);

  await julio.as.mutation(api.teams.setCallQualityLimit, { teamId, limit: "none" });
  expect(await row(ana, teamId, dm)).toMatchObject({ callQuality: "music", callQualityChosen: "music" });
});

test("agents set it through the HTTP API with the work.manage scope, under the same rules", async () => {
  const { t, teamId, julio, ana, general } = await team();
  const plain = await addAgent(t, teamId, julio, "Reader");
  const worker = await addAgent(t, teamId, julio, "Worker", ["room.read", "work.manage"]);
  const workerId = (await julio.as.query(api.teams.members, { teamId })).find((m) => m.name === "Worker")!.memberId;
  const withWorker = (await ana.as.mutation(api.channels.openDirect, { teamId, memberIds: [workerId] })).channelId;

  // The default scopes can't change a channel.
  expect(await callAsAgent(t, plain.key, "channels.setCallQuality", { channelId: general, quality: "high" })).toMatchObject({ ok: false });
  // An agent is a plain member, so a team channel is the admins'; its own direct message is its to change.
  expect(await callAsAgent(t, worker.key, "channels.setCallQuality", { channelId: general, quality: "high" })).toMatchObject({
    ok: false,
    error: { code: "forbidden" },
  });
  expect(await callAsAgent(t, worker.key, "channels.setCallQuality", { channelId: withWorker, quality: "high" })).toMatchObject({ ok: true });
  expect(await row(ana, teamId, withWorker)).toMatchObject({ callQuality: "high" });
  // The team's limit needs the team.admin scope.
  expect(await callAsAgent(t, worker.key, "teams.setCallQualityLimit", { limit: "standard" })).toMatchObject({ ok: false });
});

test("what each limit allows: voice by its rank, and screen shares by the bandwidth they use", () => {
  expect(["standard", "high", "music"].filter((q) => voiceAllowed(q as never, "high"))).toEqual(["standard", "high"]);
  const shares = ["sharp", "balanced", "smooth", "smoothHd", "source", "source60"] as const;
  expect(shares.filter((q) => shareAllowed(q, "standard"))).toEqual(["sharp"]);
  expect(shares.filter((q) => shareAllowed(q, "high"))).toEqual(["sharp", "balanced", "smooth"]);
  expect(shares.filter((q) => shareAllowed(q, "none"))).toEqual([...shares]);
  expect(effectiveVoice("music", "standard")).toBe("standard");
  expect(effectiveVoice("music", "high")).toBe("high");
  expect(effectiveShare("source60", "high")).toBe("balanced");
  expect(effectiveShare("smoothHd", "none")).toBe("smoothHd");
  expect(effectiveShare("smooth", "standard")).toBe("sharp");
  // A 1080p camera needs the High limit or none.
  expect(cameraAllowed("1080p", "standard")).toBe(false);
  expect(cameraAllowed("1080p", "high")).toBe(true);
  expect(effectiveCamera("1080p", "standard")).toBe("720p");
});
