import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Helpers for the screenshot script (scripts/screenshots.ts): serve the built
 * renderer over http on port 5174 (one of the origins the Clerk instance
 * allows; see README "Auth"), and launch the built Electron app against it with a profile folder that
 * keeps the Clerk session between runs.
 */
export const appDir = join(import.meta.dirname, "..");
const rendererDir = join(appDir, "out", "renderer");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

/**
 * Serves on 5174, or on 5173 when another checkout's script (or a dev server) already holds 5174:
 * both are in the Clerk instance's allowed origins, and no other port is.
 */
export async function serveRenderer(): Promise<{ server: Server; url: string }> {
  for (const port of [5174, 5173]) {
    try {
      return await serveOn(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Ports 5174 and 5173 are both in use; the Clerk instance allows no other.");
}

function serveOn(port: number): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    let pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/") pathname = "/index.html";
    const path = normalize(join(rendererDir, pathname));
    if (!path.startsWith(rendererDir + sep)) return void res.writeHead(403).end();
    try {
      res
        .writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
        .end(await readFile(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", () =>
      resolve({ server, url: `http://localhost:${(server.address() as AddressInfo).port}` }),
    );
  });
}

/**
 * Banners the app would have shown during a run, one JSON line each (main/notifications.ts).
 * Scripted runs are quiet: no system banner and no sound on whoever's computer runs them.
 */
export const notifyLog = join(appDir, ".shots-notifications.jsonl");

export async function launch(
  url: string,
  profile: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const env = {
    ...process.env,
    ELECTRON_RENDERER_URL: url,
    UPLINK_QUIET: "1",
    UPLINK_NOTIFY_LOG: notifyLog,
  } as Record<string, string>;
  delete env["ELECTRON_RUN_AS_NODE"];
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${profile}`], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1320, height: 840 });
  return { app, page };
}

/**
 * A free local port, for a launched window's DevTools protocol. The gym's capture and crawl pick one
 * per run: two runs on one computer (two worktrees) on one fixed port drive each other's window.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
