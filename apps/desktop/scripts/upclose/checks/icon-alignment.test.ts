import { expect, it } from "vitest";
import { imageFor, labeled, measurement, paint, raster } from "../fixtures.ts";
import { labelCapCenter } from "../text-metrics.ts";
import { iconAlignment } from "./icon-alignment.ts";

it("accepts centered icon-only and labeled controls in layout and raster", () => {
  for (const m of [measurement(), labeled()])
    expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
});
it("identifies layout offsets beyond half a CSS pixel", () => {
  const m = measurement({ scale: 1 });
  m.icons[0]!.rect.x += 0.6;
  expect(iconAlignment(m)[0]?.measured).toMatchObject({ source: "layout" });
  m.icons[0]!.rect.x -= 0.1;
  expect(iconAlignment(m)).toEqual([]);
});
it("identifies raster offsets independently of correct layout", () => {
  const m = measurement(),
    r = raster();
  paint(r, 24, 22, 20, 20);
  const result = iconAlignment(m, { crop: r });
  expect(result).toHaveLength(1);
  expect(result[0]!.measured).toMatchObject({ source: "raster" });
});
it("compares icon and label centers and distinguishes missing ink", () => {
  const m = labeled();
  m.scale = 1;
  m.texts[0]!.baseline += 1;
  expect(iconAlignment(m).some((f) => f.message.includes("label"))).toBe(true);
  const empty = measurement();
  expect(iconAlignment(empty, { crop: raster() })[0]!.message).toContain("no visible");
});
it("uses actual nested containers instead of a large view's center", () => {
  const m = measurement();
  m.target.rect.width = 150;
  m.iconContexts = {
    [m.icons[0]!.selector]: {
      container: { ...m.target, rect: { x: 10, y: 20, width: 28, height: 28 } },
    },
  };
  expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
});
it("centers a labeled group when its explicit container is the whole button", () => {
  const m = labeled();
  m.iconContexts = {
    [m.icons[0]!.selector]: { container: m.target, labelSelector: m.texts[0]!.selector },
  };
  expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
});
it("reports missing container context for multiple icons", () => {
  const m = measurement({ scale: 1 });
  m.icons.push({ ...m.icons[0]!, selector: ".second" });
  expect(iconAlignment(m)).toHaveLength(2);
});

it("checks the leading content edge for a left-aligned navigation row", () => {
  const m = labeled();
  m.scale = 1;
  m.target.selector = ".nav-item";
  m.target.rect.width = 200;
  Object.assign(m.target.styles, {
    display: "flex",
    justifyContent: "normal",
    paddingLeft: "16px",
    paddingRight: "16px",
  });
  m.iconContexts = {
    [m.icons[0]!.selector]: { container: m.target, labelSelector: m.texts[0]!.selector },
  };
  expect(iconAlignment(m)).toEqual([]);
  m.icons[0]!.rect.x += 1;
  expect(iconAlignment(m)).toHaveLength(1);
});

it("uses ink bounds rather than density-weighted centroids for asymmetric drawings", () => {
  const m = measurement(),
    r = raster();
  paint(r, 20, 20, 24, 2);
  paint(r, 20, 20, 2, 24);
  expect(iconAlignment(m, { crop: r })).toEqual([]);
});

it("does not pair clipped one-pixel screen-reader labels with a visible icon", () => {
  const m = labeled();
  m.scale = 1;
  m.texts[0]!.rect = { x: 27, y: 27, width: 1, height: 1 };
  m.texts[0]!.inkRect.y += 20;
  m.iconContexts = {
    [m.icons[0]!.selector]: {
      container: { ...m.target, rect: m.icons[0]!.rect, styles: {} },
      labelSelector: m.texts[0]!.selector,
    },
  };
  expect(iconAlignment(m)).toEqual([]);
});

