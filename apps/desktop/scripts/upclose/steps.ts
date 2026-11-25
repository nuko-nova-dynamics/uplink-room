import type { Locator, Page } from "@playwright/test";
import { resize } from "./launch.ts";
import type { Step } from "./types.ts";

/** A frame can be visible before its PDF worker has painted the page. */
export async function waitForContent(target: Locator): Promise<void> {
  const htmlFrames = (await target.evaluate((el) => el.matches("iframe.html-frame")))
    ? [target]
    : await target.locator("iframe.html-frame").all();
  for (const frame of htmlFrames)
    await frame.contentFrame().locator("body").filter({ hasText: /\S/ }).waitFor({
      state: "visible",
      timeout: 10000,
    });
  const attachment = (await target.evaluate((el) => el.matches(".attachment-pdf")))
    ? target
    : target.locator(".attachment-pdf");
  if (await attachment.count())
    await attachment.locator("iframe.pdf-frame").first().waitFor({
      state: "visible",
      timeout: 10000,
    });
  const frames = (await target.evaluate((el) => el.matches("iframe.pdf-frame")))
    ? [target]
    : await target.locator("iframe.pdf-frame").all();
  for (const frame of frames)
    if (await frame.isVisible())
      await frame.contentFrame().locator('.page[data-rendered="true"]').first().waitFor({
        state: "visible",
        timeout: 10000,
      });
}

export async function settle(target: Locator): Promise<void> {
  await target.evaluate(async (el) => {
    // Infinite activity animations have no settled state. Leave them running for the motion pass.
    for (let attempt = 0; attempt < 4; attempt++) {
      const animations = el
        .getAnimations({ subtree: true })
        .filter(
          (a) =>
            a.effect?.getComputedTiming().iterations !== Infinity &&
            a.playState !== "finished" &&
            a.playState !== "idle",
        );
      if (!animations.length) break;
      await Promise.race([
        Promise.all(animations.map((a) => a.finished.catch(() => {}))),
        new Promise<void>((r) => setTimeout(r, 1500)),
      ]);
    }
    if (
      el
        .getAnimations({ subtree: true })
        .some(
          (a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === "running",
        )
    )
      throw new Error("Target transitions did not settle within six seconds");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

export async function performSteps(page: Page, steps: Step[] = []): Promise<void> {
  for (const step of steps) {
    if (step.do === "key") {
      await page.keyboard.press(step.key);
      continue;
    }
    if (step.do === "resize") {
      await resize(page, step.width, step.height);
      continue;
    }
    if (step.do === "tab" || step.do === "shift-tab") {
      const destination = page.locator(step.to).first();
      await destination.waitFor({ state: "attached", timeout: 2000 });
      let reached = false;
      for (let i = 0; i < (step.max ?? 60); i++) {
        await page.keyboard.press(step.do === "tab" ? "Tab" : "Shift+Tab");
        if (
          await destination.evaluate(
            (el) => el === document.activeElement && el.matches(":focus-visible"),
          )
        ) {
          reached = true;
          break;
        }
      }
      if (!reached) throw new Error(`Keyboard could not reach ${step.to} with ${step.do}`);
      await settle(destination);
      continue;
    }
    const target = page.locator(step.do === "wait" ? step.for : step.target).first();
    await target.waitFor({ state: "visible", timeout: 2000 });
    if (step.do === "wait") continue;
    if (step.do === "click") await target.click({ timeout: 2500 });
    if (step.do === "type") {
      await target.click({ timeout: 2500 });
      await page.keyboard.type(step.text);
    }
    if (step.do === "hover" || step.do === "press") {
      await target.scrollIntoViewIfNeeded({ timeout: 2000 });
      const r = await target.boundingBox();
      if (!r) throw new Error(`No box for ${step.target}`);
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      if (step.do === "press") await page.mouse.down();
      await target.evaluate(async () => {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      });
      const actual = await target.evaluate((el) => ({
        hover: el.matches(":hover"),
        active: el.matches(":active"),
        hit: document.elementFromPoint(
          el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2,
          el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2,
        )?.tagName,
      }));
      if (!actual.hover || (step.do === "press" && !actual.active))
        throw new Error(
          `Real ${step.do} did not activate ${step.target}: ${JSON.stringify(actual)}`,
        );
    }
    // A click may remove its trigger. The capture target is settled again by the caller.
    if ((await target.count()) && (await target.isVisible())) await settle(target);
  }
}

export async function releaseInput(page: Page): Promise<void> {
  await page.mouse.up().catch(() => {});
  await page.mouse.move(0, 0).catch(() => {});
}
