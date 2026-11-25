import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list, put } from "@vercel/blob";

/**
 * Publishes the bridge for cloud machines (#52, ADR 0013): builds and packs
 * it, uploads the tarball to the public Vercel Blob store
 * `uplink-bridge-releases` at `bridge/uplink-room-bridge-<version>-<sha>.tgz`,
 * downloads it again to check its sha256, and points
 * `UPLINK_BRIDGE_TARBALL_URL` on the Convex deployment at it, as
 * `<url>#sha256=<hex>`: a cloud machine installs the tarball only when its
 * bytes match that hash (`packages/backend/convex/lib/cloudBoot.ts`), and
 * reinstalls the bridge on its next boot when the value changes.
 *
 * It won't point the deployment at an older version than the one it has (a
 * rerun of an old tag would roll every cloud machine back). `--rollback` does
 * that on purpose.
 *
 * Needs `BLOB_READ_WRITE_TOKEN` (the store's read-write token) and
 * `CONVEX_DEPLOY_KEY` (prod's deploy key picks prod). `--skip-convex` stops
 * after the upload and its check. It talks to the store through `@vercel/blob`
 * with that token, not the Vercel CLI, which wants a Vercel login even when
 * given the token. Running it again for the same commit reuses the
 * tarball already uploaded if its sha256 matches.
 */
const root = join(import.meta.dirname, "..");
const repo = join(root, "../..");
const skipConvex = process.argv.includes("--skip-convex");
const rollback = process.argv.includes("--rollback");

/** The version in a tarball URL (`.../uplink-room-bridge-<version>-<sha>.tgz`), or null. */
function versionIn(url: string): number[] | null {
  const match = /uplink-room-bridge-(\d+)\.(\d+)\.(\d+)-[0-9a-f]+\.tgz/.exec(url);
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Negative when `a` is older than `b`. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

class ReleaseError extends Error {}

function fail(message: string): never {
  throw new ReleaseError(message);
}

/** Runs a command and returns its output. On failure it names only the command, never its arguments (the token is one). */
function run(command: string[], cwd = repo) {
  const [bin, ...args] = command;
  const result = spawnSync(bin!, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`couldn't start ${bin}: ${result.error.message}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) fail(`${bin} ${args[0] ?? ""} failed (exit ${result.status}):\n${output}`);
  return output;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const token = process.env["BLOB_READ_WRITE_TOKEN"] ?? "";
const missing = [...(token ? [] : ["BLOB_READ_WRITE_TOKEN"]), ...(skipConvex || process.env["CONVEX_DEPLOY_KEY"] ? [] : ["CONVEX_DEPLOY_KEY"])];
if (missing.length > 0) {
  console.error(`release: set ${missing.join(" and ")} (or pass --skip-convex to leave the deployment alone).`);
  process.exit(1);
}

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
};
const commit = process.env["GITHUB_SHA"] ?? run(["git", "rev-parse", "HEAD"]).trim();
const sha = commit.slice(0, 7);
if (!/^[0-9a-f]{7}$/.test(sha)) fail(`couldn't read the commit (got "${sha}").`);
const pathname = `bridge/uplink-room-bridge-${version}-${sha}.tgz`;

// Build and pack.
run(["pnpm", "--filter", "@uplink-room/bridge", "build"]);
const out = await mkdtemp(join(tmpdir(), "uplink-bridge-release-"));
try {
  run(["pnpm", "pack", "--pack-destination", out], root);
  const packed = (await readdir(out)).filter((f) => f.endsWith(".tgz"));
  if (packed.length !== 1) fail(`expected one tarball from pnpm pack, found ${packed.length}.`);
  const tarball = join(out, packed[0]!);
  const local = sha256(await readFile(tarball));
  console.log(`Packed ${packed[0]} (sha256 ${local}).`);

  // Upload, unless this commit's tarball is already there.
  const listed = await list({ prefix: pathname, token });
  let url = listed.blobs.find((blob) => blob.pathname === pathname)?.url;
  if (url) {
    console.log(`Already uploaded: ${url}`);
  } else {
    const blob = await put(pathname, await readFile(tarball), {
      access: "public",
      token,
      addRandomSuffix: false,
      contentType: "application/gzip",
    });
    url = blob.url;
    console.log(`Uploaded ${url}`);
  }

  // What a cloud machine will download must be what was packed.
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) fail(`downloading ${url} answered ${response.status}.`);
  const remote = sha256(new Uint8Array(await response.arrayBuffer()));
  if (remote !== local)
    fail(`the downloaded tarball's sha256 is ${remote}, but the packed one is ${local}.`);
  console.log(`Downloaded it again: sha256 matches (${remote}).`);

  if (skipConvex) {
    console.log("Skipped setting UPLINK_BRIDGE_TARBALL_URL (--skip-convex).");
  } else {
    const backend = join(repo, "packages/backend");
    const setting = `${url}#sha256=${local}`;
    // `convex env get` fails for a variable that isn't set yet, as on a deployment's first release.
    const before = spawnSync("pnpm", ["exec", "convex", "env", "get", "UPLINK_BRIDGE_TARBALL_URL"], {
      cwd: backend,
      encoding: "utf8",
    });
    // A pnpm that can't start would read as "not set yet" and skip the rollback check below.
    if (before.error) fail(`couldn't start pnpm: ${before.error.message}`);
    const current = before.status === 0 ? versionIn(before.stdout) : null;
    const mine = versionIn(url) ?? fail(`can't read the version in ${url}.`);
    if (current && compareVersions(mine, current) < 0 && !rollback)
      fail(
        `the deployment already runs bridge ${current.join(".")}, newer than ${version}. Run with --rollback to go back on purpose.`,
      );
    run(["pnpm", "exec", "convex", "env", "set", "UPLINK_BRIDGE_TARBALL_URL", setting], backend);
    const now = run(["pnpm", "exec", "convex", "env", "get", "UPLINK_BRIDGE_TARBALL_URL"], backend).trim();
    if (!now.split("\n").includes(setting))
      fail(`UPLINK_BRIDGE_TARBALL_URL reads back as "${now}", not ${setting}.`);
    console.log(
      `UPLINK_BRIDGE_TARBALL_URL now points at ${url} (sha256 ${local}). Cloud machines install it on their next boot.`,
    );
  }
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`release: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(out, { recursive: true, force: true });
}
