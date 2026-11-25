import { expect, it } from "vitest";
import { measurement } from "../fixtures.ts";
import { clickableArea } from "./clickable-area.ts";

it("accepts correctly sampled 28px controls", () => {
  expect(clickableArea(measurement())).toEqual([]);
});
it("reports targets below 24px and obstructed grid hits", () => {
  const m = measurement();
  m.target.rect.width = 23;
  m.hits[0]!.hitsTarget = false;
  m.hits[0]!.hit = ".overlay";
  const result = clickableArea(m);
  expect(result.some((f) => f.message.includes("smaller"))).toBe(true);
  expect(result.some((f) => f.message.includes("covers"))).toBe(true);
});
it("requires a sampled center and a complete grid, not duplicate hits", () => {
  const m = measurement();
  m.hits = Array.from({ length: 25 }, () => m.hits[12]!);
  expect(clickableArea(m)).toHaveLength(1);
  m.hits = [];
  expect(clickableArea(m)).toHaveLength(1);
});
it("does not apply target-size rules to noninteractive containers", () => {
  const m = measurement();
  m.target.selector = ".view";
  m.target.tag = "div";
  m.hits = [];
  expect(clickableArea(m)).toEqual([]);
});
it("accepts a separately sampled center and rejects incomplete grids", () => {
  const m = measurement(),
    original = m.hits.slice();
  m.hits = m.hits.map((h) => ({ ...h, x: h.x - 0.2, y: h.y - 0.2 }));
  m.hits.push(original[12]!);
  expect(clickableArea(m)).toEqual([]);
  m.hits.pop();
  m.hits.pop();
  m.hits.push(original[12]!);
  expect(clickableArea(m)).toHaveLength(1);
});

it("doesn't count what covers a disabled control as an obstruction", () => {
  const m = measurement({ state: "disabled" });
  m.hits[0]!.hitsTarget = false;
  m.hits[0]!.hit = ".row";
  expect(clickableArea(m)).toEqual([]);
});
