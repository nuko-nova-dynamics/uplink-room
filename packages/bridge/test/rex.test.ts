import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BridgeMessage, RoomMessage } from "@uplink-room/protocol";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { RexAdapter } from "../src/adapters/rex.ts";
import { LocalSocket } from "../src/localSocket.ts";
import { quoteCommand, socketPathFor } from "../src/platform.ts";

// Rex tabs are offered on macOS and Linux only (ADR 0019); Rex has no public Windows build.
const skip = process.platform === "win32";
const rexTool = join(import.meta.dirname, "tools/rex");
const bin = join(import.meta.dirname, "../src/bin.ts");
const term = (...args: string[]) => quoteCommand([process.execPath, join(import.meta.dirname, "tools/term.mjs"), ...args]);
const owner = { memberId: "owner", name: "Owner" };

class FakeRoom implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void;
  send(message: BridgeMessage) {
    this.messages.push(message);
  }
  onMessage(handler: (message: RoomMessage) => void) {
    this.handler = handler;
  }
  deliver(message: RoomMessage) {
    this.handler!(message);
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<BridgeMessage, { type: T }> => m.type === type);
  }
  output(terminalId: string) {
    return this.of("terminal_output")
      .filter((m) => m.terminalId === terminalId)
      .map((m) => m.data)
      .join("");
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function setup(
  options: { running?: boolean; server?: string; env?: Record<string, string>; mostOpenAccess?: "watch" | "suggest" | "drive" | "open" } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "uplink-rex-"));
  const rex = join(dir, "rex");
  await mkdir(rex);
  if (options.running !== false) await writeFile(join(rex, "running"), "");
  // One session with a tab the person opened in Rex itself: never shareable, only counted.
  await writeFile(
    join(rex, "sessions.json"),
    JSON.stringify([
      {
        session_id: "session:work",
        label: "work",
        windows: [{ window_id: "window:plain", label: "zsh", blocks: [{ block_id: "block:plain", label: "shell", creator_name: "com.superlogical.terminal" }] }],
      },
    ]),
  );
  const env = { FAKE_REX_DIR: rex, REX_SERVER: options.server ?? "", ...options.env };
  const room = new FakeRoom();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: options.mostOpenAccess ?? "drive", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    env,
    belongsTo: "owner",
    linkedBy: "owner",
    rex: { executable: rexTool, pollMs: 200, bridgeCommand: () => [process.execPath, bin] },
  });
  const socketPath = socketPathFor(dir);
  const local = new LocalSocket(socketPath, bridge);
  cleanups.push(async () => {
    // Every fake tab still open is closed, as Rex would close them on quitting.
    const tabs = existsSync(join(rex, "tabs")) ? await readdir(join(rex, "tabs")) : [];
    for (const tab of tabs) {
      const pid = Number(await readFile(join(rex, "tabs", tab), "utf8"));
      if (alive(pid)) process.kill(pid, "SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(dir, { recursive: true, force: true });
  });
  cleanups.push(() => local.close());
  cleanups.push(() => bridge.close());
  await local.start();
  await bridge.start();
  return { room, bridge, dir, rex, socketPath, env };
}

/**
 * A plain shell's one-shot command runs in the person's shell as a login one (`$SHELL -l -i -c`): bash,
 * with an empty home, so no one's own startup files run in a test.
 */
async function loginShellEnv() {
  const home = await mkdtemp(join(tmpdir(), "uplink-rex-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return { SHELL: "/bin/bash", HOME: home };
}

/** Opens a tab the way a person does with `uplink-bridge rex-open`, and returns its Rex block id. */
async function openTab(ctx: Awaited<ReturnType<typeof setup>>, ...words: string[]) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [bin, "rex-open", "--session", "work", "--title", "Agent", "--cwd", ctx.dir, "--", ...words],
    { env: { ...process.env, ...ctx.env, UPLINK_REX: rexTool, UPLINK_BRIDGE_SOCKET: ctx.socketPath } },
  );
  const block = /Opened Rex tab (block:\S+)\./.exec(stdout)?.[1];
  expect(block).toBeDefined();
  await expect.poll(() => ctx.bridge.rexTabList().map((tab) => tab.tabRef)).toContain(block);
  return block!;
}
const tabPid = async (rex: string, block: string) => Number(await readFile(join(rex, "tabs", block), "utf8"));
const calls = async (rex: string) =>
  (await readFile(join(rex, "calls.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
const features: RoomMessage = { v: 1, type: "room_features", features: ["rex"] };

test.skipIf(skip)("reports shareable Rex tabs only once the room takes them, and only counts the rest", async () => {
  const ctx = await setup();
  expect(ctx.room.messages[0]).toMatchObject({ type: "register_machine", tools: expect.arrayContaining(["rex-tabs"]) });
  const block = await openTab(ctx, process.execPath, join(import.meta.dirname, "tools/term.mjs"), "echo");
  // A room that predates `rex_found` would refuse it, so nothing goes before it says it takes them.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(ctx.room.of("rex_found")).toEqual([]);
  ctx.room.deliver(features);
  await expect
    .poll(() => ctx.room.of("rex_found").at(-1))
    .toMatchObject({ running: true, otherTabs: 1, tabs: [{ tabRef: block, sessionRef: "session:work", session: "work", title: "Agent" }] });
  // The plain tab's labels never leave the machine.
  expect(JSON.stringify(ctx.room.of("rex_found"))).not.toContain("block:plain");
});

test.skipIf(skip)("shares a found tab with live output and only the driver's input, and stopping it only unshares", async () => {
  const ctx = await setup();
  ctx.room.deliver(features);
  const block = await openTab(ctx, process.execPath, join(import.meta.dirname, "tools/term.mjs"), "echo");
  ctx.room.deliver({ v: 1, type: "share_rex_tab", terminalId: "shared", tabRef: block, sharedBy: owner, access: "drive" });
  await expect.poll(() => ctx.room.of("terminal_started")).toContainEqual(
    expect.objectContaining({ terminalId: "shared", localRef: block, tool: "rex", access: "drive" }),
  );
  // The tab's recent output comes along, so the room sees what is on screen.
  await expect.poll(() => ctx.room.output("shared")).toContain("ready");
  expect(ctx.room.of("terminal_size")).toContainEqual(expect.objectContaining({ terminalId: "shared", cols: 100, rows: 30 }));
  ctx.room.deliver({ v: 1, type: "input", terminalId: "shared", from: { memberId: "intruder", name: "Other" }, data: "bad\r" });
  ctx.room.deliver({ v: 1, type: "input", terminalId: "shared", from: owner, data: "good\r" });
  await expect.poll(() => ctx.room.output("shared")).toContain("got:good");
  expect(ctx.room.output("shared")).not.toContain("got:bad");
  expect(ctx.room.of("input_rejected")).toContainEqual(expect.objectContaining({ memberId: "intruder", reason: "not_driver" }));
  ctx.room.deliver({ v: 1, type: "stop_terminal", terminalId: "shared" });
  await expect.poll(() => ctx.room.of("terminal_ended")).toContainEqual(expect.objectContaining({ terminalId: "shared", reason: "stopped" }));
  // The person's program keeps running in Rex, and the tab can be shared again.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(alive(await tabPid(ctx.rex, block))).toBe(true);
  await expect.poll(() => ctx.room.of("rex_found").at(-1)?.tabs[0]).not.toHaveProperty("terminalRef");
});

test.skipIf(skip)("starts a run In Rex as a new tab in the Uplink Room session and reports its exit", async () => {
  const ctx = await setup();
  ctx.room.deliver({
    v: 1,
    type: "start_terminal",
    terminalId: "run",
    startedBy: owner,
    usesSlot: false,
    access: "watch",
    command: term("print", "in-rex", "3", "300"),
    cwd: ctx.dir,
    inRex: true,
    title: "Fix the build",
  });
  await expect.poll(() => ctx.room.of("terminal_started")).toContainEqual(expect.objectContaining({ terminalId: "run", tool: "rex" }));
  await expect.poll(() => ctx.room.of("terminal_ended")).toContainEqual(
    expect.objectContaining({ terminalId: "run", exitCode: 3, reason: "exited" }),
  );
  expect(ctx.room.output("run")).toContain("in-rex");
  const opened = (await calls(ctx.rex)).find((args) => args[0] === "new");
  expect(opened?.slice(0, 7)).toEqual(["new", "Uplink Room", "-c", ctx.dir, "--window", "Fix the build", "--interactive"]);
  expect(opened).toContain("--terminal");
});

test.skipIf(skip)("a run whose Rex tab is still opening counts as busy, so the app doesn't restart under it", async () => {
  const ctx = await setup();
  const rexTabs = (ctx.bridge as unknown as { rexTabs: { open: (...args: unknown[]) => Promise<unknown> } }).rexTabs;
  let refuse!: (error: Error) => void;
  rexTabs.open = () => new Promise((_resolve, reject) => (refuse = reject));
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: term("echo"), inRex: true });

  await expect.poll(() => ctx.bridge.busyTerminals()).toBe(1);
  expect(ctx.room.of("terminal_started")).toEqual([]);
  refuse(new Error("Rex is gone"));
  await expect.poll(() => ctx.room.of("terminal_start_failed").map((m) => m.terminalId)).toEqual(["run"]);
  expect(ctx.bridge.busyTerminals()).toBe(0);
});

test.skipIf(skip)("below Drive a personal machine's bridge opens a Rex tab only for its person or their agents (ADR 0025)", async () => {
  const ctx = await setup({ mostOpenAccess: "suggest" });
  const ana = { memberId: "ana", name: "Ana" };
  const begin = (terminalId: string, startedBy: typeof owner, accountable?: typeof owner) =>
    ctx.room.deliver({ v: 1, type: "start_terminal", terminalId, startedBy, ...(accountable ? { accountable } : {}), usesSlot: true, access: "watch", command: term("echo"), inRex: true });
  begin("teammate", ana);
  begin("teammates-agent", { memberId: "claude", name: "Claude" }, ana);
  begin("owners-agent", { memberId: "codex", name: "Codex" }, owner);

  await expect.poll(() => ctx.room.of("terminal_started").map((m) => m.terminalId)).toEqual(["owners-agent"]);
  expect(ctx.room.of("terminal_start_failed")).toEqual([
    { v: 1, type: "terminal_start_failed", terminalId: "teammate", reason: "owner_only" },
    { v: 1, type: "terminal_start_failed", terminalId: "teammates-agent", reason: "owner_only" },
  ]);
  // Rex opened one tab: the owner's agent's.
  expect((await calls(ctx.rex)).filter((args) => args[0] === "new")).toHaveLength(1);
});

test.skipIf(skip)("a shell's one-shot command In Rex runs without colors, as in a plain terminal", async () => {
  const ctx = await setup({ env: await loginShellEnv() });
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", harness: "shell", command: term("env", "NO_COLOR"), inRex: true });
  await expect.poll(() => ctx.room.of("terminal_ended")).toContainEqual(expect.objectContaining({ terminalId: "run", exitCode: 0 }));
  // A login shell may print the system's own notes first (Ubuntu's sudo hint, in a home without
  // .sudo_as_admin_successful); the program's line comes last.
  expect(ctx.room.output("run").trim().split(/\r?\n/).at(-1)).toBe("1");
});

test.skipIf(skip)("stopping a run In Rex ends its program, and a tab closed in Rex reports the run stopped", async () => {
  const ctx = await setup();
  const begin = (terminalId: string) =>
    ctx.room.deliver({ v: 1, type: "start_terminal", terminalId, startedBy: owner, usesSlot: false, access: "watch", command: term("echo"), inRex: true });
  begin("first");
  await expect.poll(() => ctx.room.output("first")).toContain("ready");
  const first = ctx.bridge.rexTabList().find((tab) => tab.terminalRef === "first")!.tabRef;
  ctx.room.deliver({ v: 1, type: "stop_terminal", terminalId: "first" });
  await expect.poll(async () => alive(await tabPid(ctx.rex, first))).toBe(false);
  begin("second");
  await expect.poll(() => ctx.room.output("second")).toContain("ready");
  const second = ctx.bridge.rexTabList().find((tab) => tab.terminalRef === "second")!.tabRef;
  process.kill(await tabPid(ctx.rex, second), "SIGTERM");
  await expect.poll(() => ctx.room.of("terminal_ended")).toContainEqual({ v: 1, type: "terminal_ended", terminalId: "second", reason: "stopped" });
});

test.skipIf(skip)("resizes go through Rex, apply only while no Rex app owns the tab, and the room hears the tab's size", async () => {
  const ctx = await setup();
  ctx.room.deliver(features);
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: term("size"), inRex: true });
  await expect.poll(() => ctx.room.output("run")).toContain("ready");
  const block = ctx.bridge.rexTabList()[0]!.tabRef;
  ctx.room.deliver({ v: 1, type: "resize_terminal", terminalId: "run", from: owner, cols: 90, rows: 20 });
  await expect.poll(() => ctx.room.of("terminal_size").at(-1)).toMatchObject({ terminalId: "run", cols: 90, rows: 20 });
  ctx.room.deliver({ v: 1, type: "input", terminalId: "run", from: owner, data: "\r" });
  await expect.poll(() => ctx.room.output("run")).toContain("20 90");
  expect(await calls(ctx.rex)).toContainEqual(["block", "call", "-s", expect.any(String), "-b", block, "resize", '{"columns":90,"rows":20}']);
  // With the tab open in a Rex app, the app's size stays.
  await writeFile(join(ctx.rex, "owned", block), "");
  ctx.room.deliver({ v: 1, type: "resize_terminal", terminalId: "run", from: owner, cols: 60, rows: 15 });
  ctx.room.deliver({ v: 1, type: "input", terminalId: "run", from: owner, data: "\r" });
  await expect.poll(() => ctx.room.output("run").split("20 90").length).toBe(3);
  expect(ctx.room.of("terminal_size").at(-1)).toMatchObject({ cols: 90, rows: 20 });
});

