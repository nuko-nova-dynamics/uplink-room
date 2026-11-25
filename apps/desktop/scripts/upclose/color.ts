import type { Rgba } from "./types.ts";

/** Resolved sRGB values emitted by Chromium, plus hex root tokens. */
export function color(value: string): Rgba {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (/^#[\da-f]{3,8}$/.test(text)) {
    let hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length !== 6 && hex.length !== 8) throw new Error(`Invalid hex color: ${value}`);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
    };
  }
  const match = /^(rgba?|color)\((.*)\)$/.exec(text);
  if (!match) throw new Error(`Expected a resolved sRGB color, received: ${value}`);
  const srgb = match[1] === "color";
  let body = match[2]!;
  if (srgb) {
    if (!body.startsWith("srgb ")) throw new Error(`Unsupported color space: ${value}`);
    body = body.slice(5);
  }
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new Error(`Invalid color: ${value}`);
  const channel = (v: string) => parseFloat(v) * (v.endsWith("%") ? 2.55 : srgb ? 255 : 1);
  const alpha = parts[3] ? parseFloat(parts[3]) / (parts[3].endsWith("%") ? 100 : 1) : 1;
  const result = { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: alpha };
  if (!Object.values(result).every(Number.isFinite)) throw new Error(`Invalid color: ${value}`);
  return result;
}

export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a + under.a * (1 - top.a);
  if (!a) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (x: number, y: number) => (x * top.a + y * under.a * (1 - top.a)) / a;
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
}

/** One element between a text and the window: its own background and its own CSS opacity. */
export interface Layer {
  background: Rgba;
  opacity: number;
}

/**
 * The text pixel and the surface beside it as the browser paints them. CSS opacity fades an element
 * as a group, its own background and everything in it together, onto what lies beneath, so a
 * translucent control with an opaque fill fades both the label and the fill. `layers` run from the
 * text's element outward; whatever they leave uncovered is the white window.
 */
export function throughLayers(fg: Rgba, layers: Layer[]): { text: Rgba; surface: Rgba } {
  let text = fg,
    surface: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  for (const layer of layers) {
    text = over(text, layer.background);
    surface = over(surface, layer.background);
    if (layer.opacity < 1) {
      text = { ...text, a: text.a * layer.opacity };
      surface = { ...surface, a: surface.a * layer.opacity };
    }
  }
  const white = { r: 255, g: 255, b: 255, a: 1 };
  return { text: over(text, white), surface: over(surface, white) };
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const luminance = (c: Rgba) =>
    [c.r, c.g, c.b].reduce((sum, v, i) => {
      const n = v / 255;
      return (
        sum +
        (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!
      );
    }, 0);
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
