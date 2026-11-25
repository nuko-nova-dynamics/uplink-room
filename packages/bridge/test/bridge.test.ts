import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeMessage } from "@uplink-room/protocol";
import { Bridge } from "../src/bridge.ts";
import type { TerminalHost, TerminalProcess } from "../src/terminal.ts";
import { quoteCommand, socketPathFor } from "../src/platform.ts";
import { cleanups, driver, FakeRoom, screen, setup, start, stoppableHost, term } from "./tools/bridgeFixture.ts";

const windows = process.platform === "win32";
const claudeTool = () =>
  quoteCommand([process.execPath, join(import.meta.dirname, "tools/claude.mjs")]);

test("registers local limits, streams real terminal output in order, and reports its exit", async () => {
  const { room } = await setup();
  expect(room.messages[0]).toMatchObject({
    type: "register_machine",
    limits: { mostOpenAccess: "suggest", slots: 1 },
  });
  start(room, "one", term("print", "real-terminal", "7"));
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_ended"))
    .toMatchObject({ terminalId: "one", exitCode: 7 });
  const output = room.messages.filter((m) => m.type === "terminal_output");
  expect(output.map((m) => m.data).join("")).toContain("real-terminal");
  expect(output.map((m) => m.seq)).toEqual(output.map((_, i) => i + 1));
  expect(room.messages).toContainEqual({
    v: 1,
    type: "run_state_changed",
    source: { kind: "terminal", terminalId: "one" },
    state: "unknown",
  });
});
test("terminal output never reaches the room with half a surrogate pair, whatever cut it", async () => {
  // A process whose output ends inside an emoji, as a trimmed buffer could: Convex refuses such a
  // string, and with it the whole batch, which would stop sharing.
  let emit: (data: string) => void = () => {};
  const host: TerminalHost = {
    spawn: () =>
      ({
        write() {},
        resize() {},
        kill() {},
        onData: (f: (data: string) => void) => ((emit = f), { dispose() {} }),
        onExit: () => ({ dispose() {} }),
      }) as unknown as TerminalProcess,
  };
  const { room } = await setup({ terminalHost: host });
  start(room, "split", term("idle"));
  await expect.poll(() => room.messages.some((m) => m.type === "terminal_started")).toBe(true);
  // Each half goes out in a batch of its own.
  emit("tide \uD83D");
  await expect.poll(() => room.messages.some((m) => m.type === "terminal_output")).toBe(true);
  emit("\uDE00 table");
  await expect.poll(() => room.messages.filter((m) => m.type === "terminal_output").map((m) => m.data).join("")).toContain("table");
  for (const m of room.messages.filter((m) => m.type === "terminal_output")) expect(m.data.isWellFormed()).toBe(true);
});
test("only the current driver can type, at every access level including Watch", async () => {
  const { room } = await setup({ limits: { mostOpenAccess: "open", slots: 1, longestProfileMs: 1000 } });
  start(
    room,
    "one",
    term("echo"),
    // The wheel can only go to a teammate at Drive or above.
    { access: "drive" },
  );
  await expect
    .poll(() =>
      room.messages
        .filter((m) => m.type === "terminal_output")
        .map((m) => m.data)
        .join(""),
    )
    .toContain("ready");
  room.deliver({
    v: 1,
    type: "input",
    terminalId: "one",
    from: { memberId: "intruder", name: "Other" },
    data: "bad\n",
  });
  room.deliver({ v: 1, type: "input", terminalId: "one", from: driver, data: "good\n" });
  await expect
    .poll(() =>
      room.messages
        .filter((m) => m.type === "terminal_output")
        .map((m) => m.data)
        .join(""),
    )
    .toContain("got:good");
  room.deliver({
    v: 1,
    type: "driver_changed",
    terminalId: "one",
    driver: { memberId: "next", name: "Next" },
  });
  room.deliver({ v: 1, type: "input", terminalId: "one", from: driver, data: "stale\n" });
  room.deliver({ v: 1, type: "change_access", terminalId: "one", access: "watch" });
  room.deliver({
    v: 1,
    type: "input",
    terminalId: "one",
    from: { memberId: "next", name: "Next" },
    data: "watch\n",
  });
  // Access limits teammates, never the driver (GLOSSARY.md, "Access").
  await expect
    .poll(() =>
      room.messages
        .filter((m) => m.type === "terminal_output")
        .map((m) => m.data)
        .join(""),
    )
    .toContain("got:watch");
  expect(room.messages.filter((m) => m.type === "input_rejected")).toHaveLength(2);
  expect(
    room.messages
      .filter((m) => m.type === "terminal_output")
      .map((m) => m.data)
      .join(""),
  ).not.toMatch(/got:(bad|stale)/);
});
test("caps access and slots locally, but sharing a personal terminal uses no slot", async () => {
  const { room, bridge } = await setup();
  start(room, "one", term("idle"), { access: "open" });
  start(room, "two", term("idle"));
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_start_failed"))
    .toMatchObject({ terminalId: "two", reason: "no_free_slot" });
  expect(room.messages.find((m) => m.type === "terminal_started")).toMatchObject({
    access: "suggest",
  });
  expect(room.messages).toContainEqual({
    v: 1,
    type: "terminal_access",
    terminalId: "one",
    access: "suggest",
  });
  room.deliver({ v: 1, type: "change_access", terminalId: "one", access: "open" });
  await expect.poll(() => room.messages.filter((m) => m.type === "terminal_access").length).toBe(2);
  await bridge.share({ command: term("idle") });
  expect(room.messages.filter((m) => m.type === "terminal_started")).toHaveLength(2);
  expect(room.messages.filter((m) => m.type === "terminal_started")[1]).not.toHaveProperty(
    "terminalId",
  );
  room.deliver({ v: 1, type: "stop_terminal", terminalId: "one" });
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_ended")).toBeDefined();
  start(room, "three", term("idle"));
  await expect
    .poll(() => room.messages.filter((m) => m.type === "terminal_started").length)
    .toBe(3);
});
test("stop sharing cuts off all output and input, ends room terminals, and unlink deletes profiles and token", async () => {
  let token = "saved";
  const { room, bridge, dir } = await setup({
    dropToken: () => {
      token = "";
    },
  });
  room.deliver({
    v: 1,
    type: "create_profile",
    profileId: "retained",
    person: driver,
    expiresAt: Date.now() + 500,
  });
  start(room, "room-terminal", term("idle"));
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started")).toBeDefined();
  const localRef = await bridge.share({ command: term("idle") });
  room.deliver({ v: 1, type: "stop_sharing" });
  await expect.poll(() => room.messages.filter((m) => m.type === "terminal_ended").length).toBe(2);
  room.deliver({ v: 1, type: "input", terminalId: localRef, from: driver, data: "never\n" });
  start(room, "after-stop", term("print", "never"));
  room.deliver({ v: 1, type: "unlink" });
  await expect.poll(() => token).toBe("");
  expect(room.messages.filter((m) => m.type === "terminal_started")).toHaveLength(2);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(join(dir, "profiles"))).toEqual([]);
});
// herdr and tmux don't run natively on Windows, so a Windows bridge never loads their adapters.
test.skipIf(windows)("herdr reports explicit waiting and done without reading screen text", async () => {
  const { HerdrAdapter } = await import("../src/adapters/herdr.ts");
  const { room } = await setup({
    adapters: [
      new HerdrAdapter({ executable: join(import.meta.dirname, "tools/hc"), target: "t7" }),
    ],
  });
  // Keep the terminal open until the adapter has delivered every event.
  start(room, "herdr", term("idle"));
  await expect
    .poll(() => room.messages.filter((m) => m.type === "run_state_changed").map((m) => m.state))
    .toContain("done");
  expect(room.messages).toContainEqual(
    expect.objectContaining({ type: "run_state_changed", state: "working" }),
  );
  expect(room.messages).toContainEqual(
    expect.objectContaining({
      type: "run_state_changed",
      state: "waiting",
      prompt: { kind: "approval", text: "Approve build?", promptId: expect.any(String) },
    }),
  );
});
test.skipIf(windows)("tmux turns explicit control-mode state options into waiting and done", async () => {
  const { TmuxAdapter } = await import("../src/adapters/tmux.ts");
  const { room } = await setup({
    adapters: [
      new TmuxAdapter({ executable: join(import.meta.dirname, "tools/tmux"), target: "fake" }),
    ],
  });
  start(room, "tmux", term("idle"));
  await expect
    .poll(() => room.messages.filter((m) => m.type === "run_state_changed").map((m) => m.state))
    .toContain("done");
  expect(room.messages).toContainEqual(
    expect.objectContaining({ type: "run_state_changed", state: "working" }),
  );
  expect(room.messages).toContainEqual(
    expect.objectContaining({
      type: "run_state_changed",
      state: "waiting",
      prompt: { kind: "approval", text: "Approve build?", promptId: expect.any(String) },
    }),
  );
});
test("Rex reads wrapped block events and reports explicit waiting and completion, with a permission request to answer in the terminal", async () => {
  const { RexAdapter } = await import("../src/adapters/rex.ts");
  const { room } = await setup({
    adapters: [
      new RexAdapter({
        executable: join(import.meta.dirname, "tools/rex"),
        target: "fake",
        block: "block-one",
      }),
    ],
  });
  start(room, "rex", term("print", "rex-output", "0", "300"));
  await expect
    .poll(() => room.messages.filter((m) => m.type === "run_state_changed").map((m) => m.state))
    .toContain("done");
  expect(room.messages).toContainEqual(
    expect.objectContaining({ type: "run_state_changed", state: "working" }),
  );
  expect(room.messages).toContainEqual(
    expect.objectContaining({
      type: "run_state_changed",
      state: "waiting",
      // Rex has no way to send an answer back, so it's a question, without Allow and Deny.
      prompt: { kind: "question", text: "Approve build? Answer it in the terminal." },
    }),
  );
});
test("Claude hooks reach the bridge by socket and only the driver answers approvals", async () => {
  const { ClaudeCodeAdapter } = await import("../src/adapters/claude.ts");
  const { LocalSocket } = await import("../src/localSocket.ts");
  const { room, bridge, dir } = await setup({ adapters: [new ClaudeCodeAdapter()] });
  const socket = new LocalSocket(socketPathFor(dir), bridge);
  await socket.start();
  cleanups.push(() => socket.close());
  start(
    room,
    "claude-hook",
    claudeTool(),
  );
  await expect
    .poll(() => room.messages.find((m) => m.type === "run_state_changed" && m.state === "waiting"))
    .toMatchObject({ prompt: { kind: "approval" } });
  const waiting = room.messages.find((m) => m.type === "run_state_changed" && m.state === "waiting");
  const promptId = (waiting?.type === "run_state_changed" && waiting.prompt?.promptId) || "";
  room.deliver({
    v: 1,
    type: "answer_prompt",
    source: { kind: "terminal", terminalId: "claude-hook" },
    from: { memberId: "other", name: "Other" },
    promptId,
    answer: "allow",
  });
  await expect.poll(() => room.messages.find((m) => m.type === "input_rejected")).toBeDefined();
  room.deliver({
    v: 1,
    type: "answer_prompt",
    source: { kind: "terminal", terminalId: "claude-hook" },
    from: driver,
    promptId,
    answer: "deny",
  });
  await expect
    .poll(() =>
      room.messages
        .filter((m) => m.type === "terminal_output")
        .map((m) => m.data)
        .join(""),
    )
    .toContain("decision:deny");
  await expect
    .poll(() => room.messages.find((m) => m.type === "run_state_changed" && m.state === "done"))
    .toBeDefined();
});
test("lowering local limits immediately lowers a live terminal, and teammates still can't type", async () => {
  const { room, bridge } = await setup();
  start(room, "lowered", term("idle"));
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started")).toBeDefined();
  await bridge.setLimits({ mostOpenAccess: "watch", slots: 0, longestProfileMs: 1000 });
  room.deliver({
    v: 1,
    type: "input",
    terminalId: "lowered",
    from: { memberId: "teammate", name: "Teammate" },
    data: "blocked\n",
  });
  await expect
    .poll(() => room.messages.find((m) => m.type === "input_rejected"))
    .toMatchObject({ memberId: "teammate", reason: "not_driver" });
  expect(room.messages).toContainEqual({
    v: 1,
    type: "terminal_access",
    terminalId: "lowered",
    access: "watch",
  });
  // New limits aren't a restart, so the room keeps this terminal live.
  expect(room.messages).toContainEqual({
    v: 1,
    type: "limits_changed",
    limits: { mostOpenAccess: "watch", slots: 0, longestProfileMs: 1000 },
  });
  expect(room.messages.filter((m) => m.type === "register_machine")).toHaveLength(1);
});

