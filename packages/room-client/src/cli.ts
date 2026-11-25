#!/usr/bin/env node
/**
 * The Room API as a command-line tool (ADR 0003).
 *
 *   uplink login --url <site url>                    (a person, in the browser: ADR 0030)
 *   uplink login --url <site url> --key <agent key>  (an agent)
 *   uplink whoami | uplink logout
 *   uplink functions
 *   uplink call <fn> [--args '<json>'] [key=value ...]
 *   uplink tasks create --title "Fix login"     (one subcommand per function)
 *
 * The per-function subcommands are built at run time from
 * `GET /api/v1/functions`, so a new Room API function needs no change here.
 * UPLINK_URL and UPLINK_AGENT_KEY override the saved config in
 * `$UPLINK_HOME/cli.json` (default `~/.uplink-room/cli.json`; src/config.ts).
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { onClosedOutput } from "@uplink-room/protocol/closedOutput";
import {
  isCliSignInToken,
  requireSecureUrl,
  RoomApiError,
  RoomClient,
  runInTerminal,
  waitForRuns,
  waitForTerminal,
  type JsonSchema,
  type RoomFunction,
  type RunInTerminalResult,
} from "./client.ts";
import {
  BUILT_IN_URL,
  CliError,
  configPath,
  readSavedConfig,
  roomCredentials,
  saveConfig,
  type SavedConfig,
  type UnrevokedSignIn,
} from "./config.ts";
import {
  installMcp,
  installSkill,
  MCP_HARNESS_NAMES,
  MCP_HARNESSES,
  SKILL_TARGET_NAMES,
  SKILL_TARGETS,
  type McpHarness,
  type Runner,
  type SkillTarget,
} from "./agentSetup.ts";
import { CLI_GUIDE } from "./guide.ts";
import { mcpProgram, shQuote, skillsSource } from "./self.ts";
import { addInboxCommand, addJoinCommands, HookExit, type JoinIo } from "./joinCommands.ts";
import { signInFromCli } from "./signIn.ts";

export { configPath } from "./config.ts";

export type CliIo = JoinIo & {
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Reads all of standard input, for `--stdin`. Defaults to `process.stdin`. */
  stdin?: () => Promise<string>;
  /** Opens a URL in the person's browser, for `uplink login`. Defaults to the system's opener. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Waits between polls of `uplink login --device`. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs a harness's own command, for `uplink mcp install`. Defaults to spawning it. */
  run?: Runner;
};

/**
 * Opens `url` in the default browser without a shell: `open` on macOS, the URL handler through
 * rundll32 on Windows, `xdg-open` elsewhere. If it can't, the link printed beside it still works.
 */
function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}


/** The list term of each generated function command, set when it's made. */
const SUBCOMMAND_TERMS = new WeakMap<Command, string>();

/** Commander's own term for a command in a list: its name, then [options] and its arguments. */
function defaultTerm(cmd: Command): string {
  const args = cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}${a.variadic ? "..." : ""}>` : `[${a.name()}${a.variadic ? "..." : ""}]`)).join(" ");
  return `${cmd.name()}${cmd.options.length ? " [options]" : ""}${args ? ` ${args}` : ""}`;
}

/** Command names that Room API functions can't take over. They stay reachable through `call`. */
const BUILTIN_COMMANDS = new Set([
  "login",
  "logout",
  "whoami",
  "functions",
  "call",
  "upload",
  "run-in-terminal",
  "wait-for-terminal",
  "wait-for-runs",
  "guide",
  "help",
  // A session that joins the room by itself (ADR 0032; joinCommands.ts).
  "join",
  "pair",
  "leave",
  "open",
  "close",
  "say",
  "reply",
  "download",
  "hook",
  "joined-keeper",
  // Setting up agent harnesses on this computer (ADR 0042; agentSetup.ts).
  "skills",
  "mcp",
]);
/** Flags every generated subcommand already has. */
const RESERVED_FLAGS = new Set(["json", "help", "args", "stdin"]);

/** --team-id for the built-in commands, worded as the team functions' teamId. */
const TEAM_ID_HELP = "the team: optional with an agent key, and with a sign-in when you're in one team (uplink whoami lists yours)";
const TERMINAL_TEAM_ID_HELP = `${TEAM_ID_HELP}; in several teams it's found from the terminal`;

function teamOption(teamId: string | undefined): { teamId?: string } {
  return teamId ? { teamId } : {};
}

// --- Values ---------------------------------------------------------------

