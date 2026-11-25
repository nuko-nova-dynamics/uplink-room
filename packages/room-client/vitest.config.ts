import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // A worker exits when Vitest's process is gone, though convex-test's timers would keep it.
    execArgv: ["--require", fileURLToPath(new URL("../../scripts/vitest-exit-with-parent.cjs", import.meta.url))],
    // Each file's first test loads every backend function into convex-test. On the shared Windows
    // runners, with another job running, that alone takes over 5 s, so the default timeout failed
    // them for load, not for a bug (as in packages/backend/vitest.config.ts).
    testTimeout: 20_000,
    server: { deps: { inline: ["convex-test"] } },
  },
});
