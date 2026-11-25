/**
 * The Space gateway (GLOSSARY.md, ADR 0009): the bridge's door to the Spaces on its machine.
 *
 * Each Space view gets a random key and is served at `/v/<key>/`, piped to that Space's
 * `cua-spacesd`, which Cua's viewer supports ("behind a gateway that serves it under a path").
 * Each route is bound to what it was issued:
 *  - **One upstream.** Requests go only to the route's own `cua-spacesd` origin. The path is
 *    rebuilt from normalized segments, and anything that isn't the viewer page, a `cua.env.v1`
 *    call or the `/media` socket is 404, so no path can reach another host, port or service.
 *  - **One credential.** Every call carries the viewer ticket the route was issued with, put in
 *    by the gateway in place of whatever the page sent, so a ticket saved from an earlier view
 *    (say, from before the wheel moved) gets nothing more than this view's. The media socket
 *    attaches only with a media ticket this route's own `StreamService/OpenMedia` returned.
 * Closing a view forgets its key and destroys its open sockets at once, which is how the bridge
 * takes input away: Cua can't revoke one viewer ticket, and an attached video socket outlives it.
 */
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { networkInterfaces } from "node:os";

interface Route {
  /** The Space's `cua-spacesd` base: the only origin this route reaches. */
  target: URL;
  /** The viewer ticket this route was issued. */
  ticket?: string;
  /** Media tickets this route's own `OpenMedia` calls returned. */
  mediaTickets: Set<string>;
  sockets: Set<Socket>;
}

/** Headers a hop must not forward, and credentials the gateway sets itself. */
const DROPPED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "authorization",
  "x-cua-env-authorization",
]);

const OPEN_MEDIA = "cua.env.v1.StreamService/OpenMedia";
/** How long, and how much, a Space's answer to an upgrade may take before the gateway gives up. */
const UPGRADE_ANSWER_MS = 10_000;
const UPGRADE_ANSWER_LIMIT = 16 * 1024;
/** An `OpenMedia` answer is small; anything bigger isn't one. */
const OPEN_MEDIA_LIMIT = 64 * 1024;

/**
 * Where the gateway listens by default: loopback, and the machine's Tailscale addresses
 * (100.64.0.0/10), which only the tailnet reaches. Other interfaces only when the person asks.
 */
export function defaultGatewayHosts(): string[] {
  const hosts = ["127.0.0.1"];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const [a, b] = address.address.split(".").map(Number);
      if (a === 100 && b! >= 64 && b! <= 127) hosts.push(address.address);
    }
  }
  return hosts;
}

/**
 * The segments of a request path under a route, or undefined when the path is anything but plain
 * segments: no empty, `.` or `..` segment, and no encoded or literal slash, backslash or dot
 * segment that `cua-spacesd` or a URL parser could read as another path or host.
 */
export function pathSegments(path: string): string[] | undefined {
  if (!path.startsWith("/")) return undefined;
  const segments = path.slice(1).split("/");
  if (segments.at(-1) === "") segments.pop();
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || /[\\@]|%(2e|2f|5c|40|00)/i.test(segment)) return undefined;
  }
  return segments;
}

/** What a route serves: the viewer page (GET), `cua.env.v1` calls (POST), and the media socket. */
function allowed(segments: string[], method: string, upgrade: boolean): boolean {
  if (upgrade) return segments.length === 1 && segments[0] === "media" && method === "GET";
  if (segments[0] === "viewer") return method === "GET" || method === "HEAD";
  if (segments.length === 2 && /^cua\.env\.v1\.[A-Za-z]+$/.test(segments[0]!) && /^[A-Za-z]+$/.test(segments[1]!)) {
    return method === "POST" || method === "OPTIONS";
  }
  return false;
}

/** Media tickets in a gRPC-Web `OpenMediaResponse` (field 2, a string), binary or base64 text. */
export function mediaTicketsIn(body: Buffer, contentType: string): string[] {
  const bytes = contentType.includes("grpc-web-text") ? Buffer.from(body.toString("latin1"), "base64") : body;
  const tickets: string[] = [];
  for (let at = 0; at + 5 <= bytes.length; ) {
    const flag = bytes[at]!;
    const length = bytes.readUInt32BE(at + 1);
    const message = bytes.subarray(at + 5, at + 5 + length);
    at += 5 + length;
    if (flag & 0x80) continue;
    const ticket = stringField(message, 2);
    if (ticket) tickets.push(ticket);
  }
  return tickets;
}

