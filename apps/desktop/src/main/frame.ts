/**
 * The HTML frame. Posted HTML pages render in an iframe whose document comes
 * from this origin (`uplink-frame://sandbox`), not from the app's. The iframe
 * is also sandboxed with `allow-scripts` only, so the page gets an opaque
 * origin: it can't read the app's localStorage, IndexedDB or cookies, or reach
 * into the parent window. Either layer alone would keep the app's storage out
 * of reach; both are on so one mistake in either doesn't expose the session.
 *
 * The shell below waits for the app to post the page's HTML, then writes it
 * into itself. It reports its height so the app can size the iframe.
 */

export const FRAME_SCHEME = "uplink-frame";
export const FRAME_HOST = "sandbox";

const FRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><script src="frame.js"></script></body></html>`;

const FRAME_JS = `(() => {
  const parent = window.parent;
  const tell = (message) => parent.postMessage(Object.assign({ source: "uplink-frame" }, message), "*");
  const height = () => Math.ceil(Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  ));
  const report = () => tell({ type: "height", height: height() });
  let rendered = false;
  addEventListener("message", (event) => {
    const data = event.data;
    if (rendered || event.source !== parent || !data || data.source !== "uplink-room" || data.type !== "render") return;
    if (typeof data.html !== "string") return;
    rendered = true;
    document.open();
    document.write(data.html);
    document.close();
    report();
    addEventListener("load", report);
    if (typeof ResizeObserver === "function") new ResizeObserver(report).observe(document.documentElement);
    setInterval(report, 750);
  });
  tell({ type: "ready" });
})();`;

/**
 * What a posted page may do. It can run its own scripts and styles and load
 * images, fonts and data over https, which covers charts and small apps. It
 * can't open frames or submit forms.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The PDF viewer (spec #9) runs from the same origin as the HTML frame, in an
 * iframe with the same sandbox. Its own code comes from the built renderer
 * (`pdf-frame.html` and `/assets/`); a PDF can't reach the network at all.
 * Module scripts in an opaque-origin page are CORS requests, so these responses
 * allow any origin: they are the app's public code, nothing private.
 */
export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Paths of the frame origin that serve the viewer's built files. */
export function isViewerPath(pathname: string): boolean {
  return pathname === "/pdf-frame.html" || pathname.startsWith("/assets/");
}

export function viewerHeaders(contentType: string | undefined): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": VIEWER_CSP,
    "access-control-allow-origin": "*",
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

export function frameResponse(pathname: string): Response {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": FRAME_CSP,
  };
  if (pathname === "/frame.js") {
    return new Response(FRAME_JS, {
      headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (pathname === "/frame.html" || pathname === "/") {
    return new Response(FRAME_HTML, {
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not found", { status: 404, headers });
}
