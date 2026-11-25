import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** Every stylesheet the renderer loads, comments removed. */
const sheets = ["styles.css", "views/work.css", "views/thread.css", "views/pairs.css", "views/space.css", "components/copy.css", "components/blockquote.css"].map((file) =>
  readFileSync(join(import.meta.dirname, "..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
);

/** A selector's specificity as [ids, classes/attributes/pseudo-classes, types], for the plain selectors these sheets use. */
function specificity(selector: string): [number, number, number] {
  const notArgs = [...selector.matchAll(/:not\(([^()]*)\)/g)].map((m) => m[1]!);
  let rest = selector.replace(/:not\(([^()]*)\)/g, " ");
  const ids = (rest.match(/#[\w-]+/g) ?? []).length;
  const attrs = (rest.match(/\[[^\]]*\]/g) ?? []).length;
  rest = rest.replace(/\[[^\]]*\]/g, " ");
  const classes = (rest.match(/\.[\w-]+/g) ?? []).length;
  const pseudoClasses = (rest.match(/(?<!:):(?!:)[\w-]+/g) ?? []).length;
  const types = (rest.replace(/[.#:][\w-]+/g, " ").match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
  const own: [number, number, number] = [ids, attrs + classes + pseudoClasses, types];
  for (const arg of notArgs) {
    const inner = specificity(arg);
    for (const i of [0, 1, 2] as const) own[i] += inner[i];
  }
  return own;
}
const below = (a: number[], b: number[]) => a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!)));

/**
 * Selects draw the app's chevron as a background image that doesn't repeat (styles.css, `select.select`).
 * A `background` shorthand resets `background-repeat`, so one that outranks the chevron's rule tiles
 * the chevron across the box, as the light theme's did for every select (the task panel's Owner and
 * Project drew a zigzag).
 */
test("no background shorthand on a select outranks the rule that keeps its chevron from repeating", () => {
  const rules = sheets.flatMap((css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors!.split(",").map((s) => s.trim()), body: body! })));
  const chevron = rules.filter((r) => /background-repeat:\s*no-repeat/.test(r.body) && r.selectors.some((s) => /select\.select/.test(s)));
  expect(chevron.length).toBe(1);
  const keeps = specificity(chevron[0]!.selectors.find((s) => /select\.select/.test(s))!);
  const shorthands = rules.flatMap((r) => (/(^|;|\s)background\s*:/.test(r.body) ? r.selectors.filter((s) => /\.select(?![\w-])/.test(s)) : []));
  expect(shorthands.length).toBeGreaterThan(0);
  for (const selector of shorthands) expect(below(specificity(selector), keeps), `${selector} outranks the chevron's no-repeat`).toBe(true);
});
