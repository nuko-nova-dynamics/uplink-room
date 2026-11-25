import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserFrame, type FrameEvent } from "./components/BrowserFrame";
import { MessageBody } from "./components/MessageBody";
import { PdfFrame } from "./components/files/PdfFrame";

/**
 * The isolation check's page (see e2e/isolation.spec.ts). It plants a secret
 * in the app's own localStorage and cookie, then renders a hostile HTML
 * message through the real message renderer. The hostile page tries every way
 * it can think of to reach that secret and writes what it found into its own body,
 * where the test reads it.
 *
 * It also mounts the shared-browser frame (spec #7) the way the app does, and
 * hands it a link that isn't Hyperbeam's, so the frame answers without going
 * to the network. The test probes that frame from inside.
 */
const SECRET = "app-session-secret-8f3a";

try {
  localStorage.setItem("uplink.session", SECRET);
} catch {
  // The test fails later if the app can't plant its own secret.
}
document.cookie = `uplink_session=${SECRET}; path=/`;

const HOSTILE = `<!doctype html>
<html><body style="font:13px sans-serif">
<h1 id="title">Posted page</h1>
<pre id="report">running</pre>
<script>
  const found = {};
  const attempt = (name, fn) => {
    try { const value = fn(); found[name] = value === undefined || value === null ? "no access" : String(value); }
    catch (error) { found[name] = "blocked: " + (error && error.name); }
  };
  // \`window.origin\` is the security origin ("null" when opaque); \`location.origin\` just echoes the URL.
  attempt("origin", () => window.origin);
  attempt("localStorage", () => localStorage.getItem("uplink.session"));
  attempt("sessionStorage", () => sessionStorage.length);
  attempt("cookie", () => document.cookie);
  attempt("parentDocument", () => parent.document.title);
  attempt("parentStorage", () => parent.localStorage.getItem("uplink.session"));
  attempt("topStorage", () => top.localStorage.getItem("uplink.session"));
  attempt("indexedDB", () => { indexedDB.open("uplink-probe"); return "opened"; });
  document.getElementById("report").textContent = JSON.stringify(found);
  document.getElementById("report").dataset.done = "true";
</script>
</body></html>`;

function BrowserFrameCheck() {
  const [events, setEvents] = useState<FrameEvent[]>([]);
  const [attempt, setAttempt] = useState(1);
  return (
    <div style={{ height: 240, marginTop: 16 }}>
      <button id="browser-frame-reconnect" type="button" onClick={() => setAttempt((n) => n + 1)}>
        Reconnect
      </button>
      <BrowserFrame
        connect={{ embedUrl: "https://example.com/not-hyperbeam?token=x", ticket: `hbt_isolation_check_${attempt}` }}
        onEvent={(event) => setEvents((all) => [...all, event])}
        title="Shared browser frame"
      />
      <pre id="browser-frame-report">{JSON.stringify(events)}</pre>
    </div>
  );
}

/**
 * A one-page PDF built by hand, with an OpenAction that asks a viewer to run
 * JavaScript. PDF.js's display layer never runs it; the frame's isolation is
 * what the check relies on either way.
 */
function hostilePdf(): ArrayBuffer {
  const stream = "BT /F1 24 Tf 72 720 Td (Posted PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert('pdf')) >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 16, maxWidth: 720 }}>
    <h1 id="app-title">Message renderer harness</h1>
    <MessageBody format="html" body={HOSTILE} title="Hostile page" />
    <BrowserFrameCheck />
    <div style={{ height: 420, display: "flex", marginTop: 16 }}>
      <PdfFrame
        data={hostilePdf()}
        title="Posted PDF"
        pins={[{ commentId: "c1", n: 1, pin: { kind: "page", page: 1, x: 0.2, y: 0.1 } }]}
        selected={null}
        draft={null}
        placing={false}
        onPlace={() => {}}
        onSelect={() => {}}
      />
    </div>
  </div>,
);
