import type { InventoryComponent, Rect } from "../types.ts";
import { selectorSpecificity } from "../identity.ts";
export const interactive =
  'button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex^="-"]), [contenteditable=true], [role=button], [role=menuitem], [role=option], [role=tab], summary';
export const forbidden =
  /clipboard|copy|share|github|openExternal|openInT3|open\s+in\s+t3|window\.open|location\.(?:href|assign)|open.*browser|https?:\/\/|launch.*(?:url|link)|open.*(?:url|link)|system settings/i;
export function cycleLength(order: string[]): number | null {
  for (let n = 2; n <= order.length / 2; n++) {
    if (order.slice(-n).every((v, i) => v === order[order.length - 2 * n + i])) return n;
  }
  return null;
}
export function tabBudget(controlCount: number): number {
  return Math.max(200, 2 * (controlCount + 2));
}
export function escapeProgress(
  before: { layers: number; value: string },
  after: { layers: number; value: string },
): boolean {
  return after.layers < before.layers || (!!before.value && !after.value);
}
export function clipped(v: {
  overflow: string;
  width: number;
  scroll: number;
  ellipsis: string;
  height?: number;
}): boolean {
  if (v.width <= 1 && (v.height ?? Infinity) <= 1) return false;
  return /hidden|clip/.test(v.overflow) && v.scroll > v.width + 1 && v.ellipsis !== "ellipsis";
}
export function intersection(a: Rect, b: Rect): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
export function overlap(a: Rect, b: Rect, related: boolean, intended: boolean): boolean {
  return !related && !intended && intersection(a, b) > 4;
}
export function overlappingRegions(a: Rect[], b: Rect[]): [Rect, Rect] | undefined {
  for (const left of a)
    for (const right of b) if (intersection(left, right) > 4) return [left, right];
  return undefined;
}
export function motionProperty(property: string): boolean {
  return /^(transform|opacity|color|background-color|border(?:-(?:top|right|bottom|left))?-color|outline-color|fill|stroke|text-decoration-color)$/.test(
    property,
  );
}
export function nearestComponent(
  ancestry: string[][],
  components: Pick<InventoryComponent, "id" | "selector">[],
): string {
  for (const matches of ancestry) {
    const candidates = components.filter((c) => matches.includes(c.selector));
    if (candidates.length)
      return candidates.sort(
        (a, b) =>
          selectorSpecificity(b.selector) - selectorSpecificity(a.selector) ||
          a.id.localeCompare(b.id),
      )[0]!.id;
  }
  return "unmapped";
}

export function focusKey(
  e: { selector: string; activeDescendant?: string | null } | undefined,
): string | undefined {
  return e?.activeDescendant || e?.selector;
}

export function roundedHit(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: number[][],
): boolean {
  if (x < 0 || y < 0 || x > width || y > height) return false;
  const r = radii.map((pair) => [Math.max(0, pair[0] || 0), Math.max(0, pair[1] || 0)]);
  const scale = Math.min(
    1,
    width / Math.max(1, r[0]![0]! + r[1]![0]!),
    width / Math.max(1, r[3]![0]! + r[2]![0]!),
    height / Math.max(1, r[0]![1]! + r[3]![1]!),
    height / Math.max(1, r[1]![1]! + r[2]![1]!),
  );
  for (let i = 0; i < 4; i++) {
    const rx = r[i]![0]! * scale,
      ry = r[i]![1]! * scale;
    if (!rx || !ry) continue;
    const right = i === 1 || i === 2,
      bottom = i >= 2,
      cx = right ? width - rx : rx,
      cy = bottom ? height - ry : ry;
    if ((right ? x > cx : x < cx) && (bottom ? y > cy : y < cy))
      return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  }
  return true;
}

export function animationEasings(
  effect: string | undefined,
  frames: { easing?: string }[],
): string[] {
  const segment = frames.slice(0, -1).map((frame) => frame.easing || "linear");
  if (!segment.length || (effect && effect !== "linear")) segment.push(effect || "linear");
  return [...new Set(segment)];
}
export function tokenValue(value: string, tokens: Record<string, string>): boolean {
  const normal = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return Object.values(tokens).some((token) => normal(token) === normal(value));
}

