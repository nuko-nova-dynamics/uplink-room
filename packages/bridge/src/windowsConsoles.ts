/**
 * Windows console hosts the bridge's terminals leave behind (#66).
 *
 * node-pty can't close a ConPTY console once its shell has exited (microsoft/node-pty#965), so the
 * terminal's `conhost.exe --headless` stays until the bridge exits, and when the bridge dies with
 * terminals open it can stay after that too. The bridge ends those console hosts itself, through a
 * holder process of their own (`CONSOLE_HOLDER_SCRIPT`), separate from the one that holds shells
 * for tree kills (`Holder` in `terminal.ts`), and at a lower priority: its requests wait until no
 * kill is running and that holder is idle, so a slow scan here never delays or resets a stop.
 *
 * A console host is ended only when it is certainly the terminal's and nothing is attached to it.
 * Certainly the terminal's: right after the spawn, while the shell is alive, the holder asks Windows
 * which console host the shell's console has (`ProcessConsoleHostProcess`), checks that it is a
 * child of the bridge that started during the spawn, and records its pid and start time (`bind`).
 * Every later step requires exactly that process, and a terminal that couldn't be bound (its shell
 * was gone first, or the holder couldn't tell) is never cleaned up. A window of time alone isn't
 * enough: two terminals started within it can't be told apart once one console host has gone.
 * Ending a console host doesn't end the programs attached to it, the way closing the console would,
 * so ending one with a program still attached would leave that program running forever.
 * `GetConsoleProcessList` would list the console's processes, but it needs a process to attach
 * through, and an empty console has none. What makes an empty console certain is that a console
 * can only gain a process from a process already in it: once it is empty, it stays empty. So the
 * scan (`UplinkConsoles.Members`) may answer "empty" only when it has looked at every process that
 * could be in it, and answers "uncertain" whenever it couldn't: a process it can't open, one whose
 * pid now names another process, or one that exited after the scan began (it may have started
 * another). The kill runs the scan again right before it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellIdentity } from "./terminal.ts";

/** How long after node-pty reports a shell's exit the bridge looks for that terminal's console host. */
export const CONSOLE_END_DELAY_MS = 1000;
/**
 * How far a console host's, or a shell's, start time may fall outside Node's clock readings around
 * `pty.spawn`. node-pty starts both inside `pty.spawn`: in 230 terminals on sthopc20 and sthopc01
 * (#66, #82), every console host started 0 to 1496 ms into its spawn, and none outside it.
 */
export const CONSOLE_CLOCK_SLACK_MS = 100;
/** How long the console holder may take over one request (a scan, its first compile), from when it gets it. */
export const CONSOLE_REQUEST_MS = 30_000;
/** How many scans a console gets, the first right away and each later one twice as far apart. */
export const CONSOLE_SCAN_TRIES = 6;
/** The wait before the second scan. */
export const CONSOLE_RETRY_MS = 1000;
/** How often, and how long, a binding is asked again while the shell hasn't connected to its console yet. */
export const CONSOLE_BIND_RETRY_MS = 50;
export const CONSOLE_BIND_TRIES = 100;
/**
 * How long a console host that had to stay (something attached, or never certain) waits before it
 * is looked at again; each later wait is twice as long, up to `CONSOLE_RECHECK_MAX_MS`.
 */
export const CONSOLE_RECHECK_MS = 30_000;
export const CONSOLE_RECHECK_MAX_MS = 10 * 60_000;

