/**
 * Spec #6, seam 2: the bridge's Space adapter with a fake room and a fake Cua. The fake Cua is a
 * scripted `cua` executable (test/tools/cua) the real adapter runs, and a fake `cua-spacesd` that
 * serves a viewer page and an echoing WebSocket, reached through the real Space gateway.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { BridgeMessage, RoomMessage } from "@uplink-room/protocol";
import { Bridge, type RoomLink } from "../src/bridge.ts";
import { SpaceGateway } from "../src/spaces/gateway.ts";
import { CuaCliHost } from "../src/spaces/host.ts";

class FakeRoom implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void | Promise<void>;
  send(message: BridgeMessage) {
    this.messages.push(message);
  }
  onMessage(handler: (message: RoomMessage) => void | Promise<void>) {
    this.handler = handler;
  }
  deliver(message: RoomMessage) {
    return this.handler!(message);
  }
  of<T extends BridgeMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<BridgeMessage, { type: T }> => m.type === type);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TOKEN = "env-token-secret-123";
const julio = { memberId: "julio", name: "Julio" };
const ana = { memberId: "ana", name: "Ana" };

/** A gRPC-Web frame: flag byte, big-endian length, message. */
function grpcWebFrame(flag: number, body: Buffer) {
  const head = Buffer.alloc(5);
  head[0] = flag;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** A protobuf string field (wire type 2) with a one-byte length. */
function stringField(field: number, value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes]);
}

/**
 * A fake cua-spacesd: a viewer page, a capabilities call that echoes the credential it got,
 * `StreamService/OpenMedia` answering in gRPC-Web framing with a media ticket minted for that
 * credential (as Cua's does), and an echoing `/media` socket. `privateHits` counts requests to a
 * second server on the machine that the gateway must never reach.
 */
