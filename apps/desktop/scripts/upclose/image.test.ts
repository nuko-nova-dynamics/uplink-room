import { describe, expect, it } from "vitest";
import { encode as encodeRaw } from "fast-png";
import { decode, encode, GRID_COLOR, inkBounds, overlay, OVERLAY_COLORS, zoom } from "./image.ts";
import { background, imageFor, measurement, paint, raster } from "./fixtures.ts";

const pixel = (r: ReturnType<typeof raster>, x: number, y: number) => [
  ...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4),
];
describe("PNG tools", () => {
  it("roundtrips RGBA, RGB, grayscale and transparent palette PNGs", () => {
    const r = raster(2, 2);
    paint(r, 1, 0, 1, 1, { r: 120, g: 80, b: 30, a: 0.5 });
    expect(decode(encode(r))).toEqual(r);
    expect(
      pixel(
        decode(encodeRaw({ width: 1, height: 1, channels: 3, data: new Uint8Array([10, 20, 30]) })),
        0,
        0,
      ),
    ).toEqual([10, 20, 30, 255]);
    expect(
      pixel(
        decode(encodeRaw({ width: 1, height: 1, channels: 1, data: new Uint8Array([40]) })),
        0,
        0,
      ),
    ).toEqual([40, 40, 40, 255]);
    expect(
      pixel(
        decode(
          encodeRaw({
            width: 1,
            height: 1,
            channels: 1,
            depth: 8,
            data: new Uint8Array([0]),
            palette: [[10, 20, 30, 0]],
          }),
        ),
        0,
        0,
      ),
    ).toEqual([10, 20, 30, 0]);
  });
  it.each([4, 8] as const)("zooms at %ix with unchanged blocks and one-pixel grid", (factor) => {
    const r = raster(2, 1);
    paint(r, 1, 0, 1, 1);
    const out = decode(zoom(r, factor));
    expect([out.width, out.height]).toEqual([factor * 2 + 1, factor]);
    expect(pixel(out, factor - 1, 0)).toEqual(pixel(r, 0, 0));
    expect(pixel(out, factor, 0)).toEqual([...GRID_COLOR]);
    expect(pixel(out, factor + 1, 0)).toEqual(pixel(r, 1, 0));
  });
  it("rejects unsupported zoom factors", () => {
    expect(() => zoom(raster(), 3 as 4)).toThrow("4 or 8");
  });
  it("finds clipped ink bounds and an alpha-weighted subpixel center", () => {
    const r = raster(4, 2, { r: 0, g: 0, b: 0, a: 0 });
    paint(r, 1, 0, 1, 1, { r: 255, g: 255, b: 255, a: 1 });
    paint(r, 2, 0, 1, 1, { r: 255, g: 255, b: 255, a: 0.5 });
    const ink = inkBounds(r, { x: -1, y: -1, width: 9, height: 9 }, { r: 0, g: 0, b: 0, a: 1 })!;
    expect(ink).toMatchObject({ x: 1, y: 0, width: 2, height: 1 });
    expect(ink.center.x).toBeCloseTo(1.8342, 3);
    expect(ink.center.y).toBe(0.5);
  });
  it("ignores background, low deltas and fully transparent pixels", () => {
    const r = raster(3, 1);
    paint(r, 1, 0, 1, 1, { ...background, r: background.r + 8 });
    paint(r, 2, 0, 1, 1, { r: 255, g: 255, b: 255, a: 0 });
    expect(inkBounds(r, { x: 0, y: 0, width: 3, height: 1 }, background)).toBeNull();
  });
  it("draws all overlay colors and a legend without mutating the source", () => {
    const m = measurement(),
      r = imageFor(m),
      original = r.data.slice();
    m.target.styles.paddingLeft = "2px";
    m.target.styles.paddingRight = "2px";
    m.target.styles.marginLeft = "1px";
    m.target.styles.marginRight = "1px";
    const out = decode(overlay(r, m));
    expect(out.height).toBe(r.height + 30);
    expect(r.data).toEqual(original);
    for (const color of Object.values(OVERLAY_COLORS)) {
      let found = false;
      for (let i = 0; i < out.data.length; i += 4)
        if (color.every((v, c) => out.data[i + c] === v)) found = true;
      expect(found).toBe(true);
    }
    expect(
      pixel(out, (m.icons[0]!.rect.x - m.crop.x) * 2, (m.icons[0]!.rect.y - m.crop.y) * 2),
    ).toEqual([...OVERLAY_COLORS.icon]);
  });
});

it("measures the icon color without counting a filled control background", () => {
  const background = { r: 20, g: 20, b: 20, a: 1 };
  const foreground = { r: 240, g: 240, b: 240, a: 1 };
  const r = raster(20, 20, { r: 50, g: 100, b: 200, a: 1 });
  paint(r, 5, 6, 8, 7, foreground);
  const rect = { x: 0, y: 0, width: 20, height: 20 };
  expect(inkBounds(r, rect, background, foreground)).toMatchObject({
    x: 5,
    y: 6,
    width: 8,
    height: 7,
  });
  expect(inkBounds(r, rect, background)).toMatchObject({ width: 20, height: 20 });
});
