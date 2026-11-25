import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPaths, waived } from "./types.ts";
import type { Finding, Waiver } from "./types.ts";
import { compareText, sortFindings } from "./checks/shared.ts";
import { walk } from "./files.ts";
import { normalizedSelector, stableValue } from "./identity.ts";
import { emptyScopeCounts } from "./scope.ts";
import type { ScopeCounts } from "./scope.ts";

export const WAIVER_FILE = fileURLToPath(
  new URL("../../src/renderer/gym/waivers.json", import.meta.url),
);
export const MEASUREMENT_CHECKS = [
  "icon-alignment",
  "sizes",
  "whole-pixels",
  "even-spacing",
  "icon-drawing",
  "contrast",
  "clickable-area",
] as const;
const ALL_CHECKS = new Set<string>([
  ...MEASUREMENT_CHECKS,
  "overflow",
  "motion",
  "keyboard",
  "mouse",
  "detector",
  "inventory",
]);
export const CAPTURE_FIELDS = {
  owners:
    "Map each element to the nearest inventory component and its root on the rendered gym scene.",
  scopeMatches:
    "Record named scope rules matched through DOM ancestry, including ancestors hidden by an element ID.",
  rotations: "Record whether an icon rotation was paused at time zero or was still running.",
  inputState:
    "Record actual hover, active and focus-visible state and the focused element selector.",
  layoutRects:
    "Map transformed element selectors to their layout boxes before their own transform.",
  iconContexts:
    "Map icon selectors to their actual container, optional labelSelector, optical family and paintedStrokeWidths excluding stroke:none children.",
  textContexts: "Map text selectors to purpose, disabled ancestry and effective ancestor opacity.",
  elementKinds: "Map selectors to button, icon-button, title-row, control or hairline roles.",
  extraElements: "Include nested controls and hairlines with rect, styles and background.",
  textRows:
    "List text selectors sharing each single visual row when automatic grouping is insufficient.",
};

type Counts = { total: number; open: number; waived: number };
export type FindingGroup = {
  check: Finding["check"];
  component: string;
  selector: string;
  measured: unknown;
  expected: unknown;
  message: string;
  instanceCount: number;
  elementCount: number;
  states: string[];
  gymStates: string[];
  themes: string[];
  scales: number[];
  example: Finding;
  reason?: string;
};
export type Report = {
  open: Finding[];
  waived: (Finding & { reason: string })[];
  counts: Counts & { byCheck: Record<string, Counts>; byComponent: Record<string, Counts> };
  captureFields: typeof CAPTURE_FIELDS;
  groups: { open: FindingGroup[]; waived: FindingGroup[] };
  summary: {
    groups: Counts;
    instances: Counts;
    byCheck: Record<string, { groups: Counts; instances: Counts }>;
    byComponent: Record<string, { groups: Counts; instances: Counts }>;
  };
  scope: ScopeCounts;
};
const emptyCounts = (): Counts => ({ total: 0, open: 0, waived: 0 });
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export async function readWaivers(file = WAIVER_FILE): Promise<Waiver[]> {
  const json: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(json)) throw new Error(`Waivers must be an array: ${file}`);
  for (const [i, item] of json.entries()) {
    if (!isObject(item) || typeof item.reason !== "string" || !item.reason.trim())
      throw new Error(`Waiver ${i} must have a non-empty reason: ${file}`);
    if (
      typeof item.component !== "string" ||
      !item.component.trim() ||
      !ALL_CHECKS.has(String(item.check)) ||
      (item.theme !== undefined && item.theme !== "dark" && item.theme !== "light") ||
      ["state", "selector"].some((key) => item[key] !== undefined && typeof item[key] !== "string")
    )
      throw new Error(`Invalid waiver ${i}: ${file}`);
  }
  return json as Waiver[];
}

export function validateFindings(json: unknown, file: string): asserts json is Finding[] {
  if (!Array.isArray(json)) throw new Error(`Findings must be an array: ${file}`);
  for (const [i, item] of json.entries()) {
    if (
      !isObject(item) ||
      !ALL_CHECKS.has(String(item.check)) ||
      ["id", "component", "state", "gymState", "selector", "message"].some(
        (key) => typeof item[key] !== "string",
      ) ||
      !["dark", "light"].includes(String(item.theme)) ||
      (item.scale !== undefined && item.scale !== 1 && item.scale !== 2) ||
      !("measured" in item) ||
      !("expected" in item)
    )
      throw new Error(`Invalid finding ${i}: ${file}`);
  }
}

