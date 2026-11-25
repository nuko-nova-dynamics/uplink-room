import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hyperbeamProvider, setBrowserProviderForTests } from "../convex/lib/browserProvider";
import { fakeBrowserProvider, type FakeBrowserProvider } from "./fakeBrowserProvider";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { addAgent, addTeammate, callAsAgent, modules, newRoom, newTeam, type Room } from "./setup";

/** Spec #7: shared browsers, tested at the Room API with a fake provider. */

const MINUTE = 60 * 1000;
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

async function room(t: Room = newRoom()) {
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const bo = await addTeammate(t, teamId, julio, "Bo");
  const channels = await julio.as.query(api.channels.list, { teamId });
  const channelId = channels.find((c) => c.name === "general")!.channelId;
  return { t, teamId, julio, ana, bo, channelId };
}

/** Julio starts a live browser in #general at this access. */
async function liveBrowser(access: "watch" | "suggest" | "drive" | "open" = "drive", t?: Room) {
  const r = await room(t);
  const browserId = await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    url: "https://staging.example.com",
    access,
  });
  await settle(r.t);
  return { ...r, browserId: browserId as Id<"browsers"> };
}

/** Hyperbeam asks our auth webhook whether a connection may join, the way its SDK does with `webhookUserdata`. */
async function hyperbeamAsks(t: Room, startIndex: number, hbUserId: string, ticket: string, bearer?: string) {
  const response = await t.fetch("/hyperbeam/auth", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer ?? fake.started[startIndex]!.authWebhook.bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ user_id: hbUserId, userdata: { ticket } }),
  });
  return { status: response.status, ...((await response.json()) as { authorized?: boolean }) };
}

/** A person joins: gets a ticket from the Room API, and Hyperbeam checks it. */
async function joins(t: Room, who: { as: any }, teamId: Id<"teams">, browserId: Id<"browsers">, hbUserId: string) {
  const { ticket } = await who.as.mutation(api.browsers.join, { teamId, browserId });
  const answer = await hyperbeamAsks(t, 0, hbUserId, ticket);
  await settle(t);
  return answer;
}

test("without HYPERBEAM_API_KEY, shared browsers say they're not configured and won't start", async () => {
  setBrowserProviderForTests(null);
  const { julio, teamId, channelId } = await room();
  expect(await julio.as.query(api.browsers.settings, { teamId })).toMatchObject({
    configured: false,
    envVar: "HYPERBEAM_API_KEY",
  });
  await expect(julio.as.mutation(api.browsers.start, { teamId, channelId })).rejects.toThrow(/not_configured/);
});

test("a started browser goes live with its starter driving, and never shows its embed URL or admin token", async () => {
  const r = await room();
  const browserId = await r.julio.as.mutation(api.browsers.start, {
    teamId: r.teamId,
    channelId: r.channelId,
    url: "https://staging.example.com",
  });
  expect(await r.ana.as.query(api.browsers.get, { teamId: r.teamId, browserId })).toMatchObject({ status: "starting" });

  await settle(r.t);

  const view = await r.ana.as.query(api.browsers.get, { teamId: r.teamId, browserId });
  expect(view).toMatchObject({
    status: "live",
    access: "drive",
    startedBy: { name: "Julio" },
    driver: { name: "Julio" },
    channel: { name: "general" },
    startUrl: "https://staging.example.com",
  });
  const listed = await r.ana.as.query(api.browsers.list, { teamId: r.teamId });
  expect(listed).toHaveLength(1);
  for (const shown of [JSON.stringify(view), JSON.stringify(listed)]) {
    expect(shown).not.toContain("admin-1");
    expect(shown).not.toContain("embed-1");
    expect(shown).not.toContain("session-1");
  }

  // Hyperbeam was asked for a browser in which nobody may click yet, with our webhooks and timeouts.
  expect(fake.started).toHaveLength(1);
  expect(fake.started[0]).toMatchObject({
    tag: browserId,
    startUrl: "https://staging.example.com",
    timeouts: { inactiveSec: 10 * 60, offlineSec: 5 * 60, absoluteSec: 120 * 60, warningSec: 60 },
  });
  expect(fake.started[0]!.authWebhook.url).toMatch(/\/hyperbeam\/auth$/);
  expect(fake.started[0]!.timeoutWebhook.url).toMatch(/\/hyperbeam\/timeout$/);
});

