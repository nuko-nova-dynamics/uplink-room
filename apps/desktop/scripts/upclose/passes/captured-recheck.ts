// Reapply pure rules to saved measurements without opening a gym window.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findingId, runPaths, type Finding } from "../types.ts";
import { save } from "./common.ts";
import { clipped } from "./rules.ts";
import { recheckCursor } from "./cursor-recheck.ts";
import { recheckMotion } from "./motion-recheck.ts";
const run = resolve(process.argv[2]!);
const paths = runPaths(run);
const overflow: Finding[] = JSON.parse(await readFile(paths.findings("overflow"), "utf8"));
const kept: Finding[] = [], removed: string[] = [];
for (const row of overflow) {
  if (row.message === "clipped-without-ellipsis" && row.artifact) {
    const data = JSON.parse(await readFile(resolve(run, row.artifact.replace(/\.png$/, ".json")), "utf8"));
    const element = data.elements.find((e: { selector: string }) => e.selector === row.selector);
    if (element && !clipped({ ...element, height: element.rect.height })) {
      removed.push(row.id);
      continue;
    }
  }
  kept.push(row);
}
await save(paths.findings("overflow"), kept);
const detector: Finding[] = JSON.parse(await readFile(paths.findings("detector"), "utf8"));
for (const row of detector) {
  const measured = row.measured as { rule: string; value?: { antipattern?: string } };
  if (measured.value?.antipattern) {
    row.message = measured.rule = measured.value.antipattern;
    row.id = findingId(row);
  }
}
await save(paths.findings("detector"), detector);
await recheckMotion(run);
await recheckCursor(run);
await save(resolve(run, "captured-recheck.json"), {
  hiddenLabelFindingsRemoved: removed,
  reason: "A 1 by 1 pixel hidden box is the renderer's screen-reader-only label pattern.",
  detectorRulesNamed: detector.length,
});