/** A top-level string field of a protobuf message, or undefined. */
function stringField(message: Buffer, field: number): string | undefined {
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 35 && at < message.length; shift += 7) {
      const byte = message[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error("bad varint");
  };
  try {
    while (at < message.length) {
      const tag = varint();
      const wire = tag & 7;
      if (wire === 0) varint();
      else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else if (wire === 2) {
        const length = varint();
        if (tag >>> 3 === field) return message.subarray(at, at + length).toString("utf8");
        at += length;
      } else return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The media tickets a socket upgrade presents: `?ticket=` and `cua.ticket.<t>` (or legacy `rcdp.v2.ticket.<t>`) subprotocols. */
function presentedTickets(req: IncomingMessage, search: URLSearchParams): string[] {
  const tickets = search.getAll("ticket");
  for (const protocol of String(req.headers["sec-websocket-protocol"] ?? "").split(",")) {
    const value = protocol.trim();
    if (value.startsWith("cua.ticket.")) tickets.push(value.slice("cua.ticket.".length));
    else if (value.startsWith("rcdp.v2.ticket.")) tickets.push(value.slice("rcdp.v2.ticket.".length));
  }
  return tickets;
}

export class SpaceGateway {
  private routes = new Map<string, Route>();
  private servers: Server[] = [];
  private urls: string[] = [];
  private hosts: string[];
  private port: number;
  constructor(options: { hosts?: string[]; port?: number } = {}) {
    this.hosts = options.hosts ?? defaultGatewayHosts();
    this.port = options.port ?? 0;
  }
  /** Starts listening on every host, all on one port. Returns the base URLs. */
  async start(): Promise<string[]> {
    if (this.servers.length) return this.urls;
    let port = this.port;
    for (const host of this.hosts) {
      const server = createServer((req, res) => this.handle(req, res));
      server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as Socket, head));
      try {
        port = await listen(server, host, port);
      } catch (error) {
        // The chosen port is taken on this host: let the system pick one for every host.
        if (port !== 0 && (error as NodeJS.ErrnoException).code === "EADDRINUSE" && this.servers.length === 0) {
          port = await listen(server, host, 0);
        } else {
          server.close();
          continue;
        }
      }
      this.servers.push(server);
      this.urls.push(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
    }
    if (!this.servers.length) throw new Error("The Space gateway could not listen on any address.");
    return this.urls;
  }
  baseUrls() {
    return [...this.urls];
  }
  /**
   * Opens a route to a Space's `cua-spacesd`, bound to the viewer ticket it was issued. Returns
   * its key; the view is served at `/v/<key>/`.
   */
  open(target: string, ticket?: string): string {
    const key = randomBytes(24).toString("base64url");
    const base = new URL(target);
    base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    base.search = "";
    base.hash = "";
    this.routes.set(key, { target: base, ...(ticket ? { ticket } : {}), mediaTickets: new Set(), sockets: new Set() });
    return key;
  }
  /**
   * Gives a route a fresh viewer ticket, for calls from now on. Its key, path and open sockets
   * stay as they are, so attached video keeps playing; media tickets it already got stay valid.
   */
  renew(key: string, ticket: string): boolean {
    const route = this.routes.get(key);
    if (!route) return false;
    route.ticket = ticket;
    return true;
  }
  /** Forgets a route and destroys its open sockets. */
  close(key: string) {
    const route = this.routes.get(key);
    if (!route) return;
    this.routes.delete(key);
    for (const socket of route.sockets) socket.destroy();
  }
  has(key: string) {
    return this.routes.has(key);
  }
  async stop() {
    for (const key of this.routes.keys()) this.close(key);
    await Promise.all(
      this.servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    this.urls = [];
  }
  /** The route and the upstream URL for a request, or why not. Only the route's own origin. */
  private resolve(req: IncomingMessage, upgrade: boolean): { route: Route; target: URL; segments: string[] } | number {
    const match = /^\/v\/([A-Za-z0-9_-]{16,64})(\/[^?#]*)?(\?[^#]*)?$/.exec(req.url ?? "");
    const route = match ? this.routes.get(match[1]!) : undefined;
    if (!match || !route) return 404;
    const segments = pathSegments(match[2] ?? "/");
    if (!segments) return 400;
    if (!allowed(segments, req.method ?? "GET", upgrade)) return 404;
    const target = new URL(route.target.href);
    target.pathname = route.target.pathname + segments.join("/") + ((match[2] ?? "/").endsWith("/") && segments.length ? "/" : "");
    target.search = match[3] ?? "";
    // Belt and braces: the URL can only differ from the route's base in its path and query.
    if (target.origin !== route.target.origin || !target.pathname.startsWith(route.target.pathname)) return 400;
    return { route, target, segments };
  }
  private track(route: Route, socket: Socket) {
    // A keep-alive socket carries many requests; listen for its close once.
    if (route.sockets.has(socket)) return;
    route.sockets.add(socket);
    socket.once("close", () => route.sockets.delete(socket));
  }
  private handle(req: IncomingMessage, res: ServerResponse) {
    const found = this.resolve(req, false);
    if (typeof found === "number") {
      req.resume();
      res.writeHead(found, { "content-type": "text/plain" }).end(found === 404 ? "No such Space view." : "Bad path.");
      return;
    }
    const { route, target, segments } = found;
    this.track(route, req.socket);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROPPED.has(name)) headers[name] = value;
    }
    if (route.ticket) headers["x-cua-env-authorization"] = `Bearer ${route.ticket}`;
    const openMedia = segments.join("/") === OPEN_MEDIA;
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, { method: req.method, headers }, (reply) => {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(reply.headers)) {
        if (value !== undefined && !DROPPED.has(name) && name !== "set-cookie" && !(openMedia && name === "content-length")) out[name] = value;
      }
      if (!openMedia) {
        res.writeHead(reply.statusCode ?? 502, out);
        reply.pipe(res);
        return;
      }
      // Read the answer to learn the media ticket this route may attach with, then pass it on.
      const chunks: Buffer[] = [];
      let size = 0;
      reply.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= OPEN_MEDIA_LIMIT) chunks.push(chunk);
      });
      reply.on("end", () => {
        const body = Buffer.concat(chunks);
        if (size > OPEN_MEDIA_LIMIT) {
          res.writeHead(502, { "content-type": "text/plain" }).end("The Space's answer was too large.");
          return;
        }
        for (const ticket of mediaTicketsIn(body, String(reply.headers["content-type"] ?? ""))) route.mediaTickets.add(ticket);
        res.writeHead(reply.statusCode ?? 502, out).end(body);
      });
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The Space didn't answer.");
    });
    req.pipe(upstream);
  }
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const found = this.resolve(req, true);
    if (typeof found === "number") {
      socket.end(`HTTP/1.1 ${found === 404 ? "404 Not Found" : "400 Bad Request"}\r\nconnection: close\r\n\r\n`);
      return;
    }
    const { route, target } = found;
    const tickets = presentedTickets(req, target.searchParams);
    if (!tickets.length || !tickets.every((t) => route.mediaTickets.has(t))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    this.track(route, socket);
    // Nothing from the client reaches the Space until the Space has agreed to switch protocols.
    socket.pause();
    const secure = target.protocol === "https:";
    const port = Number(target.port) || (secure ? 443 : 80);
    const upstream = secure
      ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
      : netConnect({ host: target.hostname, port });
    this.track(route, upstream);
    const end = () => {
      clearTimeout(timer);
      socket.destroy();
      upstream.destroy();
    };
    const timer = setTimeout(() => {
      if (!socket.destroyed) socket.end("HTTP/1.1 504 Gateway Timeout\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      end();
    }, UPGRADE_ANSWER_MS);
    upstream.on("error", end);
    socket.on("error", end);
    upstream.on("close", end);
    socket.on("close", end);
    upstream.once(secure ? "secureConnect" : "connect", () => {
      const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `host: ${target.host}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (["host", "cookie", "authorization", "x-cua-env-authorization"].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      if (route.ticket) lines.push(`x-cua-env-authorization: Bearer ${route.ticket}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
    });
    // Read the Space's answer head. Only a 101 opens the pipe: any other answer (Cua answers a
    // bad upgrade with ordinary HTTP on a connection it keeps open) would otherwise let the
    // client send ordinary requests that skip this gateway's path and ticket rules.
    let answer = Buffer.alloc(0);
    const onAnswer = (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const headEnd = answer.indexOf("\r\n\r\n");
      if (headEnd < 0) {
        if (answer.length > UPGRADE_ANSWER_LIMIT) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
          end();
        }
        return;
      }
      upstream.off("data", onAnswer);
      clearTimeout(timer);
      const status = /^HTTP\/1\.1 (\d{3})([^\r\n]*)/.exec(answer.subarray(0, headEnd).toString("latin1"));
      if (status?.[1] !== "101") {
        const code = status?.[1] ?? "502";
        const reason = status ? status[2]!.trim() || "Refused" : "Bad Gateway";
        socket.end(`HTTP/1.1 ${code} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
        end();
        return;
      }
      upstream.pause();
      socket.write(answer);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.resume();
      socket.resume();
    };
    upstream.on("data", onAnswer);
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
