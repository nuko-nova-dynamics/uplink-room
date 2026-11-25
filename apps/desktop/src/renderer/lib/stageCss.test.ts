import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * A big call's compact tiles (styles.css, "A big call") are for people only: no compact rule may
 * reach a shared screen's tile, or the stage's layout while a screen is shared (expanded or not).
 */
test("compact call tiles never size a shared screen or the screen layout", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]*\.call-stage\.compact[^{}]*)\{/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
  expect(selectors.length).toBeGreaterThan(3);
  for (const selector of selectors) {
    if (selector.includes(".tile")) expect(selector, selector).toContain(".tile:not(.screen)");
    else expect(selector, selector).toContain(":not(.has-screen)");
  }
});

/**
 * The call stage can't shrink (`flex: none`) and the body doesn't scroll, so every rule that sizes
 * it must keep a height cap. A big call in a short window then scrolls its tiles inside the stage
 * instead of pushing the conversation and composer below the window.
 */
test("no call stage rule lifts its height cap", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...css.matchAll(/([^{}]*\.call-stage[^{}]*)\{([^{}]*)\}/g)];
  expect(blocks.length).toBeGreaterThan(3);
  for (const [, selector, body] of blocks) expect(body, selector!.trim()).not.toMatch(/max-height:\s*none/);
});
