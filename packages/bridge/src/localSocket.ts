import { createConnection, createServer, type Socket } from "node:net";
import { chmod, lstat, rm } from "node:fs/promises";
import type { Bridge } from "./bridge.ts";
import type { MachineLimits } from "@uplink-room/protocol";
import type { HostHello } from "./rex/host.ts";
import { RexRequestError } from "./rex/tabs.ts";
import { LocalRequestError } from "./localErrors.ts";
import { runSayFiles } from "./runFiles.ts";

export class LocalSocket {
  private sockets = new Set<Socket>();
  private server = createServer((socket) => {
    this.sockets.add(socket);
    const abort = new AbortController();
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      abort.abort();
    });
    socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
    let buffer = "";
    let handled = false;
    // A multi-byte character can be split across chunks, so decode as a stream.
    socket.setEncoding("utf8");
    const onData = (data: string) => {
      if (handled) return;
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      let first: { type?: string };
      try {
        first = JSON.parse(buffer.slice(0, end));
      } catch {
        socket.destroy();
        return;
      }
      // A Rex tab's host keeps its connection for as long as its program runs (ADR 0019).
      if (first.type === "rex_host") {
        socket.off("data", onData);
        socket.setTimeout(0);
        this.bridge.rexHost(socket, first as HostHello, buffer.slice(end + 1));
        return;
      }
      void (async () => {
        const request = first as Record<string, any>;
        let result: unknown;
        switch (request.type) {
          case "hook":
            result = await this.bridge.hook(
              request.terminalId,
              request.secret,
              request.event,
              request.payload ?? {},
              abort.signal,
            );
            break;
          // An idle Claude Code session's waiter (ADR 0026) can wait for days: no idle timeout.
          case "inbox-wait":
            socket.setTimeout(0);
            result = await this.bridge.inboxWait(request.terminalId, request.secret, abort.signal, request.event);
            break;
          // A hook's CLI wrote the run's messages it was handed (ADR 0026).
          case "ack":
            result = this.bridge.ack(String(request.terminalId), request.secret, String(request.claimId));
            break;
          // A Codex terminal's hooks (ADR 0038): `uplink-bridge codex-hook`. An approval can wait for its driver.
          case "codex-hook":
            if (request.event === "PermissionRequest") socket.setTimeout(0);
            result = await this.bridge.codexHook(request.terminalId, request.secret, String(request.event ?? ""), request.payload ?? {}, abort.signal);
            break;
          // `uplink-bridge codex` started, or stopped, the terminal's Codex on an app server of its own.
          case "codex-server":
            result = this.bridge.codexServer(request.terminalId, request.secret, request);
            break;
          // A run posting as itself (ADR 0026): `uplink-bridge say` and `reply`, in a terminal by its
          // id and secret, in a T3 Code thread by the run key a delivery gave it (ADR 0037).
          case "say": {
            const files = runSayFiles(request.files);
            const say = {
              text: String(request.text ?? ""),
              ...(typeof request.in === "string" ? { in: request.in } : {}),
              ...(typeof request.replyTo === "string" ? { replyTo: request.replyTo } : {}),
              // Files the run sends with the message (ADR 0047), each as the command read it.
              ...(files.length ? { files } : {}),
            };
            result =
              request.key !== undefined
                ? await this.bridge.threadSay(request.key, request.threadId, say, abort.signal)
                : await this.bridge.say(request.terminalId, request.secret, say, abort.signal);
            break;
          }
          case "share":
            result = {
              localRef: await this.bridge.share({
                command: request.command,
                cwd: request.cwd,
                access: request.access,
              }),
            };
            break;
          case "limits":
            result = await this.bridge.setLimits(request.limits);
            if (this.onLimits) await this.onLimits(request.limits);
            break;
          case "stop-sharing":
            await this.bridge.stopSharing();
            result = {};
            break;
          case "unlink":
            await this.bridge.unlink();
            result = {};
            break;
          case "probe":
            result = {};
            break;
          // The desktop app asks before it restarts itself to install an update.
          case "busy":
            result = { terminals: this.bridge.busyTerminals() };
            break;
          // Settings, Machines on this computer (the desktop app), and `uplink-bridge t3-threads`:
          // this machine's T3 Code threads, and the ones picked to share. Never sent to the room.
          case "t3-threads":
            result = this.bridge.t3Threads();
            break;
          case "t3-share":
            result = await this.bridge.shareT3Threads(request);
            break;
          case "rex-tabs":
            result = { tabs: this.bridge.rexTabList() };
            break;
          case "share-rex":
            result = { localRef: await this.bridge.shareRexTabLocally(request.target, request.access) };
            break;
          case "unshare-rex":
            await this.bridge.unshareRexTabLocally(request.target);
            result = {};
            break;
          default:
            throw new Error("Unknown local bridge command");
        }
        socket.end(JSON.stringify({ result }) + "\n");
      })().catch((error: unknown) =>
        socket.end(
          JSON.stringify({ error: error instanceof RexRequestError || error instanceof LocalRequestError ? error.message : "Local bridge command failed" }) + "\n",
        ),
      );
    };
    socket.on("data", onData);
  });
  private path: string;
  private bridge: Bridge;
  private onLimits?: (limits: MachineLimits) => Promise<void>;
  constructor(path: string, bridge: Bridge, onLimits?: (limits: MachineLimits) => Promise<void>) {
    this.path = path;
    this.bridge = bridge;
    this.onLimits = onLimits;
  }
  async start() {
    const pipe = this.path.startsWith("\\\\.\\pipe\\");
    // A named pipe disappears with the process that made it, so only a Unix socket can be stale.
    if (!pipe) {
      try {
        const stat = await lstat(this.path);
        if (!stat.isSocket()) throw new Error("Bridge socket path is occupied");
        try {
          await localRequest(this.path, { type: "probe" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED")
            throw new Error("A bridge is already running");
          await rm(this.path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await new Promise<void>((resolve, reject) => {
      const fail = (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" ? new Error("A bridge is already running") : error);
      this.server.once("error", fail);
      // Without writableAll, Windows' default pipe security lets only this user,
      // SYSTEM and administrators write to the pipe, so nobody else can send it a request.
      this.server.listen({ path: this.path, readableAll: false, writableAll: false }, () => {
        this.server.off("error", fail);
        resolve();
      });
    });
    if (!pipe) await chmod(this.path, 0o600);
    this.bridge.setSocketPath(this.path);
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening)
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
/** Sends one request to the running bridge. `timeoutMs` 0 waits for as long as the bridge takes. */
export function localRequest(path: string, request: unknown, options: { timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    if (timeoutMs > 0) socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Local bridge request timed out")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("end", () => {
      if (!buffer.includes("\n")) reject(new Error("Bridge closed the request"));
    });
  });
}
/**
 * True when a bridge answers on `path`, so it runs with this config folder. A missing socket or
 * pipe, or a Unix socket file no process listens on, means none does.
 */
export async function bridgeRunning(path: string) {
  try {
    await localRequest(path, { type: "probe" });
    return true;
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    // It answered, but not as this bridge does (an older bridge refuses `probe`), or it failed in
    // some other way: treat it as running rather than write under it.
    return true;
  }
}
