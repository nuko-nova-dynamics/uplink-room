import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkCss } from "./css.mjs";
import { countFindings, compareBaseline } from "./baseline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = resolve(root, "scripts/ui-lint/baseline.json");
const fileName = (file) => relative(root, resolve(root, file)).replaceAll("\\", "/");
// The UI gym (src/renderer/gym) is a capture harness around the real components, and tests aren't
// rendered UI, so neither is checked. Oxlint resolves its config's ignorePatterns against the config's
// own folder, where they never match, so the runner applies them to both linters here.
const ignored = (file) => /(^|\/)apps\/desktop\/src\/renderer\/gym\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);
const cssFiles = [];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignored(fileName(path) + "/")) await scan(path);
    } else if (ignored(fileName(path))) continue;
    if (path.endsWith(".css")) cssFiles.push(path);
  }
}
await scan(resolve(root, "apps/desktop/src/renderer"));
const exceptions = JSON.parse(
  await readFile(resolve(root, "scripts/ui-lint/exceptions.json"), "utf8"),
);
const findings = [];
const sources = new Map(
  await Promise.all(cssFiles.sort().map(async (file) => [file, await readFile(file, "utf8")])),
);
// Scale lengths are fixed in styles.css; share them with imported component stylesheets.
const sharedWidths = Object.fromEntries(
  [
    ...sources
      .get(resolve(root, "apps/desktop/src/renderer/styles.css"))
      .matchAll(/(--[\w-]+)\s*:\s*([\d.]+)px\s*;/g),
  ].map((match) => [match[1], Number(match[2])]),
);
for (const [file, source] of sources)
  findings.push(...checkCss(source, fileName(file), exceptions, sharedWidths));
// Calling the package's JS entry avoids .cmd quoting and shell differences on Windows.
const oxlint = JSON.parse(
  await readFile(resolve(root, "node_modules/oxlint/package.json"), "utf8"),
);
const bin = typeof oxlint.bin === "string" ? oxlint.bin : oxlint.bin.oxlint;
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/oxlint", bin),
    "-c",
    "scripts/ui-lint/oxlint.json",
    "--format",
    "json",
    "apps/desktop/src/renderer",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (result.error) throw result.error;
let diagnostics;
try {
  diagnostics = JSON.parse(result.stdout).diagnostics;
} catch {
  throw new Error(`Oxlint failed: ${result.stderr || result.stdout}`);
}
if (result.status > 1 || result.signal)
  throw new Error(`Oxlint failed (${result.status}): ${result.stderr}`);
for (const d of diagnostics) {
  if (d.severity !== "error" || ignored(fileName(d.filename))) continue;
  findings.push({
    file: fileName(d.filename),
    rule: d.code.replace("(", "/").replace(")", ""),
    line: d.labels[0]?.span?.line ?? 1,
    message: d.message,
  });
}
const current = countFindings(findings);
if (process.argv.includes("--list")) {
  // Wait for the write: exiting first cuts piped output off at 64 KB.
  await new Promise((done) => process.stdout.write(JSON.stringify(findings, null, 2) + "\n", done));
  process.exit(0);
}
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const update = process.argv.includes("--update");
const errors = compareBaseline(current, baseline, update);
const neverBaseline = findings.filter((f) => ["css/syntax", "ui/icon-geometry"].includes(f.rule));
if (errors.length || neverBaseline.length) {
  for (const hit of findings)
    if (
      neverBaseline.includes(hit) ||
      (current[hit.file]?.[hit.rule] ?? 0) > (baseline[hit.file]?.[hit.rule] ?? 0)
    )
      console.error(`${hit.file}:${hit.line} ${hit.rule}: ${hit.message}`);
  errors.forEach((e) => console.error(e));
  process.exitCode = 1;
} else {
  if (update) await writeFile(baselinePath, JSON.stringify(current, null, 2) + "\n");
  console.log(
    `UI lint passed: ${cssFiles.length} CSS files, ${findings.length} existing findings${update ? " (baseline updated)" : ""}.`,
  );
}
