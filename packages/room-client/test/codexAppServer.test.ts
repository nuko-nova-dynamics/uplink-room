/**
 * Connecting to Codex's app server over its control socket (codexAppServer.ts in the protocol package).
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CodexAppServer } from "@uplink-room/protocol/codexAppServer";
import { tempDir } from "./support.ts";

test("an app server that closes the connection before the handshake ends fails the open", async () => {
  if (process.platform === "win32") return; // A Unix socket path; Windows' named pipes differ.
  const path = join(await tempDir("uplink-codex-"), "control.sock");
  const server = createServer((socket) => socket.once("data", () => socket.end()));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const opened = CodexAppServer.open(path, 60_000);
    const outcome = await Promise.race([
      opened.then(
        () => "opened",
        (error: Error) => error.message,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
    ]);
    expect(outcome).toMatch(/closed the connection/);
  } finally {
    server.close();
  }
});
