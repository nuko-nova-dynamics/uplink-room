import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { addTeammate, bridgeInbox, bridgeSays, DAY, linkMachine, newRoom, newTeam } from "./setup";

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

async function anaOnJuliosMachine() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  // At Drive, so Ana may start runs on it (ADR 0025).
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, longestProfileMs: 7 * DAY, mostOpenAccess: "drive" });
  return { t, teamId, julio, ana, machineId, token };
}

test("a profile on someone's personal machine needs you to accept that they can read it", async () => {
  const { teamId, ana, machineId } = await anaOnJuliosMachine();
  await expect(
    ana.as.mutation(api.profiles.create, { teamId, machineId, name: "Ana's logins", keepForMs: DAY }),
  ).rejects.toThrow(/Julio can read everything in it/);
});

test("a profile's expiry is capped at the machine's limit, and the bridge is asked to make it", async () => {
  const { t, teamId, ana, machineId, token } = await anaOnJuliosMachine();

  const profileId = await ana.as.mutation(api.profiles.create, {
    teamId,
    machineId,
    name: "Ana's logins",
    keepForMs: 30 * DAY,
    acceptReadableByOwner: true,
  });

  const asked = (await bridgeInbox(t, token)).find((m: any) => m.type === "create_profile") as any;
  expect(asked).toMatchObject({ profileId, person: { name: "Ana" } });
  const expiresAt = asked.expiresAt as number;
  expect(expiresAt - Date.now()).toBeGreaterThan(7 * DAY - 1000);
  expect(expiresAt - Date.now()).toBeLessThan(7 * DAY + 1000);
  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt });
  expect(await ana.as.query(api.profiles.mine, { teamId })).toMatchObject([
    { profileId, machine: { name: "julio-mbp" }, status: "ready", expiresAt },
  ]);
});

test("a teammate's terminal can use their own profile instead of the machine setup", async () => {
  const { t, teamId, ana, machineId, token } = await anaOnJuliosMachine();
  const profileId = await ana.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: DAY, acceptReadableByOwner: true });
  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt: Date.now() + DAY });
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Try the beta" });

  const { terminalId } = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId, profileId });

  expect(await bridgeInbox(t, token)).toContainEqual(expect.objectContaining({ type: "start_terminal", terminalId, profileId, usesSlot: true }));
});

test("you see your profiles on every machine and can delete them", async () => {
  const { t, teamId, ana, machineId, token } = await anaOnJuliosMachine();
  const profileId = await ana.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: DAY, acceptReadableByOwner: true });
  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt: Date.now() + DAY });

  await ana.as.mutation(api.profiles.remove, { teamId, profileId });

  expect(await bridgeInbox(t, token)).toContainEqual({ v: 1, type: "delete_profile", profileId });
  expect(await ana.as.query(api.profiles.mine, { teamId })).toEqual([]);
});

test("a profile the bridge expired disappears from your list", async () => {
  const { t, teamId, ana, machineId, token } = await anaOnJuliosMachine();
  const profileId = await ana.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: DAY, acceptReadableByOwner: true });
  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt: Date.now() + DAY });

  await bridgeSays(t, token, { type: "profile_expired", profileId });

  expect(await ana.as.query(api.profiles.mine, { teamId })).toEqual([]);
});

test("a late profile_created doesn't bring back a profile that was deleted", async () => {
  const { t, teamId, ana, machineId, token } = await anaOnJuliosMachine();
  const profileId = await ana.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: DAY, acceptReadableByOwner: true });
  await ana.as.mutation(api.profiles.remove, { teamId, profileId });

  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt: Date.now() + DAY });

  expect(await ana.as.query(api.profiles.mine, { teamId })).toEqual([]);
});

test("a profile expires in the room at its time, even before the bridge reports it, and at the bridge's earlier time", async () => {
  const { t, teamId, julio, ana, machineId, token } = await anaOnJuliosMachine();
  const profileId = await ana.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: 2 * DAY, acceptReadableByOwner: true });
  // The machine keeps it for less time than the room asked.
  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt: Date.now() + DAY });
  expect(await ana.as.query(api.profiles.mine, { teamId })).toHaveLength(1);

  // Nothing else writes at expiry, so the room must, or subscribed lists keep showing it.
  vi.advanceTimersByTime(DAY);
  await t.finishInProgressScheduledFunctions();

  expect(await t.run((ctx) => ctx.db.get(profileId))).toMatchObject({ status: "expired" });
  expect(await ana.as.query(api.profiles.mine, { teamId })).toEqual([]);
  expect(await julio.as.query(api.profiles.onMachine, { teamId, machineId })).toEqual([]);
});

test("a run can use a profile only with a harness that keeps the profile's logins apart from the machine setup", async () => {
  const { t, teamId, ana, machineId, token } = await anaOnJuliosMachine();
  const profileId = await ana.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: DAY, acceptReadableByOwner: true });
  await bridgeSays(t, token, { type: "profile_created", profileId, expiresAt: Date.now() + DAY });
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Try the beta" });

  for (const harness of ["codex", "grok-build", "cursor", "hermes-agent", "shell"]) {
    await expect(ana.as.mutation(api.runs.start, { teamId, taskId, harness, machineId, profileId })).rejects.toThrow(
      /can't use a profile.*machine setup/i,
    );
  }
  const { terminalId } = await ana.as.mutation(api.runs.start, { teamId, taskId, harness: "opencode", machineId, profileId });

  const starts = (await bridgeInbox(t, token)).filter((m: any) => m.type === "start_terminal");
  expect(starts).toEqual([expect.objectContaining({ terminalId, profileId, harness: "opencode", command: "opencode" })]);
});
