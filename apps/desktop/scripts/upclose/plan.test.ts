import { expect, it } from "vitest";
import { cropRect, groups, parseArgs, plan } from "./plan.ts";
import type { Inventory } from "./types.ts";
const inventory: Inventory = {
  version: 1,
  nonVisual: [],
  components: ["one", "two", "three"].map((id) => ({
    id,
    name: id,
    selector: ".btn",
    sources: [],
    kind: "primitive",
    zoom: true,
    states: [
      { id: "default", gymState: "controls" },
      { id: "hover", gymState: "controls", steps: [{ do: "hover", target: ".btn" }] },
    ],
  })),
};
it("parses filters and rejects invalid shards and missing values", () => {
  expect(
    parseArgs([
      "out",
      "--components",
      "one,two",
      "--states",
      "hover",
      "--shard",
      "2/3",
      "--skip-checks",
    ]),
  ).toEqual({
    run: "out",
    components: ["one", "two"],
    states: ["hover"],
    shard: [2, 3],
    skipChecks: true,
  });
  for (const s of ["0/2", "3/2", "1/0", "wat"])
    expect(() => parseArgs(["out", "--shard", s])).toThrow();
  expect(() => parseArgs(["out", "--states"])).toThrow();
});
it("shards every component exactly once with disjoint capture paths", () => {
  const all = [1, 2].flatMap((i) => plan(inventory, { components: [], states: [], shard: [i, 2] }));
  expect(all).toHaveLength(12);
  expect(new Set(all.map((t) => `${t.component.id}/${t.state.id}/${t.theme}`)).size).toBe(12);
  expect(plan(inventory, { components: ["two"], states: ["hover"], shard: [1, 1] })).toHaveLength(
    2,
  );
  expect(() => plan(inventory, { components: ["missing"], states: [], shard: [1, 1] })).toThrow();
});
it("shares passive scene loads while isolating every input state", () => {
  const batches = groups(plan(inventory, { components: [], states: [], shard: [1, 1] }));
  expect(batches.filter((b) => b.length === 3)).toHaveLength(2);
  expect(batches.filter((b) => b.length === 1)).toHaveLength(6);
  expect(batches.every((b) => b.every((t) => t.theme === b[0]!.theme))).toBe(true);
});
it("rounds fractional crop edges outward in device pixels", () => {
  const crop = cropRect(
    { x: 10.3, y: 20.7, width: 28, height: 28 },
    { width: 100, height: 100 },
    2,
  );
  expect(crop).toEqual({ x: 5, y: 15.5, width: 38.5, height: 38.5, margin: 5 });
  expect(cropRect({ x: 0, y: 0, width: 28, height: 28 }, { width: 30, height: 30 }, 1)).toEqual({
    x: 0,
    y: 0,
    width: 30,
    height: 30,
    margin: 5,
  });
  expect(() =>
    cropRect({ x: 101, y: 101, width: 28, height: 28 }, { width: 30, height: 30 }, 1),
  ).toThrow();
});
