/**
 * The Codex hooks the bridge gives a terminal it starts with `codex` (ADR 0038). They go to that
 * terminal's own app server as `-c` overrides, Codex's "session flags" config layer, so they apply to
 * that session only and nothing is written to the person's Codex home: Codex reads hooks from inline
 * `[hooks]` tables "next to active config layers" (learn.chatgpt.com/docs/hooks.md, "Where Codex
 * looks for hooks"), and `hooks/list` reports them with `source: "sessionFlags"`.
 *
 * Codex runs a non-managed hook only once it is trusted ("Review and trust hooks"), and records trust
 * against a hash of the hook's definition under `hooks.state."<key>".trusted_hash` in `config.toml`.
 * The bridge passes that trust in the same `-c` layer, for its own hooks only: the person's hooks keep
 * their own review, and `--dangerously-bypass-hook-trust`, which skips it for every hook, isn't used.
 * The bridge's first guess is Codex's hash (`hook_hash` and `version_for_toml` in openai/codex at
 * rust-v0.166.0, codex-rs/hooks/src/engine/discovery.rs and codex-rs/config/src/fingerprint.rs):
 * SHA-256 of the normalized hook as JSON with sorted keys. The server says whether it trusts them
 * (`hooks/list`, `trustStatus`) and the hash it would (`currentHash`), and `uplink-bridge codex`
 * starts it again with those when a Codex hashes differently (`codexSession.ts`). Trust has to come
 * from this layer: session flags win over the person's `config.toml` field by field
 * (`hook_states_from_stack`, codex-rs/hooks/src/config_rules.rs), so a hash the bridge got wrong would
 * also beat one the person approved in `/hooks`.
 *
 * - `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt`: report the
 *   run's state, and tell the bridge the session's thread (`session_id`, which "Subagent hooks use the
 *   parent session id" keeps on the main thread). `PostToolUse` also posts what `uplink-bridge say` or
 *   `reply` couldn't send from inside Codex's sandbox (`codexRelay.ts`).
 * - `PermissionRequest`: the approval goes to the room, and the driver's answer comes back as Codex's
 *   `decision`. It waits up to Codex's default hook timeout; then Codex, with no decision, asks in the
 *   terminal as it would without the hook.
 */
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { quoteCommand } from "./platform.ts";

type Platform = NodeJS.Platform;

/** The events the bridge hooks, in the order it passes them, and each one's timeout in seconds. */
const HOOKS: [event: string, timeout: number][] = [
  ["SessionStart", 30],
  ["UserPromptSubmit", 30],
  ["PreToolUse", 30],
  ["PostToolUse", 30],
  ["PermissionRequest", 600],
  ["Stop", 30],
  // Codex allows an Interrupt hook at most 3 seconds.
  ["Interrupt", 3],
];

/** Events whose matcher Codex ignores, and leaves out of the hash (`matcher_pattern_for_event`). */
const NO_MATCHER = new Set(["UserPromptSubmit", "Stop", "Interrupt", "PreModelRequest", "PostModelRequest"]);

/** `PreToolUse` → `pre_tool_use`: how Codex names an event in a hook's key and hash. */
const label = (event: string) => event.replace(/[A-Z]/g, (letter, at: number) => (at ? "_" : "") + letter.toLowerCase());

/** A command hook as Codex reads it from config. */
export type CodexCommandHook = { command: string; timeout?: number; matcher?: string; statusMessage?: string; async?: boolean };

/** JSON with every object's keys sorted, as serde_json's `sort_all_objects` leaves it. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/** The hash Codex trusts a command hook by, for one hook alone in its matcher group. */
export function codexHookHash(event: string, hook: CodexCommandHook): string {
  // Codex 0.166.0 normalizes the timeout first: SessionEnd and Interrupt default to 1 second and allow
  // at most 3; every other event defaults to 600 (`normalize_command_hook`).
  const short = event === "SessionEnd" || event === "Interrupt";
  const timeout = short ? Math.min(Math.max(hook.timeout ?? 1, 1), 3) : Math.max(hook.timeout ?? 600, 1);
  const handler = {
    type: "command",
    command: hook.command,
    timeout,
    async: hook.async ?? false,
    ...(hook.statusMessage === undefined ? {} : { statusMessage: hook.statusMessage }),
  };
  const identity = {
    event_name: label(event),
    ...(hook.matcher === undefined || NO_MATCHER.has(event) ? {} : { matcher: hook.matcher }),
    hooks: [handler],
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(sorted(identity))).digest("hex");
}

