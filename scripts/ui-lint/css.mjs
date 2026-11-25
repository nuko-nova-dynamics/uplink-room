import * as css from "css-tree";

export const scales = {
  space: new Set([
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
    "--space-7",
    "--space-8",
    "--space-10",
    "--space-12",
    "--space-14",
    "--space-16",
    "--space-18",
    "--space-20",
    "--space-24",
    "--space-28",
    "--space-32",
    "--space-40",
    "--space-48",
    "--row-pad",
    "--edge",
    "--gutter",
  ]),
  font: new Set([
    "--font-11",
    "--font-12",
    "--font-13",
    "--font-13-5",
    "--font-14",
    "--font-14-5",
    "--font-15",
    "--font-16",
    "--font-18",
    "--font-20",
    "--font-24",
    "--fs",
  ]),
  icon: new Set(["--icon-12", "--icon-14", "--icon-16", "--icon-18", "--icon-20", "--icon-24"]),
};
const layout =
  /^(?:(?:min-|max-)?(?:width|height|block-size|inline-size)|top|left|right|bottom|inset(?:-.+)?|margin(?:-.+)?|padding(?:-.+)?|(?:row-|column-)?gap|grid(?:-.+)?|flex(?:-.+)?|border(?:-.+)?-width|font-size|line-height|letter-spacing|word-spacing|position|display)$/;
const spaceProperty = /^(?:margin|padding|gap|row-gap|column-gap)(?:-.+)?$/;
const sideProperty = /^border-(?:left|right|inline-start|inline-end)(?:-(?:width|color|style))?$/;
const neutralColors = new Set([
  "--line",
  "--faint",
  "--muted",
  "--text",
  "--ground",
  "--sidebar",
  "--raised",
  "--hover",
]);
const stringify = (node) => css.generate(node);
const selectors = (rule) =>
  rule.prelude?.type === "SelectorList" ? rule.prelude.children.toArray().map(stringify) : [];
const normalizeFocus = (selector) => selector.replace(/:focus-visible/g, "");
const visible = (decl) => {
  const value = stringify(decl.value).toLowerCase();
  return (
    /^(outline|outline-width|box-shadow|border|border-color|border-width)$/.test(decl.property) &&
    !/^(none|0(?:[a-z%]+)?|transparent)$/.test(value)
  );
};

