/**
 * The harness process a command runs under, for `uplink join` (ADR 0032): the joined run's keeper
 * ends the run when that process exits, only processes it started act as the session, and its
 * command line says how Claude Code was started (`--setting-sources`, the development channels
 * flag). Read with `ps` on macOS and Linux, and on Windows from one snapshot of the process list
 * (`Get-CimInstance Win32_Process`, through PowerShell).
 */
import { execFile, spawn } from "node:child_process";
import { readlink } from "node:fs/promises";

/**
 * A harness process: its command line, and the folder it runs in. For Claude Code that folder is the
 * session's primary working directory (it stays where Claude Code started while the Bash tool `cd`s).
 */
export type HarnessProcess = { pid: number; args: string; cwd?: string };

/** The folder a process runs in: `/proc` on Linux, `lsof` on macOS, unknown on Windows. */
async function processCwd(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return readlink(`/proc/${pid}/cwd`).catch(() => undefined);
  if (process.platform !== "darwin") return undefined;
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2000 }, (error, stdout) => {
      const line = error ? undefined : stdout.split("\n").find((l) => l.startsWith("n"));
      resolve(line ? line.slice(1) : undefined);
    });
  });
}

/** The program each harness runs as (packages/backend/convex/lib/harnesses.ts lists their commands). */
const PROGRAMS: Record<string, string[]> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  "grok-build": ["grok"],
  opencode: ["opencode"],
  cursor: ["cursor-agent"],
  "hermes-agent": ["hermes"],
};

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "cmd", "powershell", "pwsh"]);

/** At most this many parents are read, from this command up. */
const DEPTH = 16;

/** One process: its parent, program name (without `.exe`) and command line. */
export type ProcessInfo = { ppid: number; name: string; args: string };

/** Looks up a process by its id; undefined when it isn't running or can't be read. */
export type ProcessTable = (pid: number) => Promise<ProcessInfo | undefined>;

/** A path's last part, on either kind of separator, without a Windows program extension. */
function programName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.(exe|cmd|bat)$/i, "");
}

function ps(pid: number, field: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", `${field}=`, "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/** macOS and Linux: `ps`, one process at a time. */
const psTable: ProcessTable = async (pid) => {
  const line = await ps(pid, "ppid");
  const args = await ps(pid, "args");
  const comm = await ps(pid, "comm");
  if (!line || !args || !comm) return undefined;
  return { ppid: Number(line), name: programName(comm), args };
};

/** Every process's id, parent, name and command line, from Windows' WMI, as JSON. */
function windowsSnapshot(): Promise<string> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    // PowerShell can wait on its standard input: give it none.
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/**
 * Windows: the process list, read once (`snapshot`) and looked up in memory, since each PowerShell
 * start takes about a second. A process whose parent has exited keeps that parent's id, which
 * Windows may give a new process.
 */
export function windowsProcessTable(snapshot: () => Promise<string> = windowsSnapshot): ProcessTable {
  let rows: Promise<Map<number, ProcessInfo>> | undefined;
  return async (pid) => {
    rows ??= snapshot().then(
      (json) => {
        const map = new Map<number, ProcessInfo>();
        const parsed = JSON.parse(json || "[]") as unknown;
        for (const row of (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]) {
          if (typeof row?.ProcessId !== "number") continue;
          const name = typeof row.Name === "string" ? row.Name : "";
          map.set(row.ProcessId, {
            ppid: typeof row.ParentProcessId === "number" ? row.ParentProcessId : 0,
            name: programName(name),
            args: typeof row.CommandLine === "string" ? row.CommandLine : name,
          });
        }
        return map;
      },
      () => new Map(),
    );
    return (await rows).get(pid);
  };
}

/** The table for this platform. */
export function processTable(): ProcessTable {
  return process.platform === "win32" ? windowsProcessTable() : psTable;
}

/** The words of a command line, with quoted ones (Windows paths with spaces) kept whole. */
function words(args: string): string[] {
  return (args.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"|"$/g, ""));
}

/**
 * Whether a process runs a harness's program: as itself (`claude`, `claude.exe`, Codex's native
 * `codex-<target>.exe`), or as a Node script, an npm install's launcher (`claude.js`, `codex.js`).
 */