test("starting a browser in a channel that has one returns the live one instead of paying for two", async () => {
  const { t, teamId, ana, channelId, browserId } = await liveBrowser();
  expect(await ana.as.mutation(api.browsers.start, { teamId, channelId })).toBe(browserId);
  await settle(t);
  expect(fake.started).toHaveLength(1);
});

test("starting beyond the team's live-browser limit fails with a clear reason", async () => {
  const { t, teamId, julio, channelId } = await room();
  await julio.as.mutation(api.browsers.setSettings, { teamId, maxLive: 1 });
  await julio.as.mutation(api.browsers.start, { teamId, channelId });
  const other = await julio.as.mutation(api.channels.create, { teamId, name: "design" });
  await expect(julio.as.mutation(api.browsers.start, { teamId, channelId: other })).rejects.toThrow(
    /1 shared browser.*live/i,
  );
  await settle(t);
  expect(fake.started).toHaveLength(1);
});

test("a provider failure marks the browser failed, with the reason", async () => {
  const { t, teamId, julio, channelId } = await room();
  fake.failNextStart("Hyperbeam answered 402: out of minutes");
  const browserId = await julio.as.mutation(api.browsers.start, { teamId, channelId });
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({
    status: "failed",
    endReason: "failed",
    failReason: "Hyperbeam answered 402: out of minutes",
  });
  expect(await julio.as.query(api.browsers.list, { teamId })).toEqual([]);
});

test("joining needs a fresh ticket: Hyperbeam is told yes once, and no for a reused, foreign or forged one", async () => {
  const { t, teamId, ana, bo, browserId } = await liveBrowser();
  const { ticket, embedUrl } = await ana.as.mutation(api.browsers.join, { teamId, browserId });
  expect(embedUrl).toBe("https://fake1.hyperbeam.test/s1?token=embed-1");

  expect(await hyperbeamAsks(t, 0, "hb-ana", ticket)).toMatchObject({ status: 200, authorized: true });
  // The same ticket can't let a second connection in.
  expect(await hyperbeamAsks(t, 0, "hb-stranger", ticket)).toMatchObject({ authorized: false });
  // A leaked embed URL without a ticket gets nobody in.
  expect(await hyperbeamAsks(t, 0, "hb-stranger", "")).toMatchObject({ authorized: false });
  // A request that doesn't carry this browser's secret isn't from Hyperbeam.
  const { ticket: boTicket } = await bo.as.mutation(api.browsers.join, { teamId, browserId });
  expect(await hyperbeamAsks(t, 0, "hb-bo", boTicket, "wrong-secret")).toMatchObject({ status: 401, authorized: false });
  // A ticket older than two minutes has expired.
  vi.advanceTimersByTime(3 * MINUTE);
  expect(await hyperbeamAsks(t, 0, "hb-bo", boTicket)).toMatchObject({ authorized: false });
});

test("only the driver's connections can use the mouse and keyboard, after every join and wheel change", async () => {
  const { t, teamId, julio, ana, browserId } = await liveBrowser("open");
  await joins(t, julio, teamId, browserId, "hb-julio");
  await joins(t, ana, teamId, browserId, "hb-ana");
  expect(fake.controllers("session-1")).toEqual(["hb-julio"]);

  await ana.as.mutation(api.browsers.takeWheel, { teamId, browserId });
  await settle(t);
  expect(fake.controllers("session-1")).toEqual(["hb-ana"]);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Ana" } });
});

