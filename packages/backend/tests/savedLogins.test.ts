import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hyperbeamProvider, setBrowserProviderForTests } from "../convex/lib/browserProvider";
import { fakeBrowserProvider, type FakeBrowserProvider } from "./fakeBrowserProvider";
import { addAgent, addTeammate, callAsAgent, DAY, newRoom, newTeam, type Room } from "./setup";

/**
 * ADR 0011 (spec #7): saved logins for shared browsers, tested at the Room API
 * with a fake provider that models Hyperbeam's profiles.
 */

const HOUR = 60 * 60 * 1000;
/** About `ms` from now: the test clock moves a few milliseconds while the room runs. */
const fromNow = (ms: number) => expect.closeTo(Date.now() + ms, -4);
let fake: FakeBrowserProvider;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  fake = fakeBrowserProvider();
  setBrowserProviderForTests(fake.provider);
});

afterEach(() => {
  setBrowserProviderForTests(undefined);
  vi.useRealTimers();
});

/** Runs what the room scheduled to happen now (provider calls), without jumping ahead to later timeouts. */
async function settle(t: Room) {
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

/** Moves the clock on and runs whatever the room scheduled for that time. */
async function later(t: Room, ms: number) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
  await settle(t);
}

async function room() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const bo = await addTeammate(t, teamId, julio, "Bo");
  const channels = await julio.as.query(api.channels.list, { teamId });
  const channelId = channels.find((c) => c.name === "general")!.channelId;
  return { t, teamId, julio, ana, bo, channelId };
}

type R = Awaited<ReturnType<typeof room>>;

/** `who` starts a browser in #general that keeps its logins as "staging admin". */
async function startKeeping(r: R, who: R["julio"], keep: "1d" | "7d" | "30d" | "forever" = "7d", name = "staging admin") {
  const browserId = (await who.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    url: "https://staging.example.com/admin",
    newSavedLogin: { name, keep },
  })) as Id<"browsers">;
  await settle(r.t);
  const [saved] = await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  return { browserId, savedLoginId: saved!.savedLoginId };
}

/** Ends a browser and waits out the pause before Hyperbeam's DELETE that a browser with saved logins gets. */
async function endBrowser(r: R, browserId: Id<"browsers">) {
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  await later(r.t, 30_000);
}

