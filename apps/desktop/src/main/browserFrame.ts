import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net } from "electron";

/**
 * The shared-browser frame (spec #7, ADR 0006) lives at
 * `uplink-frame://browser/`, a different origin from the app
 * (`uplink-room://app`, or the dev server) and from posted HTML
 * (`uplink-frame://sandbox`). Hyperbeam's web SDK downloads its client code
 * at runtime and runs it in this origin, which holds no session, token or
 * storage of ours. Subframes never get the preload, so it has no bridge to
 * the main process either.
 *
 * Its page is built with the renderer (`browser-frame.html`); only that page
 * and the built assets are served here. In development the files come from
 * the dev server, still under this origin.
 */
export const BROWSER_FRAME_HOST = "browser";
export const BROWSER_FRAME_PAGE = "/browser-frame.html";

const HYPERBEAM = "https://*.hyperbeam.com";

/**
 * Hyperbeam only. This also blocks the SDK's fallback host
 * (`jquery.tutturu.workers.dev`), which it tries when Hyperbeam's own hosts
 * fail. `blob:` scripts are how the SDK loads the code it downloads.
 */
function csp(dev: boolean): string {
  return [
    "default-src 'none'",
    `script-src 'self' blob:${dev ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${HYPERBEAM} wss://*.hyperbeam.com${dev ? " 'self' ws://localhost:* ws://127.0.0.1:*" : ""}`,
    `img-src data: blob: ${HYPERBEAM}`,
    `media-src blob: mediastream: ${HYPERBEAM}`,
    `font-src data: ${HYPERBEAM}`,
    "worker-src blob:",
    `frame-src ${HYPERBEAM}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export async function browserFrameResponse(
  pathname: string,
  search: string,
  rendererDir: string,
  devServer: string | undefined,
): Promise<Response> {
  const allowed = pathname === BROWSER_FRAME_PAGE || pathname.startsWith("/assets/") || Boolean(devServer);
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": csp(Boolean(devServer)),
  });
  if (!allowed) return new Response("Not found", { status: 404, headers });

  let response: Response;
  if (devServer) {
    response = await net.fetch(new URL(pathname + search, devServer).toString());
  } else {
    const file = normalize(join(rendererDir, decodeURIComponent(pathname)));
    if (!file.startsWith(rendererDir + sep) || !existsSync(file)) {
      return new Response("Not found", { status: 404, headers });
    }
    response = await net.fetch(pathToFileURL(file).toString());
  }
  const type = TYPES[pathname.slice(pathname.lastIndexOf("."))] ?? response.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(response.body, { status: response.status, headers });
}