test("access works as for terminals: Watch, Suggest, Drive and Open each allow what they say", async () => {
  // Watch: teammates can't suggest or ask for the wheel.
  {
    const { teamId, ana, browserId } = await liveBrowser("watch");
    await expect(ana.as.mutation(api.browsers.suggestUrl, { teamId, browserId, url: "https://a.example" })).rejects.toThrow(/watch/);
    await expect(ana.as.mutation(api.browsers.requestWheel, { teamId, browserId })).rejects.toThrow(/watch/);
    await expect(ana.as.mutation(api.browsers.takeWheel, { teamId, browserId })).rejects.toThrow(/watch/);
  }
  // Suggest: a teammate suggests a URL; only the driver opens it.
  {
    const { t, teamId, julio, ana, browserId } = await liveBrowser("suggest");
    const suggestionId = await ana.as.mutation(api.browsers.suggestUrl, { teamId, browserId, url: "https://docs.example.com" });
    expect(await julio.as.query(api.browsers.suggestions, { teamId, browserId })).toMatchObject([
      { suggestionId, url: "https://docs.example.com", from: { name: "Ana" } },
    ]);
    await expect(ana.as.mutation(api.browsers.openSuggestion, { teamId, suggestionId })).rejects.toThrow(/driver/);
    await julio.as.mutation(api.browsers.openSuggestion, { teamId, suggestionId });
    await settle(t);
    expect(fake.opened.map((o) => o.url)).toEqual(["https://docs.example.com"]);
    expect(await julio.as.query(api.browsers.suggestions, { teamId, browserId })).toEqual([]);
    await expect(ana.as.mutation(api.browsers.requestWheel, { teamId, browserId })).rejects.toThrow(/suggest/);
  }
  // Drive: a teammate asks for the wheel and the driver hands it over.
  {
    const { teamId, julio, ana, browserId } = await liveBrowser("drive");
    await expect(ana.as.mutation(api.browsers.takeWheel, { teamId, browserId })).rejects.toThrow(/ask the driver/);
    const requestId = await ana.as.mutation(api.browsers.requestWheel, { teamId, browserId });
    expect(await julio.as.query(api.browsers.wheelRequests, { teamId, browserId })).toMatchObject([{ requestId, from: { name: "Ana" } }]);
    await julio.as.mutation(api.browsers.answerWheelRequest, { teamId, requestId, grant: true });
    expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Ana" } });
  }
  // Open: anyone takes the wheel at once.
  {
    const { teamId, bo, browserId, julio } = await liveBrowser("open");
    await bo.as.mutation(api.browsers.takeWheel, { teamId, browserId });
    expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Bo" } });
  }
});

test("on a Watch browser the wheel can only go back to whoever started it", async () => {
  const { teamId, julio, ana, browserId } = await liveBrowser("watch");
  await expect(julio.as.mutation(api.browsers.passWheel, { teamId, browserId, to: ana.memberId })).rejects.toThrow(/watch/);
});

test("only the driver opens URLs, and only http and https ones", async () => {
  const { t, teamId, julio, ana, browserId } = await liveBrowser("drive");
  await expect(ana.as.mutation(api.browsers.openUrl, { teamId, browserId, url: "https://a.example" })).rejects.toThrow(/driver/);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
    await expect(julio.as.mutation(api.browsers.openUrl, { teamId, browserId, url })).rejects.toThrow(/http/);
  }
  await julio.as.mutation(api.browsers.openUrl, { teamId, browserId, url: "https://pr.example.com/42" });
  await settle(t);
  expect(fake.opened).toEqual([{ sessionId: "session-1", url: "https://pr.example.com/42" }]);
});

test("access can't exceed the team's limit, and lowering the limit lowers live browsers", async () => {
  const { teamId, julio, ana, browserId } = await liveBrowser("open");
  const requestId = await ana.as.mutation(api.browsers.requestWheel, { teamId, browserId });
  await expect(ana.as.mutation(api.browsers.setSettings, { teamId, mostOpenAccess: "watch" })).rejects.toThrow(/admin/);

  await julio.as.mutation(api.browsers.setSettings, { teamId, mostOpenAccess: "suggest" });

  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ access: "suggest", loweredFrom: "open" });
  expect(await julio.as.query(api.browsers.wheelRequests, { teamId, browserId })).toEqual([]);
  await expect(julio.as.mutation(api.browsers.answerWheelRequest, { teamId, requestId, grant: true })).rejects.toThrow();
  await expect(julio.as.mutation(api.browsers.setAccess, { teamId, browserId, access: "drive" })).rejects.toThrow(/at most suggest/);
  // Only whoever started it can raise it; anyone else can't change it.
  await expect(ana.as.mutation(api.browsers.setAccess, { teamId, browserId, access: "watch" })).rejects.toThrow(/started/);
});

