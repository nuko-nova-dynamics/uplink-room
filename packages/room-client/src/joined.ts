/**
 * What `uplink join` keeps on this computer for each session that joined (ADR 0032), in
 * `$UPLINK_HOME/joined/` (default `~/.uplink-room/joined/`), each file mode 0600:
 *
 *   <key>.json     the join: the deployment, the run token, the run, and how the session hears
 *   <key>.turn     Claude Code's turn, from its hooks: working or idle, and the newest waiter's id
 *   <key>.waiting  how many messages wait, from the keeper's live watch of `joined.waiting`
 *   <key>.keeper   the keeper's process id
 *
 * The key is the harness and its session id, which Claude Code gives its Bash tool and hooks
 * (`CLAUDE_CODE_SESSION_ID`, the hooks' `session_id`) and Codex its commands (`CODEX_THREAD_ID`).
 * The run token is the only credential here: the person's sign-in stays in cli.json, and the
 * hooks and commands in the session use only the run token (ADR 0029 D8).
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, type Env } from "./config.ts";
import { replaceFile } from "./files.ts";

export type Hearing = "mid_task" | "between_turns" | "none";

/** How the session hears messages: Claude Code hooks, a Claude Code channel, Codex's app server, or `uplink inbox`. */
export type Via = "hooks" | "channel" | "codex" | "inbox";

export type JoinedSession = {
  url: string;
  token: string;
  /** With a team: its run there. A session that joined in no team has none, and can only pair (D13). */
  runId?: string;
  label: string;
  teamId?: string;
  team?: string;
  harness: string;
  sessionRef: string;
  hearing: Hearing;
  via: Via;
  heartbeatMs: number;
  /** The harness process: the run ends when it exits. */
  harnessPid?: number;
  /** The Claude Code settings file that holds the hooks this join added, the hooks, and whether the join made the file. */
  hooks?: { file: string; created: boolean; block: Record<string, unknown[]> };
  /** For Codex: its home, where its app server's control socket is. */
  codexHome?: string;
  joinedAt: number;
};

export type Turn = { turn: "working" | "idle"; waiterId?: string };

export function joinedDir(env: Env): string {
  return join(env.UPLINK_HOME || join(homedir(), ".uplink-room"), "joined");
}

/** A session's key: its harness and its session id, safe as a file name. */
export function sessionKey(harness: string, sessionRef: string): string {
  return `${harness}-${sessionRef.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160)}`;
}

function path(env: Env, key: string, kind: "json" | "turn" | "waiting" | "keeper"): string {
  return join(joinedDir(env), `${key}.${kind}`);
}

/** Writes a file whole (a temporary file, then a rename), mode 0600, so a reader never sees half of it. */
async function writePrivate(file: string, text: string): Promise<void> {
  await replaceFile(file, text, { mode: 0o600 });
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function saveJoined(env: Env, session: JoinedSession): Promise<string> {
  await mkdir(joinedDir(env), { recursive: true, mode: 0o700 });
  const key = sessionKey(session.harness, session.sessionRef);
  await writePrivate(path(env, key, "json"), `${JSON.stringify(session, null, 2)}\n`);
  return key;
}

export async function readJoined(env: Env, key: string): Promise<JoinedSession | undefined> {
  const text = await readText(path(env, key, "json"));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as JoinedSession;
    return typeof parsed.token === "string" && typeof parsed.url === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every session that joined from this computer and hasn't left, with its key. */
export async function listJoined(env: Env): Promise<{ key: string; session: JoinedSession }[]> {
  let names: string[];
  try {
    names = await readdir(joinedDir(env));
  } catch {
    return [];
  }
  const found: { key: string; session: JoinedSession }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -".json".length);
    const session = await readJoined(env, key);
    if (session) found.push({ key, session });
  }
  return found;
}

export async function readTurn(env: Env, key: string): Promise<Turn> {
  const text = await readText(path(env, key, "turn"));
  try {
    const parsed = text ? (JSON.parse(text) as Turn) : undefined;
    if (parsed && (parsed.turn === "working" || parsed.turn === "idle")) return parsed;
  } catch {
    // A missing or unreadable turn file: the session joined mid-turn.
  }
  return { turn: "working" };
}

export async function writeTurn(env: Env, key: string, turn: Turn): Promise<void> {
  await mkdir(joinedDir(env), { recursive: true, mode: 0o700 });
  await writePrivate(path(env, key, "turn"), JSON.stringify(turn));
}

