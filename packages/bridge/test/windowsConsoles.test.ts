import { EventEmitter } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, getPriority, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { quoteCommand, terminalShell } from "../src/platform.ts";
import { consoleCleanup, endProcessTree, Holder, HOLDER_REQUEST_MS, nodePtyHost, startPowerShell } from "../src/terminal.ts";
import {
  CONSOLE_CLOCK_SLACK_MS,
  CONSOLE_END_DELAY_MS,
  CONSOLE_HOLDER_SCRIPT,
  CONSOLE_RECHECK_MS,
  CONSOLE_REQUEST_MS,
  CONSOLE_SCAN_TRIES,
  ConsoleCleanup,
  ConsoleRecords,
  type ConsoleRecord,
} from "../src/windowsConsoles.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "uplink-consoles-"));
  dirs.push(dir);
  return dir;
}

const SID = "S-1-5-21-1000-2000-3000-1001";
const shell = { pid: 4321, spawnStarted: 1_000_000, spawnEnded: 1_000_050 };
const bind = `${shell.pid},${shell.spawnStarted - CONSOLE_CLOCK_SLACK_MS},${shell.spawnEnded + CONSOLE_CLOCK_SLACK_MS},77`;
const scan = `${shell.pid},${shell.spawnStarted - CONSOLE_CLOCK_SLACK_MS}`;
const conhost = { pid: 5555, created: "134382225895358555" };
const hold = `${conhost.pid},${conhost.created}`;

/** A console holder that answers each verb from `answers` (used in order, the last repeating). */
function fakeConsoleHolder(answers: Record<string, string[][]>) {
  const requests: string[] = [];
  const used: Record<string, number> = {};
  let next = 1;
  const all: Record<string, string[][]> = { whoami: [["user", SID]], bind: [["bound", `${conhost.pid}:${conhost.created}`]], hold: [["held"]], ...answers };
  const request = async (verb: string, argument: string, id: string) => {
    requests.push(`${verb} ${argument}`.trim());
    const list = all[verb] ?? [["done"]];
    const at = Math.min(used[verb] ?? 0, list.length - 1);
    used[verb] = (used[verb] ?? 0) + 1;
    const [word, ...rest] = list[at]!;
    return [word!, id, ...rest];
  };
  return { requests, request, newId: () => String(next++) };
}

function cleanupWith(holder: ReturnType<typeof fakeConsoleHolder>, more: Partial<ConstructorParameters<typeof ConsoleCleanup>[0]> = {}) {
  return new ConsoleCleanup({ request: holder.request, newId: holder.newId, turn: async () => {}, bridgePid: 77, sleep: async () => {}, recheckMs: Infinity, ...more });
}
/** A terminal that started (and was bound) and then exited. */
function exited(cleanup: ConsoleCleanup, stopped: boolean, terminal = shell) {
  cleanup.spawned(terminal);
  return cleanup.afterExit(terminal, { stopped });
}

test("a terminal is bound to its own console host right after it starts, and only that process is ever cleaned up (#82, Codex round 2)", async () => {
  // Two terminals started within one window: each is bound to the console host of its own shell.
  const second = { pid: 4322, spawnStarted: 1_000_051, spawnEnded: 1_000_090 };
  const requests: string[] = [];
  let next = 1;
  const cleanup = new ConsoleCleanup({
    request: async (verb, argument, id) => {
      requests.push(`${verb} ${argument}`.trim());
      if (verb === "bind") return argument.startsWith("4321,") ? ["bound", id, "5555:134382225895358555"] : ["bound", id, "6666:134382225895358999"];
      // The first terminal's console host went with it (node-pty closed it); the second's is there.
      if (verb === "hold") return argument.startsWith("5555,") ? ["gone", id] : ["held", id];
      if (verb === "scan") return ["members", id, "-"];
      if (verb === "end") return ["ended", id];
      return ["done", id];
    },
    newId: () => String(next++),
    turn: async () => {},
    bridgePid: 77,
    sleep: async () => {},
    recheckMs: Infinity,
  });
  cleanup.spawned(shell);
  cleanup.spawned(second);
  await expect(cleanup.afterExit(shell, { stopped: true })).resolves.toBe("gone");
  // Only its own console host was asked for, never the second terminal's, though that started in its window.
  expect(requests.filter((r) => !r.startsWith("bind"))).toEqual(["hold 5555,134382225895358555"]);
  await expect(cleanup.afterExit(second, { stopped: false })).resolves.toBe("ended");
  expect(requests.filter((r) => r.startsWith("hold"))).toEqual(["hold 5555,134382225895358555", "hold 6666,134382225895358999"]);
});

