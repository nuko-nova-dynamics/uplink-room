import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import type { Finding } from "../types.ts";
import { recheckCursor } from "./cursor-recheck.ts";
import { writeReport } from "../report.ts";
import { save } from "./common.ts";
const root = resolve(process.argv[2]!);
const findings: Record<string, Finding[]> = {};
const summaries = [];
for (const shard of await readdir(join(root, ".shards"), { withFileTypes: true })) {
  if (!shard.isDirectory()) continue;
  const dir = join(root, ".shards", shard.name);
  try {
    summaries.push(JSON.parse(await readFile(join(dir, "passes.json"), "utf8")));
  } catch {
    summaries.push({ shard: shard.name, error: "Missing completion summary" });
  }
  for (const pass of ["mouse", "keyboard", "motion", "overflow", "detector"]) {
    try {
      const rows: Finding[] = JSON.parse(
        await readFile(join(dir, "findings", pass + ".json"), "utf8"),
      );
      (findings[pass] ??= []).push(...rows);
    } catch {
      findings[pass] ??= [];
    }
  }
  async function move(dir: string, rel = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!rel && ["passes.json", "findings"].includes(entry.name)) continue;
      const next = join(rel, entry.name),
        source = join(dir, entry.name),
        dest = join(root, next);
      if (entry.isDirectory()) await move(source, next);
      else {
        await mkdir(dirname(dest), { recursive: true });
        await rename(source, dest);
      }
    }
  }
  await move(dir);
}
for (const [pass, rows] of Object.entries(findings))
  await save(join(root, "findings", pass + ".json"), rows);
if (findings["mouse"]?.length) findings["mouse"] = await recheckCursor(root);
const counts: Record<string, number> = {};
const byPass: Record<string, Record<string, number>> = {};
for (const [pass, rows] of Object.entries(findings))
  for (const f of rows) {
    const rule = (f.measured as { rule?: string })?.rule || f.message;
    counts[rule] = (counts[rule] || 0) + 1;
    (byPass[pass] ??= {})[rule] = ((byPass[pass] || {})[rule] || 0) + 1;
  }
await save(join(root, "passes-summary.json"), { summaries, counts, byPass });
const lines = [
  "# Interaction pass results",
  "",
  ...Object.entries(findings).map(([p, rows]) => `${p}: ${rows.length} findings`),
  "",
  "## Ten most common findings",
  "",
  ...Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, n]) => `- ${rule}: ${n}`),
  "",
  "## Counts by check",
  "",
  JSON.stringify(byPass, null, 2),
  "",
  "## Run times and coverage",
  "",
  JSON.stringify(summaries, null, 2),
];
await writeFile(join(root, "passes-report.md"), lines.join("\n") + "\n");

await writeReport(root);
