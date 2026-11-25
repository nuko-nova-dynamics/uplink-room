import { writeFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import backend from "../../../vitest.config.ts";

// The backend's worker settings, for held.fixture.ts alone. Once the file's tests are done, and
// before Vitest stops the worker that ran them, Vitest says so in HELD_WORKER_DONE_FILE and waits
// to be killed: as when `| grep -q` closed its output and it died on EPIPE in that moment.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: "node",
    include: ["held.fixture.ts"],
    execArgv: backend.test?.execArgv ?? [],
    reporters: [
      "default",
      {
        onTestModuleEnd: async () => {
          writeFileSync(process.env.HELD_WORKER_DONE_FILE!, "done");
          await new Promise(() => {});
        },
      },
    ],
  },
});
