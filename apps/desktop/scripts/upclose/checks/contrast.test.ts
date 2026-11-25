import { expect, it } from "vitest";
import { element, labeled, measurement } from "../fixtures.ts";
import { contrast } from "./contrast.ts";

it.each(["default", "hover", "pressed", "selected", "disabled"])(
  "checks readable text in %s",
  (state) => {
    const m = labeled();
    m.state = state;
    expect(contrast(m)).toEqual([]);
    m.texts[0]!.styles.color = "#151619";
    expect(contrast(m)).toHaveLength(1);
  },
);
it("uses large-text thresholds and keeps disabled labels at 4.5:1", () => {
  const m = labeled(),
    t = m.texts[0]!;
  t.background = { r: 255, g: 255, b: 255, a: 1 };
  t.styles.color = "#888888";
  expect(contrast(m)).toHaveLength(1);
  t.styles.fontSize = "24px";
  expect(contrast(m)).toEqual([]);
  t.styles.fontSize = "18.66px";
  t.styles.fontWeight = "700";
  expect(contrast(m)).toEqual([]);
  t.styles.fontSize = "13px";
  m.textContexts = { [t.selector]: { kind: "interface", disabled: true } };
  expect(contrast(m)).toHaveLength(1);
  t.styles.color = "#5b6069";
  expect(contrast(m)).toEqual([]);
  t.styles.color = "#cccccc";
  expect(contrast(m)).toHaveLength(1);
});
it("composites foreground alpha and ancestor opacity, ignoring hidden text", () => {
  const m = labeled(),
    t = m.texts[0]!;
  t.styles.color = "rgb(235 236 238 / 20%)";
  expect(contrast(m)).toHaveLength(1);
  t.styles.color = "color(srgb 0.92 0.92 0.92)";
  m.textContexts = { [t.selector]: { kind: "interface", effectiveOpacity: 0.1 } };
  expect(contrast(m)).toHaveLength(1);
  m.textContexts[t.selector]!.effectiveOpacity = 0;
  expect(contrast(m)).toEqual([]);
});
it("fades a translucent control's fill along with its label, as the browser paints it", () => {
  const m = labeled(),
    t = m.texts[0]!,
    fill = { r: 0x8b, g: 0x6f, b: 0xe0, a: 1 },
    white = { r: 255, g: 255, b: 255, a: 1 };
  // A disabled filled button at 50% opacity on a white panel: fading only the label against the
  // unfaded fill reads 2.09:1, while the painted pair (white on the fill
  // half-mixed with white) is 1.84:1.
  t.styles.color = "#ffffff";
  t.background = fill;
  m.textContexts = {
    [t.selector]: {
      kind: "interface",
      disabled: true,
      effectiveOpacity: 0.5,
      layers: [
        { background: fill, opacity: 0.5 },
        { background: white, opacity: 1 },
      ],
    },
  };
  const found = contrast(m);
  expect(found).toHaveLength(1);
  expect(found[0]!.measured).toEqual({ ratio: "1.8421:1" });
  delete m.textContexts[t.selector]!.layers;
  expect(contrast(m)).toHaveLength(1);
});
it("accepts primary-text focus rings in both themes with alpha", () => {
  for (const theme of ["dark", "light"] as const) {
    const m = measurement({ theme, state: "focus-visible" });
    m.tokens["--text"] = theme === "dark" ? "#ebecee" : "#15171a";
    m.focus = {
      element: element(".focus"),
      ringWidth: 2,
      ringColor:
        theme === "dark" ? { r: 235, g: 236, b: 238, a: 0.72 } : { r: 21, g: 23, b: 26, a: 0.72 },
      adjacent: theme === "dark" ? { r: 21, g: 22, b: 25, a: 1 } : { r: 247, g: 248, b: 250, a: 1 },
    };
    expect(contrast(m)).toEqual([]);
  }
});
it("reports missing rings, low ring contrast and accent rings", () => {
  const m = measurement({ state: "focus-visible" });
  expect(contrast(m)).toHaveLength(1);
  m.focus = {
    element: element(".focus"),
    ringWidth: 2,
    ringColor: { r: 169, g: 139, b: 245, a: 1 },
    adjacent: { r: 21, g: 22, b: 25, a: 1 },
  };
  expect(contrast(m)[0]!.message).toContain("primary text");
  m.focus.ringColor = { r: 235, g: 236, b: 238, a: 0.1 };
  expect(contrast(m)[0]!.message).toContain("contrast");
});

it("reads the ring from the target's outline when a view marks focus without DOM focus", () => {
  const m = measurement({ state: "focus-visible" });
  m.tokens["--text"] = "#ebecee";
  m.focus = null;
  m.target.background = { r: 21, g: 22, b: 25, a: 1 };
  m.target.styles.outlineStyle = "solid";
  m.target.styles.outlineWidth = "2px";
  m.target.styles.outlineColor = "rgba(235, 236, 238, 0.72)";
  expect(contrast(m)).toEqual([]);
  m.target.styles.outlineStyle = "none";
  expect(contrast(m)).toHaveLength(1);
});
