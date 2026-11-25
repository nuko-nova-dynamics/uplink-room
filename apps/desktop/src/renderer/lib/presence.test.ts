// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { ONLINE_MS, presenceLabel, presenceOf } from "./presence";

test("presence: active or away while beats come in, offline past the window, with when they were last seen", () => {
  const now = 1_800_000_000_000;
  expect(presenceOf({ lastSeenAt: now - 30_000, active: true }, now)).toBe("active");
  expect(presenceOf({ lastSeenAt: now - 30_000, active: false }, now)).toBe("away");
  expect(presenceOf({ lastSeenAt: now - ONLINE_MS - 1, active: true }, now)).toBe("offline");
  expect(presenceOf(undefined, now)).toBe("offline");
  expect(presenceLabel("offline", now - 5 * 60_000, now)).toBe("Last seen 5 min ago");
  expect(presenceLabel("offline", now - 3 * 3_600_000, now)).toBe("Last seen 3 h ago");
  expect(presenceLabel("offline", now - 2 * 86_400_000, now)).toBe("Last seen 2 days ago");
  expect(presenceLabel("offline", undefined, now)).toBe("Offline");
});
