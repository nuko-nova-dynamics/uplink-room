import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/**
 * The .deb's after-install and after-remove (build/linux, electron-builder.yml `deb`): electron-builder's
 * own templates, unchanged, with the `uplink-bridge`, `uplink` and `uplink-mcp` links added at the end of each.
 */
const here = dirname(fileURLToPath(import.meta.url));
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const ours = async (name: string) => lf(await readFile(join(here, "..", "..", "build", "linux", name), "utf8"));

async function template(name: string) {
  const require = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  return lf(await readFile(join(dirname(require.resolve("app-builder-lib/package.json")), "templates", "linux", name), "utf8"));
}

test("each script is electron-builder's default template with only the uplink-bridge block after it", async () => {
  for (const [script, tpl] of [
    ["after-install.sh", "after-install.tpl"],
    ["after-remove.sh", "after-remove.tpl"],
  ] as const) {
    const text = await ours(script);
    const end = text.indexOf("\n# >>> uplink-bridge");
    expect(end, script).toBeGreaterThan(0);
    // An electron-builder upgrade that changes its template fails here: copy the new one in, then the block.
    expect(text.slice(0, end).trimEnd(), script).toBe((await template(tpl)).trimEnd());
    // electron-builder replaces ${name} in the whole file and stops at a name it doesn't know.
    expect([...text.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]).filter((n) => n !== "executable" && n !== "sanitizedProductName"), script).toEqual([]);
  }
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The script's uplink-bridge block, run by bash with the links and launchers moved into a temporary root. */
async function block(script: string) {
  const root = await mkdtemp(join(tmpdir(), "uplink-deb-"));
  roots.push(root);
  const linkDir = join(root, "usr", "bin");
  const launcherDir = join(root, "opt", "Uplink Room", "resources", "bin");
  await mkdir(linkDir, { recursive: true });
  await mkdir(launcherDir, { recursive: true });
  for (const name of NAMES) await writeFile(join(launcherDir, name), "#!/bin/sh\n", { mode: 0o755 });
  const text = await ours(script);
  const body = text
    .slice(text.indexOf("# >>> uplink-bridge"), text.indexOf("# <<< uplink-bridge"))
    .replace(/^UPLINK_LINK_DIR=.*$/m, `UPLINK_LINK_DIR='${linkDir}'`)
    .replace(/^UPLINK_LAUNCHER_DIR=.*$/m, `UPLINK_LAUNCHER_DIR='${launcherDir}'`);
  return {
    link: (name: string) => join(linkDir, name),
    launcher: (name: string) => join(launcherDir, name),
    run: () => execFileSync("bash", ["-c", body], { encoding: "utf8" }),
  };
}

const NAMES = ["uplink-bridge", "uplink", "uplink-mcp"];

test.runIf(process.platform !== "win32")("after-install links uplink-bridge, uplink and uplink-mcp unless something else is there; after-remove takes away only its own links", async () => {
  const install = await block("after-install.sh");
  expect(install.run()).toBe("");
  for (const name of NAMES) expect(await readlink(install.link(name))).toBe(install.launcher(name));
  // Installing again changes nothing.
  expect(install.run()).toBe("");
  for (const name of NAMES) expect(await readlink(install.link(name))).toBe(install.launcher(name));

  // A link to another copy of Uplink Room, gone or not (an earlier install that moved, an AppImage's
  // old mount), is replaced.
  for (const name of NAMES) {
    for (const copy of [`/media/old disk/Uplink Room/resources/bin/${name}`, `/tmp/.mount_UplinkAbc123/resources/bin/${name}`]) {
      await rm(install.link(name));
      await symlink(copy, install.link(name));
      expect(install.run()).toBe("");
      expect(await readlink(install.link(name))).toBe(install.launcher(name));
    }
  }

  // A link to another copy's other command isn't this one's: it's left alone.
  await rm(install.link("uplink"));
  await symlink("/media/old disk/Uplink Room/resources/bin/uplink-bridge", install.link("uplink"));
  expect(install.run()).toContain("Left");
  expect(await readlink(install.link("uplink"))).toBe("/media/old disk/Uplink Room/resources/bin/uplink-bridge");

  // A dangling link to anything else is left alone, and says so; the others are still made.
  await rm(install.link("uplink"));
  await rm(install.link("uplink-mcp"));
  await symlink("/opt/someone-else/uplink", install.link("uplink"));
  expect(install.run()).toContain(`Left ${install.link("uplink")} as it is`);
  expect(await readlink(install.link("uplink"))).toBe("/opt/someone-else/uplink");
  expect(await readlink(install.link("uplink-mcp"))).toBe(install.launcher("uplink-mcp"));

  // A bridge installed with npm is left alone.
  await rm(install.link("uplink-bridge"));
  await writeFile(install.link("uplink-bridge"), "#!/usr/bin/env node\n", { mode: 0o755 });
  expect(install.run()).toContain("Left");
  expect(await readFile(install.link("uplink-bridge"), "utf8")).toBe("#!/usr/bin/env node\n");

  const remove = await block("after-remove.sh");
  await writeFile(remove.link("uplink-bridge"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await symlink(remove.launcher("uplink"), remove.link("uplink"));
  await symlink(remove.launcher("uplink-mcp"), remove.link("uplink-mcp"));
  remove.run();
  expect(await readFile(remove.link("uplink-bridge"), "utf8")).toBe("#!/usr/bin/env node\n");
  await expect(readlink(remove.link("uplink"))).rejects.toThrow();
  await expect(readlink(remove.link("uplink-mcp"))).rejects.toThrow();
});
