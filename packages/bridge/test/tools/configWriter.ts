// node configWriter.ts HOME COUNT: adds 1 to bridge.json's afterSeq COUNT times, each a separate
// read-modify-write, as a running bridge's cursor saves do. Several of these run at once in the
// config test, so any update lost to a race shows in the final count.
import { updateConfig } from "../../src/config.ts";

const [home, count] = process.argv.slice(2);
// The test is about lost updates, not waiting: on a loaded CI runner one writer can lose the lock
// race for longer than a bridge's 10 s wait, so it waits as long as the test may take.
for (let i = 0; i < Number(count); i++)
  await updateConfig(home!, (config) => void (config.afterSeq = (config.afterSeq ?? 0) + 1), { waitMs: 60_000 });
