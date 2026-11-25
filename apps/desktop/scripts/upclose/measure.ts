import type { Locator } from "@playwright/test";
import type {
  Measurement,
  MeasuredElement,
  MeasuredText,
  Rect,
  Rgba,
  Styles,
  InventoryComponent,
} from "./types.ts";
import { selectorSpecificity } from "./identity.ts";
import { withTextPurposes } from "./text-purpose.ts";
import { scopeRules, type ScopeRule } from "./scope.ts";

export type CaptureInfo = Pick<
  Measurement,
  "component" | "state" | "theme" | "scale" | "gymState" | "crop" | "files"
> & {
  inventory?: Pick<InventoryComponent, "id" | "selector">[];
  scopeRules?: Pick<ScopeRule, "id" | "classes" | "frame">[];
};

/** Runs after the screenshot. Temporary font probes are removed before returning. */
export async function measure(target: Locator, info: CaptureInfo): Promise<Measurement> {
  info = { ...info, scopeRules: scopeRules.filter((rule) => rule.classes || rule.frame) };
  if (info.inventory)
    info = {
      ...info,
      inventory: info.inventory.toSorted(
        (a, b) =>
          selectorSpecificity(b.selector) - selectorSpecificity(a.selector) ||
          a.id.localeCompare(b.id),
      ),
    };
  const measurement = await target.evaluate((root, info): Measurement => {
    const { inventory, scopeRules, ...captureInfo } = info;
    const rect = (r: DOMRect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const colors = new Map<string, Rgba>();
    const parse = (value: string): Rgba => {
      if (colors.has(value)) return colors.get(value)!;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = "transparent";
      canvas.fillStyle = value;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      const result = { r: r!, g: g!, b: b!, a: a! / 255 };
      colors.set(value, result);
      return result;
    };
    const over = (top: Rgba, under: Rgba): Rgba => {
      const a = top.a + under.a * (1 - top.a);
      if (!a) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a,
        g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a,
        b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a,
        a,
      };
    };
    const background = (el: Element): Rgba => {
      const layers: Rgba[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        layers.push(c);
        if (c.a === 1) break;
      }
      return layers
        .reverse()
        .reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
    };
    const selectors = new Map<Element, string>();
    const selector = (el: Element): string => {
      const cached = selectors.get(el);
      if (cached) return cached;
      const parts: string[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        if (e.id) {
          parts.unshift(`#${CSS.escape(e.id)}`);
          break;
        }
        const tag = e.tagName.toLowerCase();
        const classes = [...e.classList].map((c) => `.${CSS.escape(c)}`).join("");
        const index = e.parentElement ? [...e.parentElement.children].indexOf(e) + 1 : 1;
        parts.unshift(`${tag}${classes}:nth-child(${index})`);
        if (tag === "body") break;
      }
      const result = parts.join(" > ");
      selectors.set(el, result);
      return result;
    };
    const properties = [
      "display",
      "position",
      "boxSizing",
      "width",
      "height",
      "minHeight",
      "minWidth",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "marginTop",
      "marginRight",
      "marginBottom",
      "marginLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomRightRadius",
      "borderBottomLeftRadius",
      "gap",
      "columnGap",
      "rowGap",
      "alignItems",
      "justifyContent",
      "flexDirection",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "textTransform",
      "color",
      "backgroundColor",
      "backgroundImage",
      "appearance",
      "visibility",
      "clip",
      "clipPath",
      "opacity",
      "cursor",
      "overflow",
      "overflowX",
      "textOverflow",
      "whiteSpace",
      "outlineStyle",
      "outlineWidth",
      "outlineColor",
      "outlineOffset",
      "boxShadow",
      "transitionProperty",
      "transitionDuration",
      "transitionTimingFunction",
      "transform",
      "zIndex",
    ] as const;
    const elements = new Map<Element, MeasuredElement>();
    const layoutRects: Record<string, Rect> = {};
    const element = (el: Element): MeasuredElement => {
      if (elements.has(el)) return elements.get(el)!;
      const s = getComputedStyle(el);
      const labelled = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      const name =
        el.getAttribute("aria-label") ||
        labelled ||
        el.getAttribute("title") ||
        (el.matches("button,a,[role=button]") ? el.textContent?.trim() : undefined);
      const result: MeasuredElement = {
        selector: selector(el),
        tag: el.tagName.toLowerCase(),
        rect: rect(el.getBoundingClientRect()),
        styles: Object.fromEntries(properties.map((p) => [p, s[p]])) as Styles,
        background: background(el),
        ...(el.getAttribute("role") ? { role: el.getAttribute("role")! } : {}),
        ...(name ? { name } : {}),
      };
      if (s.transform !== "none") {
        let transformedAncestor = false;
        for (let p = el.parentElement; p; p = p.parentElement)
          if (getComputedStyle(p).transform !== "none") transformedAncestor = true;
        const width = parseFloat(s.width),
          height = parseFloat(s.height);
        if (
          !transformedAncestor &&
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          (s.boxSizing === "border-box" || el.tagName.toLowerCase() === "svg")
        ) {
          const [ox, oy] = s.transformOrigin.split(" ").map(parseFloat);
          const matrix = new DOMMatrix(s.transform);
          const points = [
            [0, 0],
            [width, 0],
            [0, height],
            [width, height],
          ].map(([x, y]) => new DOMPoint(x! - ox!, y! - oy!).matrixTransform(matrix));
          layoutRects[result.selector] = {
            x: result.rect.x - Math.min(...points.map((p) => p.x + ox!)),
            y: result.rect.y - Math.min(...points.map((p) => p.y + oy!)),
            width,
            height,
          };
        }
      }
      elements.set(el, result);
      return result;
    };
    const intersects = (r: Rect) =>
      r.width > 0 &&
      r.height > 0 &&
      r.x < info.crop.x + info.crop.width &&
      r.y < info.crop.y + info.crop.height &&
      r.x + r.width > info.crop.x &&
      r.y + r.height > info.crop.y;
    const opacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement)
        o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    // From el outward until an opaque, unfaded box with no faded ancestor hides everything beneath.
    const layersOf = (el: Element) => {
      const layers: { background: Rgba; opacity: number }[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e),
          background = parse(s.backgroundColor),
          o = Number(s.opacity);
        layers.push({ background, opacity: o });
        if (background.a === 1 && o === 1 && (!e.parentElement || opacity(e.parentElement) === 1))
          break;
      }
      return layers;
    };
    const visible = (el: Element) =>
      intersects(rect(el.getBoundingClientRect())) &&
      getComputedStyle(el).visibility !== "hidden" &&
      opacity(el) > 0;
    const textVisible = (el: Element) => {
      if (!visible(el)) return false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e),
          r = e.getBoundingClientRect();
        if (
          e.classList.contains("sr-only") ||
          ((r.width <= 1 || r.height <= 1) &&
            ((s.clip !== "auto" && s.clip !== "") ||
              (s.clipPath !== "none" && s.clipPath !== "") ||
              /hidden|clip/.test(s.overflow)))
        )
          return false;
      }
      return true;
    };
    const layoutRow = (el: Element): string => {
      if (/(?:flex|grid)/.test(getComputedStyle(el).display)) return selector(el);
      for (let e: Element | null = el; e?.parentElement; e = e.parentElement) {
        const parent = e.parentElement,
          s = getComputedStyle(parent);
        if (
          s.display.includes("grid") ||
          (s.display.includes("flex") && s.flexDirection.startsWith("column"))
        )
          return selector(e);
        if (s.display.includes("flex")) return selector(parent);
        // Block siblings form different text flows even when their vertical spans overlap.
        if (getComputedStyle(e).display === "block") return selector(e);
      }
      return selector(el);
    };
    const fontMetrics = new Map<string, { capHeight: number; xHeight: number }>();
    const fontAscents = new Map<string, number>();
    const baselineAscent = (s: CSSStyleDeclaration) => {
      const font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} / ${s.lineHeight} ${s.fontFamily}`;
      const cached = fontAscents.get(font);
      if (cached !== undefined) return cached;
      // Range bounds use Chromium's rounded DOM font metrics, not canvas ascent.
      // Probe outside the target so anonymous flex items and wrapping stay intact.
      const probe = document.createElement("span");
      probe.style.cssText =
        "all: initial; position: fixed; left: 0; top: 0; visibility: hidden; white-space: pre; pointer-events: none;";
      probe.style.font = font;
      const text = document.createTextNode("Hg");
      const marker = document.createElement("span");
      marker.style.cssText =
        "all: initial; display: inline-block; width: 0; height: 0; vertical-align: baseline;";
      probe.append(text, marker);
      document.body.append(probe);
      try {
        const range = document.createRange();
        range.selectNodeContents(text);
        const ascent = marker.getBoundingClientRect().y - range.getBoundingClientRect().y;
        fontAscents.set(font, ascent);
        return ascent;
      } finally {
        probe.remove();
      }
    };
    const heights = (s: CSSStyleDeclaration) => {
      const font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      let value = fontMetrics.get(font);
      if (!value) {
        canvas.font = font;
        value = {
          capHeight: canvas.measureText("H").actualBoundingBoxAscent,
          xHeight: canvas.measureText("x").actualBoundingBoxAscent,
        };
        fontMetrics.set(font, value);
      }
      return value;
    };
    const controlSelector =
      'button,input:not([type="hidden"]),select,textarea,a[href],[role="button"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="combobox"],[tabindex]';
    const purposeOf = (
      el: Element,
      text: string,
    ): NonNullable<Measurement["textContexts"]>[string]["kind"] => {
      if (el.closest(".xterm,.terminal-output")) return "terminal";
      if (el.closest(".run-id")) return "run-id";
      if (
        el.closest(".timer,.elapsed,.call-time,.call-dock-time,.log-time") ||
        (el.matches(".mono") && /^\d{1,3}:\d{2}(?::\d{2})?$/.test(text.trim()))
      )
        return "timer";
      if (
        el.closest(".machine-name,.machine-label") ||
        (el.matches(".mono") &&
          /^[a-z][a-z0-9]*[-._][a-z0-9-._]+$/i.test(text.trim()) &&
          el.closest(
            ".machine-grid,.machine-option,.terminal-main,.thread-main,.run-card,.space-main,.panel-section",
          ))
      )
        return "machine-name";
      if (el.closest("code,pre,.cmd-row,.cmd,.command,.cli-path,.agent-setup")) return "command";
      if (
        el.closest(
          "button,input,select,textarea,.attachments,.reaction,.chip,.tag,.deliveries,.thread-ref",
        )
      )
        return "interface";
      if (
        el.closest(".md,.thread-msg-body,.msg-body") &&
        !el.closest(
          ".msg-head,.msg-foot,.agent-run,.thread-work,.quote-badge,.badge,.edit-keys,.link-preview",
        )
      )
        return "message";
      return "interface";
    };
    const texts: MeasuredText[] = [];
    const textContexts: NonNullable<Measurement["textContexts"]> = {};
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement,
        value = node.textContent ?? "";
      if (!parent || !value.trim() || parent.closest("svg,style,script") || !textVisible(parent))
        continue;
      const range = document.createRange();
      const lines: { start: number; end: number; r: DOMRect }[] = [];
      for (let i = 0; i < value.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const last = lines.at(-1);
        if (last && Math.abs(last.r.y - r.y) < 0.5) {
          last.end = i + 1;
          range.setStart(node, last.start);
          last.r = range.getBoundingClientRect();
        } else lines.push({ start: i, end: i + 1, r });
      }
      const s = getComputedStyle(parent);
      const ascent = baselineAscent(s);
      for (const line of lines) {
        const text = value.slice(line.start, line.end);
        if (!text.trim() || !intersects(rect(line.r))) continue;
        const id = `${selector(parent)}::text(${Array.from<Node>(parent.childNodes).indexOf(node)})[${line.start}:${line.end}]`;
        let clipped = false;
        for (let e: Element | null = parent; e; e = e.parentElement) {
          const cs = getComputedStyle(e),
            b = e.getBoundingClientRect();
          if (
            /(hidden|clip|auto|scroll)/.test(`${cs.overflowX} ${cs.overflowY}`) &&
            (line.r.x < b.x - 0.5 ||
              line.r.right > b.right + 0.5 ||
              line.r.y < b.y - 0.5 ||
              line.r.bottom > b.bottom + 0.5)
          )
            clipped = true;
        }
        texts.push({
          ...element(parent),
          selector: id,
          text,
          inkRect: rect(line.r),
          baseline: line.r.y + ascent,
          ...heights(s),
          layoutRow: layoutRow(parent),
          clipped,
        });
        textContexts[id] = {
          kind: purposeOf(parent, text),
          disabled: !!parent.closest(':disabled,[aria-disabled="true"]'),
          effectiveOpacity: opacity(parent),
          layers: layersOf(parent),
        };
      }
    }
    for (const control of [
      ...(root.matches("input,textarea,select") ? [root] : []),
      ...root.querySelectorAll("input,textarea,select"),
    ].filter(textVisible)) {
      const native = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      let value =
        native instanceof HTMLSelectElement
          ? (native.selectedOptions[0]?.textContent ?? "")
          : native.value || native.getAttribute("placeholder") || "";
      if (
        !value ||
        (native instanceof HTMLInputElement &&
          ["checkbox", "radio", "range", "color", "file"].includes(native.type))
      )
        continue;
      if (native instanceof HTMLInputElement && native.type === "password" && native.value)
        value = "•".repeat([...native.value].length);
      const e = element(control),
        s = getComputedStyle(control);
      const textStyle =
        !native.value && native.hasAttribute("placeholder")
          ? getComputedStyle(control, "::placeholder")
          : s;
      canvas.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const metrics = canvas.measureText(value),
        h = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
      const x = e.rect.x + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
        y = e.rect.y + (e.rect.height - h) / 2;
      const id = `${e.selector}::value`;
      texts.push({
        ...e,
        selector: id,
        text: value,
        styles: { ...e.styles, color: textStyle.color },
        inkRect: { x, y, width: metrics.width, height: h },
        baseline: y + metrics.fontBoundingBoxAscent,
        ...heights(s),
        layoutRow: layoutRow(control),
        clipped:
          metrics.width >
          control.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
      });
      textContexts[id] = {
        kind: purposeOf(control, value),
        disabled: control.matches(":disabled"),
        effectiveOpacity: opacity(control),
        layers: layersOf(control),
      };
    }
    const textRows: string[][] = [];
    for (const text of texts) {
      const row = textRows.find((row) =>
        row.every((id) => {
          const peer = texts.find((t) => t.selector === id)!;
          return (
            peer.layoutRow === text.layoutRow &&
            Math.abs(peer.inkRect.y - text.inkRect.y) <
              Math.min(peer.inkRect.height, text.inkRect.height) * 0.5
          );
        }),
      );
      if (row) row.push(text.selector);
      else textRows.push([text.selector]);
    }
    const iconContexts: NonNullable<Measurement["iconContexts"]> = {};
    const icons = [...(root.matches("svg") ? [root] : []), ...root.querySelectorAll("svg")]
      .filter(visible)
      .map((svg) => {
        const shapes = [
          ...svg.querySelectorAll<SVGGraphicsElement>(
            "path,circle,line,rect,polyline,polygon,ellipse",
          ),
        ];
        const boxes = shapes
          .filter((s) => getComputedStyle(s).display !== "none")
          .map((s) => {
            const b = s.getBBox(),
              matrix = s.getCTM(),
              inv = (svg as SVGSVGElement).getCTM()?.inverse();
            if (!matrix || !inv) return rect(b);
            const m = inv.multiply(matrix),
              points = [
                [b.x, b.y],
                [b.x + b.width, b.y],
                [b.x, b.y + b.height],
                [b.x + b.width, b.y + b.height],
              ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
            const x = Math.min(...points.map((p) => p.x)),
              y = Math.min(...points.map((p) => p.y));
            return {
              x,
              y,
              width: Math.max(...points.map((p) => p.x)) - x,
              height: Math.max(...points.map((p) => p.y)) - y,
            };
          });
        const x = Math.min(...boxes.map((b) => b.x)),
          y = Math.min(...boxes.map((b) => b.y));
        const iconName = svg.getAttribute("data-icon");
        const result = {
          ...element(svg),
          viewBox: svg.getAttribute("viewBox"),
          attrWidth: svg.getAttribute("width"),
          attrHeight: svg.getAttribute("height"),
          strokeWidths: shapes.map((s) => parseFloat(getComputedStyle(s).strokeWidth)),
          bbox: boxes.length
            ? {
                x,
                y,
                width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
                height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
              }
            : null,
          iconName,
        };
        const parent = svg.parentElement ?? svg;
        const wrapper = parent;
        let alignmentRect: Rect | undefined;
        const ws = getComputedStyle(wrapper);
        if (ws.display.includes("grid")) {
          const wr = wrapper.getBoundingClientRect(),
            ir = svg.getBoundingClientRect();
          const track = (values: string, start: number, gap: number, at: number) => {
            const sizes = values.split(/\s+/).map(Number.parseFloat);
            if (!sizes.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
            for (const size of sizes) {
              if (at >= start - 0.5 && at <= start + size + 0.5) return { start, size };
              start += size + gap;
            }
            return undefined;
          };
          const col = track(
            ws.gridTemplateColumns,
            wr.x + parseFloat(ws.borderLeftWidth) + parseFloat(ws.paddingLeft),
            parseFloat(ws.columnGap) || 0,
            ir.x + ir.width / 2,
          );
          const row = track(
            ws.gridTemplateRows,
            wr.y + parseFloat(ws.borderTopWidth) + parseFloat(ws.paddingTop),
            parseFloat(ws.rowGap) || 0,
            ir.y + ir.height / 2,
          );
          if (col && row)
            alignmentRect = { x: col.start, y: row.start, width: col.size, height: row.size };
        }
        const label = texts.find((t) => {
          if (ws.flexDirection.startsWith("column")) return false;
          if (alignmentRect)
            return (
              t.inkRect.x >= alignmentRect.x &&
              t.inkRect.x + t.inkRect.width <= alignmentRect.x + alignmentRect.width &&
              t.inkRect.y >= alignmentRect.y &&
              t.inkRect.y + t.inkRect.height <= alignmentRect.y + alignmentRect.height
            );
          return ws.display.includes("flex") && t.layoutRow === selector(wrapper);
        });
        const flow =
          ws.display.includes("flex") && !ws.flexDirection.startsWith("column")
            ? [...wrapper.childNodes]
                .flatMap((node) => {
                  if (node instanceof Element) {
                    const s = getComputedStyle(node);
                    return textVisible(node) && !["absolute", "fixed"].includes(s.position)
                      ? [rect(node.getBoundingClientRect())]
                      : [];
                  }
                  if (!node.textContent?.trim()) return [];
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  return [rect(range.getBoundingClientRect())];
                })
                .filter((r) => r.width > 0 && r.height > 0)
            : [];
        const left = Math.min(...flow.map((r) => r.x)),
          top = Math.min(...flow.map((r) => r.y));
        const contentGroup = flow.length
          ? {
              x: left,
              y: top,
              width: Math.max(...flow.map((r) => r.x + r.width)) - left,
              height: Math.max(...flow.map((r) => r.y + r.height)) - top,
            }
          : undefined;
        iconContexts[result.selector] = {
          container: element(wrapper),
          ...(alignmentRect ? { alignmentRect } : {}),
          ...(contentGroup ? { contentGroup } : {}),
          ...(label ? { labelSelector: label.selector } : {}),
          ...(iconName ? { family: "Icon" } : {}),
          paintedStrokeWidths: shapes
            .filter(
              (s) =>
                getComputedStyle(s).stroke !== "none" &&
                parseFloat(getComputedStyle(s).strokeOpacity) > 0,
            )
            .map((s) => parseFloat(getComputedStyle(s).strokeWidth)),
        };
        return result;
      });
    const peers = root.parentElement ? [...root.parentElement.children].filter(visible) : [root];
    const ps = root.parentElement ? getComputedStyle(root.parentElement) : null;
    const flex = ps?.display.includes("flex"),
      grid = ps?.display.includes("grid");
    const r = root.getBoundingClientRect();
    const rowPeers =
      (flex && !ps?.flexDirection.startsWith("column")) || grid
        ? peers
            .filter((p) => {
              const b = p.getBoundingClientRect();
              return Math.abs(b.y + b.height / 2 - r.y - r.height / 2) <= 1;
            })
            .map(element)
        : [];
    const columnPeers =
      (flex && ps?.flexDirection.startsWith("column")) || grid || ps?.display === "block"
        ? peers
            .filter((p) => {
              const b = p.getBoundingClientRect();
              return (
                Math.abs(b.width - r.width) <= 1 && Math.min(b.right, r.right) > Math.max(b.x, r.x)
              );
            })
            .map(element)
        : [];
    const extraElements = [...root.querySelectorAll("*")]
      .filter(visible)
      .filter((el) => {
        if (el.matches(`${controlSelector},hr,[role="separator"],.divider,.sep`)) return true;
        const s = getComputedStyle(el),
          r = el.getBoundingClientRect();
        return (
          [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].some(
            (v) => parseFloat(v) > 0,
          ) ||
          (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
          r.width === 1 ||
          r.height === 1
        );
      })
      .map(element);
    const elementKinds: NonNullable<Measurement["elementKinds"]> = {};
    for (const [el, e] of elements) {
      if (el.matches(".btn"))
        elementKinds[e.selector] = el.matches(".icon") ? "icon-button" : "button";
      else if (
        el.matches(".main-head,.drawer-head,.sidebar-top,.sidebar-bottom,.viewer-head,.rail-head")
      )
        elementKinds[e.selector] = "title-row";
      else if (el.matches(controlSelector)) elementKinds[e.selector] = "control";
      else if (el.matches('hr,[role="separator"],.divider,.sep'))
        elementKinds[e.selector] = "hairline";
    }
    const hits = Array.from({ length: 25 }, (_, i) => {
      const x = r.x + r.width * (((i % 5) + 0.5) / 5),
        y = r.y + r.height * ((Math.floor(i / 5) + 0.5) / 5),
        hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitsTarget: !!hit && (root === hit || root.contains(hit)),
        hit: hit ? selector(hit) : "outside viewport",
      };
    });
    const targetElement = element(root);
    // element(root) may be new when it has no visible descendants.
    if (root.matches(".btn"))
      elementKinds[targetElement.selector] = root.matches(".icon") ? "icon-button" : "button";
    else if (root.matches(controlSelector)) elementKinds[targetElement.selector] = "control";
    let focus: Measurement["focus"] = null;
    if (
      info.state === "focus-visible" &&
      document.activeElement &&
      document.activeElement !== document.body
    ) {
      const el = document.activeElement,
        s = getComputedStyle(el);
      let ringColor = parse(s.outlineColor),
        ringWidth = s.outlineStyle === "none" ? 0 : parseFloat(s.outlineWidth);
      if (!ringWidth && s.boxShadow !== "none") {
        const color = s.boxShadow.match(/rgba?\([^)]*\)|color\([^)]*\)/)?.[0];
        const widths =
          s.boxShadow
            .replace(/rgba?\([^)]*\)|color\([^)]*\)/g, "")
            .match(/-?[\d.]+px/g)
            ?.map(parseFloat) ?? [];
        ringWidth = Math.max(0, ...widths.slice(2));
        if (color) ringColor = parse(color);
      }
      focus = {
        element: element(el),
        ringColor: ringWidth ? ringColor : null,
        ringWidth,
        adjacent: background(el.parentElement ?? el),
      };
    }
    const rootStyles = getComputedStyle(document.documentElement),
      tokens: Record<string, string> = {};
    // Chromium can enumerate custom properties in a different order in a fresh process.
    for (const property of [...rootStyles].filter((p) => p.startsWith("--")).sort())
      tokens[property] = rootStyles.getPropertyValue(property).trim();
    const owners: NonNullable<Measurement["owners"]> = {};
    const candidates = inventory ?? [];
    const matching = new Map<Element, { component: string; root: string }>();
    for (const candidate of candidates) {
      // Native CSS supports :has, but Playwright's text pseudos need their text predicate here.
      const texts: { text: string; exact: boolean }[] = [];
      const css = candidate.selector.replace(
        /:(has-text|text-is)\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g,
        (_all, kind: string, quoted: string) => {
          texts.push({ text: quoted.slice(1, -1), exact: kind === "text-is" });
          return "";
        },
      );
      for (const el of document.querySelectorAll(css)) {
        const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
        if (
          !texts.every((t) =>
            t.exact
              ? [el, ...el.querySelectorAll("*")].some(
                  (node) => normalize(node.textContent ?? "") === t.text,
                )
              : normalize(el.textContent ?? "")
                  .toLowerCase()
                  .includes(t.text.toLowerCase()),
          )
        )
          continue;
        if (!matching.has(el)) matching.set(el, { component: candidate.id, root: selector(el) });
      }
    }
    for (const [el, value] of elements) {
      for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
        const owner = matching.get(ancestor);
        if (owner) {
          owners[value.selector] = owner;
          break;
        }
      }
    }
    const rotations: NonNullable<Measurement["rotations"]> = {};
    for (const svg of [...(root.matches("svg") ? [root] : []), ...root.querySelectorAll("svg")]) {
      if (svg.matches(".state-icon.live svg"))
        rotations[selector(svg)] = svg.getAnimations().some((a) => a.playState === "running")
          ? "running"
          : "paused-at-zero";
    }
    const scopeMatches: NonNullable<Measurement["scopeMatches"]> = {};
    for (const [el, value] of elements) {
      const matches = (scopeRules ?? [])
        .filter(
          (rule) =>
            rule.classes?.some((name) => el.closest(`.${name}`)) ||
            (rule.frame?.path === location.pathname && el.matches(rule.frame.selector)),
        )
        .map((rule) => rule.id);
      if (matches.length) scopeMatches[value.selector] = matches;
    }
    return {
      ...captureInfo,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      target: targetElement,
      icons,
      texts,
      rowPeers,
      columnPeers,
      hits,
      focus,
      tokens,
      iconContexts,
      textContexts,
      elementKinds,
      extraElements,
      textRows,
      layoutRects,
      ...(inventory ? { owners } : {}),
      rotations,
      scopeMatches,
      inputState: {
        hovered: root.matches(":hover"),
        active: root.matches(":active"),
        focusVisible: root.matches(":focus-visible"),
        focusedSelector:
          document.activeElement && document.activeElement !== document.body
            ? selector(document.activeElement)
            : null,
      },
    };
  }, info);
  return withTextPurposes(measurement);
}
