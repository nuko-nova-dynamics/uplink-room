import { RUNTIME_MODES, type RuntimeMode } from "@uplink-room/protocol";
/**
 * The harnesses a run can start, in one place for the backend and the desktop app: the command that
 * starts each in a terminal (`shell` is a plain terminal with no harness), whether a run of it can use
 * a profile, and whether T3 Code can run it as a thread.
 *
 * A profile is offered only where `research/profile-logins.md` (#18) found the harness keeps a
 * profile's logins apart from the machine setup: Claude Code (`CLAUDE_CONFIG_DIR`) and OpenCode
 * (four XDG folders, with its external skills and Claude Code imports turned off). For every other
 * harness, `profiles` is the reason it uses the machine setup only. The bridge keeps its own copy of
 * the allowed list (`packages/bridge/src/profiles.ts`) and refuses the rest itself.
 *
 * `firstPrompt` is how the CLI takes a first prompt for a run in Rex (ADR 0019), checked against its
 * --help; a harness without one starts in Rex with no prompt.
 *
 * `threads` is true where the bridge maps the harness to a T3 Code provider driver
 * (`packages/bridge/src/adapters/t3code.ts`, `HARNESS_DRIVERS`), else the reason it runs only in a
 * terminal. The room refuses a thread run of any other harness before it reaches the bridge.
 *
 * Hermes Agent (Nous Research, hermes-agent.nousresearch.com) starts with `hermes`. Its profiles move
 * Hermes's own folder (`HERMES_HOME`), but its docs say a profile without its own OAuth login keeps
 * using the one in the machine's `~/.hermes/auth.json`, and that the tools it runs keep the machine's
 * home folder and the sign-ins there (user guide, Profiles: "OAuth logins are shared, not copied" and
 * "How it works"). Nothing here tested two accounts apart, so it uses the machine setup only.
 *
 * Antigravity isn't listed: its command and where it keeps logins are unverified (#18). If it's
 * added, it uses the machine setup only until that is tested. Any other CLI agent runs in a Shell:
 * start one and type its command.
 */
export const HARNESSES = {
  "claude-code": { command: "claude", profiles: true, threads: true, firstPrompt: "argument" },
  codex: {
    command: "codex",
    firstPrompt: "argument",
    profiles:
      "Codex can't use a profile yet: it still reads skills shared by the whole machine, and its MCP logins can mix with the machine setup's. Use the machine setup.",
    threads: true,
  },
  "grok-build": {
    command: "grok",
    firstPrompt: "argument",
    profiles:
      "Grok Build can't use a profile yet: in a profile it still loads the machine setup's skills, plugins and MCP servers. Use the machine setup.",
    threads: true,
  },
  opencode: { command: "opencode", profiles: true, threads: true, firstPrompt: "--prompt" },
  cursor: {
    command: "cursor-agent",
    firstPrompt: "argument",
    profiles:
      "Cursor can't use a profile: it keeps one login for the whole machine, so a profile would share the machine setup's login. Use the machine setup.",
    threads: true,
  },
  "hermes-agent": {
    command: "hermes",
    // `hermes chat --help` (2026-11-06): --query seeds an interactive session on a TTY.
    firstPrompt: "chat --query",
    profiles:
      "Hermes Agent can't use a profile yet: a Hermes profile can still use the machine's OAuth logins in ~/.hermes/auth.json, and the tools it runs use the machine's own sign-ins. Use the machine setup.",
    threads: "T3 Code has no Hermes Agent provider, so Hermes Agent runs in a shared terminal.",
  },
  shell: {
    command: undefined,
    firstPrompt: undefined,
    profiles:
      "A plain shell can't use a profile: any harness can run in it, and only Claude Code and OpenCode keep a profile's logins apart from the machine setup. Start one of those with your profile.",
    threads: "T3 Code runs agents, not a plain shell, so a shell runs in a shared terminal.",
  },
} as const satisfies Record<
  string,
  {
    command: string | undefined;
    profiles: true | string;
    threads: true | string;
    /** How the CLI takes a first prompt for a run in Rex (ADR 0019); undefined: not checked, or none. */
    firstPrompt: "argument" | "--prompt" | "chat --query" | undefined;
  }
>;

export type Harness = keyof typeof HARNESSES;

/**
 * The flags that start a terminal harness in a permission mode (ADR 0043), or undefined where the room
 * doesn't set one: another harness, or `approval-required` for a terminal, which starts as the
 * machine sets the harness up, as before. They mirror what T3 Code passes the same harnesses for its
 * runtime modes (apps/server orchestration-v2 `ClaudeAdapterV2.ts` and `CodexAdapterV2.ts` at
 * v0.1.8-nightly.20261105.4234), as each CLI's --help names them (Claude Code 2.1.318
 * `--permission-mode`, Codex 0.166.0 `-a` and `-s`). Codex's `auto` needs `approvals_reviewer`,
 * which only `-c` sets, and `-c` takes a terminal's Codex off its own app server (ADR 0038): it isn't offered.
 */
