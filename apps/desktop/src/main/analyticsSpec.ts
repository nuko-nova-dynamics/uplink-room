/**
 * Product analytics (PostHog): which events the app sends and which properties each may carry.
 * Main (posthog-node) and the renderer (posthog-js) both send through this list, and every event
 * passes `scrubEvent` on its way out, so an event or property that isn't named here never leaves
 * the app.
 *
 * The rules (docs/analytics.md):
 *  - People are identified by member ID and the team by team ID. No names or emails.
 *  - No message, terminal, transcript, document or URL contents: every property is an enum, a
 *    boolean or a count, never free text.
 *  - Nothing is sent while "Share usage data" (Settings, Privacy) is off.
 */

/** PostHog US Cloud ingestion. The project key is public and lives in `.env.release`. */
export const POSTHOG_HOST = "https://us.i.posthog.com";
/** Where posthog-js fetches the project's remote config (JSON only: the app loads no PostHog script). */
export const POSTHOG_ASSETS_HOST = "https://us-assets.i.posthog.com";

/** The harnesses a run can use (renderer/lib/format.ts `HARNESS_LABELS`). Anything else is "other". */
export const HARNESSES = [
  "claude-code",
  "codex",
  "grok-build",
  "opencode",
  "cursor",
  "hermes-agent",
  "shell",
  "t3code",
  "space",
  "a2a",
] as const;

/** What kind of run: a terminal, a thread, a Space, an A2A agent, or a terminal on a cloud machine. */
export const RUN_KINDS = ["terminal", "thread", "space", "a2a", "cloud"] as const;

type Rule =
  | readonly string[] // one of these values
  | "boolean"
  | "count" // a whole number, 0 or more
  | "version"; // a semver version such as 0.1.0

/** Every event and the properties it may carry. */
export const EVENTS = {
  /** Main: the app started. */
  app_launched: {
    app_version: "version",
    platform: ["darwin", "win32", "linux", "other"],
    arch: ["arm64", "x64", "other"],
  },
  signed_in: {},
  signed_out: {},
  team_created: {},
  team_joined: {},
  /** A team was opened in the app (after sign-in, or switching teams). */
  team_opened: { team_count: "count" },
  /** Settings, Machines: a pairing code for `uplink-bridge pair` was made. */
  pairing_code_created: { belongs_to: ["person", "team"] },
  /** Main: this computer's bundled bridge was paired from the app. */
  machine_linked: { method: ["this_computer"], result: ["ok", "failed"] },
  cloud_machine_created: {},
  run_started: {
    harness: [...HARNESSES, "other"],
    kind: RUN_KINDS,
    access: ["watch", "suggest", "drive", "open", "none"],
    has_profile: "boolean",
  },
  call_joined: {},
  shared_browser_started: {},
  shared_browser_opened: {},
  space_opened: {},
  terminal_opened: {},
  file_opened: { file_kind: ["doc", "html", "pdf", "image", "canvas"] },
  approval_answered: {
    answer: ["allow", "deny"],
    from: ["inbox", "inbox_keyboard", "task", "notification"],
  },
  inbox_opened: {},
  inbox_view_changed: { view: ["mine", "team"] },
} as const satisfies Record<string, Record<string, Rule>>;

export type EventName = keyof typeof EVENTS;

type Value<R> = R extends readonly (infer V)[]
  ? V
  : R extends "boolean"
    ? boolean
    : R extends "count"
      ? number
      : string;

/** The properties an event takes, typed from `EVENTS`. */
export type EventProps<E extends EventName> = { [K in keyof (typeof EVENTS)[E]]?: Value<(typeof EVENTS)[E][K]> };

/** Convex document IDs: lowercase letters and digits. The only IDs events carry. */
const ID = /^[a-z0-9]{8,64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/i;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** A harness name as the run used it, or "other" for one the list doesn't know. */
export function harnessName(harness: string): (typeof EVENTS.run_started.harness)[number] {
  return (HARNESSES as readonly string[]).includes(harness)
    ? (harness as (typeof HARNESSES)[number])
    : "other";
}

/**
 * The run kind for `run_started`. A Space is a Space and a thread is a thread on any machine;
 * "cloud" means a terminal on a cloud machine.
 */
export function runKind(
  harness: string,
  via: "terminal" | "thread",
  onCloudMachine: boolean,
): (typeof RUN_KINDS)[number] {
  if (harness === "space") return "space";
  if (via === "thread") return "thread";
  return onCloudMachine ? "cloud" : "terminal";
}

function allowed(rule: Rule, value: unknown): boolean {
  if (rule === "boolean") return typeof value === "boolean";
  if (rule === "count") return typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (rule === "version") return typeof value === "string" && VERSION.test(value);
  return typeof value === "string" && rule.includes(value);
}

/** An event's own properties, keeping only those `EVENTS` names, with values its rules allow. */
export function eventProperties(event: string, properties: Record<string, unknown>): Record<string, unknown> | null {
  const rules = (EVENTS as Record<string, Record<string, Rule>>)[event];
  if (!rules) return null;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (key in properties && allowed(rule, properties[key])) out[key] = properties[key];
  }
  if (isId(properties["team_id"])) out["team_id"] = properties["team_id"];
  return out;
}

