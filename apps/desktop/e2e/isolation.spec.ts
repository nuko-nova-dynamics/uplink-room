import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Frame,
  type Page,
} from "@playwright/test";

/**
 * Spec #3, "Testing Decisions": a posted HTML page can't read the app's storage
 * or cookies.
 *
 * This launches the built app on its harness page (src/renderer/harness.tsx).
 * The harness puts a secret in the app's own localStorage and cookie, then
 * renders a hostile HTML page through the real message renderer. The page
 * tries to read the secret several ways and writes what it found into its own
 * body; the test reads that report out of the frame.
 *
 * It passes only if the page really ran (so a blocked script can't pass by
 * doing nothing) and none of its reads returned the secret.
 *
 * Two ways to host the app, because they differ on cookies:
 *  - "uplink-room://": how the packaged app serves its pages. Chromium keeps no cookies
 *    for a custom scheme, so only storage is checked here.
 *  - "http://127.0.0.1": how development serves them, and where Clerk's session
 *    cookie lives. Storage and the cookie are both checked.
 * Either way the posted page comes from `uplink-frame://sandbox`, served by the main process.
 */

const SECRET = "app-session-secret-8f3a";
const appDir = join(import.meta.dirname, "..");
const rendererDir = join(appDir, "out", "renderer");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Serves the built renderer over http, the way the dev server would. */
function serveRenderer(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const path = normalize(join(rendererDir, new URL(req.url ?? "/", "http://x").pathname));
    if (!path.startsWith(rendererDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      res
        .writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}

for (const mode of ["uplink-room://", "http://127.0.0.1"] as const) {
  test.describe(`app served from ${mode}`, () => {
    let app: ElectronApplication;
    let server: Server | undefined;

    test.beforeAll(async () => {
      // Electron runs as plain Node when this is set, which breaks launching it.
      const env = { ...process.env, UPLINK_START_PATH: "/harness.html" } as Record<string, string>;
      delete env["ELECTRON_RUN_AS_NODE"];
      delete env["ELECTRON_RENDERER_URL"];
      if (mode === "http://127.0.0.1") {
        const started = await serveRenderer();
        server = started.server;
        env["ELECTRON_RENDERER_URL"] = started.url;
      }
      app = await electron.launch({ args: [appDir], env });
    });

    test.afterAll(async () => {
      await app?.close();
      server?.close();
    });

    test("a posted HTML page can't read the app's storage or cookies", async () => {
      const page = await app.firstWindow();

      // 1. The app itself holds the secret, so a blocked read below means something.
      await expect(page.locator("#app-title")).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("uplink.session"))).toBe(SECRET);
      if (mode !== "uplink-room://") expect(await page.evaluate(() => document.cookie)).toContain(SECRET);
      const appOrigin = await page.evaluate(() => location.origin);
      expect(appOrigin.startsWith(mode === "uplink-room://" ? "uplink-room://" : "http://")).toBe(true);

      // 2. The posted page ran, from another origin than the app's.
      await expect(page.locator("iframe.html-frame")).toHaveAttribute("sandbox", "allow-scripts");
      const frame = await waitForReport(page);
      const report = JSON.parse((await frame.locator("#report").textContent()) ?? "{}") as Record<
        string,
        string
      >;
      expect(frame.url()).toMatch(/^uplink-frame:\/\/sandbox\//);
      expect(new URL(frame.url()).origin).not.toBe(appOrigin);

      // 3. Every read was blocked, and none saw the secret.
      expect(report["origin"]).toBe("null"); // opaque security origin: the frame has no allow-same-origin
      for (const read of [
        "localStorage",
        "sessionStorage",
        "cookie",
        "indexedDB",
        "parentDocument",
        "parentStorage",
        "topStorage",
      ]) {
        expect(report[read], read).toBe("blocked: SecurityError");
      }
      expect(JSON.stringify(report)).not.toContain(SECRET);

      // 4. The app's own secrets are untouched.
      expect(await page.evaluate(() => localStorage.getItem("uplink.session"))).toBe(SECRET);
    });

    test("the shared-browser frame runs on its own origin and can't reach the app's session", async () => {
      const page = await app.firstWindow();
      await expect(page.locator("#app-title")).toBeVisible();
      const appOrigin = await page.evaluate(() => location.origin);

      // The app handed the frame a link, and the frame answered: it refuses anything but Hyperbeam.
      await expect(page.locator("#browser-frame-report")).toContainText("won't open", { timeout: 15_000 });
      const iframe = page.locator("iframe.browser-frame");
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      const frame = page.frames().find((f) => f.url().startsWith("uplink-frame://browser/"));
      expect(frame, "the browser frame loaded from uplink-frame://browser").toBeTruthy();

      const report = await frame!.evaluate(async () => {
        const found: Record<string, string> = {};
        const attempt = (name: string, fn: () => unknown) => {
          try {
            const value = fn();
            found[name] = value === undefined || value === null ? "no access" : String(value);
          } catch (error) {
            found[name] = "blocked: " + (error as Error).name;
          }
        };
        attempt("origin", () => window.origin);
        attempt("localStorage", () => localStorage.getItem("uplink.session"));
        attempt("cookie", () => document.cookie);
        attempt("parentDocument", () => window.parent.document.title);
        attempt("parentStorage", () => window.parent.localStorage.getItem("uplink.session"));
        // Subframes never get the preload, so no bridge to the main process or Clerk's token cache.
        attempt("preload", () => Object.keys(window).filter((k) => k === "uplink" || k.startsWith("__clerk")).join(",") || null);
        // The CSP allows Hyperbeam only, which also blocks the SDK's fallback host.
        found["fallbackHost"] = await new Promise<string>((resolve) => {
          addEventListener("securitypolicyviolation", (e) => resolve(`blocked: ${e.violatedDirective}`), { once: true });
          fetch("https://jquery.tutturu.workers.dev/").then(
            () => resolve("reached"),
            () => setTimeout(() => resolve("failed without a CSP report"), 2000),
          );
        });
        return found;
      });

      expect(report["origin"]).toBe("uplink-frame://browser");
      expect(report["origin"]).not.toBe(appOrigin);
      expect(report["localStorage"]).toBe("no access");
      expect(report["parentDocument"]).toBe("blocked: SecurityError");
      expect(report["parentStorage"]).toBe("blocked: SecurityError");
      expect(report["preload"]).toBe("no access");
      expect(report["fallbackHost"]).toBe("blocked: connect-src");
      expect(JSON.stringify(report)).not.toContain(SECRET);
      expect(await page.evaluate(() => localStorage.getItem("uplink.session"))).toBe(SECRET);
    });

    test("a reconnect gets a fresh browser frame, which answers the new ticket", async () => {
      const page = await app.firstWindow();
      const report = page.locator("#browser-frame-report");
      await expect(report).toContainText("won't open", { timeout: 15_000 });
      const count = async (type: string) =>
        (JSON.parse((await report.textContent()) ?? "[]") as { type: string }[]).filter((e) => e.type === type).length;
      const readies = await count("ready");
      const answers = await count("error");
      await page.locator("#browser-frame-reconnect").click();
      // A frame that already took a ticket ignores later ones, so a reconnect must load a new frame.
      await expect.poll(() => count("ready"), { timeout: 15_000 }).toBe(readies + 1);
      await expect.poll(() => count("error"), { timeout: 15_000 }).toBe(answers + 1);
    });

    test("a PDF renders in the sandboxed frame, which can't read the app or reach the network", async () => {
      const page = await app.firstWindow();
      await expect(page.locator("#app-title")).toBeVisible();
      const appOrigin = await page.evaluate(() => location.origin);

      // Spec #9: PDFs are parsed only inside the frame origin, sandboxed like posted HTML.
      const iframe = page.locator("iframe.pdf-frame");
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      const frame = await waitForFrame(page, "uplink-frame://sandbox/pdf-frame.html");
      expect(new URL(frame.url()).origin).not.toBe(appOrigin);

      // The page really rendered, with its pin, so the checks below aren't passing on a dead frame.
      await expect(frame.locator(".page[data-rendered='true'] canvas")).toHaveCount(1, { timeout: 20_000 });
      await expect(frame.locator(".pin")).toHaveText("1");

      const report = await frame.evaluate(async () => {
        const found: Record<string, string> = {};
        const attempt = (name: string, fn: () => unknown) => {
          try {
            const value = fn();
            found[name] = value === undefined || value === null ? "no access" : String(value);
          } catch (error) {
            found[name] = `blocked: ${(error as Error).name}`;
          }
        };
        attempt("origin", () => window.origin);
        attempt("localStorage", () => localStorage.getItem("uplink.session"));
        attempt("cookie", () => document.cookie);
        attempt("indexedDB", () => {
          indexedDB.open("uplink-probe");
          return "opened";
        });
        attempt("parentDocument", () => parent.document.title);
        attempt("parentStorage", () => parent.localStorage.getItem("uplink.session"));
        found["network"] = await fetch("https://example.com/").then(
          () => "reached",
          () => "blocked",
        );
        return found;
      });
      expect(report["origin"]).toBe("null");
      for (const read of ["localStorage", "cookie", "indexedDB", "parentDocument", "parentStorage"]) {
        expect(report[read], read).toBe("blocked: SecurityError");
      }
      expect(report["network"]).toBe("blocked");
      expect(JSON.stringify(report)).not.toContain(SECRET);
    });
  });
}

/** The first frame whose URL starts with `prefix`. */
async function waitForFrame(page: Page, prefix: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(() => (found = page.frames().find((f) => f.url().startsWith(prefix))) !== undefined, {
      message: `no frame at ${prefix}`,
      timeout: 15_000,
    })
    .toBe(true);
  return found!;
}

/** The posted page's frame, once its script has written its report. */
async function waitForReport(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (!frame.url().startsWith("uplink-frame://")) continue;
          const done = await frame
            .locator("#report[data-done='true']")
            .count()
            .catch(() => 0);
          if (done > 0) {
            found = frame;
            return true;
          }
        }
        return false;
      },
      { message: "the posted page never ran its script", timeout: 15_000 },
    )
    .toBe(true);
  return found!;
}