/**
 * The console holder: Windows PowerShell 5.1, serving one request at a time over its stdin, like the
 * shell holder, and at the bridge's own priority like it too. Below it, on a machine busy at the
 * bridge's priority, Windows runs the holder only now and then, as a starved thread: a binding then
 * took up to 20 s, so a shell that exited sooner was never bound and its console host never ended.
 *  - `whoami <id>`: this account's SID (`user <id> <sid>`).
 *  - `bind <id> <shell>,<from>,<to>,<bridge>`: the console host of the shell with that pid, if the
 *    shell is alive and started between `from` and `to` (ms since 1970), and its console host is a
 *    child of `bridge` that started then too: `bound <id> <pid>:<created>` (FILETIME); `pending` while
 *    the shell is that process but its console host isn't one that matches yet (a starting process
 *    has none, or reports another, until it has connected); `unbound` once the shell isn't.
 *  - `hold <id> <pid>,<created>` holds exactly that process: `held`; `gone` if no process has that
 *    pid and start time; `denied` if one may but this account can't open it.
 *  - `scan <id> <shell>,<since>`: the processes attached to the held console host's console, as
 *    `pid:created` (FILETIME) separated by `;`, or `-` (`members`); `uncertain` when that can't be
 *    told for certain (see the module comment); `gone` once the console host has exited.
 *  - `end <id> <shell>,<since>` scans again and ends the held console host only if nothing is
 *    attached (`ended`); otherwise `attached` or `uncertain`.
 *  - `endmembers <id> <pid:created;...>` ends each listed process that still has that pid and start
 *    time and is still attached to the held console host's console (`endedmembers <id> <count>`).
 *  - `alive <id> <pid>,<before>`: whether a process with that pid started at or before `before`.
 *  - `release <id>` lets the held console host go.
 * Bind requests go to the front of the queue and don't wait for kills: the shell must still be alive.
 * The scan's candidates are the processes in the console host's session that started since the
 * terminal did and could descend from its shell: those whose chain of parents reaches the shell's
 * pid, or a parent that has exited (lineage unknown), without reaching a process older than the
 * terminal. A process attaches to a console only by inheriting it or by attaching through one of its
 * processes, which the scan doesn't cover for a process outside that lineage that attaches on
 * purpose. The process list comes from one `NtQuerySystemInformation` call (64-bit layout, checked
 * against this process's own entry before first use); a process that exits during it can't hide a
 * process it started, since a process it started is listed, or exits, or makes the scan uncertain.
 */
