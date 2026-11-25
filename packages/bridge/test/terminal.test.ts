import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import {
  fixConsoleListFallback,
  Holder,
  HOLDER_REQUEST_MS,
  killWithoutWaitingForOutput,
  listConsoleProcesses,
  PtyGate,
  TREE_KILL_WAIT_MS,
  withTreeKill,
  type HeldProcess,
  type HoldProcess,
  type TerminalProcess,
} from "../src/terminal.ts";

/** A stand-in for node-pty's console-list helper process. */
function helper() {
  const child = new EventEmitter() as EventEmitter & { kill: () => boolean; killed: boolean };
  child.killed = false;
  child.kill = () => (child.killed = true);
  return child;
}
const asChild = (child: ReturnType<typeof helper>) => child as unknown as ChildProcess;

afterEach(() => {
  vi.useRealTimers();
});

test("lists the console's processes with the helper's answer", async () => {
  const child = helper();
  const started: string[][] = [];
  const list = listConsoleProcesses(4321, (args) => {
    started.push(args);
    return asChild(child);
  });
  child.emit("message", { consoleProcessList: [4321, 99] });
  await expect(list).resolves.toEqual([4321, 99]);
  expect(started).toEqual([["4321"]]);
});

test("a helper that exits without answering (AttachConsole failed) lists nothing, without waiting", async () => {
  vi.useFakeTimers();
  const child = helper();
  const list = listConsoleProcesses(4321, () => asChild(child));
  child.emit("close", 1, null);
  // No timer runs: the answer comes from the helper's exit, not node-pty's 5 s timeout.
  await expect(list).resolves.toEqual([]);
});

test("a helper that never answers lists nothing after the timeout, never the shell's old pid", async () => {
  vi.useFakeTimers();
  const child = helper();
  const list = listConsoleProcesses(4321, () => asChild(child));
  await vi.advanceTimersByTimeAsync(5000);
  await expect(list).resolves.toEqual([]);
  expect(child.killed).toBe(true);
});

test("a shell with no pid lists nothing and starts no helper", async () => {
  const start = vi.fn();
  await expect(listConsoleProcesses(0, start)).resolves.toEqual([]);
  expect(start).not.toHaveBeenCalled();
});

test("fixes node-pty's Windows kill() so its fallback never returns the shell's old pid", async () => {
  vi.useFakeTimers();
  // node-pty 1.1.0's WindowsPtyAgent, reduced to the method in question.
  class WindowsPtyAgent {
    _innerPid = 4321;
    _getConsoleProcessList(): Promise<number[]> {
      return new Promise((resolve) => setTimeout(() => resolve([this._innerPid]), 5000));
    }
  }
  const child = helper();
  const started: string[][] = [];
  expect(
    fixConsoleListFallback(WindowsPtyAgent, (args) => {
      started.push(args);
      return asChild(child);
    }),
  ).toBe(true);
  const list = new WindowsPtyAgent()._getConsoleProcessList();
  await vi.advanceTimersByTimeAsync(5000);
  await expect(list).resolves.toEqual([]);
  expect(started).toEqual([["4321"]]);
  // A node-pty without the method is left alone.
  expect(fixConsoleListFallback(class {}, () => asChild(helper()))).toBe(false);
});

/**
 * A stand-in for node-pty's terminal that records the order of kills. Its kill() ends the shell, and
 * node-pty reports that exit, as the real one does.
 */
function fakeTerminal(events: string[]) {
  const exits: ((e: { exitCode: number }) => void)[] = [];
  const exit = (exitCode: number) => exits.forEach((listener) => listener({ exitCode }));
  const terminal: TerminalProcess = {
    write: () => {},
    resize: (columns, rows) => void events.push(`resize ${columns}x${rows}`),
    kill: () => {
      events.push("pty.kill");
      exit(1);
    },
    onData: () => ({ dispose: () => {} }),
    onExit: (listener) => {
      exits.push(listener);
      return { dispose: () => {} };
    },
  };
  return { terminal, exit };
}

/** The shell pid used below, spawned between these times (ms since 1970). */
const shell = { pid: 4321, spawnStarted: 1_000_000, spawnEnded: 1_000_050 };

/**
 * A stand-in for `holdWindowsProcess`: the process holding the pid started at `startedAt` (undefined:
 * none). Its tree kill takes `treeKillMs`, then ends the shell (`ended`), as taskkill does.
 */
