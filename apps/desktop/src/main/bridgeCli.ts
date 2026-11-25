import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import {
  APP_COMMANDS,
  isAppLauncher,
  isAppLauncherDir,
  isFullyQualifiedWindows,
  launcherDirEntries,
  windowsFolders,
  windowsKey,
  withLauncherFirst,
  type AppCommand,
  type BridgeCli,
  type BridgeCliInstall,
  type PathKind,
  type ToolCli,
} from "./bridgeCliSpec";
import { shQuote } from "./shellQuote";

/**
 * `uplink-bridge` on PATH (main/bridgeCliSpec.ts): what a new terminal runs for it, and putting
 * this app's launcher there when the person asks. Nothing here changes anything until `install`.
 *
 * Every system call goes through `BridgeCliDeps`, so the tests run it against temporary folders, a
 * scripted shell and a mocked administrator prompt, never this computer's own PATH.
 */
export type BridgeCliDeps = {
  platform: "darwin" | "win32" | "linux";
  /** This app's launcher: `.../resources/bin/uplink-bridge`, or `uplink-bridge.cmd` on Windows. */
  launcher: string;
  /** The command a person types for it (main/bridge.ts `bridgeCommand`). */
  command: (onPath: boolean) => string;
  env: Record<string, string | undefined>;
  /** macOS and Linux: the folders a new terminal searches, in order, or null when its shell couldn't say. */
  shellPath: () => Promise<string[] | null>;
  /** macOS and Linux: the folders to search when the shell couldn't say. */
  defaultPath: () => Promise<string[]>;
  /** macOS: where the link goes (/usr/local/bin). Linux: where the package puts it (/usr/bin). */
  linkDir: string;
  /** macOS: runs AppleScript with arguments, as `osascript -e <script> <args...>`. */
  osascript: (script: string, args: string[]) => Promise<void>;
  /** Windows: runs a PowerShell script with these extra variables and returns what it printed. */
  powershell: (script: string, env: Record<string, string>) => Promise<string>;
  /** Windows: the key under HKEY_CURRENT_USER that holds the user's variables (`Environment`). */
  envKey: string;
  /** Windows: whether a file exists. */
  exists: (path: string) => Promise<boolean>;
  /** Linux: running from an AppImage, whose path changes on every launch. */
  appImage: boolean;
};

const NAME = "uplink-bridge";

export async function readBridgeCli(d: BridgeCliDeps): Promise<BridgeCli> {
  return d.platform === "win32" ? windowsStatus(d, await readWindowsPaths(d)) : unixStatus(d);
}

/** This app's launcher for `name`, beside the bridge's in resources/bin. */
export function launcherFor(d: BridgeCliDeps, name: AppCommand): string {
  if (name === NAME) return d.launcher;
  return d.platform === "win32" ? win32.join(win32.dirname(d.launcher), `${name}.cmd`) : join(dirname(d.launcher), name);
}

/**
 * All three commands the app carries (ADR 0042): the bridge's status as `readBridgeCli` reads it,
 * with `uplink` and `uplink-mcp` in `tools`. Windows' PATH is read once for all three.
 */
export async function readAppCommands(d: BridgeCliDeps): Promise<BridgeCli> {
  const paths = d.platform === "win32" ? await readWindowsPaths(d) : null;
  const read = (name: AppCommand) => (paths ? windowsStatus(d, paths, name) : unixStatus(d, name));
  const [bridge, ...tools] = await Promise.all(APP_COMMANDS.map(read));
  return {
    ...bridge!,
    tools: tools.map(({ platform: _p, command: _c, tools: _t, ...rest }, i) => ({ name: APP_COMMANDS[i + 1] as ToolCli["name"], ...rest })),
  };
}

/**
 * Add to PATH for all three: every command that isn't this app's yet and that the app can place
 * goes on PATH in one step. On macOS the links that need an administrator share one prompt; on
 * Windows one PATH entry, the bin folder, covers all three. Then reads again what a terminal runs.
 */
export async function installAppCommands(d: BridgeCliDeps): Promise<BridgeCli> {
  const before = await readAppCommands(d);
  const all = [{ name: NAME as AppCommand, ...before }, ...(before.tools ?? [])];
  const todo = all.flatMap((c) => (c.state !== "ours" && c.install && c.install.kind !== "none" ? [{ name: c.name, install: c.install }] : []));
  if (!todo.length) {
    if (all.every((c) => c.state === "ours")) return before;
    const stuck = all.filter((c) => c.state !== "ours").map((c) => c.name);
    throw new Error(`The app can't put ${stuck.join(" and ")} on PATH here.`);
  }
  if (d.platform === "win32") await windowsInstall(d);
  else {
    const links = todo.map((t) => ({ ...(t.install as Extract<BridgeCliInstall, { kind: "link" }>), launcher: launcherFor(d, t.name) }));
    await linkAll(d, links);
  }
  return readAppCommands(d);
}

