import { expect, it } from "vitest";
import { labeled, measurement, text } from "../fixtures.ts";
import type { Measurement } from "../types.ts";
import { sizes } from "./sizes.ts";

it("accepts DESIGN.md button, icon, label, weight and font values", () => {
  expect(sizes(measurement())).toEqual([]);
  expect(sizes(labeled())).toEqual([]);
});
it.each<[string, (m: Measurement) => void]>([
  [
    "height",
    (m) => {
      m.target.rect.height = 29;
    },
  ],
  [
    "width",
    (m) => {
      m.target.rect.width = 29;
    },
  ],
  [
    "radius",
    (m) => {
      m.target.styles.borderTopLeftRadius = "8px";
    },
  ],
  [
    "edge",
    (m) => {
      m.target.styles.borderTopWidth = "2px";
    },
  ],
  [
    "icon size",
    (m) => {
      m.icons[0]!.rect.width = 16;
    },
  ],
  [
    "font size",
    (m) => {
      m.texts = [text()];
      m.texts[0]!.styles.fontSize = "14px";
    },
  ],
  [
    "weight",
    (m) => {
      m.texts = [text()];
      m.texts[0]!.styles.fontWeight = "600";
    },
  ],
  [
    "font family",
    (m) => {
      m.texts = [text()];
      m.texts[0]!.styles.fontFamily = "Arial";
    },
  ],
])("rejects wrong %s", (_name, mutate) => {
  const m = measurement();
  mutate(m);
  expect(sizes(m).length).toBeGreaterThan(0);
});
it("checks CSS and measured icon-label gaps", () => {
  const m = labeled();
  m.target.styles.gap = "7px";
  m.texts[0]!.inkRect.x += 2;
  expect(sizes(m)).toHaveLength(2);
});
it("keeps the documented control size when a token is off scale", () => {
  const m = measurement();
  m.tokens["--ctl-h"] = "30px";
  m.target.rect.width = 30;
  m.target.rect.height = 30;
  expect(sizes(m).map((f) => f.expected)).toEqual([{ height: "28px" }, { width: "28px" }]);
});
it("checks title rows, messages and allowed monospace purposes", () => {
  const m = measurement({ icons: [] });
  m.target.tag = "header";
  m.elementKinds = { [m.target.selector]: "title-row" };
  m.target.rect.height = 52;
  const t = text();
  t.styles.fontSize = "15px";
  m.texts = [t];
  m.textContexts = { [t.selector]: { kind: "message" } };
  expect(sizes(m)).toEqual([]);
  t.styles.fontSize = "13px";
  t.styles.fontFamily = '"Atkinson Hyperlegible Mono", monospace';
  m.textContexts[t.selector] = { kind: "timer" };
  expect(sizes(m)).toEqual([]);
  m.textContexts[t.selector] = { kind: "interface" };
  expect(sizes(m)).toHaveLength(1);
  m.target.rect.height = 51;
  expect(sizes(m)).toHaveLength(2);
});
it("checks the 8px spacing between controls in a row", () => {
  const m = measurement();
  m.rowPeers.push({ ...m.target, selector: ".btn.second", rect: { ...m.target.rect, x: 46 } });
  expect(sizes(m)).toEqual([]);
  m.rowPeers[1]!.rect.x = 47;
  expect(sizes(m)[0]!.message).toContain("rowGap");
});
it("recognizes title row selectors without optional semantic metadata", () => {
  const m = measurement({ icons: [] });
  m.target.selector = ".main-head";
  m.target.tag = "header";
  m.target.rect.height = 52;
  expect(sizes(m)).toEqual([]);
  m.target.rect.height = 51;
  expect(sizes(m)).toHaveLength(1);
});

it("measures a rotating working icon without treating rotation as scaling", () => {
  const m = measurement();
  const icon = m.icons[0]!;
  icon.rect.width = icon.rect.height = 19.793;
  Object.assign(icon.styles, {
    width: "14px",
    height: "14px",
    transform: "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)",
  });
  expect(sizes(m).filter((f) => f.selector === icon.selector)).toEqual([]);
  icon.styles.transform = "matrix(2, 0, 0, 2, 0, 0)";
  expect(sizes(m).filter((f) => f.selector === icon.selector)).toHaveLength(2);
});

