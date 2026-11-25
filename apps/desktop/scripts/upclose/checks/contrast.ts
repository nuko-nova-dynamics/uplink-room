import type { Finding, Measurement } from "../types.ts";
import { color, contrastRatio, over, throughLayers } from "../color.ts";
import { finding, number } from "./shared.ts";

// Quantized CSS color channels can differ by one level after serialization.
export const COLOR_CHANNEL_TOLERANCE = 1;
export const TEXT_CONTRAST = 4.5;
export const LARGE_TEXT_CONTRAST = 3;
export const DISABLED_CONTRAST = TEXT_CONTRAST;
export const FOCUS_CONTRAST = 3;
// WCAG's 14pt bold and 18pt regular thresholds, converted to CSS pixels.
export const LARGE_BOLD_PX = 18.66;
export const LARGE_REGULAR_PX = 24;

export function contrast(m: Measurement): Finding[] {
  const result: Finding[] = [];
  for (const text of m.texts) {
    if (!text.text.trim()) continue;
    const context = m.textContexts?.[text.selector];
    const opacity =
      context?.effectiveOpacity ??
      number(text.styles.opacity, 1) *
        (text.selector === m.target.selector ? 1 : number(m.target.styles.opacity, 1));
    if (opacity === 0) continue;
    const fg = color(
      text.styles.color ?? m.tokens["--text"] ?? (m.theme === "dark" ? "#ebecee" : "#15171a"),
    );
    // With the captured layers, fade the label and its fill together, as the browser does.
    const painted = context?.layers?.length ? throughLayers(fg, context.layers) : null;
    const ratio = painted
      ? contrastRatio(painted.text, painted.surface)
      : contrastRatio(over({ ...fg, a: fg.a * opacity }, text.background), text.background);
    const size = number(text.styles.fontSize),
      bold = number(text.styles.fontWeight) >= 700 || text.styles.fontWeight === "bold";
    const disabled = context?.disabled ?? m.state === "disabled";
    const need = disabled
      ? DISABLED_CONTRAST
      : size >= LARGE_REGULAR_PX || (size >= LARGE_BOLD_PX && bold)
        ? LARGE_TEXT_CONTRAST
        : TEXT_CONTRAST;
    if (ratio < need)
      result.push(
        finding(
          m,
          "contrast",
          text.selector,
          { ratio: `${ratio.toFixed(4)}:1` },
          { ratio: `≥${need}:1` },
          "Text contrast is below the required ratio.",
        ),
      );
  }
  if (m.focus || m.state === "focus-visible") {
    let focus = m.focus;
    // Some views mark focus themselves (the Inbox's focused row: a class and an outline, no DOM focus),
    // so the capture finds no focused element. Read the ring from the target's own outline then.
    const s = m.target.styles;
    if (
      (!focus?.ringColor || focus.ringWidth <= 0) &&
      m.state === "focus-visible" &&
      s.outlineStyle &&
      s.outlineStyle !== "none" &&
      number(s.outlineWidth, 0) > 0 &&
      s.outlineColor
    )
      focus = {
        element: m.target,
        ringColor: color(s.outlineColor),
        ringWidth: number(s.outlineWidth, 0),
        adjacent: m.target.background,
      };
    if (!focus?.ringColor || focus.ringWidth <= 0 || focus.ringColor.a <= 0) {
      result.push(
        finding(
          m,
          "contrast",
          focus?.element.selector ?? m.target.selector,
          "no visible focus ring",
          "visible primary-text focus ring, ≥3:1",
          "Focus state has no visible focus ring.",
        ),
      );
    } else {
      const ring = focus.ringColor;
      const rendered = over(
        { ...ring, a: ring.a * number(focus.element.styles.opacity, 1) },
        focus.adjacent,
      );
      const ratio = contrastRatio(rendered, focus.adjacent);
      if (ratio < FOCUS_CONTRAST)
        result.push(
          finding(
            m,
            "contrast",
            focus.element.selector,
            { focusRatio: `${ratio.toFixed(4)}:1` },
            { focusRatio: "≥3:1" },
            "Focus ring contrast is below the required ratio.",
          ),
        );
      const primary = color(m.tokens["--text"] ?? (m.theme === "dark" ? "#ebecee" : "#15171a"));
      if (
        ["r", "g", "b"].some(
          (key) => Math.abs(ring[key as "r"] - primary[key as "r"]) > COLOR_CHANNEL_TOLERANCE,
        )
      )
        result.push(
          finding(
            m,
            "contrast",
            focus.element.selector,
            { ringColor: ring },
            { primaryTextColor: primary, channelTolerance: "1/255 per channel; alpha allowed" },
            "Focus ring does not use the primary text color.",
          ),
        );
    }
  }
  return result;
}
