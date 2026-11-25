import { expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, linkMachine, newRoom, newTeam, type Room } from "./setup";

const STUDIO = { spaceRef: "local:studio", name: "studio", os: "linux", kind: "container" };
const GATEWAY = ["http://100.101.102.103:3219"];

type Access = "watch" | "suggest" | "drive" | "open";

/** Julio shares a Space found on a team box at the given access; Ana is a teammate. */
async function sharedSpace(access: Access, opts: { personal?: boolean } = {}) {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, opts.personal ? "julio-mbp" : "team-box", {
    team: !opts.personal,
  });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  await bridgeSays(t, token, { type: "spaces_found", spaces: [STUDIO] });
  const spaceId = (await julio.as.mutation(api.spaces.share, {
    teamId,
    machineId,
    spaceRef: STUDIO.spaceRef,
    access,
  })) as Id<"spaces">;
  await bridgeSays(t, token, { type: "space_shared", spaceId, access, gateway: GATEWAY });
  return { t, teamId, julio, ana, machineId, token, spaceId };
}

const sent = async (t: Room, token: string, type: string) =>
  (await bridgeInbox(t, token)).filter((m: any) => m.type === type);

test("the bridge's found Spaces are listed for the machine, and sharing one sends it to the bridge", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");

  await bridgeSays(t, token, { type: "spaces_found", spaces: [STUDIO, { spaceRef: "direct:10.0.0.5:3211", name: "office-pc", os: "windows" }] });
  // A later report replaces the earlier one.
  await bridgeSays(t, token, { type: "spaces_found", spaces: [STUDIO] });

  expect(await julio.as.query(api.spaces.found, { teamId, machineId })).toEqual([
    expect.objectContaining({ spaceRef: "local:studio", name: "studio", os: "linux", shared: false }),
  ]);

  const spaceId = await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: "local:studio", access: "watch" });

  expect(await sent(t, token, "share_space")).toEqual([
    { v: 1, type: "share_space", spaceId, spaceRef: "local:studio", sharedBy: expect.objectContaining({ name: "Julio" }), access: "watch" },
  ]);
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ status: "starting", driver: { name: "Julio" } });

  await bridgeSays(t, token, { type: "space_shared", spaceId, access: "watch", gateway: GATEWAY });

  const [space] = await julio.as.query(api.spaces.list, { teamId });
  expect(space).toMatchObject({ spaceId, name: "studio", os: "linux", status: "live", access: "watch", sharedBy: { name: "Julio" }, driver: { name: "Julio" } });
  expect(await julio.as.query(api.spaces.found, { teamId, machineId })).toEqual([expect.objectContaining({ spaceRef: "local:studio", shared: true })]);
});

test("only whoever a machine belongs to shares its Spaces, and only Spaces its bridge found", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, "julio-mbp");
  await bridgeSays(t, token, { type: "spaces_found", spaces: [STUDIO] });

  await expect(ana.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: "local:studio", access: "watch" })).rejects.toThrow(/belongs to Julio/);
  await expect(julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: "local:other", access: "watch" })).rejects.toThrow(/found/i);

  // A team machine: only admins.
  const box = await linkMachine(t, teamId, julio, "team-box", { team: true });
  await bridgeSays(t, box.token, { type: "spaces_found", spaces: [STUDIO] });
  await expect(ana.as.mutation(api.spaces.share, { teamId, machineId: box.machineId, spaceRef: "local:studio", access: "watch" })).rejects.toThrow(/admin/i);
  await julio.as.mutation(api.spaces.share, { teamId, machineId: box.machineId, spaceRef: "local:studio", access: "watch" });
});

test("a Space can't be set above its machine's limit, and lowering the machine lowers it", async () => {
  const { t, teamId, julio, machineId, token, spaceId } = await sharedSpace("open");

  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "suggest" });

  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ access: "suggest", loweredFrom: "open" });
  expect(await sent(t, token, "change_space_access")).toEqual([{ v: 1, type: "change_space_access", spaceId, access: "suggest" }]);
  await expect(julio.as.mutation(api.spaces.setAccess, { teamId, spaceId, access: "drive" })).rejects.toThrow(/at most suggest/);

  // The bridge clamps on its own too; a late report never raises it.
  await bridgeSays(t, token, { type: "space_access", spaceId, access: "watch" });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ access: "watch" });
});

