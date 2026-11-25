// @vitest-environment happy-dom
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenKeys } from "../../main/analyticsForbidden";

/**
 * The real posthog-js (1.444.0), in a page, with the network stubbed: what would it send, and
 * does "Share usage data" off stop all of it? Each test loads fresh modules, so each gets its own
 * posthog-js instance, the way each launch of the app does.
 */
type Captured = { event: string; distinct_id?: string; properties: Record<string, unknown> };
type Sent = { url: string; at: number; events: Captured[] };
const sent: Sent[] = [];
/** How the stubbed network answers capture requests. */
let network: "ok" | "fail" = "ok";
/** Whether the project's remote config turns replay on. */
let replay = false;

function decode(url: string, body: unknown): Captured[] {
  let text: string;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) {
    const buffer = Buffer.from(body);
    text = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
  } else return [];
  if (url.includes("compression=base64") || text.startsWith("data=")) {
    text = Buffer.from(decodeURIComponent(text.replace(/^data=/, "")), "base64").toString("utf8");
  }
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed) ? parsed : ((parsed as { batch?: unknown[] }).batch ?? [parsed]);
  return list as Captured[];
}

async function bytes(body: unknown): Promise<unknown> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = new URL(url).pathname;
      if (path.includes("/config")) return json(replay ? { sessionRecording: { endpoint: "/s/" } } : {});
      const capture = /\/(e|i\/v0\/e|s|batch)\b/.test(path);
      if (capture && network === "fail") return json({ error: "unavailable" }, 503);
      sent.push({ url, at: Date.now(), events: capture ? decode(url, await bytes(init?.body)) : [] });
      return json({ status: 1 });
    }),
  );
  Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true });
  // posthog-js drops events from what looks like a bot: happy-dom's user agent, and any page with
  // navigator.webdriver set. Look like the app's Electron window instead.
  Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
  Object.defineProperty(navigator, "userAgent", {
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) uplink-room/0.1.0 Chrome/146.0.0.0 Electron/45.2.1 Safari/537.36",
    configurable: true,
  });
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  sent.length = 0;
  network = "ok";
  replay = false;
  vi.mocked(navigator.sendBeacon).mockClear();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const captured = () => sent.flatMap((request) => request.events);
const named = (event: string) => captured().filter((e) => e.event === event);
const distinctId = (event: Captured) => event.distinct_id ?? (event.properties["distinct_id"] as string | undefined);

const A = { memberId: "j57a8b9c0d1e2f3g4h5i6j7k8l9m0n1o", teamId: "k97f3t4s1v2w8x9y0z1a2b3c4d5e6f7g" };
const B = { memberId: "m11a2b3c4d5e6f7g8h9i0j1k2l3m4n5o", teamId: "t22a2b3c4d5e6f7g8h9i0j1k2l3m4n5o" };

/** Main's side: the setting and the anonymous ID it keeps (main/analytics.ts). */
function mainProcess(deviceId = "3b1f7a52-6c1e-4d0b-9f2a-8c4e5d6f7a8b") {
  const main = { enabled: true, deviceId };
  const desktop = {
    analyticsState: async () => ({ enabled: main.enabled, deviceId: main.deviceId }),
    setAnalyticsEnabled: async (value: boolean) => void (main.enabled = value),
    analyticsIdentify: async (_identity: unknown, next: string) => void (main.deviceId = next),
  };
  return { main, desktop };
}

/** A launch of the app: fresh posthog-js and analytics modules, sharing this page's storage. */
async function launch(desktop: ReturnType<typeof mainProcess>["desktop"]) {
  vi.resetModules();
  const posthog = (await import("posthog-js/dist/module.no-external")).default;
  const { createAnalytics } = await import("./analytics");
  return { posthog, analytics: createAnalytics({ posthog, key: "phc_test", desktop }) };
}

