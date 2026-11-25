/**
 * The Claude Code hooks `uplink join` adds to a project's settings (ADR 0027, ADR 0032), so a session
 * that joined hears its messages with no bridge:
 *
 * - `PostToolUse` and `PostToolUseFailure` (matcher `*`) and `UserPromptSubmit`: hand the session its
 *   waiting messages as `additionalContext`, during its turn (#138 test 6).
 * - `Stop`, `StopFailure` and `SessionStart`: a waiter run with `asyncRewake`, which exits 2 with the
 *   messages when one comes while the session is idle, so Claude Code wakes it (#138 test 6).
 *   `StopFailure` fires instead of `Stop` when a turn ends in an API error; Claude Code ignores its
 *   output, but a waiter started from it still wakes the session (checked for the bridge with Claude
 *   Code 2.1.318, #144). Claude Code enforces
 *   a hook's `timeout` on an `asyncRewake` hook (600 seconds by default) and nothing starts another
 *   waiter until a turn ends, so the waiter's timeout is 7 days, as the bridge's is (PR #144: Claude
 *   Code 2.1.318 passes it to a JavaScript timer, whose limit is about 24.8 days).
 * - `SessionEnd`: ends the joined run, and takes these hooks out once no other joined session uses them.
 *
 * Each hook runs this `uplink` in exec form (`command` and `args`, no shell), with the session's run
 * token found by its `session_id`: no credential is written into the settings. Claude Code picks up
 * hooks added to a settings file mid-session ("Direct edits to hooks in settings files are normally
 * picked up automatically by the file watcher", code.claude.com/docs/en/hooks; #138 test 5).
 *
 * Which file: `.claude/settings.local.json`, the person's own settings for one project
 * (code.claude.com/docs/en/settings), at the repository root in a git repository (the main
 * checkout's, for a worktree) and otherwise in the session's primary working directory, the folder
 * Claude Code started in. A session started with `--setting-sources` that leaves out `local` doesn't
 * read that file, so then `.claude/settings.json` in its primary working directory if it reads
 * `project`, else no file and the run reads its inbox itself.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { replaceFile } from "./files.ts";
import { shQuote, type HookProgram } from "./self.ts";

/** How long an idle session's waiter waits, in seconds: 7 days, well under the timer's limit. */
export const WAITER_TIMEOUT_S = 7 * 24 * 60 * 60;
/** The other hooks answer at once; this only bounds a room that stopped answering. */
export const HOOK_TIMEOUT_S = 30;
/** SessionEnd hooks share a 1.5-second budget unless a hook sets a longer timeout (up to 60, code.claude.com/docs/en/hooks). */
export const SESSION_END_TIMEOUT_S = 10;

export type HookEvent = "post-tool-use" | "user-prompt-submit" | "stop" | "stop-failure" | "session-start" | "session-end";

/** The events `uplink hook claude <event>` takes. */
export const HOOK_EVENTS: HookEvent[] = ["post-tool-use", "user-prompt-submit", "stop", "stop-failure", "session-start", "session-end"];

type Hook = { type: "command"; command: string; args?: string[]; timeout: number; asyncRewake?: true };
type Group = { matcher?: string; hooks: Hook[] };
export type HooksBlock = Record<string, Group[]>;

/**
 * The hooks, each running `uplink` (`program`: the exact words that run this tool, such as node and
 * the CLI's path, or the app's launcher; self.ts `hookProgram`) with `hook claude <event>`. `home` is
 * UPLINK_HOME when set, so the hooks find the joined session there whatever environment Claude Code
 * passes them.
 */
export function claudeHooks(program: string[] | HookProgram, home?: string): HooksBlock {
  const run = Array.isArray(program) ? { exec: program } : program;
  const hook = (event: HookEvent, extra: Partial<Hook> = {}): Hook => {
    const words = ["hook", "claude", event, ...(home ? ["--home", home] : [])];
    const call =
      "exec" in run
        ? { command: run.exec[0]!, args: [...run.exec.slice(1), ...words] }
        : { command: [run.shell, ...words.map(shQuote)].join(" ") };
    return { type: "command", ...call, timeout: HOOK_TIMEOUT_S, ...extra };
  };
  const waiter = (event: HookEvent) => hook(event, { asyncRewake: true, timeout: WAITER_TIMEOUT_S });
  return {
    PostToolUse: [{ matcher: "*", hooks: [hook("post-tool-use")] }],
    PostToolUseFailure: [{ matcher: "*", hooks: [hook("post-tool-use")] }],
    UserPromptSubmit: [{ hooks: [hook("user-prompt-submit")] }],
    Stop: [{ hooks: [waiter("stop")] }],
    // A turn that ends in an API error fires StopFailure instead of Stop (code.claude.com/docs/en/hooks).
    StopFailure: [{ hooks: [waiter("stop-failure")] }],
    SessionStart: [{ hooks: [waiter("session-start")] }],
    SessionEnd: [{ hooks: [hook("session-end", { timeout: SESSION_END_TIMEOUT_S })] }],
  };
}

