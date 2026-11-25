import { capCenter, capHeight } from "./text-metrics.ts";
import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import type { MeasuredIcon, Measurement, Rect, Rgba } from "./types.ts";
import { contentBox } from "./checks/shared.ts";

export type Raster = { width: number; height: number; data: Uint8Array };
export type Png = Uint8Array | Raster;
export type InkBounds = Rect & { center: { x: number; y: number }; coverage: number };
// Eight channel levels discard compression-independent background/antialias noise.
export const INK_THRESHOLD = 8;
export const GRID_COLOR = [255, 0, 168, 255] as const;
export const OVERLAY_COLORS = {
  padding: [80, 210, 100, 255],
  margin: [255, 165, 40, 255],
  center: [40, 190, 255, 255],
  icon: [255, 70, 190, 255],
  baseline: [230, 220, 60, 255],
} as const;

/** Normalize grayscale, indexed, RGB and RGBA PNGs to eight-bit RGBA. */
export function decode(bytes: Uint8Array): Raster {
  const image = decodePng(bytes, { checkCrc: true });
  const { width, height, depth, channels } = image;
  const data = new Uint8Array(width * height * 4);
  const paletteData = image.palette ? convertIndexedToRgb(image) : undefined;
  const paletteChannels = image.palette?.[0]?.length ?? 0;
  const max = 2 ** depth - 1;
  const sample = (pixel: number, channel: number) => {
    if (depth >= 8) return image.data[pixel * channels + channel]!;
    const row = Math.floor(pixel / width);
    const bit = (pixel % width) * channels * depth + channel * depth;
    const stride = Math.ceil((width * channels * depth) / 8);
    return (image.data[row * stride + Math.floor(bit / 8)]! >> (8 - depth - (bit % 8))) & max;
  };
  for (let i = 0; i < width * height; i++) {
    if (paletteData) {
      data.set(paletteData.subarray(i * paletteChannels, i * paletteChannels + 3), i * 4);
      data[i * 4 + 3] = paletteChannels === 4 ? paletteData[i * 4 + 3]! : 255;
      continue;
    }
    const gray = channels <= 2;
    const raw = [sample(i, 0), sample(i, gray ? 0 : 1), sample(i, gray ? 0 : 2)];
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round((raw[c]! / max) * 255);
    const transparent =
      image.transparency?.length &&
      (gray ? raw[0] === image.transparency[0] : raw.every((v, c) => v === image.transparency![c]));
    data[i * 4 + 3] = transparent
      ? 0
      : channels === 2 || channels === 4
        ? Math.round((sample(i, channels - 1) / max) * 255)
        : 255;
  }
  return { width, height, data };
}

export const encode = (raster: Raster): Uint8Array =>
  encodePng({ ...raster, channels: 4, depth: 8 });
const rasterOf = (png: Png) => (png instanceof Uint8Array ? decode(png) : png);
const setPixel = (r: Raster, x: number, y: number, color: ArrayLike<number>) => {
  if (x >= 0 && y >= 0 && x < r.width && y < r.height) r.data.set(color, (y * r.width + x) * 4);
};

/** Each source pixel gets factor by factor unchanged pixels; grid pixels are inserted between them. */
export function zoom(png: Png, factor: 4 | 8): Uint8Array {
  if (factor !== 4 && factor !== 8) throw new Error("Zoom factor must be 4 or 8");
  const source = rasterOf(png);
  const width = source.width * (factor + 1) - 1;
  const height = source.height * (factor + 1) - 1;
  const result = { width, height, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / (factor + 1));
      const sy = Math.floor(y / (factor + 1));
      setPixel(
        result,
        x,
        y,
        x % (factor + 1) === factor || y % (factor + 1) === factor
          ? GRID_COLOR
          : source.data.subarray((sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4),
      );
    }
  return encode(result);
}

