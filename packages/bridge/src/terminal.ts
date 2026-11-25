import { fork, spawn, type ChildProcess } from "node:child_process";
import { accessSync, chmodSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, win32 } from "node:path";
import * as pty from "node-pty";
import { CONSOLE_HOLDER_SCRIPT, CONSOLE_REQUEST_MS, ConsoleCleanup } from "./windowsConsoles.ts";

export type TerminalProcess = Pick<pty.IPty, "write" | "resize" | "onData" | "onExit"> & {
  /** On Windows the kill takes a moment (the process-tree kill), and the promise settles when it's done. */
  kill(signal?: string): void | Promise<void>;
  /** Kills without the process-tree kill, for a caller out of time (Windows only; see `withTreeKill`). */
  killNow?(): Promise<void>;
  /** The terminal's tty, such as `/dev/ttys004` (node-pty's Unix terminal has it; it isn't in its typings). */
  readonly ptsName?: string;
};
export interface TerminalHost {
  /** A string `args` is a ready-made Windows command line. */
  spawn(
    command: string,
    args: string[] | string,
    options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions,
  ): TerminalProcess;
  /** Resolves when a spawn is safe to start (on Windows, once no kill is ending a shell). */
  whenIdle?(): Promise<void>;
  /** Whether a spawn is safe to start right now. */
  isIdle?(): boolean;
}

let helperChecked = false;
/**
 * node-pty 1.1.0's macOS prebuilt `spawn-helper` installs without its execute
 * bit, so every spawn fails with "posix_spawnp failed" (the repo's postinstall
 * fixes it for development; this fixes it for an `npm install -g` of the
 * bridge). Inside the packaged app the file is already executable and signed,
 * so this changes nothing there.
 */
function ensureSpawnHelper() {
  if (helperChecked || process.platform !== "darwin") return;
  helperChecked = true;
  try {
    const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json")).replace(
      /app\.asar(?=[\\/])/,
      "app.asar.unpacked",
    );
    for (const dir of ["build/Release", `prebuilds/darwin-${process.arch}`]) {
      const helper = join(root, dir, "spawn-helper");
      try {
        accessSync(helper, constants.X_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES") chmodSync(helper, 0o755);
      }
    }
  } catch {
    // node-pty reports its own error if the helper still can't run.
  }
}

/** How long node-pty waits for its console-list helper before giving up. */
const CONSOLE_LIST_TIMEOUT_MS = 5000;

/**
 * Lists the processes attached to a Windows shell's console, as node-pty's `kill()` does before it
 * closes the console: a helper process attaches to the console and sends back the list. Unlike
 * node-pty, every failure lists nothing. In node-pty 1.1.0 (and still in 1.2.0-beta.18) a helper that
 * doesn't answer within 5 s makes `kill()` kill the shell's old pid, which Windows may have given to
 * an unrelated process by then (#34, #44). The helper fails that way whenever the shell is already
 * gone ("AttachConsole failed"), and its exit settles the list at once instead of after 5 s.
 */
export function listConsoleProcesses(
  shellPid: number,
  startHelper: (args: string[]) => ChildProcess,
  timeoutMs = CONSOLE_LIST_TIMEOUT_MS,
): Promise<number[]> {
  if (!(shellPid > 0)) return Promise.resolve([]);
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (list: number[]) => {
      clearTimeout(timeout);
      resolve(list);
    };
    const helper = startHelper([String(shellPid)]);
    helper.on("message", (message: { consoleProcessList?: unknown }) => {
      const list = message?.consoleProcessList;
      settle(Array.isArray(list) ? list.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) : []);
    });
    // Node delivers a helper's last message before its `close`, so this only settles a helper that died silent.
    helper.on("close", () => settle([]));
    helper.on("error", () => settle([]));
    timeout = setTimeout(() => {
      helper.kill();
      settle([]);
    }, timeoutMs);
  });
}

/**
 * Replaces node-pty's console listing on its `WindowsPtyAgent` with `listConsoleProcesses`. The repo
 * patches node-pty the same way (`patches/node-pty@1.1.0.patch`), but a standalone install gets
 * node-pty unpatched from npm, so the bridge applies the fix itself. Returns false, changing
 * nothing, if this node-pty has no such method.
 */
