import { expect, test } from "vitest";
import { pairView, type LinkState } from "./setupSpec.ts";

const rosa: LinkState = { status: "paired", name: "Rosa's Mac" };

test("an already linked computer shows its pairing, and replacing it asks first", () => {
  const base = { available: true, linkedNow: false, replace: "no" as const };
  expect(pairView({ ...base, current: undefined })).toBe("checking");
  expect(pairView({ ...base, current: rosa })).toBe("linked");
  expect(pairView({ ...base, current: rosa, replace: "asked" })).toBe("confirm-replace");
  expect(pairView({ ...base, current: rosa, replace: "confirmed" })).toBe("form");
  expect(pairView({ ...base, current: { status: "unpaired" } })).toBe("form");
  expect(pairView({ ...base, current: { status: "unpaired" }, linkedNow: true })).toBe("linked");
  expect(pairView({ ...base, available: false, current: rosa })).toBe("unavailable");
});

test("a pairing that couldn't be read never shows the link form", () => {
  const base = { available: true, linkedNow: false, current: { status: "unknown", error: "EACCES" } as const };
  expect(pairView({ ...base, replace: "no" })).toBe("unknown");
  expect(pairView({ ...base, replace: "confirmed" })).toBe("unknown");
});