test("a terminal shared from the machine is controlled by its room id once the room links it", async () => {
  // The room makes whoever linked the machine the starter and driver of a terminal shared from it.
  const { room, bridge } = await setup({ linkedBy: driver.memberId });
  const localRef = await bridge.share({
    command: term("echo"),
  });
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_started"))
    .toMatchObject({ localRef });
  expect(room.messages.find((m) => m.type === "terminal_started")).not.toHaveProperty("terminalId");

  room.deliver({ v: 1, type: "terminal_linked", localRef, terminalId: "room-7" });
  room.deliver({ v: 1, type: "driver_changed", terminalId: "room-7", driver });
  room.deliver({ v: 1, type: "input", terminalId: "room-7", from: driver, data: "linked\n" });

  await expect
    .poll(() =>
      room.messages
        .filter((m) => m.type === "terminal_output")
        .map((m) => m.data)
        .join(""),
    )
    .toContain("got:linked");
  expect(room.messages.filter((m) => m.type === "input_rejected")).toEqual([]);
});

const echoLoop =
  term("echo");
test("slot use comes from who the machine belongs to, never from the room's usesSlot", async () => {
  // At Drive, so teammates may start terminals here (ADR 0025).
  const { room } = await setup({ belongsTo: "owner", limits: { mostOpenAccess: "drive", slots: 1, longestProfileMs: 1000 } });
  start(room, "teammate-one", term("idle"), { startedBy: { memberId: "ana", name: "Ana" }, usesSlot: false });
  start(room, "teammate-two", term("idle"), { startedBy: { memberId: "sam", name: "Sam" }, usesSlot: false });
  start(room, "owners", term("idle"), { startedBy: { memberId: "owner", name: "Owner" }, usesSlot: true });

  await expect
    .poll(() => room.messages.filter((m) => m.type === "terminal_started").map((m) => m.localRef))
    .toEqual(["teammate-one", "owners"]);
  expect(room.messages.filter((m) => m.type === "terminal_start_failed")).toEqual([
    { v: 1, type: "terminal_start_failed", terminalId: "teammate-two", reason: "no_free_slot" },
  ]);
});