test("only the driver's Space view is interactive, and a view's ticket reaches only its viewer", async () => {
  const { t, teamId, julio, ana, token, spaceId } = await sharedSpace("watch");

  const julioView = await julio.as.mutation(api.spaces.openView, { teamId, spaceId });
  const anaView = await ana.as.mutation(api.spaces.openView, { teamId, spaceId });

  expect(await sent(t, token, "open_space_view")).toEqual([
    expect.objectContaining({ spaceId, viewId: julioView, viewer: expect.objectContaining({ name: "Julio" }), interactive: true }),
    expect.objectContaining({ spaceId, viewId: anaView, viewer: expect.objectContaining({ name: "Ana" }), interactive: false }),
  ]);

  const expiresAt = Date.now() + 5 * 60_000;
  await bridgeSays(t, token, { type: "space_view_ready", spaceId, viewId: anaView, path: "/v/k-ana/viewer/", ticket: "ticket-ana", expiresAt, interactive: false });

  expect(await ana.as.query(api.spaces.myView, { teamId, spaceId })).toMatchObject({
    status: "ready",
    interactive: false,
    urls: [`${GATEWAY[0]}/v/k-ana/viewer/#ticket=ticket-ana`],
  });
  // Julio's own view isn't ready yet, and nothing he can read shows Ana's ticket.
  expect(await julio.as.query(api.spaces.myView, { teamId, spaceId })).toMatchObject({ status: "requested", urls: [] });
  expect(JSON.stringify(await julio.as.query(api.spaces.get, { teamId, spaceId }))).not.toContain("ticket-ana");
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ watching: expect.arrayContaining([expect.objectContaining({ name: "Ana" })]) });
});

test("passing the wheel closes the old driver's interactive view and tells the bridge", async () => {
  const { t, teamId, julio, ana, token, spaceId } = await sharedSpace("drive");
  const julioView = await julio.as.mutation(api.spaces.openView, { teamId, spaceId });

  await expect(ana.as.mutation(api.spaces.takeWheel, { teamId, spaceId })).rejects.toThrow(/ask/i);
  const requestId = await ana.as.mutation(api.spaces.requestWheel, { teamId, spaceId });
  await julio.as.mutation(api.spaces.answerWheelRequest, { teamId, requestId, grant: true });

  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ driver: { name: "Ana" } });
  expect(await sent(t, token, "space_driver_changed")).toEqual([
    { v: 1, type: "space_driver_changed", spaceId, driver: expect.objectContaining({ name: "Ana" }) },
  ]);
  expect(await sent(t, token, "close_space_view")).toEqual([{ v: 1, type: "close_space_view", spaceId, viewId: julioView }]);
  expect(await julio.as.query(api.spaces.myView, { teamId, spaceId })).toMatchObject({ status: "closed", closedReason: "wheel_moved" });

  // Julio opens it again, as a viewer this time.
  await julio.as.mutation(api.spaces.openView, { teamId, spaceId });
  expect((await sent(t, token, "open_space_view")).at(-1)).toMatchObject({ interactive: false });
});

test("on an Open Space anyone takes the wheel; below Drive it only goes back to whoever shared it", async () => {
  const { teamId, julio, ana, spaceId } = await sharedSpace("open");
  await ana.as.mutation(api.spaces.takeWheel, { teamId, spaceId });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ driver: { name: "Ana" } });

  await julio.as.mutation(api.spaces.setAccess, { teamId, spaceId, access: "suggest" });
  const members = await julio.as.query(api.teams.members, { teamId });
  const carl = members.find((m) => m.name === "Ana")!.memberId;
  await expect(julio.as.mutation(api.spaces.passWheel, { teamId, spaceId, to: carl })).rejects.toThrow(/suggest/);
  await julio.as.mutation(api.spaces.takeWheel, { teamId, spaceId });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ driver: { name: "Julio" } });
});