export const CONSOLE_HOLDER_SCRIPT = `$ErrorActionPreference = 'Stop'
$held = @{}
$ready = $null
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class UplinkConsoles {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int returned);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern void GetSystemTimeAsFileTime(out long now);
  const int QueryLimited = 0x1000;
  const int Terminate = 0x0001;
  struct Entry { public int Pid; public int Parent; public long Created; public int Session; }

  // Every process: pid, parent pid, start time (FILETIME) and session, from SYSTEM_PROCESS_INFORMATION.
  static List<Entry> Snapshot() {
    if (IntPtr.Size != 8) throw new PlatformNotSupportedException();
    int size = 1 << 20;
    for (int attempt = 0; attempt < 8; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int returned;
        int status = NtQuerySystemInformation(5, buffer, size, out returned);
        if (status == unchecked((int)0xC0000004)) { size = Math.Max(size * 2, returned + 65536); continue; }
        if (status != 0) throw new InvalidOperationException("NtQuerySystemInformation " + status);
        List<Entry> list = new List<Entry>();
        long at = buffer.ToInt64();
        while (true) {
          IntPtr p = new IntPtr(at);
          Entry e;
          e.Created = Marshal.ReadInt64(p, 32);
          e.Pid = (int)Marshal.ReadInt64(p, 80);
          e.Parent = (int)Marshal.ReadInt64(p, 88);
          e.Session = Marshal.ReadInt32(p, 100);
          list.Add(e);
          int next = Marshal.ReadInt32(p, 0);
          if (next == 0) break;
          at += next;
        }
        return list;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("the process list kept growing");
  }

  static bool Times(IntPtr h, out long created, out long exited) {
    long kernel, user;
    return GetProcessTimes(h, out created, out exited, out kernel, out user);
  }

  // A held process's start time (FILETIME), or 0.
  public static long Created(IntPtr h) {
    long created, exited;
    return Times(h, out created, out exited) ? created : 0;
  }

  // The console host of the shell with this pid: "pid:created", if the shell is alive and started
  // between from and to, and its console host is a child of bridge that started between them too.
  // "" while the shell is that process but its console host isn't (yet) one that matches: as a new
  // process starts, Windows reports no console host, or another one, until it has connected.
  public static string Bind(int shell, long from, long to, int bridge) {
    IntPtr h = OpenProcess(QueryLimited, false, shell);
    if (h == IntPtr.Zero) return null;
    try {
      long created, exited;
      if (!Times(h, out created, out exited) || exited != 0 || created < from || created > to) return null;
      IntPtr value;
      int returned;
      if (NtQueryInformationProcess(h, 49, out value, IntPtr.Size, out returned) != 0) return null;
      int host = (int)(value.ToInt64() & ~3L);
      if (host == 0) return "";
      IntPtr hh = OpenProcess(QueryLimited, false, host);
      if (hh == IntPtr.Zero) return "";
      try {
        long hostCreated, hostExited;
        if (!Times(hh, out hostCreated, out hostExited) || hostExited != 0 || hostCreated < from || hostCreated > to) return "";
        foreach (Entry e in Snapshot()) if (e.Pid == host) return e.Parent == bridge && e.Created == hostCreated ? host + ":" + hostCreated : "";
        return "";
      } finally { CloseHandle(hh); }
    } finally { CloseHandle(h); }
  }

  // Whether Snapshot reads this process's own start time and session as Windows reports them.
  public static bool SelfCheck() {
    Process me = Process.GetCurrentProcess();
    IntPtr h = OpenProcess(QueryLimited, false, me.Id);
    if (h == IntPtr.Zero) return false;
    long created, exited;
    bool ok = Times(h, out created, out exited);
    CloseHandle(h);
    if (!ok) return false;
    foreach (Entry e in Snapshot()) if (e.Pid == me.Id) return e.Created == created && e.Session == me.SessionId;
    return false;
  }

  static bool MayDescend(Entry e, Dictionary<int, Entry> byPid, int shell, long since) {
    for (int depth = 0; depth < 1024; depth++) {
      if (e.Parent == shell) return true;
      Entry parent;
      if (!byPid.TryGetValue(e.Parent, out parent) || parent.Created > e.Created) return true;
      if (parent.Created < since) return false;
      e = parent;
    }
    return true;
  }

  // The processes attached to host's console, as "pid:created;...", or null when that can't be told for certain.
  public static string Members(int host, long since, int shell) {
    long began;
    GetSystemTimeAsFileTime(out began);
    List<Entry> all = Snapshot();
    Dictionary<int, Entry> byPid = new Dictionary<int, Entry>();
    foreach (Entry e in all) byPid[e.Pid] = e;
    Entry hostEntry;
    if (!byPid.TryGetValue(host, out hostEntry)) return null;
    int self = Process.GetCurrentProcess().Id;
    List<string> members = new List<string>();
    foreach (Entry e in all) {
      if (e.Pid == 0 || e.Pid == host || e.Pid == self || e.Session != hostEntry.Session || e.Created < since) continue;
      if (!MayDescend(e, byPid, shell, since)) continue;
      IntPtr h = OpenProcess(QueryLimited, false, e.Pid);
      if (h == IntPtr.Zero) return null;
      try {
        long created, exited;
        if (!Times(h, out created, out exited) || created != e.Created) return null;
        if (exited != 0) { if (exited >= began) return null; continue; }
        IntPtr value;
        int returned;
        if (NtQueryInformationProcess(h, 49, out value, IntPtr.Size, out returned) != 0) return null;
        if ((value.ToInt64() & ~3L) == host) members.Add(e.Pid + ":" + e.Created);
      } finally { CloseHandle(h); }
    }
    return string.Join(";", members.ToArray());
  }

  // Ends each listed "pid:created" that still names that process and is still attached to host's console.
  public static int EndMembers(int host, string list) {
    int ended = 0;
    foreach (string item in list.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) {
      string[] parts = item.Split(':');
      int pid = int.Parse(parts[0]);
      long listed = long.Parse(parts[1]);
      IntPtr h = OpenProcess(QueryLimited | Terminate, false, pid);
      if (h == IntPtr.Zero) continue;
      try {
        long created, exited;
        IntPtr value;
        int returned;
        if (!Times(h, out created, out exited) || created != listed || exited != 0) continue;
        if (NtQueryInformationProcess(h, 49, out value, IntPtr.Size, out returned) != 0 || (value.ToInt64() & ~3L) != host) continue;
        if (TerminateProcess(h, 1)) ended++;
      } finally { CloseHandle(h); }
    }
    return ended;
  }
}
'@
function Ready {
  if ($null -eq $script:ready) {
    try { Add-Type -TypeDefinition $source; $script:ready = [UplinkConsoles]::SelfCheck() } catch { $script:ready = $false }
  }
  return $script:ready
}
function Ticks([long]$ms) { return $ms * 10000 + 116444736000000000 }
$null = Ready
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $verb, $id, $arg = $line.Split(' ')
  $answer = "done $id"
  try {
    if ($verb -eq 'whoami') {
      $answer = "user $id $([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"
    } elseif ($verb -eq 'bind') {
      $shell, $from, $to, $bridge = $arg.Split(',')
      $bound = if (Ready) { [UplinkConsoles]::Bind([int]$shell, (Ticks ([long]$from)), (Ticks ([long]$to)), [int]$bridge) } else { $null }
      $answer = if ($bound) { "bound $id $bound" } elseif ($null -ne $bound) { "pending $id" } else { "unbound $id" }
    } elseif ($verb -eq 'hold') {
      $other, $created = $arg.Split(',')
      try {
        $p = [System.Diagnostics.Process]::GetProcessById([int]$other)
        try { $handle = $p.Handle } catch { $p.Dispose(); $answer = "denied $id"; throw 'denied' }
        if (-not (Ready)) { $p.Dispose(); $answer = "denied $id" }
        elseif ("$([UplinkConsoles]::Created($handle))" -eq $created -and -not $p.HasExited) { $held[$id] = $p; $answer = "held $id" }
        else { $p.Dispose(); $answer = "gone $id" }
      } catch [System.ArgumentException] { $answer = "gone $id" } catch { if ($answer -ne "denied $id") { $answer = "denied $id" } }
    } elseif ($verb -eq 'scan' -or $verb -eq 'end') {
      $p = $held[$id]
      if (-not $p) { $answer = "unknown $id" }
      elseif ($p.HasExited) { $answer = "gone $id" }
      elseif (-not (Ready)) { $answer = "uncertain $id helper" }
      else {
        $shell, $since = $arg.Split(',')
        $members = [UplinkConsoles]::Members($p.Id, (Ticks ([long]$since)), [int]$shell)
        if ($null -eq $members) { $answer = "uncertain $id scan" }
        elseif ($verb -eq 'scan') { $answer = "members $id $(if ($members) { $members } else { '-' })" }
        elseif ($members) { $answer = "attached $id $members" }
        else { $p.Kill(); $answer = "ended $id $($p.Id)"; $p.Dispose(); $held.Remove($id) }
      }
    } elseif ($verb -eq 'endmembers') {
      $p = $held[$id]
      $count = if ($p -and (Ready)) { [UplinkConsoles]::EndMembers($p.Id, $arg) } else { 0 }
      $answer = "endedmembers $id $count"
    } elseif ($verb -eq 'alive') {
      $other, $before = $arg.Split(',')
      try {
        $q = [System.Diagnostics.Process]::GetProcessById([int]$other)
        try { $s = if (Ready) { [UplinkConsoles]::Created($q.Handle) } else { 0 } } finally { $q.Dispose() }
        $answer = if ($s -eq 0) { "alive $id unknown" } elseif ($s -le (Ticks ([long]$before))) { "alive $id yes" } else { "alive $id no" }
      } catch [System.ArgumentException] { $answer = "alive $id no" } catch { $answer = "alive $id unknown" }
    } elseif ($verb -eq 'release') {
      $p = $held[$id]
      if ($p) { $p.Dispose(); $held.Remove($id) }
    }
  } catch { $answer = "failed $id" }
  [Console]::Out.WriteLine($answer)
}`;

