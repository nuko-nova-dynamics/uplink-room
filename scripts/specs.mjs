/**
 * Model-checks the TLA+ specs in specs/ with TLC (specs/README.md):
 *
 *   pnpm specs [Name ...]
 *
 * Each `<Spec><Variant>.cfg` names its spec by the longest `<Spec>.tla` its name starts with, and
 * says on its first line what TLC must find: `\* expect: ok`, or `\* expect: violation <Name>` for
 * a config that keeps a bug in the model on purpose, so the model is shown to catch it (`violation
 * temporal` for a PROPERTY, which TLC doesn't name). Fails when
 * any result differs. Needs Java 11 or later (`JAVA_HOME`, or `java` on PATH); TLC itself is
 * downloaded once, checked against its SHA-256, and kept in a cache folder.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specs = join(root, "specs");

async function tlcJar() {
  const cache = join(process.env["RUNNER_TOOL_CACHE"] ?? join(homedir(), ".cache"), "uplink-room", "tla");
  const jar = join(cache, `tla2tools-${TLC_VERSION}.jar`);
  if (existsSync(jar)) return jar;
  mkdirSync(cache, { recursive: true });
  const response = await fetch(TLC_URL);
  if (!response.ok) throw new Error(`Couldn't download TLC ${TLC_VERSION}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== TLC_SHA256) throw new Error(`TLC ${TLC_VERSION} downloaded with SHA-256 ${sum}, not ${TLC_SHA256}`);
  writeFileSync(`${jar}.part`, bytes);
  renameSync(`${jar}.part`, jar);
  return jar;
}

const java = process.env["JAVA_HOME"] ? join(process.env["JAVA_HOME"], "bin", "java") : "java";

/** What TLC found: "ok", "violation <Invariant>", "violation temporal", or its error. */
function result(output) {
  if (/Model checking completed\. No error has been found\./.test(output)) return "ok";
  const invariant = /Invariant (\w+) is violated/.exec(output);
  if (invariant) return `violation ${invariant[1]}`;
  // TLC doesn't say which temporal property failed; a config checks one PROPERTY at a time.
  if (/Temporal properties were violated/.test(output)) return "violation temporal";
  return `error: ${output.split("\n").filter((line) => /Error|error/.test(line)).slice(0, 3).join(" | ") || "no result"}`;
}

const only = process.argv.slice(2);
const modules = readdirSync(specs).filter((f) => f.endsWith(".tla")).map((f) => basename(f, ".tla"));
const configs = readdirSync(specs)
  .filter((f) => f.endsWith(".cfg"))
  .map((f) => basename(f, ".cfg"))
  .filter((name) => only.length === 0 || only.some((o) => name.startsWith(o)))
  .sort();
if (configs.length === 0) throw new Error(`No specs/*.cfg matched ${only.join(", ")}`);

const jar = await tlcJar();
let failed = 0;
for (const config of configs) {
  const module = modules.filter((m) => config.startsWith(m)).sort((a, b) => b.length - a.length)[0];
  const expected = /^\\\* expect: (.+)$/m.exec(readFileSync(join(specs, `${config}.cfg`), "utf8"))?.[1]?.trim();
  if (!module || !expected) {
    console.log(`✗ ${config}: needs a matching .tla and a first line \\* expect: ok | violation <Name>`);
    failed++;
    continue;
  }
  const meta = mkdtempSync(join(tmpdir(), "tlc-"));
  const run = spawnSync(
    java,
    ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-config", `${config}.cfg`, "-workers", "auto", "-metadir", meta, "-cleanup", `${module}.tla`],
    { cwd: specs, encoding: "utf8" },
  );
  rmSync(meta, { recursive: true, force: true });
  if (run.error) throw new Error(`Couldn't run ${java}: ${run.error.message}. TLC needs Java 11 or later (JAVA_HOME or java on PATH).`);
  const found = result(`${run.stdout}\n${run.stderr}`);
  if (found === expected) {
    console.log(`✓ ${config}: ${found}`);
  } else {
    console.log(`✗ ${config}: expected ${expected}, TLC found ${found}\n${run.stdout}`);
    failed++;
  }
}
if (failed) process.exitCode = 1;
