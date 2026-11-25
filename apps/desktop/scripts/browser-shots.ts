import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";
import { appDir } from "./lib.ts";

/**
 * Review screenshots of the shared-browser screens (spec #7), from the built
 * app's sample-data page (src/renderer/browser-harness.tsx). It needs no
 * sign-in and no backend:
 *
 *   pnpm --filter @uplink-room/desktop build
 *   node scripts/browser-shots.ts
 */
const outDir = join(appDir, "screenshots");
await mkdir(outDir, { recursive: true });

const SHOTS: { file: string; state: string; prepare?: (page: Page) => Promise<void> }[] = [
  { file: "23-browser-driving", state: "driver" },
  { file: "24-browser-watching-full", state: "watcher" },
  { file: "25-browser-start", state: "start" },
  { file: "26-browser-not-set-up", state: "unset" },
  { file: "27-browser-settings", state: "settings" },
  // Saved logins (ADR 0011): keeping a new browser's logins, named, for 7 days.
  {
    file: "28-browser-keep-logins",
    state: "start",
    prepare: async (page) => {
      await page.getByRole("button", { name: "Keep logins" }).click();
      await page.getByLabel("Name").fill("billing sandbox");
    },
  },
];

for (const theme of ["dark", "light"] as const) {
  for (const shot of SHOTS) {
    const env = { ...process.env, UPLINK_START_PATH: `/browser-harness.html?state=${shot.state}&theme=${theme}` } as Record<
      string,
      string
    >;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["ELECTRON_RENDERER_URL"];
    const app = await electron.launch({ args: [appDir], env });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1320, height: 840 });
      await page.locator(".app").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await shot.prepare?.(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, `${shot.file}-${theme}.png`) });
      if (shot.state === "driver") {
        await page.setViewportSize({ width: 960, height: 600 });
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(outDir, `${shot.file}-small-${theme}.png`) });
      }
    } finally {
      await app.close();
    }
  }
}
console.log(`Saved to ${outDir}`);