test("below Drive a personal machine's bridge starts the room's terminals and threads only for its person or their agents, and hands it their teammates' wheels", async () => {
  // The room refuses these first (ADR 0025); this is the machine's own check, on its own limit.
  const { room } = await setup({ belongsTo: "owner", limits: { mostOpenAccess: "suggest", slots: 2, longestProfileMs: 1000 } });
  const owner = { memberId: "owner", name: "Owner" };
  start(room, "teammate", term("idle"), { startedBy: { memberId: "ana", name: "Ana" } });
  start(room, "teammates-agent", term("idle"), { startedBy: { memberId: "claude", name: "Claude" }, accountable: { memberId: "ana", name: "Ana" } });
  start(room, "owners-agent", echoLoop, { startedBy: { memberId: "codex", name: "Codex" }, accountable: owner });
  start(room, "owners", term("idle"), { startedBy: owner });
  room.deliver({ v: 1, type: "start_thread", runId: "run-thread", harness: "codex", startedBy: { memberId: "ana", name: "Ana" } });

  await expect
    .poll(() => room.messages.filter((m) => m.type === "terminal_started").map((m) => m.localRef))
    .toEqual(["owners-agent", "owners"]);
  expect(room.messages.filter((m) => m.type === "terminal_start_failed")).toEqual([
    { v: 1, type: "terminal_start_failed", terminalId: "teammate", reason: "owner_only" },
    { v: 1, type: "terminal_start_failed", terminalId: "teammates-agent", reason: "owner_only" },
  ]);
  expect(room.messages).toContainEqual({ v: 1, type: "thread_start_failed", runId: "run-thread", reason: "owner_only" });

  // Below Drive the wheel can go to the machine's person, though they didn't start the terminal.
  await expect.poll(() => screen(room)).toContain("ready");
  room.deliver({ v: 1, type: "driver_changed", terminalId: "owners-agent", driver: owner });
  room.deliver({ v: 1, type: "input", terminalId: "owners-agent", from: owner, data: "mine\n" });
  await expect.poll(() => screen(room)).toContain("got:mine");
});

