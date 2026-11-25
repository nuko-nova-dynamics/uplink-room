import { expect, it } from "vitest";
import { measurement, text } from "./fixtures.ts";
import { ownershipIndex, owns, withOwnership } from "./ownership.ts";
import { checkMeasurement } from "./checks/index.ts";

it("assigns nested text to the nearest captured root and keeps the view structure", () => {
  const view = measurement({
    component: "view",
    icons: [],
    target: { ...measurement().target, selector: "#root > main" },
  });
  const button = measurement({
    component: "button",
    icons: [],
    target: { ...measurement().target, selector: "#root > main > button.btn" },
  });
  view.texts = [
    {
      ...text(),
      selector: `${button.target.selector}::text(0)[0:2]`,
      styles: { ...text().styles, fontSize: "14px" },
    },
  ];
  const owned = withOwnership(view, ownershipIndex([view, button]));
  expect(owns(owned, view.target.selector)).toBe(true);
  expect(owns(owned, view.texts[0]!.selector)).toBe(false);
  expect(checkMeasurement(owned).filter((f) => f.selector === view.texts[0]!.selector)).toEqual([]);
});

it("preserves DOM-recorded owners and resolves equal roots consistently", () => {
  const a = measurement({ component: "a", icons: [] }),
    b = { ...a, component: "b" };
  const roots = ownershipIndex([b, a]);
  expect(owns(withOwnership(b, roots), b.target.selector)).toBe(false);
  const live = {
    ...b,
    owners: { [b.target.selector]: { component: "b", root: b.target.selector } },
  };
  expect(withOwnership(live, roots)).toBe(live);
});
