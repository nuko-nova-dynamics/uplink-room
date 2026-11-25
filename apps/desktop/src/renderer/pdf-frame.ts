/**
 * The PDF viewer frame (spec #9). It runs at `uplink-frame://sandbox/pdf-frame.html`
 * inside an iframe sandboxed with `allow-scripts` only, so it has an opaque origin:
 * it can't read the app's storage or cookies or reach the parent window. Its CSP
 * has `connect-src 'none'`, so a PDF can't reach the network either. The app
 * downloads the PDF and posts the bytes in; PDF.js parses them here.
 *
 * Messages from the app (`source: "uplink-room"`): `load` (the bytes), `pins`
 * (numbered pins to draw, the selected one, a draft), `placing` (clicks place a
 * pin), `reveal` (scroll to a pin), `theme` (colours). Messages to the app
 * (`source: "uplink-frame"`): `ready`, `loaded` (page count), `place` (page and
 * fractions), `select` (a pin's comment), `failed`.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
// The worker's code is bundled in as text and started from a blob URL: the frame
// can't fetch it, and a worker script must otherwise share the page's origin.
import workerCode from "pdfjs-dist/build/pdf.worker.min.mjs?raw";

type Pin = { id: string; n: number; page: number; x: number; y: number };
type Incoming =
  | { type: "load"; data: ArrayBuffer }
  | { type: "pins"; pins: Pin[]; selected: string | null; draft: Omit<Pin, "id" | "n"> | null }
  | { type: "placing"; placing: boolean }
  | { type: "reveal"; id: string }
  | { type: "theme"; colors: Record<string, string>; dark: boolean };

const parent = window.parent;
const tell = (message: Record<string, unknown>) =>
  parent.postMessage({ source: "uplink-frame", ...message }, "*");

const pagesEl = document.getElementById("pages")!;
const statusEl = document.getElementById("status")!;
const pageEls: HTMLDivElement[] = [];
let pins: Pin[] = [];
let selected: string | null = null;
let draft: Omit<Pin, "id" | "n"> | null = null;
let loaded = false;

/**
 * In an opaque-origin page a module worker from a blob URL fails to start, while a
 * classic one runs. PDF.js ships its worker as a module, so it is turned into a
 * classic script: its one `export` statement goes, and `import.meta.url` (used only
 * to locate optional wasm decoders, which are off) becomes the worker's own URL.
 * If the pinned build ever changes shape, PDF.js parses on this thread instead,
 * still inside the sandbox.
 */
function startWorker(): void {
  const exportStatement = /export\s*\{\s*WorkerMessageHandler\s*\};?\s*$/;
  if (!exportStatement.test(workerCode)) return;
  const classic = workerCode.replace(exportStatement, "").replaceAll("import.meta.url", "self.location.href");
  try {
    const url = URL.createObjectURL(new Blob([classic], { type: "text/javascript" }));
    GlobalWorkerOptions.workerPort = new Worker(url);
  } catch {
    // Falls back to parsing on this thread.
  }
}

async function render(data: ArrayBuffer): Promise<void> {
  let pdf: PDFDocumentProxy;
  try {
    // No font, CMap or wasm URLs: the frame has no network, and PDF.js falls back to
    // built-in renderers. A PDF's own scripts and forms are never run by the display layer.
    pdf = await getDocument({ data: new Uint8Array(data), useWasm: false, enableXfa: false }).promise;
  } catch (error) {
    statusEl.textContent = "This PDF can't be opened.";
    tell({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  statusEl.remove();
  const width = Math.min(900, document.documentElement.clientWidth - 36);
  const ratio = window.devicePixelRatio || 1;
  const pending = new Map<Element, () => Promise<void>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const draw = pending.get(entry.target);
        if (!entry.isIntersecting || !draw) continue;
        pending.delete(entry.target);
        observer.unobserve(entry.target);
        void draw();
      }
    },
    { rootMargin: "800px 0px" },
  );

  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const el = document.createElement("div");
    el.className = "page";
    el.dataset["page"] = String(number);
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;
    const label = document.createElement("span");
    label.className = "page-label";
    label.textContent = `Page ${number}`;
    el.append(label);
    el.addEventListener("click", (event) => {
      if (!document.body.classList.contains("placing")) return;
      if ((event.target as HTMLElement).closest(".pin")) return;
      const box = el.getBoundingClientRect();
      tell({
        type: "place",
        page: number,
        x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      });
    });
    pagesEl.append(el);
    pageEls.push(el);
    pending.set(el, async () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      el.prepend(canvas);
      await page.render({
        canvas,
        viewport: page.getViewport({ scale: (width / base.width) * ratio }),
      }).promise;
      el.dataset["rendered"] = "true";
    });
    observer.observe(el);
  }
  loaded = true;
  drawPins();
  tell({ type: "loaded", pages: pdf.numPages });
}

function pinEl(label: string, x: number, y: number, className: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `pin ${className}`;
  el.textContent = label;
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  return el;
}

function drawPins(): void {
  if (!loaded) return;
  for (const el of document.querySelectorAll(".pin")) el.remove();
  for (const pin of pins) {
    const page = pageEls[pin.page - 1];
    if (!page) continue;
    const el = pinEl(String(pin.n), pin.x, pin.y, pin.id === selected ? "selected" : "");
    el.title = `Comment ${pin.n}`;
    el.addEventListener("click", () => tell({ type: "select", id: pin.id }));
    page.append(el);
  }
  if (draft) pageEls[draft.page - 1]?.append(pinEl("+", draft.x, draft.y, "draft selected"));
}

addEventListener("message", (event: MessageEvent) => {
  if (event.source !== parent) return;
  const data = event.data as ({ source?: string } & Incoming) | null;
  if (!data || data.source !== "uplink-room") return;
  switch (data.type) {
    case "load":
      if (loaded || !(data.data instanceof ArrayBuffer)) return;
      void render(data.data);
      return;
    case "pins":
      pins = Array.isArray(data.pins) ? data.pins : [];
      selected = data.selected;
      draft = data.draft;
      drawPins();
      return;
    case "placing":
      document.body.classList.toggle("placing", data.placing === true);
      return;
    case "reveal": {
      const pin = pins.find((p) => p.id === data.id);
      const page = pin ? pageEls[pin.page - 1] : undefined;
      if (pin && page) {
        const box = page.getBoundingClientRect();
        window.scrollBy({ top: box.top + box.height * pin.y - window.innerHeight / 3, behavior: "smooth" });
      }
      return;
    }
    case "theme":
      document.documentElement.style.colorScheme = data.dark === false ? "light" : "dark";
      for (const [name, value] of Object.entries(data.colors ?? {})) {
        if (/^[a-z-]+$/.test(name) && /^#[0-9a-f]{3,8}$/i.test(value)) {
          document.documentElement.style.setProperty(`--${name}`, value);
        }
      }
      return;
  }
});

startWorker();
tell({ type: "ready" });
