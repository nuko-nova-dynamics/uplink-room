import { describe, it, expect } from "vitest";
import {
  forbidden,
  animationEasings,
  tokenValue,
  roundedHit,
  focusKey,
  cycleLength,
  clipped,
  overlap,
  motionProperty,
  nearestComponent,
} from "./rules.ts";
describe("interaction pass rules", () => {
  it("requires a repeated sequence, not one repeated stop, to close a tab cycle", () => {
    expect(cycleLength(["a", "b", "c", "a"])).toBeNull();
    expect(cycleLength(["a", "b", "c", "a", "b", "c"])).toBe(3);
  });
  it("flags hidden text unless it has an ellipsis, with rounding tolerance", () => {
    expect(clipped({ overflow: "hidden", width: 100, scroll: 102, ellipsis: "clip" })).toBe(true);
    expect(clipped({ overflow: "hidden", width: 100, scroll: 102, ellipsis: "ellipsis" })).toBe(
      false,
    );
    expect(clipped({ overflow: "auto", width: 100, scroll: 200, ellipsis: "clip" })).toBe(false);
    expect(clipped({ overflow: "hidden", width: 1, height: 1, scroll: 80, ellipsis: "clip" })).toBe(false);
  });
  it("excludes ancestor boxes and intentional stacks from overlaps", () => {
    const a = { x: 0, y: 0, width: 20, height: 20 },
      b = { x: 10, y: 10, width: 20, height: 20 };
    expect(overlap(a, b, false, false)).toBe(true);
    expect(overlap(a, b, true, false)).toBe(false);
    expect(overlap(a, b, false, true)).toBe(false);
    expect(overlap(a, { ...b, x: 20 }, false, false)).toBe(false);
  });
  it("allows only compositor and color transition properties", () => {
    expect(motionProperty("transform")).toBe(true);
    expect(motionProperty("border-left-color")).toBe(true);
    expect(motionProperty("width")).toBe(false);
    expect(motionProperty("box-shadow")).toBe(false);
    expect(motionProperty("all")).toBe(false);
  });
  it("maps the nearest matching ancestor, preferring a specific selector", () => {
    const c = [
      { id: "parent", selector: ".parent" },
      { id: "button", selector: ".btn" },
      { id: "icon", selector: ".btn.icon" },
    ];
    expect(nearestComponent([[], [".btn", ".btn.icon"], [".parent"]], c)).toBe("icon");
    expect(nearestComponent([[]], c)).toBe("unmapped");
  });
});

it("tracks composite focus through aria-activedescendant", () => {
  expect(focusKey({ selector: "#input", activeDescendant: "option-two" })).toBe("option-two");
  expect(focusKey({ selector: "#button" })).toBe("#button");
});

it("uses the painted rounded box rather than its clipped-off corners", () => {
  const r = [
    [7, 7],
    [7, 7],
    [7, 7],
    [7, 7],
  ];
  expect(roundedHit(14, 2, 28, 28, r)).toBe(true);
  expect(roundedHit(2, 2, 28, 28, r)).toBe(false);
  expect(roundedHit(14, -2, 28, 28, r)).toBe(false);
});

it("checks segment easing rather than the unused final keyframe default", () => {
  expect(animationEasings("linear", [{ easing: "ease-out" }, { easing: "linear" }])).toEqual([
    "ease-out",
  ]);
  expect(tokenValue("cubic-bezier(0, 0, 1, 1)", { "--ease": "cubic-bezier(0,0,1,1)" })).toBe(true);
});

it("blocks clipboard and external navigation labels", () => {
  for (const label of ["Copy link", "View on GitHub", "Share", "Open in T3 Code"])
    expect(forbidden.test(label)).toBe(true);
  expect(forbidden.test("Open thread")).toBe(false);
});
