// One gym window for the up-close passes (issue #173): the built app on gym.html, driven over CDP,
// with no sign-in, no backend, no banner, no sound and synthetic media. The same rules as
// scripts/gym.ts: a free port per run, the hidden gym window (#125), links logged instead of opened,
// and the Electron child killed by PID when the caller closes it. Never call process.exit before close().
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { prepare } from "../gymPrepare.ts";
import { appDir, freePort } from "../lib.ts";
import type { Scale, Theme } from "./types.ts";

export type Gym = {
  page: Page;
  browser: Browser;
  child: ChildProcess;
  port: number;
  scale: Scale;
  close(): Promise<void>;
};

export const gymUrl = (state: string, theme: Theme = "dark") =>
  `uplink-room://app/gym.html?state=${state}&theme=${theme}`;

/**
 * Launches the built app (pnpm --filter @uplink-room/desktop build) on gym.html at device scale 1 or 2.
 * UPLINK_GYM_ELECTRON_ARGS adds switches the platform needs (for example --no-sandbox in a box).
 */
export async function openGym(options: { scale?: Scale; log?: string } = {}): Promise<Gym> {
  if (process.platform === "darwin")
    throw new Error("The capture gym runs on the Linux box, never on the Mac");
  const scale = options.scale ?? 1;
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), "uplink-upclose-"));
  const env = {
    ...process.env,
    UPLINK_QUIET: "1",
    UPLINK_NO_UPDATES: "1",
    UPLINK_FAKE_MEDIA: "1",
    UPLINK_START_PATH: "/gym.html",
  } as Record<string, string>;
  if (options.log) env["UPLINK_NOTIFY_LOG"] = options.log;
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["ELECTRON_RENDERER_URL"];
  const extra = (process.env["UPLINK_GYM_ELECTRON_ARGS"] ?? "").split(" ").filter(Boolean);
  const electronBin = (await import("electron")).default as unknown as string;
  const child = spawn(
    electronBin,
    [
      appDir,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--force-device-scale-factor=${scale}`,
      ...extra,
    ],
    { env, stdio: "ignore" },
  );
  const close = async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  try {
    let browser: Browser | undefined;
    for (let i = 0; i < 60 && !browser; i++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
      if (!browser) await new Promise((r) => setTimeout(r, 500));
    }
    if (!browser) throw new Error("The gym's window didn't open.");
    let page: Page | undefined;
    for (let i = 0; i < 40 && !page; i++) {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("gym.html"));
      if (!page) await new Promise((r) => setTimeout(r, 250));
    }
    if (!page) throw new Error("No gym page.");
    page.setDefaultTimeout(5000);
    await page.waitForFunction(() => "gymStates" in window);
    const b = browser;
    return {
      page,
      browser: b,
      child,
      port,
      scale,
      close: async () => (await b.close().catch(() => {}), await close()),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The window's size in CSS pixels; 960 × 600 is the smallest the app allows. */
export async function resize(page: Page, width: number, height: number): Promise<void> {
  await page.evaluate(
    ([w, h]) => window.resizeTo(w! + outerWidth - innerWidth, h! + outerHeight - innerHeight),
    [width, height],
  );
  await page.waitForFunction(
    ([w, h]) => window.innerWidth === w && window.innerHeight === h,
    [width, height],
    { timeout: 2500 },
  );
}

/**
 * Loads a gym state in one theme (a fresh load per theme, never a flipped data-theme), waits for fonts
 * and the first render, and runs the clicks scripts/gymPrepare.ts gives that state. False when it didn't render.
 */
export async function showState(
  page: Page,
  state: string,
  theme: Theme,
  options: { reducedMotion?: boolean } = {},
): Promise<boolean> {
  await page.bringToFront();
  await page.clock.setFixedTime(new Date("2026-11-02T19:24:00Z"));
  await page.emulateMedia({ reducedMotion: options.reducedMotion ? "reduce" : "no-preference" });
  await page.goto(gymUrl(state, theme));
  const shown = await page
    .waitForFunction(
      (id) => {
        const root = document.querySelector("[data-gym-state]");
        return root?.getAttribute("data-gym-state") === id && root.childElementCount > 0;
      },
      state,
      { timeout: 5000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!shown) return false;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  await prepare(page, state);
  await page.waitForTimeout(50);
  return true;
}
