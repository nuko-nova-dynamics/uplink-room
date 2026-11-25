// @vitest-environment node
/**
 * The worker's only way out (ADR 0012): each connection's resolved address is
 * checked as the socket opens, so a name that resolves, or later rebinds, to a
 * private address is refused, and the address checked is the one connected to.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, inject, test } from "vitest";
import { guardedFetch, setResolverForTests } from "../convex/lib/a2a/guardedFetch";
import { INSECURE_PEERS_ENV } from "../convex/lib/a2a/peerUrl";

const insecure = process.env[INSECURE_PEERS_ENV];
afterEach(() => {
  process.env[INSECURE_PEERS_ENV] = insecure;
  setResolverForTests(undefined);
});

async function agent(): Promise<{ id: string; url: string }> {
  return (await (
    await fetch(`${inject("fakeAgents")}/agents`, { method: "POST", body: "{}" })
  ).json()) as never;
}
async function calls(id: string): Promise<unknown[]> {
  return (await (await fetch(`${inject("fakeAgents")}/agents/${id}/calls`)).json()) as never;
}
const card = (port: string, host: string) => `http://${host}:${port}/.well-known/agent-card.json`;

test("a name that resolves to a private address is refused before connecting", async () => {
  delete process.env[INSECURE_PEERS_ENV];
  setResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
  await expect(
    guardedFetch("https://agent.example.com/", { method: "GET", headers: {} }),
  ).rejects.toThrow(/127\.0\.0\.1/);
  setResolverForTests(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "::ffff:7f00:1", family: 6 },
  ]);
  await expect(
    guardedFetch("https://agent.example.com/", { method: "GET", headers: {} }),
  ).rejects.toThrow(/private or reserved/);
  await expect(
    guardedFetch("https://[::ffff:7f00:1]/", { method: "GET", headers: {} }),
  ).rejects.toThrow(/private or reserved/);
  await expect(
    guardedFetch("https://x.convex.site/", { method: "GET", headers: {} }),
  ).rejects.toThrow(/deployment/);
});

test("every request resolves again, so a name that rebinds to a private address is refused then", async () => {
  delete process.env[INSECURE_PEERS_ENV];
  const answers = ["93.184.216.34", "10.0.0.5"];
  setResolverForTests(async () => [{ address: answers.shift() ?? "10.0.0.5", family: 4 }]);
  // The first answer is public: the connection is attempted (and fails or not; that's not the point).
  await guardedFetch("https://rebind.example.com/", {
    method: "GET",
    headers: {},
    signal: AbortSignal.timeout(200),
  }).catch((error: Error) => expect(error.message).not.toMatch(/private or reserved/));
  await expect(
    guardedFetch("https://rebind.example.com/", { method: "GET", headers: {} }),
  ).rejects.toThrow(/10\.0\.0\.5/);
});

test("the connection goes to the address that was checked", async () => {
  process.env[INSECURE_PEERS_ENV] = "1";
  const a = await agent();
  const port = new URL(a.url).port;
  // `agent.invalid` exists in no DNS: reaching the agent proves the checked answer was used.
  setResolverForTests(async (host) =>
    host === "agent.invalid" ? [{ address: "127.0.0.1", family: 4 }] : [],
  );
  const response = await guardedFetch(card(port, "agent.invalid"), { method: "GET", headers: {} });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { name: string }).name).toBe("Fake agent");
  expect(await calls(a.id)).toEqual([]);
});

test("a gateway answering HTTP 101 or closing without an answer fails the request at once", async () => {
  process.env[INSECURE_PEERS_ENV] = "1";
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      if (chunk.toString().includes("/upgrade")) {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n",
        );
      } else {
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const started = Date.now();
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/upgrade`, { method: "GET", headers: {} }),
    ).rejects.toThrow(/switch protocols/i);
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/close`, { method: "GET", headers: {} }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    server.close();
  }
}, 10_000);

test("a request's body goes out with its Content-Length, never chunked, so a gateway that reads only that header gets it", async () => {
  process.env[INSECURE_PEERS_ENV] = "1";
  let head = "";
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      head += chunk.toString();
      if (head.includes("\r\n\r\n")) {
        socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "SendMessage", params: { text: "é" } });
    await guardedFetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(head.toLowerCase()).toContain(`content-length: ${Buffer.byteLength(body)}`);
    expect(head.toLowerCase()).not.toContain("transfer-encoding");
  } finally {
    server.close();
  }
});
