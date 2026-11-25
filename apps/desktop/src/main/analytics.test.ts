import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainAnalytics, parseIdentity } from "./analytics";
import { forbiddenKeys } from "./analyticsForbidden";

/** What posthog-node sent: one entry per request, with its decoded body. */
function recorder() {
  const sent: { url: string; body: { batch?: { event: string; properties: Record<string, unknown> }[] } }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
    let raw = init?.body;
    if (raw instanceof Blob) raw = Buffer.from(await raw.arrayBuffer());
    if (raw instanceof Uint8Array) {
      const bytes = Buffer.from(raw);
      raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
    }
    sent.push({ url: String(url), body: JSON.parse(String(raw)) });
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  });
  return { sent, fetch: fetchMock as unknown as typeof fetch };
}

describe("MainAnalytics", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uplink-analytics-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts on, with an anonymous ID it keeps", () => {
    const file = join(dir, "analytics.json");
    const first = new MainAnalytics({ key: "phc_test", file }).state;
    expect(first.enabled).toBe(true);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new MainAnalytics({ key: "phc_test", file }).state).toEqual(first);
  });

  it("sends the member and team IDs and the event's own properties, nothing more", async () => {
    const { sent, fetch } = recorder();
    const analytics = new MainAnalytics({ key: "phc_test", file: join(dir, "a.json"), fetch });
    analytics.identify({ memberId: "j57a8b9c0d1e2f3g4h5i6j7k8l9m0n1o", teamId: "k97f3t4s1v2w8x9y0z1a2b3c4d5e6f7g" });
    // A careless call: the extra keys must not leave the app.
    await analytics.capture("machine_linked", {
      method: "this_computer",
      result: "ok",
      ...({ email: "someone@example.com", url: "https://example.com", name: "julio-mbp" } as object),
    });
    expect(sent).toHaveLength(1);
    const body = JSON.stringify(sent[0]!.body);
    expect(body).toContain('"distinct_id":"j57a8b9c0d1e2f3g4h5i6j7k8l9m0n1o"');
    expect(body).toContain('"team_id":"k97f3t4s1v2w8x9y0z1a2b3c4d5e6f7g"');
    expect(body).toContain('"event":"machine_linked"');
    expect(body).not.toMatch(/someone|example\.com|julio-mbp/);
    expect(forbiddenKeys(sent[0]!.body)).toEqual([]);
  });

  it("sends nothing once Share usage data is off, and remembers it", async () => {
    const { sent, fetch } = recorder();
    const file = join(dir, "b.json");
    const analytics = new MainAnalytics({ key: "phc_test", file, fetch });
    analytics.setEnabled(false);
    await analytics.capture("app_launched", { app_version: "0.1.0", platform: "darwin", arch: "arm64" });
    await analytics.capture("machine_linked", { method: "this_computer", result: "ok" });
    await analytics.shutdown();
    expect(sent).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
    expect(new MainAnalytics({ key: "phc_test", file }).state.enabled).toBe(false);
  });

  it("sends nothing without a project key (development and test builds)", async () => {
    const { sent, fetch } = recorder();
    const analytics = new MainAnalytics({ key: undefined, file: join(dir, "c.json"), fetch });
    await analytics.capture("signed_in", {});
    expect(sent).toEqual([]);
  });

  it("moves to the renderer's new anonymous ID after a sign-out, and keeps it across launches", async () => {
    const { sent, fetch } = recorder();
    const file = join(dir, "d.json");
    const analytics = new MainAnalytics({ key: "phc_test", file, fetch });
    const first = analytics.state.deviceId;
    const rotated = "0b7c2a5e-9d41-4f3a-8e6b-2c1d0f9a8b7e";
    analytics.identify(null, rotated);
    analytics.identify(null, "not-an-id");
    await analytics.capture("app_launched", { app_version: "0.1.0", platform: "darwin", arch: "arm64" });
    expect(JSON.stringify(sent[0]!.body)).toContain(`"distinct_id":"${rotated}"`);
    expect(new MainAnalytics({ key: "phc_test", file }).state.deviceId).toBe(rotated);
    expect(rotated).not.toBe(first);
  });

  it("takes only IDs as the identity", () => {
    expect(parseIdentity({ memberId: "j57a8b9c0d1e2f3g", teamId: "k97f3t4s1v2w8x9y" })).toEqual({
      memberId: "j57a8b9c0d1e2f3g",
      teamId: "k97f3t4s1v2w8x9y",
    });
    expect(parseIdentity({ memberId: "someone@example.com", teamId: "k97f3t4s1v2w8x9y" })).toBeNull();
    expect(parseIdentity(null)).toBeNull();
  });
});