/** Puts this app's launcher on PATH, then reads again what a new terminal runs. */
export async function installBridgeCli(d: BridgeCliDeps): Promise<BridgeCli> {
  const before = await readBridgeCli(d);
  const install = before.install;
  if (before.state === "ours" || !install) return before;
  if (install.kind === "none") throw new Error("The app can't put uplink-bridge on PATH here.");
  if (install.kind === "link") await linkInstall(d, install);
  else await windowsInstall(d);
  return readBridgeCli(d);
}

// ---------- macOS and Linux ----------

async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * What is at a path, without following it: nothing, a link (as it reads, and where it leads), or
 * something else. Anything that can't be read counts as something else, never as nothing.
 */
type Entry = { kind: "none" } | { kind: "link"; reads: string; target: string } | { kind: "other" };

async function entryAt(path: string): Promise<Entry> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return { kind: "other" };
    const reads = await readlink(path);
    return { kind: "link", reads, target: resolve(dirname(path), reads) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "other" };
  }
}

const samePlace = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

async function unixStatus(d: BridgeCliDeps, name: AppCommand = NAME): Promise<BridgeCli> {
  const dirs = (await d.shellPath()) ?? (await d.defaultPath());
  const launcher = launcherFor(d, name);
  const ours = (await realOrNull(launcher)) ?? launcher;
  const base = { platform: d.platform, launcher };
  const place = join(d.linkDir, name);
  const atPlace = await entryAt(place);
  // The first runnable one wins, as the shell's own lookup does. An empty or relative entry is a
  // folder relative to wherever the terminal is, so nothing after it is certain.
  let relativeFirst = false;
  for (const [index, dir] of dirs.entries()) {
    if (!isAbsolute(dir)) {
      relativeFirst = true;
      continue;
    }
    const path = join(dir, name);
    if (!(await runnable(path))) continue;
    const target = (await realOrNull(path)) ?? path;
    if (target === ours) {
      return relativeFirst
        ? { ...base, state: "ours", found: path, runs: true, relativeFirst: true, command: d.command(false) }
        : { ...base, state: "ours", found: path, runs: true, command: d.command(true) };
    }
    return {
      ...base,
      state: isAppLauncher(target, name) ? "stale" : "other",
      found: path,
      target,
      runs: true,
      command: d.command(false),
      install: await unixInstall(d, dirs, index, atPlace, name),
    };
  }
  // Nothing runs. Whatever is where the app would put its link is reported, never taken for nothing:
  // a link to a copy of Uplink Room that's gone is stale; a file that isn't executable, a folder, or
  // a link to anything else is something else, which the app leaves alone.
  const missing = { ...base, command: d.command(false), install: await unixInstall(d, dirs, null, atPlace, name) };
  if (atPlace.kind === "link") {
    return { ...missing, state: isAppLauncher(atPlace.target, name) ? "stale" : "other", found: place, target: atPlace.target, runs: false };
  }
  if (atPlace.kind === "other") return { ...missing, state: "other", found: place, runs: false };
  return { ...missing, state: "missing" };
}

async function writable(dir: string): Promise<boolean> {
  for (let at = dir; ; at = dirname(at)) {
    try {
      await access(at, constants.W_OK);
      // A folder that doesn't exist yet is made inside the nearest one that does.
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) return false;
    }
  }
}

async function unixInstall(d: BridgeCliDeps, dirs: string[], winner: number | null, atPlace: Entry, name: AppCommand = NAME): Promise<BridgeCliInstall> {
  if (d.platform === "linux") {
    if (d.appImage) return { kind: "none", why: "appimage" };
    // The .deb's post-install makes /usr/bin/uplink-bridge, uplink and uplink-mcp; the app doesn't
    // run as root. A link in /usr/local/bin comes before /usr/bin on PATH. Without -f, ln stops if
    // something is already there.
    return { kind: "none", why: "package", manual: `sudo ln -s ${shQuote(launcherFor(d, name))} /usr/local/bin/${name}` };
  }
  const index = dirs.findIndex((dir) => samePlace(dir, d.linkDir));
  if (index === -1) return { kind: "none", why: "folder-not-on-path" };
  if (winner !== null && winner < index) return { kind: "none", why: "shadowed" };
  const at = join(d.linkDir, name);
  const admin = !(await writable(d.linkDir));
  if (atPlace.kind === "none") return { kind: "link", at, admin };
  // Only another copy of Uplink Room is ever replaced, and only through "Use this app's".
  if (atPlace.kind === "link" && isAppLauncher(atPlace.target, name)) return { kind: "link", at, admin, replaces: atPlace.reads };
  return { kind: "none", why: "occupied" };
}