test("ending a browser stops it at Hyperbeam and says who ended it; teammates who didn't start or drive it can't", async () => {
  const { t, teamId, julio, ana, browserId } = await liveBrowser();
  await expect(ana.as.mutation(api.browsers.end, { teamId, browserId })).rejects.toThrow(/started/);
  await julio.as.mutation(api.browsers.end, { teamId, browserId });
  await settle(t);
  expect(fake.ended).toEqual(["session-1"]);
  expect(await ana.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({
    status: "ended",
    endReason: "ended",
    endedBy: { name: "Julio" },
  });
  await expect(ana.as.mutation(api.browsers.join, { teamId, browserId })).rejects.toThrow(/ended/);
});

test("a timeout from Hyperbeam ends the browser as idle, but a warning alone doesn't", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser();
  const bearer = fake.started[0]!.timeoutWebhook.bearer;
  const timeout = (type: string) =>
    t.fetch("/hyperbeam/timeout", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-1", type }),
    });

  // Hyperbeam also calls the webhook to warn; the session is still running then.
  expect((await timeout("inactive")).status).toBe(200);
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "live" });

  fake.terminate("session-1");
  await timeout("inactive");
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "ended", endReason: "idle" });
});

test("the room ends a browser at its longest session even if Hyperbeam's webhook never arrives", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser();
  vi.advanceTimersByTime(120 * MINUTE);
  await settle(t);
  expect(fake.ended).toEqual(["session-1"]);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({
    status: "ended",
    endReason: "longest_session",
  });
  const settings = await julio.as.query(api.browsers.settings, { teamId });
  expect(settings).toMatchObject({ configured: true, live: 0, minutesThisMonth: 120 });
});

test("an agent needs the shared-browser scope, and with it can start, open URLs and pass the wheel over HTTP", async () => {
  const { t, teamId, julio, ana, channelId } = await room();
  const { key: reader } = await addAgent(t, teamId, julio, "Notetaker");
  const denied = await callAsAgent(t, reader, "browsers.start", { channelId });
  expect(denied).toMatchObject({ status: 403, ok: false });

  const { key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "browsers.use"]);
  const started = await callAsAgent(t, key, "browsers.start", { channelId, url: "https://status.example.com", access: "drive" });
  expect(started).toMatchObject({ ok: true });
  const browserId = started.result as Id<"browsers">;
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({
    driver: { name: "Hermes", kind: "agent", addedBy: { name: "Julio" } },
  });

  expect(await callAsAgent(t, key, "browsers.openUrl", { browserId, url: "https://status.example.com/incidents" })).toMatchObject({ ok: true });
  await settle(t);
  expect(fake.opened.at(-1)).toEqual({ sessionId: "session-1", url: "https://status.example.com/incidents" });
  // While an agent drives, no person's connection has control.
  await joins(t, ana, teamId, browserId, "hb-ana");
  expect(fake.controllers("session-1")).toEqual([]);

  expect(await callAsAgent(t, key, "browsers.passWheel", { browserId, to: ana.memberId })).toMatchObject({ ok: true });
  await settle(t);
  expect(fake.controllers("session-1")).toEqual(["hb-ana"]);
});

test("the Hyperbeam adapter sends the documented requests", async () => {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // Hyperbeam labels its JSON answers text/plain (seen live on 2026-11-02), so the adapter can't go by the header.
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url === "https://engine.hyperbeam.com/v0/vm") {
      return json({ session_id: "s1", embed_url: "https://abc.hyperbeam.com/xyz?token=t", admin_token: "adm" });
    }
    // Session endpoints wrap their answer in `result`, as Hyperbeam did live.
    if (url.endsWith("/tabs.query")) return json({ result: [{ id: 7, active: true, url: "https://example.com/" }] });
    if (url.includes("/v0/vm/s1") && (init?.method ?? "GET") === "GET") return json({ termination_date: null });
    if (url.includes("/v0/vm/s0") && (init?.method ?? "GET") === "GET") return json({ termination_date: "2026-11-02T23:00:00Z" });
    return json({});
  }) as typeof fetch;
  const hb = hyperbeamProvider("key-123", fetchFn);

  const session = await hb.start({
    tag: "b1",
    startUrl: "https://example.com",
    timeouts: { inactiveSec: 600, offlineSec: 300, absoluteSec: 7200, warningSec: 60 },
    authWebhook: { url: "https://x.convex.site/hyperbeam/auth", bearer: "sec" },
    timeoutWebhook: { url: "https://x.convex.site/hyperbeam/timeout", bearer: "sec" },
  });
  await hb.setControl(session, ["u1"]);
  await hb.openUrl(session, "https://example.com/2");
  expect(await hb.hasEnded("s1")).toBe(false);
  expect(await hb.hasEnded("s0")).toBe(true);
  await hb.disconnect(session, ["u2"]);
  await hb.end("s1");

  expect(calls[0]).toMatchObject({
    method: "POST",
    url: "https://engine.hyperbeam.com/v0/vm",
    auth: "Bearer key-123",
    body: {
      start_url: "https://example.com",
      tag: "b1",
      default_roles: [],
      auth: { type: "webhook", value: { url: "https://x.convex.site/hyperbeam/auth", bearer: "sec" } },
      timeout: { inactive: 600, offline: 300, absolute: 7200, warning: 60 },
    },
  });
  // Session endpoints use the admin token at the embed URL without its query string.
  expect(calls.slice(1, 3)).toEqual([
    { method: "POST", url: "https://abc.hyperbeam.com/xyz/removeRoles", auth: "Bearer adm", body: [["u1"], ["control", "clipboard_copy"], true] },
    { method: "POST", url: "https://abc.hyperbeam.com/xyz/addRoles", auth: "Bearer adm", body: [["u1"], ["control", "clipboard_copy"]] },
  ]);
  expect(calls[4]).toMatchObject({ url: "https://abc.hyperbeam.com/xyz/tabs.update", body: [7, { url: "https://example.com/2" }] });
  expect(calls.at(-2)).toMatchObject({ method: "DELETE", url: "https://abc.hyperbeam.com/xyz/users/u2", auth: "Bearer adm" });
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://engine.hyperbeam.com/v0/vm/s1", auth: "Bearer key-123" });
});