test("on Suggest, teammates send suggestions the driver marks done; on Watch they can't", async () => {
  const { teamId, julio, ana, spaceId } = await sharedSpace("watch");
  await expect(ana.as.mutation(api.spaces.suggest, { teamId, spaceId, text: "Open Settings" })).rejects.toThrow(/watch/i);

  await julio.as.mutation(api.spaces.setAccess, { teamId, spaceId, access: "suggest" });
  const suggestionId = await ana.as.mutation(api.spaces.suggest, { teamId, spaceId, text: "Open Settings, then Deploy" });
  expect(await julio.as.query(api.spaces.suggestions, { teamId, spaceId })).toMatchObject([{ text: "Open Settings, then Deploy", from: { name: "Ana" } }]);

  await expect(ana.as.mutation(api.spaces.answerSuggestion, { teamId, suggestionId, done: true })).rejects.toThrow(/driver/i);
  await julio.as.mutation(api.spaces.answerSuggestion, { teamId, suggestionId, done: true });
  expect(await julio.as.query(api.spaces.suggestions, { teamId, spaceId })).toEqual([]);
});

test("an agent drives a Space with Space actions only as its driver, with the scope, and each is recorded", async () => {
  const { t, teamId, julio, token, spaceId } = await sharedSpace("drive");
  const unscoped = await addAgent(t, teamId, julio, "Reader", ["room.read"]);
  const { key } = await addAgent(t, teamId, julio, "Codex", ["room.read", "spaces.drive"]);
  const members = await julio.as.query(api.teams.members, { teamId });
  const codex = members.find((m) => m.name === "Codex")!;

  expect(await callAsAgent(t, unscoped.key, "spaces.act", { spaceId, action: { kind: "screenshot" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await callAsAgent(t, key, "spaces.act", { spaceId, action: { kind: "screenshot" } })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/driver/i) } });

  await julio.as.mutation(api.spaces.passWheel, { teamId, spaceId, to: codex.memberId });
  const shot = await callAsAgent(t, key, "spaces.act", { spaceId, action: { kind: "screenshot" } });
  const click = await callAsAgent(t, key, "spaces.act", { spaceId, action: { kind: "click", x: 40, y: 12, screenshotId: "shot-1" } });
  expect(shot.ok && click.ok).toBe(true);

  expect(await sent(t, token, "space_action")).toEqual([
    { v: 1, type: "space_action", spaceId, actionId: shot.result, from: expect.objectContaining({ name: "Codex" }), action: { kind: "screenshot" } },
    expect.objectContaining({ actionId: click.result, action: { kind: "click", x: 40, y: 12, screenshotId: "shot-1" } }),
  ]);
  expect(await callAsAgent(t, key, "spaces.action", { actionId: shot.result })).toMatchObject({ ok: true, result: { status: "pending" } });

  const screenshot = { image: "aGVsbG8=", format: "jpeg", width: 1280, height: 800, screenshotId: "shot-1" };
  await bridgeSays(t, token, { type: "space_action_result", spaceId, actionId: shot.result, ok: true, screenshot });
  await bridgeSays(t, token, { type: "space_action_result", spaceId, actionId: click.result, ok: false, error: "not_driver" });

  expect(await callAsAgent(t, key, "spaces.action", { actionId: shot.result })).toMatchObject({ result: { status: "done", screenshot } });
  expect(await callAsAgent(t, key, "spaces.action", { actionId: click.result })).toMatchObject({ result: { status: "failed", error: "not_driver" } });
  const log = await julio.as.query(api.spaces.actions, { teamId, spaceId });
  expect(log).toMatchObject([
    { action: { kind: "click" }, status: "failed", by: { name: "Codex", kind: "agent", addedBy: { name: "Julio" } } },
    { action: { kind: "screenshot" }, status: "done", by: { name: "Codex" } },
  ]);
  // The log is for people to read: it never carries the image.
  expect(JSON.stringify(log)).not.toContain("aGVsbG8=");
});