describe("renderer analytics", () => {
  beforeEach(() => localStorage.clear());

  it("sends only the app's events, with no forbidden fields, and nothing once sharing is off", async () => {
    const { main, desktop } = mainProcess();
    const { posthog, analytics } = await launch(desktop);

    // Tracked before the setting is read: kept, then sent.
    analytics.track("signed_in");
    await analytics.start();
    analytics.identify(A);
    analytics.track("run_started", {
      harness: "codex",
      kind: "terminal",
      access: "drive",
      has_profile: false,
      ...({ prompt: "Refactor the auth module", email: "someone@example.com", url: "https://example.com/x" } as object),
    });
    // Something on the page posthog-js could pick up on its own, if autocapture were on.
    document.body.innerHTML = '<button id="b">Delete the production database</button><input value="hunter2">';
    document.getElementById("b")!.click();
    await wait(200);

    const events = captured();
    const names = events.map((e) => e.event);
    expect(names).toContain("signed_in");
    expect(names).toContain("run_started");
    expect(names).not.toContain("$pageview");
    expect(names).not.toContain("$autocapture");
    for (const event of events) {
      expect(forbiddenKeys(event), event.event).toEqual([]);
      expect(JSON.stringify(event)).not.toMatch(/someone|example\.com|auth module|production database|hunter2/i);
      expect(event.properties["$geoip_disable"], event.event).toBe(true);
    }
    const run = named("run_started")[0]!;
    expect(run.properties).toMatchObject({
      harness: "codex",
      kind: "terminal",
      distinct_id: A.memberId,
      team_id: A.teamId,
    });

    // Off: nothing at all goes out, whatever the app tracks or how long it waits.
    await analytics.setEnabled(false);
    expect(main.enabled).toBe(false);
    const before = sent.length;
    analytics.track("inbox_opened");
    analytics.track("call_joined");
    posthog.capture("$pageview");
    analytics.reset();
    analytics.track("signed_out");
    posthog.capture("signed_out");
    await wait(3_500);
    expect(sent.slice(before)).toEqual([]);

    // On again: sending resumes.
    await analytics.setEnabled(true);
    analytics.track("inbox_opened");
    await wait(200);
    expect(named("inbox_opened")).toHaveLength(1);
  }, 15_000);

  it("keeps GeoIP off after a team switch and a sign-out reset posthog-js", async () => {
    const { main, desktop } = mainProcess();
    const { analytics } = await launch(desktop);
    await analytics.start();
    analytics.identify(A);
    analytics.track("inbox_opened");
    analytics.identify(B);
    analytics.track("call_joined");
    analytics.reset();
    analytics.track("signed_out");
    analytics.track("pairing_code_created", { belongs_to: "person" });
    await wait(300);

    const events = captured();
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["$identify", "inbox_opened", "call_joined", "signed_out", "pairing_code_created"]),
    );
    for (const event of events) expect(event.properties["$geoip_disable"], event.event).toBe(true);
    // Each person gets their own events, and after sign-out the anonymous ID is new and main has it.
    expect(distinctId(named("inbox_opened")[0]!)).toBe(A.memberId);
    expect(distinctId(named("call_joined")[0]!)).toBe(B.memberId);
    const after = distinctId(named("pairing_code_created")[0]!);
    expect(after).toBe(main.deviceId);
    expect(after).not.toBe("3b1f7a52-6c1e-4d0b-9f2a-8c4e5d6f7a8b");
  });

  it("after a sign-out and a restart, the next person's first events don't go to the last member", async () => {
    const first = "3b1f7a52-6c1e-4d0b-9f2a-8c4e5d6f7a8b";
    const { main, desktop } = mainProcess(first);

    // Launch 1: member A uses the app (merging the install's first ID into A), then signs out.
    const one = await launch(desktop);
    await one.analytics.start();
    one.analytics.identify(A);
    one.analytics.track("inbox_opened");
    one.analytics.reset();
    // posthog-js debounces its storage writes by 250 ms (`defaults`), and flushes them when the
    // app quits. Wait them out here, since the test's "restart" doesn't unload the page.
    await wait(400);
    expect(main.deviceId).not.toBe(first);
    const rotated = main.deviceId;

    // Launch 2: someone signs in. Before a team opens, they are the rotated ID, not A's old one.
    sent.length = 0;
    const two = await launch(desktop);
    await two.analytics.start();
    expect(two.posthog.get_distinct_id()).toBe(rotated);
    two.analytics.track("signed_in");
    await wait(200);
    expect(distinctId(named("signed_in")[0]!)).toBe(rotated);

    // Launch 3, signed in as B: the member stays, and the ID isn't swapped back.
    two.analytics.identify(B);
    await wait(400);
    const three = await launch(desktop);
    await three.analytics.start();
    expect(three.posthog.get_distinct_id()).toBe(B.memberId);
  });

  it("a sign-out before main's state arrives still starts the next person on a new ID", async () => {
    const first = "3b1f7a52-6c1e-4d0b-9f2a-8c4e5d6f7a8b";
    const { main, desktop } = mainProcess(first);

    // Launch 1: member A uses the app, merging the install's first ID into A.
    const one = await launch(desktop);
    await one.analytics.start();
    one.analytics.identify(A);
    await wait(400);

    // Launch 2: Clerk reports the sign-out while the state request to main is still pending.
    sent.length = 0;
    const two = await launch(desktop);
    const starting = two.analytics.start();
    two.analytics.reset();
    await starting;
    await wait(200);
    expect(main.deviceId).not.toBe(first);
    expect(two.posthog.get_distinct_id()).toBe(main.deviceId);
    two.analytics.track("signed_in");
    await wait(200);
    expect(distinctId(named("signed_in")[0]!)).toBe(main.deviceId);
    expect(distinctId(named("signed_in")[0]!)).not.toBe(A.memberId);
  });

  it("sends nothing after sharing is off, even a request that failed and would be retried", async () => {
    const { desktop } = mainProcess();
    const { posthog, analytics } = await launch(desktop);
    await analytics.start();
    analytics.identify(A);
    await wait(200);

    // Control, sharing on: a failed request is retried once the network is back.
    network = "fail";
    analytics.track("inbox_opened");
    await wait(200);
    expect(named("inbox_opened")).toEqual([]);
    network = "ok";
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60_000);
    window.dispatchEvent(new Event("online"));
    await wait(200);
    clock.mockRestore();
    expect(named("inbox_opened")).toHaveLength(1);

    // Now: a request fails, sharing is turned off, the network recovers. Nothing goes out.
    network = "fail";
    analytics.track("call_joined");
    await wait(200);
    await analytics.setEnabled(false);
    const before = sent.length;
    network = "ok";
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
    window.dispatchEvent(new Event("online"));
    await wait(3_500);
    // Leaving the page would beacon anything still queued.
    window.dispatchEvent(new Event("pagehide"));
    await wait(100);
    later.mockRestore();
    expect(sent.slice(before)).toEqual([]);
    expect(named("call_joined")).toEqual([]);
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
    // The queue it guards is posthog-js's own (a tripwire if an upgrade renames it).
    expect((posthog as unknown as { _retryQueue: { _queue: unknown[] } })._retryQueue._queue).toEqual([]);
  }, 15_000);

  it("resumes session replay when sharing is turned back on, under the project's setting", async () => {
    replay = true;
    const { desktop } = mainProcess();
    const { posthog, analytics } = await launch(desktop);
    await analytics.start();
    analytics.identify(A);
    await wait(300);
    // posthog-js's own gate for recording (session-recording.ts `_isRecordingEnabled`): the project
    // turns replay on, the config doesn't turn it off, and the person hasn't opted out. happy-dom
    // can't run the rrweb recorder itself, so the test checks the gate.
    const recording = () => (posthog as unknown as { sessionRecording: { _isRecordingEnabled: boolean } }).sessionRecording._isRecordingEnabled;
    expect(recording()).toBe(true);

    await analytics.setEnabled(false);
    expect(recording()).toBe(false);
    expect(posthog.config.disable_session_recording).toBe(true);

    const start = vi.spyOn(posthog, "startSessionRecording");
    await analytics.setEnabled(true);
    expect(recording()).toBe(true);
    expect(posthog.config.disable_session_recording).toBe(false);
    // Called with no override, so the project's sampling, linked flag and triggers still apply.
    expect(start).toHaveBeenCalledWith();
  }, 10_000);
});

