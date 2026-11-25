import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { endOrphanedHelpers, orphanedHelpers } from "./globalSetup.ts";

const TERM = fileURLToPath(new URL("./tools/term.mjs", import.meta.url));

// A process that starts terminals and is killed at once, as a test worker killed mid-test is.
const DIES_WHILE_SPAWNING = `
import pty from "node-pty";
for (let i = 0; i < 10; i++) pty.spawn(process.execPath, [${JSON.stringify(TERM)}, "echo"], { cols: 80, rows: 24 });
process.kill(process.pid, "SIGKILL");
`;

test.skipIf(process.platform !== "darwin")(
  "terminals whose process is killed as they start leave spawn-helpers that the test run ends",
  async () => {
    const before = new Set(orphanedHelpers());
    const child = spawn(process.execPath, ["--input-type=module", "-e", DIES_WHILE_SPAWNING], { cwd: import.meta.dirname, stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));

    // node-pty's helper waits forever for a terminal whose other end closed before it opened it.
    const stuck = orphanedHelpers().filter((pid) => !before.has(pid));
    expect(stuck.length).toBeGreaterThan(0);

    expect(endOrphanedHelpers()).toEqual(expect.arrayContaining(stuck));
    await expect.poll(() => orphanedHelpers().filter((pid) => stuck.includes(pid))).toEqual([]);
  },
);