test("a terminal whose console host couldn't be bound is never cleaned up (#82, Codex round 2)", async () => {
  const holder = fakeConsoleHolder({ bind: [["unbound"]] });
  await expect(exited(cleanupWith(holder), true)).resolves.toBe("unbound");
  expect(holder.requests).toEqual([`bind ${bind}`]);
});

test("a binding asked before the shell has connected to its console is asked again until it has (#82, Codex round 2)", async () => {
  const holder = fakeConsoleHolder({ bind: [["pending"], ["pending"], ["bound", `${conhost.pid}:${conhost.created}`]], hold: [["gone"]] });
  const cleanup = cleanupWith(holder);
  cleanup.spawned(shell);
  // The shell runs on while its binding is asked again; its exit comes later.
  await until(() => holder.requests.length === 3);
  await expect(cleanup.afterExit(shell, { stopped: true })).resolves.toBe("gone");
  expect(holder.requests.filter((r) => r.startsWith("bind"))).toEqual([`bind ${bind}`, `bind ${bind}`, `bind ${bind}`]);
  expect(holder.requests.filter((r) => !r.startsWith("bind"))).toEqual([`hold ${hold}`]);
});

test("keeps a console host while the scan can't account for every process that could be attached, and ends it once it can (#82, Codex 1)", async () => {
  // A process that exits mid-scan, or one the scan can't open, leaves the answer uncertain.
  const holder = fakeConsoleHolder({ scan: [["uncertain", "scan"], ["uncertain", "scan"], ["members", "-"]], end: [["ended", "5555"]] });
  await expect(exited(cleanupWith(holder), false)).resolves.toBe("ended");
  expect(holder.requests).toEqual([`bind ${bind}`, `hold ${hold}`, `scan ${scan}`, `scan ${scan}`, `scan ${scan}`, `end ${scan}`, "release"]);

  // Never certain: kept, never ended.
  const never = fakeConsoleHolder({ scan: [["uncertain", "scan"]] });
  await expect(exited(cleanupWith(never), true)).resolves.toBe("kept");
  expect(never.requests.filter((r) => r.startsWith("scan"))).toHaveLength(CONSOLE_SCAN_TRIES);
  expect(never.requests.some((r) => r.startsWith("end"))).toBe(false);

  // The kill's own recheck finds a process attached after all: not ended then; the next scan decides.
  const late = fakeConsoleHolder({ scan: [["members", "-"]], end: [["attached", "9:1"], ["ended", "5555"]] });
  await expect(exited(cleanupWith(late), false)).resolves.toBe("ended");
  expect(late.requests.filter((r) => r.startsWith("end "))).toHaveLength(2);
});

test("after a stop, programs still attached to the console are ended first; after an exit of its own, they and the console stay (#82, follow-up 1)", async () => {
  const stopped = fakeConsoleHolder({ scan: [["members", "8888:131000000000000000"], ["members", "-"]], end: [["ended", "5555"]] });
  await expect(exited(cleanupWith(stopped), true)).resolves.toBe("ended");
  expect(stopped.requests).toEqual([`bind ${bind}`, `hold ${hold}`, `scan ${scan}`, "endmembers 8888:131000000000000000", `scan ${scan}`, `end ${scan}`, "release"]);

  const own = fakeConsoleHolder({ scan: [["members", "8888:131000000000000000"]] });
  await expect(exited(cleanupWith(own), false)).resolves.toBe("kept");
  expect(own.requests).toEqual([`bind ${bind}`, `hold ${hold}`, `scan ${scan}`, "release"]);
});

test("a console host this account can't open is kept, never read as gone; one with another start time is gone (#82, Codex round 2)", async () => {
  const denied = fakeConsoleHolder({ hold: [["denied"]] });
  await expect(exited(cleanupWith(denied), true)).resolves.toBe("kept");
  expect(denied.requests).toEqual([`bind ${bind}`, `hold ${hold}`]);
  const gone = fakeConsoleHolder({ hold: [["gone"]] });
  await expect(exited(cleanupWith(gone), true)).resolves.toBe("gone");
});

