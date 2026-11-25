import { findingId } from "../types.ts";
import type {
  CheckId,
  Finding,
  MeasuredElement,
  MeasuredText,
  Measurement,
  Rect,
} from "../types.ts";
import type { Raster } from "../image.ts";
import { owns } from "../ownership.ts";

export type Images = { crop?: Raster };
// Half a CSS pixel is the alignment limit in issue #173 and the frozen rubric.
export const ALIGNMENT_TOLERANCE = 0.5;
// Ignore floating-point noise, but catch visible fractional origins and token deviations.
export const PIXEL_TOLERANCE = 0.01;
export const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
export const number = (value: string | undefined, fallback = 0) => {
  const n = value === undefined ? NaN : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};
export const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
export const lastSelector = (selector: string) => selector.split(/[\s>+~]+/).at(-1) ?? selector;
export const hasClass = (selector: string, name: string) =>
  new RegExp(`\\.${name}(?![\\w-])`).test(lastSelector(selector));
export function kind(m: Measurement, e: MeasuredElement): string {
  return (
    m.elementKinds?.[e.selector] ??
    (hasClass(e.selector, "btn")
      ? hasClass(e.selector, "icon")
        ? "icon-button"
        : "button"
      : [
            "main-head",
            "drawer-head",
            "sidebar-top",
            "sidebar-bottom",
            "viewer-head",
            "rail-head",
          ].some((name) => hasClass(e.selector, name))
        ? "title-row"
        : "")
  );
}
export function isControl(m: Measurement, e: MeasuredElement): boolean {
  return (
    ["button", "icon-button", "control"].includes(kind(m, e)) ||
    ["button", "input", "select", "textarea", "a"].includes(e.tag.toLowerCase()) ||
    [
      "button",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "combobox",
      "slider",
      "link",
    ].includes(e.role ?? "")
  );
}
export function elements(m: Measurement): MeasuredElement[] {
  const all = [
    m.target,
    ...m.icons,
    // A Range identifies a text run, but its rect/styles still describe its parent box.
    // Check that painted parent once when several runs share it.
    ...m.texts.map((text) => ({
      ...text,
      selector: text.selector.replace(/::(?:text\(\d+\)\[\d+:\d+\]|value)$/, ""),
    })),
    ...m.rowPeers,
    ...m.columnPeers,
    ...(m.extraElements ?? []),
    ...(m.focus ? [m.focus.element] : []),
  ];
  return [...new Map(all.map((e) => [e.selector, e])).values()].filter((e) => owns(m, e.selector));
}
export function contentBox(e: MeasuredElement): Rect {
  const s = e.styles;
  const left = number(s.borderLeftWidth) + number(s.paddingLeft);
  const top = number(s.borderTopWidth) + number(s.paddingTop);
  return {
    x: e.rect.x + left,
    y: e.rect.y + top,
    width: e.rect.width - left - number(s.borderRightWidth) - number(s.paddingRight),
    height: e.rect.height - top - number(s.borderBottomWidth) - number(s.paddingBottom),
  };
}
export function finding(
  m: Measurement,
  check: CheckId,
  selector: string,
  measured: unknown,
  expected: unknown,
  message: string,
): Finding {
  const fields = {
    check,
    component: m.component,
    state: m.state,
    theme: m.theme,
    scale: m.scale,
    gymState: m.gymState,
    selector,
    measured,
    expected,
    message,
    artifact: m.files.crop,
  };
  return { id: findingId(fields), ...fields };
}
export function tokenNumber(m: Measurement, token: string, fallback: number): number {
  const value = m.tokens[token];
  if (value === undefined) return fallback;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`Unresolved token ${token}: ${value}`);
  return parsed;
}
export function visibleText(m: Measurement, text: MeasuredText): boolean {
  return (
    text.rect.width > 1 &&
    text.rect.height > 1 &&
    !/\.sr-only(?![\w-])/.test(text.selector) &&
    text.styles.visibility !== "hidden" &&
    number(
      m.textContexts?.[text.selector]?.effectiveOpacity?.toString(),
      number(text.styles.opacity, 1),
    ) > 0
  );
}