// ---------------------------------------------------------------------------
// Review fixes (PR #20)

test("overlapping wheel changes leave only the latest driver with control, though Hyperbeam's add is additive", async () => {
  const { t, teamId, julio, ana, bo, browserId } = await liveBrowser("open");
  await joins(t, julio, teamId, browserId, "hb-julio");
  await joins(t, ana, teamId, browserId, "hb-ana");
  await joins(t, bo, teamId, browserId, "hb-bo");

  // Ana takes the wheel; her control update stops between its remove and add calls...
  const paused = fake.pauseNextControlUpdate();
  await ana.as.mutation(api.browsers.takeWheel, { teamId, browserId });
  vi.advanceTimersByTime(1);
  await paused.reached;
  // ...while Bo takes it.
  await bo.as.mutation(api.browsers.takeWheel, { teamId, browserId });
  // Let any update Bo's change started run as far as it can before Ana's finishes.
  vi.advanceTimersByTime(1);
  for (let i = 0; i < 500; i++) await Promise.resolve();
  paused.release();
  await settle(t);

  expect(fake.controllers("session-1")).toEqual(["hb-bo"]);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Bo" } });
});

test("removing a teammate refuses their unused ticket, cuts their connection, and gives the wheel back", async () => {
  const { t, teamId, julio, ana, browserId } = await liveBrowser("open");
  await joins(t, julio, teamId, browserId, "hb-julio");
  await joins(t, ana, teamId, browserId, "hb-ana");
  await ana.as.mutation(api.browsers.takeWheel, { teamId, browserId });
  await settle(t);
  expect(fake.controllers("session-1")).toEqual(["hb-ana"]);
  const { ticket: spare } = await ana.as.mutation(api.browsers.join, { teamId, browserId });

  await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
  await settle(t);

  expect(fake.disconnected).toEqual([{ sessionId: "session-1", userId: "hb-ana" }]);
  expect(await hyperbeamAsks(t, 0, "hb-ana-again", spare)).toMatchObject({ authorized: false });
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Julio" } });
  expect(fake.controllers("session-1")).toEqual(["hb-julio"]);
});

test("a ticket a person got before deleting their account is refused, before the steps that take them out of the team run (ADR 0035)", async () => {
  const { t, teamId, ana, browserId } = await liveBrowser("open");
  const { ticket } = await ana.as.mutation(api.browsers.join, { teamId, browserId });
  // Fake timers hold back the scheduled cleanup: Ana is still a member of the team.
  await t.mutation(internal.accounts.deleteFromClerk, { deliveryId: "msg_ana_deleted", subject: "user_Ana" });
  expect(await hyperbeamAsks(t, 0, "hb-ana", ticket)).toMatchObject({ authorized: false });
});

