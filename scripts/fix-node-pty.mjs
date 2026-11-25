// node-pty 1.1.0's prebuilt spawn-helper installs without its execute bit,
// so every spawn fails with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const store = join(import.meta.dirname, "..", "node_modules", ".pnpm");
if (existsSync(store)) {
  for (const dir of readdirSync(store).filter((d) => d.startsWith("node-pty@"))) {
    const prebuilds = join(store, dir, "node_modules", "node-pty", "prebuilds");
    if (!existsSync(prebuilds)) continue;
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
}
