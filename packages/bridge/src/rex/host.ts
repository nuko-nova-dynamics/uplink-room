import { connect, type Socket } from "node:net";
import { nodePtyHost, type TerminalProcess } from "../terminal.ts";
import { terminalShell } from "../platform.ts";

/**
 * `uplink-bridge rex-host`: the program a shareable Rex tab runs (ADR 0019). It runs the tab's real
 * program on a pty of its own and passes everything through, so the person uses the tab in Rex as
 * usual: its output goes to the tab, their keys and the tab's size go to the program. It also
 * connects to the bridge over the private local socket, and while the bridge shares the tab it
 * sends the output there and takes the room driver's input.
 *
 * Rex has no documented stream of a tab's output, so this is how the room sees one: the pty is the
 * bridge's, inside the tab, and the tab's program lives exactly as long as the tab.
 */

/** The first line a host sends the bridge. */
export interface HostHello {
  v: 1;
  type: "rex_host";
  /** `REX_SESSION`: the tab's Rex session. */
  session: string;
  /** `REX_BLOCK`: the tab's terminal block in Rex. */
  block: string;
  /** Set when the room started this run in Rex: the terminal it is. */
  terminalId?: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}
/** What a host sends after its hello. `closed`: the tab closed (or Rex quit), which ended the program. */
export type HostEvent =
  | { type: "output"; data: string }
  | { type: "size"; cols: number; rows: number }
  | { type: "exit"; exitCode: number; closed?: boolean };
/** What the bridge sends a host. `stream`: send output while on. `kill`: end the program. */
export type BridgeToHost =
  | { type: "stream"; on: boolean }
  | { type: "input"; data: string }
  | { type: "kill" };

/** Output a host keeps for a share that starts later, so the room sees what is on screen. */
const REPLAY_BYTES = 256 * 1024;
/** How often a host the bridge isn't listening for tries again. */
const RECONNECT_MS = 5000;
/**
 * How long a host whose program exited may take to tell the bridge: a connection in progress, the
 * output still queued and the exit. Past it the socket is cut, so a bridge that stopped reading can't
 * hold the tab open.
 */
const EXIT_REPORT_WAIT_MS = 2000;

/**
 * The end of `text` that fits in `maxBytes` of UTF-8, starting on a whole character: cutting a
 * string by UTF-16 length can split a surrogate pair (an emoji), which the room refuses.
 */
export function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  // UTF-8 continuation bytes are 10xxxxxx: step past them to the next character's first byte.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** Environment variables a hosted program must not inherit from wherever the host started. */
const NOT_INHERITED = ["UPLINK_TERMINAL_REF", "UPLINK_TERMINAL_SECRET", "UPLINK_BRIDGE_SOCKET", "ELECTRON_RUN_AS_NODE"];

export interface RexHostOptions {
  socketPath: string;
  /** For a run the room started in Rex: the bridge waits for this terminal, and the host ends with the bridge. */
  terminalId?: string;
  /** The command line to run; absent, the person's shell. */
  command?: string;
  /**
   * A plain shell's one-shot command (`runs.start` with harness `shell`): run it in the person's own
   * shell as a login and interactive one, as the bridge runs it in a plain terminal (`terminalShell`).
   */
  userShell?: boolean;
  /** Run it without colors (NO_COLOR=1, no FORCE_COLOR), as the bridge runs a shell an agent reads as text. */
  noColor?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  spawn?: (file: string, args: string[] | string, options: Parameters<typeof nodePtyHost.spawn>[2]) => TerminalProcess;
}

