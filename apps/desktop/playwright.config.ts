import { defineConfig } from "@playwright/test";

/**
 * The one integration check the spec asks for (e2e/isolation.spec.ts). It
 * launches the built Electron app, so run `pnpm --filter @uplink-room/desktop build`
 * first (the `test:isolation` script does).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