/** A person joins a browser: gets a ticket, and Hyperbeam asks our auth webhook about it, as its SDK does. */
async function joins(r: R, who: R["julio"], browserId: Id<"browsers">, hbUserId: string, startIndex = 0) {
  const { ticket } = await who.as.mutation(api.browsers.join, { teamId: r.teamId, browserId });
  const response = await r.t.fetch("/hyperbeam/auth", {
    method: "POST",
    headers: { authorization: `Bearer ${fake.started[startIndex]!.authWebhook.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: hbUserId, userdata: { ticket } }),
  });
  expect(await response.json()).toMatchObject({ authorized: true });
  await settle(r.t);
}

test("a browser is Temporary unless someone picks how long to keep its logins: no profile is saved or loaded", async () => {
  const r = await room();
  const browserId = await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId });
  await settle(r.t);
  expect(fake.started[0]!.profile).toBeUndefined();
  const view = await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId });
  expect(view).toMatchObject({ status: "live" });
  expect(view).not.toHaveProperty("savedLogin");
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toEqual([]);
});

test("keeping logins saves the browser as named saved logins, and the next browser loads them and saves back", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);

  // Hyperbeam is asked for a new profile, and the channel lists the saved logins.
  expect(fake.started[0]!.profile).toBe("new");
  const listed = await r.ana.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  expect(listed).toMatchObject([
    {
      name: "staging admin",
      keep: "7d",
      status: "kept",
      expiresAt: fromNow(7 * DAY),
      savedBy: { name: "Julio" },
      inUse: true,
      channel: { name: "general" },
    },
  ]);
  expect(await r.ana.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({
    savedLogin: { savedLoginId, name: "staging admin", keep: "7d", status: "kept" },
  });

  // Ending the browser is when Hyperbeam saves the profile.
  await endBrowser(r, browserId);
  expect(fake.profileSaves("profile-1")).toBe(1);

  // The next browser loads that profile and saves back to it, so new logins carry over.
  const next = await r.ana.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId });
  await settle(r.t);
  expect(fake.started[1]!.profile).toEqual({ id: "profile-1" });
  expect(fake.loadedProfile("session-2")).toBe("profile-1");
  await endBrowser(r, next as Id<"browsers">);
  expect(fake.profileSaves("profile-1")).toBe(2);
  expect(await r.ana.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { name: "staging admin", inUse: false, lastUsedAt: expect.any(Number) },
  ]);
});

test("ending a browser with saved logins waits 30 seconds before Hyperbeam's DELETE, so a login made just before is saved", async () => {
  // Live on 2026-11-03 (dev key): a session ended about 5 s after a login came back logged out when
  // its profile was loaded; sessions ended 15 s or more after the login stayed logged in.
  const r = await room();
  const { browserId } = await startKeeping(r, r.julio);
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  await settle(r.t);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "stopping" });
  expect(fake.ended).toEqual([]);
  await later(r.t, 29_000);
  expect(fake.ended).toEqual([]);
  await later(r.t, 1_000);
  expect(fake.ended).toEqual(["session-1"]);
  expect(fake.profileSaves("profile-1")).toBe(1);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "ended" });

  // A temporary browser saves nothing, so it ends at once.
  const temporary = (await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId })) as Id<"browsers">;
  await settle(r.t);
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId: temporary });
  await settle(r.t);
  expect(fake.ended).toEqual(["session-1", "session-2"]);
});

test("pressing End on a browser with saved logins takes away everyone's control and connection at once, though the DELETE waits", async () => {
  // Codex review of PR #74: during the 30 s before Hyperbeam's DELETE, people already connected could
  // still watch and drive the signed-in browser.
  const r = await room();
  const { browserId } = await startKeeping(r, r.julio);
  await joins(r, r.julio, browserId, "hb-julio");
  await joins(r, r.ana, browserId, "hb-ana");
  expect(fake.controllers("session-1")).toEqual(["hb-julio"]);

  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  await settle(r.t);
  expect(fake.controllers("session-1")).toEqual([]);
  expect(fake.disconnected.map((d) => d.userId).sort()).toEqual(["hb-ana", "hb-julio"]);
  // The session itself stays up only so it can save the logins.
  expect(fake.ended).toEqual([]);
  await later(r.t, 30_000);
  expect(fake.ended).toEqual(["session-1"]);
});

test("a control update in flight when End is pressed can't give control back to anyone", async () => {
  const r = await room();
  const { browserId } = await startKeeping(r, r.julio);
  await joins(r, r.julio, browserId, "hb-julio");
  await joins(r, r.ana, browserId, "hb-ana");

  // Julio passes the wheel to Ana; that control update stops between its remove and add calls...
  const paused = fake.pauseNextControlUpdate();
  await r.julio.as.mutation(api.browsers.passWheel, { teamId: r.teamId, browserId, to: r.ana.memberId });
  vi.advanceTimersByTime(1);
  await paused.reached;
  // ...while Julio presses End, and the room cuts everyone off.
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  vi.advanceTimersByTime(1);
  for (let i = 0; i < 500; i++) await Promise.resolve();
  // Then the old update finishes and adds Ana's roles back.
  paused.release();
  await settle(r.t);

  expect(fake.controllers("session-1")).toEqual([]);
});

test("End disconnects everyone without waiting for their roles to come off, even when that stalls", async () => {
  // Codex review round 2: the cut waited for role removal before disconnecting anyone.
  const r = await room();
  const { browserId } = await startKeeping(r, r.julio);
  await joins(r, r.julio, browserId, "hb-julio");
  await joins(r, r.ana, browserId, "hb-ana");

  // Taking the roles away stalls at Hyperbeam...
  const paused = fake.pauseNextControlUpdate();
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  vi.advanceTimersByTime(1);
  await paused.reached;
  for (let i = 0; i < 50; i++) await Promise.resolve();
  // ...and everyone is disconnected meanwhile.
  expect(fake.disconnected.map((d) => d.userId).sort()).toEqual(["hb-ana", "hb-julio"]);
  paused.release();
  await settle(r.t);
});

test("End retries taking the roles away when Hyperbeam fails it", async () => {
  const r = await room();
  const { browserId } = await startKeeping(r, r.julio);
  await joins(r, r.julio, browserId, "hb-julio");
  const before = fake.controlUpdates.length;

  fake.failControlUpdates(1);
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  await settle(r.t);
  expect(fake.controlUpdates.slice(before)).toEqual([{ sessionId: "session-1", controllers: [] }]);
  // The failed removal is tried again with backoff while the browser is stopping.
  await later(r.t, 5_000);
  expect(fake.controlUpdates.slice(before)).toEqual([
    { sessionId: "session-1", controllers: [] },
    { sessionId: "session-1", controllers: [] },
  ]);
});

test("a URL opened right after a browser with saved logins goes live isn't overwritten by its start URL", async () => {
  // Codex review round 2: the start URL is opened in a scheduled action, which could land after a
  // newer openUrl, such as an agent driving as soon as the browser is live.
  const r = await room();
  const browserId = (await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    url: "https://staging.example.com/admin",
    newSavedLogin: { name: "staging admin", keep: "7d" },
  })) as Id<"browsers">;
  // The browser goes live, and its start URL is scheduled but not opened yet...
  vi.advanceTimersByTime(1);
  await r.t.finishInProgressScheduledFunctions();
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "live" });
  expect(fake.opened).toEqual([]);
  // ...when the driver opens another URL.
  await r.julio.as.mutation(api.browsers.openUrl, { teamId: r.teamId, browserId, url: "https://vendor.example.com/" });
  await settle(r.t);
  expect(fake.opened.map((o) => o.url)).toEqual(["https://vendor.example.com/"]);
});

test("the profile id never reaches a client: not in the saved logins list, the browser or the activity log", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  await endBrowser(r, browserId);
  await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId });
  await settle(r.t);
  const shown = JSON.stringify([
    await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId }),
    await r.julio.as.query(api.browsers.list, { teamId: r.teamId }),
    await r.julio.as.query(api.activity.list, { teamId: r.teamId }),
  ]);
  expect(shown).not.toContain("profile-1");
});

test("the profile id is never the id of a session anyone can join, so a joiner can't read it from the embed URL", async () => {
  const r = await room();
  const { browserId } = await startKeeping(r, r.julio);
  const joined = await r.ana.as.mutation(api.browsers.join, { teamId: r.teamId, browserId });
  // The browser's own session saves to a profile made apart from it.
  expect(fake.savesTo("session-1")).toBe("profile-1");
  expect(joined.embedUrl).not.toContain("profile-1");
});

test("each keep choice sets when the saved logins are forgotten, and Until deleted sets none", async () => {
  const r = await room();
  await r.julio.as.mutation(api.browsers.setSettings, { teamId: r.teamId, maxLive: 4 });
  const channels = ["a", "b", "c", "d"];
  const expected = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY, forever: undefined } as const;
  for (const [i, keep] of (["1d", "7d", "30d", "forever"] as const).entries()) {
    const channelId = await r.julio.as.mutation(api.channels.create, { teamId: r.teamId, name: channels[i]! });
    await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId, newSavedLogin: { name: `logins ${keep}`, keep } });
    const [saved] = await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId });
    const ms = expected[keep];
    expect(saved).toMatchObject({ keep });
    if (ms === undefined) expect(saved).not.toHaveProperty("expiresAt");
    else expect(saved!.expiresAt).toBe(saved!.createdAt + ms);
  }
});

test("saved logins need a name that no other saved logins in the channel have", async () => {
  const r = await room();
  await expect(
    r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, newSavedLogin: { name: "  ", keep: "7d" } }),
  ).rejects.toThrow(/name/i);
  const { browserId } = await startKeeping(r, r.julio);
  await endBrowser(r, browserId);
  await expect(
    r.ana.as.mutation(api.browsers.start, {
      teamId: r.teamId,
      channelId: r.channelId,
      newSavedLogin: { name: "Staging Admin", keep: "1d" },
    }),
  ).rejects.toThrow(/already/i);
});

test("saved logins are forgotten when their time runs out, and the channel shows what was forgotten", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio, "1d");
  await endBrowser(r, browserId);

  await later(r.t, DAY - HOUR);
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { status: "kept" },
  ]);

  await later(r.t, HOUR);
  expect(await r.ana.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { name: "staging admin", status: "forgotten", forgetReason: "expired", forgottenAt: expect.any(Number) },
  ]);
  await expect(
    r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId }),
  ).rejects.toThrow(/forgotten/i);
  expect(fake.started).toHaveLength(1);
});

test("changing how long saved logins are kept restarts their clock, and renaming keeps the same logins", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio, "1d");
  await endBrowser(r, browserId);
  await later(r.t, 12 * HOUR);

  await r.julio.as.mutation(api.savedLogins.setKeep, { teamId: r.teamId, savedLoginId, keep: "30d" });
  await r.julio.as.mutation(api.savedLogins.rename, { teamId: r.teamId, savedLoginId, name: "staging (admin)" });
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { name: "staging (admin)", keep: "30d", expiresAt: fromNow(30 * DAY) },
  ]);

  // The old one-day deadline passes and nothing is forgotten.
  await later(r.t, DAY);
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { status: "kept" },
  ]);
  await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId });
  await settle(r.t);
  expect(fake.started[1]!.profile).toEqual({ id: "profile-1" });

  // Until deleted: no deadline at all.
  await r.julio.as.mutation(api.savedLogins.setKeep, { teamId: r.teamId, savedLoginId, keep: "forever" });
  await later(r.t, 60 * DAY);
  const [kept] = await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  expect(kept).toMatchObject({ status: "kept", keep: "forever" });
  expect(kept).not.toHaveProperty("expiresAt");
});

test("forgetting saved logins now stops them loading, is recorded, and a running browser keeps going", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });

  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { status: "forgotten", forgetReason: "forgotten", forgottenBy: { name: "Julio" } },
  ]);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({
    status: "live",
    savedLogin: { status: "forgotten" },
  });
  const log = await r.julio.as.query(api.activity.list, { teamId: r.teamId });
  expect(log.map((e) => e.action)).toContain("saved_logins.forgotten");

  await endBrowser(r, browserId);
  await expect(
    r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId }),
  ).rejects.toThrow(/forgotten/i);
  // Forgetting again is a no-op, and a forgotten name can be used again.
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    newSavedLogin: { name: "staging admin", keep: "1d" },
  });
  await settle(r.t);
  expect(fake.started[1]!.profile).toBe("new");
});

test("only whoever saved them or an admin can rename, change or forget saved logins", async () => {
  const r = await room();
  const { savedLoginId } = await startKeeping(r, r.ana);
  const args = { teamId: r.teamId, savedLoginId };

  await expect(r.bo.as.mutation(api.savedLogins.rename, { ...args, name: "mine" })).rejects.toThrow(/forbidden/);
  await expect(r.bo.as.mutation(api.savedLogins.setKeep, { ...args, keep: "forever" })).rejects.toThrow(/forbidden/);
  await expect(r.bo.as.mutation(api.savedLogins.forget, args)).rejects.toThrow(/forbidden/);

  await r.ana.as.mutation(api.savedLogins.setKeep, { ...args, keep: "30d" });
  await r.julio.as.mutation(api.savedLogins.rename, { ...args, name: "staging, admin account" });
  await r.julio.as.mutation(api.savedLogins.forget, args);
  expect(await r.bo.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { name: "staging, admin account", status: "forgotten", forgottenBy: { name: "Julio" } },
  ]);
});

test("saved logins belong to their channel", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  await endBrowser(r, browserId);
  const design = await r.julio.as.mutation(api.channels.create, { teamId: r.teamId, name: "design" });
  await expect(
    r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: design, savedLoginId }),
  ).rejects.toThrow(/channel/i);
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: design })).toEqual([]);
});

test("saved logins a stopping browser is still saving can't be loaded until Hyperbeam confirms it's gone", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  fake.failEnds(1);
  await endBrowser(r, browserId);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "stopping" });

  await expect(
    r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId }),
  ).rejects.toThrow(/still saving/i);

  await later(r.t, 5_000);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "ended" });
  await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId });
  await settle(r.t);
  expect(fake.started[1]!.profile).toEqual({ id: "profile-1" });
});

test("a first browser that fails leaves the saved logins empty, and the next one starts their profile", async () => {
  const r = await room();
  fake.failNextStart("Hyperbeam answered 500");
  await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    newSavedLogin: { name: "staging admin", keep: "7d" },
  });
  await settle(r.t);
  const [saved] = await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  expect(saved).toMatchObject({ status: "kept", inUse: false });
  expect(saved).not.toHaveProperty("lastUsedAt");
  await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    savedLoginId: saved!.savedLoginId,
  });
  await settle(r.t);
  expect(fake.started[0]!.profile).toBe("new");
});

test("agents list, start with, keep, rename and forget saved logins over HTTP, with the scopes those need", async () => {
  const r = await room();
  const { key: reader } = await addAgent(r.t, r.teamId, r.julio, "Notetaker", ["room.read"]);
  const { key } = await addAgent(r.t, r.teamId, r.ana, "Hermes", ["room.read", "browsers.use"]);

  expect(
    await callAsAgent(r.t, reader, "browsers.start", {
      channelId: r.channelId,
      newSavedLogin: { name: "vendor console", keep: "7d" },
    }),
  ).toMatchObject({ status: 403 });

  const started = await callAsAgent(r.t, key, "browsers.start", {
    channelId: r.channelId,
    url: "https://vendor.example.com",
    newSavedLogin: { name: "vendor console", keep: "1d" },
  });
  expect(started).toMatchObject({ ok: true });
  await settle(r.t);
  expect(fake.started[0]!.profile).toBe("new");

  const listed = await callAsAgent(r.t, reader, "savedLogins.list", { channelId: r.channelId });
  expect(listed).toMatchObject({ ok: true, result: [{ name: "vendor console", savedBy: { name: "Hermes" } }] });
  const savedLoginId = listed.result[0].savedLoginId as string;

  expect(await callAsAgent(r.t, reader, "savedLogins.setKeep", { savedLoginId, keep: "forever" })).toMatchObject({
    status: 403,
  });
  expect(await callAsAgent(r.t, key, "savedLogins.setKeep", { savedLoginId, keep: "30d" })).toMatchObject({ ok: true });
  expect(await callAsAgent(r.t, key, "savedLogins.rename", { savedLoginId, name: "vendor (read-only)" })).toMatchObject({
    ok: true,
  });
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId: started.result });
  await later(r.t, 30_000);

  const again = await callAsAgent(r.t, key, "browsers.start", { channelId: r.channelId, savedLoginId });
  expect(again).toMatchObject({ ok: true });
  await settle(r.t);
  expect(fake.started[1]!.profile).toEqual({ id: "profile-1" });

  expect(await callAsAgent(r.t, key, "savedLogins.forget", { savedLoginId })).toMatchObject({ ok: true });
  const log = await r.julio.as.query(api.activity.list, { teamId: r.teamId });
  expect(log.find((e) => e.action === "saved_logins.forgotten")).toMatchObject({
    actor: { name: "Hermes" },
    accountable: { name: "Ana" },
  });
});

test("an agent that didn't save them needs an admin's role and the admin scope to change someone else's saved logins", async () => {
  const r = await room();
  const { savedLoginId } = await startKeeping(r, r.ana);
  const { key: userKey } = await addAgent(r.t, r.teamId, r.julio, "Deployer", ["room.read", "browsers.use"]);
  const { key: adminKey } = await addAgent(r.t, r.teamId, r.julio, "Admin bot", ["room.read", "browsers.use", "team.admin"]);
  const agentMembers = await r.julio.as.query(api.teams.members, { teamId: r.teamId });
  for (const name of ["Deployer", "Admin bot"]) {
    const memberId = agentMembers.find((m) => m.name === name)!.memberId;
    await r.julio.as.mutation(api.members.setRole, { teamId: r.teamId, memberId, role: "admin" });
  }

  expect(await callAsAgent(r.t, userKey, "savedLogins.forget", { savedLoginId })).toMatchObject({
    status: 403,
    error: { message: expect.stringMatching(/team\.admin/) },
  });
  expect(await callAsAgent(r.t, adminKey, "savedLogins.forget", { savedLoginId })).toMatchObject({ ok: true });
});

test("the Hyperbeam adapter makes a new profile in a seed session nobody joins, then loads and saves it by that id", async () => {
  // Hyperbeam's embed URL path is its session id in base64url, so a profile named after a session
  // people join would leak its id to them. A new profile comes from a seed session the room ends at
  // once, whose embed URL goes nowhere; visible sessions load and save it by id.
  const calls: { method: string; url: string; body: any }[] = [];
  let n = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // The start URL opened in the active tab (see the next test) isn't what this test checks.
    if (String(input).includes("/tabs.")) return new Response(JSON.stringify({ result: [] }));
    calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "DELETE") return new Response("", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (method === "GET") {
      return new Response(JSON.stringify({ termination_date: "2026-11-02T23:00:00Z" }), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    n++;
    return new Response(JSON.stringify({ session_id: `s${n}`, embed_url: `https://abc.hyperbeam.com/e${n}?token=t`, admin_token: "a" }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }) as typeof fetch;
  const hb = hyperbeamProvider("key", fetchFn);
  const base = {
    tag: "b",
    startUrl: "https://example.com",
    timeouts: { inactiveSec: 600, offlineSec: 300, absoluteSec: 7200, warningSec: 60 },
    authWebhook: { url: "https://x/a", bearer: "s" },
    timeoutWebhook: { url: "https://x/t", bearer: "s" },
  };

  const fresh = await hb.start({ ...base, profile: "new" });
  expect(fresh).toMatchObject({ sessionId: "s2", profileId: "s1" });
  expect(calls[0]).toMatchObject({ method: "POST", url: "https://engine.hyperbeam.com/v0/vm", body: { profile: true, default_roles: [] } });
  expect(calls[0]!.body).not.toHaveProperty("start_url");
  // The seed answers no join: its auth webhook bearer is one the room never stored.
  expect(calls[0]!.body.auth.value.bearer).not.toBe("s");
  expect(calls[1]).toMatchObject({ method: "DELETE", url: "https://engine.hyperbeam.com/v0/vm/s1" });
  // The seed is confirmed ended before any browser loads its profile.
  expect(calls[2]).toMatchObject({ method: "GET", url: "https://engine.hyperbeam.com/v0/vm/s1" });
  expect(calls[3]).toMatchObject({ method: "POST", body: { start_url: "https://example.com", profile: { load: "s1", save: "s1" } } });

  const again = await hb.start({ ...base, profile: { id: "s1" } });
  expect(again).toMatchObject({ sessionId: "s3", profileId: "s1" });
  expect(calls[4]!.body).toMatchObject({ profile: { load: "s1", save: "s1" } });

  const temporary = await hb.start(base);
  expect(temporary.profileId).toBeUndefined();
  expect(calls[5]!.body).not.toHaveProperty("profile");
});

test("the Hyperbeam adapter hands back a start URL it couldn't apply, and bounds its session calls with a deadline", async () => {
  // Hyperbeam ignores `start_url` when a session loads a profile (seen live, 2026-11-03). Codex review
  // of PR #74: navigating inside start() with no deadline could keep start() from ever returning, so
  // the room never recorded the session. Now start() returns at once, and the room opens the URL.
  vi.useRealTimers();
  const calls: { method: string; url: string }[] = [];
  let n = 0;
  const text = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "text/plain; charset=utf-8" } });
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    // The session endpoints stall, and only a deadline's abort ends the wait.
    if (url.includes("/tabs.") || url.includes("Roles") || url.includes("/users/")) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (method === "DELETE") return Promise.resolve(new Response(""));
    if (method === "GET") return Promise.resolve(text({ termination_date: "2026-11-03T19:00:00Z" }));
    n++;
    return Promise.resolve(text({ session_id: `s${n}`, embed_url: `https://abc.hyperbeam.com/e${n}?token=t`, admin_token: `a${n}` }));
  }) as typeof fetch;
  const hb = hyperbeamProvider("key", fetchFn, { sessionCallTimeoutMs: 50 });
  const base = {
    tag: "b",
    startUrl: "https://staging.example.com/admin",
    timeouts: { inactiveSec: 600, offlineSec: 300, absoluteSec: 7200, warningSec: 60 },
    authWebhook: { url: "https://x/a", bearer: "s" },
    timeoutWebhook: { url: "https://x/t", bearer: "s" },
  };

  const loaded = await hb.start({ ...base, profile: { id: "p1" } });
  expect(loaded).toMatchObject({ sessionId: "s1", profileId: "p1", openAfterStart: "https://staging.example.com/admin" });
  expect(calls.some((c) => c.url.includes("/tabs."))).toBe(false);

  // A temporary browser opens its start URL through start_url, as before.
  expect(await hb.start(base)).not.toHaveProperty("openAfterStart");

  // Opening a URL, changing roles and disconnecting give up at their deadline instead of waiting forever.
  await expect(hb.openUrl(loaded, "https://example.com")).rejects.toThrow(/didn't answer within/);
  await expect(hb.setControl(loaded, [])).rejects.toThrow(/didn't answer within/);
  await expect(hb.disconnect(loaded, ["u1"])).rejects.toThrow(/didn't answer within/);
});

test("a browser loading saved logins is recorded live first, then the room opens its start URL", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "live" });
  expect(fake.opened).toEqual([{ sessionId: "session-1", url: "https://staging.example.com/admin" }]);
  await endBrowser(r, browserId);

  // If opening the URL fails, the browser still runs; anyone can open it.
  fake.failNextOpenUrl();
  const next = (await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    url: "https://vendor.example.com",
    savedLoginId,
  })) as Id<"browsers">;
  await settle(r.t);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId: next })).toMatchObject({ status: "live" });
});

