import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import type { Inventory, Step } from "../../../scripts/upclose/types";
import { STATES } from "./states";

const root = resolve(import.meta.dirname, "../../../../..");
const inventory: Inventory = JSON.parse(
  readFileSync(join(import.meta.dirname, "inventory.json"), "utf8"),
);
const required = [
  "default",
  "hover",
  "focus-visible",
  "pressed",
  "open",
  "selected",
  "disabled",
  "loading",
  "error",
  "empty",
  "overflow",
  "many",
];
const unique = (values: string[]) => expect(new Set(values).size).toBe(values.length);
function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(join(folder, item.name))
      : // The inventory names sources with "/", so compare in that form on Windows too.
        [relative(root, join(folder, item.name)).split(sep).join("/")],
  );
}
function checkStep(step: Step) {
  const text = (value: unknown) =>
    expect(typeof value === "string" && value.trim().length > 0).toBe(true);
  switch (step.do) {
    case "hover":
    case "press":
    case "click":
      expect(Object.keys(step).sort()).toEqual(["do", "target"]);
      text(step.target);
      break;
    case "tab":
    case "shift-tab":
      text(step.to);
      if (step.max !== undefined) expect(Number.isInteger(step.max) && step.max > 0).toBe(true);
      break;
    case "key":
      text(step.key);
      break;
    case "type":
      text(step.target);
      expect(typeof step.text).toBe("string");
      break;
    case "resize":
      expect(Number.isInteger(step.width) && step.width >= 960).toBe(true);
      expect(Number.isInteger(step.height) && step.height >= 600).toBe(true);
      break;
    case "wait":
      text(step.for);
      break;
    default:
      throw new Error(`Unknown input step: ${JSON.stringify(step)}`);
  }
}

describe("component inventory", () => {
  test("uses unique component and gym ids", () => {
    expect(inventory.version).toBe(1);
    unique(inventory.components.map((c) => c.id));
    unique(STATES.map((s) => s.id));
    for (const c of inventory.components) {
      expect(c.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(["primitive", "component", "view"]).toContain(c.kind);
      expect(c.selector.trim()).not.toBe("");
      expect(typeof c.zoom).toBe("boolean");
    }
  });
  test("references existing sources and gym scenes", () => {
    const gym = new Set(STATES.map((s) => s.id));
    for (const c of inventory.components) {
      expect(c.sources.length, c.id).toBeGreaterThan(0);
      for (const source of c.sources)
        expect(existsSync(resolve(root, source.split("#")[0]!)), `${c.id}: ${source}`).toBe(true);
      for (const state of c.states)
        expect(gym.has(state.gymState), `${c.id}: ${state.gymState}`).toBe(true);
    }
    for (const entry of inventory.nonVisual) {
      expect(existsSync(resolve(root, entry.file)), entry.file).toBe(true);
      expect(entry.reason.trim()).not.toBe("");
    }
  });
  test("covers every renderer component and view source file", () => {
    const covered = new Set(
      inventory.components
        .flatMap((c) => c.sources.map((s) => s.split("#")[0]!))
        .concat(inventory.nonVisual.map((e) => e.file)),
    );
    const sources = ["components", "views"].flatMap((folder) =>
      files(resolve(root, "apps/desktop/src/renderer", folder)),
    );
    const missing = sources.filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\./.test(file) && !covered.has(file),
    );
    expect(missing).toEqual([]);
  });
  test("accounts for all twelve states once per component", () => {
    for (const c of inventory.components) {
      unique(c.states.map((s) => s.id));
      for (const id of required) {
        const count =
          c.states.filter((s) => s.id === id).length + (id in (c.notApplicable ?? {}) ? 1 : 0);
        expect(count, `${c.id}: ${id}`).toBe(1);
      }
      for (const reason of Object.values(c.notApplicable ?? {}))
        expect(reason?.trim()).not.toBe("");
    }
  });
  test("uses real input steps with valid targets and dimensions", () => {
    for (const c of inventory.components)
      for (const state of c.states) {
        if (state.target !== undefined) expect(state.target.trim()).not.toBe("");
        if (state.nth !== undefined)
          expect(Number.isInteger(state.nth) && state.nth >= 0).toBe(true);
        for (const step of state.steps ?? []) checkStep(step);
      }
  });
});