test("below Drive the bridge hands the wheel only back to whoever started the terminal", async () => {
  const { room } = await setup({ limits: { mostOpenAccess: "open", slots: 1, longestProfileMs: 1000 } });
  const next = { memberId: "next", name: "Next" };
  const mallory = { memberId: "mallory", name: "Mallory" };
  start(room, "wheel", echoLoop, { access: "drive" });
  await expect.poll(() => screen(room)).toContain("ready");

  room.deliver({ v: 1, type: "driver_changed", terminalId: "wheel", driver: next });
  room.deliver({ v: 1, type: "change_access", terminalId: "wheel", access: "suggest" });
  room.deliver({ v: 1, type: "driver_changed", terminalId: "wheel", driver: mallory });
  room.deliver({ v: 1, type: "input", terminalId: "wheel", from: mallory, data: "evil\n" });
  room.deliver({ v: 1, type: "input", terminalId: "wheel", from: next, data: "next\n" });
  room.deliver({ v: 1, type: "driver_changed", terminalId: "wheel", driver });
  room.deliver({ v: 1, type: "input", terminalId: "wheel", from: driver, data: "back\n" });

  await expect.poll(() => screen(room)).toContain("got:back");
  expect(screen(room)).toContain("got:next");
  expect(screen(room)).not.toContain("got:evil");
  expect(room.messages).toContainEqual({
    v: 1,
    type: "input_rejected",
    terminalId: "wheel",
    memberId: "mallory",
    reason: "driver_change_rejected",
  });
});

