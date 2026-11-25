import { readFile, access } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { walk } from "../files.ts";
import { findingId, runPaths, type Finding, type Theme } from "../types.ts";
import { inventory, save } from "./common.ts";
import { nearestComponent, sceneComponents, cursorExpected } from "./rules.ts";
export async function recheckCursor(run: string) {
  const paths = runPaths(run),
    inv = await inventory();
  const rows: Finding[] = JSON.parse(await readFile(paths.findings("mouse"), "utf8"));
  const kept = rows.filter((r) => r.message !== "cursor-convention");
  const files = (await walk(resolve(run, "mouse"))).filter((f) => f.endsWith("controls.json"));
  const records = await Promise.all(
    files.map(async (file) => ({ file, data: JSON.parse(await readFile(file, "utf8")) })),
  );
  const counts: Record<string, number> = {};
  for (const { data } of records)
    for (const r of data.records) counts[r.cursor] = (counts[r.cursor] || 0) + 1;
  const convention = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const { file, data } of records) {
    const [state, theme] = relative(resolve(run, "mouse"), file).split(sep) as [string, Theme];
    const overflow = resolve(run, "overflow", state, "default", `${theme}.json`);
    const elements = await readFile(overflow, "utf8")
      .then((s) => JSON.parse(s).elements)
      .catch(() => []);
    for (const r of data.records) {
      const existing = rows.find(
        (f) => f.gymState === state && f.theme === theme && f.selector === r.selector,
      );
      const e = elements.find((e: { selector: string }) => e.selector === r.selector);
      const info = { ...e, ...r };
      // Legacy records lack semantic context; their saved overflow element supplies it.
      if (!info.role || cursorExpected(info).includes(r.cursor)) continue;
      let artifact = resolve(dirname(file), "cursor.png");
      if (
        !(await access(artifact).then(
          () => true,
          () => false,
        ))
      ) {
        artifact = resolve(run, "overflow", state, "default", `${theme}.png`);
        if (
          !(await access(artifact).then(
            () => true,
            () => false,
          ))
        )
          artifact = file;
      }
      const f = {
        check: "mouse" as const,
        component:
          e?.owner ||
          r.component ||
          existing?.component ||
          nearestComponent(e?.ancestry || [], sceneComponents(inv.components, state)),
        state,
        gymState: state,
        theme,
        selector: r.selector,
        measured: { rule: "cursor-convention", value: r.cursor },
        expected: cursorExpected(info),
        message: "cursor-convention",
        artifact: relative(run, artifact),
      };
      kept.push({ ...f, id: findingId(f) });
    }
    data.localConvention ??= data.convention;
    data.convention = convention;
    await save(file, data);
  }
  await save(paths.findings("mouse"), kept);
  await save(resolve(run, "cursor-convention.json"), { convention, counts });
  return kept;
}