it("centers a grid icon in its cell rather than across the entire multi-row control", () => {
  const m = measurement({ scale: 1 });
  m.target.rect.width = 200;
  m.target.rect.height = 80;
  m.iconContexts = {
    [m.icons[0]!.selector]: {
      container: m.target,
      alignmentRect: { x: 10, y: 20, width: 28, height: 28 },
    },
  };
  expect(iconAlignment(m)).toEqual([]);
  m.icons[0]!.rect.y += 1;
  expect(iconAlignment(m)).toHaveLength(1);
});

it("compares both icon measurements to a letter-independent cap band", () => {
  const m = labeled();
  for (const word of ["Save", "Forget"]) {
    m.texts[0]!.text = word;
    m.texts[0]!.inkRect.height = word === "Forget" ? 18 : 14;
    expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
  }
  // Legacy captures use the pinned font's OS/2 cap-height ratio.
  delete m.texts[0]!.capHeight;
  m.texts[0]!.baseline = 34 + (13 * 0.668) / 2;
  expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
  m.texts[0]!.baseline += 1;
  const offsets = iconAlignment(m, { crop: imageFor(m) }).filter((f) =>
    f.message.includes("cap band"),
  );
  expect(offsets.map((f) => f.measured)).toEqual([
    { source: "layout", labelOffset: "-1px" },
    { source: "raster", labelOffset: "-1px" },
  ]);
});

it("does not pair an icon with text in another grid cell", () => {
  const m = labeled();
  m.scale = 1;
  m.texts[0]!.inkRect.y += 10.5;
  m.texts[0]!.baseline += 10.5;
  m.iconContexts = {
    [m.icons[0]!.selector]: {
      container: { ...m.target, styles: { display: "grid" } },
      alignmentRect: { ...m.icons[0]!.rect },
      labelSelector: m.texts[0]!.selector,
    },
  };
  expect(iconAlignment(m)).toEqual([]);
});

it("centers the whole flex content group when a trailing icon has a nested label", () => {
  const m = measurement({ scale: 1 });
  m.target.selector = ".row";
  m.target.rect = { x: 10, y: 20, width: 160, height: 28 };
  m.target.styles.display = "flex";
  m.target.styles.justifyContent = "center";
  const icon = m.icons[0]!;
  icon.selector = ".row > svg";
  icon.rect.x = 151;
  m.iconContexts = {
    [icon.selector]: {
      container: m.target,
      contentGroup: { x: 15, y: 27, width: 150, height: 14 },
    },
  };
  expect(iconAlignment(m)).toEqual([]);
  m.iconContexts[icon.selector]!.contentGroup!.x += 1;
  expect(iconAlignment(m)).toHaveLength(1);
});

it("uses the cross-axis for stacked icons and the reserved slot for positioned adornments", () => {
  const m = measurement();
  m.target.styles.flexDirection = "column";
  m.target.rect.height = 100;
  expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
  m.target.styles.flexDirection = "row";
  m.target.rect.height = 28;
  m.target.rect.width = 200;
  m.icons[0]!.styles.position = "absolute";
  expect(iconAlignment(m, { crop: imageFor(m) })).toEqual([]);
  m.icons[0]!.rect.y += 1;
  expect(iconAlignment(m, { crop: imageFor(m) }).some((f) => f.message.startsWith("Layout"))).toBe(
    true,
  );
});

it("centers the full cap-band extent of a wrapped label", () => {
  const m = labeled();
  m.scale = 1;
  const first = m.texts[0]!;
  first.selector = ".label::text(0)[0:2]";
  first.baseline = 29;
  m.texts.push({ ...first, selector: ".label::text(0)[3:5]", baseline: 47 });
  m.iconContexts = {
    [m.icons[0]!.selector]: { container: m.target, labelSelector: first.selector },
  };
  expect(iconAlignment(m)).toEqual([]);
  expect(labelCapCenter(first, m.texts, "flex-start")).toBe(25);
  expect(labelCapCenter(first, m.texts, "flex-end")).toBe(43);
  m.texts[1]!.baseline += 2;
  expect(iconAlignment(m)).toHaveLength(1);
});