test("an approval answer applies only to the approval it names", async () => {
  const { ClaudeCodeAdapter } = await import("../src/adapters/claude.ts");
  const { LocalSocket } = await import("../src/localSocket.ts");
  const { room, bridge, dir } = await setup({ adapters: [new ClaudeCodeAdapter()] });
  const socket = new LocalSocket(socketPathFor(dir), bridge);
  await socket.start();
  cleanups.push(() => socket.close());
  start(room, "approval", claudeTool());
  await expect
    .poll(() => room.messages.find((m) => m.type === "run_state_changed" && m.state === "waiting"))
    .toBeDefined();
  const waiting = room.messages.find((m) => m.type === "run_state_changed" && m.state === "waiting");
  const promptId = waiting?.type === "run_state_changed" ? waiting.prompt?.promptId : undefined;
  expect(promptId).toEqual(expect.any(String));

  const source = { kind: "terminal", terminalId: "approval" } as const;
  room.deliver({ v: 1, type: "answer_prompt", source, from: driver, promptId: "an-earlier-approval", answer: "allow" });
  await expect
    .poll(() => room.messages.find((m) => m.type === "input_rejected"))
    .toMatchObject({ memberId: "driver", reason: "stale_prompt" });
  expect(screen(room)).not.toContain("decision:");

  room.deliver({ v: 1, type: "answer_prompt", source, from: driver, promptId: promptId!, answer: "deny" });
  await expect.poll(() => screen(room)).toContain("decision:deny");
});

test("closing the bridge reports its shared terminals as ended", async () => {
  const { room, bridge } = await setup();
  start(room, "open-at-close", term("idle"));
  const localRef = await bridge.share({ command: term("idle") });
  await expect.poll(() => room.messages.filter((m) => m.type === "terminal_started").length).toBe(2);

  await bridge.close();

  expect(room.messages.filter((m) => m.type === "terminal_ended").map((m) => m.terminalId).sort()).toEqual(
    ["open-at-close", localRef].sort(),
  );
});

test("terminal_ended says why: exited with its code, stopped by the room, or the bridge closing", async () => {
  const { room, bridge } = await setup();
  const ended = (terminalId: string) =>
    room.messages.find((m) => m.type === "terminal_ended" && m.terminalId === terminalId);
  start(room, "exits", term("print", "bye", "3"));
  await expect.poll(() => ended("exits")).toMatchObject({ reason: "exited", exitCode: 3 });

  start(room, "stopped", term("idle"));
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started" && m.terminalId === "stopped")).toBeDefined();
  room.deliver({ v: 1, type: "stop_terminal", terminalId: "stopped" });
  await expect.poll(() => ended("stopped")).toMatchObject({ reason: "stopped" });

  start(room, "open-at-close", term("idle"));
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started" && m.terminalId === "open-at-close")).toBeDefined();
  await bridge.close();
  expect(ended("open-at-close")).toMatchObject({ reason: "bridge_stopped" });
  expect(ended("open-at-close")).not.toHaveProperty("exitCode");
});

