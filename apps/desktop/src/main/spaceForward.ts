import { get } from "node:http";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";

/**
 * A Space view's frame loads from a loopback port that this forwards to a bridge's Space gateway
 * (spec #6, ADR 0009). Two reasons:
 *  - Cua's viewer decodes video with WebCodecs, which needs a secure context, and
 *    `http://127.0.0.1` is one while a Tailscale or LAN address over http is not.
 *  - Each view gets its own port, so its own origin: a Space's page can't reach the app's
 *    storage or another Space's.
 * Closing the forward destroys its connections at once.
 */
export interface Forward {
  /** The view's URL on loopback, with the same path, query and fragment. */
  url: string;
  close(): Promise<void>;
}

export async function forwardSpaceView(target: string): Promise<Forward> {
  const remote = new URL(target);
  if (remote.protocol !== "http:") throw new Error("A Space gateway is reached over http.");
  const port = Number(remote.port) || 80;
  const sockets = new Set<Socket>();
  const server: Server = createServer((local) => {
    const upstream = connect({ host: remote.hostname.replace(/^\[|\]$/g, ""), port });
    sockets.add(local);
    sockets.add(upstream);
    const end = () => {
      local.destroy();
      upstream.destroy();
      sockets.delete(local);
      sockets.delete(upstream);
    };
    local.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    local.pipe(upstream);
    upstream.pipe(local);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const local = new URL(target);
  local.hostname = "127.0.0.1";
  local.port = String((server.address() as AddressInfo).port);
  return {
    url: local.toString(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * The response headers of a page from a Space view's forward, changed so the app may frame it.
 * Cua's viewer page (`cua-spacesd` 0.10.0) sends `frame-ancestors 'none'`, which stops it loading in
 * the Space view's frame. This puts the app's origin in its place (or adds the directive), so the
 * app can frame it and no other page can, and drops `X-Frame-Options`. Nothing else changes.
 */
export function letAppFrame(headers: Record<string, string[]>, appOrigin: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cspKey: string | undefined;
  for (const [key, values] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-frame-options") continue;
    if (lower !== "content-security-policy") {
      out[key] = values;
      continue;
    }
    cspKey = key;
    out[key] = values.map((policy) => {
      const directives = policy.split(";").map((d) => d.trim()).filter(Boolean);
      const rest = directives.filter((d) => !/^frame-ancestors(\s|$)/i.test(d));
      const at = directives.findIndex((d) => /^frame-ancestors(\s|$)/i.test(d));
      rest.splice(at === -1 ? rest.length : at, 0, `frame-ancestors ${appOrigin}`);
      return rest.join("; ");
    });
  }
  if (!cspKey) out["Content-Security-Policy"] = [`frame-ancestors ${appOrigin}`];
  return out;
}

/**
 * The first of a Space view's gateway URLs that serves this view: a GET of its page answering 200
 * within `timeoutMs`. Answering at all isn't enough, since this computer may run a bridge whose
 * own gateway listens on the same port and doesn't know the remote view's key (404).
 */
export async function firstReachable(urls: string[], timeoutMs = 1500): Promise<string | undefined> {
  for (const url of urls.slice(0, 8)) {
    let remote: URL;
    try {
      remote = new URL(url);
    } catch {
      continue;
    }
    if (remote.protocol !== "http:") continue;
    const ok = await new Promise<boolean>((resolve) => {
      const req = get(
        { host: remote.hostname.replace(/^\[|\]$/g, ""), port: Number(remote.port) || 80, path: remote.pathname + remote.search, timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
    });
    if (ok) return url;
  }
  return undefined;
}
