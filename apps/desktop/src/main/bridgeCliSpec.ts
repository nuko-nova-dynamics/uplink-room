/**
 * Whether `uplink-bridge` in a new terminal runs the bridge inside this app (main/bridgeCli.ts),
 * and how the app can put it there. Types and pure helpers, so the renderer, the gym and the tests
 * share them.
 *
 * - macOS: a link in /usr/local/bin, as VS Code's "Install 'code' command in PATH" makes. macOS
 *   asks for an administrator's password when the folder isn't writable.
 * - Windows: the app's `resources\bin` folder at the front of the user's PATH (HKCU), no
 *   administrator needed.
 * - Linux: the .deb links /usr/bin/uplink-bridge when it installs. The AppImage can't: its path
 *   changes on every launch.
 */

/**
 * What a new terminal runs for `uplink-bridge`:
 * - `ours`: this app's launcher.
 * - `missing`: nothing, and nothing is where the app would put it.
 * - `stale`: another copy of the app, or a link to a copy that is gone.
 * - `other`: something else: a different program, such as a bridge installed with npm, or a file,
 *   folder or link where the app would put its own, which the app never replaces.
 */
export type BridgeCliState = "ours" | "missing" | "stale" | "other";

/** Why the app can't put it on PATH itself. */
export type CantInstall =
  /** The AppImage's path changes on every launch. */
  | "appimage"
  /** Linux packages make the link when they install; the app doesn't run as root. */
  | "package"
  /** Another `uplink-bridge` comes earlier on PATH than where the app would put its own. */
  | "shadowed"
  /** The folder the app links into isn't on this terminal's PATH. */
  | "folder-not-on-path"
  /** Something that isn't Uplink Room's is where the app would put its link. */
  | "occupied";

export type BridgeCliInstall =
  /**
   * A link at `at`, made only where nothing is. `replaces`: the link already there, as it reads, when
   * it leads to another copy of Uplink Room; it's replaced only if it still reads the same.
   * `admin`: macOS asks for an administrator's password first.
   */
  | { kind: "link"; at: string; admin: boolean; replaces?: string }
  /** The launcher's folder `at` goes first in the user's PATH (Windows). */
  | { kind: "user-path"; at: string }
  | { kind: "none"; why: CantInstall; manual?: string };

export type BridgeCli = {
  platform: "darwin" | "win32" | "linux";
  state: BridgeCliState;
  /** What a new terminal finds: a link or launcher on PATH. Absent when `missing`. */
  found?: string;
  /** Where `found` leads, when it isn't this app's launcher. */
  target?: string;
  /** False when `found` doesn't run: a file that isn't executable, a folder, or a link to nothing. */
  runs?: boolean;
  /**
   * `ours`, but an empty or relative folder comes first on PATH, so what `uplink-bridge` runs depends
   * on the folder the terminal is in. `command` stays the launcher's full path.
   */
  relativeFirst?: boolean;
  /** This app's launcher. */
  launcher: string;
  /** The command for a terminal on this computer: `uplink-bridge` when it's ours, else the launcher's quoted path. */
  command: string;
  /** What Add to PATH does here, or why the app can't. Absent when it's ours. */
  install?: BridgeCliInstall;
  /**
   * `uplink` and `uplink-mcp`, read the same way (ADR 0042). Add to PATH puts every one of the three
   * that it can on PATH in one step. Absent where only the bridge was read.
   */
  tools?: ToolCli[];
};

/** `uplink` or `uplink-mcp` in a new terminal: the same facts as the bridge's, for its own launcher. */
export type ToolCli = Omit<BridgeCli, "platform" | "tools" | "command"> & { name: Exclude<AppCommand, "uplink-bridge"> };

/** Every command of the three that a new terminal runs from this app. */
export function allOnPath(s: BridgeCli): boolean {
  return [s, ...(s.tools ?? [])].every((c) => c.state === "ours" && !c.relativeFirst);
}

/** The commands the app carries in resources/bin and puts on PATH together (ADR 0042). */
export const APP_COMMANDS = ["uplink-bridge", "uplink", "uplink-mcp"] as const;
export type AppCommand = (typeof APP_COMMANDS)[number];