test("stopping a terminal ends the processes its shell started (#43)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { room, dir } = await setup();
  const pidFile = join(dir, "child.pid");
  // On Windows the child is detached, with no console: closing the terminal's console doesn't end it
  // and node-pty's kill() doesn't find it, so only the bridge's process-tree kill does. On macOS and
  // Linux the pty hangup ends the shell's process group, here a pipeline as in microsoft/node-pty#952;
  // a detached child would leave that group on purpose, as a daemon does.
  start(room, "tree", windows ? term("detached", pidFile) : `${term("child", pidFile)} | more`);
  await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).not.toBe("");
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // If the child outlives the test, end it; once it's gone its pid isn't this test's to kill.
  let survived = true;
  cleanups.push(async () => {
    if (survived && alive()) process.kill(pid);
  });
  expect(alive()).toBe(true);
  room.deliver({ v: 1, type: "stop_terminal", terminalId: "tree" });
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_ended")).toMatchObject({ reason: "stopped" });
  // Windows itself ends some console processes about 10 s after their console closes, so the child
  // must be gone well before that for the bridge, not Windows, to have ended it.
  await expect.poll(alive, { timeout: 3000 }).toBe(false);
  survived = false;
});

test("resume_sharing turns sharing stopped from the room back on, but not a stop made on the machine", async () => {
  const { room, bridge } = await setup();
  room.deliver({ v: 1, type: "stop_sharing" });
  start(room, "while-stopped", term("idle"));
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_start_failed"))
    .toMatchObject({ terminalId: "while-stopped", reason: "sharing_stopped" });

  room.deliver({ v: 1, type: "resume_sharing" });
  start(room, "after-resume", term("idle"));
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_started"))
    .toMatchObject({ terminalId: "after-resume" });

  await bridge.stopSharing();
  room.deliver({ v: 1, type: "resume_sharing" });
  start(room, "after-local-stop", term("idle"));
  await expect
    .poll(() => room.messages.filter((m) => m.type === "terminal_start_failed").map((m) => m.terminalId))
    .toEqual(["while-stopped", "after-local-stop"]);
  expect(room.messages.filter((m) => m.type === "terminal_started")).toHaveLength(1);
});

test("only the driver resizes a terminal, and the bridge clamps the size itself", async () => {
  const { room } = await setup({ limits: { mostOpenAccess: "open", slots: 1, longestProfileMs: 1000 } });
  // Every line typed prints the pty's own idea of its size, as "rows cols".
  start(room, "size", term("size"), { access: "open" });
  await expect.poll(() => screen(room)).toContain("ready");
  const sizes = () => (screen(room).match(/\d+ \d+\r?\n/g) ?? []).map((line) => line.trim());
  // A program sees a new size only after its SIGWINCH (or ConPTY's resize
  // event) arrives, which can be after the next line it reads. So each poll
  // types a line and reads the newest answer, until the size shows up.
  const sizeBecomes = (expected: string) =>
    expect
      .poll(async () => {
        const before = sizes().length;
        room.deliver({ v: 1, type: "input", terminalId: "size", from: driver, data: "size\n" });
        await expect.poll(() => sizes().length).toBeGreaterThan(before);
        return sizes().at(-1);
      })
      .toBe(expected);

  await sizeBecomes("30 120");
  room.deliver({ v: 1, type: "resize_terminal", terminalId: "size", from: driver, cols: 100, rows: 40 });
  await sizeBecomes("40 100");

  room.deliver({ v: 1, type: "resize_terminal", terminalId: "size", from: { memberId: "intruder", name: "Other" }, cols: 50, rows: 10 });
  await expect
    .poll(() => room.messages.find((m) => m.type === "input_rejected"))
    .toEqual({ v: 1, type: "input_rejected", terminalId: "size", memberId: "intruder", reason: "not_driver" });
  await sizeBecomes("40 100");

  room.deliver({ v: 1, type: "resize_terminal", terminalId: "size", from: driver, cols: 9000, rows: 1 });
  await sizeBecomes("5 500");
  // The intruder's size never reached the pty, before or after the clamp.
  expect(sizes()).not.toContain("10 50");
});