function fakeHold(events: string[], startedAt: number | undefined, { treeKillMs = 0, ended = () => {} } = {}) {
  return async (pid: number) => {
    events.push(`hold ${pid}`);
    return {
      startedAt,
      killTree: async () => {
        await new Promise((done) => setTimeout(done, treeKillMs));
        events.push(`tree ${pid}`);
        ended();
      },
      release: () => void events.push(`release ${pid}`),
    };
  };
}

test("on Windows, kill() ends the shell's whole process tree before node-pty closes the terminal", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const { terminal, exit } = fakeTerminal(events);
  const hold = fakeHold(events, shell.spawnStarted + 10, { treeKillMs: 1000, ended: () => exit(1) });
  const killed = withTreeKill(terminal, shell, { hold, gate: new PtyGate() }).kill();
  await vi.advanceTimersByTimeAsync(999);
  // node-pty waits for the tree kill, which runs in the background.
  expect(events).toEqual(["hold 4321"]);
  await vi.advanceTimersByTimeAsync(1);
  await killed;
  expect(events).toEqual(["hold 4321", "tree 4321", "pty.kill"]);
});

test("a pid that another process took before node-pty reported the exit is never tree-killed", async () => {
  const events: string[] = [];
  const gate = new PtyGate();
  // onExit hasn't fired, but the process now holding the pid started after the shell was spawned.
  await withTreeKill(fakeTerminal(events).terminal, shell, { hold: fakeHold(events, shell.spawnEnded + 5000), gate }).kill();
  expect(events).toEqual(["hold 4321", "release 4321", "pty.kill"]);
  // Nor one that started before it, or a pid nothing holds.
  events.length = 0;
  await withTreeKill(fakeTerminal(events).terminal, shell, { hold: fakeHold(events, shell.spawnStarted - 5000), gate }).kill();
  await withTreeKill(fakeTerminal(events).terminal, shell, { hold: fakeHold(events, undefined), gate }).kill();
  expect(events).toEqual(["hold 4321", "release 4321", "pty.kill", "hold 4321", "release 4321", "pty.kill"]);
});

test("node-pty closes the terminal after TREE_KILL_WAIT_MS if the holder hasn't answered, and a late answer is let go", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  let answer: (held: HeldProcess) => void = () => {};
  const late: HoldProcess = () => new Promise((resolve) => (answer = resolve));
  const killed = withTreeKill(fakeTerminal(events).terminal, shell, { hold: late, gate: new PtyGate() }).kill();
  await vi.advanceTimersByTimeAsync(TREE_KILL_WAIT_MS - 1);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await killed;
  expect(events).toEqual(["pty.kill"]);
  // No shell ends outside the kill's turn: the late holder is let go, not used.
  answer({ startedAt: shell.spawnStarted, killTree: async () => void events.push("tree"), release: () => void events.push("release") });
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["pty.kill", "release"]);
});

test("killNow() stops waiting for the holder: node-pty's kill runs at once, and a late holder is let go", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  let answer: (held: HeldProcess) => void = () => {};
  const late: HoldProcess = () => new Promise((resolve) => (answer = resolve));
  const wrapped = withTreeKill(fakeTerminal(events).terminal, shell, { hold: late, gate: new PtyGate() });
  void wrapped.kill();
  await vi.advanceTimersByTimeAsync(1000);
  expect(events).toEqual([]);
  await wrapped.killNow!();
  expect(events).toEqual(["pty.kill"]);
  answer({ startedAt: shell.spawnStarted, killTree: async () => void events.push("tree"), release: () => void events.push("release") });
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["pty.kill", "release"]);
});

test("kills end one shell at a time, each after node-pty reports the last one's exit", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const gate = new PtyGate();
  const kills = [1, 2].map((pid) => {
    const { terminal, exit } = fakeTerminal(events);
    const ended = () => setTimeout(() => (events.push(`exit ${pid}`), exit(1)), 100);
    const hold = fakeHold(events, shell.spawnStarted, { treeKillMs: 50, ended });
    return withTreeKill(terminal, { ...shell, pid }, { hold, gate }).kill();
  });
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all(kills);
  // Both holders start at once; the second tree kill waits for the first shell's exit.
  expect(events).toEqual(["hold 1", "hold 2", "tree 1", "exit 1", "pty.kill", "tree 2", "exit 2", "pty.kill"]);
});