/**
 * posthog-js's own properties that carry no content: the SDK, the OS and screen, the session.
 * Everything else it adds is dropped, notably `$current_url`, `$pathname`, `$host`, `$referrer`,
 * `$title`, `$raw_user_agent`, the `$initial_*` and `$session_entry_*` URLs, and any `$el_*` text.
 */
const SYSTEM = new Set([
  "token",
  "distinct_id",
  "$lib",
  "$lib_version",
  "$os",
  "$os_version",
  "$browser",
  "$browser_version",
  "$browser_language",
  "$browser_language_prefix",
  "$device_type",
  "$device_id",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$timezone",
  "$timezone_offset",
  "$session_id",
  "$window_id",
  "$insert_id",
  "$time",
  "$is_identified",
  "$process_person_profile",
  "$anon_distinct_id",
  "$configured_session_timeout_ms",
  "$recording_status",
  "$sdk_debug_replay_internal_buffer_length",
  "$sdk_debug_replay_internal_buffer_size",
  "$sdk_debug_current_session_duration",
  "$sdk_debug_session_start",
  "$active_feature_flags",
]);

/** Person properties PostHog may set: the OS and app, never a URL or a name. */
const PERSON = new Set(["$os", "$os_version", "$browser", "$browser_version", "$device_type"]);
const PERSON_ONCE = new Set([...PERSON].map((key) => `$initial_${key.slice(1)}`));

function pick(source: unknown, keep: Set<string>): Record<string, unknown> | undefined {
  if (!source || typeof source !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) if (keep.has(key)) out[key] = value;
  return out;
}

function systemProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SYSTEM.has(key) || key.startsWith("$feature/")) out[key] = value;
  }
  const set = pick(properties["$set"], PERSON);
  if (set) out["$set"] = set;
  const once = pick(properties["$set_once"], PERSON_ONCE);
  if (once) out["$set_once"] = once;
  return out;
}

/** A replay's page address, without the query or hash (the sign-in flow keeps state in both). */
export function pageAddress(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/** Replay's meta events record the page address; cut it to the page itself. */
function scrubSnapshot(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((item: unknown) => {
    const event = item as { type?: number; data?: { href?: unknown } };
    if (event?.type === 4 && event.data && typeof event.data.href === "string") {
      return { ...event, data: { ...event.data, href: pageAddress(event.data.href) } };
    }
    return item;
  });
}

/** PostHog's own events that may go out, besides ours. Pageviews, autocapture and the rest don't. */
const POSTHOG_EVENTS = new Set(["$identify", "$snapshot", "$opt_in"]);

export type OutgoingEvent = {
  event: string;
  properties?: Record<string, unknown> | undefined;
  /** posthog-js sends person properties beside `properties` on some events, `$identify` among them. */
  $set?: unknown;
  $set_once?: unknown;
};

/** The person properties beside `properties`, cut to the safe ones (and left out when there were none). */
function personFields<T extends OutgoingEvent>(input: T): Partial<T> {
  const out: Partial<OutgoingEvent> = {};
  if ("$set" in input) out.$set = pick(input.$set, PERSON) ?? {};
  if ("$set_once" in input) out.$set_once = pick(input.$set_once, PERSON_ONCE) ?? {};
  return out as Partial<T>;
}

/** On every event: PostHog must not look up a location from the IP address before dropping it. */
const NO_GEOIP = { $geoip_disable: true } as const;

/**
 * The last check before an event leaves the app (posthog-js `before_send`, and main before
 * posthog-node). Returns the event with only allowed properties, or null to drop it. It also
 * turns GeoIP off on every event, so nothing that resets posthog-js's own properties can drop it.
 */
export function scrubEvent<T extends OutgoingEvent>(input: T): T | null {
  const properties = input.properties ?? {};
  const own = eventProperties(input.event, properties);
  if (own) {
    return { ...input, ...personFields(input), properties: { ...systemProperties(properties), ...own, ...NO_GEOIP } };
  }
  if (!POSTHOG_EVENTS.has(input.event)) return null;
  const out: Record<string, unknown> = { ...systemProperties(properties), ...NO_GEOIP };
  if (input.event === "$snapshot") {
    out["$snapshot_data"] = scrubSnapshot(properties["$snapshot_data"]);
    if (typeof properties["$snapshot_bytes"] === "number") out["$snapshot_bytes"] = properties["$snapshot_bytes"];
    if (typeof properties["$snapshot_source"] === "string") out["$snapshot_source"] = properties["$snapshot_source"];
  }
  return { ...input, ...personFields(input), properties: out };
}