/** How many messages wait, as the keeper last heard; undefined when the keeper hasn't said. */
export async function readWaiting(env: Env, key: string): Promise<number | undefined> {
  const text = await readText(path(env, key, "waiting"));
  const n = text === undefined ? NaN : Number(text);
  return Number.isFinite(n) ? n : undefined;
}

export async function writeWaiting(env: Env, key: string, waiting: number): Promise<void> {
  await writePrivate(path(env, key, "waiting"), String(waiting));
}

export async function readKeeperPid(env: Env, key: string): Promise<number | undefined> {
  const n = Number(await readText(path(env, key, "keeper")));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function writeKeeperPid(env: Env, key: string, pid: number): Promise<void> {
  await writePrivate(path(env, key, "keeper"), String(pid));
}

/** Forgets a session's files. */
export async function removeJoinedFiles(env: Env, key: string): Promise<void> {
  for (const kind of ["json", "turn", "waiting", "keeper"] as const) await rm(path(env, key, kind), { force: true });
}

/** The session a command runs in, from the harness's own variable: Claude Code's or Codex's. */
export function sessionFromEnv(env: Env): { harness: string; sessionRef: string } | undefined {
  if (env.CLAUDE_CODE_SESSION_ID) return { harness: "claude-code", sessionRef: env.CLAUDE_CODE_SESSION_ID };
  if (env.CODEX_THREAD_ID) return { harness: "codex", sessionRef: env.CODEX_THREAD_ID };
  return undefined;
}

/**
 * Whether this process was started from the harness process the session joined from: that process
 * is among its parents. The harness's variables (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID) and a hook's
 * `session_id` only name a session, and any program of the same person can set them; the parent
 * chain comes from the system. What's left: a process the harness started, such as a command the
 * agent runs, can act as the session. A join that found no harness process (`harnessPid` unset) is
 * taken by its name alone.
 */
export async function startedFromHarness(session: JoinedSession, parents: () => Promise<number[]>): Promise<boolean> {
  if (session.harnessPid === undefined || process.ppid === session.harnessPid) return true;
  return (await parents()).includes(session.harnessPid);
}

/**
 * The joined session a command runs in: by the harness's variable, else the one whose harness
 * process is a parent of this command (an agent `uplink join --harness` knew by its process). A
 * session named by the variable answers only a process started from its harness.
 */
export async function currentJoined(env: Env, parents: () => Promise<number[]>): Promise<{ key: string; session: JoinedSession } | undefined> {
  const fromEnv = sessionFromEnv(env);
  if (fromEnv) {
    const key = sessionKey(fromEnv.harness, fromEnv.sessionRef);
    const session = await readJoined(env, key);
    if (session && !(await startedFromHarness(session, parents))) {
      throw new CliError(
        "not_joined",
        `${session.label} joined from process ${session.harnessPid}, and this command wasn't started from it, so it can't act as that run. Run it in that session.`,
      );
    }
    return session ? { key, session } : undefined;
  }
  const all = await listJoined(env);
  const withPid = all.filter((entry) => entry.session.harnessPid !== undefined);
  if (!withPid.length) return undefined;
  const above = new Set(await parents());
  const matches = withPid.filter((entry) => above.has(entry.session.harnessPid!));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Where `uplink-mcp --channel` says it runs for a Claude Code session (`$UPLINK_HOME/channels/<session id>`),
 * so `uplink join` knows the session can hear through it.
 */
function channelFile(env: Env, sessionRef: string): string {
  return join(env.UPLINK_HOME || join(homedir(), ".uplink-room"), "channels", sessionRef.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160));
}

export async function announceChannel(env: Env, sessionRef: string, pid: number): Promise<void> {
  const file = channelFile(env, sessionRef);
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await writePrivate(file, String(pid));
}

export async function forgetChannel(env: Env, sessionRef: string): Promise<void> {
  await rm(channelFile(env, sessionRef), { force: true });
}

/** The pid of the `uplink-mcp --channel` that announced itself for this session, if it still runs. */
export async function announcedChannel(env: Env, sessionRef: string, running: (pid: number) => boolean): Promise<number | undefined> {
  const pid = Number(await readText(channelFile(env, sessionRef)));
  return Number.isInteger(pid) && pid > 0 && running(pid) ? pid : undefined;
}