test.skipIf(skip)("reports Rex program status, with a permission request as a question to answer in the terminal", async () => {
  // Store the report before attaching the follower. Its delayed stream must recover it from the snapshot.
  const ctx = await setup({ env: { FAKE_REX_EVENTS_DELAY_MS: "1000" } });
  const block = await openTab(ctx, process.execPath, join(import.meta.dirname, "tools/term.mjs"), "report", "blocked", "permission", "Approve deploy?");
  await expect.poll(() => readFile(join(ctx.rex, "records", block), "utf8")).toContain("blocked");
  ctx.room.deliver({ v: 1, type: "share_rex_tab", terminalId: "run", tabRef: block, sharedBy: owner, access: "watch" });
  await expect.poll(() => ctx.room.of("run_state_changed").filter((m) => m.state === "waiting")).toContainEqual(
    expect.objectContaining({ prompt: { kind: "question", text: "Approve deploy? Answer it in the terminal." } }),
  );
  ctx.room.deliver({ v: 1, type: "answer_prompt", source: { kind: "terminal", terminalId: "run" }, from: owner, promptId: "any", answer: "allow" });
  await expect.poll(() => ctx.room.of("input_rejected")).toContainEqual(expect.objectContaining({ reason: "no_pending_approval" }));
});

test.skipIf(skip)("says Rex isn't running, and refuses a run In Rex then", async () => {
  const ctx = await setup({ running: false });
  ctx.room.deliver(features);
  await expect.poll(() => ctx.room.of("rex_found").at(-1)).toMatchObject({ running: false, tabs: [], otherTabs: 0 });
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: term("echo"), inRex: true });
  await expect.poll(() => ctx.room.of("terminal_start_failed")).toContainEqual(
    expect.objectContaining({ terminalId: "run", reason: "rex_unavailable" }),
  );
});