export const TERMINAL_MODE_FLAGS: Partial<Record<string, Partial<Record<RuntimeMode, string>>>> = {
  "claude-code": {
    "auto-accept-edits": "--permission-mode acceptEdits",
    auto: "--permission-mode auto",
    "full-access": "--permission-mode bypassPermissions",
  },
  codex: {
    "auto-accept-edits": "-a on-request -s workspace-write",
    "full-access": "-a never -s danger-full-access",
  },
};

/** The permission modes a terminal of this harness can start in, most careful first; empty where the room sets none. */
export function terminalModes(harness: string): RuntimeMode[] {
  const flags = TERMINAL_MODE_FLAGS[harness];
  return flags ? ["approval-required", ...RUNTIME_MODES.filter((mode) => flags[mode] !== undefined)] : [];
}

/** The command a terminal starts with in `mode`: the harness's own, then the mode's flags. */
export function commandWithMode(harness: string, command: string | undefined, mode: RuntimeMode | undefined): string | undefined {
  const flags = mode ? TERMINAL_MODE_FLAGS[harness]?.[mode] : undefined;
  return command && flags ? `${command} ${flags}` : command;
}

/** Harnesses a run can start, in the order the app offers them. */
export const STARTABLE_HARNESSES = Object.keys(HARNESSES) as Harness[];

export function isHarness(harness: string): harness is Harness {
  return Object.hasOwn(HARNESSES, harness);
}

export function commandFor(harness: string): string | undefined {
  return isHarness(harness) ? HARNESSES[harness].command : undefined;
}

/** Why a run of this harness can't use a profile, or undefined when it can. */
export function profileRefusal(harness: string): string | undefined {
  if (!isHarness(harness)) return undefined;
  const profiles = HARNESSES[harness].profiles;
  return profiles === true ? undefined : profiles;
}

/** Why T3 Code can't run this harness as a thread, or undefined when it can. */
export function threadRefusal(harness: string): string | undefined {
  if (!isHarness(harness)) return undefined;
  const threads = HARNESSES[harness].threads;
  return threads === true ? undefined : threads;
}

/** Whether a run in Rex can give this harness a first prompt on its command line. */
export function takesFirstPrompt(harness: string): boolean {
  return isHarness(harness) && HARNESSES[harness].firstPrompt !== undefined;
}

/** The longest first prompt a run in Rex takes on its command line. */
export const MAX_REX_PROMPT = 4000;

/** Quotes one word for the POSIX shell a Rex tab's command runs in (Rex runs on macOS and Linux). */
function shellWord(word: string) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The command a run "In Rex" starts (ADR 0019): the harness's own, with the first prompt the way its
 * CLI takes one (`firstPrompt`). Checked against each CLI's --help on 2026-11-04: `claude [prompt]`,
 * `codex [PROMPT]`, `grok [PROMPT]`, `cursor-agent [prompt...]` and `opencode --prompt`. A `--`
 * before the prompt ends the options (commander and clap both document it), so a prompt that starts
 * with a dash stays the prompt.
 */
export function inRexCommand(harness: string, prompt?: string): string | undefined {
  if (!isHarness(harness)) return undefined;
  const { command, firstPrompt } = HARNESSES[harness];
  const text = prompt?.trim();
  if (!command || !text || !firstPrompt) return command;
  if (firstPrompt === "chat --query") return `${command} chat --query=${shellWord(text)}`;
  return firstPrompt === "--prompt" ? `${command} --prompt=${shellWord(text)}` : `${command} -- ${shellWord(text)}`;
}

/** Why a run of this harness can't start "In Rex" with this first prompt, or undefined when it can. */
export function inRexRefusal(harness: string, prompt?: string): string | undefined {
  if (!isHarness(harness)) return undefined;
  if (prompt?.trim() && !HARNESSES[harness].firstPrompt)
    return "A plain shell takes no first prompt. Leave it empty, or pick a harness.";
  if ((prompt?.trim().length ?? 0) > MAX_REX_PROMPT) return `A first prompt for a run in Rex can be at most ${MAX_REX_PROMPT} characters.`;
  return undefined;
}

/**
 * What people call each harness, as the desktop app shows it (`apps/desktop/src/renderer/lib/format.ts`,
 * `HARNESS_LABELS`). A live run is named by this and its driver, such as Claude Code (Julio) (ADR 0026).
 */
const HARNESS_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok Build",
  opencode: "OpenCode",
  cursor: "Cursor",
  "hermes-agent": "Hermes Agent",
  shell: "Shell",
  t3code: "T3 Code",
  space: "Space",
  rex: "Rex",
  a2a: "A2A agent",
};

/**
 * The harness a bridge adapter's terminal runs, by the adapter's name (`terminal_started.tool`): the
 * Claude Code adapter is `claude`, the room's harness `claude-code`. `t3code` and `rex` are the
 * room's names already; `tmux` and `herdr` are multiplexers, not harnesses, so they keep their own.
 */
const HARNESS_OF_TOOL: Record<string, string> = { claude: "claude-code" };

/** The harness for a run found in a terminal the bridge reports with `tool`. */
export function harnessOfTool(tool: string): string {
  return HARNESS_OF_TOOL[tool] ?? tool;
}

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness;
}