test("if the seed session can't be confirmed ended, no browser starts with its profile", async () => {
  // A seed still running would save its empty profile when its own timeout ends it, which could be
  // after a short-lived browser saved real logins to the same id, wiping them.
  const calls: { method: string; url: string }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    if (method === "DELETE") return new Response("upstream error", { status: 502 });
    if (method === "GET") return new Response(JSON.stringify({ termination_date: null }), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(JSON.stringify({ session_id: "seed", embed_url: "https://abc.hyperbeam.com/e?token=t", admin_token: "a" }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }) as typeof fetch;
  const hb = hyperbeamProvider("key", fetchFn, { retryDelayMs: 0 });
  await expect(
    hb.start({
      tag: "b",
      profile: "new",
      timeouts: { inactiveSec: 600, offlineSec: 300, absoluteSec: 7200, warningSec: 60 },
      authWebhook: { url: "https://x/a", bearer: "s" },
      timeoutWebhook: { url: "https://x/t", bearer: "s" },
    }),
  ).rejects.toThrow(/Couldn't finish setting up saved logins/);
  // Only the seed was created; no visible browser was started with its profile.
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("when Hyperbeam hasn't enabled profiles for the account, starting with saved logins fails and says so", async () => {
  // What the dev key answered live on 2026-11-02 to every form of `profile`.
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        code: "err_api_restricted",
        message: "A feature you are trying to use is restricted, please contact founders@hyperbeam.com to get it enabled",
      }),
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    )) as typeof fetch;
  const hb = hyperbeamProvider("key", fetchFn);
  const base = {
    tag: "b",
    timeouts: { inactiveSec: 600, offlineSec: 300, absoluteSec: 7200, warningSec: 60 },
    authWebhook: { url: "https://x/a", bearer: "s" },
    timeoutWebhook: { url: "https://x/t", bearer: "s" },
  };
  await expect(hb.start({ ...base, profile: "new" })).rejects.toThrow(
    /Hyperbeam hasn't turned on saved logins \(profiles\) for this account/,
  );
  // Without saved logins the same refusal is passed on as Hyperbeam said it.
  await expect(hb.start(base)).rejects.toThrow(/err_api_restricted/);
});

