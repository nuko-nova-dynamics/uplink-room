import type { MeasuredText } from "./types.ts";

/** Legacy runs used these pinned Atkinson fonts (OS/2 metrics, 1000 units per em). */
export function capHeight(text: MeasuredText): number | undefined {
  if (text.capHeight !== undefined) return text.capHeight;
  if (!/^['"]?Atkinson Hyperlegible (?:Next|Mono)['"]?(?:,|$)/.test(text.styles.fontFamily ?? ""))
    return undefined;
  const size = parseFloat(text.styles.fontSize ?? "");
  return Number.isFinite(size) ? (size * 668) / 1000 : undefined;
}

export function capCenter(text: MeasuredText): number | undefined {
  const height = capHeight(text);
  return height === undefined ? undefined : text.baseline - height / 2;
}

/** Wrapped runs on one label contribute one cap-band extent. */
export function labelCapCenter(
  label: MeasuredText,
  texts: MeasuredText[],
  alignment = "center",
): number | undefined {
  const element = label.selector.replace(/::(?:text.*|value)$/, "");
  const centers = texts
    .filter((t) => t.selector.replace(/::(?:text.*|value)$/, "") === element)
    .map(capCenter)
    .filter((y) => y !== undefined);
  if (!centers.length) return undefined;
  if (["start", "flex-start"].includes(alignment)) return Math.min(...centers);
  if (["end", "flex-end"].includes(alignment)) return Math.max(...centers);
  return (Math.min(...centers) + Math.max(...centers)) / 2;
}
