import { expect, it } from "vitest";
import { measurement, text } from "./fixtures.ts";
import { checkMeasurement } from "./checks/index.ts";
import { scopeRule } from "./scope.ts";

it("excludes library internals while retaining surrounding application controls", () => {
  const m = measurement({ icons: [] });
  m.texts = [
    {
      ...text(),
      selector: ".canvas-viewer > div.excalidraw > span::text(0)[0:2]",
      styles: { fontSize: "1px", fontFamily: "Arial" },
    },
  ];
  expect(checkMeasurement(m).filter((f) => f.selector.includes("excalidraw"))).toEqual([]);
  expect(scopeRule(m, ".canvas-viewer > button.btn", "sizes")).toBeUndefined();
  expect(scopeRule(m, ".terminal > div.xterm > span", "contrast")?.id).toBe("third-party-dom");
  m.scopeMatches = { "#library-child": ["third-party-dom"] };
  expect(scopeRule(m, "#library-child::text(0)[0:2]", "sizes")?.id).toBe("third-party-dom");
});

it("excludes drawings from icon checks only and retains their text checks", () => {
  const m = measurement();
  m.icons[0]!.selector = ".wordmark > svg";
  m.icons[0]!.rect.width = 77;
  m.texts = [
    {
      ...text(),
      selector: ".wordmark > span::text(0)[0:2]",
      styles: { ...text().styles, fontSize: "22px" },
    },
  ];
  const findings = checkMeasurement(m);
  expect(findings.some((f) => f.selector === ".wordmark > svg")).toBe(false);
  expect(
    findings.some((f) => f.selector.startsWith(".wordmark > span") && f.check === "sizes"),
  ).toBe(true);
});

it("excludes running rotation ink but checks a rotation paused at zero", () => {
  const m = measurement();
  const selector = m.icons[0]!.selector;
  m.rotations = { [selector]: "running" };
  expect(scopeRule(m, selector, "icon-alignment")?.id).toBe("running-rotation");
  expect(scopeRule(m, selector, "sizes")).toBeUndefined();
  m.rotations[selector] = "paused-at-zero";
  expect(scopeRule(m, selector, "icon-alignment")).toBeUndefined();
});