test("a Windows bridge leaves out tmux and herdr and runs commands in PowerShell with their exit code", async () => {
  const { defaultAdapters } = await import("../src/adapters/index.ts");
  const { terminalShell } = await import("../src/platform.ts");
  expect(defaultAdapters("win32").map((a) => a.name)).toEqual(["claude", "codex", "hermes-agent", "rex", "t3code"]);
  expect(defaultAdapters("linux").map((a) => a.name)).toEqual(["claude", "codex", "hermes-agent", "herdr", "tmux", "rex", "t3code"]);
  const env = { UPLINK_BRIDGE_SHELL: "powershell.exe", Path: "" };
  const shell = terminalShell("node build.mjs", env, "win32");
  expect(shell).toMatchObject({ file: "powershell.exe", label: "node build.mjs" });
  const encoded = (shell.args as string[]).at(-1)!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  expect(script.startsWith("node build.mjs\n")).toBe(true);
  expect(script).toContain("exit $LASTEXITCODE");
  expect(terminalShell("dir", { UPLINK_BRIDGE_SHELL: "cmd.exe" }, "win32").args).toBe('/d /s /c "dir"');
});

test("register_machine carries the saved inbox cursor, so the room can end a start already handled", async () => {
  const { room } = await setup({ afterSeq: 7 });
  expect(room.messages[0]).toMatchObject({ type: "register_machine", afterSeq: 7 });
});

