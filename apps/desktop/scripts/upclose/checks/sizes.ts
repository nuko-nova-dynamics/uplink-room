import { color } from "../color.ts";
import type { Finding, MeasuredElement, Measurement } from "../types.ts";
import {
  elements,
  finding,
  hasClass,
  kind,
  isControl,
  number,
  pairedText,
  PIXEL_TOLERANCE,
  px,
} from "./shared.ts";

// DESIGN.md, Type: Mono for timers, machine names, commands, run IDs, terminal output, and the codes,
// tokens and endpoint URLs people copy or paste.
const MONO_KINDS = new Set([
  "timer",
  "machine-name",
  "command",
  "run-id",
  "terminal",
  "code",
  "url",
]);
const TYPE_SCALE = [11, 12, 13, 15, 20];
const WEIGHTS = [400, 500, 700];
const primaryFont = (font: string) =>
  font
    .split(",")[0]!
    .trim()
    .replace(/^['"]|['"]$/g, "");
const inPath = (selector: string, names: string[]) =>
  names.some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(selector));
const isButton = (e: MeasuredElement) =>
  hasClass(e.selector, "btn") || hasClass(e.selector, "icon-btn");
const inHeader = (selector: string) => {
  const parts = selector.split(" > ");
  const header = parts.findLastIndex((part) =>
    inPath(part, [
      "main-head",
      "drawer-head",
      "dialog-head",
      "viewer-head",
      "rail-head",
      "a2a-chat-head",
      "pane-title",
      "terminal-bar",
    ]),
  );
  return (
    header >= 0 && !parts.slice(header + 1).some((part) => inPath(part, ["pop", "popover", "menu"]))
  );
};
const controlHeight = (e: MeasuredElement) =>
  inPath(e.selector, ["stage-controls"]) && hasClass(e.selector, "btn")
    ? 36
    : !inHeader(e.selector) && (hasClass(e.selector, "small") || hasClass(e.selector, "icon-btn"))
      ? 24
      : 28;

export function sizes(m: Measurement): Finding[] {
  const result: Finding[] = [];
  const size = (
    selector: string,
    property: string,
    actual: number,
    expected: number | number[],
  ) => {
    const values = Array.isArray(expected) ? expected : [expected];
    if (
      !values.some(
        (value) => Number.isFinite(actual) && Math.abs(actual - value) <= PIXEL_TOLERANCE,
      )
    )
      result.push(
        finding(
          m,
          "sizes",
          selector,
          { [property]: px(actual) },
          { [property]: values.map(px).join(" or ") },
          `${property} does not match the design value.`,
        ),
      );
  };
  for (const e of elements(m)) {
    const k = kind(m, e);
    const button = k === "button" || k === "icon-button" || (k !== "title-row" && isButton(e));
    const height = controlHeight(e);
    if (button) {
      size(e.selector, "height", e.rect.height, height);
      // The call stage's Leave is a labeled pill whose width fits its label (DESIGN.md, Calls).
      if (
        (k === "icon-button" || hasClass(e.selector, "icon-btn")) &&
        !hasClass(e.selector, "leave")
      )
        size(e.selector, "width", e.rect.width, height);
      if (hasClass(e.selector, "btn")) {
        for (const prop of [
          "borderTopWidth",
          "borderRightWidth",
          "borderBottomWidth",
          "borderLeftWidth",
        ] as const)
          size(e.selector, prop, number(e.styles[prop], NaN), 1);
        const pairedIcon = m.icons.find(
          (icon) =>
            !!pairedText(m, icon.selector) &&
            (m.iconContexts?.[icon.selector]?.container.selector === e.selector ||
              e.selector === m.target.selector),
        );
        if (pairedIcon) size(e.selector, "gap", number(e.styles.columnGap ?? e.styles.gap, NaN), 6);
      }
    }
    if (k === "title-row") size(e.selector, "height", e.rect.height, 52);
    const pill =
      inPath(e.selector.split(" > ").at(-1)!, [
        "chip",
        "pill",
        "driver-pill",
        "face",
        "state-dot",
        "presence-dot",
      ]) ||
      (inPath(e.selector, ["stage-controls"]) && hasClass(e.selector, "leave"));
    // DESIGN.md, Scales: inset rows (the sidebar's, a menu's) are 6 px; full-width rows have none.
    const insetRow = ["nav-item", "menu-row"].some((c) => hasClass(e.selector, c));
    // The Inbox's rows are cards (DESIGN.md, Platforms and Inbox); a message row is full width.
    const row = ["msg-row"].some((c) => hasClass(e.selector, c));
    const bubble = ["bubble"].some((c) => hasClass(e.selector, c));
    // Inline tags, key hints, highlights and image thumbnails are 4 px.
    const last = e.selector.split(" > ").at(-1)!;
    const inline =
      ["tag", "kbd", "search-mention", "quote-badge", "pin", "pin-n", "attachment-image"].some(
        (c) => hasClass(last, c),
      ) || /^(?:img|kbd|mark|code)(?![\w-])/.test(last);
    const card = ["panel", "card", "link-preview", "attachment-preview", "inbox-row"].some((c) =>
      hasClass(e.selector, c),
    );
    const dialog = ["dialog", "onboarding", "onboarding-card"].some((c) => hasClass(e.selector, c));
    for (const prop of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const) {
      if (e.styles[prop] === undefined) continue;
      // A radius only shows on a box that paints a background, an edge or a shadow.
      const painted =
        !/^(?:transparent|rgba\([^)]*,\s*0\))$/.test(
          (e.styles.backgroundColor ?? "transparent").trim(),
        ) ||
        (["Top", "Right", "Bottom", "Left"] as const).some(
          (side) =>
            number(e.styles[`border${side}Width`], 0) > 0 &&
            color(e.styles[`border${side}Color`] ?? "transparent").a > 0,
        ) ||
        (e.styles.boxShadow ?? "none") !== "none" ||
        /^(?:img|video|canvas)(?![\w-])/.test(e.selector.split(" > ").at(-1)!);
      if (!painted) continue;
      const radius = number(e.styles[prop], NaN);
      // A fully rounded box is a pill (a reaction, a badge, a file chip) whatever its class.
      const rounded = e.styles[prop]!.includes("%")
        ? radius >= 50
        : radius >= Math.min(e.rect.width, e.rect.height) / 2 - PIXEL_TOLERANCE;
      if (pill || rounded) {
        // CSS clamps large radii to the box. Percent radii remain percentages in computed style.
        if (
          !(e.styles[prop]!.includes("%")
            ? radius >= 50
            : radius >= Math.min(e.rect.width, e.rect.height) / 2)
        )
          result.push(
            finding(
              m,
              "sizes",
              e.selector,
              { [prop]: e.styles[prop] },
              { [prop]: "full pill" },
              "The pill does not have fully rounded ends.",
            ),
          );
      } else
        size(
          e.selector,
          prop,
          radius,
          row
            ? 0
            : insetRow
              ? 6
              : inline
                ? 4
                : bubble
                  ? 14
                  : dialog
                    ? 12
                    : card
                      ? 8
                      : button
                        ? height === 24
                          ? 6
                          : height === 28
                            ? 7
                            : [6, 7, 8, 12]
                        : [0, 6, 7, 8, 12],
        );
    }
  }
  const peers = m.rowPeers.filter((peer) => isButton(peer)).toSorted((a, b) => a.rect.x - b.rect.x);
  for (let i = 1; i < peers.length; i++) {
    const previous = peers[i - 1]!,
      current = peers[i]!;
    size(current.selector, "rowGap", current.rect.x - previous.rect.x - previous.rect.width, 8);
  }
  for (const icon of m.icons) {
    const container = m.iconContexts?.[icon.selector]?.container ?? m.target;
    const path = icon.selector;
    // DESIGN.md, Scales: 12 px in `.btn.small` and chips, 16 px for the composer's own controls, 20 px in
    // an empty state, and 14 px everywhere else (the default <Icon> size).
    let expected: number | number[] = 14;
    if (hasClass(container.selector, "small") || inPath(path, ["chip"])) expected = 12;
    else if (inPath(path, ["composer-send", "composer-tool", "mode-option"])) expected = 16;
    else if (isControl(m, container)) expected = 14;
    else if (inPath(path, ["empty-state", "space-state"])) expected = 20;
    const matrix = icon.styles.transform
      ?.match(/^matrix\(([^)]+)\)$/)?.[1]
      ?.split(",")
      .map(Number);
    const rotation =
      matrix?.length === 6 &&
      Math.abs(matrix[0]! ** 2 + matrix[1]! ** 2 - 1) < 0.001 &&
      Math.abs(matrix[2]! ** 2 + matrix[3]! ** 2 - 1) < 0.001 &&
      Math.abs(matrix[0]! * matrix[2]! + matrix[1]! * matrix[3]!) < 0.001;
    size(
      icon.selector,
      "iconWidth",
      m.layoutRects?.[path]?.width ??
        (rotation ? number(icon.styles.width, icon.rect.width) : icon.rect.width),
      expected,
    );
    size(
      icon.selector,
      "iconHeight",
      m.layoutRects?.[path]?.height ??
        (rotation ? number(icon.styles.height, icon.rect.height) : icon.rect.height),
      expected,
    );
    const label = pairedText(m, icon.selector);
    if (label && hasClass(container.selector, "btn")) {
      const gap = Math.max(
        label.inkRect.x - (icon.rect.x + icon.rect.width),
        icon.rect.x - (label.inkRect.x + label.inkRect.width),
      );
      size(icon.selector, "iconLabelGap", gap, 6);
    }
  }
  for (const text of m.texts) {
    const context = m.textContexts?.[text.selector];
    if (context?.kind === "emoji") continue;
    const font = primaryFont(text.styles.fontFamily ?? "");
    const uiFont = "Atkinson Hyperlegible Next",
      monoFont = "Atkinson Hyperlegible Mono";
    const mono = font === monoFont;
    if (font !== uiFont && !(mono && context && MONO_KINDS.has(context.kind)))
      result.push(
        finding(
          m,
          "sizes",
          text.selector,
          { fontFamily: text.styles.fontFamily ?? "missing" },
          {
            fontFamily:
              context && MONO_KINDS.has(context.kind) ? `${uiFont} or ${monoFont}` : uiFont,
          },
          "Text uses the wrong font family for its purpose.",
        ),
      );
    const parent = text.selector.replace(/::(?:text.*|value)$/, "");
    // The initials in a face scale with the face (DESIGN.md, Scales), so they aren't on the type scale.
    if (/\.face(?![\w-])/.test(parent)) continue;
    const expected = mono
      ? [12, 13]
      : context?.kind === "message"
        ? 15
        : hasClass(parent, "btn")
          ? hasClass(parent, "small")
            ? 12
            : 13
          : TYPE_SCALE;
    size(text.selector, "fontSize", number(text.styles.fontSize, NaN), expected);
    const weight =
      text.styles.fontWeight === "normal"
        ? 400
        : text.styles.fontWeight === "bold"
          ? 700
          : Number(text.styles.fontWeight);
    if (!WEIGHTS.includes(weight))
      result.push(
        finding(
          m,
          "sizes",
          text.selector,
          { fontWeight: `${text.styles.fontWeight ?? "missing"} weight` },
          { fontWeight: "400, 500 or 700 weight" },
          "Text uses a weight outside the design set.",
        ),
      );
  }
  return result;
}