/** Turns text from the command line into the value a function's schema expects. */
function coerceValue(schema: JsonSchema, raw: string): unknown {
  const type = schema.type;
  if (type === "string") return raw;
  if (type === "number" || type === "integer") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n))
      throw new Error(`expected a number, got "${raw}"`);
    return n;
  }
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`expected true or false, got "${raw}"`);
  }
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) return raw;
  return guessValue(raw, type === "array" || type === "object");
}

/** JSON when the text parses as JSON, else the text itself (unless JSON is required). */
function guessValue(raw: string, jsonRequired = false): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    if (jsonRequired) throw new Error(`expected JSON, got "${raw}"`);
    return raw;
  }
}

function parseArgsJson(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new CliError("usage", "--args must be a JSON object.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("usage", "--args must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Reads `key=value` pairs into `args`, converting each value with the function's schema. */
function applyPairs(args: Record<string, unknown>, pairs: string[], properties: Record<string, JsonSchema>): void {
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new CliError("usage", `Expected key=value or a --flag, got "${pair}". Run the command with --help for its flags.`);
    }
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    const schema = properties[key];
    try {
      args[key] = schema ? coerceValue(schema, raw) : guessValue(raw);
    } catch (error) {
      throw new CliError("usage", `${key}: ${(error as Error).message}`);
    }
  }
}

/**
 * How a function's command reads in its module's list: its required arguments as key=... pairs,
 * the optional ones that take one of a few values with those values, and how many more optional
 * ones there are. `uplink inbox --help` shows `get [view=mine|person|team]`.
 */
function argumentsHint(fn: RoomFunction): string {
  const required = requiredProperties(fn);
  const parts: string[] = [];
  let more = 0;
  for (const [name, schema] of Object.entries(inputProperties(fn))) {
    if (name === "teamId") continue;
    const values = Array.isArray(schema.enum) ? schema.enum.map(String) : undefined;
    const value = values && values.length <= 6 ? values.join("|") : schema.description?.toString().startsWith("A") && name.endsWith("Id") ? "ID" : "…";
    if (required.includes(name)) parts.push(`${name}=${value}`);
    else if (values && values.length <= 6) parts.push(`[${name}=${value}]`);
    else more++;
  }
  if (more) parts.push(`[+${more} more]`);
  return parts.join(" ");
}

/**
 * The command line run-in-terminal types. One argument is the command line as given, for the
 * machine's own shell to read (globs, pipes, $VAR). Several are each quoted for a POSIX shell (sh,
 * bash, zsh, fish), every word, so the shell reads none of them: not a glob, a ~, or zsh's =word.
 * `node -e "console.log('hello world')"` stays three arguments. Windows shells read that quoting
 * differently, so on a Windows machine pass the whole command as one argument.
 */
export function commandLine(words: string[]): string {
  if (words.length === 1) return words[0]!;
  return words.map((w) => `'${w.replaceAll("'", "'\\''")}'`).join(" ");
}