test("a console host that had to stay is looked at again later, less and less often, and goes once nothing is attached (#82, Codex 1)", async () => {
  const waits: number[] = [];
  const holder = fakeConsoleHolder({ scan: [["members", "8888:1"], ["members", "8888:1"], ["members", "-"]], end: [["ended", "5555"]] });
  let ended = () => {};
  const done = new Promise<void>((resolve) => (ended = resolve));
  const cleanup = cleanupWith(
    { ...holder, request: async (verb, argument, id) => {
      const answer = await holder.request(verb, argument, id);
      if (verb === "end") ended();
      return answer;
    } },
    { sleep: async (ms) => void waits.push(ms), recheckMs: CONSOLE_RECHECK_MS },
  );
  // An exit of its own with a program still attached: kept at first, then ended once it is gone.
  await expect(exited(cleanup, false)).resolves.toBe("kept");
  await done;
  expect(waits).toEqual([CONSOLE_END_DELAY_MS, CONSOLE_RECHECK_MS, CONSOLE_RECHECK_MS * 2]);
  expect(holder.requests.filter((r) => r.startsWith("end "))).toEqual([`end ${scan}`]);
  expect(holder.requests.some((r) => r.startsWith("endmembers"))).toBe(false);
});

test("console cleanup waits CONSOLE_END_DELAY_MS, and asks the console holder nothing but the binding while a kill runs or the shell holder is busy (#82, Codex 2)", async () => {
  vi.useFakeTimers();
  const holder = fakeConsoleHolder({ hold: [["gone"]] });
  let free = () => {};
  let turns = 0;
  const cleanup = new ConsoleCleanup({
    request: holder.request,
    newId: holder.newId,
    turn: () => (turns++, new Promise<void>((resolve) => (free = resolve))),
    bridgePid: 77,
  });
  cleanup.spawned(shell);
  const outcome = cleanup.afterExit(shell, { stopped: true });
  await vi.advanceTimersByTimeAsync(CONSOLE_END_DELAY_MS - 1);
  expect(turns).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(turns).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  // The binding doesn't wait (the shell must still be alive); nothing else goes until the turn.
  expect(holder.requests).toEqual([`bind ${bind}`]);
  free();
  await expect(outcome).resolves.toBe("gone");
});

/** A stand-in for a holder process: it records the requests on its stdin and says what the test writes. */
function holderProcess(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdin, stdout, unref: () => {} });
  const requests: string[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => requests.push(...chunk.trim().split("\n")));
  return { child: child as unknown as ChildProcess, requests, say: (line: string) => void stdout.write(`${line}\n`) };
}

test("a console holder that hangs on a scan is ended alone; the shell holder keeps answering holds meanwhile (#82, Codex 2)", async () => {
  vi.useFakeTimers();
  const shellProcess = holderProcess(7001);
  const consoleProcess = holderProcess(8001);
  const ended: number[] = [];
  const shells = new Holder(() => shellProcess.child, (pid) => void ended.push(pid));
  const consoles = new Holder(() => consoleProcess.child, (pid) => void ended.push(pid), CONSOLE_REQUEST_MS);
  const cleanup = new ConsoleCleanup({
    request: (verb, argument, id, first) => consoles.request(verb, argument, id, first),
    newId: () => consoles.newId(),
    turn: () => shells.whenIdle(),
    bridgePid: 77,
    sleep: async () => {},
    recheckMs: Infinity,
  });
  cleanup.spawned(shell);
  await vi.advanceTimersByTimeAsync(0);
  consoleProcess.say(`bound 1 ${conhost.pid}:${conhost.created}`);
  void cleanup.afterExit(shell, { stopped: true });
  await vi.advanceTimersByTimeAsync(CONSOLE_END_DELAY_MS);
  consoleProcess.say("held 2");
  await vi.advanceTimersByTimeAsync(0);
  expect(consoleProcess.requests).toEqual([`bind 1 ${bind}`, `hold 2 ${hold}`, `scan 2 ${scan}`]);
  // The scan hangs. A hold goes to the shell holder and is answered at once, well inside HOLDER_REQUEST_MS.
  const held = shells.hold(4321);
  await vi.advanceTimersByTimeAsync(0);
  shellProcess.say("started 1 1000010");
  await expect(held).resolves.toMatchObject({ startedAt: 1_000_010 });
  await vi.advanceTimersByTimeAsync(CONSOLE_REQUEST_MS);
  // Only the console holder was ended; the shell holder is the same process, still answering.
  expect(ended).toEqual([8001]);
  const again = shells.hold(4322);
  await vi.advanceTimersByTimeAsync(0);
  expect(shellProcess.requests).toEqual(["hold 1 4321", "hold 2 4322"]);
  shellProcess.say("started 2 1000011");
  await expect(again).resolves.toMatchObject({ startedAt: 1_000_011 });
  expect(HOLDER_REQUEST_MS).toBeLessThan(CONSOLE_REQUEST_MS);
});