test("killNow() moves a waiting kill to the front of the queue, but never alongside the kill in progress", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const gate = new PtyGate();
  const terminals = [1, 2, 3].map((pid) => {
    const { terminal, exit } = fakeTerminal(events);
    const ended = () => (events.push(`exit ${pid}`), exit(1));
    return withTreeKill(terminal, { ...shell, pid }, { hold: fakeHold(events, shell.spawnStarted, { treeKillMs: 100, ended }), gate });
  });
  const kills = terminals.map((terminal) => terminal.kill());
  // 1's tree kill is running; 2 and 3 wait their turn.
  await vi.advanceTimersByTimeAsync(50);
  expect(events).toEqual(["hold 1", "hold 2", "hold 3"]);
  // As a profile's cleanup does when its time runs out.
  const urgent = terminals[2]!.killNow!();
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all([...kills, urgent]);
  expect(events.slice(3)).toEqual(["tree 1", "exit 1", "pty.kill", "tree 3", "exit 3", "pty.kill", "tree 2", "exit 2", "pty.kill"]);
});

test("a spawn or a resize waits while a kill is ending a shell", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const gate = new PtyGate();
  const { terminal, exit } = fakeTerminal(events);
  const killed = withTreeKill(terminal, shell, {
    hold: fakeHold(events, shell.spawnStarted, { treeKillMs: 500, ended: () => exit(1) }),
    gate,
  }).kill();
  const other = withTreeKill(fakeTerminal(events).terminal, { ...shell, pid: 99 }, { gate });
  // Waiting for the holder doesn't hold the gate; the tree kill, once the holder answers, does.
  expect(gate.busy).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(gate.busy).toBe(true);
  void gate.idle().then(() => events.push("spawn may start"));
  other.resize(100, 40);
  await vi.advanceTimersByTimeAsync(500);
  await killed;
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["hold 4321", "tree 4321", "pty.kill", "spawn may start", "resize 100x40"]);
  // With no kill going, a resize is immediate.
  other.resize(80, 24);
  expect(events.at(-1)).toBe("resize 80x24");
});

/**
 * node-pty's Windows terminal reduced to its queue: every call waits for the terminal's first
 * output. Its output connection is `pending` until it says `ready_datapipe`.
 */
function queuingTerminal(events: string[], connected: boolean) {
  const queue = (run: () => void) => {
    if (terminal._isReady) run();
    else terminal._deferreds.push({ run });
  };
  const socket = Object.assign(new EventEmitter(), { pending: !connected, destroyed: false });
  const fake = fakeTerminal(events);
  const terminal = {
    ...fake.terminal,
    _isReady: false,
    _deferreds: [] as { run: () => void }[],
    _socket: socket,
    write: (data: string) => queue(() => events.push(`write ${data}`)),
    kill: () => queue(() => events.push("pty.kill")),
  };
  return { terminal, exit: fake.exit, connect: () => ((socket.pending = false), socket.emit("ready_datapipe")) };
}

test("on Windows, kill() doesn't wait for the terminal's first output, which ConPTY may never send (#61)", async () => {
  const events: string[] = [];
  const { terminal, exit } = queuingTerminal(events, true);
  terminal.write("typed before any output");
  await withTreeKill(terminal, shell, { hold: fakeHold(events, shell.spawnStarted, { ended: () => exit(1) }), gate: new PtyGate() }).kill();
  // node-pty kills once the tree kill is done, and the write still queued is dropped: the terminal is closing.
  expect(events).toEqual(["hold 4321", "tree 4321", "pty.kill"]);
  // A node-pty without the queue is killed as usual.
  const plain = fakeTerminal(events).terminal;
  killWithoutWaitingForOutput(plain, () => plain.kill());
  expect(events).toEqual(["hold 4321", "tree 4321", "pty.kill", "pty.kill"]);
});

test("a kill() before node-pty has connected to the terminal's output runs once it connects, and only once", async () => {
  const events: string[] = [];
  const { terminal, exit, connect } = queuingTerminal(events, false);
  const hold = fakeHold(events, shell.spawnEnded, { ended: () => exit(1) });
  const wrapped = withTreeKill(terminal, shell, { hold, gate: new PtyGate() });
  await Promise.all([wrapped.kill(), wrapped.kill()]);
  expect(events).toEqual(["hold 4321", "tree 4321"]);
  connect();
  expect(events).toEqual(["hold 4321", "tree 4321", "pty.kill"]);
});

test("node-pty's exit report goes to console cleanup once, saying whether the bridge was stopping the terminal (#66)", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const exits: boolean[] = [];
  const afterExit = (stopped: boolean) => void exits.push(stopped);
  const { terminal, exit } = fakeTerminal(events);
  const wrapped = withTreeKill(terminal, shell, { hold: fakeHold(events, shell.spawnStarted, { ended: () => exit(1) }), gate: new PtyGate(), afterExit });
  // Nothing while the shell runs.
  await vi.advanceTimersByTimeAsync(1000);
  expect(exits).toEqual([]);
  const killed = wrapped.kill();
  await vi.advanceTimersByTimeAsync(0);
  await killed;
  // The tree kill's exit and node-pty's kill() both report; cleanup hears one.
  expect(exits).toEqual([true]);
  // A shell that exits on its own isn't a stop, however often its exit is reported.
  const own = fakeTerminal(events);
  withTreeKill(own.terminal, { ...shell, spawnStarted: 2_000_000, spawnEnded: 2_000_080 }, { gate: new PtyGate(), afterExit });
  own.exit(0);
  own.exit(0);
  expect(exits).toEqual([true, false]);
});

