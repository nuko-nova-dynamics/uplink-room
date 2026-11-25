import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // A worker exits when Vitest's process is gone, though convex-test's timers would keep it.
    execArgv: ["--require", fileURLToPath(new URL("../../scripts/vitest-exit-with-parent.cjs", import.meta.url))],
    // convex-test runs every query in memory, and a few tests write hundreds of rows. Those take
    // 4-5 s on the shared Windows runners when another job is running, so the default 5 s fails
    // them for load, not for a bug.
    testTimeout: 20_000,
    server: { deps: { inline: ["convex-test"] } },
    // Starts local A2A agents (in Node) for tests/a2a.test.ts.
    globalSetup: ["tests/a2a/globalSetup.ts"],
    env: {
      // A test-only key for sealing A2A tokens: 32 zero bytes. Real deployments set their own.
      A2A_CREDENTIALS_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      // The local A2A agents listen on http://127.0.0.1.
      A2A_ALLOW_INSECURE_PEERS: "1",
    },
  },
});
