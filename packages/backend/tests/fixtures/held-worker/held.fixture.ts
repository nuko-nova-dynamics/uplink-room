// Run only by tests/processes.test.ts, through the vitest.config.ts beside it: a test that passes
// and leaves a timer, as convex-test does for a function scheduled a week out.
import { writeFileSync } from "node:fs";
import { test } from "vitest";

test("leaves a timer", () => {
  setTimeout(() => {}, 7 * 24 * 60 * 60 * 1000);
  writeFileSync(process.env.HELD_WORKER_PID_FILE!, String(process.pid));
});