test("an agent that drives gets a watch-only view: its input goes through Space actions only", async () => {
  const { t, teamId, julio, token, spaceId } = await sharedSpace("drive");
  // Reading is all a view needs, so the scope can't be what keeps an agent from typing.
  const { key } = await addAgent(t, teamId, julio, "Reader", ["room.read"]);
  const members = await julio.as.query(api.teams.members, { teamId });
  const reader = members.find((m) => m.name === "Reader")!;
  await julio.as.mutation(api.spaces.passWheel, { teamId, spaceId, to: reader.memberId });

  const opened = await callAsAgent(t, key, "spaces.openView", { spaceId });

  expect(opened.ok).toBe(true);
  expect((await sent(t, token, "open_space_view")).at(-1)).toMatchObject({ viewId: opened.result, interactive: false });
  expect(await callAsAgent(t, key, "spaces.myView", { spaceId })).toMatchObject({ result: { interactive: false } });
  // Still the driver for Space actions, which need the spaces.drive scope and are logged.
  expect(await callAsAgent(t, key, "spaces.act", { spaceId, action: { kind: "screenshot" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
});

test("a view whose heartbeat stops is closed, and the bridge is told to close it", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, token, spaceId } = await sharedSpace("watch");
    const viewId = await ana.as.mutation(api.spaces.openView, { teamId, spaceId });
    for (let i = 0; i < 3; i++) {
      await ana.as.mutation(api.spaces.watch, { teamId, spaceId });
      vi.advanceTimersByTime(15_000);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await sent(t, token, "close_space_view")).toEqual([]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await sent(t, token, "close_space_view")).toEqual([{ v: 1, type: "close_space_view", spaceId, viewId }]);
    expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ watching: [] });
  } finally {
    vi.useRealTimers();
  }
});

test("stopping sharing on the machine, a bridge restart, or Cua losing the Space ends it", async () => {
  const { t, teamId, julio, machineId, token, spaceId } = await sharedSpace("watch");

  await bridgeSays(t, token, { type: "space_ended", spaceId, reason: "gone" });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ status: "ended" });

  const second = await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "watch" });
  await bridgeSays(t, token, { type: "space_shared", spaceId: second, access: "watch", gateway: GATEWAY });
  await julio.as.mutation(api.machines.stopSharing, { teamId, machineId });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId: second as Id<"spaces"> })).toMatchObject({ status: "ended" });
  await expect(julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "watch" })).rejects.toThrow(/sharing/i);

  await julio.as.mutation(api.machines.resumeSharing, { teamId, machineId });
  const third = await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "watch" });
  await bridgeSays(t, token, { type: "space_shared", spaceId: third, access: "watch", gateway: GATEWAY });
  await bridgeSays(t, token, { type: "register_machine", hostname: "team-box.local", os: "darwin", bridgeVersion: "0.1.0", tools: [], limits: { mostOpenAccess: "open", slots: 2, longestProfileMs: 1000 } });
  expect(await julio.as.query(api.spaces.list, { teamId })).toEqual([]);
});

test("a Space shared for a task is one of its runs, Unknown while live and Stopped once it ends", async () => {
  const { t, teamId, julio, machineId, token, spaceId: first } = await sharedSpace("watch");
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Playtest the Windows build" });
  await julio.as.mutation(api.spaces.stopSharing, { teamId, spaceId: first });
  expect(await sent(t, token, "unshare_space")).toEqual([{ v: 1, type: "unshare_space", spaceId: first }]);

  const spaceId = (await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "watch", taskId })) as Id<"spaces">;
  const { runId } = await julio.as.query(api.spaces.get, { teamId, spaceId });
  expect(await julio.as.query(api.runs.get, { teamId, runId: runId! })).toMatchObject({ taskId, state: "unknown", harness: "space" });

  await bridgeSays(t, token, { type: "space_ended", spaceId, reason: "stopped" });
  expect(await julio.as.query(api.runs.get, { teamId, runId: runId! })).toMatchObject({ state: "stopped" });
});

test("a Space stopped on its machine closes its views, refuses new ones and actions, and its run comes back when it starts", async () => {
  const { t, teamId, julio, ana, machineId, token } = await sharedSpace("watch");
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Playtest" });
  const first = (await julio.as.query(api.spaces.list, { teamId }))[0]!.spaceId;
  await julio.as.mutation(api.spaces.stopSharing, { teamId, spaceId: first });
  const spaceId = (await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "watch", taskId })) as Id<"spaces">;
  await bridgeSays(t, token, { type: "space_shared", spaceId, access: "watch", gateway: GATEWAY });
  const viewId = await ana.as.mutation(api.spaces.openView, { teamId, spaceId });
  const { runId } = await julio.as.query(api.spaces.get, { teamId, spaceId });

  await bridgeSays(t, token, { type: "space_power", spaceId, state: "stopped" });
  await bridgeSays(t, token, { type: "spaces_found", spaces: [{ ...STUDIO, state: "stopped" }] });

  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ status: "live", power: "stopped" });
  expect(await ana.as.query(api.spaces.myView, { teamId, spaceId })).toMatchObject({ viewId, status: "closed", closedReason: "space_stopped" });
  await expect(ana.as.mutation(api.spaces.openView, { teamId, spaceId })).rejects.toThrow(/stopped/);
  await expect(julio.as.mutation(api.spaces.act, { teamId, spaceId, action: { kind: "screenshot" } })).rejects.toThrow(/stopped/);
  expect(await julio.as.query(api.runs.get, { teamId, runId: runId! })).toMatchObject({ state: "stopped" });
  expect(await julio.as.query(api.spaces.found, { teamId, machineId })).toEqual([expect.objectContaining({ state: "stopped" })]);

  await bridgeSays(t, token, { type: "space_power", spaceId, state: "running" });

  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ power: "running" });
  expect(await julio.as.query(api.runs.get, { teamId, runId: runId! })).toMatchObject({ state: "unknown" });
  await ana.as.mutation(api.spaces.openView, { teamId, spaceId });
});