export function fixConsoleListFallback(
  agent: { prototype: object } | undefined,
  startHelper: (args: string[]) => ChildProcess,
): boolean {
  const prototype = agent?.prototype as { _getConsoleProcessList?: unknown } | undefined;
  if (typeof prototype?._getConsoleProcessList !== "function") return false;
  prototype._getConsoleProcessList = function (this: { _innerPid: number }) {
    return listConsoleProcesses(this._innerPid, startHelper);
  };
  return true;
}

function fixWindowsKill() {
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve("node-pty/lib/windowsPtyAgent");
    const helper = join(dirname(file), "conpty_console_list_agent");
    fixConsoleListFallback(require(file).WindowsPtyAgent, (args) => fork(helper, args));
  } catch {
    // A node-pty laid out differently keeps its own kill().
  }
}
if (process.platform === "win32") fixWindowsKill();

/** A process `holdWindowsProcess` holds open, so its pid can't go to another process until it's let go. */
export interface HeldProcess {
  /** When the process with the pid started (ms since 1970), or undefined if none could be held. */
  startedAt?: number;
  /** Ends the held process and every process it started (`taskkill /T /F`), then lets it go. */
  killTree(): Promise<void>;
  /** Lets it go without killing it. */
  release(): void;
}
export type HoldProcess = (pid: number) => Promise<HeldProcess>;

/**
 * The holder: one Windows PowerShell 5.1 process (on every Windows; pwsh may not be) that serves
 * every hold over its stdin, one line per request, and answers each with the request's id. A new
 * PowerShell process blocks the bridge's event loop while Windows starts it, about 1 s and up to
 * 2.9 s under NETWORK SERVICE on sthopc01, which made close() overrun its deadline when every kill
 * started one. `Process.Handle` opens a handle and keeps it until the process is disposed, and
 * `StartTime` reads through that handle (.NET Framework's `Process.cs`), so the start time and the
 * `taskkill` both concern the process the handle holds. Windows reuses a pid only once every handle
 * to the process is closed (`PROCESS_INFORMATION`, Microsoft Learn). A process that's gone, or that
 * this account can't open, answers "gone". The holder ends, letting every handle go, when the
 * bridge closes its stdin or exits. It serves only holds and tree kills: ending a terminal's console
 * host has its own holder (`windowsConsoles.ts`), so a slow scan there never delays one here.
 */
const HOLDER_SCRIPT = `$ErrorActionPreference = 'Stop'
$held = @{}
$epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $verb, $id, $pid_ = $line.Split(' ')
  if ($verb -eq 'hold') {
    try {
      $p = [System.Diagnostics.Process]::GetProcessById([int]$pid_)
      $null = $p.Handle
      $started = [long]($p.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds
      $held[$id] = $p
      [Console]::Out.WriteLine("started $id $started")
    } catch { [Console]::Out.WriteLine("gone $id") }
  } else {
    $p = $held[$id]
    if ($p) {
      if ($verb -eq 'kill') { try { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.Id /T /F *> $null } catch {} }
      $p.Dispose()
      $held.Remove($id)
    }
    [Console]::Out.WriteLine("done $id")
  }
}`;

/** How long the holder may take over one request, counted from when it gets it; past that it counts as hung. */
export const HOLDER_REQUEST_MS = 5000;

