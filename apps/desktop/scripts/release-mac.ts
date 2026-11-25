import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `pnpm release:mac` (docs/releases.md): builds the Mac app for release, signs it with the
 * Developer ID Application certificate in this Mac's keychain, notarizes the apps and the dmgs
 * with an App Store Connect API key, checks the result, and uploads it to its channel with
 * scripts/release.ts. The version in apps/desktop/package.json picks the channel.
 *
 * Notarization takes APPLE_API_KEY (the .p8's path), APPLE_API_KEY_ID and APPLE_API_ISSUER from
 * the environment. Without them it uses the `asc` CLI's default key (~/.asc/config.json, the
 * key_id, issuer_id and private_key_path of `default_key_name`). It never prints the key.
 *
 * Source maps go to Sentry with SENTRY_AUTH_TOKEN from the environment, or else the token
 * `sentry-cli` is logged in with (~/.sentryclirc). Without either, Mac errors can't be traced to
 * the source, so it warns.
 *
 *   pnpm release:mac               build, notarize and upload
 *   pnpm release:mac --no-upload   build and notarize only (dist/)
 *
 * Apple's notarization can take an hour or more, so start it where no time limit stops it: a
 * terminal, a Rex pane, or `nohup pnpm release:mac > /tmp/release-mac.log 2>&1 &` from an agent
 * (docs/releases.md). Each step prints how long it took.
 */
const desktop = join(import.meta.dirname, "..");
const upload = !process.argv.includes("--no-upload");

function fail(message: string): never {
  console.error(`release:mac: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, quiet = false) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: desktop,
    env,
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  // A program that can't start (not found, or ENOEXEC: a file with no #! line) has status null.
  if (result.error)
    fail(
      `couldn't start ${command}: ${result.error.message}. Check that \`${command}\` runs from Node.`,
    );
  if (!quiet)
    console.log(
      `release:mac: ${command} ${args.slice(0, 2).join(" ")} took ${Math.round((Date.now() - started) / 60_000)} min.`,
    );
  if (result.status !== 0)
    fail(
      `${command} ${args[0] ?? ""} failed (exit ${result.status}).${quiet ? `\n${result.stdout}${result.stderr}` : ""}`,
    );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

if (process.platform !== "darwin") fail("run this on a Mac.");

// Every program this spawns, checked in seconds before anything is built: a pnpm Node can't start
// once cost a release an hour. `xcrun --find` checks stapler without running it.
for (const [command, args] of [
  ["pnpm", ["--version"]],
  ["node", ["--version"]],
  ["xcrun", ["--find", "stapler"]],
  ["xcrun", ["--find", "notarytool"]],
] as const)
  run(command, [...args], process.env, true);

function notaryKey(): { key: string; keyId: string; issuer: string } {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (key && keyId && issuer) return { key, keyId, issuer };
  const config = join(homedir(), ".asc", "config.json");
  if (!existsSync(config))
    fail(
      "set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or set up a default key with `asc auth`.",
    );
  const asc = JSON.parse(readFileSync(config, "utf8")) as {
    default_key_name?: string;
    keys?: { name?: string; key_id?: string; issuer_id?: string; private_key_path?: string }[];
  };
  const chosen = asc.keys?.find((k) => k.name === asc.default_key_name);
  if (
    !chosen?.key_id ||
    !chosen.issuer_id ||
    !chosen.private_key_path ||
    !existsSync(chosen.private_key_path)
  )
    fail(`~/.asc/config.json has no usable default key (${asc.default_key_name ?? "none"}).`);
  console.log(
    `Notarizing with the App Store Connect key ${chosen.key_id} (asc's default, ${asc.default_key_name}).`,
  );
  return { key: chosen.private_key_path, keyId: chosen.key_id, issuer: chosen.issuer_id };
}

const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], process.env, true);
if (!/"Developer ID Application: [^"]+"/.test(identities))
  fail(
    "no Developer ID Application certificate in the keychain, so the app can't be signed (and a Mac app that isn't signed can't update itself).",
  );

/** The `[auth] token` in ~/.sentryclirc, the file `sentry-cli login` writes. */
function sentryCliToken(): string | undefined {
  const path = join(homedir(), ".sentryclirc");
  if (!existsSync(path)) return undefined;
  let section = "";
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1] ?? "";
    else if (section === "auth") {
      const token = /^token\s*=\s*(\S+)$/.exec(line)?.[1];
      if (token) return token;
    }
  }
  return undefined;
}

const sentryToken = process.env["SENTRY_AUTH_TOKEN"] || sentryCliToken();
if (!sentryToken)
  console.warn(
    "No SENTRY_AUTH_TOKEN and no `sentry-cli login`, so the Mac build's source maps won't reach Sentry and its error reports won't point at the source.",
  );

const { key, keyId, issuer } = notaryKey();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  APPLE_API_KEY: key,
  APPLE_API_KEY_ID: keyId,
  APPLE_API_ISSUER: issuer,
  ...(sentryToken ? { SENTRY_AUTH_TOKEN: sentryToken } : {}),
};
// Electron runs as plain Node when this is set, and electron-builder runs Electron.
delete env["ELECTRON_RUN_AS_NODE"];

rmSync(join(desktop, "dist"), { recursive: true, force: true });
run("pnpm", ["build:release"], env);
run("pnpm", ["exec", "electron-builder", "--mac", "--publish", "never"], env);

// Check what was built: each app signed, accepted by Gatekeeper and stapled, each dmg stapled.
const dist = join(desktop, "dist");
const apps = readdirSync(dist)
  .filter((d) => d.startsWith("mac"))
  .map((d) => join(dist, d, "Uplink Room.app"))
  .filter(existsSync);
if (apps.length === 0) fail("electron-builder made no Uplink Room.app.");
for (const app of apps) {
  run("codesign", ["--verify", "--deep", "--strict", app], env, true);
  run("spctl", ["--assess", "--type", "execute", app], env, true);
  run("xcrun", ["stapler", "validate", app], env, true);
  console.log(`Signed, notarized and stapled: ${app}`);
}
for (const dmg of readdirSync(dist).filter((f) => f.endsWith(".dmg"))) {
  run("xcrun", ["stapler", "validate", join(dist, dmg)], env, true);
  console.log(`Stapled: ${dmg}`);
}

if (upload) run("node", [join(desktop, "scripts", "release.ts")], env);
else console.log("Built and notarized in apps/desktop/dist (--no-upload).");
