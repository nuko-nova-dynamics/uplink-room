import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { firstReachable, forwardSpaceView, letAppFrame } from "./spaceForward";

test("Cua's viewer page, which refuses every frame, may be framed by the app's origin and no other", () => {
  // cua-spacesd 0.10.0 sends this on /viewer/ (live check, issue #6).
  const cua =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'";
  const headers = letAppFrame(
    { "Content-Security-Policy": [cua], "X-Frame-Options": ["DENY"], "content-type": ["text/html"] },
    "uplink-room://app",
  );
  expect(headers).toEqual({
    "Content-Security-Policy": [
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; frame-ancestors uplink-room://app; base-uri 'none'",
    ],
    "content-type": ["text/html"],
  });
  // Without a frame-ancestors directive, one is added, so other pages still can't frame it.
  expect(letAppFrame({ "content-security-policy": ["default-src 'self'"] }, "http://localhost:5173")).toEqual({
    "content-security-policy": ["default-src 'self'; frame-ancestors http://localhost:5173"],
  });
  expect(letAppFrame({}, "uplink-room://app")).toEqual({
    "Content-Security-Policy": ["frame-ancestors uplink-room://app"],
  });
});

test("a Space view loads from its own loopback port, keeps its path and fragment, and stops when closed", async () => {
  const gateway = createServer((req, res) => res.end(`gateway saw ${req.url}`));
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = (gateway.address() as AddressInfo).port;
  try {
    // The bridge lists every address its gateway listens on; the first that answers is used.
    const chosen = await firstReachable([`http://127.0.0.1:1/v/key123/viewer/#ticket=t`, `http://127.0.0.1:${port}/v/key123/viewer/#ticket=t`]);
    expect(chosen).toBe(`http://127.0.0.1:${port}/v/key123/viewer/#ticket=t`);
    const forward = await forwardSpaceView(chosen!);
    const local = new URL(forward.url);
    expect(local.port).not.toBe(String(port));
    expect(local.pathname + local.hash).toBe("/v/key123/viewer/#ticket=t");
    expect(await (await fetch(forward.url)).text()).toBe("gateway saw /v/key123/viewer/");

    await forward.close();
    await expect(fetch(forward.url)).rejects.toThrow();
  } finally {
    gateway.closeAllConnections();
    gateway.close();
  }
});

test("only an http gateway can be forwarded", async () => {
  await expect(forwardSpaceView("file:///etc/passwd")).rejects.toThrow(/http/);
});

test("the address chosen is the one that serves this view, not the viewer's own gateway on the same port", async () => {
  // This computer runs a bridge too: its gateway answers, but doesn't know the remote view's key.
  const own = createServer((_req, res) => res.writeHead(404).end("No such Space view."));
  const remote = createServer((req, res) =>
    req.url === "/v/key123/viewer/" ? res.writeHead(200, { "content-type": "text/html" }).end("viewer") : res.writeHead(404).end(),
  );
  for (const server of [own, remote]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server: typeof own) => (server.address() as AddressInfo).port;
  try {
    const urls = [own, remote].map((server) => `http://127.0.0.1:${port(server)}/v/key123/viewer/#ticket=t`);
    expect(await firstReachable(urls)).toBe(urls[1]);
    expect(await firstReachable([urls[0]!])).toBeUndefined();
  } finally {
    for (const server of [own, remote]) {
      server.closeAllConnections();
      server.close();
    }
  }
});
