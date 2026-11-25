import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { installCommand, installLine, pairCommand, pathLine, psQuote, shQuote, type MachineOs } from "./bridgeInstall";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const unix = process.platform !== "win32";

/**
 * Runs the install line in sh with HOME in a temporary folder, curl reading a local tarball, and npm
 * replaced by a script that logs its arguments.
 */
async function run(os: MachineOs, sha256: (bytes: Buffer) => string) {
  const root = await mkdtemp(join(tmpdir(), "uplink install "));
  roots.push(root);
  const bytes = Buffer.from("a packed bridge");
  const tarball = join(root, "uplink-room-bridge-0.2.5-57b537f.tgz");
  await writeFile(tarball, bytes);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" > ${JSON.stringify(join(root, "npm.log"))}\n`, { mode: 0o755 });
  const line = installLine(os, pathToFileURL(tarball).href, sha256(bytes));
  const env = { ...process.env, HOME: join(root, "home"), PATH: `${bin}:${process.env["PATH"]}` };
  const ran = spawnSync("sh", ["-c", line], { cwd: root, env, encoding: "utf8" });
  const npm = existsSync(join(root, "npm.log")) ? (await readFile(join(root, "npm.log"), "utf8")).trim() : null;
  return { status: ran.status, npm, left: existsSync(join(root, FILE_NAME)), home: env.HOME };
}
const FILE_NAME = "uplink-bridge.tgz";
const real = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

for (const [os, tool] of [
  ["macos", "shasum"],
  ["linux", "sha256sum"],
] as const) {
  test.runIf(unix && has(tool) && has("curl"))(`${os}: npm installs into ~/.uplink-room/npm, without sudo, only when the tarball matches the room's sha256`, async () => {
    const ok = await run(os, real);
    expect(ok).toEqual({ status: 0, npm: `install -g --prefix ${ok.home}/.uplink-room/npm --allow-scripts=node-pty ./uplink-bridge.tgz`, left: false, home: ok.home });
    const wrong = await run(os, () => "0".repeat(64));
    expect(wrong.status).not.toBe(0);
    expect(wrong.npm).toBeNull();
  });
}

test.runIf(unix)("macOS and Linux: the PATH line puts ~/.uplink-room/npm/bin first for a new shell, even after a last line with no newline", async () => {
  for (const [os, file] of [
    ["macos", ".zprofile"],
    ["linux", ".bashrc"],
  ] as const) {
    // No startup file yet, and one whose last line is a comment that doesn't end in a newline:
    // appended straight after it, the export would be part of the comment.
    for (const before of [null, "export EDITOR=vim\n# my settings"]) {
      const home = await mkdtemp(join(tmpdir(), "uplink home "));
      roots.push(home);
      if (before !== null) await writeFile(join(home, file), before);
      execFileSync("sh", ["-c", pathLine(os)!], { env: { ...process.env, HOME: home } });
      const env = { ...process.env, HOME: home, EDITOR: "" };
      const path = execFileSync("sh", ["-c", `. "$HOME/${file}"; printf %s "$PATH"`], { env, encoding: "utf8" });
      expect(path.split(":")[0], `${file} ${JSON.stringify(before)}`).toBe(`${home}/.uplink-room/npm/bin`);
      if (before !== null) {
        expect(await readFile(join(home, file), "utf8")).toBe(`${before}\nexport PATH="$HOME/.uplink-room/npm/bin:$PATH"\n`);
        expect(execFileSync("sh", ["-c", `. "$HOME/${file}"; printf %s "$EDITOR"`], { env, encoding: "utf8" })).toBe("vim");
      }
    }
  }
  expect(pathLine("windows")).toBeNull();
});

const RELEASE = { url: "https://abc.public.blob.vercel-storage.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz", sha256: "ab".repeat(32), version: "0.2.5" };

test("a release URL that isn't plain text, or isn't https, never goes into a command", () => {
  expect(installCommand("linux", RELEASE)).toContain(`'${RELEASE.url}'`);
  for (const url of [
    `${RELEASE.url}’;Write-Output(12345);’`,
    `${RELEASE.url}';id;'`,
    "https://abc.public.blob.vercel-storage.com/bridge/$(id).tgz",
    "https://abc.public.blob.vercel-storage.com/bridge/`id`.tgz",
    "https://abc.public.blob.vercel-storage.com/bridge/a b.tgz",
    "http://abc.public.blob.vercel-storage.com/bridge/b.tgz",
    "file:///tmp/b.tgz",
  ]) {
    for (const os of ["macos", "linux", "windows"] as const) expect(installCommand(os, { ...RELEASE, url }), `${os} ${url}`).toBeNull();
  }
  expect(installCommand("windows", { ...RELEASE, sha256: "x".repeat(64) })).toBeNull();
  // The pair command's code and URL are checked the same way.
  expect(pairCommand("uplink-bridge", "JQJG-9PUM", "https://fleet-jaguar-632.convex.cloud")).toBe(
    "uplink-bridge pair JQJG-9PUM --url https://fleet-jaguar-632.convex.cloud",
  );
  expect(pairCommand("uplink-bridge", "a;b", "https://x.convex.cloud/’;id")).toBe("uplink-bridge pair <pairing code> --url <your Convex URL>");
});

const QUOTES = ["it's", "a‘b", "a’b", "a‚b", "a‛b", "a$(id)`id`b"];

test.runIf(unix)("sh reads each quoted value back as itself", () => {
  for (const value of QUOTES) expect(execFileSync("sh", ["-c", `printf %s ${shQuote(value)}`], { encoding: "utf8" })).toBe(value);
});

// One pwsh for every value, and time for it to start: under the whole suite's load a start takes
// seconds, and one per value passed vitest's 5 seconds.
test.runIf(has("pwsh"))("PowerShell reads each quoted value back as itself, curly quotes included", () => {
  const script = ["[Console]::OutputEncoding = [Text.Encoding]::UTF8", ...QUOTES.map((value) => `Write-Output ${psQuote(value)}`)].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  expect(execFileSync("pwsh", ["-NoProfile", "-EncodedCommand", encoded], { encoding: "utf8" }).trim().split(/\r?\n/)).toEqual(QUOTES);
}, 30_000);

test("Windows: PowerShell checks the download's SHA256 before npm.cmd runs, and npm keeps its own global folder", () => {
  expect(installCommand("windows", RELEASE)).toBe(
    `Invoke-WebRequest -UseBasicParsing '${RELEASE.url}' -OutFile uplink-bridge.tgz; ` +
      `if ((Get-FileHash uplink-bridge.tgz -Algorithm SHA256).Hash -ne '${"ab".repeat(32)}') { throw "uplink-bridge.tgz doesn't match the room's sha256" }; ` +
      `npm.cmd install -g --allow-scripts=node-pty .\\uplink-bridge.tgz; Remove-Item uplink-bridge.tgz`,
  );
});
