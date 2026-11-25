import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildReport, markdown, readWaivers, writeReport } from "./report.ts";
import { finding } from "./checks/shared.ts";
import { measurement } from "./fixtures.ts";
import { findingId, waived } from "./types.ts";
import type { Waiver } from "./types.ts";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});
async function folder() {
  const f = await mkdtemp(join(tmpdir(), "upclose-report-"));
  folders.push(f);
  return f;
}
const sample = () => finding(measurement(), "sizes", ".btn.icon", "29px", "28px", "Wrong height.");

it("uses the shared finding ID and matches every optional waiver field", () => {
  const f = sample();
  expect(f.id).toBe(findingId(f));
  const w: Waiver = { check: "sizes", component: f.component, reason: "Intended exception." };
  expect(waived(f, [w])).toBe(w);
  for (const patch of [
    { check: "motion" },
    { component: "other" },
    { state: "hover" },
    { theme: "light" },
    { selector: ".other" },
  ] as Partial<Waiver>[])
    expect(waived(f, [{ ...w, ...patch }])).toBeUndefined();
  expect(waived({ ...f, scale: 1 }, [w])).toBe(w);
});
it("rejects empty reasons and malformed waiver files", async () => {
  const file = join(await folder(), "waivers.json");
  for (const value of [
    {},
    [{ check: "sizes", component: "button", reason: "  " }],
    [{ check: "unknown", component: "button", reason: "Reason" }],
  ]) {
    await writeFile(file, JSON.stringify(value));
    await expect(readWaivers(file)).rejects.toThrow();
  }
  await writeFile(file, "[]");
  expect(await readWaivers(file)).toEqual([]);
  expect(() =>
    buildReport([sample()], [{ check: "sizes", component: "button", reason: " " }]),
  ).toThrow("non-empty");
});
it("sorts findings deterministically and counts waived and open findings", () => {
  const a = sample(),
    b = { ...sample(), check: "contrast" as const, selector: ".text", message: "Text contrast." };
  const w: Waiver = { check: "sizes", component: "button", reason: "Intended exception." };
  const report = buildReport([a, b], [w], ["empty"]);
  expect(report).toEqual(buildReport([b, a], [w], ["empty"]));
  expect(report.counts).toMatchObject({
    total: 2,
    open: 1,
    waived: 1,
    byCheck: { sizes: { total: 1, waived: 1 }, contrast: { total: 1, open: 1 } },
    byComponent: { empty: { total: 0 }, button: { total: 2 } },
  });
  expect(report.waived[0]!.reason).toBe(w.reason);
  expect(markdown(report)).toContain("## Open findings");
  expect(markdown(report)).toContain("Reason: Intended exception.");
});
it("reads every pass and writes deterministic JSON and Markdown", async () => {
  const run = await folder();
  await mkdir(join(run, "findings"));
  await mkdir(join(run, "captures/empty/default/dark"), { recursive: true });
  await writeFile(
    join(run, "captures/empty/default/dark/measure-1x.json"),
    JSON.stringify({ component: "empty" }),
  );
  await writeFile(join(run, "findings/measure.json"), JSON.stringify([sample()]));
  await writeFile(
    join(run, "findings/mouse.json"),
    JSON.stringify([{ ...sample(), check: "mouse" }]),
  );
  const waivers = join(run, "waivers.json");
  await writeFile(
    waivers,
    JSON.stringify([{ check: "sizes", component: "button", reason: "Intentional." }]),
  );
  const report = await writeReport(run, waivers);
  expect(report.counts).toMatchObject({ total: 2, open: 1, waived: 1 });
  const first = await readFile(join(run, "report.json"), "utf8");
  await writeReport(run, waivers);
  expect(await readFile(join(run, "report.json"), "utf8")).toBe(first);
  expect(await readFile(join(run, "report.md"), "utf8")).toContain(
    "captures/button/default/dark/2x.png",
  );
  await writeFile(join(run, "findings/bad.json"), "{}");
  await expect(writeReport(run, waivers)).rejects.toThrow("array");
});

it("groups repeated states and scales by normalized selector and exact values", () => {
  const base = {
    ...sample(),
    selector: "#root > div:nth-child(1) > #\\:r12\\: > .btn:nth-child(2)::text(0)[0:3]",
  };
  const repeated = {
    ...base,
    selector: "#root > div.open:nth-child(4) > #\\:r32\\: > .btn.selected:nth-child(3)::text(2)[0:8]",
    state: "hover",
    theme: "light" as const,
    scale: 1 as const,
  };
  const different = { ...base, measured: "30px" };
  const report = buildReport([base, repeated, different], []);
  expect(report.groups.open.map((g) => g.instanceCount)).toEqual([2, 1]);
  expect(report.groups.open[0]).toMatchObject({
    states: ["default", "hover"],
    themes: ["dark", "light"],
    scales: [1, 2],
  });
  expect(report.groups.open[0]!.selector).not.toMatch(/nth-child|r12|r32/);
  expect(report.summary).toMatchObject({
    groups: { open: 2 },
    instances: { open: 3 },
    byCheck: { sizes: { groups: { open: 2 }, instances: { open: 3 } } },
  });
  expect(markdown(report)).toContain("2 instances");
});