/** Exit codes of the link script: something appeared where nothing was, or the old link changed. */
const APPEARED = 17;
const CHANGED = 18;

/**
 * The AppleScript that links the launcher (TN2065, "do shell script in AppleScript"). The paths
 * arrive as arguments and reach the shell through `quoted form of`, so no path is ever spliced into
 * the script. With `admin`, macOS shows its own administrator prompt, as VS Code's "Install 'code'
 * command in PATH" does.
 *
 * - `create`, with [launcher, folder, link]: makes the link only where nothing is (`ln -s`, no -f),
 *   and exits 17 if something is there, such as a file made while the prompt was open.
 * - `replace`, with [launcher, link, what the old link reads]: replaces the link only while it
 *   still reads the same, else exits 18.
 */
export function linkScript(mode: "create" | "replace", admin: boolean): string {
  const command =
    mode === "create"
      ? `"if [ -e " & quoted form of item 3 of argv & " ] || [ -L " & quoted form of item 3 of argv & " ]; then exit ${APPEARED}; fi; ` +
        `/bin/mkdir -p " & quoted form of item 2 of argv & " && /bin/ln -s " & quoted form of item 1 of argv & " " & quoted form of item 3 of argv`
      : `"if [ ! -L " & quoted form of item 2 of argv & " ] || [ \\"$(/usr/bin/readlink " & quoted form of item 2 of argv & ")\\" != " & quoted form of item 3 of argv & " ]; then exit ${CHANGED}; fi; ` +
        `/bin/ln -sfh " & quoted form of item 1 of argv & " " & quoted form of item 2 of argv`;
  // macOS shows this above its password field.
  const prompt =
    mode === "create"
      ? `"Uplink Room wants to add uplink-bridge to " & item 2 of argv & "."`
      : `"Uplink Room wants to point " & item 2 of argv & " at its own bridge."`;
  return [
    "on run argv",
    admin ? `do shell script ${command} with prompt ${prompt} with administrator privileges` : `do shell script ${command}`,
    "end run",
  ].join("\n");
}

type Link = Extract<BridgeCliInstall, { kind: "link" }> & { launcher: string };

/**
 * Makes several links: each one the app can make itself, then the rest through one administrator
 * prompt, which checks every link before it makes any.
 */