it("accepts the type scale and only permits Mono for documented purposes", () => {
  const m = measurement({ icons: [], texts: [text()] });
  for (const size of [11, 12, 13, 15, 20]) {
    m.texts[0]!.styles.fontSize = `${size}px`;
    expect(sizes(m)).toEqual([]);
  }
  m.texts[0]!.styles.fontSize = "11.96px";
  expect(sizes(m).some((f) => "fontSize" in (f.measured as object))).toBe(true);
  m.texts[0]!.styles.fontFamily = '"Atkinson Hyperlegible Mono"';
  m.texts[0]!.styles.fontSize = "12px";
  expect(sizes(m).some((f) => "fontFamily" in (f.measured as object))).toBe(true);
  m.textContexts = { [m.texts[0]!.selector]: { kind: "command" } };
  expect(sizes(m)).toEqual([]);
  m.texts[0]!.styles.fontSize = "15px";
  expect(sizes(m)).toHaveLength(1);
});

it("uses small controls, chips, the default, the composer and empty-state icon sizes", () => {
  for (const [selector, size] of [
    [".btn.small", 12],
    [".chip", 12],
    [".icon-btn", 14],
    ["h2.title", 14],
    [".nav-item", 14],
    [".composer-send", 16],
    [".mode-option", 16],
    [".empty-state", 20],
  ] as const) {
    const m = measurement();
    m.target.selector = selector;
    if (selector === ".empty-state") m.target.tag = "div";
    m.target.rect.width = m.target.rect.height =
      selector === ".btn.small" || selector === ".icon-btn" ? 24 : 28;
    const icon = m.icons[0]!;
    icon.selector = `${selector} > svg`;
    icon.rect.width = icon.rect.height = size;
    m.iconContexts = { [icon.selector]: { container: m.target } };
    expect(sizes(m).filter((f) => f.selector === icon.selector)).toEqual([]);
    icon.rect.width = size + 1;
    expect(sizes(m).some((f) => f.selector === icon.selector)).toBe(true);
  }
});

