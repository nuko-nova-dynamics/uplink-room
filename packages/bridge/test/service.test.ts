import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installService, uninstallService, unitFile, type ServiceRunner } from "../src/service.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the unit runs the bridge with the installer's PATH, quoted for systemd", () => {
  const unit = unitFile({
    execPath: "/opt/node 24/bin/node",
    script: '/home/ana/a"b/uplink-bridge.mjs',
    path: "/home/ana/100%/bin:/usr/bin",
    bridgeHome: "/home/ana/$box",
  });
  expect(unit).toContain('ExecStart="/opt/node 24/bin/node" "/home/ana/a\\"b/uplink-bridge.mjs" run');
  expect(unit).toContain('Environment="PATH=/home/ana/100%%/bin:/usr/bin"');
  expect(unit).toContain('Environment="UPLINK_BRIDGE_HOME=/home/ana/$$box"');
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).not.toContain("ELECTRON_RUN_AS_NODE");
});

test("install writes the unit, starts it and asks for lingering; uninstall removes it", async () => {
  const config = await mkdtemp(join(tmpdir(), "uplink-service-"));
  cleanups.push(() => rm(config, { recursive: true, force: true }));
  const calls: string[] = [];
  const run: ServiceRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args.includes("--property=Linger")) return { code: 0, stdout: "no\n", stderr: "" };
    if (args[0] === "enable-linger") return { code: 1, stdout: "", stderr: "Access denied" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const lines: string[] = [];
  const context = { env: { XDG_CONFIG_HOME: config, PATH: "/usr/bin" }, platform: "linux" as const, run, log: (l: string) => lines.push(l) };

  await installService({ linger: true }, context);
  const file = join(config, "systemd", "user", "uplink-bridge.service");
  expect(await readFile(file, "utf8")).toContain('Environment="PATH=/usr/bin"');
  expect(calls.filter((c) => c.startsWith("systemctl"))).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable uplink-bridge.service",
    "systemctl --user restart uplink-bridge.service",
  ]);
  expect(lines.join("\n")).toMatch(/sudo loginctl enable-linger \S+/);

  await uninstallService(context);
  await expect(stat(file)).rejects.toThrow();
  await expect(installService({ linger: false }, { ...context, platform: "darwin" })).rejects.toThrow(/on Linux/);
});