/** Only the SessionEnd hook, for a session that hears through a channel: it still ends the run. */
export function sessionEndOnly(block: HooksBlock): HooksBlock {
  return { SessionEnd: block.SessionEnd! };
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}

/**
 * The folder whose `.claude/settings.local.json` Claude Code reads for a session whose primary
 * working directory is `primary` (code.claude.com/docs/en/settings, "Where Claude Code keeps the
 * local file in a git repository"): the repository root in a git repository, the main checkout's
 * for a worktree; but the primary working directory outside a git repository, on Windows, when the
 * root is the home folder, or when the root, its `.git` or its `.claude` isn't owned by this user.
 */
export async function localSettingsRoot(primary: string): Promise<string> {
  if (process.platform === "win32") return primary;
  const common = await git(primary, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || basename(common) !== ".git") return primary;
  const root = dirname(common);
  if (root === homedir()) return primary;
  const uid = process.getuid?.();
  for (const entry of [root, common, join(root, ".claude")]) {
    const owner = await stat(entry).then(
      (s) => s.uid,
      () => undefined,
    );
    if (owner !== undefined && uid !== undefined && owner !== uid) return primary;
  }
  return root;
}

/**
 * The settings file the hooks go in, from the session's primary working directory and its
 * `--setting-sources` (undefined: all of them). Claude Code reads the shared `.claude/settings.json`
 * from the primary working directory itself, not the repository root (code.claude.com/docs/en/settings),
 * so a session started in a subfolder or a worktree has its own; the local file is placed by
 * `localSettingsRoot`.
 */
export async function settingsFileFor(primary: string, sources?: string[]): Promise<{ file: string; shared: boolean } | undefined> {
  if (!sources || sources.includes("local")) return { file: join(await localSettingsRoot(primary), ".claude", "settings.local.json"), shared: false };
  if (sources.includes("project")) return { file: join(primary, ".claude", "settings.json"), shared: true };
  return undefined;
}

async function readSettings(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} isn't a JSON object.`);
  return parsed as Record<string, unknown>;
}

/**
 * A local settings file this tool makes is one Claude Code didn't, so it isn't kept out of git
 * for it ("if you create the file by hand, add it to .gitignore yourself", code.claude.com/docs/en/settings):
 * it goes in the repository's own exclude file, which is never committed.
 */
async function keepOutOfGit(file: string): Promise<void> {
  const dir = dirname(file);
  if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])) !== "true") return;
  const ignored = await new Promise<boolean>((resolve) => execFile("git", ["-C", dir, "check-ignore", "-q", file], (error) => resolve(!error)));
  if (ignored) return;
  const exclude = await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (!exclude) return;
  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(exclude, "\n# Added by uplink join: Claude Code's personal settings for this project\n**/.claude/settings.local.json\n");
}

/**
 * Adds `block`'s hooks to the settings file, beside whatever hooks it has, unless they're there
 * already (another session of this project joined). Returns whether this made the file.
 */
export async function addHooks(file: string, block: HooksBlock, opts: { local: boolean }): Promise<{ created: boolean }> {
  const settings = await readSettings(file);
  const created = settings === undefined;
  const next: Record<string, unknown> = { ...settings };
  const hooks: Record<string, Group[]> = { ...(next.hooks as Record<string, Group[]> | undefined) };
  let changed = created;
  for (const [event, groups] of Object.entries(block)) {
    const list = [...(hooks[event] ?? [])];
    for (const group of groups) {
      if (list.some((existing) => isDeepStrictEqual(existing, group))) continue;
      list.push(group);
      changed = true;
    }
    hooks[event] = list;
  }
  if (!changed) return { created: false };
  next.hooks = hooks;
  await writeSettings(file, next);
  if (created && opts.local) await keepOutOfGit(file);
  return { created };
}

/**
 * Writes a settings file whole (a temporary file, then a rename), so Claude Code's file watcher
 * never reads half of it, keeping the mode the file had. Callers hold its lock (joinedHooks.ts).
 */
async function writeSettings(file: string, settings: Record<string, unknown>): Promise<void> {
  const mode = await stat(file).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  await replaceFile(file, `${JSON.stringify(settings, null, 2)}\n`, mode === undefined ? {} : { mode });
}

/**
 * Takes `block`'s hooks out of the settings file, leaving every other setting and hook as it was.
 * A file this tool made and that holds nothing else is deleted.
 */
export async function removeHooks(file: string, block: HooksBlock, created: boolean): Promise<void> {
  const settings = await readSettings(file).catch(() => undefined);
  if (!settings) return;
  const hooks: Record<string, Group[]> = { ...(settings.hooks as Record<string, Group[]> | undefined) };
  for (const [event, groups] of Object.entries(block)) {
    if (!hooks[event]) continue;
    const left = hooks[event]!.filter((existing) => !groups.some((group) => isDeepStrictEqual(existing, group)));
    if (left.length) hooks[event] = left;
    else delete hooks[event];
  }
  const next: Record<string, unknown> = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  if (created && !Object.keys(next).length) {
    await rm(file, { force: true });
    return;
  }
  if (!isDeepStrictEqual(next, settings)) await writeSettings(file, next);
}
