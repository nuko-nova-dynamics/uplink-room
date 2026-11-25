import { expect, it } from "vitest";
import { element, measurement, text } from "../fixtures.ts";
import { evenSpacing } from "./even-spacing.ts";

it("accepts even padding, icon insets, peer heights, left edges and baselines", () => {
  const m = measurement();
  m.rowPeers.push(element(".other"));
  m.columnPeers = [element(".a"), element(".b")];
  m.texts = [text(".first"), text(".second")];
  expect(evenSpacing(m)).toEqual([]);
});
it("reports unequal padding and accounts for icon-only insets", () => {
  const m = measurement();
  m.target.styles.paddingLeft = "1px";
  m.icons[0]!.rect.y += 1;
  expect(evenSpacing(m)).toHaveLength(2);
});
it("reports row heights, column left edges and same-row baselines", () => {
  const m = measurement();
  m.rowPeers.push(element(".other", { rect: { x: 10, y: 20, width: 28, height: 30 } }));
  m.columnPeers = [element(".a"), element(".b", { rect: { x: 11, y: 50, width: 28, height: 28 } })];
  m.texts = [text(".first"), text(".second")];
  m.texts[1]!.baseline += 1;
  expect(evenSpacing(m)).toHaveLength(3);
});
it("does not compare different visual rows and supports explicit row membership", () => {
  const m = measurement();
  m.texts = [text(".first"), text(".second")];
  m.texts[1]!.inkRect.y += 25;
  m.texts[1]!.baseline += 25;
  expect(evenSpacing(m)).toEqual([]);
  m.textRows = [[".first", ".second"]];
  expect(evenSpacing(m)).toHaveLength(1);
});

it("keeps independently centered grid text out of adjacent label baseline comparisons", () => {
  const m = measurement({ icons: [], texts: [text(".face"), text(".label")] });
  m.texts[0]!.styles.display = "grid";
  m.texts[0]!.baseline += 4;
  m.textRows = [[".face", ".label"]];
  expect(evenSpacing(m)).toEqual([]);
});

it("leaves a raised superscript out of its row's baselines", () => {
  const m = measurement();
  m.texts = [text("p > span.first"), text("p > sup.quote-badge")];
  m.texts[1]!.baseline -= 5;
  m.textRows = [["p > span.first", "p > sup.quote-badge"]];
  expect(evenSpacing(m)).toEqual([]);
});

it("excludes invisible text and keeps independent layout rows separate", () => {
  const m = measurement();
  m.texts = [
    text(".row > .label"),
    text(".row > .sr-only"),
    text(".row > .transparent"),
    text(".left > span"),
    text(".right > span"),
  ];
  for (const t of m.texts.slice(1)) t.baseline += 4;
  m.textContexts = { ".row > .transparent": { kind: "interface", effectiveOpacity: 0 } };
  m.textRows = [m.texts.map((t) => t.selector)];
  expect(evenSpacing(m)).toEqual([]);
  m.texts[1]!.selector = ".row > .visible";
  m.textRows = [m.texts.map((t) => t.selector)];
  expect(evenSpacing(m)).toHaveLength(1);
  m.texts[1]!.rect.width = 1;
  expect(evenSpacing(m)).toEqual([]);
});

it("subtracts reserved chevron space only for selects with an app chevron", () => {
  const m = measurement({ icons: [] });
  m.target.tag = "select";
  m.target.selector = "select.select";
  Object.assign(m.target.styles, {
    paddingLeft: "10px",
    paddingRight: "28px",
    appearance: "none",
    backgroundImage: 'url("data:image/svg+xml,chevron")',
  });
  expect(evenSpacing(m)).toEqual([]);
  m.target.styles.paddingRight = "29px";
  expect(evenSpacing(m)).toHaveLength(1);
  m.target.styles.backgroundImage = "none";
  expect(evenSpacing(m)[0]!.measured).toMatchObject({ spread: "19px" });
});

it("compares input padding after reserving its positioned search icon", () => {
  const m = measurement();
  m.target.tag = "input";
  m.target.selector = "#search";
  m.target.rect.width = 120;
  m.target.styles.paddingLeft = "30px";
  m.target.styles.paddingRight = "10px";
  m.icons[0]!.styles.position = "absolute";
  expect(evenSpacing(m)).toEqual([]);
  m.target.styles.paddingLeft = "31px";
  expect(evenSpacing(m)).toHaveLength(1);
});

it("keeps adjacent columns out of a column's left-edge comparison", () => {
  const m = measurement({ icons: [] });
  m.columnPeers = [m.target, element(".next-column", { rect: { ...m.target.rect, x: 38 } })];
  expect(evenSpacing(m)).toEqual([]);
  m.columnPeers[1]!.rect.x = 11;
  expect(evenSpacing(m)).toHaveLength(1);
});