export function buildReport(
  findings: Finding[],
  waivers: Waiver[],
  components: string[] = [],
  scope: ScopeCounts = emptyScopeCounts(),
): Report {
  if (waivers.some((w) => !w.reason.trim()))
    throw new Error("Every waiver must have a non-empty reason");
  const report: Report = {
    open: [],
    waived: [],
    counts: { ...emptyCounts(), byCheck: {}, byComponent: {} },
    captureFields: CAPTURE_FIELDS,
    groups: { open: [], waived: [] },
    summary: { groups: emptyCounts(), instances: emptyCounts(), byCheck: {}, byComponent: {} },
    scope,
  };
  for (const check of [...new Set([...MEASUREMENT_CHECKS, ...findings.map((f) => f.check)])].sort(
    compareText,
  ))
    report.counts.byCheck[check] = emptyCounts();
  for (const component of [...new Set([...components, ...findings.map((f) => f.component)])].sort(
    compareText,
  ))
    report.counts.byComponent[component] = emptyCounts();
  for (const f of sortFindings([...findings])) {
    const waiver = waived(f, waivers),
      category = waiver ? "waived" : "open";
    if (waiver) report.waived.push({ ...f, reason: waiver.reason.trim() });
    else report.open.push(f);
    for (const counts of [
      report.counts,
      report.counts.byCheck[f.check]!,
      report.counts.byComponent[f.component]!,
    ]) {
      counts.total++;
      counts[category]++;
    }
  }
  report.groups.open = groupFindings(report.open);
  report.groups.waived = groupFindings(report.waived);
  const countGroups = (filter: (g: FindingGroup) => boolean): Counts => {
    const open = report.groups.open.filter(filter).length,
      waived = report.groups.waived.filter(filter).length;
    return { total: open + waived, open, waived };
  };
  report.summary.groups = countGroups(() => true);
  report.summary.instances = {
    total: report.counts.total,
    open: report.counts.open,
    waived: report.counts.waived,
  };
  for (const [field, source] of [
    ["byCheck", report.counts.byCheck],
    ["byComponent", report.counts.byComponent],
  ] as const) {
    const rows = Object.entries(source).map(
      ([key, counts]) =>
        [
          key,
          {
            instances: counts,
            groups: countGroups((g) => (field === "byCheck" ? g.check : g.component) === key),
          },
        ] as const,
    );
    rows.sort(
      ([a, ac], [b, bc]) =>
        bc.groups.open - ac.groups.open ||
        bc.instances.open - ac.instances.open ||
        compareText(a, b),
    );
    report.summary[field] = Object.fromEntries(rows);
  }
  return report;
}

/** Ignore capture location and repeated source metadata, retaining the measured failure. */
export function groupedMeasurement(f: Finding): unknown {
  if (!["mouse", "keyboard", "motion", "overflow", "detector"].includes(f.check)) return f.measured;
  const keepPosition = ["outside-window", "layout-shift"].includes(f.message);
  const normalize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string")
      return ["selector", "other", "before", "after", "escapedTo"].includes(key) ||
        (key === "value" && /^(?:#|body >)/.test(value))
        ? normalizedSelector(value)
        : value;
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value);
    const rect = ["x", "y", "width", "height"].every((k) => k in value);
    return Object.fromEntries(
      entries
        .filter(
          ([k]) =>
            !["tokens", "file", "line", "description", "name", "percent"].includes(k) &&
            !(rect && !keepPosition && ["x", "y"].includes(k)),
        )
        .map(([k, v]) => [k, normalize(v, k)]),
    );
  };
  return normalize(f.measured);
}