test("once the shell has exited, kill() leaves its old pid alone", async () => {
  const events: string[] = [];
  const gate = new PtyGate();
  const { terminal, exit } = fakeTerminal(events);
  const wrapped = withTreeKill(terminal, shell, { hold: fakeHold(events, shell.spawnStarted), gate });
  exit(0);
  await wrapped.kill();
  // node-pty heard the exit from Windows, though its onExit hasn't fired yet.
  const reported = Object.assign(fakeTerminal(events).terminal, { _agent: { exitCode: 0 } });
  await withTreeKill(reported, shell, { hold: fakeHold(events, shell.spawnStarted), gate }).kill();
  expect(events).toEqual(["pty.kill", "pty.kill"]);
});

/** A stand-in for the holder process: it records the requests on its stdin and says what the test writes. */
function holderProcess(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdin, stdout, unref: () => {} });
  const requests: string[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => requests.push(...chunk.trim().split("\n")));
  return { child: child as unknown as ChildProcess, stdin, requests, say: (line: string) => void stdout.write(`${line}\n`) };
}

test("a holder that doesn't answer in time, or whose stdin breaks, is ended with its tree, and the next request starts a fresh one", async () => {
  vi.useFakeTimers();
  const holders = [holderProcess(7001), holderProcess(7002), holderProcess(7003)];
  const unstarted = [...holders];
  const ended: number[] = [];
  const holder = new Holder(() => unstarted.shift()!.child, (pid) => void ended.push(pid));

  // A hung holder: its request gives up after HOLDER_REQUEST_MS, and its own process tree is ended.
  const first = holder.hold(4321);
  await vi.advanceTimersByTimeAsync(HOLDER_REQUEST_MS - 1);
  expect(ended).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(first).resolves.toMatchObject({ startedAt: undefined });
  expect(ended).toEqual([7001]);
  // Its late answer finds nobody waiting, and the next request goes to a new holder.
  holders[0]!.say("started 1 1000010");
  const second = holder.hold(4321);
  await vi.advanceTimersByTimeAsync(0);
  expect(holders[0]!.requests).toEqual(["hold 1 4321"]);
  expect(holders[1]!.requests).toEqual(["hold 2 4321"]);
  holders[1]!.say("started 2 1000010");
  const held = await second;
  expect(held.startedAt).toBe(1_000_010);

  // A holder whose stdin breaks answers what is waiting at once, and is ended too.
  const killed = held.killTree();
  await vi.advanceTimersByTimeAsync(0);
  holders[1]!.stdin.emit("error", new Error("EPIPE"));
  await killed;
  expect(ended).toEqual([7001, 7002]);
  void holder.hold(99);
  await vi.advanceTimersByTimeAsync(0);
  expect(holders[2]!.requests).toEqual(["hold 3 99"]);
});

test("a request waiting behind a slow one gets its own HOLDER_REQUEST_MS once the holder takes it (#82)", async () => {
  vi.useFakeTimers();
  const fake = holderProcess(7001);
  const ended: number[] = [];
  const holder = new Holder(() => fake.child, (pid) => void ended.push(pid));
  const first = holder.hold(1111);
  const second = holder.hold(2222);
  await vi.advanceTimersByTimeAsync(0);
  // One request at a time: the second waits here, not in the holder, and its deadline hasn't started.
  expect(fake.requests).toEqual(["hold 1 1111"]);
  await vi.advanceTimersByTimeAsync(HOLDER_REQUEST_MS - 1000);
  fake.say("started 1 1000010");
  await expect(first).resolves.toMatchObject({ startedAt: 1_000_010 });
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.requests).toEqual(["hold 1 1111", "hold 2 2222"]);
  // Answered HOLDER_REQUEST_MS - 1 after the holder got it, and 2 * HOLDER_REQUEST_MS - 2000 after it was asked.
  await vi.advanceTimersByTimeAsync(HOLDER_REQUEST_MS - 1);
  fake.say("started 2 1000020");
  await expect(second).resolves.toMatchObject({ startedAt: 1_000_020 });
  expect(ended).toEqual([]);
});