describe("replay masking", () => {
  it("keeps layout attributes and empties the rest", async () => {
    const { maskAttribute, maskText } = await import("./analytics");
    expect(maskAttribute("class", "row muted")).toBe("row muted");
    expect(maskAttribute("aria-pressed", "true")).toBe("true");
    expect(maskAttribute("href", "https://example.com/secret")).toBe("");
    expect(maskAttribute("src", "https://cdn.example.com/avatar.png")).toBe("");
    expect(maskAttribute("title", "Fix the login bug")).toBe("");
    expect(maskAttribute("aria-label", "Message from Julio")).toBe("");
    expect(maskAttribute("data-id", "abc")).toBe("");
    expect(maskAttribute("style", "width: 40px")).toBe("width: 40px");
    expect(maskAttribute("style", "background: url(https://example.com/a.png)")).toBe("");
    expect(maskText("rm -rf  build")).toBe("** ***  *****");
  });
});

describe("startIdentity", () => {
  it("bootstraps main's ID only when posthog-js doesn't have it yet", async () => {
    const { startIdentity } = await import("./analytics");
    expect(startIdentity({ anonymous: null, member: null }, "id-1")).toBe("id-1");
    expect(startIdentity({ anonymous: "id-1", member: "j57a8b9c0d1e2f3g" }, "id-1")).toBeUndefined();
    expect(startIdentity({ anonymous: "id-1", member: null }, "id-2")).toBe("id-2");
  });
});
