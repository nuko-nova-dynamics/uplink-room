import { expect, it } from "vitest";
import { imageFor, measurement, paint, raster } from "../fixtures.ts";
import { iconDrawing, iconOpticalSizes, opticalSamples } from "./icon-drawing.ts";

it("accepts consistent strokes and bounds including half a stroke", () => {
  const m = measurement();
  expect(iconDrawing(m)).toEqual([]);
  m.icons[0]!.strokeWidths = [0, 1.5, 1.5];
  expect(iconDrawing(m)).toEqual([]);
});
it("rejects stroke variance and bounds that spill beyond the viewBox", () => {
  const m = measurement();
  m.icons[0]!.strokeWidths = [1.5, 2];
  m.icons[0]!.bbox!.x = 0.5;
  expect(iconDrawing(m)).toHaveLength(2);
});
it("reports invalid or changed viewBoxes and missing bounds", () => {
  const m = measurement();
  m.icons[0]!.viewBox = null;
  expect(iconDrawing(m)).toHaveLength(1);
  m.icons[0]!.viewBox = "0 0 20 20";
  m.icons[0]!.bbox = null;
  expect(iconDrawing(m)).toHaveLength(2);
});
it("accepts equal optical sizes across distinct family members", () => {
  const samples = ["a", "b", "c"].map((name) => {
    const m = measurement();
    m.icons[0]!.iconName = name;
    return { measurement: m, images: { crop: imageFor(m) } };
  });
  expect(iconOpticalSizes(samples)).toEqual([]);
});
it("flags optical outliers without weighting frequently captured states", () => {
  const samples = ["a", "b", "small"].map((name) => {
    const m = measurement();
    m.icons[0]!.iconName = name;
    const crop = name === "small" ? raster() : imageFor(m);
    if (name === "small") paint(crop, 27, 27, 10, 10);
    return { measurement: m, images: { crop } };
  });
  expect(
    iconOpticalSizes([...samples, ...Array.from({ length: 10 }, () => samples[2]!)]),
  ).toHaveLength(11);
  expect(iconOpticalSizes(samples.slice(0, 2))).toEqual([]);
});
it("excludes fill-only children whose computed stroke width is inherited or defaulted", () => {
  const m = measurement(),
    icon = m.icons[0]!;
  icon.strokeWidths = [1.5, 1];
  m.iconContexts = { [icon.selector]: { container: m.target, paintedStrokeWidths: [1.5] } };
  expect(iconDrawing(m)).toEqual([]);
  m.iconContexts[icon.selector]!.paintedStrokeWidths = [];
  expect(iconDrawing(m)).toEqual([]);
});

it("does not apply the Icon family contract to a character illustration", () => {
  const m = measurement();
  Object.assign(m.icons[0]!, {
    iconName: null,
    viewBox: "0 0 200 200",
    strokeWidths: [9, 4.5, 3.2],
    bbox: { x: -16, y: -26, width: 188.5, height: 204 },
  });
  expect(iconDrawing(m)).toEqual([]);
});

it("leaves compact glyphs out of the optical comparison while keeping stroke and bounds checks", () => {
  const samples = ["a", "b", "c", "chevron", "chevron-left", "chevron-down", "more", "leave"].map(
    (name) => {
      const m = measurement();
      m.icons[0]!.iconName = name;
      m.iconContexts = { [m.icons[0]!.selector]: { container: m.target, family: "Icon" } };
      const crop = imageFor(m);
      if (!["a", "b", "c"].includes(name)) {
        crop.data.set(raster().data);
        paint(crop, 27, 27, 10, 10);
      }
      return { measurement: m, images: { crop } };
    },
  );
  expect(iconOpticalSizes(samples)).toEqual([]);
  const compact = samples[3]!.measurement;
  compact.icons[0]!.strokeWidths = [2];
  compact.icons[0]!.bbox!.x = 0;
  expect(iconDrawing(compact)).toHaveLength(2);
  // Even a compact glyph far from the others' area isn't compared.
  paint(samples[3]!.images.crop, 22, 22, 20, 20);
  expect(iconOpticalSizes(samples)).toEqual([]);
});

it("normalizes a rotating icon with its unrotated layout box", () => {
  const m = measurement();
  const icon = m.icons[0]!;
  const crop = imageFor(m);
  const before = opticalSamples(m, { crop })[0]!.area;
  m.layoutRects = { [icon.selector]: { ...icon.rect } };
  icon.rect = { ...icon.rect, width: 20, height: 20 };
  expect(opticalSamples(m, { crop })[0]!.area).toBe(before);
});

it("keeps a border crossing the SVG box out of the working icon's optical area", () => {
  const m = measurement(),
    crop = imageFor(m);
  m.icons[0]!.iconName = "working";
  const before = opticalSamples(m, { crop })[0]!.area;
  // The A2A header border crosses the SVG box above the actual path.
  paint(crop, 18, 18, 28, 1);
  expect(opticalSamples(m, { crop })[0]!.area).toBe(before);
  m.crop.height = 15;
  expect(opticalSamples(m, { crop })).toEqual([]);
});
