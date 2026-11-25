import { color } from "../color.ts";
import type { Rgba } from "../types.ts";
import type { Finding, Measurement } from "../types.ts";
import { deviceRect, inkBounds, iconInkRect } from "../image.ts";
import { finding, PIXEL_TOLERANCE } from "./shared.ts";
import type { Images } from "./shared.ts";

// The source Icon.tsx uses 1.5 user-unit strokes. Ignore only serialization noise.
export const STROKE_WIDTH = 1.5;
// Bbox area varies with shape; allow 35% around the family's median before flagging an outlier.
export const OPTICAL_AREA_TOLERANCE = 0.35;
// Three distinct drawings prevent a single pair from establishing an arbitrary reference.
export const MIN_FAMILY_MEMBERS = 3;

export function iconDrawing(m: Measurement): Finding[] {
  const result: Finding[] = [];
  for (const icon of m.icons) {
    // Character illustrations use their own coordinates, masks and stroke scales.
    if (!icon.iconName && !m.iconContexts?.[icon.selector]?.family) continue;
    const view = icon.viewBox?.trim().split(/[ ,]+/).map(Number);
    if (
      !view ||
      view.length !== 4 ||
      !view.every(Number.isFinite) ||
      view[2]! <= 0 ||
      view[3]! <= 0
    ) {
      result.push(
        finding(
          m,
          "icon-drawing",
          icon.selector,
          { viewBox: icon.viewBox },
          "a finite viewBox with positive size in user units",
          "Icon has no valid viewBox.",
        ),
      );
      continue;
    }
    if (icon.iconName && view.join(" ") !== "0 0 16 16")
      result.push(
        finding(
          m,
          "icon-drawing",
          icon.selector,
          { viewBox: icon.viewBox },
          "0 0 16 16 user units",
          "Icon family uses a different viewBox.",
        ),
      );
    const strokes = (
      m.iconContexts?.[icon.selector]?.paintedStrokeWidths ?? icon.strokeWidths
    ).filter((width) => width !== 0);
    if (
      strokes.some(
        (width) => !Number.isFinite(width) || Math.abs(width - STROKE_WIDTH) > PIXEL_TOLERANCE,
      )
    )
      result.push(
        finding(
          m,
          "icon-drawing",
          icon.selector,
          { strokeWidths: strokes.map((width) => `${width} user units`) },
          "1.5 user units on every stroked child",
          "Icon strokes differ from the family stroke width.",
        ),
      );
    if (!icon.bbox) {
      result.push(
        finding(
          m,
          "icon-drawing",
          icon.selector,
          "missing drawn bounds",
          "drawn bounds in user units",
          "Icon is missing its measured drawing bounds.",
        ),
      );
      continue;
    }
    const half = Math.max(0, ...strokes) / 2;
    const b = icon.bbox;
    if (
      b.x - half < view[0]! - PIXEL_TOLERANCE ||
      b.y - half < view[1]! - PIXEL_TOLERANCE ||
      b.x + b.width + half > view[0]! + view[2]! + PIXEL_TOLERANCE ||
      b.y + b.height + half > view[1]! + view[3]! + PIXEL_TOLERANCE
    )
      result.push(
        finding(
          m,
          "icon-drawing",
          icon.selector,
          {
            x: b.x - half,
            y: b.y - half,
            width: b.width + half * 2,
            height: b.height + half * 2,
            unit: "SVG user units",
          },
          { viewBox: icon.viewBox, tolerance: "0.01 user units" },
          "Icon drawing and half its stroke extend beyond the viewBox.",
        ),
      );
  }
  return result;
}

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export type OpticalSample = {
  m: Measurement;
  selector: string;
  name: string;
  area: number;
  family: string;
};

/** Keep only small numeric observations, so a run never retains all decoded PNG buffers. */
// DESIGN.md, Scales: chevrons, the ellipsis and the call's handset are compact glyphs, the family's
// stroke on a smaller ink box. Their shapes differ too much (a caret, three dots, a handset) for one
// optical area, so they're held to the stroke and bounds checks only and left out of this comparison.
const COMPACT_GLYPHS = new Set(["chevron", "chevron-left", "chevron-down", "more", "leave"]);

export function opticalSamples(m: Measurement, images: Images): OpticalSample[] {
  if (m.scale !== 2 || !images.crop) return [];
  const samples: OpticalSample[] = [];
  for (const icon of m.icons) {
    if (icon.iconName && COMPACT_GLYPHS.has(icon.iconName)) continue;
    const family = m.iconContexts?.[icon.selector]?.family ?? (icon.iconName ? "Icon" : undefined);
    if (!family || !icon.rect.width || !icon.rect.height) continue;
    let foreground: Rgba | undefined;
    try {
      foreground = color(icon.styles.color ?? "");
    } catch {
      // Older captures may not contain a resolved color. Keep their background comparison.
    }
    const region = iconInkRect(m, icon);
    // A clipped drawing cannot supply its complete optical area.
    if (
      region.x < m.crop.x ||
      region.y < m.crop.y ||
      region.x + region.width > m.crop.x + m.crop.width ||
      region.y + region.height > m.crop.y + m.crop.height
    )
      continue;
    const ink = inkBounds(images.crop, deviceRect(m, region), icon.background, foreground);
    const layout = m.layoutRects?.[icon.selector] ?? icon.rect;
    if (ink)
      samples.push({
        m,
        selector: icon.selector,
        name: icon.iconName ?? icon.selector,
        area: (ink.width * ink.height) / (4 * layout.width * layout.height),
        family,
      });
  }
  return samples;
}

export function iconOpticalSizes(
  samples: { measurement: Measurement; images: Images }[],
): Finding[] {
  return compareOpticalSamples(
    samples.flatMap(({ measurement, images }) => opticalSamples(measurement, images)),
  );
}

export function compareOpticalSamples(observations: OpticalSample[]): Finding[] {
  const families = new Map<string, OpticalSample[]>();
  for (const observation of observations) {
    const group = families.get(observation.family) ?? [];
    group.push(observation);
    families.set(observation.family, group);
  }
  const result: Finding[] = [];
  for (const [family, samples] of families) {
    const names = new Map<string, number[]>();
    for (const sample of samples) {
      const areas = names.get(sample.name) ?? [];
      areas.push(sample.area);
      names.set(sample.name, areas);
    }
    if (names.size < MIN_FAMILY_MEMBERS) continue;
    // Each drawing gets one vote, however often it appeared in captured states.
    const reference = median([...names.values()].map(median));
    for (const sample of samples)
      if (Math.abs(sample.area / reference - 1) > OPTICAL_AREA_TOLERANCE)
        result.push(
          finding(
            sample.m,
            "icon-drawing",
            sample.selector,
            { family, normalizedInkBoxArea: `${(sample.area * 100).toFixed(2)}% of icon box` },
            { median: `${(reference * 100).toFixed(2)}% of icon box`, relativeTolerance: "±35%" },
            "Icon optical area is outside its family's tolerance.",
          ),
        );
  }
  return result;
}
