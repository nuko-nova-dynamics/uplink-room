/**
 * A client of a Hermes Agent gateway (ADR 0040). From v0.23.0 `hermes` runs no agent in the terminal:
 * the classic CLI attaches to its profile's gateway, which runs every session of the profile, and any
 * client attached to a session sees its events and may steer it or submit to it (Hermes docs,
 * developer-guide/programmatic-integration.md, "TUI Gateway JSON-RPC"; gateway-local-sessions.md).
 *
 * A local client gets in the way Hermes's own CLI does (`hermes_cli/gateway_client.py`): it asks the
 * gateway's control socket, which only its OS user can reach, who the gateway is (`identify`) and for
 * a one-use ticket (`session-ticket`), then opens the gateway's loopback WebSocket with the subprotocol
 * `hermes-gateway-v1` beside the ticket, and speaks JSON-RPC there. The bridge never starts a gateway:
 * the terminal's `hermes` does, and the bridge attaches once it runs.
 */
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { targetFlag } from "./adapters/process.ts";

export const HERMES_GATEWAY_PROTOCOL = "hermes-gateway-v1";
const TICKET_PREFIX = "hermes-gateway-ticket.";

/** The gateway refused a call: it did nothing. `reason` is its own (`not_found`, `stale_generation`, …). */
export class HermesRefusal extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** A call went out and no answer came (the connection closed, or it timed out): it may have been done. */
export class HermesNoAnswer extends Error {}

export interface HermesConnection {
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  close(): void;
}

/** What a session event carries (`{type, session_id, execution_generation, payload}`). */
export interface HermesEvent {
  type: string;
  session_id?: string;
  execution_generation?: number;
  payload?: Record<string, unknown>;
}

export interface HermesEvents {
  onEvent(event: HermesEvent): void;
  onClose(): void;
}

/**
 * The Hermes home a terminal's `hermes` uses, as Hermes picks it: `HERMES_HOME`, else the profile its
 * command names (`-p`, `--profile`), else the sticky `active_profile` in `~/.hermes`, else `~/.hermes`.
 */
export function hermesHome(env: NodeJS.ProcessEnv, command: string, home = homedir()): string {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  const root = join(home, ".hermes");
  let profile = targetFlag(command, "-p") ?? targetFlag(command, "--profile");
  if (profile === undefined) {
    try {
      profile = readFileSync(join(root, "active_profile"), "utf8").trim();
    } catch {
      // No sticky profile.
    }
  }
  return profile && profile !== "default" ? join(root, "profiles", profile) : root;
}

/**
 * The breadcrumb in which Hermes's classic CLI records the session a terminal runs, named after the
 * terminal's tty as `hermes_cli/terminal_breadcrumbs.py` names it: `/dev/ttys004` → `tty-dev-ttys004`.
 */
export function breadcrumbFile(home: string, tty: string): string {
  const name = tty.trim().replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  return join(home, "terminal-sessions", `tty-${name}`);
}

/** The session a breadcrumb names, or nothing when there is none yet. */
export async function readBreadcrumb(file: string): Promise<string | undefined> {
  try {
    const crumb = JSON.parse(await readFile(file, "utf8")) as { session_id?: unknown };
    return typeof crumb.session_id === "string" && crumb.session_id.trim() ? crumb.session_id.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gateway's control socket: `gateway.sock` in the home, or where `gateway.sock.path` points when
 * the home is too deep for a socket path. Only one this OS user owns: Node can't ask a Unix socket's
 * peer who it is, so the owner of the socket file (and of the pointer) is the check.
 */
async function controlSocket(home: string): Promise<string> {
  const uid = process.getuid?.();
  const owned = async (path: string) => {
    const stat = await lstat(path);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} isn't this user's.`);
    return stat;
  };
  const direct = join(home, "gateway.sock");
  try {
    if ((await owned(direct)).isSocket()) return direct;
  } catch {
    // No socket here: the pointer says where.
  }
  const pointer = join(home, "gateway.sock.path");
  const stat = await owned(pointer);
  if (!stat.isFile() || stat.mode & 0o077) throw new Error(`${pointer} is open to others.`);
  const target = (await readFile(pointer, "utf8")).trim();
  if (!isAbsolute(target) || !target.endsWith("/control.sock")) throw new Error(`${pointer} doesn't name a control socket.`);
  if (!(await owned(target)).isSocket()) throw new Error(`${target} isn't a socket.`);
  return target;
}

/** One request line to the control socket, and its answer's `result`. */
function control(socket: string, request: object, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(socket);
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error("Hermes's gateway didn't answer."));
    }, timeoutMs);
    let data = "";
    peer.setEncoding("utf8");
    peer.on("connect", () => peer.write(JSON.stringify({ protocol: 1, id: 1, ...request }) + "\n"));
    peer.on("data", (chunk) => {
      data += chunk;
      if (data.length > 524_288) peer.destroy(new Error("Hermes's gateway answered too much."));
      if (!data.includes("\n")) return;
      clearTimeout(timer);
      peer.end();
      try {
        const answer = JSON.parse(data.slice(0, data.indexOf("\n")));
        if (answer?.ok !== true || typeof answer.result !== "object") reject(new Error(`Hermes's gateway refused: ${String(answer?.error ?? "no answer")}`));
        else resolve(answer.result);
      } catch (error) {
        reject(error);
      }
    });
    peer.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const sameHome = async (a: string, b: string) => a === b || (await realpath(a).catch(() => a)) === (await realpath(b).catch(() => b));

