import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openGym, resize, showState } from "./launch.ts";
import { cropRect, groups, parseArgs, plan } from "./plan.ts";
import type { CaptureTask, Options } from "./plan.ts";
import { performSteps, releaseInput, settle, waitForContent } from "./steps.ts";
import { stateRules } from "./state-rules.ts";
import { measure } from "./measure.ts";
import { cropPng } from "./crop.ts";
import { captureNativeTooltip } from "./native-tooltip.ts";
import { overlay, zoom } from "./image.ts";
import { findingId, runPaths } from "./types.ts";
import type { Finding, Inventory, Scale } from "./types.ts";
import { runChecks } from "./checks/index.ts";
import { writeReport } from "./report.ts";
import type { Page } from "@playwright/test";

const inventoryFile = fileURLToPath(
  new URL("../../src/renderer/gym/inventory.json", import.meta.url),
);
async function save(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

export async function capture(
  page: Page,
  task: CaptureTask,
  scale: Scale,
  run: string,
  inventory?: Inventory,
) {
  const { component, state, theme } = task;
  const selector = state.target ?? component.selector;
  const target = page.locator(selector).nth(state.nth ?? 0);
  await target.waitFor({ state: "visible", timeout: 2500 });
  if (!state.steps?.length) {
    await target.scrollIntoViewIfNeeded({ timeout: 2500 });
    // Scrolling a passive specimen can move it under Chromium's retained pointer.
    // Refresh the hit test after scrolling so default frames do not capture hover.
    await page.mouse.move(1, 1);
    await page.mouse.move(0, 0);
  }
  if (state.id !== "loading") await waitForContent(target);
  await settle(target);
  // Measurement stills use the beginning of an icon's rotation. Motion passes own animation frames.
  await target.evaluate((el) => {
    for (const icon of [el, ...el.querySelectorAll("svg")])
      if (icon.matches(".state-icon.live svg"))
        for (const animation of icon.getAnimations()) {
          animation.pause();
          animation.currentTime = 0;
        }
  });
  const rendered = await target.evaluate((el) => {
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement)
      opacity *= Number(getComputedStyle(e).opacity);
    return {
      opacity,
      disabled: el.matches(':disabled,[aria-disabled="true"]'),
      control: el.matches("button,input,textarea,select"),
    };
  });
  if (rendered.opacity === 0) throw new Error(`Target is transparent: ${selector}`);
  if (state.id === "disabled" && rendered.control && !rendered.disabled)
    throw new Error(`Disabled state selected an enabled control: ${selector}`);
  const rect = await target.boundingBox();
  if (!rect || !rect.width || !rect.height)
    throw new Error(`Selector has no rendered box: ${selector}`);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const native =
    component.id === "native-tooltip" ? await captureNativeTooltip(page, target, scale) : undefined;
  const crop = native?.crop ?? cropRect(rect, viewport, scale);
  const paths = runPaths(run);
  const file = (name: string) => paths.capture(component.id, state.id, theme, name);
  const cropFile = file(`${scale}x.png`);
  await mkdir(dirname(cropFile), { recursive: true });
  // Chromium on the pinned box clears hover and active state on a smaller capture surface.
  // Capture the unchanged viewport, then cut its pixels to the requested element bounds.
  const viewportPng = native
    ? undefined
    : await page.screenshot({
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
        animations: "allow",
        caret: "initial",
        scale: "device",
      });
  const png = native?.png ?? cropPng(viewportPng!, crop, scale);
  const lastInput = state.steps?.at(-1);
  if (lastInput?.do === "hover" || lastInput?.do === "press") {
    const held = await page
      .locator(lastInput.target)
      .first()
      .evaluate(
        (el, pressed) => el.matches(pressed ? ":active" : ":hover"),
        lastInput.do === "press",
      );
    if (!held) throw new Error(`Screenshot lost the ${lastInput.do} state`);
  }
  const measurement = await measure(target, {
    component: component.id,
    state: state.id,
    theme,
    scale,
    gymState: state.gymState,
    crop,
    files: {
      crop: relative(run, cropFile),
      ...(component.zoom
        ? {
            zoom400: relative(run, file("zoom-400.png")),
            zoom800: relative(run, file("zoom-800.png")),
          }
        : {}),
      overlay: relative(run, file("overlay.png")),
    },
    ...(inventory
      ? {
          inventory: inventory.components
            .flatMap((c) =>
              c.states
                .filter((s) => s.gymState === state.gymState)
                .map((s) => ({ id: c.id, selector: s.target ?? c.selector })),
            )
            .filter(
              (candidate, index, all) =>
                all.findIndex(
                  (other) => other.id === candidate.id && other.selector === candidate.selector,
                ) === index,
            ),
        }
      : {}),
  });
  if (measurement.devicePixelRatio !== scale)
    throw new Error(`Expected devicePixelRatio ${scale}, got ${measurement.devicePixelRatio}`);
  await writeFile(cropFile, png);
  await save(file(`measure-${scale}x.json`), measurement);
  if (native)
    await save(file(`native-tooltip-${scale}x.json`), {
      windowId: native.windowId,
      surface: native.surface,
      title: await target.getAttribute("title"),
      focused: await target.evaluate((el) => el.matches(":focus-visible")),
      reducedMotion: await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    });
  if (scale === 1 && component.zoom) {
    await writeFile(file("zoom-400.png"), zoom(png, 4));
    await writeFile(file("zoom-800.png"), zoom(png, 8));
  }
  if (scale === 2) await writeFile(file("overlay.png"), overlay(png, measurement));
  return measurement;
}

