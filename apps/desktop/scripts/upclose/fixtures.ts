import type { MeasuredElement, Measurement, MeasuredText, Rgba } from "./types.ts";
import type { Raster } from "./image.ts";

export const background: Rgba = { r: 21, g: 22, b: 25, a: 1 };
export const foreground: Rgba = { r: 235, g: 236, b: 238, a: 1 };
export function element(selector: string, patch: Partial<MeasuredElement> = {}): MeasuredElement {
  return {
    selector,
    tag: "button",
    rect: { x: 10, y: 20, width: 28, height: 28 },
    background,
    styles: {
      fontFamily: '"Atkinson Hyperlegible Next", sans-serif',
      fontSize: "13px",
      fontWeight: "400",
      lineHeight: "14px",
      color: "#ebecee",
      opacity: "1",
      paddingTop: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      paddingRight: "0px",
      gap: "6px",
      borderTopWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderRightWidth: "1px",
      borderTopColor: "#2b2e33",
      borderBottomColor: "#2b2e33",
      borderLeftColor: "#2b2e33",
      borderRightColor: "#2b2e33",
      borderTopLeftRadius: "7px",
      borderTopRightRadius: "7px",
      borderBottomLeftRadius: "7px",
      borderBottomRightRadius: "7px",
    },
    ...patch,
  };
}
export function text(selector = ".label"): MeasuredText {
  return {
    ...element(selector, { tag: "span", rect: { x: 47, y: 27, width: 26, height: 14 } }),
    text: "Go",
    inkRect: { x: 47, y: 27, width: 26, height: 14 },
    baseline: 38,
    capHeight: 8,
    xHeight: 6,
    clipped: false,
  };
}
export function measurement(patch: Partial<Measurement> = {}): Measurement {
  const target = element(".btn.icon");
  const m: Measurement = {
    component: "button",
    state: "default",
    theme: "dark",
    scale: 2,
    gymState: "buttons",
    viewport: { width: 960, height: 600 },
    devicePixelRatio: 2,
    crop: { x: 8, y: 18, width: 84, height: 32, margin: 2 },
    target,
    icons: [
      {
        ...element(".btn.icon svg", {
          tag: "svg",
          rect: { x: 17, y: 27, width: 14, height: 14 },
          styles: {},
        }),
        viewBox: "0 0 16 16",
        attrWidth: "14",
        attrHeight: "14",
        strokeWidths: [1.5],
        bbox: { x: 2, y: 2, width: 12, height: 12 },
        iconName: "test",
      },
    ],
    texts: [],
    rowPeers: [target],
    columnPeers: [],
    hits: [],
    tokens: {
      "--text": "#ebecee",
      "--ctl-h": "28px",
      "--fs": "13px",
      "--head-h": "52px",
      "--ui": '"Atkinson Hyperlegible Next", sans-serif',
      "--mono": '"Atkinson Hyperlegible Mono", monospace',
    },
    files: { crop: "captures/button/default/dark/2x.png" },
    ...patch,
  };
  m.hits = gridHits(m.target);
  return m;
}
export function gridHits(target: MeasuredElement) {
  return Array.from({ length: 25 }, (_, i) => ({
    x: target.rect.x + target.rect.width * (((i % 5) + 0.5) / 5),
    y: target.rect.y + target.rect.height * ((Math.floor(i / 5) + 0.5) / 5),
    hitsTarget: true,
    hit: target.selector,
  }));
}
export function labeled(): Measurement {
  const m = measurement();
  m.target.selector = ".btn";
  m.target.rect.width = 80;
  m.icons[0]!.selector = ".btn svg";
  m.icons[0]!.rect.x = 27;
  m.texts = [text()];
  m.hits = gridHits(m.target);
  return m;
}
export function raster(width = 168, height = 64, bg: Rgba = background): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([bg.r, bg.g, bg.b, Math.round(bg.a * 255)], i);
  return { width, height, data };
}
export function paint(
  r: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
  c: Rgba = foreground,
): void {
  for (let py = y; py < y + height; py++)
    for (let px = x; px < x + width; px++)
      r.data.set([c.r, c.g, c.b, Math.round(c.a * 255)], (py * r.width + px) * 4);
}
export function imageFor(m: Measurement): Raster {
  const r = raster();
  for (const icon of m.icons)
    paint(r, (icon.rect.x - m.crop.x + 2) * 2, (icon.rect.y - m.crop.y + 2) * 2, 20, 20);
  for (const t of m.texts)
    paint(
      r,
      (t.inkRect.x - m.crop.x) * 2,
      (t.inkRect.y - m.crop.y) * 2,
      t.inkRect.width * 2,
      t.inkRect.height * 2,
    );
  return r;
}