/** A console host, exactly: its pid and start time (FILETIME, as a string, past `Number`'s precision). */
export interface ConsoleHost {
  pid: number;
  created: string;
}
/** A terminal a bridge started: its shell's pid, the times around `pty.spawn` (ms since 1970), and its console host. */
export type RecordedTerminal = Pick<ShellIdentity, "pid" | "spawnStarted" | "spawnEnded"> & { conhost: ConsoleHost };
/** One bridge process's terminals, saved so a later bridge of the same user can end console hosts it left (#66). */
export interface ConsoleRecord {
  v: 2;
  /** The Windows account (SID) the bridge ran as. */
  user: string;
  pid: number;
  /** When this bridge process started (ms since 1970, `performance.timeOrigin`). */
  startedAt: number;
  terminals: RecordedTerminal[];
}

const sameTerminal = (a: Pick<ShellIdentity, "pid" | "spawnStarted">, b: Pick<ShellIdentity, "pid" | "spawnStarted">) =>
  a.pid === b.pid && a.spawnStarted === b.spawnStarted;

/**
 * A bridge's record of its bound Windows terminals: one small file per bridge process,
 * `<dir>/<user SID>.<pid>-<startedAt>.json`, written when a terminal is bound and when its console
 * host is gone, and deleted once none is left. Each bridge writes only its own file, and sweeps only
 * files of its own user, so bridges running at once, or as other users, never rewrite each other's.
 */
