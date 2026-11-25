import { expect, test } from "vitest";
import { parseT3ShareRequest, parseT3ThreadsView, t3BridgeError, T3_SHARE_MAX } from "./t3ThreadsSpec";

const ask = { machineId: "m1", environmentId: "env-1", revision: 2, threads: ["t-1", "t-2"] };

test("a save from the renderer is taken only as the bridge would take it", () => {
  expect(parseT3ShareRequest(ask)).toEqual(ask);
  expect(parseT3ShareRequest({ ...ask, threads: ["t-1", "t-1"] })?.threads).toEqual(["t-1"]);
  expect(parseT3ShareRequest({ ...ask, threads: [] })?.threads).toEqual([]);
  for (const bad of [
    null,
    "t-1",
    { ...ask, machineId: "" },
    { ...ask, machineId: 7 },
    { ...ask, environmentId: "env 1" },
    { ...ask, revision: -1 },
    { ...ask, revision: 1.5 },
    { ...ask, threads: "t-1" },
    { ...ask, threads: [42] },
    { ...ask, threads: ["../etc"] },
    { ...ask, threads: Array.from({ length: T3_SHARE_MAX + 1 }, (_, i) => `t-${i}`) },
  ])
    expect(parseT3ShareRequest(bad)).toBeNull();
});

test("the bridge's list reaches the renderer with known fields only, cut to length", () => {
  const view = parseT3ThreadsView({
    state: "ready",
    machineId: "m1",
    revision: 3,
    environmentId: "env-1",
    token: "t3-bearer-secret",
    threads: [
      { id: "t-1", title: "Fix\u0007 rounding", project: "Billing", projectRoot: "/work/billing", state: "working", updatedAt: "2026-11-06T10:00:00.000Z", shared: true, fromRoom: false, session: { token: "x" } },
      { id: "t-2", title: "x".repeat(1000), project: "", state: "idle", shared: false },
      { id: "t-3", title: "Launched", project: "Billing", state: "done", shared: false, fromRoom: true },
      { id: "bad id", title: "dropped", project: "p", state: "working" },
      { id: "t-4", title: "dropped", project: "p", state: "exploded" },
      "not a row",
    ],
    missing: [{ id: "gone", title: "Archived one" }, { id: "no good" }],
    otherEnvironment: 2,
  });
  expect(view).toEqual({
    state: "ready",
    machineId: "m1",
    revision: 3,
    environmentId: "env-1",
    threads: [
      { id: "t-1", title: "Fix  rounding", project: "Billing", projectRoot: "/work/billing", state: "working", updatedAt: "2026-11-06T10:00:00.000Z", shared: true, fromRoom: false },
      { id: "t-2", title: "x".repeat(300), project: "No repo", state: "idle", shared: false, fromRoom: false },
      // A room launch is shared whatever the row says.
      { id: "t-3", title: "Launched", project: "Billing", state: "done", shared: true, fromRoom: true },
    ],
    missing: [{ id: "gone", title: "Archived one" }],
    otherEnvironment: 2,
  });
  expect(JSON.stringify(view)).not.toContain("secret");
});

test("an answer that isn't a list is never read as an empty one", () => {
  for (const odd of [null, "ok", {}, { state: "great" }, { threads: [] }])
    expect(parseT3ThreadsView(odd)).toEqual({ state: "unavailable", error: "The bridge answered without a list." });
  expect(parseT3ThreadsView({ state: "connecting" })).toEqual({ state: "connecting", machineId: null, revision: 0, threads: [], missing: [] });
});

test("an older bridge's refusal says what to do", () => {
  expect(t3BridgeError("Local bridge command failed")).toMatch(/can't list T3 Code threads. Restart Uplink Room/);
  expect(t3BridgeError("The threads shared here changed meanwhile.")).toBe("The threads shared here changed meanwhile.");
});