/** Exact exceptions are file + selector + property, with a reason. */
export function checkCss(source, file, exceptions = [], sharedWidths = {}) {
  const out = [];
  const add = (rule, node, message) =>
    out.push({ file, rule, line: node.loc?.start.line ?? 1, message });
  let ast;
  try {
    ast = css.parse(source, {
      positions: true,
      parseCustomProperty: true,
      onParseError(error) {
        throw error;
      },
    });
  } catch (error) {
    return [{ file, rule: "css/syntax", line: error.line ?? 1, message: error.message }];
  }
  // Breakpoints cannot use var(), but still enter the explicit existing-value baseline.
  css.walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (!node.prelude) return;
      let raw = false;
      css.walk(node.prelude, (part) => {
        if (part.type === "Dimension" && part.unit === "px" && Number(part.value) !== 0) raw = true;
      });
      if (raw)
        add(
          "css/tokens",
          node,
          "Existing pixel breakpoint; new thresholds need an explicit design decision.",
        );
    },
  });
  const tokenWidths = new Map(Object.entries(sharedWidths));
  css.walk(ast, {
    visit: "Declaration",
    enter(node) {
      if (node.property.startsWith("--")) {
        const values = node.value.children?.toArray() ?? [];
        if (values.length === 1 && values[0].type === "Dimension" && values[0].unit === "px")
          tokenWidths.set(node.property, Number(values[0].value));
      }
    },
  });
  const rules = [];
  css.walk(ast, {
    visit: "Rule",
    enter(rule) {
      rules.push(rule);
    },
  });
  // Replacements must be on the same selector, in the same enclosing at-rule context.
  const contexts = new Map();
  css.walk(ast, {
    enter(node) {
      if (node.type === "Rule")
        contexts.set(
          node,
          this.atrule
            ? this.atrule.name + ":" + (this.atrule.prelude ? stringify(this.atrule.prelude) : "")
            : "root",
        );
    },
  });
  const replacements = new Map();
  for (const rule of rules) {
    if (rule.block.children.toArray().some((d) => d.type === "Declaration" && visible(d))) {
      for (const selector of selectors(rule))
        if (selector.includes(":focus-visible"))
          replacements.set(
            contexts.get(rule) + ":" + normalizeFocus(selector),
            rules.indexOf(rule),
          );
    }
  }
  for (const rule of rules) {
    const selected = selectors(rule);
    const side = new Map();
    for (const decl of rule.block.children) {
      if (decl.type !== "Declaration") continue;
      const prop = decl.property.toLowerCase();
      const value = stringify(decl.value);
      // Every selector the declaration applies to needs its own exception, so a selector added to an
      // excepted rule later is still checked.
      const allowed = (name) =>
        selected.length > 0 &&
        selected.every((selector) =>
          exceptions.some(
            (e) =>
              e.rule === name &&
              e.file === file &&
              e.selector === selector &&
              e.property === prop &&
              e.reason,
          ),
        );
      if (decl.important && !allowed("css/no-important"))
        add("css/no-important", decl, "Remove !important or add a reviewed exact exception.");
      if (prop.startsWith("--")) continue;
      let raw = false,
        scale = false;
      const family = spaceProperty.test(prop)
        ? "space"
        : prop === "font-size" || prop === "font"
          ? "font"
          : /(?:^|[ .:#])(?:svg|icon)(?:[ .:#[]|$)/.test(selected.join(" ")) &&
              /^(width|height|inline-size|block-size)$/.test(prop)
            ? "icon"
            : null;
      css.walk(decl.value, (node) => {
        if (
          node.type === "Dimension" &&
          ((node.unit.toLowerCase() === "px" && Number(node.value) !== 0) ||
            (/^(ms|s)$/i.test(node.unit) && Number(node.value) !== 0))
        )
          raw = true;
        if (
          node.type === "Hash" ||
          (node.type === "Function" &&
            /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|device-cmyk)$/i.test(node.name))
        )
          raw = true;
        if (
          node.type === "Identifier" &&
          !/^(currentcolor|transparent|inherit|initial|unset|none)$/i.test(node.name) &&
          css.lexer.matchType("color", node).matched
        )
          raw = true;
        if (family && node.type === "Dimension" && Number(node.value) !== 0) scale = true;
        if (family && node.type === "Percentage" && Number(node.value) !== 0) scale = true;
        if (
          family &&
          node.type === "Identifier" &&
          node.name.startsWith("--") &&
          !scales[family].has(node.name) &&
          !(prop === "font" && ["--ui", "--mono"].includes(node.name))
        )
          scale = true;
      });
      if (prop.endsWith("radius") || prop === "z-index") {
        css.walk(decl.value, (node) => {
          if (
            (node.type === "Number" || node.type === "Percentage" || node.type === "Dimension") &&
            Number(node.value) !== 0
          )
            raw = true;
        });
      }
      if (raw && !allowed("css/tokens"))
        add(
          "css/tokens",
          decl,
          "Use a token for pixels, colors, durations, radius and stacking order.",
        );
      if (scale && !allowed("css/scale")) add("css/scale", decl, `Use a ${family} scale token.`);
      if (/^outline(?:-width|-style)?$/.test(prop) && /^(none|0(?:px)?)$/i.test(value)) {
        if (
          selected.some(
            (s) =>
              !replacements.has(contexts.get(rule) + ":" + normalizeFocus(s)) ||
              (s.includes(":focus-visible") &&
                replacements.get(contexts.get(rule) + ":" + normalizeFocus(s)) <
                  rules.indexOf(rule)),
          ) &&
          !allowed("css/focus-visible")
        )
          add(
            "css/focus-visible",
            decl,
            "Keep a visible :focus-visible replacement on this selector.",
          );
      }
      if (/^transition(?:-property)?$/.test(prop)) {
        const identifiers = [];
        css.walk(decl.value, (n) => {
          if (n.type === "Identifier") identifiers.push(n.name.toLowerCase());
        });
        // Split only top-level commas, not cubic-bezier() or steps() arguments.
        const groups = [[]];
        for (const part of decl.value.children) {
          if (part.type === "Operator" && part.value === ",") groups.push([]);
          else groups.at(-1).push(part);
        }
        const timing = new Set([
          "ease",
          "ease-in",
          "ease-out",
          "ease-in-out",
          "linear",
          "step-start",
          "step-end",
          "allow-discrete",
          "normal",
        ]);
        // A shorthand group that names no property transitions all of them, whether its duration is
        // a literal or a token (`transition: var(--motion-fast)`).
        const durationOnly = groups.some(
          (group) =>
            group.length > 0 &&
            !group.some((n) => n.type === "Identifier" && !timing.has(n.name.toLowerCase())),
        );
        if (identifiers.includes("all") || (prop === "transition" && durationOnly))
          add("css/transition-all", decl, "Name the properties that may transition.");
        if (identifiers.some((n) => layout.test(n)))
          add(
            "css/transition-layout",
            decl,
            "Animate transform, opacity or color instead of layout.",
          );
      }
      if (sideProperty.test(prop)) {
        const key = prop.replace(/-(width|color|style)$/, "");
        const entry = side.get(key) ?? { node: decl, width: 0, accent: false };
        css.walk(decl.value, (n) => {
          if (n.type === "Dimension" && n.unit === "px")
            entry.width = Math.max(entry.width, Number(n.value));
          if (
            n.type === "Identifier" &&
            n.name.startsWith("--") &&
            !neutralColors.has(n.name) &&
            !tokenWidths.has(n.name)
          )
            entry.accent = true;
          if (n.type === "Identifier" && ["thin", "medium", "thick"].includes(n.name))
            entry.width = Math.max(entry.width, { thin: 1, medium: 3, thick: 5 }[n.name]);
          if (n.type === "Identifier" && tokenWidths.has(n.name))
            entry.width = Math.max(entry.width, tokenWidths.get(n.name));
          if (n.type === "Hash" || (n.type === "Function" && /^(rgb|hsl|oklch|color)/.test(n.name)))
            entry.accent = true;
          if (
            n.type === "Identifier" &&
            !/^(none|solid|dashed|dotted|transparent|currentcolor|inherit)$/.test(n.name) &&
            css.lexer.matchType("color", n).matched
          )
            entry.accent = true;
        });
        side.set(key, entry);
      }
    }
    for (const entry of side.values())
      if (entry.width > 1 && entry.accent)
        add(
          "css/no-side-stripe",
          entry.node,
          "Use a neutral edge or a full accent outline instead of a thick accent side stripe.",
        );
  }
  return out;
}