/** The first sentence of a description, at most 140 characters, for command lists. */
function firstSentence(text: string): string {
  const match = /^.+?[.!?](?=\s|$)/s.exec(text);
  const sentence = (match ? match[0] : text).replace(/\s+/g, " ").trim();
  if (sentence.length <= 140) return sentence;
  return `${sentence.slice(0, 139).replace(/\s+\S*$/, "")}…`;
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function inputProperties(fn: RoomFunction): Record<string, JsonSchema> {
  return (fn.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
}

function requiredProperties(fn: RoomFunction): string[] {
  const required = fn.inputSchema.required;
  return Array.isArray(required) ? (required as string[]).filter((p) => p !== "teamId") : [];
}

// --- Output ---------------------------------------------------------------

function renderResult(result: unknown, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  if (typeof result === "string") return `${result}\n`;
  if (result === null || result === undefined) return "ok\n";
  return `${JSON.stringify(result, null, 2)}\n`;
}

function renderFunctions(functions: RoomFunction[]): string {
  const rows = functions.map((f) => [f.name, f.kind, f.scope, f.description]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map(
      (r) =>
        `${r[0]!.padEnd(widths[0]!)}  ${r[1]!.padEnd(widths[1]!)}  ${r[2]!.padEnd(widths[2]!)}  ${r[3]}\n`,
    )
    .join("");
}

/** run-in-terminal and wait-for-terminal print the text, then how the wait ended. */
function renderTerminalResult(result: RunInTerminalResult, terminalId: string): string {
  const how =
    result.stopped === "ended"
      ? `The terminal ended${result.exitCode !== undefined ? ` with exit code ${result.exitCode}` : ""} (run ${result.runState ?? result.status}).`
      : result.stopped === "prompt"
        ? "The command finished: the shell's prompt is back."
        : `${result.hint ?? "The command may still be running."} On the command line: uplink terminals read terminalId=${terminalId} afterSeq=${result.cursor}${result.cursorOffset ? ` afterOffset=${result.cursorOffset}` : ""}`;
  return `${result.text}${result.text.endsWith("\n") || !result.text ? "" : "\n"}--\n${how}\n`;
}

// --- The tool -------------------------------------------------------------

/**
 * Runs the tool with `argv` (without the node and script paths) and returns
 * the exit code. Output goes through `io`, so tests can capture it.
 */
export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => void process.stderr.write(text));

  const program = new Command("uplink")
    .description("Do anything in Uplink Room from a shell, through the Room API.")
    .option("--json", "print raw JSON")
    .exitOverride()
    // Subcommands inherit this: `uplink tasks list` prints the tasks commands after its error.
    .showHelpAfterError()
    .configureOutput({ writeOut: out, writeErr: err })
    .addHelpText("after", `\n${CLI_GUIDE}\n`)
    // A function's line in its module's list shows its arguments (argumentsHint).
    .configureHelp({ subcommandTerm: (cmd) => SUBCOMMAND_TERMS.get(cmd) ?? defaultTerm(cmd) });
  const json = () => program.opts<{ json?: boolean }>().json === true;

  async function makeClient(): Promise<RoomClient> {
    const { url, key } = await roomCredentials(env);
    if (!url || !key) {
      throw new CliError(
        "not_configured",
        BUILT_IN_URL
          ? "Not signed in. Run `uplink login` to sign in as yourself, or `uplink login --key <agent key>` for an agent, or set UPLINK_AGENT_KEY."
          : "Not signed in. Run `uplink login --url <site url>` to sign in as yourself, or `uplink login --url <site url> --key <agent key>` for an agent, or set UPLINK_URL and UPLINK_AGENT_KEY.",
      );
    }
    return new RoomClient({ url, key, fetch: io.fetch });
  }

  async function callFunction(fn: string, args: Record<string, unknown>): Promise<void> {
    const result = await (await makeClient()).call(fn, args);
    out(renderResult(result, json()));
  }

  /** The site URL to log in to: --url, else UPLINK_URL, else the saved one. */
  function siteUrl(given: string | undefined, saved: string | undefined): string {
    const raw = given ?? env.UPLINK_URL ?? saved ?? BUILT_IN_URL;
    if (!raw) throw new CliError("usage", "Pass --url <site url>, the Convex deployment's site URL, such as https://<deployment>.convex.site.");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CliError("usage", `--url must be a URL such as http://127.0.0.1:3211, got "${raw}".`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new CliError("usage", "--url must start with http:// or https://.");
    }
    // A sign-in or key is about to go there (and be saved for it), so only over HTTPS or loopback.
    requireSecureUrl(raw);
    return raw.replace(/\/+$/, "");
  }

  /** Revokes a CLI sign-in this computer no longer keeps. Returns false when the room couldn't be told. */
  async function revokeSignIn(url: string, token: string): Promise<boolean> {
    try {
      await new RoomClient({ url, key: token, fetch: io.fetch }).call("people.revokeSignIn");
      return true;
    } catch (error) {
      // Already revoked or expired: nothing left to end.
      return error instanceof RoomApiError && error.code === "unauthenticated";
    }
  }

  /** Revokes each sign-in and returns the ones the room couldn't be told about. */
  async function revokeAll(signIns: UnrevokedSignIn[]): Promise<UnrevokedSignIn[]> {
    const left: UnrevokedSignIn[] = [];
    for (const entry of signIns) if (!(await revokeSignIn(entry.url, entry.signIn))) left.push(entry);
    return left;
  }

  function plural(n: number, what: string): string {
    return `${n} ${what}${n === 1 ? "" : "s"}`;
  }

  /**
   * Saves `next` over `saved` and revokes the sign-in it replaces. That sign-in stays in the file
   * (`unrevoked`) until the room confirms it's revoked, so a failure never loses it: the person is
   * told, and `uplink logout --pending` retries.
   */
  async function saveReplacing(saved: SavedConfig, next: SavedConfig): Promise<string> {
    const earlier = saved.unrevoked ?? [];
    const replaced = saved.signIn ? { url: saved.url ?? next.url!, signIn: saved.signIn } : undefined;
    const path = await saveConfig(env, { ...next, unrevoked: replaced ? [...earlier, replaced] : earlier });
    if (replaced) {
      if (await revokeSignIn(replaced.url, replaced.signIn)) {
        await saveConfig(env, { ...next, unrevoked: earlier });
      } else {
        err(
          `Warning: couldn't revoke the sign-in this one replaces, because ${replaced.url} didn't answer. It still works until it expires (at most 30 days). Run \`uplink logout --pending\` to revoke it.\n`,
        );
      }
    }
    return path;
  }

  program
    .command("guide")
    .description("Where an agent starts: the functions most work needs, and how they fit together")
    .action(() => out(`${CLI_GUIDE}\n`));

  program
    .command("login")
    .description(
      "Sign in as yourself in the browser (Clerk), and save this computer's sign-in for later commands and uplink-mcp. With --key, save an agent key instead",
    )
    .option("--url <site url>", `the Convex deployment's site URL (default: UPLINK_URL, or the one saved${BUILT_IN_URL ? `, else ${BUILT_IN_URL}` : ""})`)
    .option("--key <agent key>", "save an agent key instead of signing in as yourself")
    .option("--device", "sign in on another device with a code, for a computer with no browser")
    .option("--no-browser", "print the sign-in link instead of opening the browser")
    .option("--name <name>", "what to call this computer's sign-in (default: its host name)")
    .action(async (options: { url?: string; key?: string; device?: boolean; browser: boolean; name?: string }) => {
      const saved = await readSavedConfig(env);
      const url = siteUrl(options.url, saved.url);

      // A sign-in this computer is about to forget is revoked, so it can't outlive the file.
      if (options.key !== undefined) {
        const path = await saveReplacing(saved, { url, key: options.key });
        out(`Saved to ${path}\n`);
        return;
      }

      const result = await signInFromCli({
        url,
        fetch: io.fetch ?? ((input, init) => globalThis.fetch(input, init)),
        name: options.name?.trim() || hostname(),
        method: options.device ? "device" : "browser",
        ...(options.browser && !options.device ? { openBrowser: io.openBrowser ?? openInBrowser } : {}),
        say: err,
        ...(io.sleep ? { sleep: io.sleep } : {}),
      });
      const path = await saveReplacing(saved, { url, signIn: result.token });
      const { person, signInId, expiresAt } = result;
      out(
        json()
          ? `${JSON.stringify({ signInId, expiresAt, person })}\n`
          : `Signed in as ${person.name}${person.email ? ` (${person.email})` : ""}. This computer's sign-in lasts until ${day(expiresAt)}; \`uplink logout\` ends it.\nSaved to ${path}\n`,
      );
    });

  program
    .command("logout")
    .description(
      "Sign this computer out: revoke its sign-in in the room and forget it (or forget a saved agent key). Also revokes sign-ins it replaced but couldn't revoke then",
    )
    .option("--pending", "only revoke the sign-ins this computer replaced but couldn't revoke then, and stay signed in")
    .action(async (options: { pending?: boolean }) => {
      const saved = await readSavedConfig(env);
      const note = env.UPLINK_AGENT_KEY ? "\nUPLINK_AGENT_KEY is still set in this shell, and commands still use it." : "";
      const earlier = saved.unrevoked ?? [];
      const stillWork = (n: number) =>
        `${plural(n, "sign-in")} couldn't be revoked because the room didn't answer, and still work until they expire (at most 30 days). Run \`uplink logout --pending\` to try again.`;

      if (options.pending) {
        if (!earlier.length) return out("No replaced sign-ins are waiting to be revoked.\n");
        const left = await revokeAll(earlier);
        await saveConfig(env, { ...saved, unrevoked: left });
        if (left.length) throw new CliError("revoke_failed", `${left.length} of ${plural(earlier.length, "replaced sign-in")}: ${stillWork(left.length)}`);
        return out(`Revoked ${plural(earlier.length, "replaced sign-in")}.\n`);
      }

      if (!saved.signIn && !saved.key && !earlier.length) return out(`Not signed in on this computer.${note}\n`);
      let left = await revokeAll(earlier);
      const said: string[] = [];
      if (saved.signIn) {
        const told = saved.url ? await revokeSignIn(saved.url, saved.signIn) : false;
        if (!told && saved.url) left = [...left, { url: saved.url, signIn: saved.signIn }];
        said.push(told ? "Signed out: this computer's sign-in is revoked." : "Forgot this computer's sign-in.");
      } else if (saved.key) {
        said.push(`Removed the agent key from ${configPath(env)}. It still works wherever else it's used, until it's revoked in the app.`);
      }
      const revokedEarlier = earlier.length - left.filter((entry) => earlier.includes(entry)).length;
      if (revokedEarlier) said.push(`Revoked ${plural(revokedEarlier, "replaced sign-in")}.`);
      await saveConfig(env, { url: saved.url, unrevoked: left });
      if (left.length) throw new CliError("revoke_failed", `${said.join(" ")} But ${stillWork(left.length)}${note}`);
      out(`${said.join(" ")}${note}\n`);
    });

  program
    .command("whoami")
    .description("Who the saved sign-in or agent key acts as, and in which teams")
    .action(async () => {
      const client = await makeClient();
      if (isCliSignInToken(client.key)) {
        const me = (await client.call("people.me")) as {
          name: string;
          email?: string;
          teams: { teamId: string; name: string; role: string }[];
          signIn?: { name: string; expiresAt: number };
        };
        if (json()) return out(`${JSON.stringify(me)}\n`);
        const where = me.signIn ? `, signed in on this computer as "${me.signIn.name}" until ${day(me.signIn.expiresAt)}` : "";
        const teams = me.teams.length
          ? `Teams:\n${me.teams.map((t) => `  ${t.name} (${t.role}), teamId ${t.teamId}`).join("\n")}`
          : "No team yet. Account functions (uplink people ...) work; team functions need an invite to a team.";
        return out(`${me.name}${me.email ? ` (${me.email})` : ""}${where}.\n${teams}\n`);
      }
      const me = (await client.call("members.me")) as {
        name: string;
        kind: string;
        team: { name: string };
        addedBy?: { name: string };
        key?: { name: string };
        scopes?: { scope: string }[];
      };
      if (json()) return out(`${JSON.stringify(me)}\n`);
      const scopes = me.scopes ? ` Its scopes: ${me.scopes.map((s) => s.scope).join(", ")}.` : "";
      out(`${me.name}, ${me.kind === "agent" ? "an agent" : "a member"} in ${me.team.name}${me.addedBy ? `, added by ${me.addedBy.name}` : ""}.${me.key ? ` Agent key "${me.key.name}".` : ""}${scopes}\n`);
    });

  program
    .command("functions")
    .description("List the Room API functions: name, kind, scope and description")
    .action(async () => {
      const { functions } = await (await makeClient()).functions();
      out(json() ? `${JSON.stringify(functions)}\n` : renderFunctions(functions));
    });

  program
    .command("call <fn> [pairs...]")
    .description("Call any Room API function: uplink call tasks.create title='Fix login'")
    .option("--args <json>", "arguments as a JSON object; key=value pairs override it")
    .action(async (fn: string, pairs: string[], options: { args?: string }) => {
      const args = parseArgsJson(options.args);
      if (pairs.length > 0) {
        // The catalog tells us which values are strings and which are numbers.
        const properties = await (
          await makeClient()
        )
          .functions()
          .then((c) => c.functions.find((f) => f.name === fn))
          .then((f) => (f ? inputProperties(f) : {}))
          .catch(() => ({}) as Record<string, JsonSchema>);
        applyPairs(args, pairs, properties);
      }
      await callFunction(fn, args);
    });

  program
    .command("upload <file>")
    .description(
      "Upload a file to attach to a message. Prints { uploadId, storageId, name }: pass it in messages.post --attachments '[...]'",
    )
    .option("--name <name>", "the name to show (default: the file's own name)")
    .option("--type <content type>", "the content type (default: from the extension)")
    .option("--team-id <teamId>", TEAM_ID_HELP)
    .action(async (file: string, options: { name?: string; type?: string; teamId?: string }) => {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(file));
      } catch (error) {
        throw new CliError("usage", `Could not read ${file}: ${(error as Error).message}`);
      }
      const name = options.name ?? basename(file);
      const uploaded = await (await makeClient()).upload(bytes, name, options.type, teamOption(options.teamId));
      out(renderResult(uploaded, json()));
    });

  program
    .command("run-in-terminal <terminalId> <command...>")
    .description(
      "Run one command in a terminal you drive (from `uplink runs start --harness shell`) and print what it printed, as plain text. Waits until the terminal ends, the shell's prompt is back, the output is quiet for --idle-ms, or --wait-ms passes. The command's own flags pass through (uplink run-in-terminal ID node --version); put -- before a command that itself uses --json, --wait-ms, --idle-ms or --team-id. Several arguments are quoted for a POSIX shell (macOS, Linux), so each reaches the command as one: uplink run-in-terminal ID node -e \"console.log('hello world')\". To use the machine's shell features (globs, pipes, $VAR), or on a Windows machine, pass the whole command as one quoted argument: uplink run-in-terminal ID 'ls *.js | wc -l'. `exit 0` ends the shell and prints the run's state.",
    )
    .option("--wait-ms <ms>", "the longest to wait (default 30000, at most 600000)")
    .option("--idle-ms <ms>", "stop once the output has been quiet this long (default 2000)")
    .option("--team-id <teamId>", TERMINAL_TEAM_ID_HELP)
    // The command's own flags (node --version, ls -la) are part of it, not this tool's options.
    // Put -- before a command that itself uses --json, --wait-ms, --idle-ms or --team-id.
    .allowUnknownOption()
    .action(async (terminalId: string, words: string[], options: { waitMs?: string; idleMs?: string; teamId?: string }) => {
      const number = (raw: string | undefined, flag: string) => {
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new CliError("usage", `${flag} must be a number of milliseconds.`);
        return n;
      };
      const waitMs = number(options.waitMs, "--wait-ms");
      const idleMs = number(options.idleMs, "--idle-ms");
      const result = await runInTerminal(await makeClient(), {
        terminalId,
        command: commandLine(words),
        ...teamOption(options.teamId),
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(idleMs !== undefined ? { idleMs } : {}),
      });
      out(json() ? `${JSON.stringify(result)}\n` : renderTerminalResult(result, terminalId));
    });

  program
    .command("wait-for-terminal <terminalId>")
    .description(
      "Wait for a terminal to end, such as one `uplink runs start ... command=...` opened, and print everything it printed, as plain text, then its exit code.",
    )
    .option("--wait-ms <ms>", "the longest to wait (default 60000, at most 600000)")
    .option("--after-seq <seq>", "print only what came after this cursor")
    .option("--after-offset <offset>", "with --after-seq, the cursorOffset an earlier result returned")
    .option("--team-id <teamId>", TERMINAL_TEAM_ID_HELP)
    .action(async (terminalId: string, options: { waitMs?: string; afterSeq?: string; afterOffset?: string; teamId?: string }) => {
      const waitMs = options.waitMs === undefined ? undefined : Number(options.waitMs);
      const afterSeq = options.afterSeq === undefined ? undefined : Number(options.afterSeq);
      const afterOffset = options.afterOffset === undefined ? undefined : Number(options.afterOffset);
      if ([waitMs, afterSeq, afterOffset].some((n) => n !== undefined && !Number.isFinite(n))) {
        throw new CliError("usage", "--wait-ms, --after-seq and --after-offset take numbers.");
      }
      const result = await waitForTerminal(await makeClient(), {
        terminalId,
        ...teamOption(options.teamId),
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        ...(afterOffset !== undefined ? { afterOffset } : {}),
      });
      out(json() ? `${JSON.stringify(result)}\n` : renderTerminalResult(result, terminalId));
    });

  program
    .command("wait-for-runs [runIds...]")
    .description(
      "Wait until a run you follow changes state: the runs you drive or started, or the runIds you name. Prints the runs that changed and the cursor to wait from next time (--after).",
    )
    .option("--after <cursor>", "the cursor an earlier wait printed (default: wait from now)")
    .option("--wait-ms <ms>", "the longest to wait (default 50000, at most 600000)")
    .option("--team-id <teamId>", "the team, when you're in several")
    .action(async (runIds: string[], options: { after?: string; waitMs?: string; teamId?: string }) => {
      const after = options.after === undefined ? undefined : Number(options.after);
      const waitMs = options.waitMs === undefined ? undefined : Number(options.waitMs);
      if ([after, waitMs].some((n) => n !== undefined && !Number.isFinite(n))) throw new CliError("usage", "--after and --wait-ms take numbers.");
      const result = await waitForRuns(await makeClient(), {
        ...(runIds.length ? { runIds } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(options.teamId ? { teamId: options.teamId } : {}),
      });
      out(`${JSON.stringify(result, null, json() ? undefined : 2)}\n`);
    });

  // Setting up agent harnesses on this computer (ADR 0042). Neither needs a sign-in.
  const skills = program.command("skills").description("The uplink skill, which teaches an agent to join, pair and answer with this tool");
  skills
    .command("install")
    .description("Copy the uplink skill into Claude Code's and Codex's personal skills folders (~/.claude/skills, ~/.agents/skills), replacing an earlier copy")
    .option("--claude", "only for Claude Code")
    .option("--codex", "only for Codex")
    .action(async (options: { claude?: boolean; codex?: boolean }) => {
      const picked = SKILL_TARGETS.filter((t) => options[t]);
      const targets: SkillTarget[] = picked.length ? picked : SKILL_TARGETS;
      const source = skillsSource(env);
      const done: { target: SkillTarget; path: string }[] = [];
      for (const target of targets) done.push({ target, path: await installSkill(target, source, env) });
      if (json()) return out(`${JSON.stringify(done)}\n`);
      out(done.map((d) => `Installed the uplink skill for ${SKILL_TARGET_NAMES[d.target]} in ${d.path}\n`).join(""));
      out("A session started from now on finds it; one that's running may need restarting.\n");
    });
  const mcp = program.command("mcp").description("uplink-mcp, this tool's MCP server, in an agent harness");
  mcp
    .command("install <harness>")
    .description("Add uplink-mcp to Claude Code (user scope), Codex or Hermes with the harness's own mcp add, replacing an earlier one named uplink")
    .addOption(new Option("--channel", "run it as a Claude Code channel (uplink-mcp --channel)"))
    .action(async (harness: string, options: { channel?: boolean }) => {
      if (!MCP_HARNESSES.includes(harness as McpHarness)) throw new CliError("usage", `The harness is one of ${MCP_HARNESSES.join(", ")}.`);
      const server = [...mcpProgram(env), ...(options.channel ? ["--channel"] : [])];
      const { command, output } = await installMcp(harness as McpHarness, server, env, io.run);
      if (json()) return out(`${JSON.stringify({ harness, command, output })}\n`);
      out(`${output ? `${output}\n` : ""}Added uplink-mcp to ${MCP_HARNESS_NAMES[harness as McpHarness]}: ${command.map(shQuote).join(" ")}\n`);
    });

  // Output a joined run acknowledges once written (ADR 0032): it settles when the stream has it.
  const written = (stream: NodeJS.WriteStream, own: ((text: string) => void) | undefined) => async (text: string) => {
    if (own) return own(text);
    await new Promise<void>((resolve, reject) => stream.write(text, (error) => (error ? reject(error) : resolve())));
  };
  const joinContext = { env, io: { ...io, stdin: io.stdin ?? readProcessStdin }, out, err, json, write: { out: written(process.stdout, io.stdout), err: written(process.stderr, io.stderr) } };
  addJoinCommands(program, joinContext);

  // One subcommand per Room API function. Needs the catalog, so skip it for
  // commands that don't, and for `--help` ignore a catalog we can't reach.
  const first = argv.find((a) => !a.startsWith("-"));
  // `uplink inbox` alone is a joined session's own inbox; `uplink inbox get` is the Inbox module's function.
  const joinedInbox =
    first === "inbox" && !argv.slice(argv.indexOf("inbox") + 1).some((a) => !a.startsWith("-")) && !argv.includes("--help") && !argv.includes("-h");
  if (joinedInbox) addInboxCommand(program, joinContext);
  const wantsCatalog = !joinedInbox && (first === undefined || !BUILTIN_COMMANDS.has(first));
  const catalogRequired = first !== undefined && first !== "help";

  // Help marks the functions this key lacks the scope for; only help pays for the extra lookup.
  const wantsHelp = first === undefined || first === "help" || argv.includes("--help") || argv.includes("-h");

  try {
    if (wantsCatalog) {
      try {
        const client = await makeClient();
        const [{ functions }, me] = await Promise.all([
          client.functions(),
          wantsHelp
            ? (client.call("members.me") as Promise<{ lacksScopes?: string[]; addedBy?: { name: string } }>).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        const lacks = { scopes: new Set(me?.lacksScopes ?? []), addedBy: me?.addedBy?.name };
        addFunctionCommands(program, functions, callFunction, io.stdin ?? readProcessStdin, lacks);
      } catch (error) {
        if (catalogRequired) throw error;
      }
    }
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof HookExit) return error.exitCode;
    const [code, message] =
      error instanceof RoomApiError || error instanceof CliError
        ? [error.code, error.message]
        : ["error", error instanceof Error ? error.message : String(error)];
    err(
      json()
        ? `${JSON.stringify({ ok: false, error: { code, message } })}\n`
        : `${code}: ${message}\n`,
    );
    return 1;
  }
}

function addFunctionCommands(
  program: Command,
  functions: RoomFunction[],
  run: (fn: string, args: Record<string, unknown>) => Promise<void>,
  readStdin: () => Promise<string>,
  lacks: { scopes: Set<string>; addedBy?: string } = { scopes: new Set() },
): void {
  const groups = new Map<string, Command>();
  // Each module's functions, for its line in `uplink --help`: "tasks  Room API: board, create, ...".
  const groupLeaves = new Map<string, string[]>();

  for (const fn of functions) {
    const segments = fn.name.split(".");
    const leaf = segments.pop()!;
    // Run functions take a joined run's own token, which these commands don't send: uplink inbox, say and reply do.
    if (segments.length === 0 || BUILTIN_COMMANDS.has(segments[0]!) || fn.realm === "run") continue;

    let parent = program;
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}.${segment}` : segment;
      let group = groups.get(path);
      if (!group) {
        group = parent.command(segment).description(`Room API: ${path}`);
        groups.set(path, group);
      }
      parent = group;
    }

    const group = groups.get(segments.join("."))!;
    group.description(`Room API: ${[...(groupLeaves.get(segments.join(".")) ?? []), leaf].join(", ")}`);
    if (segments.join(".") === "inbox" && !groupLeaves.has("inbox")) {
      group.addHelpText("after", "\nuplink inbox, with no function: the new messages for a session that joined the room with uplink join.");
    }
    groupLeaves.set(segments.join("."), [...(groupLeaves.get(segments.join(".")) ?? []), leaf]);
    const command = parent
      .command(leaf)
      .argument("[pairs...]", "arguments as key=value pairs, as with `uplink call`; flags override them")
      .summary(`${lacks.scopes.has(fn.scope) ? `[your key lacks ${fn.scope}] ` : ""}${firstSentence(fn.description)}`)
      .description(
        fn.realm === "account"
          ? `${fn.description} (account: for a person signed in with uplink login, in no team)`
          : fn.realm === "pair"
            ? `${fn.description} (Pairs: for a person signed in with uplink login, or an agent key with the pairs.join scope)`
          : `${fn.description} (scope: ${fn.scope}${lacks.scopes.has(fn.scope) ? `; your key lacks it${lacks.addedBy ? `, and ${lacks.addedBy}, who added you, can add it` : ""}` : ""})`,
      )
      .option("--args <json>", "arguments as a JSON object; key=value pairs and flags override it")
      .option("--stdin <argument>", "read this argument's value from standard input, such as a message body: --stdin body <<'EOF'");
    SUBCOMMAND_TERMS.set(command, `${leaf} ${argumentsHint(fn)}`.trim());

    const required = requiredProperties(fn);
    const flags: { property: string; attribute: string }[] = [];
    for (const [property, schema] of Object.entries(inputProperties(fn))) {
      const flag = kebab(property);
      if (RESERVED_FLAGS.has(flag)) continue;
      const choices = Array.isArray(schema.enum) && schema.enum.every((c) => typeof c === "string") ? (schema.enum as string[]) : undefined;
      const description = [
        required.includes(property) ? "(required)" : "",
        typeof schema.description === "string" ? schema.description : "",
        choices ? `One of: ${choices.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      let option: Option;
      if (schema.type === "boolean") {
        option = new Option(`--${flag}`, description);
        command.addOption(new Option(`--no-${flag}`, `Set ${property} to false`));
      } else {
        option = new Option(`--${flag} <value>`, description).argParser((raw: string) => {
          try {
            return coerceValue(schema, raw);
          } catch (error) {
            throw new InvalidArgumentError((error as Error).message);
          }
        });
      }
      command.addOption(option);
      flags.push({ property, attribute: option.attributeName() });
    }

    command.action(async (pairs: string[], options: Record<string, unknown>) => {
      const args = parseArgsJson(options.args);
      applyPairs(args, pairs, inputProperties(fn));
      if (typeof options.stdin === "string") {
        const schema = inputProperties(fn)[options.stdin];
        if (!schema) throw new CliError("usage", `--stdin names an argument ${fn.name} takes, such as ${Object.keys(inputProperties(fn)).filter((p) => p !== "teamId").join(", ")}.`);
        const raw = (await readStdin()).replace(/\r?\n$/, "");
        try {
          args[options.stdin] = coerceValue(schema, raw);
        } catch (error) {
          throw new CliError("usage", `${options.stdin}: ${(error as Error).message}`);
        }
      }
      for (const { property, attribute } of flags) {
        if (options[attribute] !== undefined) args[property] = options[attribute];
      }
      const missing = required.filter((p) => args[p] === undefined);
      if (missing.length > 0) {
        throw new CliError(
          "usage",
          `Missing required: ${missing.map((p) => `--${kebab(p)} (or ${p}=...)`).join(", ")}. Run with --help for every flag.`,
        );
      }
      await run(fn.name, args);
    });
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Inside the desktop app this runs on Electron as Node (resources/bin/uplink). What it starts, such
  // as a browser or a Codex, must not inherit that; the keeper gets it back (self.ts).
  if (process.versions.electron) delete process.env["ELECTRON_RUN_AS_NODE"];
  // `uplink … | head` and the like: once nobody reads the output, stop (closedOutput.ts).
  onClosedOutput(() => process.exit());
  process.exitCode = await main(process.argv.slice(2));
}