test("a person can change and forget the saved logins their agent saved, and a teammate can't", async () => {
  const r = await room();
  const { key } = await addAgent(r.t, r.teamId, r.ana, "Ana's helper", ["room.read", "browsers.use"]);
  const started = await callAsAgent(r.t, key, "browsers.start", {
    channelId: r.channelId,
    newSavedLogin: { name: "helper logins", keep: "7d" },
  });
  expect(started).toMatchObject({ ok: true });
  const [saved] = await r.ana.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  expect(saved).toMatchObject({ savedBy: { name: "Ana's helper", addedBy: { name: "Ana" } } });
  const args = { teamId: r.teamId, savedLoginId: saved!.savedLoginId };

  await expect(r.bo.as.mutation(api.savedLogins.rename, { ...args, name: "bo's now" })).rejects.toThrow(/forbidden/);
  await r.ana.as.mutation(api.savedLogins.rename, { ...args, name: "helper logins (staging)" });
  await r.ana.as.mutation(api.savedLogins.setKeep, { ...args, keep: "30d" });
  await r.ana.as.mutation(api.savedLogins.forget, args);
  expect(await r.ana.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { name: "helper logins (staging)", keep: "30d", status: "forgotten", forgottenBy: { name: "Ana" } },
  ]);
});

test("saved logins past their deadline count as forgotten even before the scheduled job runs", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio, "1d");
  await endBrowser(r, browserId);
  // The deadline passed, and the job that forgets them hasn't run yet.
  const lapse = () => r.t.run(async (ctx) => ctx.db.patch(savedLoginId, { expiresAt: Date.now() - 1 }));
  await lapse();
  await expect(
    r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId }),
  ).rejects.toThrow(/forgotten/i);
  await expect(
    r.julio.as.mutation(api.savedLogins.setKeep, { teamId: r.teamId, savedLoginId, keep: "forever" }),
  ).rejects.toThrow(/forgotten/i);
});

