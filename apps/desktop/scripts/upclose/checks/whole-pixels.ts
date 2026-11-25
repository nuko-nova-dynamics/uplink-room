import type { Finding, MeasuredElement, Measurement, Rgba } from "../types.ts";
import { elements, finding, kind, number, PIXEL_TOLERANCE, px, type Images } from "./shared.ts";
import { color, over } from "../color.ts";

/** A channel difference small enough to call an edge pixel the full edge color (antialiasing aside). */
const EDGE_COLOR_TOLERANCE = 4;

/**
 * Chromium snaps a box's background, border and outline to whole device pixels when it paints them, so
 * a box at x = 1104.078 still draws a crisp 1 px edge (the 1x crops show it: one column in the exact
 * border color, nothing blended). SVG icons aren't snapped, so a fractional icon origin does blur.
 * Icons are therefore held to whole-pixel layout positions, while a painted box with a fractional edge
 * is checked in the 1x crop: it passes when a pixel within one pixel of the snapped edge is the full
 * edge color, and is a finding when the edge came out blended (or no crop is at hand).
 */
export function wholePixels(m: Measurement, images: Images = {}): Finding[] {
  if (m.scale !== 1) return [];
  const icons = new Set(m.icons.map((icon) => icon.selector));
  return elements(m).flatMap((e) => {
    const s = e.styles;
    const border = (["Top", "Right", "Bottom", "Left"] as const).some(
      (side) =>
        number(s[`border${side}Width`]) > 0 &&
        color(s[`border${side}Color`] ?? "transparent").a > 0,
    );
    const outline =
      s.outlineStyle !== "none" &&
      number(s.outlineWidth) > 0 &&
      color(s.outlineColor ?? "transparent").a > 0;
    const focus =
      m.focus?.element.selector === e.selector &&
      m.focus.ringWidth > 0 &&
      (m.focus.ringColor?.a ?? 0) > 0;
    const hairline =
      kind(m, e) === "hairline" ||
      ((e.rect.width === 1 || e.rect.height === 1) &&
        color(s.backgroundColor ?? "transparent").a > 0);
    if (!icons.has(e.selector) && !border && !outline && !focus && !hairline) return [];
    const r = m.layoutRects?.[e.selector] ?? e.rect;
    const positions: Record<string, number> = { x: r.x, y: r.y };
    if (border || outline || focus || hairline)
      Object.assign(positions, {
        right: r.x + r.width,
        bottom: r.y + r.height,
      });
    if (outline || focus) {
      const spread = outline
        ? number(s.outlineWidth) + number(s.outlineOffset)
        : m.focus!.ringWidth;
      Object.assign(positions, {
        ringLeft: r.x - spread,
        ringTop: r.y - spread,
        ringRight: r.x + r.width + spread,
        ringBottom: r.y + r.height + spread,
      });
    }
    const isIcon = icons.has(e.selector) && !border && !outline && !focus && !hairline;
    const fractional = Object.fromEntries(
      Object.entries(positions)
        .filter(([, n]) => Math.abs(n - Math.round(n)) > PIXEL_TOLERANCE)
        .filter(([key, n]) => isIcon || !crispEdge(m, e, images, key, n, { border, outline, focus, hairline }))
        .map(([key, n]) => [key, px(n)]),
    );
    return Object.keys(fractional).length
      ? [
          finding(
            m,
            "whole-pixels",
            e.selector,
            fractional,
            "whole CSS pixels within 0.01px at 1x",
            "A painted box starts or ends between device pixels.",
          ),
        ]
      : [];
  });
}

/** Whether the painted edge at `key` (x, right, y, bottom, or a ring edge) came out as one crisp pixel row or column. */
function crispEdge(
  m: Measurement,
  e: MeasuredElement,
  images: Images,
  key: string,
  edge: number,
  painted: { border: boolean; outline: boolean; focus: boolean; hairline: boolean },
): boolean {
  const png = images.crop;
  if (!png || m.scale !== 1) return false;
  const s = e.styles;
  const ring = key.startsWith("ring");
  const side = key.replace(/^ring/, "").toLowerCase();
  const vertical = side === "x" || side === "left" || side === "right";
  const sideName = { x: "Left", left: "Left", right: "Right", y: "Top", top: "Top", bottom: "Bottom" }[side];
  if (!sideName) return false;
  // A side with no border of its own draws only the background's edge, which Chromium snaps.
  if (!ring && !painted.hairline && !(number(s[`border${sideName}Width` as keyof typeof s], 0) > 0 && color(s[`border${sideName}Color` as keyof typeof s] ?? "transparent").a > 0))
    return true;
  let ink: Rgba | null = null;
  let behind: Rgba = e.background;
  if (ring) {
    if (painted.focus && m.focus?.ringColor) {
      ink = m.focus.ringColor;
      behind = m.focus.adjacent;
    } else if (painted.outline) ink = color(s.outlineColor ?? "transparent");
  } else if (painted.border && number(s[`border${sideName}Width` as keyof typeof s], 0) > 0)
    ink = color(s[`border${sideName}Color` as keyof typeof s] ?? "transparent");
  else if (painted.hairline) ink = color(s.backgroundColor ?? "transparent");
  if (!ink || ink.a <= 0) return false;
  const want = ink.a < 1 ? over(ink, behind) : ink;
  const r = m.layoutRects?.[e.selector] ?? e.rect;
  // Sample across the middle of the edge, away from rounded corners.
  const along = vertical ? r.y + r.height / 2 - m.crop.y : r.x + r.width / 2 - m.crop.x;
  const at = Math.round(edge - (vertical ? m.crop.x : m.crop.y));
  const a = Math.round(along);
  for (const d of [at - 1, at, at + 1]) {
    const px = vertical ? d : a,
      py = vertical ? a : d;
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
    const i = (py * png.width + px) * 4;
    const [cr, cg, cb] = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
    if (
      Math.abs(cr - want.r) <= EDGE_COLOR_TOLERANCE &&
      Math.abs(cg - want.g) <= EDGE_COLOR_TOLERANCE &&
      Math.abs(cb - want.b) <= EDGE_COLOR_TOLERANCE
    )
      return true;
  }
  return false;
}
