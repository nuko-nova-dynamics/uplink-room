import type { Finding, Measurement } from "../types.ts";
import {
  ALIGNMENT_TOLERANCE,
  elements,
  finding,
  isControl,
  kind,
  number,
  px,
  visibleText,
  textRow,
  hasClass,
} from "./shared.ts";

export function evenSpacing(m: Measurement): Finding[] {
  const result: Finding[] = [];
  const equal = (selector: string, name: string, values: number[]) => {
    const spread = Math.max(...values) - Math.min(...values);
    if (values.length > 1 && spread > ALIGNMENT_TOLERANCE)
      result.push(
        finding(
          m,
          "even-spacing",
          selector,
          { [name]: values.map(px), spread: px(spread) },
          "spread ≤0.5px",
          `${name} do not match.`,
        ),
      );
  };
  for (const e of elements(m).filter((e) => isControl(m, e))) {
    const reserve = { left: 0, right: 0 };
    if (
      e.tag.toLowerCase() === "select" &&
      ((e.styles.appearance === undefined &&
        (hasClass(e.selector, "select") ||
          (e.selector.startsWith("#") &&
            number(e.styles.paddingLeft) === 10 &&
            number(e.styles.paddingRight) === 28))) ||
        (e.styles.appearance === "none" && e.styles.backgroundImage?.includes("svg")) ||
        /\.select-wrap(?![\w-])/.test(e.selector))
    )
      reserve.right = 18;
    if (["input", "textarea"].includes(e.tag.toLowerCase())) {
      for (const icon of m.icons) {
        if (
          icon.styles.position !== "absolute" ||
          icon.rect.x < e.rect.x ||
          icon.rect.x + icon.rect.width > e.rect.x + e.rect.width ||
          icon.rect.y < e.rect.y ||
          icon.rect.y + icon.rect.height > e.rect.y + e.rect.height
        )
          continue;
        const side =
          icon.rect.x + icon.rect.width / 2 < e.rect.x + e.rect.width / 2 ? "left" : "right";
        reserve[side] = Math.max(reserve[side], icon.rect.width + 6);
      }
    }
    equal(e.selector, "horizontal padding", [
      number(e.styles.paddingLeft) - reserve.left,
      number(e.styles.paddingRight) - reserve.right,
    ]);
    equal(e.selector, "vertical padding", [
      number(e.styles.paddingTop),
      number(e.styles.paddingBottom),
    ]);
    if (kind(m, e) === "icon-button" && e.selector === m.target.selector && m.icons.length === 1) {
      const icon = m.icons[0]!;
      equal(e.selector, "icon side insets", [
        icon.rect.x - e.rect.x,
        e.rect.x + e.rect.width - icon.rect.x - icon.rect.width,
      ]);
      equal(e.selector, "icon vertical insets", [
        icon.rect.y - e.rect.y,
        e.rect.y + e.rect.height - icon.rect.y - icon.rect.height,
      ]);
    }
  }
  const controls = m.rowPeers.filter((e) => isControl(m, e));
  equal(
    m.target.selector,
    "row control heights",
    controls.map((e) => e.rect.height),
  );
  equal(
    m.target.selector,
    "column left edges",
    m.columnPeers
      .filter(
        (e) =>
          Math.min(e.rect.x + e.rect.width, m.target.rect.x + m.target.rect.width) >
          Math.max(e.rect.x, m.target.rect.x),
      )
      .map((e) => e.rect.x),
  );
  const rows = m.textRows ?? inferRows(m);
  for (const row of rows) {
    const texts = row
      .map((selector) => m.texts.find((t) => t.selector === selector))
      .filter((t) => t !== undefined)
      .filter((t) => visibleText(m, t))
      // A superscript (a quote's number badge) sits above the line on purpose.
      .filter((t) => !/(?:^|[\s>])sup(?![\w-])|\.quote-badge(?![\w-])/.test(t.selector));
    const contexts = Map.groupBy(texts, (t) => textRow(m, t));
    for (const group of contexts.values())
      equal(
        group[0]?.selector ?? m.target.selector,
        "text baselines",
        group.map((t) => t.baseline),
      );
  }
  return result;
}

function inferRows(m: Measurement): string[][] {
  const rows: (typeof m.texts)[] = [];
  for (const text of m.texts) {
    // Multi-line runs have multiple baselines and must be split by capture to compare them.
    if (
      text.inkRect.height >
      number(text.styles.lineHeight, number(text.styles.fontSize) * 1.5) + ALIGNMENT_TOLERANCE
    )
      continue;
    const row = rows.find((r) =>
      r.every(
        (t) =>
          Math.min(t.inkRect.y + t.inkRect.height, text.inkRect.y + text.inkRect.height) >
          Math.max(t.inkRect.y, text.inkRect.y),
      ),
    );
    if (row) row.push(text);
    else rows.push([text]);
  }
  return rows.map((row) => row.map((t) => t.selector));
}