test("saved logins that lapse while their browser starts aren't loaded: it starts temporary", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio, "1d");
  await endBrowser(r, browserId);
  await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId });
  // Between the start and provisioning, the deadline passes.
  await r.t.run(async (ctx) => ctx.db.patch(savedLoginId, { expiresAt: Date.now() - 1 }));
  await settle(r.t);
  expect(fake.started).toHaveLength(2);
  expect(fake.started[1]!.profile).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Erasing forgotten saved logins at Hyperbeam (#76)

/** The saved logins row as the backend holds it, profile id included. */
const row = (r: R, savedLoginId: Id<"savedLogins">) => r.t.run((ctx) => ctx.db.get(savedLoginId));

test("forgetting saved logins erases their Hyperbeam profile once the last browser with them has ended, with one session that loads nothing", async () => {
  // #76: Forget used to drop the profile id and leave the logins at Hyperbeam for three months.
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  await settle(r.t);
  // The browser still runs and will save to the profile, so nothing erases it yet.
  expect(fake.erases).toEqual([]);

  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  await later(r.t, 29_000);
  expect(fake.erases).toEqual([]);
  await later(r.t, 1_000);
  // The browser has ended and saved its logins; then one erase session starts, which saves to the
  // profile and loads nothing.
  expect(fake.isTerminated("session-1")).toBe(true);
  expect(fake.profileContents("profile-1")).toBe("logins");
  expect(fake.erases).toEqual([
    {
      sessionId: "erase-1",
      tag: `${savedLoginId}:erase`,
      profileId: "profile-1",
      authWebhookUrl: expect.stringMatching(/\/hyperbeam\/auth$/),
    },
  ]);

  // It runs as long as a browser runs on to save, then the room ends it and the profile is empty.
  await later(r.t, 25_000);
  expect(fake.isTerminated("erase-1")).toBe(false);
  await later(r.t, 10_000);
  expect(fake.isTerminated("erase-1")).toBe(true);
  expect(fake.profileContents("profile-1")).toBe("empty");
  expect(fake.overlaps).toEqual([]);

  // The room keeps no reference to the profile any more, nothing loads it, and it isn't erased twice.
  const saved = await row(r, savedLoginId);
  expect(saved?.erase).toMatchObject({ state: "erased", erasedAt: expect.any(Number) });
  expect(JSON.stringify(saved)).not.toContain("profile-1");
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  await later(r.t, DAY);
  expect(fake.erases).toHaveLength(1);
  expect(fake.profileLoads("profile-1")).toBe(0);
});

test("saved logins that expire are erased the same way, after a browser still running with them at the deadline has ended", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio, "1d");
  await endBrowser(r, browserId);
  await later(r.t, DAY - HOUR);
  const next = (await r.ana.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId })) as Id<"browsers">;
  await settle(r.t);
  expect(fake.profileLoads("profile-1")).toBe(1);

  // The day runs out while that browser runs.
  await later(r.t, HOUR);
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { status: "forgotten", forgetReason: "expired" },
  ]);
  expect(fake.erases).toEqual([]);

  await endBrowser(r, next);
  expect(fake.isTerminated("session-2")).toBe(true);
  expect(fake.erases).toMatchObject([{ profileId: "profile-1" }]);
  await later(r.t, 35_000);
  expect(fake.profileContents("profile-1")).toBe("empty");
  expect(fake.erases).toHaveLength(1);
  expect(fake.overlaps).toEqual([]);
  expect(fake.profileLoads("profile-1")).toBe(1);
});

test("an erase that fails is tried again with backoff, and Forget doesn't wait for it", async () => {
  const r = await room();
  const { browserId, savedLoginId } = await startKeeping(r, r.julio);
  await endBrowser(r, browserId);
  // Hyperbeam fails the next two starts and the next end.
  fake.failErases(2, 1);
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  expect(await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId })).toMatchObject([
    { status: "forgotten" },
  ]);

  await settle(r.t);
  expect((await row(r, savedLoginId))?.erase).toMatchObject({ state: "pending", tries: 1, lastError: expect.stringMatching(/502/) });
  // Tried again 30 s later, then 60 s after that, when the session starts.
  await later(r.t, 30_000);
  expect(fake.erases).toEqual([]);
  await later(r.t, 60_000);
  expect(fake.erases).toHaveLength(1);
  // 30 s on it is ended; that fails, and works 4 minutes later.
  await later(r.t, 30_000);
  expect(fake.isTerminated("erase-1")).toBe(false);
  await later(r.t, 240_000);
  expect(fake.isTerminated("erase-1")).toBe(true);
  expect(fake.profileContents("profile-1")).toBe("empty");
  expect((await row(r, savedLoginId))?.erase).toMatchObject({ state: "erased", tries: 5 });
  expect(fake.erases).toHaveLength(1);
});