/** Starts Windows PowerShell running `script`. */
export function startPowerShell(script: string): ChildProcess {
  const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawn(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
}

/** Ends a process and every process it started (`taskkill /T /F`), without waiting. */
export function endProcessTree(pid: number) {
  const taskkill = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
}

interface HolderProcess {
  child: ChildProcess;
  /** The request it is working on: the only one written to it and not yet answered. */
  working?: { id: string; answer: (words: string[]) => void };
}
interface QueuedRequest {
  verb: string;
  id: string;
  argument: string;
  resolve: (words: string[]) => void;
}

/**
 * The client side of a holder process (`HOLDER_SCRIPT`, or the console holder's). Requests go to
 * it one at a time, and each must be answered within `requestMs` of being written: the wait in this
 * queue doesn't count, so requests waiting behind a slow one never time out for it. A holder that
 * doesn't answer in time, or whose stdin breaks, is ended with its own process tree (a `taskkill` it
 * is stuck in included), the request it was working on answers "timeout" or "failed", and the next
 * request starts a fresh holder. Both only ever mean a failure, so a failure can't pass for a real
 * answer (a console host the script found "gone", say).
 */
export class Holder {
  private current?: HolderProcess;
  private nextRequest = 1;
  private readonly queue: QueuedRequest[] = [];
  private idlers: (() => void)[] = [];
  private readonly start: () => ChildProcess;
  private readonly endTree: (pid: number) => void;
  private readonly requestMs: number;
  // Plain fields, not parameter properties: Node runs this file with its types stripped (`bin.ts`).
  constructor(
    start: () => ChildProcess = () => startPowerShell(HOLDER_SCRIPT),
    endTree: (pid: number) => void = endProcessTree,
    requestMs = HOLDER_REQUEST_MS,
  ) {
    this.start = start;
    this.endTree = endTree;
    this.requestMs = requestMs;
  }
  /** Starts the holder if none is running. */
  warm() {
    this.running();
  }
  /** Whether no request is waiting or being worked on. */
  get idle() {
    return this.queue.length === 0 && !this.current?.working;
  }
  /** Resolves once no request is waiting or being worked on. */
  whenIdle(): Promise<void> {
    return this.idle ? Promise.resolve() : new Promise((resolve) => this.idlers.push(resolve));
  }
  private running(): HolderProcess {
    if (this.current) return this.current;
    const child = this.start();
    const current: HolderProcess = { child };
    this.current = current;
    // It never keeps the bridge process running; it ends by itself when the bridge closes its stdin.
    child.unref?.();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    child.stdin?.on("error", () => this.replace(current, "failed"));
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const words = buffer.slice(0, end).trim().split(" ");
        buffer = buffer.slice(end + 1);
        const working = current.working;
        if (working && working.id === words[1]) working.answer(words);
      }
    });
    const ended = () => {
      if (this.current === current) this.current = undefined;
      current.working?.answer(["failed"]);
    };
    child.once("close", ended);
    child.once("error", ended);
    return current;
  }
  /** Ends a hung or broken holder; the next request starts a fresh one. */
  private replace(current: HolderProcess, answer: string) {
    if (this.current === current) this.current = undefined;
    const { child } = current;
    // Still running as far as Node knows, so Node still holds it and its pid is still its own.
    if (child.pid && child.exitCode === null && child.signalCode === null) this.endTree(child.pid);
    current.working?.answer([answer]);
  }
  /** Writes the next request once the holder has answered the one before it. */
  private pump() {
    if (this.current?.working) return;
    const next = this.queue.shift();
    if (!next) {
      for (const idle of this.idlers.splice(0)) idle();
      return;
    }
    const current = this.running();
    let settled = false;
    const timer = setTimeout(() => {
      if (current.working?.id === next.id) this.replace(current, "timeout");
    }, this.requestMs);
    timer.unref?.();
    current.working = {
      id: next.id,
      answer: (words) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (current.working?.id === next.id) current.working = undefined;
        next.resolve(words);
        this.pump();
      },
    };
    current.child.stdin?.write(`${next.verb} ${next.id} ${next.argument}\n`);
  }
  /**
   * Sends `verb id argument` and resolves with the answer's words ("timeout" or "failed" if it failed).
   * `first` puts it ahead of the requests waiting (never ahead of the one being worked on).
   */
  request(verb: string, argument = "", id = String(this.nextRequest++), first = false): Promise<string[]> {
    return new Promise((resolve) => {
      const request = { verb, id, argument, resolve };
      if (first) this.queue.unshift(request);
      else this.queue.push(request);
      this.pump();
    });
  }
  /** A fresh request id, for requests that refer to an earlier one (`kill`, `release`). */
  newId() {
    return String(this.nextRequest++);
  }
  /** Holds a Windows process open (see `HOLDER_SCRIPT`). */
  async hold(pid: number): Promise<HeldProcess> {
    const id = this.newId();
    const [verb, , started] = await this.request("hold", String(Math.trunc(pid)), id);
    const startedAt = verb === "started" ? Number(started) : undefined;
    return {
      startedAt,
      killTree: async () => {
        if (startedAt !== undefined) await this.request("kill", "", id);
      },
      release: () => {
        if (startedAt !== undefined) void this.request("release", "", id);
      },
    };
  }
}

/** The holder for holds and tree kills. */
export const holder = new Holder();
/** The holder for ending console hosts (`windowsConsoles.ts`): its own process, so it never delays or resets `holder`. */
const consoleHolder = new Holder(() => startPowerShell(CONSOLE_HOLDER_SCRIPT), endProcessTree, CONSOLE_REQUEST_MS);

/**
 * Starts both holders ahead of the first kill, where their start stalls nothing time-bound: each
 * blocks the bridge while Windows creates its process, so they start alongside the first terminal.
 */
