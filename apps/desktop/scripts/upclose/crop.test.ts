import { expect, it } from "vitest";
import { cropPng } from "./crop.ts";
import { decode, encode } from "./image.ts";
it("cuts exact device pixels at both scales without resampling", () => {
  const data = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => i % 251);
  const png = encode({ width: 8, height: 8, data });
  for (const scale of [1, 2] as const) {
    const result = decode(cropPng(png, { x: 1, y: 1, width: 2, height: 2 }, scale));
    expect([result.width, result.height]).toEqual([2 * scale, 2 * scale]);
    expect(result.data.slice(0, 4)).toEqual(
      data.slice((scale * 8 + scale) * 4, (scale * 8 + scale) * 4 + 4),
    );
  }
  expect(() => cropPng(png, { x: 0.1, y: 0, width: 2, height: 2 }, 1)).toThrow();
  expect(() => cropPng(png, { x: 7, y: 7, width: 2, height: 2 }, 1)).toThrow();
});