test("saved logins forgotten while their first browser starts still have that browser's new profile erased when it ends", async () => {
  // The room learns a new profile's id only when its browser goes live, after Forget dropped what it knew.
  const r = await room();
  const held = fake.holdNextStart();
  const browserId = (await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    newSavedLogin: { name: "staging admin", keep: "7d" },
  })) as Id<"browsers">;
  vi.advanceTimersByTime(1);
  await held.reached;
  const [saved] = await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId: saved!.savedLoginId });
  held.release();
  await settle(r.t);
  expect(fake.started[0]!.profile).toBe("new");
  expect(fake.erases).toEqual([]);

  await endBrowser(r, browserId);
  expect(fake.erases).toMatchObject([{ profileId: "profile-1" }]);
  await later(r.t, 35_000);
  expect(fake.profileContents("profile-1")).toBe("empty");
  expect(fake.overlaps).toEqual([]);
});

test("the Hyperbeam adapter erases a profile with a session that loads nothing, saves over it and admits nobody, then ends it", async () => {
  vi.useRealTimers();
  const calls: { method: string; url: string; body: any }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "DELETE") return new Response("");
    if (method === "GET") return new Response(JSON.stringify({ termination_date: "2026-11-03T21:00:00Z" }));
    return new Response(JSON.stringify({ session_id: "e1", embed_url: "https://abc.hyperbeam.com/e1?token=t", admin_token: "a" }));
  }) as typeof fetch;
  const hb = hyperbeamProvider("key", fetchFn);

  const erase = await hb.startErase({ tag: "sl1:erase", profileId: "p1", authWebhookUrl: "https://x/hyperbeam/auth" });
  // Only the session id comes back: its embed URL and admin token go nowhere.
  expect(erase).toEqual({ sessionId: "e1" });
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: "https://engine.hyperbeam.com/v0/vm",
    body: { tag: "sl1:erase", profile: { save: "p1" }, default_roles: [], auth: { type: "webhook", value: { url: "https://x/hyperbeam/auth" } } },
  });
  expect(calls[0]!.body.profile).not.toHaveProperty("load");
  expect(calls[0]!.body).not.toHaveProperty("start_url");
  expect(calls[0]!.body.auth.value.bearer).toMatch(/^[0-9a-f-]{36}$/);

  expect(await hb.endErase("e1")).toBe(true);
  expect(calls.slice(1)).toMatchObject([
    { method: "DELETE", url: "https://engine.hyperbeam.com/v0/vm/e1" },
    { method: "GET", url: "https://engine.hyperbeam.com/v0/vm/e1" },
  ]);

  // Each call has a deadline, so a stalled Hyperbeam can't keep a try from reporting back.
  const stalled = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const slow = hyperbeamProvider("key", stalled, { engineCallTimeoutMs: 50 });
  await expect(slow.startErase({ tag: "t", profileId: "p1", authWebhookUrl: "https://x/a" })).rejects.toThrow(/didn't answer within/);
  await expect(slow.endErase("e1")).rejects.toThrow(/didn't answer within/);
});

// ---------------------------------------------------------------------------
// One ordered path for a browser's navigations (#77)

/** Lets the room's in-flight work run while a provider call is held, without waiting for that call. */
async function flush(t: Room, rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    vi.advanceTimersByTime(1);
    for (let j = 0; j < 500; j++) await Promise.resolve();
  }
}

test("a start URL held inside its Hyperbeam call can't land over a URL the driver opens meanwhile", async () => {
  // #77: the deferred start URL passed its check, then its Hyperbeam call returned after a newer openUrl's.
  const r = await room();
  const held = fake.holdNextOpenUrl();
  const browserId = (await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    url: "https://staging.example.com/admin",
    newSavedLogin: { name: "staging admin", keep: "7d" },
  })) as Id<"browsers">;
  // The browser goes live, and opening its start URL is held inside Hyperbeam...
  vi.advanceTimersByTime(1);
  await r.t.finishInProgressScheduledFunctions();
  vi.advanceTimersByTime(1);
  await held.reached;
  // ...while the driver opens another URL, and the room has every chance to open it.
  await r.julio.as.mutation(api.browsers.openUrl, { teamId: r.teamId, browserId, url: "https://vendor.example.com/" });
  await flush(r.t);
  // Then the start URL's call returns, after the driver's request.
  held.release("land");
  await settle(r.t);
  expect(fake.openPage("session-1")).toBe("https://vendor.example.com/");
  expect(fake.opened.map((o) => o.url)).toEqual(["https://staging.example.com/admin", "https://vendor.example.com/"]);
});

test("a navigation whose Hyperbeam call stalls holds up later ones only until its lease runs out", async () => {
  const r = await room();
  const browserId = (await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId })) as Id<"browsers">;
  await settle(r.t);
  const stalled = fake.holdNextOpenUrl();
  const open = (url: string) => r.julio.as.mutation(api.browsers.openUrl, { teamId: r.teamId, browserId, url });
  await open("https://a.example.com/");
  vi.advanceTimersByTime(1);
  await stalled.reached;
  // The driver opens another URL while that call hangs, and its navigation never reports back.
  await open("https://b.example.com/");
  await flush(r.t);
  expect(fake.opened).toEqual([]);

  // Its lease runs out a minute on, and the next navigation opens the latest URL.
  vi.advanceTimersByTime(60_000);
  await flush(r.t);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
  // The stalled call fails at its deadline (well inside the lease, in the real adapter) and lands nothing.
  stalled.release("fail");
  await settle(r.t);
  expect(fake.opened.map((o) => o.url)).toEqual(["https://b.example.com/"]);
});

// ---------------------------------------------------------------------------
// Codex review of PR #79, round 1

test("a start with saved logins whose answer was lost is found by its tag and ended before Forget erases their profile", async () => {
  // Finding 1: the start failed, settling released the erase, and the session Hyperbeam made anyway
  // saved the old logins back after it.
  const r = await room();
  const { browserId: first, savedLoginId } = await startKeeping(r, r.julio);
  await endBrowser(r, first);
  // The next browser with them is starting when they are forgotten...
  const held = fake.holdNextStart();
  fake.loseNextStartAnswer();
  const next = (await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId })) as Id<"browsers">;
  vi.advanceTimersByTime(1);
  await held.reached;
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  // ...then Hyperbeam makes the session, which loads them, and its answer never arrives.
  held.release();
  await settle(r.t);
  expect(fake.tagLookups).toEqual([next]);
  expect(fake.isTerminated("session-2")).toBe(true);
  await later(r.t, 1_000);
  await later(r.t, 35_000);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId: next })).toMatchObject({
    status: "failed",
    failReason: expect.stringMatching(/connection was reset/),
  });
  expect(fake.erases).toHaveLength(1);
  expect(fake.overlaps).toEqual([]);
  expect(fake.profileContents("profile-1")).toBe("empty");
  // Had it run on, Hyperbeam's own timeouts would end it later; nothing saves over the erase.
  fake.terminate("session-2");
  expect(fake.profileContents("profile-1")).toBe("empty");
});

test("logins forgotten while their first browser starts, which is ended before its start returns, still get its new profile erased", async () => {
  // Finding 2: the stopping branch recorded only the session, so the new profile id never reached the saved logins.
  const r = await room();
  const held = fake.holdNextStart();
  const browserId = (await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    newSavedLogin: { name: "staging admin", keep: "7d" },
  })) as Id<"browsers">;
  vi.advanceTimersByTime(1);
  await held.reached;
  const [saved] = await r.julio.as.query(api.savedLogins.list, { teamId: r.teamId, channelId: r.channelId });
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId: saved!.savedLoginId });
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  held.release();
  await settle(r.t);
  expect(fake.isTerminated("session-1")).toBe(true);
  await later(r.t, 1_000);
  await later(r.t, 35_000);
  expect(fake.erases).toMatchObject([{ profileId: "profile-1" }]);
  expect(fake.profileContents("profile-1")).toBe("empty");
  expect(fake.overlaps).toEqual([]);
});