/** Runs the host until its program exits. Resolves with the exit code to leave with. */
export async function runRexHost(options: RexHostOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (process.platform === "win32") throw new Error("Rex tabs are shared on macOS and Linux only.");
  if (!env.REX_SESSION || !env.REX_BLOCK)
    throw new Error("rex-host runs inside a Rex tab, and REX_SESSION and REX_BLOCK aren't set here.");
  if (!stdout.isTTY) throw new Error("rex-host runs in a terminal tab.");
  const roomStarted = options.terminalId !== undefined;
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const childEnv: NodeJS.ProcessEnv = { ...env, TERM: "xterm-256color" };
  for (const name of NOT_INHERITED) delete childEnv[name];
  if (options.noColor) {
    childEnv.NO_COLOR = "1";
    delete childEnv.FORCE_COLOR;
  }
  const shell = terminalShell(options.command, childEnv, process.platform, { userShell: options.userShell });
  const hello = (): HostHello => ({
    v: 1,
    type: "rex_host",
    session: env.REX_SESSION!,
    block: env.REX_BLOCK!,
    ...(options.terminalId ? { terminalId: options.terminalId } : {}),
    command: shell.label,
    cwd: process.cwd(),
    ...size(),
  });

  let socket: Socket | undefined;
  // A run the room started streams from its first byte: the bridge holds that output until the share
  // takes it, so a program that prints and exits at once still shows. A person's tab streams only
  // while shared.
  let streaming = roomStarted;
  let exited = false;
  let closed = false;
  let replay = "";
  let child: TerminalProcess | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** The connection attempt in progress, if any: it settles true once the bridge has the hello. */
  let connecting: Promise<boolean> | undefined;
  const send = (event: HostEvent | HostHello) => {
    if (socket && !socket.destroyed) socket.write(JSON.stringify(event) + "\n");
  };
  const closeTab = () => {
    // The tab is gone (closed in Rex, or Rex quit): end the program the way closing a terminal does.
    if (closed || exited) return;
    closed = true;
    child?.kill("SIGHUP");
  };
  const handle = (message: BridgeToHost) => {
    if (message.type === "stream") {
      const starting = message.on && !streaming;
      streaming = message.on;
      if (starting && replay) {
        // What the tab showed lately, from a line start, then a resize so a full-screen program draws its screen again.
        const recent = tailBytes(replay, REPLAY_BYTES);
        const cut = recent === replay ? -1 : recent.indexOf("\n");
        send({ type: "output", data: cut >= 0 ? recent.slice(cut + 1) : recent });
        const { cols, rows } = size();
        if (cols > 2) {
          child?.resize(cols - 1, rows);
          setTimeout(() => !exited && child?.resize(size().cols, size().rows), 50).unref();
        }
      }
    }
    if (message.type === "input") child?.write(message.data);
    if (message.type === "kill") child?.kill("SIGHUP");
  };
  const connectBridge = () =>
    new Promise<boolean>((resolve) => {
      const s = connect(options.socketPath);
      let buffer = "";
      let ready = false;
      s.setEncoding("utf8");
      s.on("connect", () => {
        ready = true;
        socket = s;
        s.write(JSON.stringify(hello()) + "\n");
        resolve(true);
      });
      s.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            handle(JSON.parse(line) as BridgeToHost);
          } catch {}
        }
      });
      s.on("error", () => {});
      s.on("close", () => {
        if (!ready) return resolve(false);
        if (socket === s) socket = undefined;
        streaming = false;
        if (exited) return;
        // A run the room started ends with the bridge, like any terminal the room starts. A tab the
        // person opened keeps going, and is offered to the bridge again once it's back.
        if (roomStarted) child?.kill("SIGHUP");
        else scheduleRetry();
      });
    });
  /** Connects in the background, trying again every RECONNECT_MS until the bridge answers. */
  const attempt = () => {
    connecting = connectBridge().then((ok) => {
      connecting = undefined;
      if (!ok && !exited) scheduleRetry();
      return ok;
    });
  };
  const scheduleRetry = () => {
    clearTimeout(retry);
    retry = setTimeout(() => {
      if (!exited) attempt();
    }, RECONNECT_MS);
    retry.unref();
  };

  // The room waits for this terminal, so it needs the bridge from the start. A person's tab works without one.
  if (roomStarted && !(await connectBridge())) {
    stdout.write("Uplink Room's bridge isn't running on this machine, so this run can't start.\r\n");
    return 1;
  }
  const { cols, rows } = size();
  const program = (options.spawn ?? nodePtyHost.spawn)(shell.file, shell.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: childEnv,
  });
  child = program;
  // Before anything can yield: a program that prints and exits at once must lose neither. Until a
  // share starts, its output is kept only in `replay` (bounded), which the bridge gets with the share.
  program.onData((data) => {
    if (!closed) stdout.write(data);
    replay += data;
    if (replay.length > REPLAY_BYTES && Buffer.byteLength(replay) > REPLAY_BYTES * 2) replay = tailBytes(replay, REPLAY_BYTES);
    if (streaming) send({ type: "output", data });
  });
  const ended = new Promise<number>((resolve) =>
    program.onExit(({ exitCode, signal }) => {
      exited = true;
      clearTimeout(retry);
      resolve(signal ? 128 + signal : exitCode);
    }),
  );
  // A person's tab works with or without a bridge: it connects in the background.
  if (!roomStarted) attempt();

  const raw = stdin.isTTY;
  if (raw) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (data: string) => child?.write(data));
  stdin.on("error", closeTab);
  stdin.on("end", closeTab);
  stdin.resume();
  stdout.on("error", closeTab);
  const onResize = () => {
    const now = size();
    child?.resize(now.cols, now.rows);
    send({ type: "size", ...now });
  };
  stdout.on("resize", onResize);
  process.on("SIGHUP", closeTab);
  const onTerm = () => child?.kill("SIGTERM");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);

  const code = await ended;
  stdout.off("resize", onResize);
  process.off("SIGHUP", closeTab);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
  if (raw && !closed) {
    try {
      stdin.setRawMode(false);
    } catch {}
  }
  stdin.pause();
  // The bridge hears the exit after any output still queued, once a connection in progress lands. One
  // deadline covers all of it: a bridge that never connects, or stopped reading, doesn't hold the tab
  // open, which ends with its program as any terminal does.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (async () => {
      if (connecting) await connecting;
      send({ type: "exit", exitCode: code, ...(closed ? { closed: true } : {}) });
      const open = socket;
      if (open && !open.destroyed) await new Promise<void>((resolve) => open.end(() => resolve()));
    })(),
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, EXIT_REPORT_WAIT_MS);
    }),
  ]);
  clearTimeout(deadline);
  socket?.destroy();
  return code;
}
