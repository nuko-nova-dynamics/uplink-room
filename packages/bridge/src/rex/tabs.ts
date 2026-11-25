import { homedir } from "node:os";
import type { Socket } from "node:net";
import type { BridgeMessage, RexTab } from "@uplink-room/protocol";
import { expandHome } from "../platform.ts";
import type { TerminalProcess } from "../terminal.ts";
import type { BridgeToHost, HostEvent, HostHello } from "./host.ts";
import { RexError, rexJson } from "./rexCli.ts";

/**
 * Rex tabs on this machine (ADR 0019). A tab whose program runs through `uplink-bridge rex-host`
 * connects to the bridge; the bridge can share it like any terminal, and opens one for a run the
 * room starts "In Rex". Every Rex call goes through Rex's CLI, with `--autostart=false`.
 */

/** The Rex session the bridge opens the room's runs in, made when it's missing. */
export const ROOM_SESSION = "Uplink Room";
/** How often the bridge looks at Rex's sessions, for the tabs' labels and whether Rex runs. */
const DISCOVERY_MS = 30_000;
/** How long a run the room starts in Rex waits for its tab's host to connect. */
const OPEN_WAIT_MS = 20_000;
/** Rex keeps labels to 128 characters. */
const LABEL_MAX = 128;
/** The most output a host's link holds for a share that hasn't subscribed yet, in characters. */
const PENDING_MAX = 1024 * 1024;

/** Why a Rex tab didn't start or share, reported to the room as `terminal_start_failed`. */
export class RexTabError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** A local `share-rex` or `unshare-rex` the bridge refused, with a reason the CLI prints as is. */
export class RexRequestError extends Error {}

/** One `rex-host` connected to the bridge. */
export class HostLink {
  hello: HostHello;
  cols: number;
  rows: number;
  /** Set when the host's program exited; its code, and whether the tab closed first. */
  ended?: { exitCode: number; closed: boolean };
  private socket: Socket;
  private outputs = new Set<(data: string) => void>();
  /**
   * Output that came before anyone listened: a run the room started streams from its first byte,
   * before the share subscribes. Kept up to PENDING_MAX characters, the newest.
   */
  private pending = "";
  private sizes = new Set<(cols: number, rows: number) => void>();
  private exits = new Set<(ended: { exitCode: number; closed: boolean }) => void>();
  constructor(socket: Socket, hello: HostHello, rest: string) {
    this.socket = socket;
    this.hello = hello;
    this.cols = hello.cols;
    this.rows = hello.rows;
    let buffer = rest;
    const take = () => {
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let event: HostEvent;
        try {
          event = JSON.parse(line) as HostEvent;
        } catch {
          continue;
        }
        this.receive(event);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // A host never sends a line this long; a client that does isn't one.
      if (buffer.length > 8 * 1024 * 1024) socket.destroy();
      else take();
    });
    // A host that goes away without saying its program exited took the program with it (it was killed).
    socket.on("close", () => this.finish({ exitCode: 129, closed: true }));
    take();
  }
  get tabRef() {
    return this.hello.block;
  }
  get sessionRef() {
    return this.hello.session;
  }
  private receive(event: HostEvent) {
    if (event.type === "output" && typeof event.data === "string") {
      if (this.outputs.size === 0) {
        this.pending += event.data;
        if (this.pending.length > PENDING_MAX) this.pending = this.pending.slice(-PENDING_MAX).toWellFormed();
      } else for (const f of this.outputs) f(event.data);
    }
    if (event.type === "size" && Number.isFinite(event.cols) && Number.isFinite(event.rows)) {
      this.cols = event.cols;
      this.rows = event.rows;
      for (const f of this.sizes) f(event.cols, event.rows);
    }
    if (event.type === "exit") this.finish({ exitCode: Number(event.exitCode) || 0, closed: event.closed === true });
  }
  private finish(ended: { exitCode: number; closed: boolean }) {
    if (this.ended) return;
    this.ended = ended;
    for (const f of this.exits) f(ended);
  }
  send(message: BridgeToHost) {
    if (!this.socket.destroyed) this.socket.write(JSON.stringify(message) + "\n");
  }
  onOutput(listener: (data: string) => void) {
    // What came before anyone listened goes first, in order.
    if (this.pending) {
      const held = this.pending;
      this.pending = "";
      listener(held);
    }
    this.outputs.add(listener);
    return { dispose: () => void this.outputs.delete(listener) };
  }
  onSize(listener: (cols: number, rows: number) => void) {
    this.sizes.add(listener);
    return { dispose: () => void this.sizes.delete(listener) };
  }
  onEnded(listener: (ended: { exitCode: number; closed: boolean }) => void) {
    if (this.ended) listener(this.ended);
    else this.exits.add(listener);
    return { dispose: () => void this.exits.delete(listener) };
  }
  close() {
    this.socket.destroy();
  }
}