test("revoking an agent's key refuses its tickets and cuts its connections", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser("drive");
  const { agentId, key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "browsers.use"]);
  const joined = await callAsAgent(t, key, "browsers.join", { browserId });
  expect(await hyperbeamAsks(t, 0, "hb-hermes", joined.result.ticket)).toMatchObject({ authorized: true });
  const spare = (await callAsAgent(t, key, "browsers.join", { browserId })).result.ticket as string;

  const { keyId } = (await julio.as.query(api.agents.keys, { teamId, agentId }))[0]!;
  await julio.as.mutation(api.agents.revokeKey, { teamId, keyId });
  await settle(t);

  expect(fake.disconnected).toEqual([{ sessionId: "session-1", userId: "hb-hermes" }]);
  expect(await hyperbeamAsks(t, 0, "hb-hermes-2", spare)).toMatchObject({ authorized: false });
});

test("lowering access below Drive gives the wheel back to whoever started the browser", async () => {
  const { t, teamId, julio, ana, browserId } = await liveBrowser("open");
  await joins(t, julio, teamId, browserId, "hb-julio");
  await joins(t, ana, teamId, browserId, "hb-ana");
  await ana.as.mutation(api.browsers.takeWheel, { teamId, browserId });
  await settle(t);

  await julio.as.mutation(api.browsers.setAccess, { teamId, browserId, access: "watch" });
  await settle(t);

  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Julio" } });
  expect(fake.controllers("session-1")).toEqual(["hb-julio"]);
});

test("a browser Hyperbeam ended without a webhook is found at the idle window and frees its slot", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser();
  fake.terminate("session-1");
  vi.advanceTimersByTime(10 * MINUTE);
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({
    status: "ended",
    endReason: "timed_out",
  });
  expect((await julio.as.query(api.browsers.settings, { teamId })).live).toBe(0);
});

test("a start that hits the limit checks whether the live browsers really are, so the next start can go ahead", async () => {
  const { t, teamId, julio, channelId, browserId } = await liveBrowser();
  await julio.as.mutation(api.browsers.setSettings, { teamId, maxLive: 1 });
  const other = await julio.as.mutation(api.channels.create, { teamId, name: "design" });
  // Hyperbeam ends it a few minutes later, and its webhook never arrives.
  vi.advanceTimersByTime(2 * MINUTE);
  fake.terminate("session-1");

  // The start is accepted, and asks Hyperbeam about the live browser before claiming its slot.
  const next = await julio.as.mutation(api.browsers.start, { teamId, channelId: other });
  await settle(t);

  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "ended", endReason: "timed_out" });
  expect(await julio.as.query(api.browsers.get, { teamId, browserId: next })).toMatchObject({ status: "live" });
  expect(fake.started).toHaveLength(2);

  // With every live browser just checked, a start beyond the limit fails at once.
  const third = await julio.as.mutation(api.channels.create, { teamId, name: "ops" });
  await expect(julio.as.mutation(api.browsers.start, { teamId, channelId: third })).rejects.toThrow(/live at once/);
  void channelId;
});

test("ending holds the slot as Stopping and retries until Hyperbeam confirms the browser is gone", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser();
  await julio.as.mutation(api.browsers.setSettings, { teamId, maxLive: 1 });
  const other = await julio.as.mutation(api.channels.create, { teamId, name: "design" });
  fake.failEnds(2);

  await julio.as.mutation(api.browsers.end, { teamId, browserId });
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "stopping", endReason: "ended" });
  // Still running at Hyperbeam, so it still counts.
  await expect(julio.as.mutation(api.browsers.start, { teamId, channelId: other })).rejects.toThrow(/live at once/);

  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(MINUTE);
    await settle(t);
  }
  expect(fake.ended).toEqual(["session-1"]);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "ended", endReason: "ended" });
  await julio.as.mutation(api.browsers.start, { teamId, channelId: other });
});

// ---------------------------------------------------------------------------
// Review round 2 (PR #20)

test("removing a teammate cuts their connection to a browser that is still stopping", async () => {
  const { t, teamId, julio, ana, browserId } = await liveBrowser("drive");
  await joins(t, ana, teamId, browserId, "hb-ana");
  fake.failEnds(1);
  await julio.as.mutation(api.browsers.end, { teamId, browserId });
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "stopping" });

  await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
  await settle(t);

  expect(fake.disconnected).toEqual([{ sessionId: "session-1", userId: "hb-ana" }]);
});