test.skipIf(skip)("closing the bridge ends runs the room started in Rex and leaves the person's own tabs running", async () => {
  const ctx = await setup();
  const mine = await openTab(ctx, process.execPath, join(import.meta.dirname, "tools/term.mjs"), "echo");
  ctx.room.deliver({ v: 1, type: "share_rex_tab", terminalId: "shared", tabRef: mine, sharedBy: owner, access: "watch" });
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: term("echo"), inRex: true });
  await expect.poll(() => ctx.room.output("run")).toContain("ready");
  const run = ctx.bridge.rexTabList().find((tab) => tab.terminalRef === "run")!.tabRef;
  await ctx.bridge.close();
  expect(ctx.room.of("terminal_ended")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ terminalId: "shared", reason: "bridge_stopped" }),
      expect.objectContaining({ terminalId: "run", reason: "bridge_stopped" }),
    ]),
  );
  await expect.poll(async () => alive(await tabPid(ctx.rex, run))).toBe(false);
  expect(alive(await tabPid(ctx.rex, mine))).toBe(true);
});

test.skipIf(skip)("names the Rex server outright, so a gone server fails instead of reaching another", async () => {
  const ctx = await setup({ server: "unix:///tmp/uplink-test-rex.sock" });
  ctx.room.deliver(features);
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: term("echo"), inRex: true });
  await expect.poll(() => ctx.room.output("run")).toContain("ready");
  const servers = (await readFile(join(ctx.rex, "servers.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  // Every call, the status follower's included, names the server REX_SERVER gave.
  expect(new Set(servers)).toEqual(new Set(["unix:///tmp/uplink-test-rex.sock"]));
});

test.skipIf(skip)("a tab shared from the machine says which Rex tab it is, but only to a room that takes Rex messages", async () => {
  const ctx = await setup();
  const first = await openTab(ctx, process.execPath, join(import.meta.dirname, "tools/term.mjs"), "echo");
  // A room from before Rex tabs refuses the field, so a bridge it never told about them leaves it out.
  await ctx.bridge.shareRexTabLocally(first);
  expect(ctx.room.of("terminal_started").find((m) => m.localRef === first)).not.toHaveProperty("rex");
  ctx.room.deliver(features);
  const second = await openTab(ctx, process.execPath, join(import.meta.dirname, "tools/term.mjs"), "echo");
  await ctx.bridge.shareRexTabLocally(second);
  expect(ctx.room.of("terminal_started").find((m) => m.localRef === second)).toMatchObject({
    rex: { sessionRef: "session:work", tabRef: second },
  });
});

test.skipIf(skip)("a Rex tab's program gets one answer per terminal query: Rex's, while the room's screen's is dropped and typing passes", async () => {
  const ctx = await setup();
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: term("query"), inRex: true });
  await expect.poll(() => ctx.room.output("run")).toContain("asked");
  // The driver's screen answers the same query on its own, marked as a reply by the room.
  ctx.room.deliver({ v: 1, type: "input", terminalId: "run", from: owner, data: "\x1b[?1;2c", reply: true });
  // Shift+F3 is shaped like a cursor position report, but it was typed: it passes.
  ctx.room.deliver({ v: 1, type: "input", terminalId: "run", from: owner, data: "\x1b[1;2R\r" });
  await expect.poll(() => ctx.room.output("run")).toContain("replies:");
  expect(ctx.room.output("run")).toContain('replies:"\\u001b[?62;22c\\u001b[1;2R"');
});

