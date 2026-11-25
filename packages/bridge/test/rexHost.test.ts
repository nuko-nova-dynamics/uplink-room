import { afterEach, expect, test } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { runRexHost, tailBytes } from "../src/rex/host.ts";
import { rexHostArgs } from "../src/cli.ts";
import { quoteCommand } from "../src/platform.ts";
import type { TerminalProcess } from "../src/terminal.ts";

// `rex-host` runs inside a Rex tab on macOS and Linux only (ADR 0019).
const skip = process.platform === "win32";

/** The tab's terminal, as `rex-host` sees its own stdout. */
class FakeTab extends Writable {
  isTTY = true;
  columns = 100;
  rows = 30;
  text = "";
  override _write(chunk: Buffer, _encoding: string, done: () => void) {
    this.text += chunk.toString("utf8");
    done();
  }
}

/**
 * A program that prints and exits as soon as it's spawned, before any I/O can happen: the
 * bridge's connection can't have landed yet.
 */
function quickProgram(output: string, exitCode: number, afterMs?: number) {
  return (): TerminalProcess => {
    const data = new Set<(d: string) => void>();
    const exits = new Set<(e: { exitCode: number; signal?: number }) => void>();
    const run = () => {
      for (const f of data) f(output);
      for (const f of exits) f({ exitCode });
    };
    if (afterMs === undefined) queueMicrotask(run);
    else setTimeout(run, afterMs);
    return {
      write() {},
      resize() {},
      kill() {},
      onData: (f) => (data.add(f), { dispose: () => data.delete(f) }),
      onExit: (f) => (exits.add(f), { dispose: () => exits.delete(f) }),
    } as TerminalProcess;
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "uplink-rexhost-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const env = { REX_SESSION: "session:one", REX_BLOCK: "block:one", SHELL: "/bin/sh" };

/** A bridge's end of the local socket, as far as a host sees it: the lines it got. `deaf` never reads. */
async function fakeBridge(options: { deaf?: boolean } = {}) {
  const socketPath = join(await folder(), "bridge.sock");
  const lines: { type: string; [key: string]: unknown }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    // Shares the tab, then stops reading: everything the host sends from here on queues.
    if (options.deaf) {
      socket.write(JSON.stringify({ type: "stream", on: true }) + "\n");
      return socket.pause();
    }
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  // A paused socket never sees its peer close, and the server would wait for it.
  cleanups.push(() => new Promise((resolve) => (sockets.forEach((socket) => socket.destroy()), server.close(() => resolve()))));
  return { socketPath, lines };
}

test.skipIf(skip)("a person's tab whose program prints and exits at once shows the output, and the bridge hears the exit", async () => {
  const socketPath = join(await folder(), "bridge.sock");
  const lines: { type: string; [key: string]: unknown }[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const tab = new FakeTab();

  const code = await runRexHost({ socketPath, env, stdin: new PassThrough() as never, stdout: tab as never, spawn: quickProgram("done in a moment\r\n", 3) });

  expect(code).toBe(3);
  expect(tab.text).toContain("done in a moment");
  await expect.poll(() => lines.map((line) => line.type)).toEqual(["rex_host", "exit"]);
  expect(lines[1]).toEqual({ type: "exit", exitCode: 3 });
});

test.skipIf(skip)("with no bridge running, the tab still shows its program and ends with it", async () => {
  const tab = new FakeTab();
  const code = await runRexHost({
    socketPath: join(await folder(), "nobody.sock"),
    env,
    stdin: new PassThrough() as never,
    stdout: tab as never,
    spawn: quickProgram("no bridge here\r\n", 0),
  });
  expect(code).toBe(0);
  expect(tab.text).toContain("no bridge here");
});

test.skipIf(skip)("a run the room started whose program prints and exits at once delivers its output, then its exit", async () => {
  const bridge = await fakeBridge();
  const code = await runRexHost({
    socketPath: bridge.socketPath,
    terminalId: "run",
    env,
    stdin: new PassThrough() as never,
    stdout: new FakeTab() as never,
    spawn: quickProgram("exported 42 rows\r\n", 0),
  });
  expect(code).toBe(0);
  await expect.poll(() => bridge.lines.map((line) => line.type)).toEqual(["rex_host", "output", "exit"]);
  expect(bridge.lines[1]).toEqual({ type: "output", data: "exported 42 rows\r\n" });
});

test.skipIf(skip)("a bridge that stops reading can't hold a finished tab open", async () => {
  const bridge = await fakeBridge({ deaf: true });
  // A shared tab whose program prints 4 MiB the bridge never reads, then exits.
  const run = runRexHost({
    socketPath: bridge.socketPath,
    env,
    stdin: new PassThrough() as never,
    stdout: new FakeTab() as never,
    spawn: quickProgram("x".repeat(4 * 1024 * 1024), 0, 300),
  });
  const started = Date.now();
  expect(await run).toBe(0);
  // From the exit, the report has 2 seconds in all, then the socket is cut.
  expect(Date.now() - started).toBeLessThan(300 + 3000);
});

test("the tab's kept output is cut on a whole character, never inside an emoji", () => {
  // "ab😀cd": a, b, then the emoji's 4 bytes (F0 9F 98 80), then c, d.
  expect(tailBytes("ab😀cd", 6)).toBe("😀cd");
  // 5 bytes would start inside the emoji: the cut moves past it instead.
  expect(tailBytes("ab😀cd", 5)).toBe("cd");
  expect(tailBytes("ab😀cd", 5).isWellFormed()).toBe(true);
  // Cutting by UTF-16 length, as before, leaves half the pair, which the room refuses.
  expect("ab😀cd".slice(-3).isWellFormed()).toBe(false);
  expect(tailBytes("ab", 6)).toBe("ab");
});

test("rex-host reads only its own options before --: the command's flags stay the command's", () => {
  expect(rexHostArgs(["--socket", "/b.sock", "--", "printf", "%s", "--command", "rm", "--terminal", "t", "--socket", "/x"], "/default")).toEqual({
    socketPath: "/b.sock",
    terminalId: undefined,
    // Every word after -- is the command's, quoted for this platform's shell.
    command: quoteCommand(["printf", "%s", "--command", "rm", "--terminal", "t", "--socket", "/x"]),
    userShell: false,
    noColor: false,
  });
  expect(rexHostArgs(["--terminal", "run", "--no-color", "--command", "claude"], "/default")).toEqual({
    socketPath: "/default",
    terminalId: "run",
    command: "claude",
    userShell: false,
    noColor: true,
  });
});
