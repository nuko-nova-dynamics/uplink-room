import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runPaths } from "../types.ts";
import type { Finding, Measurement } from "../types.ts";
import { owns, ownershipIndex, withOwnership } from "../ownership.ts";
import { emptyScopeCounts, inScope, scopeRule } from "../scope.ts";
import { elements } from "./shared.ts";
import { withTextPurposes } from "../text-purpose.ts";
import { elementSelector, stableValue } from "../identity.ts";
import { walk } from "../files.ts";
import { decode } from "../image.ts";
import { iconAlignment } from "./icon-alignment.ts";
import { sizes } from "./sizes.ts";
import { wholePixels } from "./whole-pixels.ts";
import { evenSpacing } from "./even-spacing.ts";
import { iconDrawing, compareOpticalSamples, opticalSamples } from "./icon-drawing.ts";
import { contrast } from "./contrast.ts";
import { clickableArea } from "./clickable-area.ts";
import type { OpticalSample } from "./icon-drawing.ts";
import { sortFindings } from "./shared.ts";
import type { Images } from "./shared.ts";

export function checkMeasurement(m: Measurement, images: Images = {}): Finding[] {
  m = withTextPurposes(m);
  const checks = [
    ["icon-alignment", (value: Measurement) => iconAlignment(value, images)],
    ["sizes", sizes],
    ["whole-pixels", (value: Measurement) => wholePixels(value, images)],
    ["even-spacing", evenSpacing],
    ["icon-drawing", iconDrawing],
    ["contrast", contrast],
    ["clickable-area", clickableArea],
  ] as const;
  const findings = checks.flatMap(([check, run]) => {
    const scoped = measurementForCheck(m, check);
    return run(scoped).filter((f) => owns(m, f.selector) && !scopeRule(m, f.selector, check));
  });
  // Wrapping a text node creates several Range measurements of one painted element.
  return sortFindings([
    ...new Map(
      findings.map((f) => [
        stableValue([f.check, elementSelector(f.selector), f.measured, f.expected]),
        f,
      ]),
    ).values(),
  ]);
}

function measurementForCheck(m: Measurement, check: Finding["check"]): Measurement {
  return {
    ...m,
    icons: m.icons.filter(
      (e) =>
        owns(m, e.selector) &&
        inScope(m, e, check) &&
        (check !== "sizes" || inScope(m, e, "icon-sizes")) &&
        (check !== "whole-pixels" || inScope(m, e, "icon-pixels")),
    ),
    texts: m.texts.filter(
      (e) => check === "icon-alignment" || (owns(m, e.selector) && inScope(m, e, check)),
    ),
    extraElements: m.extraElements?.filter((e) => owns(m, e.selector) && inScope(m, e, check)),
    rowPeers: m.rowPeers.filter((e) => inScope(m, e, check)),
    columnPeers: m.columnPeers.filter((e) => inScope(m, e, check)),
  };
}

function validateMeasurement(value: unknown, file: string): asserts value is Measurement {
  const m = value as Measurement;
  if (
    !m ||
    typeof m !== "object" ||
    !["component", "state", "gymState"].every(
      (key) => typeof (m as unknown as Record<string, unknown>)[key] === "string",
    ) ||
    !["dark", "light"].includes(m.theme) ||
    ![1, 2].includes(m.scale) ||
    !m.target?.rect ||
    !m.crop ||
    !m.tokens ||
    !m.files?.crop ||
    ![m.icons, m.texts, m.rowPeers, m.columnPeers, m.hits].every(Array.isArray)
  )
    throw new Error(`Invalid Measurement: ${file}`);
}

export async function runChecks(runFolder: string): Promise<Finding[]> {
  const files = (await walk(join(runFolder, "captures"))).filter((file) =>
    /^measure-.*\.json$/.test(basename(file)),
  );
  if (!files.length) throw new Error(`No captures/**/measure-*.json files in ${runFolder}`);
  const findings: Finding[] = [];
  const samples: OpticalSample[] = [];
  const measurements: Measurement[] = [];
  for (const file of files) {
    const m: unknown = JSON.parse(await readFile(file, "utf8"));
    validateMeasurement(m, file);
    measurements.push(m);
  }
  const inventory = JSON.parse(
    await readFile(new URL("../../../src/renderer/gym/inventory.json", import.meta.url), "utf8"),
  );
  const owners = ownershipIndex(measurements, inventory);
  const scope = emptyScopeCounts();
  for (const raw of measurements) {
    const m = withOwnership(raw, owners);
    for (const check of [
      "icon-alignment",
      "sizes",
      "whole-pixels",
      "even-spacing",
      "icon-drawing",
      "contrast",
      "clickable-area",
    ] as const) {
      if (check === "whole-pixels" && m.scale !== 1) continue;
      const candidates = check.startsWith("icon-")
        ? m.icons.filter((e) => owns(m, e.selector))
        : elements(m);
      for (const e of candidates) {
        const rule =
          scopeRule(m, e.selector, check) ??
          ((check === "sizes" || check === "whole-pixels") &&
          m.icons.some((i) => i.selector === e.selector)
            ? scopeRule(m, e.selector, check === "sizes" ? "icon-sizes" : "icon-pixels")
            : undefined);
        if (!rule) continue;
        const count = scope.rules.find((r) => r.id === rule.id)!;
        count.excluded++;
        count.byCheck[check] = (count.byCheck[check] ?? 0) + 1;
      }
    }
    const images: Images = {};
    const optical = measurementForCheck(m, "icon-drawing");
    if (
      m.scale === 2 &&
      (optical.icons.length || measurementForCheck(m, "icon-alignment").icons.length)
    ) {
      const imagePath = resolve(runFolder, m.files.crop),
        rel = relative(resolve(runFolder), imagePath);
      if (
        isAbsolute(m.files.crop) ||
        rel === ".." ||
        rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      )
        throw new Error(`Crop must be inside the run folder: ${m.files.crop}`);
      images.crop = decode(await readFile(imagePath));
    } else if (m.scale === 1 && wholePixels(measurementForCheck(m, "whole-pixels")).length) {
      // A painted box with a fractional edge is judged by its pixels (whole-pixels.ts), so load the 1x crop.
      const imagePath = resolve(runFolder, m.files.crop),
        rel = relative(resolve(runFolder), imagePath);
      if (
        isAbsolute(m.files.crop) ||
        rel === ".." ||
        rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      )
        throw new Error(`Crop must be inside the run folder: ${m.files.crop}`);
      images.crop = decode(await readFile(imagePath));
    }
    findings.push(...checkMeasurement(m, images));
    samples.push(...opticalSamples(optical, images));
  }
  findings.push(...compareOpticalSamples(samples));
  sortFindings(findings);
  const file = runPaths(runFolder).findings("measure");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(findings, null, 2) + "\n");
  await writeFile(join(runFolder, "scope-counts.json"), JSON.stringify(scope, null, 2) + "\n");
  return findings;
}