export interface RexTabsOptions {
  /** The Rex CLI, or undefined when this machine has none. */
  executable: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The words that start this bridge's CLI (`bridgeCommand`). */
  bridgeCommand: () => string[];
  socketPath: () => string | undefined;
  emit: (message: BridgeMessage) => void;
  pollMs?: number;
  openWaitMs?: number;
}

/** A host's tab with its labels from Rex, and the terminal that shares it, if one does. */
interface Labels {
  session: string;
  title: string;
}

export class RexTabs {
  /** Connected hosts, by tab (Rex's block id). */
  readonly hosts = new Map<string, HostLink>();
  /** Whether a Rex server answered the last look. */
  running = false;
  private options: RexTabsOptions;
  private labels = new Map<string, Labels>();
  private otherTabs = 0;
  private sessionIds = new Map<string, string>();
  private waiting = new Map<string, (host: HostLink) => void>();
  private reporting = false;
  private last?: string;
  private timer?: ReturnType<typeof setInterval>;
  private refresh?: ReturnType<typeof setTimeout>;
  private looking?: Promise<void>;
  private closed = false;
  /** Which terminal shares each tab: tab → terminal ref. Set by the bridge. */
  readonly sharedAs = new Map<string, string>();
  constructor(options: RexTabsOptions) {
    this.options = options;
  }
  /** Whether this machine can open and share Rex tabs: Rex's CLI is here, and it isn't Windows. */
  available() {
    return (this.options.platform ?? process.platform) !== "win32" && this.options.executable !== undefined;
  }
  private get env() {
    return this.options.env ?? process.env;
  }
  private rex(args: string[], timeoutMs?: number) {
    return rexJson(this.options.executable!, args, this.env, timeoutMs);
  }
  start() {
    if (!this.available()) return;
    void this.look();
    this.timer = setInterval(() => void this.look(), this.options.pollMs ?? DISCOVERY_MS);
    this.timer.unref();
  }
  /** The room takes `rex_found` (its `room_features` list `rex`): report now, and on every change. */
  enableReports() {
    if (this.reporting || !this.available()) return;
    this.reporting = true;
    this.report();
  }
  /** A host connected. A run the room started in Rex gets its tab now. */
  attach(socket: Socket, hello: HostHello, rest: string): HostLink {
    const host = new HostLink(socket, hello, rest);
    const previous = this.hosts.get(host.tabRef);
    this.hosts.set(host.tabRef, host);
    previous?.close();
    host.onEnded(() => {
      if (this.hosts.get(host.tabRef) === host) this.hosts.delete(host.tabRef);
      this.soon();
    });
    if (hello.terminalId) {
      this.waiting.get(hello.terminalId)?.(host);
      this.waiting.delete(hello.terminalId);
    }
    this.soon();
    return host;
  }
  /** Looks at Rex again shortly, after a host came or went. */
  private soon() {
    if (this.closed) return;
    clearTimeout(this.refresh);
    this.refresh = setTimeout(() => void this.look(), 200);
    this.refresh.unref();
  }
  /** Finds a connected host by its tab id, the end of it (at least four characters), or its label. */
  find(target: string): HostLink | undefined {
    const exact = this.hosts.get(target);
    if (exact) return exact;
    const lower = target.toLowerCase();
    const matches = [...this.hosts.values()].filter(
      (host) =>
        (target.length >= 4 && host.tabRef.endsWith(target)) || this.labels.get(host.tabRef)?.title.toLowerCase() === lower,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  /** The tabs the bridge can share, as the room sees them. */
  list(): RexTab[] {
    return [...this.hosts.values()]
      .filter((host) => !host.ended)
      .map((host) => {
        const labels = this.labels.get(host.tabRef);
        const shared = this.sharedAs.get(host.tabRef);
        return {
          tabRef: host.tabRef,
          sessionRef: host.sessionRef,
          session: labels?.session ?? "",
          title: labels?.title || host.hello.command,
          command: host.hello.command,
          ...(host.hello.cwd ? { cwd: host.hello.cwd } : {}),
          ...(shared ? { terminalRef: shared } : {}),
        };
      })
      .sort((a, b) => a.session.localeCompare(b.session) || a.title.localeCompare(b.title));
  }
  /** Sends `rex_found` when what the room would see changed. */
  report() {
    if (!this.reporting || this.closed) return;
    const message: BridgeMessage = {
      v: 1,
      type: "rex_found",
      running: this.running,
      tabs: this.list(),
      otherTabs: this.otherTabs,
    };
    const text = JSON.stringify(message);
    if (text === this.last) return;
    this.last = text;
    this.options.emit(message);
  }
  /**
   * Looks at Rex's sessions: whether Rex runs, each hosted tab's session and tab labels, and how many
   * other terminal tabs there are. Only labels and counts are read, never what a tab shows.
   */
  look(): Promise<void> {
    if (!this.available() || this.closed) return Promise.resolve();
    this.looking ??= (async () => {
      try {
        const listed = (await this.rex(["ls", "--json"])) as { sessions?: { session_id: string; label?: string }[] };
        const sessions = (listed?.sessions ?? []).slice(0, 64);
        const labels = new Map<string, Labels>();
        const ids = new Map<string, string>();
        let others = 0;
        for (const session of sessions) {
          ids.set((session.label ?? "").toLowerCase(), session.session_id);
          let view: { windows?: RexWindow[] };
          try {
            view = (await this.rex(["window", "ls", "-s", session.session_id, "--json"])) as { windows?: RexWindow[] };
          } catch {
            continue;
          }
          for (const window of view?.windows ?? []) {
            const blocks = (window.layers ?? []).flatMap((layer) => layer.blocks ?? []);
            const terminals = blocks.filter((block) => block.creator_name === "com.superlogical.terminal");
            for (const block of terminals) {
              if (!this.hosts.has(block.block_id)) {
                others++;
                continue;
              }
              const tab = window.label ?? "";
              labels.set(block.block_id, {
                session: session.label ?? "",
                title: terminals.length > 1 && block.label ? `${tab} · ${block.label}` : tab,
              });
            }
          }
        }
        this.running = true;
        this.labels = labels;
        this.sessionIds = ids;
        this.otherTabs = others;
      } catch {
        // No Rex server answers (it isn't running, or Rex was removed): nothing to list.
        this.running = false;
        this.labels.clear();
        this.sessionIds.clear();
        this.otherTabs = 0;
      } finally {
        this.looking = undefined;
      }
      this.report();
    })();
    return this.looking;
  }
  /**
   * Opens a Rex tab for a run the room started, in the "Uplink Room" session (made if missing), and
   * waits for its host to connect. The tab doesn't take focus. Throws `RexTabError`.
   */
  async open(request: {
    terminalId: string;
    command?: string;
    cwd?: string;
    title?: string;
    /** A plain shell's one-shot command: run it in the person's own shell setup (`terminalShell`'s `userShell`). */
    userShell?: boolean;
    noColor?: boolean;
  }): Promise<HostLink> {
    if (!this.available()) throw new RexTabError("rex_unavailable", "This machine has no Rex CLI, or Rex tabs aren't offered here.");
    const socket = this.options.socketPath();
    if (!socket) throw new RexTabError("rex_unavailable", "The bridge has no local socket for Rex tabs.");
    await this.look();
    if (!this.running) throw new RexTabError("rex_unavailable", "Rex isn't running on this machine.");
    const title = (request.title?.trim() || "Run").slice(0, LABEL_MAX);
    const cwd = expandHome(request.cwd) ?? homedir();
    const host = [
      ...this.options.bridgeCommand(),
      "rex-host",
      "--terminal",
      request.terminalId,
      "--socket",
      socket,
      ...(request.command !== undefined ? ["--command", request.command] : []),
      ...(request.userShell ? ["--user-shell"] : []),
      ...(request.noColor ? ["--no-color"] : []),
    ];
    const connected = new Promise<HostLink>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(request.terminalId);
        reject(new RexTabError("rex_tab_failed", "The Rex tab didn't connect to the bridge in time."));
      }, this.options.openWaitMs ?? OPEN_WAIT_MS);
      timer.unref();
      this.waiting.set(request.terminalId, (link) => {
        clearTimeout(timer);
        resolve(link);
      });
    });
    void connected.catch(() => {});
    const session = this.sessionIds.get(ROOM_SESSION.toLowerCase());
    let opened: { block_ids?: string[]; window_id?: string; session_id?: string } | null;
    try {
      // `--interactive`: the program finds what the person's own tabs find on PATH (.zshrc's version managers).
      opened = (await (session
        ? this.rex(["window", "new", "-s", session, title, "-c", cwd, "--interactive", "--focus=false", "--json", "--", ...host])
        : this.rex(["new", ROOM_SESSION, "-c", cwd, "--window", title, "--interactive", "--json", "--", ...host]))) as typeof opened;
    } catch (error) {
      this.waiting.delete(request.terminalId);
      throw new RexTabError("rex_tab_failed", error instanceof RexError ? error.message : "Rex couldn't open a tab.");
    }
    try {
      return await connected;
    } catch (error) {
      // Don't leave a tab behind that the room doesn't know about.
      const block = opened?.block_ids?.[0] ?? (opened as { initial_windows?: { block_ids?: string[] }[] } | null)?.initial_windows?.[0]?.block_ids?.[0];
      const sessionRef = session ?? opened?.session_id;
      if (block && sessionRef) await this.rex(["block", "close", "-s", sessionRef, block]).catch(() => {});
      throw error;
    } finally {
      this.soon();
    }
  }
  /** A terminal process backed by a host: output and exit from the tab, input and kills to it, resizes through Rex. */
  process(host: HostLink, options: { ownsProgram: boolean }): TerminalProcess {
    const rex = (args: string[]) => this.rex(args);
    return {
      write: (data: string | Buffer) => host.send({ type: "input", data: data.toString() }),
      // Rex applies a size only when no Rex app owns the tab, so the person's own view in Rex wins.
      resize: (cols: number, rows: number) =>
        void rex([
          "block",
          "call",
          "-s",
          host.sessionRef,
          "-b",
          host.tabRef,
          "resize",
          JSON.stringify({ columns: cols, rows }),
        ]).catch(() => {}),
      onData: (listener: (data: string) => void) => host.onOutput(listener),
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) =>
        host.onEnded(({ exitCode }) => listener({ exitCode })),
      kill: () => {
        // A tab the person opened is never ended from here: unsharing only stops its output.
        if (options.ownsProgram) host.send({ type: "kill" });
        else host.send({ type: "stream", on: false });
      },
    };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.refresh);
    for (const host of this.hosts.values()) host.close();
    this.hosts.clear();
  }
}

interface RexWindow {
  window_id: string;
  label?: string;
  layers?: { blocks?: { block_id: string; label?: string; creator_name?: string }[] }[];
}