export async function run(options: Options): Promise<number> {
  if (process.platform === "darwin")
    throw new Error("Up-close Electron captures run only on the pinned Linux box");
  const started = Date.now(),
    run = resolve(options.run),
    paths = runPaths(run);
  const inventory = JSON.parse(await readFile(inventoryFile, "utf8")) as Inventory;
  const tasks = plan(inventory, options),
    batches = groups(tasks),
    findings: Finding[] = [];
  if (!tasks.length) throw new Error("No capture tasks matched the requested filters and shard");
  let captured = 0;
  const failures: unknown[] = [];
  const recordFailure = async (task: CaptureTask, scale: Scale, error: unknown, page: Page) => {
    const { component, state, theme } = task;
    const fields = {
      check: "inventory" as const,
      component: component.id,
      state: state.id,
      theme,
      scale,
      gymState: state.gymState,
      selector: state.target ?? component.selector,
      measured: error instanceof Error ? error.message.split("\n")[0] : String(error),
      expected: "a rendered target reached by its input steps",
      message: "Inventory state could not be captured.",
    };
    findings.push({ id: findingId(fields), ...fields });
    console.warn(`${component.id}/${state.id}/${theme}/${scale}: ${fields.measured}`);
    failures.push({
      ...fields,
      page: await page
        .evaluate(() => ({
          url: location.href,
          text: document.body.innerText.slice(0, 14000),
          controls: [...document.querySelectorAll("button,input,select,textarea,[role]")]
            .map((e) => ({
              tag: e.tagName,
              classes: e.getAttribute("class"),
              role: e.getAttribute("role"),
              label: e.getAttribute("aria-label"),
              text: e.textContent?.slice(0, 120),
            }))
            .slice(0, 100),
        }))
        .catch(() => null),
    });
  };
  const determinism: unknown[] = [];
  const observedRules: unknown[] = [];
  for (const scale of [1, 2] as const) {
    const gym = await openGym({ scale });
    const successful = new Set<CaptureTask>();
    try {
      await resize(gym.page, 1320, 840);
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index]!,
          first = batch[0]!;
        try {
          await releaseInput(gym.page);
          await resize(gym.page, 1320, 840);
          if (!(await showState(gym.page, first.state.gymState, first.theme)))
            throw new Error("Gym state did not render");
          await performSteps(gym.page, first.state.steps);
        } catch (error) {
          for (const task of batch) await recordFailure(task, scale, error, gym.page);
          continue;
        }
        for (const task of batch) {
          try {
            await capture(gym.page, task, scale, run, inventory);
            captured++;
            successful.add(task);
            if (scale === 1 && task.state.id === "default")
              observedRules.push({
                component: task.component.id,
                theme: task.theme,
                rules: await stateRules(
                  gym.page
                    .locator(task.state.target ?? task.component.selector)
                    .nth(task.state.nth ?? 0),
                ),
              });
          } catch (error) {
            await recordFailure(task, scale, error, gym.page);
          }
        }
        await releaseInput(gym.page);
        if (index % 20 === 0)
          console.log(
            `shard ${options.shard.join("/")} scale ${scale}: ${index + 1}/${batches.length} groups, ${captured} captures, ${findings.length} inventory findings`,
          );
      }
      const candidate =
        tasks.find(
          (t) => successful.has(t) && t.component.id === "button" && t.state.id === "default",
        ) ??
        tasks.find((t) => successful.has(t) && !t.state.steps?.length) ??
        tasks.find((t) => successful.has(t));
      if (candidate) {
        try {
          const samples = [];
          for (let i = 0; i < 2; i++) {
            await releaseInput(gym.page);
            await resize(gym.page, 1320, 840);
            if (!(await showState(gym.page, candidate.state.gymState, candidate.theme)))
              throw new Error("Determinism scene did not render");
            await performSteps(gym.page, candidate.state.steps);
            samples.push(await capture(gym.page, candidate, scale, run, inventory));
          }
          const equal = JSON.stringify(samples[0]) === JSON.stringify(samples[1]);
          determinism.push({
            component: candidate.component.id,
            state: candidate.state.id,
            theme: candidate.theme,
            scale,
            identical: equal,
          });
          await save(resolve(run, `determinism-${options.shard[0]}-${scale}.json`), {
            identical: equal,
            samples,
          });
        } catch (error) {
          await recordFailure(candidate, scale, error, gym.page);
          determinism.push({
            component: candidate.component.id,
            scale,
            identical: false,
            error: String(error),
          });
        }
      }
    } finally {
      try {
        await releaseInput(gym.page);
      } finally {
        await gym.close();
      }
    }
  }
  await save(resolve(run, `state-rules-${options.shard[0]}.json`), observedRules);
  await save(paths.findings(`inventory-${options.shard[0]}`), findings);
  await save(resolve(run, `inventory-diagnostics-${options.shard[0]}.json`), failures);
  await save(resolve(run, `capture-summary-${options.shard[0]}.json`), {
    captured,
    planned: tasks.length * 2,
    components: new Set(tasks.map((t) => t.component.id)).size,
    states: tasks.length / 2,
    themes: ["dark", "light"],
    scales: [1, 2],
    durationSeconds: (Date.now() - started) / 1000,
    determinism,
    inventoryFindings: findings.length,
  });
  if (!options.skipChecks) {
    if (captured > 0) await runChecks(run);
    await writeReport(run);
  }
  console.log(
    `Captured ${captured}/${tasks.length * 2} in ${((Date.now() - started) / 1000).toFixed(1)}s; inventory findings ${findings.length}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
