/**
 * What a person types on another machine to install the bridge and pair it (Settings, Machines,
 * Link a machine). The bridge comes from the release cloud machines install (machines.bridgeRelease):
 * the command downloads the tarball, checks it against the sha256 the room recorded, and only then
 * runs npm. npm itself doesn't check a `#sha256=` fragment on a URL, so the check is in the command.
 *
 * On macOS and Linux npm installs into ~/.uplink-room/npm, a folder of the person's own, as on a
 * cloud machine: Node from a system package keeps npm's global folder root's, where `npm install -g`
 * fails with EACCES, and sudo isn't the answer. On Windows npm's global folder is already the
 * person's (%APPDATA%\npm), and Node's installer puts it on PATH.
 */
import { psQuote, shQuote } from "../../main/shellQuote";

export type MachineOs = "macos" | "linux" | "windows";

export type BridgeRelease = { url: string; sha256: string; version: string | null };

const FILE = "uplink-bridge.tgz";

/**
 * Text every shell the commands run in (sh, bash, zsh, fish, PowerShell) reads as itself, quoted or
 * not: no quote of any kind, no whitespace, no `$`, backtick, backslash, `;`, `&`, `|` or brackets.
 */
const PLAIN = /^[A-Za-z0-9._~:/-]+$/;

/** A URL that goes into a command as is: one of `schemes`, plain text only, no credentials, query or fragment. */
export function plainUrl(url: string | undefined, schemes: string[]): string | null {
  if (!url || !PLAIN.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!schemes.includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  } catch {
    return null;
  }
  return url;
}

/** The release, if every part of it can go into a command; the backend checks the same (lib/cloudBoot.ts, bridgeReleaseFrom). */
export function usableRelease(release: BridgeRelease): BridgeRelease | null {
  const ok =
    plainUrl(release.url, ["https:"]) !== null &&
    /^[0-9a-f]{64}$/.test(release.sha256) &&
    (release.version === null || /^\d+\.\d+\.\d+$/.test(release.version));
  return ok ? release : null;
}

// Quoting for each shell, shared with the main process's bridgeCommand.
export { psQuote, shQuote } from "../../main/shellQuote";

/** Where npm installs the bridge on macOS and Linux, as a shell writes it. */
const UNIX_PREFIX = '"$HOME/.uplink-room/npm"';

/** The install line for a URL and hash already checked. Exported for the tests, which run it against a local file. */
export function installLine(os: MachineOs, url: string, sha256: string): string {
  if (os === "windows") {
    // npm.cmd, not npm: Windows PowerShell's default policy refuses npm's own npm.ps1.
    return [
      `Invoke-WebRequest -UseBasicParsing ${psQuote(url)} -OutFile ${FILE}`,
      `if ((Get-FileHash ${FILE} -Algorithm SHA256).Hash -ne ${psQuote(sha256)}) { throw "${FILE} doesn't match the room's sha256" }`,
      `npm.cmd install -g --allow-scripts=node-pty .\\${FILE}`,
      `Remove-Item ${FILE}`,
    ].join("; ");
  }
  // `-` reads the checklist from stdin: GNU's sha256sum reads it without, BSD's needs it.
  const check = os === "macos" ? "shasum -a 256 -c" : "sha256sum -c -";
  return [
    `curl -fsSLo ${FILE} ${shQuote(url)}`,
    `echo ${shQuote(`${sha256}  ${FILE}`)} | ${check}`,
    `npm install -g --prefix ${UNIX_PREFIX} --allow-scripts=node-pty ./${FILE}`,
    `rm ${FILE}`,
  ].join(" && ");
}

/** One line for the machine's own shell (zsh or bash, PowerShell on Windows), or null when the release can't go into a command. */
export function installCommand(os: MachineOs, release: BridgeRelease): string | null {
  const usable = usableRelease(release);
  return usable ? installLine(os, usable.url, usable.sha256) : null;
}

/**
 * macOS and Linux: puts npm's bin folder under ~/.uplink-room/npm on PATH for new terminals, in the
 * startup file of each system's usual shell (zsh on macOS, bash on Linux). Windows needs none.
 * The line goes after a newline of its own, so it can't run onto a last line that has none.
 */
export function pathLine(os: MachineOs): string | null {
  if (os === "windows") return null;
  const line = shQuote('export PATH="$HOME/.uplink-room/npm/bin:$PATH"');
  return `printf '\\n%s\\n' ${line} >> ~/${os === "macos" ? ".zprofile" : ".bashrc"}`;
}

/** The program name after the install: PowerShell runs npm's .ps1 shim only when scripts are allowed, so Windows names the .cmd one. */
export function bridgeProgram(os: MachineOs): string {
  return os === "windows" ? "uplink-bridge.cmd" : "uplink-bridge";
}

/** `<program> pair <code> --url <url>`; a code or URL that isn't plain text shows as a placeholder rather than go into a command. */
export function pairCommand(program: string, code: string, url: string | undefined): string {
  const safeCode = /^[A-Za-z0-9-]{4,64}$/.test(code) ? code : "<pairing code>";
  return `${program} pair ${safeCode} --url ${plainUrl(url, ["https:", "http:"]) ?? "<your Convex URL>"}`;
}

/** Linux has no node-pty prebuild, so npm compiles it with these (Debian and Ubuntu package names). */
export const LINUX_BUILD_TOOLS = "sudo apt-get install -y python3 make g++";

/** This computer's system, as the other machine's first guess. */
export function osOf(platform: string | undefined): MachineOs {
  return platform === "win32" ? "windows" : platform === "linux" ? "linux" : "macos";
}
