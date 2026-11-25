import type { Finding, Measurement } from "../types.ts";
import { center, finding, isControl, PIXEL_TOLERANCE, px } from "./shared.ts";

// The issue applies the WCAG 2.5.8 size minimum to every control; exceptions require a waiver.
export const MIN_TARGET_SIZE = 24;
export const HIT_GRID_SIZE = 5;

export function clickableArea(m: Measurement): Finding[] {
  if (!isControl(m, m.target)) return [];
  const result: Finding[] = [],
    r = m.target.rect;
  if (r.width < MIN_TARGET_SIZE || r.height < MIN_TARGET_SIZE)
    result.push(
      finding(
        m,
        "clickable-area",
        m.target.selector,
        { width: px(r.width), height: px(r.height) },
        { width: "≥24px", height: "≥24px" },
        "Control is smaller than the minimum clickable area.",
      ),
    );
  const c = center(r);
  const hasCenter = m.hits.some(
    (hit) => Math.abs(hit.x - c.x) <= PIXEL_TOLERANCE && Math.abs(hit.y - c.y) <= PIXEL_TOLERANCE,
  );
  // Capture may choose different inset fractions. Require five distinct rows and columns, all pairs.
  const hits = m.hits.filter(
    (h) => h.x > r.x && h.x < r.x + r.width && h.y > r.y && h.y < r.y + r.height,
  );
  const pairs = new Set(hits.map((h) => `${h.x},${h.y}`));
  const isGrid = (points: typeof hits) => {
    const xs = new Set(points.map((h) => h.x)),
      ys = new Set(points.map((h) => h.y));
    const unique = new Set(points.map((h) => `${h.x},${h.y}`));
    return (
      xs.size === HIT_GRID_SIZE && ys.size === HIT_GRID_SIZE && unique.size === HIT_GRID_SIZE ** 2
    );
  };
  // The center can be part of the grid or a separate sample beside an even-spaced grid.
  const completeGrid =
    isGrid(hits) ||
    isGrid(
      hits.filter(
        (h) => Math.abs(h.x - c.x) > PIXEL_TOLERANCE || Math.abs(h.y - c.y) > PIXEL_TOLERANCE,
      ),
    );
  if (!hasCenter || !completeGrid)
    result.push(
      finding(
        m,
        "clickable-area",
        m.target.selector,
        { centerSample: hasCenter, distinctSamples: pairs.size },
        "center plus a complete 5×5 grid inside the control (CSS px)",
        "Control is missing center or grid hit-test evidence.",
      ),
    );
  // A disabled control takes no clicks, so what covers it doesn't block anything.
  const misses = m.state === "disabled" ? [] : m.hits.filter((h) => !h.hitsTarget);
  if (misses.length)
    result.push(
      finding(
        m,
        "clickable-area",
        m.target.selector,
        { missedHits: misses.map((h) => ({ x: px(h.x), y: px(h.y), hit: h.hit })) },
        "all center and grid hits reach the control or a descendant",
        "Another element covers part of the clickable area.",
      ),
    );
  return result;
}