export class ConsoleRecords {
  private readonly dir: string;
  private readonly file: string;
  private readonly record: ConsoleRecord;
  constructor(dir: string, user: string, pid = process.pid, startedAt = Math.round(performance.timeOrigin)) {
    this.dir = dir;
    this.file = join(dir, ConsoleRecords.fileName(user, pid, startedAt));
    this.record = { v: 2, user, pid, startedAt, terminals: [] };
  }
  static fileName(user: string, pid: number, startedAt: number) {
    return `${user}.${pid}-${startedAt}.json`;
  }
  add(terminal: RecordedTerminal) {
    this.record.terminals.push({ pid: terminal.pid, spawnStarted: terminal.spawnStarted, spawnEnded: terminal.spawnEnded, conhost: terminal.conhost });
    writeRecord(this.dir, this.file, this.record, true);
  }
  remove(terminal: Pick<ShellIdentity, "pid" | "spawnStarted">) {
    const before = this.record.terminals.length;
    this.record.terminals = this.record.terminals.filter((t) => !sameTerminal(t, terminal));
    if (this.record.terminals.length !== before) writeRecord(this.dir, this.file, this.record, true);
  }
  /** Other bridges' records of `user` in `dir`, with the file each came from. */
  static others(dir: string, user: string, own: { pid: number; startedAt: number }): { file: string; record: ConsoleRecord }[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const found: { file: string; record: ConsoleRecord }[] = [];
    for (const name of names) {
      const match = /^(S-[0-9-]+)\.(\d+)-(\d+)\.json$/.exec(name);
      if (!match || match[1] !== user || (Number(match[2]) === own.pid && Number(match[3]) === own.startedAt)) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as ConsoleRecord;
        if (record.v === 2 && record.user === user && Number.isInteger(record.pid) && Array.isArray(record.terminals)) found.push({ file: join(dir, name), record });
      } catch {
        // A file being written, or not ours: left alone.
      }
    }
    return found;
  }
  /** Drops `terminal` from another bridge's record file, deleting the file once nothing is left. */
  static drop(file: string, terminal: Pick<ShellIdentity, "pid" | "spawnStarted">) {
    let record: ConsoleRecord;
    try {
      record = JSON.parse(readFileSync(file, "utf8")) as ConsoleRecord;
    } catch {
      return;
    }
    const terminals = record.terminals.filter((t) => !sameTerminal(t, terminal));
    if (terminals.length !== record.terminals.length) writeRecord(join(file, ".."), file, { ...record, terminals }, false);
  }
}