/** A launcher `name` inside some copy of Uplink Room (an older one, or one on a disk image), not another program. */
export function isAppLauncher(path: string, name: AppCommand = "uplink-bridge"): boolean {
  const file = name.replace(/-/g, "\\-");
  return (
    new RegExp(`[\\\\/]Uplink Room(?:\\.app[\\\\/]Contents)?[\\\\/]resources[\\\\/]bin[\\\\/]${file}(?:\\.cmd)?$`, "i").test(path) ||
    // An AppImage's mount, which moves on every launch.
    new RegExp(`/\\.mount_Uplink[^/]*/resources/bin/${file}$`).test(path)
  );
}

/** A Windows PATH entry naming some copy of Uplink Room's launcher folder. */
export function isAppLauncherDir(dir: string): boolean {
  return /[\\/]Uplink Room[\\/]resources[\\/]bin[\\/]*$/i.test(dir);
}

/** Expands `%NAME%` in a Windows PATH entry; Windows' variable names ignore case. Unknown names stay. */
export function expandWindows(value: string, env: Record<string, string | undefined>): string {
  const byName = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => byName.get(name.toLowerCase()) ?? whole);
}

/** One spelling for comparing Windows folders: unquoted, backslashes, no doubled or trailing ones, lower case. */
export function windowsKey(dir: string): string {
  return dir
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\//g, "\\")
    .replace(/(?!^)\\{2,}/g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

export function splitWindowsPath(value: string | null | undefined): string[] {
  return (value ?? "").split(";").filter((entry) => entry.trim() !== "");
}

/** The registry type of a PATH value, as .NET names it: `ExpandString` (REG_EXPAND_SZ) or `String` (REG_SZ). */
export type PathKind = "ExpandString" | "String" | (string & {});

/**
 * A PATH value's folders as PowerShell searches them (CommandDiscovery.GetLookupDirectoryPaths): an
 * expandable value (REG_EXPAND_SZ) is expanded first and split after, so a variable holding several
 * folders gives each of them; a plain one (REG_SZ) is taken literally, so `C:\%TOOLS%\bin` is a
 * folder with that name. Empty entries are skipped, as PowerShell's split does; one of only spaces
 * stays, trimmed to nothing, which is no folder at all but the current one.
 */
export function windowsFolders(raw: string | null | undefined, kind: PathKind | null | undefined, env: Record<string, string | undefined>): string[] {
  const value = kind === "ExpandString" ? expandWindows(raw ?? "", env) : (raw ?? "");
  return value
    .split(";")
    .filter((entry) => entry !== "")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"));
}

/**
 * A folder named in full: `C:\…` or a UNC path (`\\server\share`). Anything else (`tools`,
 * `.\tools`, `C:tools`, `\tools`, an empty name) is found from the folder PowerShell is in, so what
 * `uplink-bridge` runs depends on it.
 */
export function isFullyQualifiedWindows(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path);
}

/**
 * The user's PATH (its raw registry value) with `dir` first. Every entry stays as written, in order,
 * except two kinds of literal ones: `dir` itself, which moves to the front, and a folder that is
 * exactly a copy of Uplink Room's launcher folder and is in `dead` (its launcher is gone). An entry
 * holding a `%VAR%` is never removed, whatever it expands to: it may name other folders too.
 */
export function withLauncherFirst(raw: string | null, dir: string, dead: ReadonlySet<string>): string {
  const ours = windowsKey(dir);
  const kept = splitWindowsPath(raw).filter((entry) => {
    if (entry.includes("%")) return true;
    const key = windowsKey(entry);
    return key !== ours && !(isAppLauncherDir(entry) && dead.has(key));
  });
  return [dir, ...kept].join(";");
}

/** The user PATH's literal entries that name a copy of Uplink Room's launcher folder: the ones `withLauncherFirst` may drop if dead. */
export function launcherDirEntries(raw: string | null): string[] {
  return splitWindowsPath(raw).filter((entry) => !entry.includes("%") && isAppLauncherDir(entry));
}
