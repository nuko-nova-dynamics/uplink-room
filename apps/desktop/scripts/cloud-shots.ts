import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";
import { appDir } from "./lib.ts";

/**
 * Review screenshots of the cloud machine settings (#10), from the built app's
 * sample-data page (src/renderer/cloud-harness.tsx). It needs no sign-in and
 * no backend:
 *
 *   pnpm --filter @uplink-room/desktop build
 *   node scripts/cloud-shots.ts [out-dir]
 */
const outDir = process.argv[2] ?? join(appDir, "screenshots");
await mkdir(outDir, { recursive: true });

for (const theme of ["dark", "light"] as const) {
  for (const state of ["states", "add"] as const) {
    const env = { ...process.env, UPLINK_START_PATH: `/cloud-harness.html?state=${state}&theme=${theme}` } as Record<string, string>;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["ELECTRON_RENDERER_URL"];
    const app = await electron.launch({ args: [appDir], env });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1320, height: 840 });
      await page.locator(".app").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, `cloud-machine-${state}-${theme}.png`) });
    } finally {
      await app.close();
    }
  }
}
console.log(`Saved to ${outDir}`);