test("a binding goes ahead of the console holder's waiting requests (#82, Codex round 2)", async () => {
  const fake = holderProcess(9001);
  const holder = new Holder(() => fake.child, () => {}, CONSOLE_REQUEST_MS);
  void holder.request("scan", "a", "1");
  void holder.request("scan", "b", "2");
  void holder.request("bind", "c", "3", true);
  await new Promise((resolve) => setImmediate(resolve));
  fake.say("members 1 -");
  await new Promise((resolve) => setImmediate(resolve));
  expect(fake.requests).toEqual(["scan 1 a", "bind 3 c"]);
});

/** Lets pending work run until `check` holds (at most 100 turns). */
async function until(check: () => boolean) {
  for (let turn = 0; turn < 100 && !check(); turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

test("a console holder that dies during a look never makes the console host count as gone: it stays, with its record, and is looked at again (#82, Codex review of fe4d09a)", async () => {
  const dir = tempDir();
  const dying = holderProcess(9101);
  const fresh = holderProcess(9102);
  const processes = [dying, fresh];
  const holder = new Holder(() => processes.shift()!.child, () => {}, CONSOLE_REQUEST_MS);
  const waits: number[] = [];
  const cleanup = new ConsoleCleanup({
    request: (verb, argument, id, first) => holder.request(verb, argument, id, first),
    newId: () => holder.newId(),
    turn: async () => {},
    bridgePid: 77,
    sleep: async (ms) => void waits.push(ms),
  });
  cleanup.recordIn(dir);
  cleanup.spawned(shell);
  await until(() => dying.requests.length === 1);
  dying.say(`bound 1 ${conhost.pid}:${conhost.created}`);
  await until(() => dying.requests.length === 2);
  dying.say(`user 2 ${SID}`);
  await until(() => readdirSync(dir).length === 1);
  const file = join(dir, readdirSync(dir)[0]!);
  const outcome = cleanup.afterExit(shell, { stopped: false });
  await until(() => dying.requests.length === 3);
  expect(dying.requests[2]).toBe(`hold 3 ${hold}`);
  // The holder process ends while working on the hold: that says nothing about the console host.
  (dying.child as unknown as EventEmitter).emit("close");
  await expect(outcome).resolves.toBe("kept");
  expect(JSON.parse(readFileSync(file, "utf8")).terminals).toHaveLength(1);
  // Looked at again CONSOLE_RECHECK_MS later, through a fresh holder, which finds it gone: only now does its record go.
  await until(() => fresh.requests.length === 1);
  expect(fresh.requests[0]).toBe(`hold 4 ${hold}`);
  expect(waits).toEqual([CONSOLE_END_DELAY_MS, CONSOLE_RECHECK_MS]);
  fresh.say("gone 4");
  await until(() => !existsSync(file));
});

test("a binding the holder failed or timed out on is asked again later while the shell runs, and given up once its exit is reported (#82)", async () => {
  // The holder fails, then times out, then answers: the terminal is bound after waits of 30 s and 60 s.
  const waits: number[] = [];
  const holder = fakeConsoleHolder({ bind: [["failed"], ["timeout"], ["bound", `${conhost.pid}:${conhost.created}`]], hold: [["gone"]] });
  const cleanup = cleanupWith(holder, { recheckMs: CONSOLE_RECHECK_MS, sleep: async (ms) => void waits.push(ms) });
  cleanup.spawned(shell);
  await until(() => holder.requests.length === 3);
  await expect(cleanup.afterExit(shell, { stopped: true })).resolves.toBe("gone");
  expect(waits.slice(0, 2)).toEqual([CONSOLE_RECHECK_MS, 2 * CONSOLE_RECHECK_MS]);
  expect(holder.requests).toEqual([`bind ${bind}`, `bind ${bind}`, `bind ${bind}`, `hold ${hold}`]);
  // The holder keeps failing and the shell exits while the binding waits to ask again: it stays
  // unbound, nothing more is asked, and its console host is never cleaned up.
  const failing = fakeConsoleHolder({ bind: [["failed"]] });
  const later = cleanupWith(failing, { recheckMs: CONSOLE_RECHECK_MS, sleep: () => new Promise(() => {}) });
  later.spawned(shell);
  await until(() => failing.requests.length === 1);
  await expect(later.afterExit(shell, { stopped: true })).resolves.toBe("unbound");
  await new Promise((resolve) => setImmediate(resolve));
  expect(failing.requests).toEqual([`bind ${bind}`]);
});

test("a whoami the holder failed on is asked again at the next need, and every terminal bound meanwhile is recorded once it answers (#82)", async () => {
  const dir = tempDir();
  const second = { pid: 4322, spawnStarted: 2_000_000, spawnEnded: 2_000_050 };
  const holder = fakeConsoleHolder({ whoami: [["failed"], ["user", SID]], bind: [["bound", "5555:134382225895358555"], ["bound", "6666:134382225895358999"]] });
  const cleanup = cleanupWith(holder);
  cleanup.recordIn(dir);
  cleanup.spawned(shell);
  await until(() => holder.requests.includes("whoami"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(readdirSync(dir)).toEqual([]);
  // The next terminal's binding needs the record again: whoami is asked again, answers, and both are written.
  cleanup.spawned(second);
  await until(() => readdirSync(dir).length === 1);
  expect(holder.requests.filter((r) => r === "whoami")).toHaveLength(2);
  expect(readdirSync(dir)).toEqual([`${SID}.77-${Math.round(performance.timeOrigin)}.json`]);
  const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")) as ConsoleRecord;
  expect(record.terminals.map((t) => t.conhost.pid)).toEqual([5555, 6666]);
});

function writeRecord(dir: string, record: ConsoleRecord) {
  const file = join(dir, ConsoleRecords.fileName(record.user, record.pid, record.startedAt));
  writeFileSync(file, JSON.stringify(record));
  return file;
}
const recorded = (pid: number, spawnStarted: number, host: number) => ({ pid, spawnStarted, spawnEnded: spawnStarted + 50, conhost: { pid: host, created: `13438222589535${host}` } });

test("on startup, ends only the console hosts a bridge that has exited recorded, with nothing attached; one it can't open, or with a program attached, keeps its record and is looked at again (#82)", async () => {
  const dir = tempDir();
  const dead = 2_147_483_000;
  const deadFile = writeRecord(dir, {
    v: 2,
    user: SID,
    pid: dead,
    startedAt: 900_000,
    // Empty and ended; gone; a program attached, which has exited by the next look; one this account can't open.
    terminals: [recorded(11, 1_000_000, 5001), recorded(12, 2_000_000, 5002), recorded(13, 3_000_000, 5003), recorded(14, 4_000_000, 5004)],
  });
  // This test's own process, under another start time: a bridge that is still running.
  const aliveFile = writeRecord(dir, { v: 2, user: SID, pid: process.pid, startedAt: 800_000, terminals: [recorded(21, 1_500_000, 6001)] });
  // Another Windows account's records: never this bridge's to sweep or rewrite.
  const otherFile = writeRecord(dir, { v: 2, user: "S-1-5-20", pid: dead + 1, startedAt: 900_000, terminals: [recorded(31, 1_000_000, 7001)] });
  const requests: string[] = [];
  let next = 1;
  let scans13 = 0;
  const waits: number[] = [];
  let looks = 0;
  let settled = () => {};
  const done = new Promise<void>((resolve) => (settled = resolve));
  const cleanup = new ConsoleCleanup({
    request: async (verb, argument, id) => {
      requests.push(`${verb} ${argument}`.trim());
      if (verb === "whoami") return ["user", id, SID];
      if (verb === "alive") return ["alive", id, "yes"];
      if (verb === "hold") {
        const host = Number(argument.split(",")[0]);
        return [host === 5002 ? "gone" : host === 5004 ? "denied" : "held", id];
      }
      if (verb === "scan") return argument.startsWith("13,") && scans13++ === 0 ? ["members", id, "9999:1"] : ["members", id, "-"];
      if (verb === "end") {
        if (argument.startsWith("13,")) settled();
        return ["ended", id];
      }
      return ["done", id];
    },
    newId: () => String(next++),
    turn: async () => {},
    bridgePid: process.pid,
    // Each look again comes at once here, three times; after that, never.
    sleep: (ms) => (waits.push(ms), ++looks <= 3 ? Promise.resolve() : new Promise(() => {})),
  });
  await cleanup.sweep(dir);
  expect(requests).toContain(`alive ${process.pid},1500000`);
  expect(requests.filter((r) => r.startsWith("hold")).slice(0, 4)).toEqual(["hold 5001,134382225895355001", "hold 5002,134382225895355002", "hold 5003,134382225895355003", "hold 5004,134382225895355004"]);
  // After the first pass: the ended and the gone ones are dropped; the attached and the denied ones stay.
  expect(JSON.parse(readFileSync(deadFile, "utf8")).terminals.map((t: { pid: number }) => t.pid)).toEqual([13, 14]);
  // Looked at again: the attached program has exited, so its console host is ended and dropped too.
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  expect(waits[0]).toBe(CONSOLE_RECHECK_MS);
  expect(JSON.parse(readFileSync(deadFile, "utf8")).terminals.map((t: { pid: number }) => t.pid)).toEqual([14]);
  expect(requests.some((r) => r.startsWith("endmembers"))).toBe(false);
  expect(existsSync(aliveFile)).toBe(true);
  expect(JSON.parse(readFileSync(otherFile, "utf8")).terminals).toHaveLength(1);
  expect(requests.some((r) => r.includes("7001"))).toBe(false);
});

test("a bridge records each bound terminal in a file of its own, named for its Windows account, and deletes it once none is left (#82)", () => {
  const dir = tempDir();
  const records = new ConsoleRecords(dir, SID, 4242, 123);
  const first = { ...shell, conhost };
  const second = { pid: 99, spawnStarted: 5, spawnEnded: 6, conhost: { pid: 98, created: "1" } };
  records.add(first);
  records.add(second);
  expect(readdirSync(dir)).toEqual([`${SID}.4242-123.json`]);
  expect(JSON.parse(readFileSync(join(dir, `${SID}.4242-123.json`), "utf8"))).toEqual({ v: 2, user: SID, pid: 4242, startedAt: 123, terminals: [first, second] });
  records.remove(first);
  records.remove(second);
  expect(readdirSync(dir)).toEqual([]);
  // Its own file is never another bridge's to sweep, and nobody else's is either.
  records.add(first);
  expect(ConsoleRecords.others(dir, SID, { pid: 4242, startedAt: 123 })).toEqual([]);
  expect(ConsoleRecords.others(dir, "S-1-5-20", { pid: 1, startedAt: 1 })).toEqual([]);
  // A record another bridge's sweep drops a terminal from is never recreated once deleted.
  const file = join(dir, `${SID}.4242-123.json`);
  rmSync(file);
  ConsoleRecords.drop(file, first);
  expect(readdirSync(dir)).toEqual([]);
});

// Real ConPTY terminals on Windows.

const windows = process.platform === "win32";
const term = join(import.meta.dirname, "tools/term.mjs");
const run = promisify(execFile);

/** `conhost.exe --headless` processes whose parent is `parent` (this process by default), by pid (CIM). */
async function consoleHosts(parent = process.pid): Promise<number[]> {
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='conhost.exe'" | Where-Object { $_.CommandLine -like '*--headless*' } | ForEach-Object { $_.ProcessId }`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  return stdout.split(/\r?\n/).filter(Boolean).map(Number);
}
/** Whether a process with this pid exists (one that won't let this process query it counts too). */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function start(...words: string[]) {
  const shell = terminalShell(quoteCommand([process.execPath, term, ...words]));
  const terminal = nodePtyHost.spawn(shell.file, shell.args, { name: "xterm-256color", cols: 120, rows: 30, cwd: process.cwd(), env: process.env });
  let output = "";
  terminal.onData((data) => void (output += data));
  const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()));
  return { terminal, exited, output: () => output };
}
async function pidIn(file: string) {
  await expect.poll(() => existsSync(file) && readFileSync(file, "utf8").trim().length > 0, { timeout: 30_000 }).toBe(true);
  return Number(readFileSync(file, "utf8").trim());
}

test.skipIf(!windows)(
  "on Windows, the console holder runs at the bridge's own priority, so a machine busy at normal priority can't starve bindings and cleanup",
  async () => {
    // A holder below the bridge's priority runs only when Windows boosts it as a starved thread. On
    // the CI runner, busy at normal priority with several test suites at once, its requests then
    // took seconds each, and an exited terminal's console host outlived the #66 test's 20 s.
    // At normal priority itself, a holder that lowers its own shows here wherever the tests run.
    const own = getPriority();
    setPriority(constants.priority.PRIORITY_NORMAL);
    const holder = startPowerShell(CONSOLE_HOLDER_SCRIPT);
    try {
      let answers = "";
      holder.stdout!.setEncoding("utf8");
      holder.stdout!.on("data", (data: string) => void (answers += data));
      holder.stdin!.write("whoami 1\n");
      // Answered, so the script has run past its first lines and set whatever it sets.
      await expect.poll(() => answers, { timeout: 60_000 }).toContain("user 1 ");
      expect(getPriority(holder.pid!)).toBe(constants.priority.PRIORITY_NORMAL);
    } finally {
      holder.stdin!.end();
      endProcessTree(holder.pid!);
      setPriority(own);
    }
  },
  90_000,
);

test.skipIf(!windows)(
  "on Windows, a terminal's console host ends after its shell exits, and a running terminal's stays, even one started right after it (#66)",
  async () => {
    const before = await consoleHosts();
    const running = start("echo");
    await expect.poll(running.output).toContain("ready");
    const hosts = (await consoleHosts()).filter((pid) => !before.includes(pid));
    expect(hosts).toHaveLength(1);

    // Its console host goes once its program exits on its own; the running terminal's stays.
    const exiting = start("print", "bye");
    await exiting.exited;
    await expect.poll(async () => (await consoleHosts()).filter((pid) => !before.includes(pid)), { timeout: 20_000 }).toEqual(hosts);

    // Started right after a terminal that then exits, a terminal's console host is in that
    // terminal's window too. Each is bound to its own: the first one's goes, the next one's stays.
    // The first one's program exits when told, not after a fixed time: on a busy CI runner the
    // next one's start and the console host listing took longer than 1.5 s, so the first one's
    // console host was already gone when the pair was counted.
    const both = await consoleHosts();
    const first = start("quit");
    const next = start("echo");
    await expect.poll(first.output).toContain("ready");
    await expect.poll(next.output).toContain("ready");
    const pair = (await consoleHosts()).filter((pid) => !both.includes(pid));
    expect(pair).toHaveLength(2);
    first.terminal.write("bye\r");
    await first.exited;
    await expect.poll(async () => pair.filter(alive).length, { timeout: 20_000 }).toBe(1);
    next.terminal.write("still here\r");
    await expect.poll(next.output).toContain("got:still here");
    running.terminal.write("me too\r");
    await expect.poll(running.output).toContain("got:me too");
    await Promise.all([running.terminal.kill(), next.terminal.kill()]);
    await Promise.all([running.exited, next.exited]);
  },
);

test.skipIf(!windows)(
  "on Windows, a console host stays while a program the scan can't read is attached, and goes once that program has (#82, Codex 1)",
  async ({ skip }) => {
    const pidFile = join(tempDir(), "locked.pid");
    const before = await consoleHosts();
    const locked = start("locked", pidFile);
    const program = await pidIn(pidFile);
    await locked.exited;
    const [host] = (await consoleHosts()).filter((pid) => !before.includes(pid));
    // Windows 11 24H2 (build 26100) ends a console's programs when its shell exits; 21H2 (22000) doesn't.
    skip(!alive(program), "this Windows build ended the program with its shell, so nothing stays attached");
    try {
      expect(host).toBeDefined();
      // Past the first scans: the console host and the program both stay.
      await new Promise((resolve) => setTimeout(resolve, CONSOLE_END_DELAY_MS + 4000));
      expect(alive(host!)).toBe(true);
      expect(alive(program)).toBe(true);
    } finally {
      // Node's process.kill needs the right to query it, so it gets that back first.
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "tools/lock-process.ps1"), String(program), "-Unlock"], { windowsHide: true });
      if (alive(program)) process.kill(program);
    }
    // The next look, at most CONSOLE_RECHECK_MS after the first ones, finds nothing attached.
    await expect.poll(() => alive(host!), { timeout: CONSOLE_RECHECK_MS + 30_000 }).toBe(false);
  },
  120_000,
);