async function linkAll(d: BridgeCliDeps, links: Link[]): Promise<void> {
  if (links.length === 1) return linkInstall(d, links[0]!, links[0]!.launcher);
  const prompt: Link[] = [];
  for (const link of links) {
    if (link.admin || !(await linkDirect(d, link, link.launcher))) prompt.push(link);
  }
  if (!prompt.length) return;
  if (prompt.length === 1) return linkWithPrompt(d, prompt[0]!, prompt[0]!.launcher);
  const at = prompt.map((l) => l.at).join(", ");
  try {
    await d.osascript(linksScript(prompt.map((l) => (l.replaces === undefined ? "create" : "replace"))), [
      d.linkDir,
      ...prompt.flatMap((l) => [l.launcher, l.at, l.replaces ?? ""]),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/-128\b|User cancel/i.test(message)) throw new Error("Nothing changed: the administrator prompt was cancelled.");
    if (message.includes(`(${APPEARED})`) || message.includes(`(${CHANGED})`)) {
      throw new Error(`Something changed at ${at} meanwhile, so the app left them alone. Nothing changed.`);
    }
    throw new Error(`Couldn't link ${at}: ${message.trim().split("\n").pop()}`);
  }
}

/**
 * The AppleScript that makes several links with one administrator prompt, as `linkScript` makes one.
 * Its arguments are the folder, then three for each link: the launcher, the link, and what the old
 * link reads ("" when there is none). It checks every link first (17: something appeared where
 * nothing was; 18: an old link changed) and makes none unless all are as the app read them.
 */
export function linksScript(modes: ("create" | "replace")[], admin = true): string {
  const item = (n: number) => `" & quoted form of item ${n} of argv & "`;
  const checks = modes.map((mode, i) => {
    const [link, old] = [item(3 + 3 * i), item(4 + 3 * i)];
    return mode === "create"
      ? `if [ -e ${link} ] || [ -L ${link} ]; then exit ${APPEARED}; fi; `
      : `if [ ! -L ${link} ] || [ \\"$(/usr/bin/readlink ${link})\\" != ${old} ]; then exit ${CHANGED}; fi; `;
  });
  const makes = modes.map((mode, i) => `/bin/ln ${mode === "create" ? "-s" : "-sfh"} ${item(2 + 3 * i)} ${item(3 + 3 * i)}`);
  const command = `"${checks.join("")}/bin/mkdir -p ${item(1)} && ${makes.join(" && ")}"`;
  const names = modes.length === 3 ? "uplink-bridge, uplink and uplink-mcp" : "Uplink Room's commands";
  return [
    "on run argv",
    admin
      ? `do shell script ${command} with prompt "Uplink Room wants to add ${names} to " & item 1 of argv & "." with administrator privileges`
      : `do shell script ${command}`,
    "end run",
  ].join("\n");
}

/** Makes one link without a prompt. False when the folder needs an administrator. */
async function linkDirect(d: BridgeCliDeps, install: Link, launcher: string): Promise<boolean> {
  const { at, replaces } = install;
  const appeared = () => new Error(`Something appeared at ${at} meanwhile, so the app left it alone. Nothing changed.`);
  const changed = () => new Error(`${at} changed meanwhile, so the app left it alone. Nothing changed.`);
  try {
    if (replaces === undefined) {
      await mkdir(d.linkDir, { recursive: true });
      await symlink(launcher, at).catch((error: NodeJS.ErrnoException) => {
        throw error.code === "EEXIST" ? appeared() : error;
      });
      return true;
    }
    const now = await entryAt(at);
    if (now.kind !== "link" || now.reads !== replaces) throw changed();
    const temp = join(d.linkDir, `.${basename(at)}-${process.pid}-${Date.now()}`);
    await symlink(launcher, temp);
    try {
      await rename(temp, at);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return false;
    throw error;
  }
}

/** One link through the administrator prompt (`linkScript`). */
async function linkWithPrompt(d: BridgeCliDeps, install: Extract<BridgeCliInstall, { kind: "link" }>, launcher: string): Promise<void> {
  const { at, replaces } = install;
  try {
    await (replaces === undefined
      ? d.osascript(linkScript("create", true), [launcher, d.linkDir, at])
      : d.osascript(linkScript("replace", true), [launcher, at, replaces]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // -128 is AppleScript's "User canceled"; a shell's exit status comes last, in parentheses.
    if (/-128\b|User cancel/i.test(message)) throw new Error("Nothing changed: the administrator prompt was cancelled.");
    if (message.includes(`(${APPEARED})`)) throw new Error(`Something appeared at ${at} meanwhile, so the app left it alone. Nothing changed.`);
    if (message.includes(`(${CHANGED})`)) throw new Error(`${at} changed meanwhile, so the app left it alone. Nothing changed.`);
    throw new Error(`Couldn't link ${at}: ${message.trim().split("\n").pop()}`);
  }
}

async function linkInstall(d: BridgeCliDeps, install: Extract<BridgeCliInstall, { kind: "link" }>, launcher = d.launcher): Promise<void> {
  if (!install.admin && (await linkDirect(d, { ...install, launcher }, launcher))) return;
  await linkWithPrompt(d, install, launcher);
}

/** The folders on PATH in a new terminal, from the person's login shell (as Terminal starts it). */
export function loginShellPath(env: Record<string, string | undefined>, timeoutMs = 5000): Promise<string[] | null> {
  const shell = env["SHELL"] && isAbsolute(env["SHELL"]) ? env["SHELL"] : "/bin/sh";
  const mark = "__uplink_room_path__";
  return new Promise((done) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-l", "-i", "-c", `printf '${mark}%s${mark}' "$PATH"`], {
        env: { ...env, UPLINK_READING_PATH: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return done(null);
    }
    // A startup file that waits on something can't hold the answer up.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.once("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.once("close", () => {
      clearTimeout(timer);
      const found = new RegExp(`${mark}([\\s\\S]*?)${mark}`).exec(out);
      // Empty entries stay: each means the terminal's current folder.
      done(found ? found[1]!.split(":") : null);
    });
  });
}

/** macOS: the PATH every shell starts from, as path_helper builds it from /etc/paths and /etc/paths.d. */
export async function macDefaultPath(): Promise<string[]> {
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const dirs = lines(await readFile("/etc/paths", "utf8").catch(() => "/usr/local/bin\n/usr/bin\n/bin\n/usr/sbin\n/sbin"));
  const extra = (await readdir("/etc/paths.d").catch(() => [] as string[])).sort();
  for (const file of extra) dirs.push(...lines(await readFile(join("/etc/paths.d", file), "utf8").catch(() => "")));
  return dirs;
}

export const LINUX_DEFAULT_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

// ---------- Windows ----------

/**
 * Reads the user's and the system's PATH as stored, `%VARS%` unexpanded, as Scoop does
 * (lib/system.ps1, Get-EnvVar), with each value's registry type: reading through .NET's default
 * expands them, and writing that back would freeze them. `$env:UPLINK_ENV_KEY` names the user key,
 * so the tests use a throwaway one.
 */
export const READ_PATHS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$opt = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
function Read-PathValue($root, $name) {
  $key = $root.OpenSubKey($name)
  if ($null -eq $key) { return $null }
  try {
    if ($key.GetValueNames() -contains 'Path') {
      return @{ value = [string]$key.GetValue('Path', '', $opt); kind = $key.GetValueKind('Path').ToString() }
    }
    return $null
  } finally { $key.Close() }
}
$user = Read-PathValue ([Microsoft.Win32.Registry]::CurrentUser) $env:UPLINK_ENV_KEY
$machine = Read-PathValue ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
[pscustomobject]@{
  user = $user.value
  userKind = $user.kind
  machine = $machine.value
  machineKind = $machine.kind
} | ConvertTo-Json -Compress
`;

/**
 * Writes the user's PATH, then tells running programs, as Microsoft's "Environment Variables" page
 * says: broadcast WM_SETTINGCHANGE with "Environment" (the same call as Scoop's Publish-EnvVar).
 * The value keeps the registry type it had (`$env:UPLINK_PATH_KIND`): a REG_SZ PATH stays REG_SZ,
 * so a literal `C:\\%TOOLS%\\bin` stays literal. It refuses when the PATH or its type changed since the
 * app read it, so nothing another program wrote meanwhile is lost.
 */
export const WRITE_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:UPLINK_ENV_KEY)
try {
  $opt = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  $had = $key.GetValueNames() -contains 'Path'
  $now = if ($had) { [string]$key.GetValue('Path', '', $opt) } else { '' }
  $nowKind = if ($had) { $key.GetValueKind('Path').ToString() } else { '' }
  $kindChanged = $had -and ($nowKind -ne $env:UPLINK_PATH_KIND)
  if (($had -ne ($env:UPLINK_PATH_HAD -eq '1')) -or ($now -cne [string]$env:UPLINK_PATH_BEFORE) -or $kindChanged) {
    throw 'Your PATH changed while the app was reading it. Try again.'
  }
  $key.SetValue('Path', $env:UPLINK_PATH_AFTER, [Microsoft.Win32.RegistryValueKind]$env:UPLINK_PATH_KIND)
} finally { $key.Close() }
if (-not ('UplinkRoom.Environment' -as [Type])) {
  Add-Type -Namespace UplinkRoom -Name Environment -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
}
$result = [UIntPtr]::Zero
# HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, at most 5 seconds.
[UplinkRoom.Environment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
`;

export type WindowsPaths = { user: string | null; userKind?: PathKind | null; machine: string | null; machineKind?: PathKind | null };

async function readWindowsPaths(d: BridgeCliDeps): Promise<WindowsPaths> {
  const parsed = JSON.parse((await d.powershell(READ_PATHS_SCRIPT, { UPLINK_ENV_KEY: d.envKey })).trim()) as Partial<WindowsPaths>;
  return {
    user: parsed.user ?? null,
    userKind: parsed.userKind ?? null,
    machine: parsed.machine ?? null,
    machineKind: parsed.machineKind ?? null,
  };
}

/** The extensions cmd and PowerShell run without being typed, in Windows' default PATHEXT order. */
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

export async function windowsStatus(d: BridgeCliDeps, paths: WindowsPaths, name: AppCommand = NAME): Promise<BridgeCli> {
  const dir = win32.dirname(d.launcher);
  const ours = windowsKey(dir);
  const launcher = launcherFor(d, name);
  const base = { platform: d.platform, launcher };
  // Windows builds a program's PATH from the system's folders, then the user's, each value
  // expanded first if its registry type says so.
  const folders = [
    ...windowsFolders(paths.machine, paths.machineKind, d.env).map((folder) => ({ folder, system: true })),
    ...windowsFolders(paths.user, paths.userKind, d.env).map((folder) => ({ folder, system: false })),
  ];
  // A folder not named in full is searched from the folder PowerShell is in (CommandPathSearch),
  // so nothing after it is certain, as on macOS and Linux.
  let relativeFirst = false;
  for (const { folder, system } of folders) {
    if (!isFullyQualifiedWindows(folder)) {
      relativeFirst = true;
      continue;
    }
    if (windowsKey(folder) === ours) {
      return relativeFirst
        ? { ...base, state: "ours", found: launcher, runs: true, relativeFirst: true, command: d.command(false) }
        : { ...base, state: "ours", found: launcher, runs: true, command: d.command(true) };
    }
    for (const ext of RUNNABLE) {
      const path = win32.join(folder, name + ext);
      if (!(await d.exists(path))) continue;
      return {
        ...base,
        state: isAppLauncherDir(folder) ? "stale" : "other",
        found: path,
        runs: true,
        command: d.command(false),
        // The system's PATH comes first and needs an administrator; the app changes only the user's.
        install: system ? { kind: "none", why: "shadowed" } : { kind: "user-path", at: dir },
      };
    }
  }
  return { ...base, state: "missing", command: d.command(false), install: { kind: "user-path", at: dir } };
}

async function windowsInstall(d: BridgeCliDeps): Promise<void> {
  const paths = await readWindowsPaths(d);
  // The type it has, or Windows' own for a user PATH when there's none yet.
  const kind = paths.user === null ? "ExpandString" : (paths.userKind ?? "ExpandString");
  if (kind !== "ExpandString" && kind !== "String") throw new Error(`Your PATH is stored as ${kind}, which the app doesn't change.`);
  // Another copy's launcher folder leaves the PATH only when its launcher is gone.
  const dead = new Set<string>();
  for (const entry of launcherDirEntries(paths.user)) {
    if (!(await d.exists(win32.join(entry.trim().replace(/^"(.*)"$/, "$1"), `${NAME}.cmd`)))) dead.add(windowsKey(entry));
  }
  await d.powershell(WRITE_PATH_SCRIPT, {
    UPLINK_ENV_KEY: d.envKey,
    UPLINK_PATH_HAD: paths.user === null ? "0" : "1",
    UPLINK_PATH_BEFORE: paths.user ?? "",
    UPLINK_PATH_KIND: kind,
    UPLINK_PATH_AFTER: withLauncherFirst(paths.user, win32.dirname(d.launcher), dead),
  });
}

const PS_ERROR = "__uplink_room_error__";

/** The script as runPowerShell sends it: UTF-8 output, and a failure's message on stdout after a marker. */
export function wrapPowerShell(script: string): string {
  return [
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    "try {",
    script,
    "} catch {",
    `  [Console]::Out.Write('${PS_ERROR}' + $_.Exception.Message)`,
    "  exit 1",
    "}",
  ].join("\n");
}

/**
 * Runs a script in Windows PowerShell, which every Windows 10 and 11 has, without the person's
 * profile. A failure's message comes back on stdout after a marker: with -EncodedCommand and a
 * redirected stderr, Windows PowerShell writes its error records there as CLIXML
 * (PowerShell/PowerShell#5912), not as text.
 */
export function runPowerShell(script: string, extra: Record<string, string>, timeoutMs = 30_000): Promise<string> {
  const exe = win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(wrapPowerShell(script), "utf16le").toString("base64");
  return new Promise((done, fail) => {
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      env: { ...process.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    // Read and dropped, so a full pipe can't stall the script.
    child.stderr.resume();
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return done(out);
      const at = out.indexOf(PS_ERROR);
      fail(new Error(at >= 0 ? out.slice(at + PS_ERROR.length).trim() : `PowerShell exited with ${code}`));
    });
  });
}

/** Runs AppleScript with arguments through /usr/bin/osascript. */
export function runOsascript(script: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("/usr/bin/osascript", ["-e", script, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.once("error", fail);
    child.once("close", (code) => (code === 0 ? done() : fail(new Error(err.trim() || `osascript exited with ${code}`))));
  });
}