test("closing ends local terminals without waiting on a send the room never answers", async () => {
  // The terminal prints nothing. On Windows 11 build 22000 under a service account (the CI runner on
  // sthopc01), ConPTY then sends no output either, so this also checks that kill() doesn't wait for
  // the terminal's first output (#61).
  const { nodePtyHost } = await import("../src/terminal.ts");
  let exited = false;
  const host: TerminalHost = {
    spawn(command, args, options) {
      const child = nodePtyHost.spawn(command, args, options);
      child.onExit(() => {
        exited = true;
      });
      return child;
    },
  };
  class StalledRoom extends FakeRoom {
    override send(message: BridgeMessage) {
      super.send(message);
      // A stalled link: this report never reaches the room.
      if (message.type === "profile_created") return new Promise<void>(() => {});
    }
  }
  const room = new StalledRoom();
  const dir = await mkdtemp(join(tmpdir(), "uplink-bridge-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    terminalHost: host,
  });
  await bridge.start();
  start(room, "running", term("idle"));
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started")).toBeDefined();
  room.deliver({ v: 1, type: "create_profile", profileId: "stalled", person: driver, expiresAt: Date.now() + 500 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();

  const started = Date.now();
  await bridge.close();
  expect(Date.now() - started).toBeLessThan(3000);
  await expect.poll(() => exited).toBe(true);
});

test("slow process-tree kills hold up neither other terminals' output nor close() past its deadline", async () => {
  const { PtyGate, withTreeKill } = await import("../src/terminal.ts");
  // Its own gate, so these kills, which take TREE_KILL_WAIT_MS each, hold up no other test's terminals.
  const gate = new PtyGate();
  // Terminals that print a line every 20 ms until killed, each with a Windows tree kill that never finishes.
  const host: TerminalHost = {
    spawn() {
      const data: ((chunk: string) => void)[] = [];
      const exits: ((event: { exitCode: number }) => void)[] = [];
      const ticker = setInterval(() => data.forEach((listener) => listener("tick\n")), 20);
      ticker.unref();
      const fake: TerminalProcess = {
        write: () => {},
        resize: () => {},
        onData: (listener) => (data.push(listener), { dispose: () => {} }),
        onExit: (listener) => (exits.push(listener), { dispose: () => {} }),
        kill: () => {
          clearInterval(ticker);
          exits.forEach((listener) => listener({ exitCode: 0 }));
        },
      };
      const now = Date.now();
      return withTreeKill(fake, { pid: 4321, spawnStarted: now, spawnEnded: now }, { hold: () => new Promise(() => {}), gate });
    },
  };
  const { room, bridge } = await setup({
    terminalHost: host,
    limits: { mostOpenAccess: "suggest", slots: 4, longestProfileMs: 1000 },
  });
  for (const id of ["a", "b", "c"]) start(room, id, "anything");
  const lines = (id: string) => room.messages.filter((m) => m.type === "terminal_output" && m.terminalId === id).length;
  await expect.poll(() => lines("c")).toBeGreaterThan(0);

  room.deliver({ v: 1, type: "stop_terminal", terminalId: "a" });
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_ended" && m.terminalId === "a")).toBeDefined();
  // a's tree kill is still running, and b's output keeps coming.
  const before = lines("b");
  await expect.poll(() => lines("b"), { timeout: 1000 }).toBeGreaterThan(before + 2);

  const started = Date.now();
  await bridge.close();
  expect(Date.now() - started).toBeLessThan(3000);
});

test("a shell's one-shot command runs in the person's own shell, without colors, and ~ in its folder is home; noColor turns colors off for an agent's shell", async () => {
  if (process.platform === "win32") return;
  const { homedir } = await import("node:os");
  const spawned: { file: string; args: string[] | string; cwd?: string; env: NodeJS.ProcessEnv }[] = [];
  const { host: stoppable } = stoppableHost();
  const host: TerminalHost = {
    spawn(file, args, options) {
      spawned.push({ file, args, cwd: options.cwd, env: options.env ?? {} });
      return stoppable.spawn(file, args, options);
    },
  };
  // The test's own environment may turn colors off (NO_COLOR=1, as an agent's shell does): only the bridge may.
  const previous = { SHELL: process.env.SHELL, FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR };
  process.env.SHELL = "/bin/zsh";
  process.env.FORCE_COLOR = "1";
  delete process.env.NO_COLOR;
  try {
    const { room } = await setup({ terminalHost: host, limits: { mostOpenAccess: "suggest", slots: 3, longestProfileMs: 1000 } });
    start(room, "one-shot", "npm test", { harness: "shell", cwd: "~" });
    start(room, "harness", "claude", { harness: "claude-code" });
    room.deliver({ v: 1, type: "start_terminal", terminalId: "agent-shell", startedBy: driver, access: "suggest", usesSlot: true, harness: "shell", noColor: true });
    await expect.poll(() => spawned.length).toBe(3);
    // An interactive shell an agent opened: its own shell as usual, without colors.
    expect(spawned[2]).toMatchObject({ file: "/bin/sh", args: ["-c", "/bin/zsh"] });
    expect(spawned[2]!.env.NO_COLOR).toBe("1");
    expect(spawned[2]!.env.FORCE_COLOR).toBeUndefined();
    expect(spawned[0]).toMatchObject({ file: "/bin/zsh", args: ["-l", "-i", "-c", "npm test"], cwd: homedir() });
    expect(spawned[0]!.env.NO_COLOR).toBe("1");
    expect(spawned[0]!.env.FORCE_COLOR).toBeUndefined();
    // A harness's own program starts as before, with the machine's colors.
    expect(spawned[1]).toMatchObject({ file: "/bin/sh", args: ["-c", "claude"] });
    expect(spawned[1]!.env.NO_COLOR).toBeUndefined();
    expect(spawned[1]!.env.FORCE_COLOR).toBe("1");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a shell killed by a signal reports exit code 128 + the signal, not node-pty's 0", async () => {
  const exits: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  const host: TerminalHost = {
    spawn() {
      return {
        write: () => {},
        resize: () => {},
        onData: () => ({ dispose: () => {} }),
        onExit: (listener) => (exits.push(listener), { dispose: () => {} }),
        kill: () => {},
      };
    },
  };
  const { room } = await setup({ terminalHost: host });
  start(room, "killed", "sleep 100", { harness: "shell" });
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started")).toBeDefined();
  // node-pty on macOS and Linux: a process killed by SIGKILL exits with code 0 and signal 9.
  for (const listener of exits) listener({ exitCode: 0, signal: 9 });
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_ended"))
    .toMatchObject({ type: "terminal_ended", terminalId: "killed", exitCode: 137, reason: "exited" });
  expect(room.messages.find((m) => m.type === "terminal_ended")).not.toHaveProperty("signal");
});