test("stopping a Space run ends that share: the bridge unshares it and every view closes, but the Space itself keeps running", async () => {
  const { t, teamId, julio, ana, machineId, token, spaceId: first } = await sharedSpace("drive");
  await julio.as.mutation(api.spaces.stopSharing, { teamId, spaceId: first });
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Playtest" });
  const spaceId = (await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "drive", taskId })) as Id<"spaces">;
  await bridgeSays(t, token, { type: "space_shared", spaceId, access: "drive", gateway: GATEWAY });
  await ana.as.mutation(api.spaces.openView, { teamId, spaceId });
  const { runId } = await julio.as.query(api.spaces.get, { teamId, spaceId });

  await julio.as.mutation(api.runs.stop, { teamId, runId: runId! });

  expect(await julio.as.query(api.runs.get, { teamId, runId: runId! })).toMatchObject({ state: "stopped" });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ status: "ended" });
  expect(await ana.as.query(api.spaces.myView, { teamId, spaceId })).toMatchObject({ status: "closed", closedReason: "space_ended" });
  const toBridge = await bridgeInbox(t, token);
  expect(toBridge.filter((m: any) => m.type === "unshare_space" && m.spaceId === spaceId)).toHaveLength(1);
  // Unsharing never powers the Space off: nothing but the unshare goes to the bridge for it.
  expect(toBridge.filter((m: any) => m.spaceId === spaceId).map((m: any) => m.type)).not.toContain("stop_terminal");
  await expect(julio.as.mutation(api.spaces.act, { teamId, spaceId, action: { kind: "screenshot" } })).rejects.toThrow(/no longer shared/);
});

test("access raised while a share starts stays raised when the bridge's acknowledgement comes back", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, julio, "team-box", { team: true });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  await bridgeSays(t, token, { type: "spaces_found", spaces: [STUDIO] });
  const spaceId = (await julio.as.mutation(api.spaces.share, { teamId, machineId, spaceRef: STUDIO.spaceRef, access: "watch" })) as Id<"spaces">;
  await julio.as.mutation(api.spaces.setAccess, { teamId, spaceId, access: "open" });

  // The bridge acknowledges with the access it shared at, from before the raise.
  await bridgeSays(t, token, { type: "space_shared", spaceId, access: "watch", gateway: GATEWAY });

  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ status: "live", access: "open" });
  // The bridge's own clamp still lowers it.
  await bridgeSays(t, token, { type: "space_access", spaceId, access: "drive" });
  expect(await julio.as.query(api.spaces.get, { teamId, spaceId })).toMatchObject({ access: "drive" });
});

test("a view the bridge renewed keeps its new expiry", async () => {
  const { t, teamId, ana, token, spaceId } = await sharedSpace("watch");
  const viewId = await ana.as.mutation(api.spaces.openView, { teamId, spaceId });
  const soon = Date.now() + 60_000;
  await bridgeSays(t, token, { type: "space_view_ready", spaceId, viewId, path: "/v/k-ana/viewer/", ticket: "t1", expiresAt: soon, interactive: false });

  await bridgeSays(t, token, { type: "space_view_renewed", spaceId, viewId, expiresAt: soon + 300_000 });

  expect(await ana.as.query(api.spaces.myView, { teamId, spaceId })).toMatchObject({ status: "ready", expiresAt: soon + 300_000 });
  // Opening again reuses the renewed view rather than replacing it.
  expect(await ana.as.mutation(api.spaces.openView, { teamId, spaceId })).toBe(viewId);
});
