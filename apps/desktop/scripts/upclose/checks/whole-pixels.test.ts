import { expect, it } from "vitest";
import { element, measurement, paint, raster, text } from "../fixtures.ts";
import { wholePixels } from "./whole-pixels.ts";

it("accepts integer icon and border geometry at 1x", () => {
  expect(wholePixels(measurement({ scale: 1 }))).toEqual([]);
});
it("reports fractional origins of icons and edges, only at 1x", () => {
  const m = measurement({ scale: 1 });
  m.icons[0]!.rect.x += 0.02;
  m.target.rect.y += 0.5;
  expect(wholePixels(m)).toHaveLength(2);
  m.scale = 2;
  expect(wholePixels(m)).toEqual([]);
});
it("checks standalone hairline endpoints but ignores text origins", () => {
  const m = measurement({ scale: 1, icons: [] });
  const line = element(".divider", {
    tag: "div",
    rect: { x: 0, y: 0, width: 15.5, height: 1 },
    styles: {},
  });
  m.extraElements = [line];
  m.elementKinds = { ".divider": "hairline" };
  expect(wholePixels(m)).toHaveLength(1);
  line.rect.width = 15.009;
  expect(wholePixels(m)).toEqual([]);
});

it("checks a painted parent once when capture splits its text into Range runs", () => {
  const m = measurement({ scale: 1, icons: [] });
  m.target.rect.x = 331.140625;
  m.texts = [0, 1].map((i) => ({
    ...text(),
    ...m.target,
    selector: `${m.target.selector}::text(0)[${i}:${i + 1}]`,
  }));
  expect(wholePixels(m)).toHaveLength(1);
  expect(wholePixels(m)[0]!.selector).toBe(m.target.selector);
});

it("uses layout origins for a rotating icon's pixel alignment", () => {
  const m = measurement({ scale: 1 });
  const icon = m.icons[0]!;
  const layout = { ...icon.rect };
  icon.rect = { x: 14.1, y: 24.1, width: 19.8, height: 19.8 };
  m.layoutRects = { [icon.selector]: layout };
  expect(wholePixels(m)).toEqual([]);
  m.layoutRects[icon.selector]!.x += 0.2;
  expect(wholePixels(m)).toHaveLength(1);
});

it("ignores transparent borders and plain painted boxes but checks outlines and focus", () => {
  const m = measurement({ scale: 1, icons: [] });
  m.target.rect.x += 0.25;
  for (const key of [
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
  ] as const)
    m.target.styles[key] = "rgba(0, 0, 0, 0)";
  m.target.styles.backgroundColor = "#ffffff";
  expect(wholePixels(m)).toEqual([]);
  Object.assign(m.target.styles, {
    outlineStyle: "solid",
    outlineWidth: "1px",
    outlineColor: "#ffffff",
  });
  expect(wholePixels(m)).toHaveLength(1);
  m.target.rect.x = 10;
  m.target.styles.outlineOffset = "0.5px";
  expect(wholePixels(m)).toHaveLength(1);
  m.target.styles.outlineStyle = "none";
  m.target.rect.x += 0.25;
  m.focus = {
    element: m.target,
    ringColor: { r: 255, g: 255, b: 255, a: 1 },
    ringWidth: 2,
    adjacent: m.target.background,
  };
  expect(wholePixels(m)).toHaveLength(1);
});

it("passes a box whose fractional edge painted crisp in the 1x crop, and flags a blended one", () => {
  const m = measurement({ scale: 1, icons: [] });
  m.crop = { x: 0, y: 0, width: 168, height: 64, margin: 0 };
  m.target.rect = { x: 10.4, y: 10, width: 40, height: 28 };
  m.target.background = { r: 29, g: 31, b: 35, a: 1 };
  m.target.styles = { ...m.target.styles, borderLeftWidth: "1px", borderLeftColor: "rgb(43, 46, 51)", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px" };
  const crisp = raster(168, 64, { r: 29, g: 31, b: 35, a: 1 });
  paint(crisp, 10, 10, 1, 28, { r: 43, g: 46, b: 51, a: 1 });
  expect(wholePixels(m, { crop: crisp }).map((f) => Object.keys(f.measured as object))).toEqual([]);
  const blurred = raster(168, 64, { r: 29, g: 31, b: 35, a: 1 });
  paint(blurred, 10, 10, 1, 28, { r: 36, g: 38, b: 43, a: 1 });
  paint(blurred, 11, 10, 1, 28, { r: 36, g: 38, b: 43, a: 1 });
  expect(wholePixels(m, { crop: blurred })).toHaveLength(1);
  expect(wholePixels(m)).toHaveLength(1);
});