function runs(info: ProcessInfo, programs: string[]): boolean {
  if (programs.some((p) => info.name === p || info.name.startsWith(`${p}-`))) return true;
  return words(info.args)
    .slice(0, 3)
    .map(programName)
    .some((word) => programs.some((p) => word === p || word === `${p}.js`));
}

/**
 * The nearest process above this one that runs `harness`, else (for a harness this doesn't know)
 * the process that started this command's shell. Undefined when the process list can't say.
 */
export async function findHarnessProcess(harness: string, start = process.ppid, table: ProcessTable = processTable()): Promise<HarnessProcess | undefined> {
  const programs = PROGRAMS[harness] ?? [harness];
  let pid = start;
  let first: ({ pid: number } & ProcessInfo) | undefined;
  for (let depth = 0; depth < DEPTH && pid > 1; depth++) {
    const info = await table(pid);
    if (!info) break;
    first ??= { pid, ...info };
    if (runs(info, programs)) {
      const cwd = await processCwd(pid);
      return { pid, args: info.args, ...(cwd ? { cwd } : {}) };
    }
    pid = info.ppid;
  }
  if (PROGRAMS[harness] || !first) return undefined;
  // An agent this doesn't know: the process that ran the shell this command runs in.
  if (!SHELLS.has(first.name.replace(/^-/, ""))) return { pid: first.pid, args: first.args };
  const parent = await table(first.ppid);
  return parent ? { pid: first.ppid, args: parent.args } : undefined;
}

/** This process's parents, nearest first, for finding which joined session a command runs in. */
export async function ancestors(start = process.ppid, table?: ProcessTable): Promise<number[]> {
  // On macOS and Linux only the parent is needed: one `ps` a level, not three.
  const lookup = table ?? (process.platform === "win32" ? processTable() : undefined);
  const parentOf = lookup
    ? async (pid: number) => (await lookup(pid))?.ppid
    : async (pid: number) => {
        const line = await ps(pid, "ppid");
        return line ? Number(line) : undefined;
      };
  const found: number[] = [];
  let pid = start;
  for (let depth = 0; depth < DEPTH && pid > 1; depth++) {
    found.push(pid);
    const parent = await parentOf(pid);
    if (parent === undefined) break;
    pid = parent;
  }
  return found;
}

/** Whether a process is running. A process of another user (EPERM) is. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The values a Claude Code command line gives a flag, wherever it appears: `--flag a,b`, `--flag=a,b`,
 * or `--flag a b` (the words up to the next option), split on commas. Undefined when it isn't there.
 */
function flagValues(args: string, flag: string): string[] | undefined {
  const words = args.split(/\s+/).filter(Boolean);
  let found: string[] | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith(`${flag}=`)) {
      (found ??= []).push(word.slice(flag.length + 1));
    } else if (word === flag) {
      found ??= [];
      while (i + 1 < words.length && !words[i + 1]!.startsWith("-")) found.push(words[++i]!);
    }
  }
  return found?.flatMap((value) => value.split(",")).map((s) => s.trim()).filter(Boolean);
}

/**
 * What a Claude Code command line says about where it reads settings and channels:
 * `--setting-sources` (undefined: every source, the default), the development channels it loads
 * (`--dangerously-load-development-channels server:… plugin:…`, which a custom channel needs during
 * the research preview, code.claude.com/docs/en/channels-reference), and its MCP config
 * (`--mcp-config`, `--strict-mcp-config`), which names the servers those entries refer to.
 */
export function claudeLaunch(args: string): { settingSources?: string[]; devChannels: string[]; mcpConfigs: string[]; strictMcp: boolean } {
  const settingSources = flagValues(args, "--setting-sources");
  return {
    ...(settingSources ? { settingSources } : {}),
    devChannels: flagValues(args, "--dangerously-load-development-channels") ?? [],
    mcpConfigs: flagValues(args, "--mcp-config") ?? [],
    strictMcp: /(?:^|\s)--strict-mcp-config(?:\s|$)/.test(args),
  };
}
