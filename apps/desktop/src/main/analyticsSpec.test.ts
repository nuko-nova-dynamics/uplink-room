import { describe, expect, it } from "vitest";
import { EVENTS, eventProperties, harnessName, runKind, scrubEvent } from "./analyticsSpec";
import { forbiddenKeys } from "./analyticsForbidden";

describe("the event list", () => {
  it("names no property after a person's name, an email, content or an address", () => {
    for (const [event, properties] of Object.entries(EVENTS)) {
      expect(forbiddenKeys(properties), event).toEqual([]);
    }
  });

  it("allows only enums, booleans, counts and versions, never free text", () => {
    for (const properties of Object.values(EVENTS)) {
      for (const rule of Object.values(properties)) {
        expect(Array.isArray(rule) || ["boolean", "count", "version"].includes(rule as string)).toBe(true);
      }
    }
  });
});

describe("scrubEvent", () => {
  const leaky = {
    event: "run_started",
    properties: {
      harness: "codex",
      kind: "terminal",
      access: "drive",
      has_profile: false,
      team_id: "k97f3t4s1v2w8x9y0z1a2b3c4d5e6f7g",
      distinct_id: "j57a8b9c0d1e2f3g4h5i6j7k8l9m0n1o",
      token: "phc_public",
      $lib: "web",
      $os: "Mac OS X",
      // What posthog-js adds on its own, and what a careless call site might pass.
      $current_url: "uplink-room://app/index.html#/sign-in?__clerk_ticket=secret",
      $pathname: "/index.html",
      $host: "app",
      $referrer: "https://example.com/private",
      $title: "Fix the login bug",
      $raw_user_agent: "Mozilla/5.0",
      $el_text: "rm -rf ./build",
      prompt: "Refactor the auth module",
      email: "someone@example.com",
      name: "Someone",
      $set: { email: "someone@example.com", name: "Someone", $os: "Mac OS X" },
      $set_once: { $initial_current_url: "uplink-room://app/#token", $initial_os: "Mac OS X" },
    },
  };

  it("keeps the event's own properties, the IDs and the safe SDK properties", () => {
    const out = scrubEvent(leaky)!;
    expect(out.properties).toEqual({
      harness: "codex",
      kind: "terminal",
      access: "drive",
      has_profile: false,
      team_id: "k97f3t4s1v2w8x9y0z1a2b3c4d5e6f7g",
      distinct_id: "j57a8b9c0d1e2f3g4h5i6j7k8l9m0n1o",
      token: "phc_public",
      $lib: "web",
      $os: "Mac OS X",
      $set: { $os: "Mac OS X" },
      $set_once: { $initial_os: "Mac OS X" },
      $geoip_disable: true,
    });
    expect(forbiddenKeys(out.properties)).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/someone|example\.com|secret|auth module|rm -rf|login bug/i);
  });

  it("turns GeoIP off on every event it lets through", () => {
    for (const event of ["signed_in", "$identify", "$snapshot", "$opt_in"]) {
      expect(scrubEvent({ event, properties: { $geoip_disable: false } })!.properties!["$geoip_disable"], event).toBe(true);
    }
  });

  it("drops a value outside the event's rules", () => {
    expect(eventProperties("run_started", { harness: "rm -rf /", kind: "terminal" })).toEqual({ kind: "terminal" });
    expect(eventProperties("inbox_opened", { needs_you: "lots" })).toEqual({});
    expect(eventProperties("run_started", { team_id: "Not an ID!" })).toEqual({});
  });

  it("drops events that aren't on the list, autocapture and pageviews included", () => {
    for (const event of ["$autocapture", "$pageview", "$pageleave", "$rageclick", "$exception", "$web_vitals", "made_up"]) {
      expect(scrubEvent({ event, properties: { $el_text: "secret" } }), event).toBeNull();
    }
  });

  it("cleans the person properties posthog-js puts beside `properties` on $identify", () => {
    const out = scrubEvent({
      event: "$identify",
      properties: { distinct_id: "j57a8b9c0d1e2f3g", $anon_distinct_id: "3b1f7a52-6c1e" },
      $set: { email: "someone@example.com" },
      $set_once: { $current_url: "uplink-room://app/#x", $referrer: "$direct", $pathname: "/", utm_content: "x", $initial_os: "Mac OS X" },
    })!;
    expect(out.$set).toEqual({});
    expect(out.$set_once).toEqual({ $initial_os: "Mac OS X" });
    expect(forbiddenKeys(out)).toEqual([]);
  });

  it("cuts the page address in replay data to the page itself", () => {
    const out = scrubEvent({
      event: "$snapshot",
      properties: {
        $session_id: "s",
        $snapshot_data: [{ type: 4, data: { href: "uplink-room://app/index.html?code=1#/factor-one", width: 1, height: 1 } }],
      },
    })!;
    expect(out.properties!["$snapshot_data"]).toEqual([
      { type: 4, data: { href: "uplink-room://app/index.html", width: 1, height: 1 } },
    ]);
  });

  it("names a harness the list doesn't know 'other'", () => {
    expect(harnessName("claude-code")).toBe("claude-code");
    expect(harnessName("my-secret-tool")).toBe("other");
  });
});

describe("runKind", () => {
  it("counts a thread on a cloud machine as a thread, and only a cloud terminal as cloud", () => {
    expect(runKind("codex", "thread", true)).toBe("thread");
    expect(runKind("codex", "thread", false)).toBe("thread");
    expect(runKind("codex", "terminal", true)).toBe("cloud");
    expect(runKind("codex", "terminal", false)).toBe("terminal");
    expect(runKind("space", "terminal", true)).toBe("space");
  });
});