test.skipIf(skip)("rex-open takes only its own options before --, and the command's flags stay the command's", async () => {
  const ctx = await setup();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [bin, "rex-open", "--session", "work", "--title", "Args", "--cwd", ctx.dir, "--", "printf", "%s\\n", "--cwd", "/not-a-real-folder", "--title", "x"],
    { env: { ...process.env, ...ctx.env, UPLINK_REX: rexTool, UPLINK_BRIDGE_SOCKET: ctx.socketPath } },
  );
  const block = /Opened Rex tab (block:\S+)\./.exec(stdout)![1]!;
  const opened = (await calls(ctx.rex)).find((args) => args[0] === "window" && args[1] === "new")!;
  expect(opened.slice(0, 6)).toEqual(["window", "new", "-s", "work", "Args", "-c"]);
  expect(opened[6]).toBe(ctx.dir);
  await expect.poll(async () => (existsSync(join(ctx.rex, "out", block)) ? readFile(join(ctx.rex, "out", block), "utf8") : "")).toContain("/not-a-real-folder");
});

test.skipIf(skip)("a shell's one-shot command In Rex runs in the person's own shell, as in a plain terminal", async () => {
  // `[[ ]]` is bash's, not /bin/sh's on Linux (dash), and `/bin/sh -c` isn't a login shell anywhere.
  const ctx = await setup({ env: await loginShellEnv() });
  const command = "[[ 1 == 1 ]] && shopt -q login_shell && echo in-bash";
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", harness: "shell", command, inRex: true });
  await expect.poll(() => ctx.room.of("terminal_ended")).toContainEqual(expect.objectContaining({ terminalId: "run", exitCode: 0 }));
  expect(ctx.room.output("run")).toContain("in-bash");
  expect((await calls(ctx.rex)).find((args) => args[0] === "new")).toContain("--user-shell");
});