export function startHolder() {
  if (process.platform !== "win32") return;
  holder.warm();
  consoleHolder.warm();
}

/** Holds a Windows process open through the bridge's holder. */
export const holdWindowsProcess: HoldProcess = (pid) => holder.hold(pid);

/** How far a process's start time, as Windows records it, may fall outside Node's clock readings around `pty.spawn`. */
const SPAWN_CLOCK_SLACK_MS = 1000;

/**
 * Whether the held process is the shell. The shell started during `pty.spawn` (node-pty creates it
 * there), so a process with the same pid that started outside that window took the pid after the
 * shell exited. The pid stays held from this check through `taskkill`, so it can't change hands in
 * between. What remains: a process that took the pid within `SPAWN_CLOCK_SLACK_MS` of the spawn
 * (the shell would have had to exit that fast) passes, and `taskkill /T` finds the shell's
 * descendants by parent pid at the moment it runs.
 */
export function isShell(held: HeldProcess, shell: ShellIdentity) {
  const { startedAt } = held;
  return (
    startedAt !== undefined &&
    startedAt >= shell.spawnStarted - SPAWN_CLOCK_SLACK_MS &&
    startedAt <= shell.spawnEnded + SPAWN_CLOCK_SLACK_MS
  );
}

/** A shell's pid, and the times just before and after `pty.spawn` started it (ms since 1970). */
export interface ShellIdentity {
  pid: number;
  spawnStarted: number;
  spawnEnded: number;
}

/** How long a kill waits for its holder to answer, and for its tree kill to finish. */
export const TREE_KILL_WAIT_MS = 5000;
/** How long a kill waits for node-pty to report the exit of the shell it ended. */
export const EXIT_REPORT_WAIT_MS = 2000;

/**
 * Lets one terminal kill at a time end a shell, and holds off spawns and resizes meanwhile.
 * node-pty 1.1.0 keeps its Windows terminals in one global list that each terminal's exit thread
 * changes without a lock, while spawns, resizes and kills read and grow it on the main thread
 * (`src/win/conpty.cc`; microsoft/node-pty#921, fixed in #922 and 1.2.0-beta.18, not in 1.1.0).
 * A shell exiting during one of those, or two exiting at once, can crash the process with an
 * access violation. On sthopc01 under NETWORK SERVICE the bridge tests crashed that way just after
 * the next terminal started while a stopped terminal's tree kill, a second behind the stop, was
 * ending its shell. The bridge can't time exits it doesn't cause, but it times the ones it causes:
 * each kill runs here from the moment it ends a shell until node-pty reports that exit, which
 * comes after the exit thread is done with the list. A waiting kill can be moved to the front
 * (`promote`, for a profile's cleanup); it still never runs alongside the kill in progress.
 */
export class PtyGate {
  private waiting: { run: () => Promise<void>; done: () => void }[] = [];
  private running = false;
  private idlers: (() => void)[] = [];
  /** Queues `task` after the ones waiting; `done` settles, never rejecting, once it has run. */
  enter(task: () => Promise<void>): { done: Promise<void>; promote(): void } {
    let entry!: { run: () => Promise<void>; done: () => void };
    const done = new Promise<void>((resolve) => (entry = { run: task, done: resolve }));
    this.waiting.push(entry);
    void Promise.resolve().then(() => this.drain());
    const promote = () => {
      const at = this.waiting.indexOf(entry);
      if (at > 0) this.waiting.unshift(...this.waiting.splice(at, 1));
    };
    return { done, promote };
  }
  /** Runs `task` after every task before it; never rejects. */
  exclusive(task: () => Promise<void>): Promise<void> {
    return this.enter(task).done;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
      try {
        await next.run();
      } catch {
        // A kill's failure is its own; the next one still runs.
      }
      next.done();
    }
    this.running = false;
    for (const idle of this.idlers.splice(0)) idle();
  }
  get busy() {
    return this.running || this.waiting.length > 0;
  }
  /** Resolves once no kill is running or waiting. */
  idle(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.idlers.push(resolve)) : Promise.resolve();
  }
}
export const ptyGate = new PtyGate();

/** Resolves with `promise`'s value, or with undefined after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Holds the pid, giving up after `TREE_KILL_WAIT_MS` or once `giveUp` settles; a holder that
 * answers after that is let go.
 */