async function fakeSpacesd(title = "Cua viewer") {
  let minted = 0;
  const auth = (req: IncomingMessage) => String(req.headers["x-cua-env-authorization"] ?? "").replace(/^Bearer /, "");
  const server: Server = createServer((req, res) => {
    if (req.url === "/viewer/") return void res.writeHead(200, { "content-type": "text/html" }).end(`<title>${title}</title>`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/cua.env.v1.SystemService/GetCapabilities" && req.method === "POST") {
        return void res.writeHead(200, { "content-type": "application/grpc-web+proto" }).end(`caps:${body}:as=${auth(req)}`);
      }
      if (req.url === "/cua.env.v1.StreamService/OpenMedia" && req.method === "POST") {
        const ticket = `media-${++minted}-for-${auth(req)}`;
        const message = Buffer.concat([stringField(1, "session-1"), stringField(2, ticket), stringField(4, `/media?ticket=${ticket}`)]);
        return void res
          .writeHead(200, { "content-type": "application/grpc-web+proto" })
          .end(Buffer.concat([grpcWebFrame(0, message), grpcWebFrame(0x80, Buffer.from("grpc-status:0\r\n"))]));
      }
      res.writeHead(404).end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  const seen: string[] = [];
  // Bytes that reached cua-spacesd on a socket whose upgrade it refused.
  const afterRefusal: string[] = [];
  server.on("upgrade", (req, socket, head) => {
    seen.push(req.url ?? "");
    if (req.headers["sec-websocket-version"] !== "13") {
      // As cua-spacesd's media upgrade handler does: an ordinary HTTP answer, and the
      // connection stays open for more requests.
      socket.write("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: keep-alive\r\n\r\n");
      if (head.length) afterRefusal.push(head.toString());
      socket.on("data", (chunk) => afterRefusal.push(chunk.toString()));
      socket.on("end", () => socket.destroy());
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo:${data}`)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let privateHits = 0;
  const other = createServer((_req, res) => {
    privateHits++;
    res.end("private");
  });
  other.on("upgrade", (_req, socket) => {
    privateHits++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    sockets.close();
    server.closeAllConnections();
    other.closeAllConnections();
    other.close();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    privatePort: (other.address() as AddressInfo).port,
    privateHits: () => privateHits,
    afterRefusal,
    seen,
  };
}

async function setup(
  options: { mostOpenAccess?: "watch" | "suggest" | "drive" | "open"; ticketTtlSeconds?: number; renewBeforeMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "uplink-spaces-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const spacesd = await fakeSpacesd();
  const state: Record<string, unknown> & { spaces: Record<string, unknown>[] } = {
    token: TOKEN,
    spaces: [
      { id: "local:studio", name: "studio", display_name: "studio", os: "linux", kind: "container" },
      { id: "relay:0123abcd", name: "someone-elses-mac", os: "macos" },
    ],
    endpoints: { "local:studio": spacesd.url },
  };
  await writeFile(join(dir, "fake-state.json"), JSON.stringify(state));
  await writeFile(join(dir, "spaces-credentials.json"), JSON.stringify({ "local:studio": { token: TOKEN } }), { mode: 0o600 });
  const room = new FakeRoom();
  const gateway = new SpaceGateway({ hosts: ["127.0.0.1"], port: 0 });
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: options.mostOpenAccess ?? "open", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    spaces: {
      host: new CuaCliHost({ executable: join(import.meta.dirname, "tools/cua"), env: { CUA_HOME: dir } }),
      gateway,
      pollMs: 0,
      ...(options.ticketTtlSeconds ? { ticketTtlSeconds: options.ticketTtlSeconds } : {}),
      ...(options.renewBeforeMs ? { renewBeforeMs: options.renewBeforeMs } : {}),
    },
  });
  cleanups.push(() => bridge.close());
  await bridge.start();
  const calls = async () =>
    (await readFile(join(dir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; token: string | null });
  const writeState = (next: typeof state) => writeFile(join(dir, "fake-state.json"), JSON.stringify(next));
  return { room, bridge, gateway, spacesd, calls, state, writeState, dir };
}

/** Calls `StreamService/OpenMedia` through a view's route, as Cua's viewer does, and reads the media ticket it got. */
async function openMedia(base: string, viewPath: string, init: RequestInit = {}) {
  const reply = await fetch(`${base}${viewPath.replace("viewer/", "")}cua.env.v1.StreamService/OpenMedia`, { method: "POST", body: "", ...init });
  const text = Buffer.from(await reply.arrayBuffer()).toString("latin1");
  const wsPath = /\/media\?ticket=[A-Za-z0-9_.-]+/.exec(text)?.[0];
  if (!wsPath) throw new Error(`no media ticket in ${JSON.stringify(text)}`);
  return { wsPath, ticket: wsPath.split("=")[1]! };
}

/**
 * The status of a GET sent on a new connection. Closing a view destroys every connection its route
 * served, including the idle one `fetch` keeps for reuse; a `fetch` that reuses it before seeing
 * the close fails with ECONNRESET (on Windows, every time with the undici in Node 24.16.0, #67).
 */
function statusOnNewConnection(url: string) {
  return new Promise<number>((resolve, reject) => {
    request(url, { agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

/** Opens a WebSocket and resolves with "open", or the HTTP status the upgrade was refused with. */
function attach(url: string, protocols?: string[]) {
  return new Promise<string>((resolve) => {
    const socket = new WebSocket(url, protocols);
    cleanups.push(() => socket.terminate());
    socket.on("open", () => resolve("open"));
    socket.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    socket.on("error", () => resolve("error"));
  });
}

/** The bridge's answer to a share, once it has one (sharing connects to Cua on its own). */
async function shared(room: FakeRoom, spaceId: string) {
  const answer = () => room.messages.find((m) => (m.type === "space_shared" || m.type === "space_share_failed") && m.spaceId === spaceId);
  await expect.poll(answer).toBeTruthy();
  return answer()!;
}

async function shareStudio(room: FakeRoom, access: "watch" | "suggest" | "drive" | "open" = "drive", spaceId = "space-1") {
  await room.deliver({ v: 1, type: "share_space", spaceId, spaceRef: "local:studio", sharedBy: julio, access });
  return shared(room, spaceId);
}

async function openView(room: FakeRoom, viewId: string, viewer: { memberId: string; name: string }, interactive: boolean) {
  await room.deliver({ v: 1, type: "open_space_view", spaceId: "space-1", viewId, viewer, interactive });
  const answer = () => room.messages.findLast((m) => (m.type === "space_view_ready" || m.type === "space_view_failed") && m.viewId === viewId);
  await expect.poll(answer).toBeTruthy();
  return answer()!;
}

test("reports the Cua Spaces on its machine, local and direct only, and only when they change", async () => {
  const { room } = await setup();
  expect(room.of("spaces_found")).toEqual([
    { v: 1, type: "spaces_found", spaces: [{ spaceRef: "local:studio", name: "studio", os: "linux", kind: "container", state: "running" }] },
  ]);
  // Sharing looks again; nothing changed, so nothing new is reported.
  await shareStudio(room);
  expect(room.of("spaces_found")).toHaveLength(1);
});

test("shares only a Space Cua knows here, clamped to the machine's limit, and never puts its token in cua's arguments", async () => {
  const { room, gateway, calls } = await setup({ mostOpenAccess: "suggest" });

  await room.deliver({ v: 1, type: "share_space", spaceId: "space-x", spaceRef: "relay:0123abcd", sharedBy: julio, access: "watch" });
  expect(await shared(room, "space-x")).toEqual({ v: 1, type: "space_share_failed", spaceId: "space-x", reason: "unknown_space" });

  expect(await shareStudio(room, "open")).toEqual({ v: 1, type: "space_shared", spaceId: "space-1", access: "suggest", gateway: gateway.baseUrls() });
  // The room asked for Open and keeps its own level on the acknowledgement; the clamp is said apart.
  expect(room.of("space_access")).toEqual([{ v: 1, type: "space_access", spaceId: "space-1", access: "suggest" }]);
  await openView(room, "view-1", julio, true);

  const all = await calls();
  expect(all.some((c) => c.args.includes("SystemService/CreateViewerTicket") && c.token === TOKEN)).toBe(true);
  expect(JSON.stringify(all.map((c) => c.args))).not.toContain(TOKEN);
});

test("only the driver it knows gets an interactive view, and the viewer and its socket go through the gateway", async () => {
  const { room, gateway, spacesd, calls } = await setup();
  await shareStudio(room);

  const mine = await openView(room, "view-julio", julio, true);
  // The room asks for an interactive view for Ana; she doesn't drive, so the bridge says no.
  const hers = await openView(room, "view-ana", ana, true);

  expect(mine).toMatchObject({ type: "space_view_ready", interactive: true, ticket: "ticket-SESSION_POLICY_ALLOW_ACTIVATION-julio" });
  expect(hers).toMatchObject({ type: "space_view_ready", interactive: false, ticket: "ticket-SESSION_POLICY_VIEW_ONLY-ana" });
  const policies = (await calls()).filter((c) => c.args.includes("SystemService/CreateViewerTicket")).map((c) => JSON.parse(c.args.at(-1)!));
  expect(policies).toMatchObject([
    { policy: "SESSION_POLICY_ALLOW_ACTIVATION", clipboard: true, ttl: "300s" },
    { policy: "SESSION_POLICY_VIEW_ONLY", clipboard: false },
  ]);

  const [base] = gateway.baseUrls();
  const path = (hers as Extract<BridgeMessage, { type: "space_view_ready" }>).path;
  expect(path).toMatch(/^\/v\/[A-Za-z0-9_-]+\/viewer\/$/);
  const page = await fetch(`${base}${path}`);
  expect(await page.text()).toBe("<title>Cua viewer</title>");
  const grpc = await fetch(`${base}${path.replace("viewer/", "")}cua.env.v1.SystemService/GetCapabilities`, { method: "POST", body: "hi" });
  // The gateway calls cua-spacesd with the ticket this view was issued, whatever the page sends.
  expect(await grpc.text()).toBe("caps:hi:as=ticket-SESSION_POLICY_VIEW_ONLY-ana");
  expect((await fetch(`${base}/v/not-a-real-key-at-all/viewer/`)).status).toBe(404);

  const media = await openMedia(base!, path);
  const socket = new WebSocket(`${base!.replace("http", "ws")}${path.replace("/viewer/", "")}${media.wsPath}`);
  cleanups.push(() => socket.close());
  const echo = new Promise<string>((resolve) => socket.on("message", (data) => resolve(String(data))));
  socket.on("open", () => socket.send("frame"));
  expect(await echo).toBe("echo:frame");
  expect(spacesd.seen).toEqual([media.wsPath]);
});

test("passing the wheel cuts the old driver's socket at once, and below Drive only the sharer can take it back", async () => {
  const { room, gateway } = await setup();
  await shareStudio(room, "suggest");
  const view = (await openView(room, "view-julio", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const [base] = gateway.baseUrls();
  const { wsPath } = await openMedia(base!, view.path);
  const socket = new WebSocket(`${base!.replace("http", "ws")}${view.path.replace("/viewer/", "")}${wsPath}`);
  await new Promise((resolve) => socket.on("open", resolve));
  const closed = new Promise((resolve) => socket.on("close", resolve));

  await room.deliver({ v: 1, type: "space_driver_changed", spaceId: "space-1", driver: ana });
  expect(room.of("space_rejected")).toEqual([{ v: 1, type: "space_rejected", spaceId: "space-1", memberId: "ana", reason: "driver_change_rejected" }]);
  expect(socket.readyState).toBe(WebSocket.OPEN);

  await room.deliver({ v: 1, type: "change_space_access", spaceId: "space-1", access: "drive" });
  await room.deliver({ v: 1, type: "space_driver_changed", spaceId: "space-1", driver: ana });

  await closed;
  expect(await statusOnNewConnection(`${base}${view.path}`)).toBe(404);
  // Julio is a viewer now: asking for an interactive view gets a view-only one.
  expect(await openView(room, "view-julio-2", julio, true)).toMatchObject({ interactive: false });
});

test("runs Space actions only from the driver, with the Space's own token", async () => {
  const { room, calls } = await setup();
  await shareStudio(room);

  await room.deliver({ v: 1, type: "space_action", spaceId: "space-1", actionId: "a1", from: ana, action: { kind: "type", text: "rm -rf /" } });
  await room.deliver({ v: 1, type: "space_action", spaceId: "space-1", actionId: "a2", from: julio, action: { kind: "screenshot" } });
  await room.deliver({ v: 1, type: "space_action", spaceId: "space-1", actionId: "a3", from: julio, action: { kind: "click", x: 40, y: 12, screenshotId: "shot-1" } });
  await room.deliver({ v: 1, type: "space_action", spaceId: "space-1", actionId: "a4", from: julio, action: { kind: "key", keys: ["ctrl", "s"] } });
  await room.deliver({ v: 1, type: "space_action", spaceId: "space-1", actionId: "a5", from: julio, action: { kind: "key", keys: ["F13x"] } });

  // Actions run on their own, one after another, in the order the room sent them.
  await expect.poll(() => room.of("space_action_result").length).toBe(5);
  expect(room.of("space_action_result")).toEqual([
    { v: 1, type: "space_action_result", spaceId: "space-1", actionId: "a1", ok: false, error: "not_driver" },
    {
      v: 1,
      type: "space_action_result",
      spaceId: "space-1",
      actionId: "a2",
      ok: true,
      screenshot: { image: Buffer.from("fake-jpeg").toString("base64"), format: "jpeg", width: 1280, height: 800, screenshotId: "shot-1" },
    },
    { v: 1, type: "space_action_result", spaceId: "space-1", actionId: "a3", ok: true },
    { v: 1, type: "space_action_result", spaceId: "space-1", actionId: "a4", ok: true },
    { v: 1, type: "space_action_result", spaceId: "space-1", actionId: "a5", ok: false, error: "invalid_action" },
  ]);
  const bodies = (await calls()).filter((c) => c.args[0] === "spacesd").map((c) => [c.args[3], JSON.parse(c.args[4]!), c.token]);
  expect(bodies).toContainEqual([
    "ComputerService/Pointer",
    { target: { space: "COORDINATE_SPACE_SCREENSHOT", screenshotId: "shot-1" }, click: { position: { x: 40, y: 12 }, button: "MOUSE_BUTTON_LEFT" } },
    TOKEN,
  ]);
  expect(bodies).toContainEqual(["ComputerService/Keyboard", { press: { key: { character: "s" }, modifiers: ["KEY_CONTROL"] } }, TOKEN]);
  expect(JSON.stringify(bodies)).not.toContain("rm -rf");
});

test("ends a shared Space when sharing stops, when Cua no longer lists it, or when the room unshares it", async () => {
  const { room, bridge, gateway, state, writeState } = await setup();
  await shareStudio(room);
  const view = (await openView(room, "view-julio", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const [base] = gateway.baseUrls();

  await room.deliver({ v: 1, type: "stop_sharing" });
  expect(room.of("space_ended")).toEqual([{ v: 1, type: "space_ended", spaceId: "space-1", reason: "stopped" }]);
  expect((await fetch(`${base}${view.path}`)).status).toBe(404);
  await room.deliver({ v: 1, type: "share_space", spaceId: "space-2", spaceRef: "local:studio", sharedBy: julio, access: "watch" });
  expect(room.of("space_share_failed")).toEqual([{ v: 1, type: "space_share_failed", spaceId: "space-2", reason: "sharing_stopped" }]);

  await room.deliver({ v: 1, type: "resume_sharing" });
  await shareStudio(room, "watch", "space-3");
  await writeState({ ...state, spaces: [] });
  // The bridge looks for Spaces on a timer; the test asks once instead of waiting for it.
  await (bridge as unknown as { spaces: { discover(): Promise<void> } }).spaces.discover();
  expect(room.of("space_ended").at(-1)).toEqual({ v: 1, type: "space_ended", spaceId: "space-3", reason: "gone" });
  expect(room.of("spaces_found").at(-1)).toEqual({ v: 1, type: "spaces_found", spaces: [] });

  await writeState(state);
  await shareStudio(room, "watch", "space-4");
  await room.deliver({ v: 1, type: "unshare_space", spaceId: "space-4" });
  expect(room.of("space_ended").at(-1)).toEqual({ v: 1, type: "space_ended", spaceId: "space-4", reason: "stopped" });
});

test("a view's path can't reach anything but its Space's cua-spacesd", async () => {
  const { room, gateway, spacesd } = await setup();
  await shareStudio(room);
  const view = (await openView(room, "view-ana", ana, false)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const [base] = gateway.baseUrls();
  const prefix = view.path.replace("/viewer/", "");
  const other = `127.0.0.1:${spacesd.privatePort}`;

  for (const path of [`///${other}/private`, `//${other}/private`, `/.//${other}/private`, `/../../${other}`, `/%2F%2F${other}/private`, `/viewer/..%2F..%2Fprivate`]) {
    // A raw request, so nothing on this side normalizes the path first.
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}${prefix}${path}`, { method: "POST", headers: { "content-type": "text/plain" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", () => resolve(0));
      req.end("secret");
    });
    expect([400, 404], path).toContain(status);
  }
  expect(await attach(`${base!.replace("http", "ws")}${prefix}///${other}/media`)).not.toBe("open");
  expect(spacesd.privateHits()).toBe(0);
  // Only the viewer, cua.env.v1 calls and the media socket are served.
  expect((await fetch(`${base}${prefix}/files/anything`)).status).toBe(404);
});

test("a route works only with the credential it was issued: a saved driver's ticket gets no input through a watch view", async () => {
  const { room, gateway } = await setup();
  await shareStudio(room);
  const [base] = gateway.baseUrls();
  const ws = (path: string, wsPath: string) => `${base!.replace("http", "ws")}${path.replace("/viewer/", "")}${wsPath}`;

  // Julio drives, and keeps a media ticket minted with his interactive ticket.
  const driving = (await openView(room, "view-1", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const saved = await openMedia(base!, driving.path);
  expect(saved.ticket).toContain("ALLOW_ACTIVATION");

  // The wheel moves; Julio reopens as a watcher.
  await room.deliver({ v: 1, type: "space_driver_changed", spaceId: "space-1", driver: ana });
  const watching = (await openView(room, "view-2", julio, false)) as Extract<BridgeMessage, { type: "space_view_ready" }>;

  // Calls through the watch route carry the watch ticket, even with the old one in the request.
  const forged = await fetch(`${base}${watching.path.replace("viewer/", "")}cua.env.v1.SystemService/GetCapabilities`, {
    method: "POST",
    body: "x",
    headers: { "x-cua-env-authorization": `Bearer ${driving.ticket}`, authorization: `Bearer ${driving.ticket}` },
  });
  expect(await forged.text()).toBe("x:as=ticket-SESSION_POLICY_VIEW_ONLY-julio".replace(/^/, "caps:"));
  const fresh = await openMedia(base!, watching.path, { headers: { "x-cua-env-authorization": `Bearer ${driving.ticket}` } });
  expect(fresh.ticket).toContain("VIEW_ONLY");

  // The saved media ticket is refused on the watch route, in the query and as a subprotocol.
  expect(await attach(ws(watching.path, saved.wsPath))).toBe("403");
  expect(await attach(ws(watching.path, "/media"), ["rcdp.v2", `cua.ticket.${saved.ticket}`])).toBe("403");
  expect(await attach(ws(watching.path, "/media"))).toBe("403");
  // The route's own media ticket works.
  expect(await attach(ws(watching.path, fresh.wsPath))).toBe("open");
});

test("taking access away never waits for Cua: the wheel moves while a viewer ticket is still being minted", async () => {
  const { room, gateway, state, writeState } = await setup();
  await writeState({ ...state, slowPrincipal: "carl", slowMs: 8000 });
  await shareStudio(room, "drive");
  const view = (await openView(room, "view-julio", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const [base] = gateway.baseUrls();
  const { wsPath } = await openMedia(base!, view.path);
  const socket = new WebSocket(`${base!.replace("http", "ws")}${view.path.replace("/viewer/", "")}${wsPath}`);
  await new Promise((resolve) => socket.on("open", resolve));
  const closed = new Promise((resolve) => socket.on("close", resolve));

  // Carl's ticket takes 8 seconds to mint; the wheel change behind it doesn't wait for it.
  const carl = room.deliver({ v: 1, type: "open_space_view", spaceId: "space-1", viewId: "view-carl", viewer: { memberId: "carl", name: "Carl" }, interactive: false });
  await room.deliver({ v: 1, type: "space_driver_changed", spaceId: "space-1", driver: ana });
  await closed;
  // Julio's socket was cut while Carl's ticket was still being minted.
  expect(room.messages.some((m) => m.type === "space_view_ready" && m.viewId === "view-carl")).toBe(false);
  await carl;
  await expect.poll(() => room.of("space_view_ready").some((m) => m.viewId === "view-carl")).toBe(true);
});

test("a Space stopped in Cua stops its views and actions, and comes back when it starts", async () => {
  const { room, bridge, gateway, state, writeState } = await setup();
  await shareStudio(room);
  const view = (await openView(room, "view-julio", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const [base] = gateway.baseUrls();
  const discover = () => (bridge as unknown as { spaces: { discover(): Promise<void> } }).spaces.discover();

  await writeState({ ...state, spaces: state.spaces.map((s) => ({ ...s, power_state: s.id === "local:studio" ? "stopped" : "" })) });
  await discover();
  expect(room.of("space_power")).toEqual([{ v: 1, type: "space_power", spaceId: "space-1", state: "stopped" }]);
  expect(room.of("spaces_found").at(-1)).toMatchObject({ spaces: [{ spaceRef: "local:studio", state: "stopped" }] });
  expect((await fetch(`${base}${view.path}`)).status).toBe(404);
  expect(await openView(room, "view-2", julio, true)).toMatchObject({ type: "space_view_failed", reason: "space_stopped" });
  await room.deliver({ v: 1, type: "space_action", spaceId: "space-1", actionId: "a1", from: julio, action: { kind: "screenshot" } });
  await expect.poll(() => room.of("space_action_result").at(-1)).toMatchObject({ actionId: "a1", ok: false, error: "space_stopped" });

  await writeState(state);
  await discover();
  await expect.poll(() => room.of("space_power").at(-1)).toEqual({ v: 1, type: "space_power", spaceId: "space-1", state: "running" });
  expect(await openView(room, "view-3", julio, true)).toMatchObject({ type: "space_view_ready", interactive: true });
  expect(room.of("space_ended")).toEqual([]);
});

test("a local Space stopped in Cua is seen stopped, though `spaces ls` leaves its power state empty", async () => {
  // Cua 0.10.0, live (issue #6): after `cua spaces stop` a local container's `spaces ls` entry has no
  // `power_state` and an empty `resources.powerState`; only `cua sb ls --local --json` says "stopped".
  const { room, bridge, state, writeState } = await setup();
  await shareStudio(room);
  const discover = () => (bridge as unknown as { spaces: { discover(): Promise<void> } }).spaces.discover();

  await writeState({ ...state, sandboxStates: { "local:studio": "stopped" } });
  await discover();
  expect(room.of("space_power")).toEqual([{ v: 1, type: "space_power", spaceId: "space-1", state: "stopped" }]);
  expect(await openView(room, "view-1", julio, true)).toMatchObject({ type: "space_view_failed", reason: "space_stopped" });

  await writeState({ ...state, sandboxStates: { "local:studio": "running" } });
  await discover();
  await expect.poll(() => room.of("space_power").at(-1)).toEqual({ v: 1, type: "space_power", spaceId: "space-1", state: "running" });
});

test("an upgrade the Space refuses closes the connection: nothing more reaches cua-spacesd on it", async () => {
  const { room, gateway, spacesd } = await setup();
  await shareStudio(room, "drive");
  const [base] = gateway.baseUrls();
  // The previous driver, now watching, with a media ticket of their watch route and their old ticket.
  const driving = (await openView(room, "view-1", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  await room.deliver({ v: 1, type: "space_driver_changed", spaceId: "space-1", driver: ana });
  const watching = (await openView(room, "view-2", julio, false)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const { wsPath } = await openMedia(base!, watching.path);
  const { port } = new URL(base!);
  const prefix = watching.path.replace("/viewer/", "");

  const socket = netConnect({ host: "127.0.0.1", port: Number(port) });
  cleanups.push(() => void socket.destroy());
  await new Promise((resolve) => socket.on("connect", resolve));
  let received = "";
  socket.on("data", (chunk) => (received += chunk.toString()));
  const closed = new Promise((resolve) => socket.on("close", resolve));
  // A bad Sec-WebSocket-Version, then an ordinary request smuggled behind it with the old ticket.
  socket.write(
    `GET ${prefix}${wsPath} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 99\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n` +
      `POST /cua.env.v1.ComputerService/Pointer HTTP/1.1\r\nhost: x\r\nx-cua-env-authorization: Bearer ${driving.ticket}\r\ncontent-length: 2\r\n\r\n{}`,
  );
  setTimeout(() => socket.write(`POST /cua.env.v1.ComputerService/Keyboard HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\n{}`), 200);

  await closed;
  expect(received).toMatch(/^HTTP\/1\.1 400 /);
  expect(received.toLowerCase()).toContain("connection: close");
  expect(spacesd.afterRefusal.join("")).toBe("");
});

test("a Space that runs again but can't be reached yet is retried on the next look, and reported running once", async () => {
  const { room, bridge, state, writeState } = await setup();
  await shareStudio(room);
  const discover = () => (bridge as unknown as { spaces: { discover(): Promise<void> } }).spaces.discover();
  const running = () => room.of("space_power").filter((m) => m.state === "running");

  await writeState({ ...state, spaces: state.spaces.map((s) => ({ ...s, power_state: s.id === "local:studio" ? "stopped" : "" })) });
  await discover();
  expect(room.of("space_power")).toEqual([{ v: 1, type: "space_power", spaceId: "space-1", state: "stopped" }]);

  // Cua says it runs again, but has no address for it yet: the reconnect fails once.
  await writeState({ ...state, endpoints: {} });
  await discover();
  // Let the failed reconnect settle.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(running()).toEqual([]);
  expect(await openView(room, "view-early", julio, true)).toMatchObject({ type: "space_view_failed", reason: "space_stopped" });

  // The address is back: the next looks reconnect it, and say so once.
  await writeState(state);
  await discover();
  await expect.poll(() => running().length).toBe(1);
  await discover();
  await discover();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(running()).toEqual([{ v: 1, type: "space_power", spaceId: "space-1", state: "running" }]);
  expect(await openView(room, "view-late", julio, true)).toMatchObject({ type: "space_view_ready", interactive: true });
});

test("a Space that stops and starts again while a reconnect is pending opens at its newest address", async () => {
  const { room, bridge, gateway, state, writeState, dir } = await setup();
  const gate = join(dir, "release-lookup");
  cleanups.push(() => writeFile(gate, ""));
  await shareStudio(room);
  const discover = () => (bridge as unknown as { spaces: { discover(): Promise<void> } }).spaces.discover();
  const power = (s: string) => room.of("space_power").filter((m) => m.state === s);
  const stopped = { ...state, spaces: state.spaces.map((s) => ({ ...s, power_state: s.id === "local:studio" ? "stopped" : "" })) };
  const endpoints = state.endpoints as Record<string, string>;

  await writeState(stopped);
  await discover();
  // Start A: Cua's lookup of its address is slow, so this reconnect is still pending...
  await writeState({ ...state, sbInfoGate: gate });
  await discover();
  await expect.poll(() => readFile(`${gate}.entered`, "utf8")).toBe("");
  // ...when Cua stops it again, then starts it (B) at a new address.
  await writeState(stopped);
  await discover();
  const b = await fakeSpacesd("Space B");
  await writeState({ ...state, endpoints: { ...endpoints, "local:studio": b.url } });
  await discover();

  await writeFile(gate, "");
  await expect.poll(() => power("running").length, { timeout: 10_000 }).toBe(1);
  await discover();
  expect(power("running")).toHaveLength(1);
  expect(power("stopped")).toHaveLength(1);
  const view = (await openView(room, "view-b", julio, true)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  expect(view).toMatchObject({ type: "space_view_ready", interactive: true });
  const [base] = gateway.baseUrls();
  expect(await (await fetch(`${base}${view.path}`)).text()).toBe("<title>Space B</title>");
});

test("a view's ticket is renewed before it expires, and the route uses the new one without dropping the video", async () => {
  // Tickets that last 3 seconds, renewed 2 seconds before they expire.
  const { room, gateway } = await setup({ ticketTtlSeconds: 3, renewBeforeMs: 2000 });
  await shareStudio(room);
  const view = (await openView(room, "view-ana", ana, false)) as Extract<BridgeMessage, { type: "space_view_ready" }>;
  const [base] = gateway.baseUrls();
  const caps = async () =>
    (await fetch(`${base}${view.path.replace("viewer/", "")}cua.env.v1.SystemService/GetCapabilities`, { method: "POST", body: "x" })).text();
  expect(await caps()).toBe("caps:x:as=ticket-SESSION_POLICY_VIEW_ONLY-ana");
  const { wsPath } = await openMedia(base!, view.path);
  const socket = new WebSocket(`${base!.replace("http", "ws")}${view.path.replace("/viewer/", "")}${wsPath}`);
  cleanups.push(() => socket.terminate());
  await new Promise((resolve) => socket.on("open", resolve));
  let closed = false;
  socket.on("close", () => (closed = true));

  await expect.poll(() => room.of("space_view_renewed").length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(room.of("space_view_renewed")[0]).toMatchObject({ spaceId: "space-1", viewId: "view-ana", expiresAt: expect.any(Number) });
  expect(room.of("space_view_renewed")[0]!.expiresAt).toBeGreaterThan(view.expiresAt);

  // Same route, new ticket: a reconnect after the first ticket expires would still open media.
  expect(await caps()).toBe("caps:x:as=ticket-SESSION_POLICY_VIEW_ONLY-ana-2");
  // The video that was attached never noticed.
  const echo = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
  socket.send("frame");
  expect(await echo).toBe("echo:frame");
  expect(closed).toBe(false);
});

test("a closed view isn't renewed", async () => {
  const { room } = await setup({ ticketTtlSeconds: 2, renewBeforeMs: 1500 });
  await shareStudio(room);
  await openView(room, "view-ana", ana, false);
  await room.deliver({ v: 1, type: "close_space_view", spaceId: "space-1", viewId: "view-ana" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(room.of("space_view_renewed")).toEqual([]);
});