function loopbackOrigin(origin: unknown): string {
  if (typeof origin !== "string") throw new Error("Hermes's gateway gave no address.");
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !url.port || !(/^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1"))
    throw new Error("Hermes's gateway isn't on this machine's loopback.");
  return `ws://${url.host}/api/ws`;
}

/**
 * Attaches to the gateway serving `home`: identify, a ticket, and the WebSocket. Fails when no gateway
 * runs there (yet), or one that isn't ready or doesn't serve this home.
 */
export async function openHermesGateway(home: string, events: HermesEvents, timeoutMs = 5000): Promise<HermesConnection> {
  const socket = await controlSocket(home);
  const identity = await control(socket, { verb: "identify" }, timeoutMs);
  if (identity.state !== "ready") throw new Error(`Hermes's gateway is ${String(identity.state)}.`);
  if (!Array.isArray(identity.capabilities) || !identity.capabilities.includes("session-authority-v1"))
    throw new Error("This Hermes gateway has no shared sessions.");
  let profile: string | undefined;
  for (const served of Array.isArray(identity.served_profiles) ? identity.served_profiles : [])
    if (typeof served?.home === "string" && typeof served.profile_id === "string" && (await sameHome(served.home, home))) profile = served.profile_id;
  if (!profile || typeof identity.instance_id !== "string") throw new Error("Hermes's gateway doesn't serve this home.");
  const url = loopbackOrigin(identity.api_origin);
  const grant = await control(socket, { verb: "session-ticket", params: { profile_id: profile, instance_id: identity.instance_id, purpose: "interactive" } }, timeoutMs);
  if (typeof grant.ticket !== "string" || !grant.ticket) throw new Error("Hermes's gateway gave no ticket.");

  const ws = new WebSocket(url, [HERMES_GATEWAY_PROTOCOL, TICKET_PREFIX + grant.ticket]);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 0;
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new HermesNoAnswer("Hermes's gateway closed the connection before it answered."));
    }
    pending.clear();
    events.onClose();
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Hermes's gateway didn't open its socket."));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      if (ws.protocol === HERMES_GATEWAY_PROTOCOL) resolve();
      else {
        ws.close();
        reject(new Error("Hermes's gateway spoke another protocol."));
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Hermes's gateway refused the socket."));
    };
  });
  ws.onerror = () => {};
  ws.onclose = end;
  ws.onmessage = (message) => {
    let frame: any;
    try {
      frame = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (typeof frame?.id === "number" && pending.has(frame.id)) {
      const call = pending.get(frame.id)!;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.error) call.reject(new HermesRefusal(String(frame.error.data?.reason ?? frame.error.message ?? "refused")));
      else call.resolve(frame.result ?? {});
      return;
    }
    // Questions the gateway asks a client (approvals in a TUI) go only to a client that said it answers
    // them (`client.capabilities`); this one never says so, so the person answers in the terminal.
    if (frame?.method === "event" && frame.params && typeof frame.params.type === "string") events.onEvent(frame.params as HermesEvent);
  };
  return {
    call(method, params, callTimeoutMs = 30_000) {
      if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new HermesRefusal("not_sent"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HermesNoAnswer(`Hermes's gateway didn't answer ${method}.`));
        }, callTimeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    close() {
      ws.close();
      end();
    },
  };
}