/** Limit raster sampling to the SVG drawing, so adjacent borders cannot become icon ink. */
export function iconInkRect(m: Measurement, icon: MeasuredIcon): Rect {
  const view = icon.viewBox?.trim().split(/[ ,]+/).map(Number);
  const b = icon.bbox;
  if (
    !b ||
    view?.length !== 4 ||
    !view.every(Number.isFinite) ||
    !view[2] ||
    !view[3] ||
    (icon.styles.transform && !["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(icon.styles.transform))
  )
    return icon.rect;
  const stroke =
    Math.max(0, ...(m.iconContexts?.[icon.selector]?.paintedStrokeWidths ?? icon.strokeWidths)) / 2;
  const scale = Math.min(icon.rect.width / view[2], icon.rect.height / view[3]);
  return {
    x: icon.rect.x + (icon.rect.width - view[2] * scale) / 2 + (b.x - stroke - view[0]!) * scale,
    y: icon.rect.y + (icon.rect.height - view[3] * scale) / 2 + (b.y - stroke - view[1]!) * scale,
    width: (b.width + stroke * 2) * scale,
    height: (b.height + stroke * 2) * scale,
  };
}

/** Measure foreground-colored ink when supplied, otherwise use background distance. Coordinates are device pixels. */
export function inkBounds(
  png: Png,
  rect: Rect,
  background: Rgba,
  foreground?: Rgba,
): InkBounds | null {
  const r = rasterOf(png);
  // Infer the surface under the glyph from the crop itself. A control's fill can
  // differ from the recorded ancestor background. Antialiased pixels lie on
  // the color segment from this surface to the icon's currentColor.
  let surface = background;
  if (foreground) {
    const counts = new Map<string, { count: number; color: Rgba }>();
    for (
      let y = Math.max(0, Math.floor(rect.y));
      y < Math.min(r.height, Math.ceil(rect.y + rect.height));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(rect.x));
        x < Math.min(r.width, Math.ceil(rect.x + rect.width));
        x++
      ) {
        const i = (y * r.width + x) * 4;
        const value = { r: r.data[i]!, g: r.data[i + 1]!, b: r.data[i + 2]!, a: 1 };
        if (
          Math.max(
            Math.abs(value.r - foreground.r),
            Math.abs(value.g - foreground.g),
            Math.abs(value.b - foreground.b),
          ) <= INK_THRESHOLD
        )
          continue;
        const key = `${value.r},${value.g},${value.b}`;
        const entry = counts.get(key) ?? { count: 0, color: value };
        entry.count++;
        counts.set(key, entry);
      }
    surface = [...counts.values()].sort((a, b) => b.count - a.count)[0]?.color ?? background;
  }
  const direction = foreground
    ? [foreground.r - surface.r, foreground.g - surface.g, foreground.b - surface.b]
    : [];
  const lengthSquared = direction.reduce((sum, n) => sum + n * n, 0);
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1,
    sumX = 0,
    sumY = 0,
    coverage = 0;
  for (
    let y = Math.max(0, Math.floor(rect.y));
    y < Math.min(r.height, Math.ceil(rect.y + rect.height));
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(rect.x));
      x < Math.min(r.width, Math.ceil(rect.x + rect.width));
      x++
    ) {
      const i = (y * r.width + x) * 4;
      const alpha = r.data[i + 3]! / 255;
      const delta =
        Math.max(
          Math.abs(r.data[i]! - background.r),
          Math.abs(r.data[i + 1]! - background.g),
          Math.abs(r.data[i + 2]! - background.b),
        ) * alpha;
      let weight = delta / 255;
      if (foreground) {
        const pixel = [
          r.data[i]! - surface.r,
          r.data[i + 1]! - surface.g,
          r.data[i + 2]! - surface.b,
        ];
        const amount = lengthSquared
          ? pixel.reduce((sum, n, c) => sum + n * direction[c]!, 0) / lengthSquared
          : 0;
        const residual = Math.max(...pixel.map((n, c) => Math.abs(n - amount * direction[c]!)));
        if (
          !alpha ||
          amount <= 0 ||
          amount > 1.05 ||
          residual > INK_THRESHOLD ||
          amount * Math.max(...direction.map(Math.abs)) <= INK_THRESHOLD
        )
          continue;
        weight = amount * alpha;
      } else if (delta <= INK_THRESHOLD) continue;
      coverage += weight;
      sumX += (x + 0.5) * weight;
      sumY += (y + 0.5) * weight;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return coverage
    ? {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        center: { x: sumX / coverage, y: sumY / coverage },
        coverage,
      }
    : null;
}

/** Convert a viewport rectangle into the supplied crop's device pixels. */
export function deviceRect(m: Measurement, rect: Rect, scale = m.scale): Rect {
  return {
    x: (rect.x - m.crop.x) * scale,
    y: (rect.y - m.crop.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

const FONT: Record<string, string> = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  G: "011100101101011",
  I: "111010010010111",
  L: "100100100100111",
  M: "101111111101101",
  N: "101111111111101",
  O: "010101101101010",
  P: "110101110100100",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  X: "101101010101101",
};

/** Preserve the 2x crop and append a bitmap legend. No platform font renderer is involved. */
export function overlay(png2x: Png, m: Measurement): Uint8Array {
  const source = rasterOf(png2x);
  const result = {
    width: Math.max(source.width, 360),
    height: source.height + 30,
    data: new Uint8Array(Math.max(source.width, 360) * (source.height + 30) * 4),
  };
  for (let i = 0; i < result.data.length; i += 4) result.data.set([24, 24, 24, 255], i);
  for (let y = 0; y < source.height; y++)
    result.data.set(
      source.data.subarray(y * source.width * 4, (y + 1) * source.width * 4),
      y * result.width * 4,
    );
  const line = (x1: number, y1: number, x2: number, y2: number, color: readonly number[]) => {
    const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      setPixel(result, Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), color);
    }
  };
  const box = (css: Rect, color: readonly number[], centers = false) => {
    const r = deviceRect(m, css, 2),
      right = r.x + r.width,
      bottom = r.y + r.height;
    line(r.x, r.y, right, r.y, color);
    line(right, r.y, right, bottom, color);
    line(right, bottom, r.x, bottom, color);
    line(r.x, bottom, r.x, r.y, color);
    if (centers) {
      line(r.x, r.y + r.height / 2, right, r.y + r.height / 2, color);
      line(r.x + r.width / 2, r.y, r.x + r.width / 2, bottom, color);
    }
  };
  const e = m.target,
    s = e.styles;
  const n = (v: string | undefined) => parseFloat(v ?? "0");
  const inset = {
    left: n(s.borderLeftWidth),
    right: n(s.borderRightWidth),
    top: n(s.borderTopWidth),
    bottom: n(s.borderBottomWidth),
  };
  box(
    {
      x: e.rect.x + inset.left,
      y: e.rect.y + inset.top,
      width: e.rect.width - inset.left - inset.right,
      height: e.rect.height - inset.top - inset.bottom,
    },
    OVERLAY_COLORS.padding,
  );
  box(
    {
      x: e.rect.x - n(s.marginLeft),
      y: e.rect.y - n(s.marginTop),
      width: e.rect.width + n(s.marginLeft) + n(s.marginRight),
      height: e.rect.height + n(s.marginTop) + n(s.marginBottom),
    },
    OVERLAY_COLORS.margin,
  );
  box(contentBox(e), OVERLAY_COLORS.center, true);
  const seen = new Set<string>();
  for (const context of Object.values(m.iconContexts ?? {}))
    if (!seen.has(context.container.selector)) {
      box(contentBox(context.container), OVERLAY_COLORS.center, true);
      seen.add(context.container.selector);
    }
  for (const icon of m.icons) box(icon.rect, OVERLAY_COLORS.icon, true);
  for (const text of m.texts) {
    const rect = deviceRect(m, text.inkRect, 2),
      y = (text.baseline - m.crop.y) * 2;
    line(rect.x, y, rect.x + rect.width, y, OVERLAY_COLORS.baseline);
    const height = capHeight(text),
      middle = capCenter(text);
    if (height !== undefined && middle !== undefined) {
      const top = (text.baseline - height - m.crop.y) * 2;
      line(rect.x, top, rect.x + rect.width, top, OVERLAY_COLORS.baseline);
      line(
        rect.x,
        (middle - m.crop.y) * 2,
        rect.x + rect.width,
        (middle - m.crop.y) * 2,
        OVERLAY_COLORS.center,
      );
    }
  }
  Object.entries(OVERLAY_COLORS).forEach(([name, color], index) => {
    const x = 7 + (index % 3) * 117,
      y = source.height + 5 + Math.floor(index / 3) * 12;
    for (let dx = 0; dx < 6; dx++)
      for (let dy = 0; dy < 6; dy++) setPixel(result, x + dx, y + dy, color);
    [...name.toUpperCase()].forEach((letter, position) => {
      const glyph = FONT[letter] ?? "000000000000000";
      [...glyph].forEach((bit, i) => {
        if (bit === "1")
          setPixel(
            result,
            x + 10 + position * 4 + (i % 3),
            y + Math.floor(i / 3),
            [245, 245, 245, 255],
          );
      });
    });
  });
  return encode(result);
}