test("a browser ended before it was provisioned never gets a session and frees its slot", async () => {
  const { t, teamId, julio, channelId } = await room();
  await julio.as.mutation(api.browsers.setSettings, { teamId, maxLive: 1 });
  const browserId = await julio.as.mutation(api.browsers.start, { teamId, channelId });
  await julio.as.mutation(api.browsers.end, { teamId, browserId });
  await settle(t);

  expect(fake.started).toEqual([]);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "ended", endReason: "ended" });
  const next = await julio.as.mutation(api.browsers.start, { teamId, channelId });
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId: next })).toMatchObject({ status: "live" });
});

test("revoking a driving agent's last shared-browser key gives the wheel back, and says so in the activity log", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser("open");
  await joins(t, julio, teamId, browserId, "hb-julio");
  const { agentId, key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "browsers.use"]);
  // A second key without the scope doesn't let it keep driving.
  await julio.as.mutation(api.agents.createKey, { teamId, agentId, name: "reader", scopes: ["room.read"] });
  expect(await callAsAgent(t, key, "browsers.takeWheel", { browserId })).toMatchObject({ ok: true });
  await settle(t);
  expect(fake.controllers("session-1")).toEqual([]);

  const keys = await julio.as.query(api.agents.keys, { teamId, agentId });
  const usable = keys.find((k) => k.scopes.includes("browsers.use"))!;
  await julio.as.mutation(api.agents.revokeKey, { teamId, keyId: usable.keyId });
  await settle(t);

  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Julio" } });
  expect(fake.controllers("session-1")).toEqual(["hb-julio"]);
  const log = await julio.as.query(api.activity.list, { teamId, limit: 20 });
  expect(log.some((e) => e.action === "browser.driver_changed" && e.actor.name === "Julio")).toBe(true);
});

test("an agent that still holds another shared-browser key keeps the wheel when one key is revoked", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser("open");
  const { agentId, key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "browsers.use"]);
  await julio.as.mutation(api.agents.createKey, { teamId, agentId, name: "spare", scopes: ["browsers.use"] });
  await callAsAgent(t, key, "browsers.takeWheel", { browserId });
  const keys = await julio.as.query(api.agents.keys, { teamId, agentId });
  await julio.as.mutation(api.agents.revokeKey, { teamId, keyId: keys.find((k) => k.name === "test")!.keyId });
  await settle(t);
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Hermes" } });
});

test("revoking a key reads only the agent's unrevoked keys, however many it revoked before", async () => {
  // A function that reads more than this many documents fails, as Convex's own limit does at 32,000.
  const limited = convexTest({ schema, modules, transactionLimits: { documentsRead: 2_000 } }) as Room;
  const { t, teamId, julio, browserId } = await liveBrowser("open", limited);
  const { agentId, key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "browsers.use"]);
  await julio.as.mutation(api.agents.createKey, { teamId, agentId, name: "spare", scopes: ["browsers.use"] });
  await callAsAgent(t, key, "browsers.takeWheel", { browserId });
  await t.run(async (ctx) => {
    const agent = (await ctx.db.get(agentId))!;
    for (let i = 0; i < 2_500; i++) {
      await ctx.db.insert("agentKeys", {
        teamId,
        agentId,
        name: `old ${i}`,
        hash: `revoked-${i}`,
        prefix: "urk_old",
        scopes: ["browsers.use"],
        createdBy: agent.addedBy,
        createdAt: Date.now(),
        revokedAt: Date.now(),
      });
    }
  });
  const keyId = await t.run(async (ctx) => (await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", agentId)).first())!._id);
  await julio.as.mutation(api.agents.revokeKey, { teamId, keyId });
  await settle(t);
  // The spare key still may drive, so Hermes keeps the wheel.
  expect(await julio.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Hermes" } });
});

test("in a private channel, only members start or join its browser; one removed loses their ticket, connection and the wheel", async () => {
  const { t, teamId, julio, ana, bo } = await room();
  const channelId = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [bo.memberId] });
  // Julio is an admin, and not in it.
  await expect(julio.as.mutation(api.browsers.start, { teamId, channelId })).rejects.toThrow(/Not found/);
  const browserId = (await ana.as.mutation(api.browsers.start, { teamId, channelId, access: "open" })) as Id<"browsers">;
  await settle(t);
  await expect(julio.as.mutation(api.browsers.join, { teamId, browserId })).rejects.toThrow(/Not found/);
  await expect(julio.as.query(api.browsers.get, { teamId, browserId })).rejects.toThrow(/Not found/);
  expect(await julio.as.query(api.browsers.list, { teamId })).toEqual([]);

  await joins(t, ana, teamId, browserId, "hb-ana");
  await joins(t, bo, teamId, browserId, "hb-bo");
  await bo.as.mutation(api.browsers.takeWheel, { teamId, browserId });
  await settle(t);
  const { ticket: spare } = await bo.as.mutation(api.browsers.join, { teamId, browserId });

  await ana.as.mutation(api.channels.removeMember, { teamId, channelId, memberId: bo.memberId });
  await settle(t);
  expect(fake.disconnected).toEqual([{ sessionId: "session-1", userId: "hb-bo" }]);
  expect(await hyperbeamAsks(t, 0, "hb-bo-again", spare)).toMatchObject({ authorized: false });
  expect(await ana.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ driver: { name: "Ana" } });
  expect(fake.controllers("session-1")).toEqual(["hb-ana"]);
});

