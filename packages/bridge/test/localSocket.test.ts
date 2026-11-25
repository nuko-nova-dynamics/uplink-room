import { afterEach, expect, test } from "vitest";
import { createConnection, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSocket, localRequest } from "../src/localSocket.ts";
import { socketPathFor } from "../src/platform.ts";
import type { Bridge } from "../src/bridge.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function tempSocketPath() {
  const home = await mkdtemp(join(tmpdir(), "uplink-socket-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return socketPathFor(home);
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a hook message split inside a multi-byte character reaches the bridge intact", async () => {
  const path = await tempSocketPath();
  const received: unknown[] = [];
  const bridge = {
    setSocketPath() {},
    hook: async (_terminalId: string, _secret: unknown, _event: string, payload: unknown) => {
      received.push(payload);
      return { ok: true };
    },
  } as unknown as Bridge;
  const socket = new LocalSocket(path, bridge);
  await socket.start();
  cleanups.push(() => socket.close());

  const bytes = Buffer.from(JSON.stringify({ type: "hook", terminalId: "t1", event: "ask", payload: { text: "café ✓ 日本" } }) + "\n");
  // Cut inside the two-byte "é", then inside the three-byte "✓".
  const cuts = [bytes.indexOf(0xc3) + 1, bytes.indexOf(0xe2) + 2];
  const client = createConnection(path);
  const reply = new Promise<string>((resolve, reject) => {
    let out = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => (out += chunk));
    client.on("end", () => resolve(out));
    client.on("error", reject);
  });
  await new Promise((resolve) => client.once("connect", resolve));
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    client.write(bytes.subarray(from, cut));
    from = cut;
    await pause();
  }

  expect(JSON.parse(await reply)).toEqual({ result: { ok: true } });
  expect(received).toEqual([{ text: "café ✓ 日本" }]);
});

test("a reply split inside a multi-byte character reaches the caller intact", async () => {
  const path = await tempSocketPath();
  const reply = Buffer.from(JSON.stringify({ result: { text: "café" } }) + "\n");
  const server = createServer((connection) => {
    connection.on("error", () => {});
    connection.once("data", async () => {
      const cut = reply.indexOf(0xc3) + 1;
      connection.write(reply.subarray(0, cut));
      await pause();
      connection.end(reply.subarray(cut));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));

  expect(await localRequest(path, { type: "probe" })).toEqual({ text: "café" });
});

test("busy answers how many terminals closing the bridge would end", async () => {
  const path = await tempSocketPath();
  const bridge = { setSocketPath() {}, busyTerminals: () => 2 } as unknown as Bridge;
  const socket = new LocalSocket(path, bridge);
  await socket.start();
  cleanups.push(() => socket.close());

  expect(await localRequest(path, { type: "busy" })).toEqual({ terminals: 2 });
});
