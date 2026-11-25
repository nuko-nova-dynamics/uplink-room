import { useEffect, useRef, useState } from "react";
import { isDark, themeColors, type ViewerPins } from "./pins";

/**
 * A PDF, rendered by PDF.js inside the sandboxed frame (`pdf-frame.ts`). The app
 * downloads the bytes and posts a copy in; the frame has an opaque origin and no
 * network, so a hostile PDF can't read the app or phone home.
 */
export const PDF_FRAME_URL = "uplink-frame://sandbox/pdf-frame.html";

export function PdfFrame({
  data,
  title,
  pins,
  selected,
  draft,
  placing,
  onPlace,
  onSelect,
  onPages,
}: ViewerPins & { data: ArrayBuffer; title: string; onPages?: (pages: number) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const handlers = useRef({ onPlace, onSelect, onPages });
  handlers.current = { onPlace, onSelect, onPages };

  const post = (message: Record<string, unknown>) =>
    // A sandboxed frame has an opaque origin, so the target origin can only be "*".
    frame.current?.contentWindow?.postMessage({ source: "uplink-room", ...message }, "*");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame's own window counts, whatever it claims to be.
      if (event.source !== frame.current?.contentWindow) return;
      const msg = event.data as {
        source?: string;
        type?: string;
        page?: unknown;
        x?: unknown;
        y?: unknown;
        id?: unknown;
        pages?: unknown;
      } | null;
      if (!msg || msg.source !== "uplink-frame") return;
      if (msg.type === "ready") {
        post({ type: "theme", colors: themeColors(), dark: isDark() });
        post({ type: "load", data: data.slice(0) });
        setReady(true);
      } else if (msg.type === "place" && typeof msg.page === "number" && typeof msg.x === "number" && typeof msg.y === "number") {
        handlers.current.onPlace({ kind: "page", page: msg.page, x: msg.x, y: msg.y });
      } else if (msg.type === "select" && typeof msg.id === "string") {
        handlers.current.onSelect(msg.id);
      } else if (msg.type === "loaded" && typeof msg.pages === "number") {
        handlers.current.onPages?.(msg.pages);
      } else if (msg.type === "failed") {
        setFailed(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // The frame loads its PDF once; a new file remounts this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    const pagePins = pins.flatMap((p) =>
      p.pin.kind === "page" ? [{ id: p.commentId, n: p.n, page: p.pin.page, x: p.pin.x, y: p.pin.y }] : [],
    );
    post({ type: "pins", pins: pagePins, selected, draft: draft?.kind === "page" ? draft : null });
  }, [ready, pins, selected, draft]);

  useEffect(() => {
    if (ready) post({ type: "placing", placing });
  }, [ready, placing]);

  useEffect(() => {
    if (ready && selected) post({ type: "reveal", id: selected });
  }, [ready, selected]);

  // Follow the app's theme switch.
  useEffect(() => {
    const observer = new MutationObserver(() => post({ type: "theme", colors: themeColors(), dark: isDark() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="viewer-fill">
      {failed ? <div className="viewer-note">This PDF can't be opened. Download it to read it elsewhere.</div> : null}
      <iframe
        ref={frame}
        className="pdf-frame"
        title={title}
        src={PDF_FRAME_URL}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
