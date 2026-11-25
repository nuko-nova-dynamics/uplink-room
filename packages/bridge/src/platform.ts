import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, win32 } from "node:path";

/**
 * Everything the bridge does differently per operating system: the shell a
 * terminal runs in, how a command line is quoted for it, finding and starting
 * a tool's executable, and where the private socket lives.
 */

export type Platform = NodeJS.Platform;

/** How a terminal starts: the program, its arguments, and the name the room shows. */
export interface TerminalShell {
  file: string;
  /** A string is a ready-made Windows command line (node-pty passes it unchanged). */
  args: string[] | string;
  label: string;
}

type WindowsShell = "pwsh" | "powershell" | "cmd";

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Reads an environment variable the way Windows does, ignoring case. */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: Platform = process.platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Finds an executable the way the shell would. On Windows a bare name also
 * tries each PATHEXT extension (`t3` finds `t3.cmd`), and a name with a
 * directory is looked up as given.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string | undefined {
  const windows = platform === "win32";
  const hasDir = windows ? /[\\/]/.test(name) : name.includes("/");
  const extensions = windows
    ? ["", ...(envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const dirs = hasDir ? [""] : (envValue(env, "PATH", platform) ?? "").split(windows ? ";" : delimiter);
  for (const dir of dirs) {
    if (!hasDir && !dir) continue;
    for (const extension of extensions) {
      // On Windows a bare name with no extension is not runnable; it needs one from PATHEXT.
      if (windows && !extension && !extname(name)) continue;
      const candidate = (dir ? (windows ? win32.join(dir, name) : join(dir, name)) : name) + extension;
      if (!isFile(candidate)) continue;
      if (windows) return candidate;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

function windowsShellKind(file: string): WindowsShell {
  const name = basename(file.replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
  if (name === "cmd") return "cmd";
  if (name === "pwsh") return "pwsh";
  return "powershell";
}

/**
 * The Windows shell: `UPLINK_BRIDGE_SHELL` if set, else PowerShell 7 (`pwsh`)
 * when it's on PATH, else Windows PowerShell, else cmd.
 */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = envValue(env, "UPLINK_BRIDGE_SHELL", "win32");
  if (chosen) return resolveExecutable(chosen, env, "win32") ?? chosen;
  const pwsh = resolveExecutable("pwsh", env, "win32");
  if (pwsh) return pwsh;
  const root = envValue(env, "SystemRoot", "win32") ?? "C:\\Windows";
  const powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (isFile(powershell)) return powershell;
  return envValue(env, "ComSpec", "win32") ?? win32.join(root, "System32", "cmd.exe");
}

/**
 * PowerShell reports only 0 or 1 for `-Command` unless the script exits with
 * the native program's code, so the script passes that code on.
 */
function powershellScript(command: string) {
  return `${command}\n$uplinkOk = $?\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $uplinkOk) { exit 1 }\n`;
}

/**
 * The program a terminal runs. With a command, a shell runs that one command
 * (`/bin/sh -c` on macOS and Linux). Without one, it's the person's own
 * interactive shell (`$SHELL`, or PowerShell on Windows).
 *
 * `userShell` is for a command the room asked a plain shell to run (`runs.start` with harness
 * `shell` and a command): on macOS and Linux it runs in the person's own shell as a login and
 * interactive one (`$SHELL -l -i -c`), so it gets the PATH and version managers (fnm, nvm, asdf)
 * their startup files set up, the same as typing it into their terminal. A bridge started by the
 * desktop app has a GUI app's short PATH, where `/bin/sh -c npm test` may not find npm at all.
 */
export function terminalShell(
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
  options: { userShell?: boolean } = {},
): TerminalShell {
  if (platform !== "win32") {
    if (command !== undefined && options.userShell) {
      const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : "/bin/sh";
      return { file: shell, args: ["-l", "-i", "-c", command], label: command };
    }
    const label = command ?? env.SHELL ?? "/bin/sh";
    return { file: "/bin/sh", args: ["-c", label], label };
  }
  const shell = windowsShell(env);
  const kind = windowsShellKind(shell);
  if (command === undefined) return { file: shell, args: kind === "cmd" ? [] : ["-NoLogo"], label: basename(shell) };
  if (kind === "cmd") return { file: shell, args: `/d /s /c "${command}"`, label: command };
  // -EncodedCommand takes UTF-16LE base64, so no quoting can be lost between here and PowerShell.
  const encoded = Buffer.from(powershellScript(command), "utf16le").toString("base64");
  return {
    file: shell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    label: command,
  };
}

/**
 * A terminal's folder with a leading `~` as this machine's home: the room passes `cwd` as typed,
 * and no shell expands it before the terminal starts there.
 */
export function expandHome(cwd: string | undefined, home: string = homedir()): string | undefined {
  if (cwd === undefined) return undefined;
  if (cwd === "~") return home;
  if (cwd.startsWith("~/") || cwd.startsWith("~\\")) return join(home, cwd.slice(2));
  return cwd;
}

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * Every character PowerShell reads as a single quote: the apostrophe and ‘ ’ ‚ ‛ (U+2018 to U+201B,
 * `CharTraits.IsSingleQuote` in PowerShell's tokenizer). In a single-quoted string each is written
 * twice to stand for itself (learn.microsoft.com about_Quoting_Rules), so a path like
 * C:\Users\O’Brien can't end the string early.
 */
const POWERSHELL_SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

/** Quotes one argument for the shell `terminalShell` runs a command in. */
export function quoteArgument(word: string, env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): string {
  if (platform !== "win32") return `'${word.replaceAll("'", "'\\''")}'`;
  if (PLAIN_WORD.test(word)) return word;
  if (windowsShellKind(windowsShell(env)) === "cmd") return `"${word.replaceAll('"', '""')}"`;
  return `'${word.replace(POWERSHELL_SINGLE_QUOTES, (quote) => quote + quote)}'`;
}

/** Joins words into one command line for the shell `terminalShell` uses. */
export function quoteCommand(
  words: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string {
  if (platform !== "win32" || windowsShellKind(windowsShell(env)) === "cmd") return words.map((w) => quoteArgument(w, env, platform)).join(" ");
  const quoted = words.map((w) => quoteArgument(w, env, platform));
  // PowerShell runs a quoted program name only with the call operator.
  return quoted.length && quoted[0] !== words[0] ? `& ${quoted.join(" ")}` : quoted.join(" ");
}

function quoteCmdArgument(arg: string) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`;
}

/**
 * Starts a tool's executable. On Windows, `.cmd` and `.bat` files (how npm
 * installs CLIs) can only run through cmd.exe, so they go through it with
 * each argument quoted.
 */
export function spawnExecutable(
  executable: string,
  args: string[],
  options: SpawnOptions,
  platform: Platform = process.platform,
): ChildProcess {
  const env = options.env ?? process.env;
  const file = resolveExecutable(executable, env, platform) ?? executable;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteCmdArgument).join(" ");
    return spawn(envValue(env, "ComSpec", platform) ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, options);
}

/**
 * Where the bridge's private socket lives. On Windows it's a named pipe,
 * which only its user can write to. On macOS and Linux it's `bridge.sock` in
 * the bridge's home, or a short path in the temp folder when the home is too
 * deep for the Unix socket length limit (about 104 bytes on macOS, 108 on Linux).
 */
export function socketPathFor(home: string, platform: Platform = process.platform): string {
  const digest = createHash("sha256").update(home).digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\uplink-bridge-${digest}`;
  const preferred = join(home, "bridge.sock");
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  return join(tmpdir(), `uplink-bridge-${digest}.sock`);
}

/** Puts a folder first on PATH, matching Windows' case-insensitive PATH key. */
export function prependPath(
  env: NodeJS.ProcessEnv,
  dir: string | undefined,
  platform: Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!dir) return env;
  const key =
    platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const current = env[key];
  return { ...env, [key]: current ? `${dir}${platform === "win32" ? ";" : ":"}${current}` : dir };
}