/** A TOML basic string. */
function toml(text: string): string {
  // oxlint-disable-next-line no-control-regex -- TOML basic strings can't hold control characters raw
  return `"${text.replace(/[\\"]/g, (c) => "\\" + c).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** A TOML value written inline, as one `-c` value holds it. */
function inline(value: unknown): string {
  if (typeof value === "string") return toml(value);
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : Number.isFinite(value) ? String(value) : value > 0 ? "inf" : "-inf";
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  // smol-toml's dates write themselves back in the form they were read.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(inline).join(",")}]`;
  if (isTable(value)) return `{${Object.entries(value).map(([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : toml(key)}=${inline(item)}`).join(",")}}`;
  return toml(String(value));
}

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** The `key=value` overrides in a list of Codex options: each `-c` and `--config` value. */
function overrides(options: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const option = options[i]!;
    if ((option === "-c" || option === "--config") && i + 1 < options.length) found.push(options[++i]!);
    else if (option.startsWith("--config=")) found.push(option.slice("--config=".length));
  }
  return found;
}

/**
 * The `hooks` table the person's own `-c` values give the session-flags layer, built as Codex
 * 0.166.0 builds it (`build_cli_overrides_layer`, codex-rs/config/src/overrides.rs): in order, the
 * key split on every dot, the value read as TOML or else as a string with its quotes trimmed, and the
 * last segment set, replacing what was there.
 */
function givenHooks(options: string[]): Table {
  const root: Table = Object.create(null);
  for (const override of overrides(options)) {
    const at = override.indexOf("=");
    if (at < 0) continue;
    const path = override.slice(0, at).trim().split(".");
    if (path[0] !== "hooks") continue;
    const raw = override.slice(at + 1).trim();
    let value: unknown;
    try {
      value = (parse(`_x_ = ${raw}`) as Table)._x_;
    } catch {
      value = raw.replace(/^["']+|["']+$/g, "");
    }
    let table = root;
    for (const segment of path.slice(0, -1)) {
      const next = table[segment];
      table = isTable(next) ? next : (table[segment] = Object.create(null) as Table);
    }
    table[path.at(-1)!] = value;
  }
  return isTable(root.hooks) ? root.hooks : {};
}

/**
 * The `-c` values for a Codex terminal's app server: one per hooked event, each running this bridge's
 * CLI (`bridge` are the words that start it) as `codex-hook EVENT`, then the trust for exactly those.
 *
 * `given` are the person's own options for the server. A `-c` value replaces what an earlier one set
 * at the same key, so the bridge's values carry what the person's set there too: their matcher groups
 * for an event come first and keep their places, and with them the keys their trust is recorded
 * under, and their `hooks.state` entries stay beside the bridge's.
 *
 * `hashes`, by event, are the ones the server reported for the bridge's hooks (`hooks/list`), which
 * replace the bridge's own; `keys`, by event, are the keys the bridge's hooks have in that list.
 */
export function codexServerConfig(
  bridge: string[],
  options: { platform?: Platform; given?: string[]; hashes?: Record<string, string> } = {},
): { values: string[]; keys: Record<string, string> } {
  const platform = options.platform ?? process.platform;
  const given = givenHooks(options.given ?? []);
  const state: Table = isTable(given.state) ? { ...given.state } : {};
  const values: string[] = [];
  const keys: Record<string, string> = {};
  for (const [event, timeout] of HOOKS) {
    const command = quoteCommand([...bridge, "codex-hook", event], {}, platform);
    const theirs = Array.isArray(given[event]) ? (given[event] as unknown[]) : [];
    values.push(`hooks.${event}=${inline([...theirs, { hooks: [{ type: "command", command, timeout }] }])}`);
    // A hook's key names its layer, its event, its matcher group and its place in that group.
    const key = (keys[event] = `/<session-flags>/config.toml:${label(event)}:${theirs.length}:0`);
    state[key] = { trusted_hash: options.hashes?.[event] ?? codexHookHash(event, { command, timeout }) };
  }
  values.push(`hooks.state=${inline(state)}`);
  return { values, keys };
}