test("when a private channel's browser starter, also its driver, leaves, a member still in it drives; with nobody left it stops (M2)", async () => {
  const { t, teamId, ana, bo } = await room();
  const channelId = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [bo.memberId] });
  const browserId = (await ana.as.mutation(api.browsers.start, { teamId, channelId, access: "drive" })) as Id<"browsers">;
  await settle(t);
  await ana.as.mutation(api.channels.leave, { teamId, channelId });
  await settle(t);
  expect(await bo.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "live", driver: { name: "Bo" } });
  // Bo, who isn't an admin, can end it now that he drives it.
  await bo.as.mutation(api.browsers.end, { teamId, browserId });
  expect((await bo.as.query(api.browsers.get, { teamId, browserId })).status).not.toBe("live");

  const second = (await bo.as.mutation(api.browsers.start, { teamId, channelId, access: "drive" })) as Id<"browsers">;
  await settle(t);
  await bo.as.mutation(api.channels.leave, { teamId, channelId });
  await settle(t);
  // Nobody is left to drive it, so it doesn't hold a slot: it stops.
  const stopped = await t.run((ctx) => ctx.db.get(second));
  expect(stopped!.status === "stopping" || stopped!.status === "ended").toBe(true);
});

test("an admin outside a private channel who removes its browser's driver from the team leaves it to a member, or stops it (M1)", async () => {
  const { t, teamId, julio, ana, bo } = await room();
  const channelId = await ana.as.mutation(api.channels.createPrivate, { teamId, name: "launch", memberIds: [bo.memberId] });
  const browserId = (await ana.as.mutation(api.browsers.start, { teamId, channelId, access: "drive" })) as Id<"browsers">;
  await settle(t);
  // Julio is the team's admin, and not in the channel.
  await julio.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
  await settle(t);
  expect(await bo.as.query(api.browsers.get, { teamId, browserId })).toMatchObject({ status: "live", driver: { name: "Bo" } });

  await julio.as.mutation(api.members.remove, { teamId, memberId: bo.memberId });
  await settle(t);
  const stopped = await t.run((ctx) => ctx.db.get(browserId));
  expect(stopped!.status === "stopping" || stopped!.status === "ended").toBe(true);
});

test("taking browsers.use from an agent's key cuts its connections and refuses its tickets", async () => {
  const { t, teamId, julio, browserId } = await liveBrowser("drive");
  const { agentId, key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "browsers.use"]);
  const joined = await callAsAgent(t, key, "browsers.join", { browserId });
  expect(await hyperbeamAsks(t, 0, "hb-hermes", joined.result.ticket)).toMatchObject({ authorized: true });
  const spare = (await callAsAgent(t, key, "browsers.join", { browserId })).result.ticket as string;

  const { keyId } = (await julio.as.query(api.agents.keys, { teamId, agentId }))[0]!;
  await julio.as.mutation(api.agents.setKeyScopes, { teamId, keyId, scopes: ["room.read"] });
  await settle(t);

  expect(fake.disconnected).toEqual([{ sessionId: "session-1", userId: "hb-hermes" }]);
  expect(await hyperbeamAsks(t, 0, "hb-hermes-2", spare)).toMatchObject({ authorized: false });
});
