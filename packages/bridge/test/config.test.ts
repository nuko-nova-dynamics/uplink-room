import { afterEach, expect, test } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_LIMITS, loadConfig, saveConfig, updateConfig } from "../src/config.ts";
import { main } from "../src/cli.ts";
import { LocalSocket } from "../src/localSocket.ts";
import { socketPathFor } from "../src/platform.ts";
import type { Bridge } from "../src/bridge.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "uplink-config-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("a running bridge's saves never put back a pairing that was replaced", async () => {
  const home = await tempHome();
  await saveConfig({ url: "https://old", token: "old-token", machineId: "m-old", teamId: "t-old", afterSeq: 5, limits: DEFAULT_LIMITS }, home);
  // Re-pairing replaces bridge.json while the old pairing's bridge still runs.
  await saveConfig({ url: "https://new", token: "new-token", machineId: "m-new", teamId: "t-new", afterSeq: 0, limits: DEFAULT_LIMITS }, home);

  // The old bridge's cursor save is refused, so the new pairing stays.
  expect(await updateConfig(home, (config) => void (config.afterSeq = 9), { token: "old-token" })).toBe(false);
  expect(await loadConfig(home)).toMatchObject({ url: "https://new", token: "new-token", machineId: "m-new", afterSeq: 0 });

  // Saves for the current pairing change only their own field and keep what other commands wrote.
  await saveConfig({ ...(await loadConfig(home)), t3: { url: "http://127.0.0.1:3773", token: "t3-token" } }, home);
  expect(await updateConfig(home, (config) => void (config.afterSeq = 3), { token: "new-token" })).toBe(true);
  const limits = { ...DEFAULT_LIMITS, slots: 4 };
  expect(await updateConfig(home, (config) => void (config.limits = limits))).toBe(true);
  expect(await loadConfig(home)).toMatchObject({
    token: "new-token",
    machineId: "m-new",
    afterSeq: 3,
    limits,
    t3: { url: "http://127.0.0.1:3773", token: "t3-token" },
  });
});

test("config writers in separate processes never lose each other's changes", async () => {
  const home = await tempHome();
  await saveConfig({ token: "token", afterSeq: 0, limits: DEFAULT_LIMITS }, home);
  const writer = join(import.meta.dirname, "tools/configWriter.ts");
  const run = promisify(execFile);
  // Each read-modify-write between another's read and write would drop an increment.
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, [writer, home, "15"])));
  expect((await loadConfig(home)).afterSeq).toBe(60);
});

test("a config lock left by a process that died is taken over, and one a live process holds is waited on", async () => {
  const home = await tempHome();
  await saveConfig({ token: "token", afterSeq: 0, limits: DEFAULT_LIMITS }, home);
  const lock = join(home, "bridge.json.lock");
  // A pid that existed and has exited.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(lock, JSON.stringify({ pid: dead, nonce: "dead", at: Date.now() }));
  expect(await updateConfig(home, (config) => void (config.afterSeq = 1), { waitMs: 5000 })).toBe(true);
  expect((await loadConfig(home)).afterSeq).toBe(1);

  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: "live", at: Date.now() }));
  await expect(updateConfig(home, (config) => void (config.afterSeq = 2), { waitMs: 300 })).rejects.toThrow(
    `locked by process ${process.pid}`,
  );
  expect((await loadConfig(home)).afterSeq).toBe(1);
});

test("pair refuses while a bridge is running on the same home, before it uses the code", async () => {
  const home = await tempHome();
  await saveConfig({ url: "https://old", token: "old-token", machineId: "m-old", limits: DEFAULT_LIMITS }, home);
  const saved = { home: process.env.UPLINK_BRIDGE_HOME, socket: process.env.UPLINK_BRIDGE_SOCKET };
  process.env.UPLINK_BRIDGE_HOME = home;
  delete process.env.UPLINK_BRIDGE_SOCKET;
  cleanups.push(async () => {
    for (const [name, value] of [["UPLINK_BRIDGE_HOME", saved.home], ["UPLINK_BRIDGE_SOCKET", saved.socket]] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const running = new LocalSocket(socketPathFor(home), { setSocketPath() {} } as unknown as Bridge);
  await running.start();
  cleanups.push(() => running.close());

  await expect(main(["pair", "CODE-1234", "--url", "https://example.invalid"])).rejects.toThrow(
    "A bridge is running with this config. Stop it first",
  );
  expect(await loadConfig(home)).toMatchObject({ url: "https://old", token: "old-token", machineId: "m-old" });
});

test("a command the room asks a plain shell to run gets the person's shell setup, and ~ in cwd is this machine's home", async () => {
  const { expandHome, terminalShell } = await import("../src/platform.ts");
  const env = { SHELL: "/bin/zsh" };
  expect(terminalShell("npm test", env, "darwin", { userShell: true })).toEqual({ file: "/bin/zsh", args: ["-l", "-i", "-c", "npm test"], label: "npm test" });
  // A harness's own command, and a shell with no command, start as before.
  expect(terminalShell("claude", env, "darwin")).toEqual({ file: "/bin/sh", args: ["-c", "claude"], label: "claude" });
  expect(terminalShell(undefined, env, "linux", { userShell: true })).toEqual({ file: "/bin/sh", args: ["-c", "/bin/zsh"], label: "/bin/zsh" });
  expect(terminalShell("npm test", { SHELL: "zsh" }, "linux", { userShell: true }).file).toBe("/bin/sh");
  // The home and the rest are joined with this machine's separator (\ on Windows).
  expect(expandHome("~/src/billing", "/home/ana")).toBe(join("/home/ana", "src/billing"));
  expect(expandHome("~", "/home/ana")).toBe("/home/ana");
  expect(expandHome("/srv/billing", "/home/ana")).toBe("/srv/billing");
  expect(expandHome("~bea/src", "/home/ana")).toBe("~bea/src");
  expect(expandHome(undefined)).toBeUndefined();
});
