import { svgPathBbox } from "svg-path-bbox";

export const artFiles = {
  "apps/desktop/src/renderer/characters/CharacterView.tsx":
    "Parametric agent character artwork, not UI icons.",
  "apps/desktop/src/renderer/characters/LinkMascot.tsx":
    "Animated Link character artwork, not UI icons.",
  "apps/desktop/src/renderer/components/Wordmark.tsx": "Authored brand lettering, not UI icons.",
};
const emojiContentFiles = new Set(["apps/desktop/src/renderer/components/chat/Reactions.tsx"]);
const pixelProperty =
  /^(?:(?:min|max)?(?:Width|Height)|width|height|top|left|right|bottom|inset.*|gap|rowGap|columnGap|padding.*|margin.*|border.*Width|border.*Radius|flexBasis|fontSize|letterSpacing|outlineOffset|outlineWidth|textIndent)$/;
export function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
function attrValue(attr) {
  if (attr?.value?.type === "Literal") return attr.value.value;
  if (attr?.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "Literal")
    return attr.value.expression.value;
}
function attrs(open) {
  return Object.fromEntries(
    open.attributes.filter((a) => a.type === "JSXAttribute").map((a) => [a.name.name, a]),
  );
}
/** A nonzero number literal, signed or not: React renders it as pixels on a length property. */
function numericLength(node) {
  if (node.type === "UnaryExpression" && ["-", "+"].includes(node.operator)) node = node.argument;
  return node.type === "Literal" && typeof node.value === "number" && node.value !== 0;
}
function name(node) {
  return node?.name?.name;
}
function text(node) {
  if (node.type === "JSXText") return node.value;
  if (node.type === "JSXElement" || node.type === "JSXFragment")
    return node.children.map(text).join("");
  if (node.type === "JSXExpressionContainer") return rendered(node.expression);
  return "";
}
/**
 * The static text an expression renders: a string or template, either branch of a conditional, the
 * right side of `&&` or `??`, and JSX it returns. Attributes (a tooltip's title) and comparison
 * operands don't render, so they don't count.
 */
function rendered(expr) {
  if (!expr) return "";
  if (expr.type === "Literal") return typeof expr.value === "string" ? expr.value : "";
  if (expr.type === "TemplateLiteral") return expr.quasis.map((q) => q.value.cooked ?? q.value.raw).join("");
  if (expr.type === "ConditionalExpression") return rendered(expr.consequent) + rendered(expr.alternate);
  if (expr.type === "LogicalExpression") return rendered(expr.right);
  if (expr.type === "ParenthesizedExpression") return rendered(expr.expression);
  if (expr.type === "JSXElement" || expr.type === "JSXFragment") return text(expr);
  return "";
}
const emoji = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3/u;

export function checkTsx(program, file) {
  const out = [];
  const constants = new Map();
  walk(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "Literal" &&
      typeof node.init.value === "string"
    )
      constants.set(node.id.name, node.init.value);
  });
  const add = (rule, node, message) => out.push({ rule, node, message, file });
  walk(program, (node) => {
    if (node.type !== "JSXElement") return;
    const open = node.openingElement,
      tag = name(open),
      a = attrs(open);
    if (tag === "svg" && !file.endsWith("/components/Icon.tsx") && !artFiles[file])
      add(
        "no-inline-svg",
        open,
        "Use Icon; artwork exceptions need a file and reason in artFiles.",
      );
    if (
      tag === "Icon" &&
      a.size &&
      attrValue(a.size) !== undefined &&
      ![12, 14, 16, 18, 20, 24].includes(Number(attrValue(a.size)))
    )
      add("icon-scale", a.size, "Use the 12, 14, 16, 18, 20 or 24 icon size.");
    if (a.style)
      walk(a.style.value, (n) => {
        if (n.type === "Literal" && typeof n.value === "string" && /(?:\d|\.)px\b/i.test(n.value))
          add("no-inline-px", n, "Move pixel values into a token-based CSS class.");
        if (n.type === "TemplateElement" && /(?:\d|\.)px\b/i.test(n.value.raw))
          add("no-inline-px", n, "Move pixel values into a token-based CSS class.");
        if (
          n.type === "Property" &&
          pixelProperty.test(n.key.name ?? n.key.value) &&
          numericLength(n.value)
        )
          add("no-inline-px", n, "React numeric length styles are pixels; use a CSS token.");
      });
    const directText = (node.children ?? [])
      .filter((child) => child.type === "JSXText" || child.type === "JSXExpressionContainer")
      .map(text)
      .join("")
      .trim();
    const onlyEmoji =
      emoji.test(directText) &&
      !directText.replace(
        /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\s]/gu,
        "",
      );
    if (
      !emojiContentFiles.has(file) &&
      !artFiles[file] &&
      (["button", "Icon"].includes(tag) ||
        onlyEmoji ||
        attrValue(a.role) === "img" ||
        a["aria-hidden"] ||
        /icon|glyph|symbol/.test(String(attrValue(a.className) ?? "")))
    ) {
      // Only inspect rendered children. Accessible names, tooltips and prose can describe emoji.
      let content = (node.children ?? []).map(text).join("");
      for (const child of node.children ?? [])
        walk(child, (n) => {
          if (n.type === "Identifier") content += constants.get(n.name) ?? "";
        });
      if (emoji.test(content))
        add("no-emoji-icon", open, "Use Icon for UI symbols. Emoji reactions are message content.");
    }
  });
  if (file.endsWith("/components/Icon.tsx")) out.push(...checkIcons(program, file));
  return out;
}