export function textRow(m: Measurement, text: MeasuredText): string {
  if (text.layoutRow) return text.layoutRow;
  const path = text.selector.replace(/::(?:text.*|value)$/, "");
  const ancestors = [
    m.target,
    ...(m.extraElements ?? []),
    ...m.texts,
    ...Object.values(m.iconContexts ?? {}).map((c) => c.container),
  ]
    .filter(
      (e) =>
        path.startsWith(e.selector.replace(/::(?:text.*|value)$/, "") + " > ") ||
        path === e.selector.replace(/::(?:text.*|value)$/, ""),
    )
    .sort((a, b) => b.selector.length - a.selector.length);
  for (const e of ancestors) {
    if (!/(?:flex|grid)/.test(e.styles.display ?? "")) continue;
    const root = e.selector.replace(/::(?:text.*|value)$/, "");
    if (e.styles.display?.includes("grid") || e.styles.flexDirection?.startsWith("column"))
      return root + " > " + path.slice(root.length + 3).split(" > ")[0];
    return root;
  }
  // Legacy captures lack ancestor styles; distinct parent paths stay distinct.
  return path.split(" > ").slice(0, -1).join(" > ");
}

export function pairedText(m: Measurement, selector: string) {
  const context = m.iconContexts?.[selector];
  const container = context?.container ?? m.target;
  if (container.styles.flexDirection?.startsWith("column")) return undefined;
  const candidates = m.texts.filter((t) => visibleText(m, t));
  const valid = (t: MeasuredText) => {
    if (
      context &&
      (container.selector.includes(" > ") || container.selector.startsWith("#")) &&
      !t.selector.startsWith(container.selector + " > ") &&
      !t.selector.startsWith(container.selector + "::")
    )
      return false;
    return (
      !container.styles.display?.includes("flex") ||
      !t.selector.includes(" > ") ||
      textRow(m, t) === container.selector
    );
  };
  const explicit = candidates.find((t) => t.selector === context?.labelSelector && valid(t));
  const candidate =
    explicit ??
    (context
      ? candidates.find(valid)
      : m.icons.length === 1 && candidates.length === 1 && isControl(m, m.target)
        ? candidates[0]
        : undefined);
  if (!candidate) return undefined;
  const cell = context?.alignmentRect;
  if (
    cell &&
    (candidate.inkRect.x < cell.x - ALIGNMENT_TOLERANCE ||
      candidate.inkRect.x + candidate.inkRect.width > cell.x + cell.width + ALIGNMENT_TOLERANCE ||
      candidate.inkRect.y < cell.y - ALIGNMENT_TOLERANCE ||
      candidate.inkRect.y + candidate.inkRect.height > cell.y + cell.height + ALIGNMENT_TOLERANCE)
  )
    return undefined;
  // Old captures sometimes paired labels outside the icon's independent wrapper.
  if (
    context &&
    selector.includes(" > ") &&
    candidate.selector.includes(" > ") &&
    !candidate.selector.startsWith(container.selector + " > ") &&
    !candidate.selector.startsWith(container.selector + "::")
  )
    return undefined;
  return candidate;
}
export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function sortFindings(items: Finding[]): Finding[] {
  return items.sort((a, b) =>
    compareText(
      JSON.stringify([
        a.component,
        a.state,
        a.theme,
        a.scale ?? 0,
        a.check,
        a.selector,
        a.message,
        a.artifact,
        a.measured,
        a.expected,
      ]),
      JSON.stringify([
        b.component,
        b.state,
        b.theme,
        b.scale ?? 0,
        b.check,
        b.selector,
        b.message,
        b.artifact,
        b.measured,
        b.expected,
      ]),
    ),
  );
}

/** Reconstruct a flex row's occupied horizontal span in captures without contentGroup. */
export function contentGroup(m: Measurement, container: MeasuredElement): Rect | undefined {
  if (
    !container.styles.display?.includes("flex") ||
    container.styles.flexDirection?.startsWith("column")
  )
    return undefined;
  const children = [
    ...m.icons,
    ...(m.extraElements ?? []),
    ...m.texts.filter((t) => visibleText(m, t)),
    ...Object.values(m.iconContexts ?? {}).map((c) => c.container),
  ]
    .filter((e) => {
      const path = e.selector.replace(/::(?:text.*|value)$/, "");
      return (
        (path === container.selector && "inkRect" in e) ||
        (path.startsWith(container.selector + " > ") &&
          ("inkRect" in e || !path.slice(container.selector.length + 3).includes(" > ")))
      );
    })
    .filter((e) => !["absolute", "fixed"].includes(e.styles.position ?? ""))
    .map((e) =>
      e.selector.startsWith(container.selector + "::") && "inkRect" in e
        ? (e as MeasuredText).inkRect
        : e.rect,
    );
  if (!children.length) return undefined;
  const x = Math.min(...children.map((r) => r.x)),
    y = Math.min(...children.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...children.map((r) => r.x + r.width)) - x,
    height: Math.max(...children.map((r) => r.y + r.height)) - y,
  };
}
