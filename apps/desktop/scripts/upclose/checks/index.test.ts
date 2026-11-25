import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { encode } from "../image.ts";
import { imageFor, measurement, text } from "../fixtures.ts";
import { runPaths } from "../types.ts";
import { checkMeasurement, runChecks } from "./index.ts";

const folders: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});
async function setup() {
  const run = await mkdtemp(join(tmpdir(), "upclose-checks-"));
  folders.push(run);
  const m = measurement(),
    paths = runPaths(run);
  await mkdir(join(run, "captures/button/default/dark"), { recursive: true });
  await writeFile(join(run, m.files.crop), encode(imageFor(m)));
  const file = paths.capture(m.component, m.state, m.theme, "measure-2x.json");
  await writeFile(file, JSON.stringify(m));
  return { run, m, file };
}
it("accepts the known-good fixture in all checks and emits stable findings with units", async () => {
  const { run, m, file } = await setup();
  expect(checkMeasurement(m, { crop: imageFor(m) })).toEqual([]);
  expect(await runChecks(run)).toEqual([]);
  m.target.styles.borderTopLeftRadius = "9px";
  await writeFile(file, JSON.stringify(m));
  const findings = await runChecks(run);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    selector: ".btn.icon",
    state: "default",
    theme: "dark",
    scale: 2,
    artifact: m.files.crop,
    measured: { borderTopLeftRadius: "9px" },
    expected: { borderTopLeftRadius: "7px" },
  });
  const first = await readFile(runPaths(run).findings("measure"), "utf8");
  await runChecks(run);
  expect(await readFile(runPaths(run).findings("measure"), "utf8")).toBe(first);
});
it("rejects empty runs, malformed measurements and missing raster evidence", async () => {
  const { run, file, m } = await setup();
  await writeFile(file, "{}");
  await expect(runChecks(run)).rejects.toThrow("Invalid Measurement");
  await writeFile(file, JSON.stringify({ ...m, files: { crop: "missing.png" } }));
  await expect(runChecks(run)).rejects.toThrow("ENOENT");
  await rm(file);
  await expect(runChecks(run)).rejects.toThrow("No captures");
});
it("CLI exits 0 for clean runs, 2 for open findings and 1 for errors", async () => {
  const { run, m, file } = await setup();
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const clean = await exec(process.execPath, [cli, run]);
  expect(clean.stdout).toContain("0 open findings");
  m.target.styles.borderTopLeftRadius = "9px";
  await writeFile(file, JSON.stringify(m));
  await expect(exec(process.execPath, [cli, run])).rejects.toMatchObject({ code: 2 });
  await expect(exec(process.execPath, [cli])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Usage:"),
  });
});
it("measures two thousand fixture inputs within seconds", () => {
  const m = measurement(),
    images = { crop: imageFor(m) },
    start = performance.now();
  for (let i = 0; i < 2000; i++) expect(checkMeasurement(m, images)).toEqual([]);
  expect(performance.now() - start).toBeLessThan(5000);
});

it("checks repeated text runs on one element once for each distinct value", () => {
  const m = measurement({
    icons: [],
    texts: [0, 1].map((line) => ({
      ...text(),
      selector: `.label::text(0)[${line}:${line + 1}]`,
      styles: { ...text().styles, fontSize: "14px" },
    })),
  });
  expect(checkMeasurement(m).filter((f) => f.check === "sizes")).toHaveLength(1);
  m.texts[1]!.styles.fontSize = "16px";
  expect(checkMeasurement(m).filter((f) => f.check === "sizes")).toHaveLength(2);
});

it("retains a paired label owned by a nested component when measuring its row icon", () => {
  const m = measurement({ scale: 1 });
  m.target.selector = ".row";
  m.target.rect.width = 80;
  const icon = m.icons[0]!;
  icon.selector = ".row > svg";
  icon.rect.x = 27;
  const label = text(".row > span::text(0)[0:2]");
  m.texts = [label];
  m.owners = { ".row > span": { component: "nested-label", root: ".row > span" } };
  m.iconContexts = { [icon.selector]: { container: m.target, labelSelector: label.selector } };
  expect(checkMeasurement(m).filter((f) => f.check === "icon-alignment")).toEqual([]);
});
