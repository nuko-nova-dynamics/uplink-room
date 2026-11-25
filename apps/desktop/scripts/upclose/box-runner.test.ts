import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// run.sh is a POSIX shell script for macOS and Linux hosts that drive instabox; Windows never runs it.
it.skipIf(process.platform === "win32")(
  "waits for the box exit marker before pulling after an SSH disconnect",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gym-runner-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const scripts = {
      git: `#!/bin/bash
case "$*" in
  'rev-parse --show-toplevel') echo "$GYM_RUNNER_TEST_ROOT" ;;
  'rev-parse HEAD') echo test-head ;;
  archive*) echo archive ;;
esac
`,
      sleep: "#!/bin/bash\nexit 0\n",
      instabox: `#!/bin/bash
case "$1" in
  push) exit 0 ;;
  ssh)
    if [[ "$*" == *'bash -s'* ]]; then
      cat > "$GYM_RUNNER_TEST_ROOT/remote.sh"
      sed -n 's/^run_token=//p' "$GYM_RUNNER_TEST_ROOT/remote.sh" > "$GYM_RUNNER_TEST_ROOT/token"
      exit 255
    elif [[ "$*" == *command.token* ]]; then
      cat "$GYM_RUNNER_TEST_ROOT/token"
    elif [[ "$*" == *command.exit* ]]; then
      if [[ ! -f "$GYM_RUNNER_TEST_ROOT/checked" ]]; then
        touch "$GYM_RUNNER_TEST_ROOT/checked"
        exit 1
      fi
      touch "$GYM_RUNNER_TEST_ROOT/complete"
      echo 0
    fi
    ;;
  pull)
    [[ -f "$GYM_RUNNER_TEST_ROOT/complete" ]] || exit 2
    mkdir -p "$4"
    echo complete > "$4/receipt"
    ;;
esac
`,
    };
    try {
      for (const [name, body] of Object.entries(scripts))
        await writeFile(join(bin, name), body, { mode: 0o755 });
      const out = join(root, "out");
      const { stdout } = await promisify(execFile)(
        "bash",
        [new URL("../gym-box/run.sh", import.meta.url).pathname, "test-box", out, "--", "true"],
        {
          env: {
            ...process.env,
            PATH: bin + ":" + process.env["PATH"],
            GYM_RUNNER_TEST_ROOT: root,
          },
        },
      );
      expect(stdout).toContain("SSH disconnected. Waiting for the box command to finish.");
      expect(await readFile(join(out, "receipt"), "utf8")).toBe("complete\n");
      expect(await readFile(join(root, "remote.sh"), "utf8")).toContain("nohup bash -c");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
