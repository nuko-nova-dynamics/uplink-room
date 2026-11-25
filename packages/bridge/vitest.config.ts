import { defineConfig } from "vitest/config";

/**
 * The bridge tests start real terminals and hook processes. On a loaded CI
 * runner, and in Windows' ConPTY, a process can take seconds to start, so
 * every `expect.poll` waits up to 20 seconds instead of Vitest's 1 second.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 20_000, interval: 50 } },
    // Ends the spawn-helpers an earlier run left when it was killed while starting a terminal.
    globalSetup: ["test/globalSetup.ts"],
  },
});
