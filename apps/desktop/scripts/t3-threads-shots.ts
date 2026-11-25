import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { serveRenderer } from "./lib.ts";

/**
 * Settings, Machines: this computer's T3 Code threads (ADR 0045), captured from the built renderer's
 * gym (sample data, no backend) in headless Chromium at 1440 and 390 CSS pixels wide, in both themes,
 * through the states a person reaches: the list, a search, picks waiting to be saved, a saved change,
 * a refused save, no match, and the states with no list. Each capture is the viewport with the
 * section scrolled into it, plus the section alone. Headless Chromium, not the gym's hidden Electron
 * window: without Xvfb that window paints once and then takes no new frame on Linux. The renderer is
 * the same bundle; the gym gives it every desktop API it uses here.
 *
 *   pnpm --filter @uplink-room/desktop build
 *   node scripts/t3-threads-shots.ts <out folder>
 */
const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/t3-threads-shots.ts <out folder>");
await mkdir(out, { recursive: true });
const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
  // The smallest window the app allows (main/index.ts).
  { name: "960", width: 960, height: 600 },
] as const;
const THEMES = ["dark", "light"] as const;

type Take = { name: string; state: string; act?: (page: Page) => Promise<void>; only?: string };
const section = (page: Page) => page.locator("section.t3-threads");
const box = (page: Page, title: string) => section(page).locator(".t3-thread", { hasText: title }).locator("input[type=checkbox]");
const TAKES: Take[] = [
  { name: "list", state: "settings-t3-threads" },
  { name: "search", state: "settings-t3-threads", act: (page) => section(page).getByRole("searchbox", { name: "Search T3 Code threads" }).fill("billing") },
  {
    name: "picked",
    state: "settings-t3-threads",
    act: async (page) => {
      await box(page, "Tax export columns").check();
      await box(page, "Retry webhook deliveries").uncheck();
    },
  },
  {
    name: "saved",
    state: "settings-t3-threads",
    act: async (page) => {
      await box(page, "Tax export columns").check();
      await section(page).getByRole("button", { name: "Save changes" }).click();
      await page.locator(".toast").first().waitFor();
    },
  },
  {
    name: "save-failed",
    state: "settings-t3-threads-save-fails",
    act: async (page) => {
      await box(page, "Draft the Q4 roadmap").check();
      await section(page).getByRole("button", { name: "Save changes" }).click();
      await section(page).getByRole("alert").waitFor();
    },
  },
  // The app has no phone layout (its window is at least 960 wide), so at 390 the shell clips the pane.
  // This shows the machine's panel itself at 390 px wide in the 1440 window: a probe of how the section
  // reflows at phone width, not a screen anyone sees.
  {
    name: "panel390-probe",
    state: "settings-t3-threads",
    only: "1440",
    act: async (page) => {
      await box(page, "Tax export columns").check();
      await box(page, "Retry webhook deliveries").uncheck();
      await page.evaluate(() => document.querySelector("section.t3-threads")?.closest<HTMLElement>(".panel")?.style.setProperty("width", "390px"));
    },
  },
  { name: "no-match", state: "settings-t3-threads", act: (page) => section(page).getByRole("searchbox").fill("payroll export 2019") },
  { name: "empty", state: "settings-t3-threads-empty" },
  { name: "bridge-off", state: "settings-t3-threads-bridge-off" },
  { name: "unavailable", state: "settings-t3-threads-unavailable" },
  { name: "other-environment", state: "settings-t3-threads-other-environment" },
];

const capture = (page: Page, path: string, clip?: { x: number; y: number; width: number; height: number }) =>
  page.screenshot({ path, ...(clip ? { clip } : {}) });

const { server, url } = await serveRenderer();
const browser = await chromium.launch({ headless: true });
const report: Record<string, unknown>[] = [];
const errors: string[] = [];
try {
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`);
    });
    for (const theme of THEMES) {
      for (const take of TAKES) {
        if (take.only && take.only !== size.name) continue;
        await page.goto(`${url}/gym.html?state=${take.state}&theme=${theme}`);
        await page.waitForFunction((id) => document.querySelector("[data-gym-state]")?.getAttribute("data-gym-state") === id, take.state);
        await page.evaluate(() => document.fonts.ready);
        await section(page).waitFor({ timeout: 8000 });
        await take.act?.(page);
        await page.waitForTimeout(350);
        // The settings pane scrolls, not the page: bring the section to its top, then clip to it.
        await page.evaluate(() => document.querySelector("section.t3-threads")?.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(150);
        const base = `${take.name}-${size.name}-${theme}`;
        await capture(page, join(out, `${base}.png`));
        const clip = await page.evaluate(() => {
          const r = document.querySelector("section.t3-threads")!.getBoundingClientRect();
          return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight - Math.max(0, r.top)) };
        });
        await capture(page, join(out, `${base}-section.png`), clip);
        // What a person meets: page overflow, the section's box, and the computed sizes of its text.
        report.push({
          take: base,
          ...(await page.evaluate(() => {
            const el = document.querySelector("section.t3-threads")!;
            const rect = el.getBoundingClientRect();
            const overflowing = [...el.querySelectorAll("*")].filter((node) => {
              const r = node.getBoundingClientRect();
              return r.width > 0 && (r.right > rect.right + 1 || r.left < rect.left - 1);
            }).length;
            const fonts = [...new Set([...el.querySelectorAll(".t3-thread-title, .sub, .hint, .label, .note, .btn, .chip")].map((n) => getComputedStyle(n).fontSize))];
            return {
              viewport: innerWidth,
              pageScrollWidth: document.documentElement.scrollWidth,
              section: { left: Math.round(rect.left), width: Math.round(rect.width) },
              childrenOutsideSection: overflowing,
              fontSizes: fonts,
              checkboxes: el.querySelectorAll("input[type=checkbox]").length,
              unnamedControls: [...el.querySelectorAll("button, input")].filter((c) => !(c.getAttribute("aria-label") || c.textContent?.trim() || c.closest("label"))).length,
            };
          })),
        });
      }
    }
    await context.close();
  }
  await writeFile(join(out, "report.json"), JSON.stringify({ report, errors }, null, 1));
  console.log(`Captured ${report.length} takes into ${out}; ${errors.length} console errors.`);
} finally {
  await browser.close();
  server.close();
}
