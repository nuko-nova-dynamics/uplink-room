import { defineConfig } from "vitest/config";

/**
 * The desktop app's unit tests cover logic that needs neither Electron nor a
 * page: token storage, the notification text and buttons (`src/main/`), and
 * which events play a cue or show a banner (`src/renderer/lib/signals.test.ts`).
 * Chat's components (spec #63: mention autocomplete, editing, reaction chips,
 * the "new" divider) have component tests, `*.test.tsx`, which render into
 * happy-dom. Layout is left to screenshot review (see `screenshots/`), and the
 * one integration check, the posted-HTML isolation test, is a Playwright test
 * that launches Electron (`pnpm --filter @uplink-room/desktop test:isolation`).
 * CI has no Electron binary, so `pnpm test` must not pick that file up.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/upclose/**/*.test.ts"],
    passWithNoTests: true,
  },
});