test.skipIf(skip)("a run In Rex whose program ended before its tab connected starts no Rex events stream", async () => {
  const ctx = await setup({ env: { FAKE_REX_NO_PROGRAM: "1" } });
  const starts = vi.spyOn(RexAdapter.prototype, "start");
  cleanups.push(async () => starts.mockRestore());
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: "printf fast", inRex: true });
  await expect.poll(async () => existsSync(join(ctx.rex, "calls.log")) && (await calls(ctx.rex)).some((args) => args[0] === "new")).toBe(true);
  // The tab's host says hello, prints and exits in one write, so the bridge meets it already ended.
  const host = connect(ctx.socketPath);
  cleanups.push(async () => void host.destroy());
  await new Promise((resolve) => host.once("connect", resolve));
  const hello = { v: 1, type: "rex_host", session: "session:room", block: "block:fast", terminalId: "run", command: "printf fast", cwd: ctx.dir, cols: 80, rows: 24 };
  host.write([hello, { type: "output", data: "fast" }, { type: "exit", exitCode: 0 }].map((line) => JSON.stringify(line) + "\n").join(""));
  await expect.poll(() => ctx.room.of("terminal_ended")).toContainEqual(expect.objectContaining({ terminalId: "run", exitCode: 0, reason: "exited" }));
  expect(ctx.room.output("run")).toBe("fast");
  expect(starts).not.toHaveBeenCalled();
});

