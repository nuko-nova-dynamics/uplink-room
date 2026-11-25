/**
 * The shared-browser frame (spec #7, ADR 0006). It runs at
 * `uplink-frame://browser/`, an origin apart from the app's, because
 * Hyperbeam's web SDK downloads its client code at runtime and runs it here.
 *
 * The app posts one `connect` message with the embed URL and a one-time
 * ticket. The SDK hands the ticket to Hyperbeam, which checks it with our
 * auth webhook. The frame reports its state back; it never sends anything
 * the app gave it.
 */
import Hyperbeam from "@hyperbeam/web";

type FrameState =
  | { type: "state"; state: "waiting" | "connecting" | "playing" | "reconnecting" | "failed" }
  | { type: "closing"; inMs: number | null; reason: string }
  | { type: "ended"; reason: string }
  | { type: "error"; message: string };

const parent = window.parent;
const tell = (message: FrameState | { type: "ready" }) =>
  parent.postMessage({ source: "uplink-browser-frame", ...message }, "*");

/** Only Hyperbeam session pages, as the REST API returns them. */
const EMBED_URL = /^https:\/\/[a-z0-9-]+\.hyperbeam\.com\//;

let connected = false;

addEventListener("message", (event) => {
  const data = event.data as { source?: string; type?: string; embedUrl?: unknown; ticket?: unknown } | null;
  if (connected || event.source !== parent || data?.source !== "uplink-room" || data.type !== "connect") return;
  if (typeof data.embedUrl !== "string" || typeof data.ticket !== "string" || !EMBED_URL.test(data.embedUrl)) {
    tell({ type: "error", message: "The room sent a browser link this frame won't open." });
    return;
  }
  connected = true;
  void connect(data.embedUrl, data.ticket);
});

async function connect(embedUrl: string, ticket: string) {
  tell({ type: "state", state: "connecting" });
  try {
    await Hyperbeam(document.getElementById("browser") as HTMLDivElement, embedUrl, {
      webhookUserdata: { ticket },
      timeout: 10_000,
      onConnectionStateChange: (e) =>
        tell({ type: "state", state: e.state }),
      onCloseWarning: (e) =>
        tell({ type: "closing", inMs: e.deadline ? e.deadline.delay : null, reason: e.type }),
      onDisconnect: (e) => tell({ type: "ended", reason: e.type }),
    });
  } catch (error) {
    tell({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

tell({ type: "ready" });
tell({ type: "state", state: "waiting" });