function groupedExpected(f: Finding): unknown {
  return typeof f.expected === "string" && /^(?:#|body >)/.test(f.expected)
    ? normalizedSelector(f.expected)
    : f.expected;
}

export function groupFindings(findings: (Finding & { reason?: string })[]): FindingGroup[] {
  const groups = new Map<string, (Finding & { reason?: string })[]>();
  for (const f of sortFindings([...findings])) {
    const key = stableValue([
      f.check,
      f.component,
      normalizedSelector(f.selector),
      groupedMeasurement(f),
      groupedExpected(f),
    ]);
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }
  const unique = <T extends string | number>(values: T[]): T[] =>
    [...new Set(values)].sort((a, b) =>
      typeof a === "number" && typeof b === "number" ? a - b : compareText(String(a), String(b)),
    );
  return [...groups.values()]
    .map((instances) => {
      const example = instances[0]!;
      return {
        check: example.check,
        component: example.component,
        selector: normalizedSelector(example.selector),
        measured: groupedMeasurement(example),
        expected: groupedExpected(example),
        message: example.message,
        instanceCount: instances.length,
        elementCount: new Set(instances.map((f) => f.selector)).size,
        states: unique(instances.map((f) => f.state)),
        gymStates: unique(instances.map((f) => f.gymState)),
        themes: unique(instances.map((f) => f.theme)),
        scales: unique(instances.flatMap((f) => (f.scale === undefined ? [] : [f.scale]))),
        example,
        ...(example.reason ? { reason: example.reason } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.instanceCount - a.instanceCount ||
        compareText(
          stableValue([a.check, a.component, a.selector, a.measured, a.expected]),
          stableValue([b.check, b.component, b.selector, b.measured, b.expected]),
        ),
    );
}
const escape = (s: unknown) =>
  String(s)
    .replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, " ");
const display = (v: unknown) => escape(typeof v === "string" ? v : JSON.stringify(v));
export function markdown(report: Report): string {
  const lines = [
    "# Up-close measurement report",
    "",
    `${report.summary.groups.open} open root-cause groups across ${report.counts.open} instances; ${report.summary.groups.waived} waived groups across ${report.counts.waived} instances.`,
    "",
    "| Check | Open groups | Open instances | Waived groups | Waived instances |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [check, c] of Object.entries(report.summary.byCheck))
    lines.push(
      `| ${check} | ${c.groups.open} | ${c.instances.open} | ${c.groups.waived} | ${c.instances.waived} |`,
    );
  lines.push(
    "",
    "| Component | Open groups | Open instances | Waived groups | Waived instances |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const [component, c] of Object.entries(report.summary.byComponent))
    lines.push(
      `| ${escape(component)} | ${c.groups.open} | ${c.instances.open} | ${c.groups.waived} | ${c.instances.waived} |`,
    );
  lines.push(
    "",
    "## Scope exclusions",
    "",
    "Counts are element/check observations omitted before checking, after ownership. They are not waivers.",
    "",
  );
  for (const rule of report.scope.rules)
    lines.push(
      `- ${rule.id}: ${rule.excluded} excluded (${display(rule.byCheck)}). ${escape(rule.reason)}`,
    );
  for (const [title, findings] of [
    ["Open findings", report.groups.open],
    ["Waived findings", report.groups.waived],
  ] as const) {
    lines.push("", `## ${title}`, "");
    if (!findings.length) lines.push("None.");
    for (const f of findings) {
      lines.push(
        `- **${f.instanceCount} instances, ${f.check}, ${escape(f.component)}**: ${escape(f.message)} Selector: ${escape(f.selector)}. States: ${display(f.states)}; themes: ${display(f.themes)}; scales: ${display(f.scales)}. Measured: ${display(f.measured)}. Expected: ${display(f.expected)}.${f.example.artifact ? ` Crop: [${escape(f.example.artifact)}](<${encodeURI(f.example.artifact).replaceAll(">", "%3E").replaceAll("<", "%3C")}>)` : ""}${f.reason ? ` Reason: ${escape(f.reason)}` : ""}`,
      );
    }
  }
  lines.push(
    "",
    "## Capture fields",
    "",
    "These optional Measurement fields let capture identify intent and nested geometry.",
    "",
  );
  for (const [field, description] of Object.entries(CAPTURE_FIELDS))
    lines.push(`- ${field}: ${description}`);
  return lines.join("\n") + "\n";
}

export async function writeReport(runFolder: string, waiverFile = WAIVER_FILE): Promise<Report> {
  const folder = join(runFolder, "findings");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort(compareText);
  const findings: Finding[] = [];
  for (const name of names) {
    const file = join(folder, name),
      json: unknown = JSON.parse(await readFile(file, "utf8"));
    validateFindings(json, file);
    findings.push(...json);
  }
  const components: string[] = [];
  for (const file of await walk(join(runFolder, "captures")))
    if (/^measure-.*\.json$/.test(file.split(/[\\/]/).at(-1)!)) {
      const json: unknown = JSON.parse(await readFile(file, "utf8"));
      if (isObject(json) && typeof json.component === "string") components.push(json.component);
    }
  const scope = await readFile(join(runFolder, "scope-counts.json"), "utf8")
    .then((value) => JSON.parse(value) as ScopeCounts)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return emptyScopeCounts();
    });
  const report = buildReport(findings, await readWaivers(waiverFile), components, scope);
  const paths = runPaths(runFolder);
  await mkdir(dirname(paths.report("json")), { recursive: true });
  await writeFile(paths.report("json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(paths.report("md"), markdown(report));
  return report;
}