it("uses control, card, dialog and full-pill radii", () => {
  for (const [selector, height, radius] of [
    [".btn.small", 24, "6px"],
    [".stage-controls > .btn.icon", 36, "8px"],
    [".panel", 28, "8px"],
    [".dialog", 28, "12px"],
    [".chip", 20, "99px"],
  ] as const) {
    const m = measurement({ icons: [] });
    m.target.selector = selector;
    m.target.rect.width = m.target.rect.height = height;
    for (const key of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      m.target.styles[key] = radius;
    expect(sizes(m)).toEqual([]);
    m.target.styles.borderTopLeftRadius = "4px";
    expect(sizes(m)).toHaveLength(1);
  }
});

it("accepts inset rows at 6px, inline tags at 4px and any fully rounded box as a pill", () => {
  for (const [selector, width, height, radius] of [
    ["nav > button.nav-item", 220, 28, "6px"],
    ["div > span.tag", 40, 16, "4px"],
    ["p > img", 120, 80, "4px"],
    ["div > button.reaction", 44, 22, "11px"],
    ["div > span.badge", 18, 18, "99px"],
  ] as const) {
    const m = measurement({ icons: [] });
    m.target.selector = selector;
    m.target.rect.width = width;
    m.target.rect.height = height;
    for (const key of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      m.target.styles[key] = radius;
    expect(sizes(m)).toEqual([]);
  }
  const card = measurement({ icons: [] });
  card.target.selector = "div > article.comment-card";
  card.target.rect.width = 240;
  card.target.rect.height = 80;
  for (const key of [
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
  ] as const)
    card.target.styles[key] = "10px";
  expect(sizes(card).length).toBeGreaterThan(0);
});

it("leaves a face's initials off the type scale", () => {
  const m = measurement({ icons: [] });
  m.texts = [text("div > span.face::text(0)[0:2]")];
  m.texts[0]!.styles.fontSize = "19px";
  expect(sizes(m)).toEqual([]);
});

it("allows Mono for codes, tokens and endpoint URLs people paste", () => {
  const m = measurement({ icons: [] });
  m.texts = [text("#pair-code-input::value")];
  m.texts[0]!.styles.fontFamily = '"Atkinson Hyperlegible Mono", monospace';
  m.texts[0]!.styles.fontSize = "13px";
  m.textContexts = { "#pair-code-input::value": { kind: "code" } };
  expect(sizes(m)).toEqual([]);
});

it("skips radius on unpainted boxes, reads percent circles as pills, and knows bubbles and Inbox cards", () => {
  const set = (m: Measurement, radius: string) => {
    for (const key of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      m.target.styles[key] = radius;
  };
  const plain = measurement({ icons: [] });
  plain.target.selector = "pre > code";
  plain.target.styles.backgroundColor = "rgba(0, 0, 0, 0)";
  for (const w of [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
  ] as const)
    plain.target.styles[w] = "0px";
  plain.target.styles.boxShadow = "none";
  set(plain, "0px");
  expect(sizes(plain)).toEqual([]);
  for (const [selector, w, h, radius] of [
    ["div > img.face-picture", 24, 24, "50%"],
    ["div > div.bubble", 320, 60, "14px"],
    ["div > div.inbox-row", 640, 56, "8px"],
  ] as const) {
    const m = measurement({ icons: [] });
    m.target.selector = selector;
    m.target.rect.width = w;
    m.target.rect.height = h;
    set(m, radius);
    expect(sizes(m)).toEqual([]);
  }
});

it("ignores a transparent border, gives pins 4px and doesn't square the labeled Leave", () => {
  const set = (m: Measurement, radius: string) => {
    for (const key of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      m.target.styles[key] = radius;
  };
  const row = measurement({ icons: [] });
  row.target.selector = "div > div.msg";
  row.target.styles.backgroundColor = "rgba(0, 0, 0, 0)";
  row.target.styles.boxShadow = "none";
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    row.target.styles[`border${side}Width`] = "1px";
    row.target.styles[`border${side}Color`] = "rgba(0, 0, 0, 0)";
  }
  set(row, "3px");
  expect(sizes(row)).toEqual([]);
  const pin = measurement({ icons: [] });
  pin.target.selector = "div > button.pin";
  pin.target.rect.width = pin.target.rect.height = 22;
  set(pin, "4px");
  expect(sizes(pin).filter((f) => JSON.stringify(f.measured).includes("Radius"))).toEqual([]);
  const leave = measurement({ icons: [] });
  leave.target.selector = "div.stage-controls > button.btn.icon.leave";
  leave.target.rect.width = 52;
  leave.target.rect.height = 36;
  set(leave, "99px");
  expect(sizes(leave).filter((f) => JSON.stringify(f.measured).includes("width"))).toEqual([]);
});

it("prioritizes control sizes inside empty states and recognizes Space placeholders", () => {
  for (const [selector, tag, size] of [
    [".empty-state > button.btn", "button", 14],
    [".empty-state > button.btn.small", "button", 12],
    [".space-state > button.btn", "button", 14],
    [".space-state", "div", 20],
  ] as const) {
    const m = measurement();
    m.target.selector = selector;
    m.target.tag = tag;
    const icon = m.icons[0]!;
    icon.selector = `${selector} > svg`;
    icon.rect.width = icon.rect.height = size;
    m.iconContexts = { [icon.selector]: { container: m.target } };
    expect(sizes(m).filter((f) => f.selector === icon.selector)).toEqual([]);
    icon.rect.width += 1;
    expect(sizes(m).filter((f) => f.selector === icon.selector)).toHaveLength(1);
  }
});

it("distinguishes a header icon control from a bare row action", () => {
  for (const [selector, height, radius] of [
    ["header.main-head > button.icon-btn", 28, "7px"],
    ["div.dialog-head > button.btn.icon", 28, "7px"],
    ["div.row-flex > button.icon-btn", 24, "6px"],
    ["header.main-head > div.pop > button.btn.small", 24, "6px"],
  ] as const) {
    const m = measurement({ icons: [] });
    m.target.selector = selector;
    m.target.rect.width = m.target.rect.height = height;
    for (const key of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      m.target.styles[key] = radius;
    expect(sizes(m)).toEqual([]);
  }
});

it("accepts emoji content without allowing an emoji font for interface labels", () => {
  const m = measurement({ icons: [], texts: [text("span.reaction-emoji::text")] });
  m.texts[0]!.styles.fontFamily = '"Noto Color Emoji"';
  m.textContexts = { "span.reaction-emoji::text": { kind: "emoji" } };
  expect(sizes(m)).toEqual([]);
  m.textContexts["span.reaction-emoji::text"]!.kind = "interface";
  expect(
    sizes(m).some(
      (finding) => finding.message === "Text uses the wrong font family for its purpose.",
    ),
  ).toBe(true);
});