test.skipIf(skip)("unshare-rex refuses a run the room started, which would end it, and sends its tab no kill", async () => {
  const ctx = await setup({ env: { FAKE_REX_NO_PROGRAM: "1" } });
  ctx.room.deliver({ v: 1, type: "start_terminal", terminalId: "run", startedBy: owner, usesSlot: false, access: "watch", command: "sleep 60", inRex: true });
  await expect.poll(async () => existsSync(join(ctx.rex, "calls.log")) && (await calls(ctx.rex)).some((args) => args[0] === "new")).toBe(true);
  // The test is the tab's host, so it sees every message the bridge sends the tab.
  const host = connect(ctx.socketPath);
  cleanups.push(async () => void host.destroy());
  let heard = "";
  host.setEncoding("utf8");
  host.on("data", (chunk: string) => (heard += chunk));
  await new Promise((resolve) => host.once("connect", resolve));
  host.write(JSON.stringify({ v: 1, type: "rex_host", session: "session:room", block: "block:long", terminalId: "run", command: "sleep 60", cwd: ctx.dir, cols: 80, rows: 24 }) + "\n");
  await expect.poll(() => ctx.room.of("terminal_started")).toContainEqual(expect.objectContaining({ terminalId: "run", tool: "rex" }));
  await expect(ctx.bridge.unshareRexTabLocally("block:long")).rejects.toThrow("Stop the run in the room instead");
  // The bridge answers the share with `stream`; a kill would follow it on the same socket.
  await expect.poll(() => heard).toContain('"type":"stream"');
  expect(heard).not.toContain('"type":"kill"');
  expect(ctx.room.of("terminal_ended")).toEqual([]);
});