/** A live temporary browser and a way to open URLs in it as its driver. */
async function liveBrowser(r: R) {
  const browserId = (await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId })) as Id<"browsers">;
  await settle(r.t);
  const open = (url: string) => r.julio.as.mutation(api.browsers.openUrl, { teamId: r.teamId, browserId, url });
  return { browserId, open };
}

test("a navigation whose lease ran out while its first Hyperbeam call hung leaves the page alone when that call answers", async () => {
  // Finding 3: the stale navigation went on to open its old URL over the newer one.
  const r = await room();
  const { open } = await liveBrowser(r);
  const late = fake.holdNextOpenUrl("query");
  await open("https://a.example.com/");
  vi.advanceTimersByTime(1);
  await late.reached;
  await open("https://b.example.com/");
  await flush(r.t);
  vi.advanceTimersByTime(60_000);
  await flush(r.t);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
  // Its first call answers now; its lease has passed on, so it doesn't change the page.
  late.release("land");
  await settle(r.t);
  expect(fake.opened.map((o) => o.url)).toEqual(["https://b.example.com/"]);
});

test("a page change that lands after its navigation's lease ran out is followed by the latest URL again", async () => {
  const r = await room();
  const { open } = await liveBrowser(r);
  // Past the fence: the call that changes the page is on its way when it stalls.
  const slow = fake.holdNextOpenUrl("change");
  await open("https://a.example.com/");
  vi.advanceTimersByTime(1);
  await slow.reached;
  await open("https://b.example.com/");
  await flush(r.t);
  vi.advanceTimersByTime(60_000);
  await flush(r.t);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
  // The old change lands after the newer one, and the room opens the latest URL again.
  slow.release("land");
  await settle(r.t);
  expect(fake.opened.map((o) => o.url)).toEqual(["https://b.example.com/", "https://a.example.com/", "https://b.example.com/"]);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
});

test("a URL Hyperbeam fails to open is tried again with backoff, and the browser shows why once the room gives up", async () => {
  // Finding 4: a failed tabs call was swallowed and counted as done.
  const r = await room();
  const { browserId, open } = await liveBrowser(r);
  const view = () => r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId });
  fake.failOpenUrls(2);
  await open("https://a.example.com/");
  await settle(r.t);
  expect(fake.opened).toEqual([]);
  // Tried again 2 s on, then 4 s after that, when it opens.
  await later(r.t, 2_000);
  expect(fake.opened).toEqual([]);
  await later(r.t, 4_000);
  expect(fake.openPage("session-1")).toBe("https://a.example.com/");
  expect((await view()).navigationError).toBeUndefined();

  // Three failures in a row: the room gives up and the browser says why.
  fake.failOpenUrls(3);
  await open("https://b.example.com/");
  await settle(r.t);
  await later(r.t, 2_000);
  await later(r.t, 4_000);
  expect(fake.openPage("session-1")).toBe("https://a.example.com/");
  expect(await view()).toMatchObject({
    navigationError: { url: "https://b.example.com/", message: expect.stringMatching(/didn't answer within 10 s/) },
  });
  // The next URL that opens clears it.
  await open("https://c.example.com/");
  await settle(r.t);
  expect(fake.openPage("session-1")).toBe("https://c.example.com/");
  expect((await view()).navigationError).toBeUndefined();
});

test("navigate jobs queued before the ordered path go through it, and a deferred start URL keeps its guard", async () => {
  // Finding 5: jobs queued before the deploy carried { url, unlessOpenedSince } and failed the new validator.
  const r = await room();
  const { browserId, open } = await liveBrowser(r);
  // The old openUrl counted its open, then queued its job, after a deferred start URL had been queued.
  await r.t.run((ctx) => ctx.db.patch(browserId, { navigationSeq: 1 }));
  await r.t.action(internal.browsers.navigate, { browserId, url: "https://staging.example.com/admin", unlessOpenedSince: 0 });
  await r.t.action(internal.browsers.navigate, { browserId, url: "https://a.example.com/" });
  await settle(r.t);
  expect(fake.opened.map((o) => o.url)).toEqual(["https://a.example.com/"]);
  // A request on the ordered path is newer than any job queued before it, so an old job running late is skipped.
  await open("https://b.example.com/");
  await settle(r.t);
  await r.t.action(internal.browsers.navigate, { browserId, url: "https://old.example.com/" });
  await settle(r.t);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
});

test("the Hyperbeam adapter gives up on a DELETE or a session lookup that stalls, at its deadline", async () => {
  // Finding 6: neither had a deadline, so a stalled call could strand a stopping browser.
  vi.useRealTimers();
  const stalled = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const hb = hyperbeamProvider("key", stalled, { engineCallTimeoutMs: 50 });
  const outcome = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => "answered",
        (e: unknown) => String(e),
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
  expect(await outcome(hb.end("s1"))).toMatch(/didn't answer within/);
  expect(await outcome(hb.hasEnded("s1"))).toMatch(/didn't answer within/);
});

test("the Hyperbeam adapter finds a session whose start answer was lost by starting with its tag, harmlessly if none runs, and ends it", async () => {
  vi.useRealTimers();
  const calls: { method: string; url: string; body: any }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "DELETE") return new Response("");
    if (method === "GET") return new Response(JSON.stringify({ termination_date: "2026-11-03T22:00:00Z" }));
    // A start with a running session's tag answers with that session (no admin token is promised).
    return new Response(JSON.stringify({ session_id: "orphan", embed_url: "https://abc.hyperbeam.com/o?token=t" }));
  }) as typeof fetch;
  const hb = hyperbeamProvider("key", fetchFn);
  expect(await hb.endTagged({ tag: "browser-1", authWebhookUrl: "https://x/hyperbeam/auth" })).toBe(true);
  expect(calls[0]).toMatchObject({ method: "POST", url: "https://engine.hyperbeam.com/v0/vm", body: { tag: "browser-1", default_roles: [] } });
  expect(calls[0]!.body).not.toHaveProperty("profile");
  expect(calls[0]!.body).not.toHaveProperty("start_url");
  expect(calls[0]!.body.auth.value.bearer).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.slice(1)).toMatchObject([
    { method: "DELETE", url: "https://engine.hyperbeam.com/v0/vm/orphan" },
    { method: "GET", url: "https://engine.hyperbeam.com/v0/vm/orphan" },
  ]);
});