test.skipIf(!windows)(
  "on Windows, stopping a terminal ends a program still attached to its console that the tree kill can't reach, and then its console host (#82, follow-up 1)",
  async ({ skip }) => {
    const pidFile = join(tempDir(), "orphan.pid");
    const before = await consoleHosts();
    const terminal = start("orphan", pidFile);
    await expect.poll(terminal.output, { timeout: 30_000 }).toContain("ready");
    const orphan = await pidIn(pidFile);
    const [host] = (await consoleHosts()).filter((pid) => !before.includes(pid));
    try {
      expect(host).toBeDefined();
      await terminal.terminal.kill();
      await terminal.exited;
      skip(!alive(orphan), "this Windows build ended the program with its shell, so nothing stays attached");
      await expect.poll(() => alive(orphan), { timeout: 30_000 }).toBe(false);
      await expect.poll(() => alive(host!), { timeout: 30_000 }).toBe(false);
    } finally {
      if (alive(orphan)) process.kill(orphan);
    }
  },
);

test.skipIf(!windows)(
  "on Windows, a bridge that starts after one that crashed with a terminal open ends the console host it left, and nothing else (#82, follow-up 2)",
  async ({ skip }) => {
    const dir = tempDir();
    // This process's own running terminal: its console host must stay.
    const before = await consoleHosts();
    const mine = start("echo");
    await expect.poll(mine.output).toContain("ready");
    const myHosts = (await consoleHosts()).filter((pid) => !before.includes(pid));
    expect(myHosts).toHaveLength(1);

    const crash = spawn(process.execPath, [join(import.meta.dirname, "tools/crashBridge.ts"), dir], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const code = await new Promise<number | null>((resolve) => crash.on("exit", (exitCode) => resolve(exitCode)));
    expect(code).toBe(3);
    expect(readdirSync(dir)).toEqual([expect.stringMatching(new RegExp(`^S-[0-9-]+\\.${crash.pid}-\\d+\\.json$`))]);
    // On build 22000 the crashed bridge's console host outlives it; on 26100 it exits with the bridge.
    const left = await consoleHosts(crash.pid);
    if (!left.length) {
      await mine.terminal.kill();
      await mine.exited;
    }
    skip(!left.length, "this Windows build ended the crashed bridge's console host with the bridge");
    expect(left).toHaveLength(1);

    await consoleCleanup.sweep(dir);
    expect(alive(left[0]!)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect((await consoleHosts()).filter((pid) => !before.includes(pid))).toEqual(myHosts);
    mine.terminal.write("still here\r");
    await expect.poll(mine.output).toContain("got:still here");
    await mine.terminal.kill();
    await mine.exited;
  },
);

test.skipIf(!windows)(
  "on Windows, two terminals started within one window keep their own console hosts: stopping one whose console node-pty closes never ends the other's (#82, Codex round 2)",
  async () => {
    const before = await consoleHosts();
    const a = start("echo");
    const b = start("echo");
    await expect.poll(a.output).toContain("ready");
    await expect.poll(b.output).toContain("ready");
    const pair = (await consoleHosts()).filter((pid) => !before.includes(pid));
    expect(pair).toHaveLength(2);
    // No tree kill: node-pty closes a's console itself, so a's console host goes on its own.
    await a.terminal.killNow!();
    await a.exited;
    await expect.poll(() => pair.filter(alive).length, { timeout: 20_000 }).toBe(1);
    const [bHost] = pair.filter(alive);
    // Past a's cleanup: b's console host, the only one left in a's window, is still there, and b still works.
    await new Promise((resolve) => setTimeout(resolve, CONSOLE_END_DELAY_MS + 4000));
    expect(alive(bHost!)).toBe(true);
    b.terminal.write("still here\r");
    await expect.poll(b.output).toContain("got:still here");
    await b.terminal.kill();
    await b.exited;
    await expect.poll(() => alive(bHost!), { timeout: 30_000 }).toBe(false);
  },
);

test.skipIf(!windows)(
  "on Windows, a crashed bridge's console host this account can't open keeps its record, and is ended once it can be (#82, Codex round 2)",
  async ({ skip }) => {
    const { stdout: privileges } = await run("whoami.exe", ["/priv"], { windowsHide: true });
    // An account that may use SeDebugPrivilege opens any process: then nothing here is out of reach.
    skip(privileges.includes("SeDebugPrivilege"), "this account can open any process (SeDebugPrivilege)");
    const dir = tempDir();
    const crash = spawn(process.execPath, [join(import.meta.dirname, "tools/crashBridge.ts"), dir], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    expect(await new Promise<number | null>((resolve) => crash.on("exit", (code) => resolve(code)))).toBe(3);
    const left = await consoleHosts(crash.pid);
    skip(!left.length, "this Windows build ended the crashed bridge's console host with the bridge");
    const lock = (...more: string[]) =>
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "tools/lock-process.ps1"), String(left[0]), ...more], { windowsHide: true });
    await lock();
    try {
      await consoleCleanup.sweep(dir);
      // Not read as gone: the console host and its record both stay.
      expect(alive(left[0]!)).toBe(true);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      await lock("-Unlock");
    }
    await consoleCleanup.sweep(dir);
    expect(alive(left[0]!)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  },
);