/** Writes or deletes a record file; `create` only for a bridge's own (another's is never recreated). */
function writeRecord(dir: string, file: string, record: ConsoleRecord, create: boolean) {
  try {
    if (!record.terminals.length) {
      unlinkSync(file);
      return;
    }
    if (create) mkdirSync(dir, { recursive: true });
    else if (!existsSync(file)) return;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record));
    renameSync(temporary, file);
  } catch {
    // Best effort: without the record, a console host this bridge leaves is only ended by Windows.
  }
}

export interface ConsoleCleanupOptions {
  /**
   * Sends one request to the console holder (see `CONSOLE_HOLDER_SCRIPT`); `first` puts it at the
   * front of the queue. A request that failed, in the holder process or in the script, answers
   * "timeout" or "failed", which counts as uncertain, never as a console host that is gone.
   */
  request: (verb: string, argument: string, id: string, first?: boolean) => Promise<string[]>;
  newId: () => string;
  /** Resolves when the console holder may work: no kill is running and the shell holder is idle. */
  turn: () => Promise<void>;
  /** The process that spawns this bridge's terminals, and so is their console hosts' parent. */
  bridgePid: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The first wait before a kept console host is looked at again (`CONSOLE_RECHECK_MS`); `Infinity` never. */
  recheckMs?: number;
}

/** What became of a terminal's console host. `unbound`: its console host was never known for certain, so it is left alone. */
export type ConsoleOutcome = "ended" | "gone" | "kept" | "unbound";

const terminalKey = (shell: Pick<ShellIdentity, "pid" | "spawnStarted">) => `${shell.pid}:${shell.spawnStarted}`;

/**
 * Ends terminals' leftover console hosts, one terminal at a time, after their shells exit (#66).
 * A terminal the bridge stopped also loses the programs still attached to its console: the tree
 * kill misses a program whose parent had already exited, and node-pty, which would have closed the
 * console with the programs in it, can't once the shell is gone. A terminal whose program exited on
 * its own keeps whatever is still attached, and so does its console host, until that has exited:
 * a console host that stays is looked at again `CONSOLE_RECHECK_MS` later, then less and less often,
 * for as long as the bridge runs. So is one kept by `sweep`.
 */