/** Resolve shared-selector aliases using this scene before applying DOM ancestry. */
export function sceneComponents(components: InventoryComponent[], state: string) {
  const viewSelectors = new Map<string, number>();
  for (const c of components.filter((c) => c.kind === "view"))
    viewSelectors.set(c.selector, (viewSelectors.get(c.selector) || 0) + 1);
  const candidates = components
    .filter(
      (c) =>
        c.kind === "primitive" ||
        c.states.some((s) => s.gymState === state) ||
        (c.kind === "view" && c.selector !== ".app" && viewSelectors.get(c.selector) === 1),
    )
    .flatMap((c) => [
      { id: c.id, selector: c.selector, active: c.states.some((s) => s.gymState === state) },
      ...c.states
        .filter((s) => s.gymState === state && s.target)
        .map((s) => ({ id: c.id, selector: s.target!, active: true })),
    ]);
  return candidates
    .filter((c) => !candidates.some((v) => v.selector === c.selector && v.active && !c.active))
    .sort(
      (a, b) =>
        selectorSpecificity(b.selector) - selectorSpecificity(a.selector) ||
        Number(b.active) - Number(a.active) ||
        a.id.localeCompare(b.id),
    );
}

export function tooltipPresent(name: string, title: string | null, custom: boolean) {
  return !!name.trim() && (!!title?.trim() || custom);
}

/** Expanded hit regions at rounded corners are valid; misses inside painted corners are not. */
export function hitMismatch(
  point: { dx: number; dy: number; hit: boolean },
  rect: Rect,
  radii: number[][],
) {
  const inset = radii.map(([x = 0, y = 0]) => [Math.max(0, x - 1), Math.max(0, y - 1)]);
  return roundedHit(point.dx - 1, point.dy - 1, rect.width - 2, rect.height - 2, inset)
    ? !point.hit
    : point.hit &&
        (point.dx < 0 || point.dy < 0 || point.dx > rect.width || point.dy > rect.height);
}

export function cursorExpected(e: {
  role: string;
  disabled: boolean;
  cursor: string;
  control: boolean;
  tabIndex?: number;
  composite?: string | null;
  pointerEvents?: string;
  inputType?: string | null;
  zoomAction?: boolean;
}) {
  if (e.disabled || e.pointerEvents === "none") return ["default", "auto", "not-allowed"];
  if (
    e.role === "select" ||
    (e.role === "input" &&
      ["checkbox", "radio", "range", "file", "color"].includes(e.inputType || ""))
  )
    return ["default", "auto", "pointer"];
  if (e.role === "combobox") return ["text", "auto", "default", "pointer"];
  if (["input", "textarea", "textbox", "searchbox"].includes(e.role)) return ["text", "auto"];
  if (e.composite === "inbox" || e.composite === "listbox") return ["default", "auto", "pointer"];
  if (e.zoomAction) return ["zoom-in", "zoom-out", "pointer"];
  if (!e.control || (e.tabIndex === -1 && e.role === "div")) return ["default", "auto", "pointer"];
  return ["pointer"];
}

export function coveredByLayer(e: { layer?: string; occluder?: { layer: string } | null }) {
  return !!e.occluder?.layer && e.occluder.layer !== e.layer;
}

export function layeredTogether(
  a: { layer: string; dismissal?: boolean; ancestors: string[] },
  b: { layer: string; dismissal?: boolean; ancestors: string[] },
) {
  return (
    a.layer !== b.layer &&
    (!a.layer ||
      !b.layer ||
      a.dismissal ||
      b.dismissal ||
      a.ancestors.includes(b.layer) ||
      b.ancestors.includes(a.layer))
  );
}

export function fallbackComponents(components: InventoryComponent[]) {
  const counts = new Map<string, number>();
  for (const c of components) counts.set(c.selector, (counts.get(c.selector) || 0) + 1);
  return components
    .filter((c) => c.selector !== ".app" && counts.get(c.selector) === 1)
    .sort(
      (a, b) =>
        selectorSpecificity(b.selector) - selectorSpecificity(a.selector) ||
        a.id.localeCompare(b.id),
    );
}

/** DOM ancestry survives IDs that shorten otherwise unrelated selector paths. */
export function relatedElements(
  a: { selector: string; ancestors?: string[] },
  b: { selector: string; ancestors?: string[] },
) {
  return (
    a.ancestors?.includes(b.selector) ||
    b.ancestors?.includes(a.selector) ||
    a.selector.startsWith(b.selector + " > ") ||
    b.selector.startsWith(a.selector + " > ")
  );
}

/** A one-option composite keeps focus on its only item when an arrow wraps. */
export function arrowMoved(
  before: string | undefined,
  after: string | undefined,
  itemCount: number,
) {
  return itemCount === 0 || (!!before && !!after && (itemCount === 1 || before !== after));
}
