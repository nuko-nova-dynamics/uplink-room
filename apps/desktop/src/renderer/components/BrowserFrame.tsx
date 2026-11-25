import "./BrowserFrame.css";
import { log } from "../lib/log";
import { useEffect, useRef, useState } from "react";

/** The shared-browser frame's origin and page (src/main/browserFrame.ts). */
export const BROWSER_FRAME_ORIGIN = "uplink-frame://browser";
const BROWSER_FRAME_URL = `${BROWSER_FRAME_ORIGIN}/browser-frame.html`;

export type FrameEvent =
  | { type: "ready" }
  | { type: "state"; state: "waiting" | "connecting" | "playing" | "reconnecting" | "failed" }
  | { type: "closing"; inMs: number | null; reason: string }
  | { type: "ended"; reason: string }
  | { type: "error"; message: string };

/**
 * Hosts a shared browser (spec #7, ADR 0006). Hyperbeam's SDK runs inside
 * the iframe, on `uplink-frame://browser`, never in the app's own origin. The
 * app hands it the embed URL and a one-time ticket, posted to that exact
 * origin so nothing else can receive them, and listens only to that iframe.
 * A new ticket (a reconnect) gets a new iframe.
 *
 * `allow-same-origin` here keeps the frame's own origin (it is not the
 * app's), which the SDK needs to reach Hyperbeam. The sandbox still blocks
 * popups, forms and navigating the app.
 */
export function BrowserFrame({
  connect,
  onEvent,
  title,
}: {
  connect: { embedUrl: string; ticket: string } | null;
  onEvent?: (event: FrameEvent) => void;
  title: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const [state, setState] = useState("waiting");
  const sent = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const send = () => {
    const target = ref.current?.contentWindow;
    if (!target || !ready.current || !connect || sent.current === connect.ticket) return;
    sent.current = connect.ticket;
    target.postMessage(
      {
        source: "uplink-room",
        type: "connect",
        embedUrl: connect.embedUrl,
        ticket: connect.ticket,
      },
      BROWSER_FRAME_ORIGIN,
    );
  };

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const data = event.data as ({ source?: string } & FrameEvent) | null;
      if (data?.source !== "uplink-browser-frame") return;
      if (data.type === "ready") {
        ready.current = true;
        send();
      }
      if (data.type === "state") setState(data.state);
      else if (data.type === "error" || data.type === "ended") setState("failed");
      // The diagnostic log gets the frame's state and reasons, never its URLs or the ticket.
      if (data.type === "state")
        log[data.state === "failed" ? "warn" : "info"]("browser", "shared browser", {
          state: data.state,
        });
      else if (data.type === "ended" || data.type === "closing")
        log.info("browser", `shared browser ${data.type}`, { why: data.reason.slice(0, 60) });
      else if (data.type === "error") log.warn("browser", "shared browser error");
      onEventRef.current?.(data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  });

  // Each ticket gets a fresh frame, so a reconnect starts a new SDK instance instead of
  // posting to a frame that already connected once and ignores later tickets.
  const ticket = connect?.ticket ?? null;
  useEffect(() => {
    setState("waiting");
    ready.current = false;
    sent.current = null;
  }, [ticket]);

  useEffect(send, [connect]);

  return (
    <div className="browser-frame" data-playing={state === "playing"}>
      <iframe
        key={ticket ?? "idle"}
        ref={ref}
        className="browser-frame-content"
        title={title}
        src={BROWSER_FRAME_URL}
        sandbox="allow-scripts allow-same-origin"
        allow="autoplay; clipboard-write"
        referrerPolicy="no-referrer"
      />
      {state !== "playing" ? (
        <div className="browser-frame-placeholder" role="status">
          {state === "failed"
            ? "Browser connection lost"
            : state === "waiting"
              ? "Waiting for the browser"
              : "Connecting to the browser…"}
        </div>
      ) : null}
    </div>
  );
}
