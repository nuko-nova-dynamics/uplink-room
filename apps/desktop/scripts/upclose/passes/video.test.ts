import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { video } from "./common.ts";

// The passes record only on the Linux gym box; the stand-in ffmpeg here is a POSIX shell script.
it.skipIf(process.platform === "win32")(
  "waits for recorder output before returning a capture handle",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "upclose-video-test-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      await writeFile(
        join(root, "ffmpeg"),
        `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGINT', () => process.exit(0));
setTimeout(() => fs.writeFileSync(process.argv.at(-1), 'recording'), 80);
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", root + ":" + process.env["PATH"]);
      const file = join(root, "capture.webm");
      stop = await video(file);
      expect(await readFile(file, "utf8")).toBe("recording");
    } finally {
      await stop?.();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
