import { expect, it } from "vitest";
import { color, contrastRatio, over } from "./color.ts";

it("parses resolved sRGB and hex colors", () => {
  expect(color("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  expect(color("rgba(255, 0, 0, 0.5)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  expect(color("color(srgb 1 0 0 / 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  expect(color("transparent").a).toBe(0);
  expect(() => color("oklch(0.5 0 0)")).toThrow();
});
it("composites alpha and computes WCAG luminance", () => {
  expect(over(color("#0008"), color("transparent"))).toEqual(color("#0008"));
  expect(over(color("transparent"), color("transparent"))).toEqual(color("transparent"));
  expect(contrastRatio(color("#000"), color("#fff"))).toBe(21);
});