export function checkIcons(program, file) {
  const out = [];
  const add = (node, message) => out.push({ file, rule: "icon-geometry", node, message });
  let stroke, paths, wrapper;
  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && node.id.name === "stroke")
      stroke = node.init?.expression ?? node.init;
    if (node.type === "VariableDeclarator" && node.id.name === "PATHS") paths = node.init;
    if (node.type === "JSXOpeningElement" && name(node) === "svg") wrapper = node;
  });
  const strokeValues = Object.fromEntries(
    (stroke?.properties ?? []).map((p) => [p.key.name, p.value.value]),
  );
  if (strokeValues.strokeWidth !== 1.5) add(stroke ?? program, "Icon strokeWidth must be 1.5.");
  if (!wrapper || attrValue(attrs(wrapper).viewBox) !== "0 0 16 16")
    add(wrapper ?? program, "Icon viewBox must be 0 0 16 16.");
  if (wrapper) {
    const viewIndex = wrapper.attributes.findIndex((a) => a.name?.name === "viewBox");
    if (wrapper.attributes.some((a, i) => a.type === "JSXSpreadAttribute" && i > viewIndex))
      add(wrapper, "Put viewBox after caller props so it cannot be overridden.");
  }
  if (!paths || paths.type !== "ObjectExpression") {
    add(program, "PATHS must be a statically inspectable icon map.");
    return out;
  }
  for (const icon of paths.properties)
    walk(icon.value, (node) => {
      if (node.type !== "JSXOpeningElement") return;
      const tag = name(node),
        a = attrs(node);
      if (!["path", "circle", "rect", "ellipse", "line", "polyline", "polygon"].includes(tag)) {
        if (tag) add(node, `Unsupported icon geometry ${tag}.`);
        return;
      }
      const inherited = node.attributes.some(
        (a) => a.type === "JSXSpreadAttribute" && a.argument.name === "stroke",
      );
      if (
        node.attributes.some(
          (a) => a.type === "JSXSpreadAttribute" && a.argument.name !== "stroke",
        ) ||
        a.transform
      ) {
        add(node, "Icon geometry must be static, without transforms or unknown spreads.");
        return;
      }
      const sw = a.strokeWidth
        ? Number(attrValue(a.strokeWidth))
        : inherited
          ? strokeValues.strokeWidth
          : a.stroke && attrValue(a.stroke) !== "none"
            ? 1
            : 0;
      if (!Number.isFinite(sw) || a.style) {
        add(node, "Icon stroke and style must be static.");
        return;
      }
      if (sw && sw !== 1.5)
        add(node, `${icon.key.name ?? icon.key.value}: strokeWidth must be 1.5.`);
      const number = (key, fallback = 0) => (a[key] ? Number(attrValue(a[key])) : fallback);
      let bounds;
      try {
        if (tag === "path") bounds = svgPathBbox(String(attrValue(a.d)));
        if (tag === "circle" || tag === "ellipse") {
          const x = number("cx"),
            y = number("cy"),
            rx = number(tag === "circle" ? "r" : "rx"),
            ry = number(tag === "circle" ? "r" : "ry");
          bounds = [x - rx, y - ry, x + rx, y + ry];
        }
        if (tag === "rect") {
          const x = number("x"),
            y = number("y");
          bounds = [x, y, x + number("width"), y + number("height")];
        }
        if (tag === "line")
          bounds = [
            Math.min(number("x1"), number("x2")),
            Math.min(number("y1"), number("y2")),
            Math.max(number("x1"), number("x2")),
            Math.max(number("y1"), number("y2")),
          ];
        if (tag === "polyline" || tag === "polygon") {
          const points = String(attrValue(a.points))
            .trim()
            .split(/[\s,]+/)
            .map(Number);
          const xs = points.filter((_, i) => i % 2 === 0),
            ys = points.filter((_, i) => i % 2);
          bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        }
        if (!bounds?.every(Number.isFinite)) throw new Error("non-static coordinates");
        const half = sw / 2;
        if (
          bounds[0] - half < 0 ||
          bounds[1] - half < 0 ||
          bounds[2] + half > 16 ||
          bounds[3] + half > 16
        )
          add(
            node,
            `${icon.key.name ?? icon.key.value}: bounds including half the stroke escape 0 0 16 16 (${bounds.join(", ")}).`,
          );
      } catch (error) {
        add(node, `Cannot measure ${icon.key.name ?? icon.key.value}: ${error.message}`);
      }
    });
  return out;
}