export class ConsoleCleanup {
  private readonly options: Required<ConsoleCleanupOptions>;
  private chain: Promise<unknown> = Promise.resolve();
  private recordsDir?: string;
  private records?: ConsoleRecords;
  private user?: Promise<string | undefined>;
  /** Each started terminal's binding, and how to tell it that node-pty has reported the shell's exit. */
  private readonly bindings = new Map<string, { conhost: Promise<ConsoleHost | undefined>; exited: () => void }>();
  /** Bound terminals whose console host isn't known to be gone, and whether each is in this bridge's record yet. */
  private readonly live = new Map<string, { terminal: RecordedTerminal; recorded: boolean }>();
  constructor(options: ConsoleCleanupOptions) {
    this.options = {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
      now: () => Date.now(),
      recheckMs: CONSOLE_RECHECK_MS,
      ...options,
    };
  }
  /** Records this bridge's bound terminals in `dir`, for `sweep` in a later bridge. */
  recordIn(dir: string) {
    this.recordsDir = dir;
  }
  /**
   * The Windows account this bridge runs as, from the holder; undefined if it couldn't say. Only an
   * answer is kept: after a failure, the next need asks again.
   */
  private whoami(): Promise<string | undefined> {
    if (!this.user) {
      const asked = this.options.request("whoami", "", this.options.newId(), true).then(([verb, , sid]) => (verb === "user" && sid?.startsWith("S-") ? sid : undefined));
      this.user = asked;
      void asked.then((sid) => {
        if (!sid && this.user === asked) this.user = undefined;
      });
    }
    return this.user;
  }
  private async ownRecords(): Promise<ConsoleRecords | undefined> {
    const dir = this.recordsDir;
    if (!dir) return undefined;
    if (!this.records) {
      const user = await this.whoami();
      if (user) this.records ??= new ConsoleRecords(dir, user, this.options.bridgePid);
    }
    return this.records;
  }
  /** Writes every bound terminal not yet in this bridge's record, once the record can be had. */
  private async recordLive() {
    const records = await this.ownRecords();
    if (!records) return;
    for (const entry of this.live.values()) {
      if (entry.recorded) continue;
      entry.recorded = true;
      records.add(entry.terminal);
    }
  }
  /** Binds a terminal that just started to its console host, while its shell is alive (see `bind` in `CONSOLE_HOLDER_SCRIPT`). */
  spawned(shell: ShellIdentity) {
    const window = `${shell.pid},${shell.spawnStarted - CONSOLE_CLOCK_SLACK_MS},${shell.spawnEnded + CONSOLE_CLOCK_SLACK_MS},${this.options.bridgePid}`;
    let exited = false;
    let reportExit = () => {};
    const exit = new Promise<void>((resolve) => {
      reportExit = () => {
        exited = true;
        resolve();
      };
    });
    const conhost = this.bind(window, () => exited, exit);
    const key = terminalKey(shell);
    this.bindings.set(key, { conhost, exited: reportExit });
    void conhost.then((host) => {
      if (!host) return;
      this.live.set(key, { terminal: { pid: shell.pid, spawnStarted: shell.spawnStarted, spawnEnded: shell.spawnEnded, conhost: host }, recorded: false });
      void this.recordLive();
    });
  }
  /**
   * Asks for a console host until the holder answers for certain or the shell's exit is reported.
   * `pending` (the shell hasn't connected yet) is asked again every `CONSOLE_BIND_RETRY_MS`. A
   * holder that failed or timed out is asked again `recheckMs` later, then less and less often.
   */
  private async bind(window: string, exited: () => boolean, exit: Promise<void>): Promise<ConsoleHost | undefined> {
    const { request, newId, sleep } = this.options;
    let pending = 0;
    let wait = this.options.recheckMs;
    while (!exited()) {
      const [verb, , found] = await request("bind", window, newId(), true);
      if (verb === "bound") {
        const match = /^(\d+):(\d+)$/.exec(found ?? "");
        return match ? { pid: Number(match[1]), created: match[2]! } : undefined;
      }
      // Unbound, for certain: the shell has exited, its pid names another process, or its console host
      // isn't the one this bridge started for it (or the helper can't tell on this Windows).
      if (verb === "unbound") return undefined;
      if (verb === "pending") {
        if (++pending >= CONSOLE_BIND_TRIES) return undefined;
        await Promise.race([sleep(CONSOLE_BIND_RETRY_MS), exit]);
        continue;
      }
      // The holder failed or timed out: that says nothing about the shell, so ask again while it runs.
      if (!Number.isFinite(wait)) return undefined;
      await Promise.race([sleep(wait), exit]);
      wait = Math.min(wait * 2, CONSOLE_RECHECK_MAX_MS);
    }
    return undefined;
  }
  /** Drops a terminal from this bridge's record once its console host is gone. */
  private async forget(key: string, terminal: RecordedTerminal) {
    const entry = this.live.get(key);
    this.live.delete(key);
    if (entry?.recorded) (await this.ownRecords())?.remove(terminal);
  }
  /**
   * Ends `shell`'s console host once nothing is attached to it; `stopped` ends what is attached
   * first. Resolves with the first look's outcome; one that stays is looked at again later.
   */
  async afterExit(shell: ShellIdentity, { stopped }: { stopped: boolean }): Promise<ConsoleOutcome> {
    const key = terminalKey(shell);
    const binding = this.bindings.get(key);
    this.bindings.delete(key);
    // A binding still asking stops now: once the shell has exited, its console host can't be bound for certain.
    binding?.exited();
    const conhost = await binding?.conhost;
    if (!conhost) return "unbound";
    const terminal = { pid: shell.pid, spawnStarted: shell.spawnStarted, spawnEnded: shell.spawnEnded, conhost };
    const forget = () => this.forget(key, terminal);
    const first = this.after(CONSOLE_END_DELAY_MS, () => this.clean(terminal, stopped));
    void first.then((outcome) => this.settle(terminal, stopped, outcome, this.options.recheckMs, forget));
    return first;
  }
  /** Once a console host is gone, `forget` drops its record; one kept is looked at again later. */
  private settle(terminal: RecordedTerminal, stopped: boolean, outcome: ConsoleOutcome, wait: number, forget: () => unknown) {
    if (outcome !== "kept") {
      void forget();
      return;
    }
    if (!Number.isFinite(wait)) return;
    void this.after(wait, () => this.clean(terminal, stopped)).then((next) =>
      this.settle(terminal, stopped, next, Math.min(wait * 2, CONSOLE_RECHECK_MAX_MS), forget),
    );
  }
  /** Runs `task` in this cleanup's queue, `ms` from now; the wait itself holds up nothing. */
  private async after<T>(ms: number, task: () => Promise<T>): Promise<T> {
    await this.options.sleep(ms);
    return this.enqueue(task);
  }
  /**
   * Ends the console hosts other bridges of this install and this Windows account left in `dir`
   * when they exited with terminals open: only the console host each record names exactly, once its
   * bridge has exited, and only with nothing attached. Nothing else is touched. One that stays (or
   * that this account can't open) keeps its record and is looked at again later, like `afterExit`'s.
   */
  sweep(dir: string): Promise<void> {
    return this.enqueue(async () => {
      const user = await this.whoami();
      if (!user) return;
      const own = { pid: this.options.bridgePid, startedAt: Math.round(performance.timeOrigin) };
      for (const { file, record } of ConsoleRecords.others(dir, user, own)) {
        if (!record.terminals.length || !(await this.exited(record))) continue;
        for (const terminal of record.terminals) {
          const outcome = await this.clean(terminal, false);
          this.settle(terminal, false, outcome, this.options.recheckMs, () => ConsoleRecords.drop(file, terminal));
        }
      }
    });
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => {});
    return run;
  }
  /** Whether the bridge that wrote `record` has exited: no process with its pid started before its first terminal. */
  private async exited(record: ConsoleRecord) {
    const first = Math.min(...record.terminals.map((t) => t.spawnStarted));
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await this.options.turn();
    const [verb, , answer] = await this.options.request("alive", `${record.pid},${first}`, this.options.newId());
    return verb === "alive" && answer === "no";
  }
  private async clean(terminal: RecordedTerminal, stopped: boolean): Promise<ConsoleOutcome> {
    const { request, newId, turn, sleep } = this.options;
    const id = newId();
    await turn();
    const [held] = await request("hold", `${terminal.conhost.pid},${terminal.conhost.created}`, id);
    // Gone: the script found no process with that pid and start time. Anything else but held (this
    // account can't open it, the holder failed or timed out): kept, never read as gone.
    if (held !== "held") return held === "gone" ? "gone" : "kept";
    const scan = `${terminal.pid},${terminal.spawnStarted - CONSOLE_CLOCK_SLACK_MS}`;
    try {
      for (let attempt = 0; attempt < CONSOLE_SCAN_TRIES; attempt++) {
        if (attempt > 0) await sleep(CONSOLE_RETRY_MS * 2 ** (attempt - 1));
        await turn();
        const [verb, , members] = await request("scan", scan, id);
        if (verb === "gone") return "gone";
        // Uncertain, or the holder failed: look again later, and keep it if it never becomes certain.
        if (verb !== "members") continue;
        if (members !== "-") {
          if (!stopped) return "kept";
          await turn();
          await request("endmembers", members ?? "", id);
          continue;
        }
        await turn();
        const [ended] = await request("end", scan, id);
        if (ended === "ended") return "ended";
        if (ended === "gone") return "gone";
      }
      return "kept";
    } finally {
      void request("release", "", id);
    }
  }
}