function holdWithin(hold: HoldProcess, pid: number, giveUp: Promise<void>): Promise<HeldProcess | undefined> {
  return new Promise((resolve) => {
    let late = false;
    const stop = () => {
      late = true;
      resolve(undefined);
    };
    const timer = setTimeout(stop, TREE_KILL_WAIT_MS);
    timer.unref();
    void giveUp.then(() => {
      clearTimeout(timer);
      stop();
    });
    hold(pid).then(
      (held) => {
        if (late) held.release();
        else {
          clearTimeout(timer);
          resolve(held);
        }
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** node-pty's Windows terminal, as far as `killWithoutWaitingForOutput` uses it. */
interface QueuingTerminal {
  _isReady?: unknown;
  _deferreds?: unknown;
  /** The connection to the terminal's output, which says `ready_datapipe` once it's connected. */
  _socket?: { pending?: boolean; destroyed?: boolean; once?: (event: string, listener: () => void) => unknown };
}

/**
 * Runs `kill` (node-pty's `kill()`) without waiting for the terminal's first output. node-pty's
 * Windows terminal queues `kill()`, writes and resizes until its first output (`_isReady`,
 * `lib/windowsTerminal.js` in 1.1.0, unchanged in 1.2.0-beta.18). On Windows 11 build 22000, ConPTY
 * sends nothing for a shell started from a service account (NETWORK SERVICE, as the Actions runner
 * on sthopc01) until the program prints, so a silent program was never killed and never reported
 * its exit (#61); newer builds send a mode request at once. Killing before node-pty has connected to
 * the terminal's output throws "stream.push() after EOF" later, so the kill still waits for that
 * connection, which comes whether or not the program prints. The writes and resizes still queued
 * are dropped: the terminal is closing. A node-pty without this queue is killed as usual.
 */
export function killWithoutWaitingForOutput(terminal: object, kill: () => void) {
  const queuing = terminal as QueuingTerminal;
  const socket = queuing._socket;
  if (queuing._isReady !== false || !Array.isArray(queuing._deferreds) || typeof socket?.once !== "function") {
    kill();
    return;
  }
  const killNow = () => {
    if (queuing._isReady === false) {
      queuing._deferreds = [];
      queuing._isReady = true;
    }
    kill();
  };
  if (socket.pending && !socket.destroyed) socket.once("ready_datapipe", killNow);
  else killNow();
}

/** Whether node-pty has heard from Windows that the shell exited; its `onExit` comes 1 s or more later. */
function shellExited(terminal: object) {
  const agent = (terminal as { _agent?: { exitCode?: unknown } })._agent;
  return agent !== undefined && agent.exitCode !== undefined;
}

/** Resolves when node-pty reports the shell's exit: from Windows (`_$onProcessExit`), or `onExit`. */
function exitReported(terminal: TerminalProcess) {
  return new Promise<void>((reported) => {
    terminal.onExit(() => reported());
    const agent = (terminal as unknown as { _agent?: { _$onProcessExit?: (code: number) => void } })._agent;
    const report = agent?._$onProcessExit;
    if (!agent || typeof report !== "function") return;
    agent._$onProcessExit = function (this: unknown, code: number) {
      report.call(this, code);
      reported();
    };
  });
}

/**
 * A Windows terminal whose `kill()` first ends the shell's process tree. node-pty's own `kill()`
 * closes the console, which ends the processes attached to it, and kills the ones its console-list
 * helper finds; a process with no console (started detached, as a tool may start a dev server)
 * is neither, and kept running (#43). `taskkill /T` follows parent links, so it has to run while
 * the shell is alive: after node-pty's `kill()` the shell is already gone.
 *
 * The tree kill reaches only the shell itself (`holdWindowsProcess`, `isShell`): node-pty closes the
 * shell's handle when the shell exits but reports the exit a second or more later, and by then
 * Windows may have given the pid to another process. The holder starts at once, alongside other
 * terminals'; once it answers, the tree kill, node-pty's `kill()` (without waiting for output, #61)
 * and the wait for the exit report run in `gate` (see `PtyGate`). `killNow()` stops waiting for the
 * holder, so node-pty's `kill()` runs as soon as the gate allows. node-pty's `kill()` runs once: a
 * second one would close the same console again. The returned promise settles, never rejecting,
 * when the terminal's turn in the gate is over.
 *
 * node-pty can't close a console once its shell has exited (microsoft/node-pty#965, open, with no
 * fix in 1.1.0 or 1.2.0-beta.18): every terminal whose program exits on its own, and every stop
 * whose tree kill ends the shell before node-pty's `kill()`, left its `conhost.exe` running until
 * the bridge exited (20 of 20 stops and 10 of 10 exits on sthopc20, #66). So when node-pty reports
 * the exit, the terminal goes to `afterExit` (for `nodePtyHost`, `ConsoleCleanup` in
 * `windowsConsoles.ts`), saying whether the bridge was stopping it, and that ends its console host
 * once nothing is attached to it.
 */
export function withTreeKill(
  terminal: TerminalProcess,
  shell: ShellIdentity,
  {
    hold = holdWindowsProcess,
    gate = ptyGate,
    afterExit = () => {},
  }: { hold?: HoldProcess; gate?: PtyGate; afterExit?: (stopped: boolean) => void } = {},
): TerminalProcess {
  let exited = false;
  let killing: Promise<void> | undefined;
  let hurry = () => {};
  const hurried = new Promise<void>((done) => (hurry = done));
  // Set by killNow(): the kill skips waiting for the holder and goes to the front of the gate.
  let urgent = false;
  let promote = () => {};
  terminal.onExit(() => {
    if (exited) return;
    exited = true;
    // Stopped: the room or the bridge asked for this exit, so programs still attached to the console
    // are the terminal's to end too. node-pty's exit thread has taken the terminal off its list
    // before reporting the exit, so ending its console host changes nothing there.
    afterExit(killing !== undefined);
  });
  const reported = exitReported(terminal);
  return {
    write: (data) => terminal.write(data),
    resize: (columns, rows) => {
      if (!gate.busy) return terminal.resize(columns, rows);
      void gate.idle().then(() => {
        try {
          terminal.resize(columns, rows);
        } catch {
          // The terminal exited meanwhile.
        }
      });
    },
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) => terminal.onExit(listener),
    kill: (signal) => kill(signal),
    killNow: () => {
      const killed = kill();
      urgent = true;
      hurry();
      promote();
      return killed;
    },
  };
  function kill(signal?: string) {
    if (killing) return killing;
    const ptyKill = () => {
      try {
        killWithoutWaitingForOutput(terminal, () => terminal.kill(signal));
      } catch {
        // Nobody awaits this to handle it; node-pty throws here only for a signal, which Windows lacks.
      }
    };
    const ended = () => exited || shellExited(terminal);
    // The holder starts at once and is awaited outside the gate: until it answers, nothing changes
    // node-pty's list, so spawns and other kills needn't wait for it.
    const holding = ended() ? Promise.resolve(undefined) : holdWithin(hold, shell.pid, hurried);
    killing = holding.then((held) => {
      const turn = gate.enter(async () => {
        if (held && !ended() && isShell(held, shell)) {
          await within(held.killTree(), TREE_KILL_WAIT_MS);
          await within(reported, EXIT_REPORT_WAIT_MS);
        } else held?.release();
        const wasRunning = !ended();
        ptyKill();
        // node-pty's kill() ends a shell the tree kill didn't; that exit is this turn's too.
        if (wasRunning) await within(reported, EXIT_REPORT_WAIT_MS);
      });
      promote = turn.promote;
      if (urgent) promote();
      return turn.done;
    });
    return killing;
  }
}

/**
 * Ends Windows terminals' leftover console hosts (#66), one at a time, each step only while no kill
 * is running and the shell holder is idle.
 */
export const consoleCleanup = new ConsoleCleanup({
  request: (verb, argument, id, first) => consoleHolder.request(verb, argument, id, first),
  newId: () => consoleHolder.newId(),
  turn: async () => {
    await ptyGate.idle();
    await holder.whenIdle();
  },
  bridgePid: process.pid,
});

export const nodePtyHost: TerminalHost = {
  spawn(command, args, options) {
    ensureSpawnHelper();
    // node-pty's spawn already blocks for a moment on Windows; the holders' first start goes with it.
    startHolder();
    const spawnStarted = Date.now();
    const terminal = pty.spawn(command, args, options);
    const spawnEnded = Date.now();
    if (process.platform !== "win32") return terminal;
    const shell = { pid: terminal.pid, spawnStarted, spawnEnded };
    consoleCleanup.spawned(shell);
    return withTreeKill(terminal, shell, { afterExit: (stopped) => void consoleCleanup.afterExit(shell, { stopped }) });
  },
  // A spawn changes node-pty's list of terminals, so it waits for kills that are ending a shell.
  whenIdle: () => (process.platform === "win32" ? ptyGate.idle() : Promise.resolve()),
  isIdle: () => process.platform !== "win32" || !ptyGate.busy,
};