test("a stop try that never reports back is tried again a minute on, and the browser keeps why the last one failed", async () => {
  // Finding 6: a stalled DELETE stranded the browser in stopping, and the failure was dropped.
  const r = await room();
  const { browserId } = await liveBrowser(r);
  const row = () => r.t.run((ctx) => ctx.db.get(browserId));
  fake.failEnds(1);
  await r.julio.as.mutation(api.browsers.end, { teamId: r.teamId, browserId });
  await settle(r.t);
  expect(await row()).toMatchObject({ status: "stopping", stopError: expect.stringMatching(/503/) });
  // Tried again 5 s on, where the DELETE stalls and its action never reports back...
  const stalled = fake.holdNextEnd();
  vi.advanceTimersByTime(5_000);
  await flush(r.t);
  await stalled.reached;
  expect((await row())?.status).toBe("stopping");
  // ...so a minute on, the next try starts, and ends it.
  vi.advanceTimersByTime(60_000);
  await flush(r.t);
  expect((await row())?.status).toBe("ended");
  stalled.release();
  await settle(r.t);
  expect((await row())?.status).toBe("ended");
});

// ---------------------------------------------------------------------------
// Codex review of PR #79, round 2

const MINUTE = 60 * 1000;

test("a lost start answer is looked for until the longest its session can run, counted from when provisioning ended", async () => {
  // Round 2, finding 1: the cutoff counted from when the browser row was made, so a session made
  // minutes later could outlive it and save the old logins after the erase.
  const r = await room();
  await r.julio.as.mutation(api.browsers.setSettings, { teamId: r.teamId, longestMinutes: 10 });
  const { browserId: first, savedLoginId } = await startKeeping(r, r.julio);
  await endBrowser(r, first);
  const held = fake.holdNextStart();
  fake.loseNextStartAnswer();
  fake.failTagLookups(1_000);
  const next = (await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId })) as Id<"browsers">;
  vi.advanceTimersByTime(1);
  await held.reached;
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  // Hyperbeam makes the session 8.5 minutes on, and its answer is lost.
  vi.advanceTimersByTime(8.5 * MINUTE);
  await flush(r.t, 10);
  held.release();
  await settle(r.t);
  const status = async () => (await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId: next })).status;
  // Past the old cutoff (11 minutes after the start), the room still holds the saved logins.
  await later(r.t, 3.5 * MINUTE);
  expect(await status()).toBe("stopping");
  expect(fake.erases).toEqual([]);
  // Its offline timeout ends the session at 13:30, as nobody can connect to it.
  await later(r.t, 1.5 * MINUTE);
  fake.terminate("session-2");
  // The room stops looking once no session it started can run: 8:30 + 10 + 5 + 1 minutes.
  await later(r.t, 10 * MINUTE);
  expect(await status()).toBe("stopping");
  await later(r.t, 2 * MINUTE);
  expect(await status()).toBe("failed");
  await later(r.t, 1_000);
  await later(r.t, 35_000);
  expect(fake.erases).toHaveLength(1);
  expect(fake.overlaps).toEqual([]);
  expect(fake.profileContents("profile-1")).toBe("empty");
});

test("a navigation whose lease ran out, with nothing handed on yet, takes it back at the fence and still opens its URL", async () => {
  // Round 2, finding 2: the fence refused, openUrl answered as if it had opened, and the URL was lost.
  const r = await room();
  const { browserId, open } = await liveBrowser(r);
  const late = fake.holdNextOpenUrl("query");
  await open("https://a.example.com/");
  vi.advanceTimersByTime(1);
  await late.reached;
  // The call answers after its lease ran out, before the watch handed the lease on.
  await r.t.run(async (ctx) => {
    const holder = (await ctx.db.get(browserId))!.navigationLease!.holder;
    await ctx.db.patch(browserId, { navigationLease: { holder, until: Date.now() - 1 } });
  });
  late.release("land");
  await settle(r.t);
  expect(fake.openPage("session-1")).toBe("https://a.example.com/");
});

test("a URL asked for while a failed one waits to retry gets a full set of tries of its own", async () => {
  // Round 2, finding 3 (GitHub 4460846942): the retry kept the failed URL's count for the newer one.
  const r = await room();
  const { browserId, open } = await liveBrowser(r);
  fake.failOpenUrls(1);
  await open("https://a.example.com/");
  await settle(r.t);
  // B is asked for during A's 2 s wait, and fails twice before it opens.
  fake.failOpenUrls(2);
  await open("https://b.example.com/");
  for (let i = 0; i < 5; i++) await later(r.t, 2_000);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
  expect((await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId })).navigationError).toBeUndefined();
});

test("two openUrl jobs queued before the ordered path both go through it, in order, so the later one wins", async () => {
  // Round 2, finding 4 (GitHub 4460846961): moving the first set navigationUrl, and the guard dropped the second.
  const r = await room();
  const { browserId } = await liveBrowser(r);
  await r.t.action(internal.browsers.navigate, { browserId, url: "https://a.example.com/" });
  await r.t.action(internal.browsers.navigate, { browserId, url: "https://b.example.com/" });
  await settle(r.t);
  expect(fake.openPage("session-1")).toBe("https://b.example.com/");
});

test("the Hyperbeam adapter gives up on a start or seed call that stalls, at its deadline", async () => {
  // Round 2, finding 5: a stalled start never reached provision's catch.
  vi.useRealTimers();
  const stalled = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const hb = hyperbeamProvider("key", stalled, { startCallTimeoutMs: 50, engineCallTimeoutMs: 50 });
  const outcome = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => "answered",
        (e: unknown) => String(e),
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
  const base = {
    tag: "b",
    timeouts: { inactiveSec: 600, offlineSec: 300, absoluteSec: 7200, warningSec: 60 },
    authWebhook: { url: "https://x/a", bearer: "s" },
    timeoutWebhook: { url: "https://x/t", bearer: "s" },
  };
  expect(await outcome(hb.start(base))).toMatch(/didn't answer within/);
  expect(await outcome(hb.start({ ...base, profile: "new" }))).toMatch(/didn't answer within/);
});

test("a start whose provisioning dies without reporting is recovered by the watchdog scheduled before it ran", async () => {
  // Round 2, finding 5: the browser stayed starting with no recovery, and forgotten logins waited forever.
  const r = await room();
  const { browserId: first, savedLoginId } = await startKeeping(r, r.julio);
  await endBrowser(r, first);
  fake.crashAfterNextStart();
  const next = (await r.julio.as.mutation(api.browsers.start, { teamId: r.teamId, channelId: r.channelId, savedLoginId })) as Id<"browsers">;
  await settle(r.t);
  expect((await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId: next })).status).toBe("starting");
  await r.julio.as.mutation(api.savedLogins.forget, { teamId: r.teamId, savedLoginId });
  // A minute on, the watchdog finds the provisioning job ended without a report, and recovers the start.
  await later(r.t, MINUTE);
  expect(fake.tagLookups).toEqual([next]);
  expect(fake.isTerminated("session-2")).toBe(true);
  await later(r.t, 1_000);
  await later(r.t, 35_000);
  expect(await r.julio.as.query(api.browsers.get, { teamId: r.teamId, browserId: next })).toMatchObject({
    status: "failed",
    failReason: expect.stringMatching(/never finished/),
  });
  expect(fake.erases).toHaveLength(1);
  expect(fake.overlaps).toEqual([]);
  expect(fake.profileContents("profile-1")).toBe("empty");
});
