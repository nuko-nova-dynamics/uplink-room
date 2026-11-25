import { defineConfig } from "vitest/config";

/** The site's tests cover the logic that needs no page: reading the update feed and picking the visitor's platform. */
export default defineConfig({
  test: { include: ["lib/**/*.test.ts"] },
});
