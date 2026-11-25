/**
 * What error reports may carry. The desktop app (main and renderer) and the bridge send Sentry
 * only what these functions keep, so the rules live in one place and one test covers them
 * (test/scrub.test.ts).
 *
 * Kept: the error's type, stack frames (file, function, line, column), the OS, runtime and app
 * versions, tags, and the member id. Dropped: request data, extra data, local variables, source
 * lines, the device's hostname, every user field but `id`, and every breadcrumb that could hold
 * what someone typed or saw (console output, clicks and key presses, IPC payloads).
 *
 * An error's message is kept only for JavaScript's own error types (TypeError, SyntaxError and the
 * rest in ENGINE_ERRORS), whose messages the engine writes, such as `Cannot read properties of
 * undefined (reading '…')`. Any other error (`Error`, `ConvexError`, a library's own class) is sent
 * as its type and stack alone, because its message is whatever the code put in it, and code puts
 * content in messages (`Couldn't send ${body}`) that no pattern can tell apart from a description.
 *
 * Redacted inside the strings that remain: quoted text, from the first quote to the last (V8 puts
 * the input in parse errors, unescaped, as in `Unexpected token 'x', "…" is not valid JSON`), JWTs (Clerk session tokens), the room's own
 * secrets (`urk_…` agent keys, `ubt_…` bridge tokens, `urt_…` thread run keys and the rest from
 * packages/backend/convex/lib/crypto.ts), pairing codes, other long hex or base64 runs, email
 * addresses, URL query strings and fragments, and the exact value of any environment variable
 * that the caller passes in.
 */

/** The parts of a Sentry event this file reads. Everything else on an event is dropped. */
export interface ScrubbableEvent {
  [key: string]: unknown;
  message?: unknown;
  logentry?: unknown;
  exception?: { values?: ScrubbableException[] };
  breadcrumbs?: ScrubbableBreadcrumb[];
  user?: { id?: unknown; [key: string]: unknown };
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  request?: unknown;
}
interface ScrubbableException {
  type?: unknown;
  value?: unknown;
  mechanism?: unknown;
  stacktrace?: { frames?: Record<string, unknown>[] };
  [key: string]: unknown;
}
export interface ScrubbableBreadcrumb {
  type?: unknown;
  category?: unknown;
  level?: unknown;
  message?: unknown;
  timestamp?: unknown;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Longest message kept. Past this, a message is more likely to hold content than describe a bug. */
const MESSAGE_LIMIT = 300;
/** Environment values shorter than this are too common ("1", "true", "en_US.UTF-8") to redact. */
const ENV_VALUE_MIN = 8;

/** Top-level event fields that pass through as they are. */
const EVENT_KEEP = new Set([
  "event_id",
  "timestamp",
  "start_timestamp",
  "level",
  "platform",
  "logger",
  "release",
  "dist",
  "environment",
  "sdk",
  "type",
  "fingerprint",
  "transaction",
  "modules",
  "debug_meta",
  "sdkProcessingMetadata",
]);
/** Contexts that describe the machine and runtime, not the person or their work. */
const CONTEXT_KEEP = new Set([
  "os",
  "runtime",
  "app",
  "browser",
  "device",
  "electron",
  "chrome",
  "node",
  "gpu",
  "trace",
]);
/** Keys dropped from the kept contexts (`name` only from `device`, where it's the computer's name). */
const CONTEXT_DROP_KEYS = new Set([
  "name",
  "hostname",
  "computer_name",
  "device_name",
  "user",
  "username",
]);
/** Stack frame fields that locate code. Source lines and local variables are dropped. */
const FRAME_KEEP = new Set([
  "filename",
  "abs_path",
  "function",
  "module",
  "lineno",
  "colno",
  "in_app",
  "platform",
  "debug_id",
  "instruction_addr",
]);
/**
 * Breadcrumb categories kept. Console output, DOM clicks and key presses (`ui.*`), and anything
 * unknown are dropped. Messages of the kept ones are redacted like everything else.
 */
const BREADCRUMB_CATEGORIES = new Set([
  // The app's own diagnostic log lines (apps/desktop: main/log.ts, renderer/lib/log.ts), which
  // are fixed texts with ids, counts and states, scrubbed before they're made.
  "uplink",
  "electron",
  "navigation",
  "fetch",
  "xhr",
  "http",
  "net",
  "child-process",
  "sentry.event",
  "sentry.transaction",
]);
/** Breadcrumb data fields kept, all of them about where a request went and how it ended. */
const BREADCRUMB_DATA_KEEP = new Set([
  "method",
  "status_code",
  "url",
  "from",
  "to",
  "reason",
  "exitCode",
]);

/** JavaScript's own error types. The engine writes their messages, so they describe code, not content. */
const ENGINE_ERRORS = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
]);
/** What an error of any other type is sent with instead of its message. */
export const MESSAGE_REMOVED = "(message not sent)";

/**
 * Library and platform messages that describe code, never content. A message whose template
 * (`templateOf`) matches one is sent as that template. Add one when a library's error turns up in
 * Sentry or the app's log as `(message not sent)`.
 */
export const SAFE_MESSAGES: readonly RegExp[] = [
  // WebAssembly refused by a content security policy (Krisp, before 'wasm-unsafe-eval'), and
  // WebAssembly's own errors.
  /^WebAssembly\.\w+\(\): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because <q> is not an allowed source of script in the following Content Security Policy directive: <q>.{0,40}$/,
  /^WebAssembly\.\w+\(\): .{0,160}$/,
  // Krisp's own (@livekit/krisp-noise-filter).
  /^(LiveKit-)?Krisp\b.{0,160}$/i,
  /^Could not enable plugin, .{0,120}$/,
  // LiveKit's connection, publishing and device errors.
  /^(could not establish (pc|signal) connection|Client initiated disconnect|connection timeout|room connection has been cancelled|Abort connection attempt|publishing rejected|cannot publish track when not connected|already connecting)\b.{0,80}$/i,
  /^(Permission denied|Permission dismissed|Requested device not found|Could not start (video|audio) source|Device in use|The request is not allowed by the user agent or the platform in the current context|Starting (videoinput|audioinput) failed)\b.{0,80}$/i,
  // The app's own device and media messages (apps/desktop/src/renderer/lib/callMedia.ts).
  /^The (microphone|camera|screen capture) didn't open within <n> seconds\.$/,
  /^No (microphone|camera) was opened\.$/,
  /^No picture came from the screen\.$/,
  // Fetch, sockets and worklets.
  /^(Failed to fetch|Load failed|The operation was aborted\.|signal is aborted without reason|The user aborted a request\.)$/,
  /^WebSocket (connection|closed|is already in CLOSING or CLOSED state).{0,80}$/,
  /^Unable to load a worklet's module\.$/,
  // Convex's connection messages.
  /^\[CONVEX [A-Z]\(.{0,80}\)\] (Connection lost while action was in flight|Server Error)$/,
];

/**
 * A message's shape without its variable parts: quoted text, URLs, emails, ids, long runs and
 * numbers become `<q>`, `<url>`, `<email>`, `<id>` and `<n>`. It decides whether a message is on the
 * SAFE_MESSAGES list, and is what's sent for one that is.
 */
export function templateOf(message: string): string {
  return message
    .replace(/"[\s\S]*?"|'[^']*'|`[^`]*`/g, "<q>")
    .replace(/[a-z][\w+.-]*:\/\/[^\s"']+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b[0-9a-f]{8,}\b|\b[A-Za-z0-9_-]{24,}\b/g, "<id>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * What may be sent of an error's message: an engine error's message, redacted; a message on the
 * SAFE_MESSAGES list, as its template; anything else as `(message not sent)` and nothing derived
 * from it. (A hash of the leftover text would let anyone holding a report test guesses at a short
 * message, so there is none: the error's class and stack carry the rest.) Environment values are
 * taken out before anything else, so no template can keep one.
 *
 * `envValues` left out means they aren't known here (the app's window): a template made then could
 * keep part of one (`pass-2024-otter-blue` becomes `pass-<n>-otter-blue`, which no later redaction
 * matches), so only a safe message with nothing to template is kept, and anything variable is
 * `(message not sent)`. Pass `[]` where the environment is known and has no values worth hiding.
 */
export function safeMessage(type: string, message: string, envValues?: readonly string[]): string {
  const known = envValues ?? [];
  const withoutEnv = redactEnv(message, known);
  if (ENGINE_ERRORS.has(type)) return redact(withoutEnv, known);
  // V8 prefixes a few messages with the error's type ("CompileError: WebAssembly.Module(): …").
  const bare = withoutEnv.replace(/^(Uncaught )?(CompileError|LinkError|RuntimeError|Error): /, "");
  const template = templateOf(bare);
  if (!SAFE_MESSAGES.some((safe) => safe.test(template))) return MESSAGE_REMOVED;
  if (!envValues && template !== bare.replace(/\s+/g, " ").trim()) return MESSAGE_REMOVED;
  return redact(template, known);
}
/**
 * Messages the Electron SDK writes itself when a renderer or GPU process exits, such as
 * `'GPU' process exited with 'crashed'`. They are the only message events sent as they are.
 */
const SDK_MESSAGE = /^'[\w -]{1,40}' process exited with '[\w-]{1,40}'$/;

const PATTERNS: [RegExp, string][] = [
  // Quoted text, which in an error message is usually someone's input. Each runs from the first
  // quote to the last of its kind, because V8 quotes parse input without escaping it:
  // JSON.parse('my "secret" message') fails with `"my "secret" message" is not valid JSON`, and a
  // long input is cut to `"…"...`. Double quotes go first, so a single quote inside them can't
  // pair with one outside.
  [/"[\s\S]*"/g, '"[redacted]"'],
  [/'[\s\S]*'/g, "'[redacted]'"],
  [/`[\s\S]*`/g, "`[redacted]`"],
  // JWTs, such as Clerk session tokens.
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, "[token]"],
  // Authorization headers that slipped into a message.
  [/\b(Bearer|Basic|Convex)\s+[\w.~+/=-]{8,}/gi, "$1 [token]"],
  // A thread run's key (ADR 0037), whose base64url body can hold `-` and `_` anywhere.
  [/urt_[A-Za-z0-9_-]{8,}/g, "[secret]"],
  // The room's secrets (`urk_`, `ubt_`, `uri_`, `hbw_`, `hbt_` and hex bodies), Clerk's (`sk_live_…`), Sentry's and others.
  [/\b[a-z]{2,8}_(?:(?:live|test)_)?[A-Za-z0-9]{16,}\b/g, "[secret]"],
  // Pairing codes, such as K7QX-2MPD.
  [/\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g, "[code]"],
  // Email addresses.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  // Query strings and fragments, which carry tokens and ids.
  [/([a-z][\w+.-]*:\/\/[^\s?#"']*)[?#][^\s"']*/gi, "$1"],
  // Other long hex or base64 runs.
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
  [/[A-Za-z0-9+_-]{40,}={0,2}/g, "[blob]"],
];

/** What a process knows about its own environment, for scrubbing. */
export interface ScrubOptions {
  /**
   * Environment variable values to redact from messages (see environmentValues). Left out, they
   * aren't known here, and an error message with variable parts isn't sent (safeMessage).
   */
  envValues?: readonly string[];
  /** The person's home folder, shown as `~` in stack frame paths (it holds their user name). */
  home?: string | undefined;
  /**
   * The event goes on to a process that knows the environment and scrubs it again (the app's
   * window sends its reports through the main process): error messages are left for that process,
   * so each is templated once, after its environment values are out.
   */
  messagesLater?: boolean;
}

/** The scrub options for a process with this environment. */
export function scrubOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ScrubOptions {
  return {
    envValues: environmentValues(env),
    home: env["HOME"] || env["USERPROFILE"] || undefined,
  };
}

/**
 * The values of the environment variables, longest first, to redact wherever they appear. Short
 * and common ones are left out (see ENV_VALUE_MIN).
 */
export function environmentValues(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const values = new Set<string>();
  for (const value of Object.values(env))
    if (value && value.length >= ENV_VALUE_MIN) values.add(value);
  return [...values].sort((a, b) => b.length - a.length);
}

function redactEnv(text: string, envValues: readonly string[]): string {
  let out = text;
  for (const value of envValues) if (out.includes(value)) out = out.split(value).join("[env]");
  return out;
}

/** Redacts the secrets and content described at the top of this file from one string. */
export function redact(text: string, envValues: readonly string[] = []): string {
  let out = redactEnv(text, envValues);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > MESSAGE_LIMIT ? `${out.slice(0, MESSAGE_LIMIT)}…` : out;
}

/** A URL reduced to its scheme, host and path. Anything that doesn't parse is redacted as text. */
function scrubUrl(value: unknown, envValues: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return redact(`${url.protocol}//${url.host}${url.pathname}`, envValues);
  } catch {
    return redact(value, envValues);
  }
}

/**
 * A file path with the home folder (which holds the user name) replaced: `/Users/julio/x.mjs`
 * becomes `app:///~/x.mjs`. Frames and `debug_meta` get the same change, because Sentry finds a
 * frame's source map by matching its path to a debug image's `code_file`. The result must stay an
 * absolute path or a URL: Sentry skips source maps for a frame at `~/x.mjs` (seen live).
 */
function shortenPath(value: unknown, home: string | undefined): unknown {
  if (typeof value !== "string" || !home || home.length < 2) return value;
  if (value.startsWith(home)) return `app:///~${value.slice(home.length).replaceAll("\\", "/")}`;
  return value.split(home).join("/~");
}

/** Frames come from code, not content, so they're kept as they are apart from the home folder. */
function scrubFrames(frames: Record<string, unknown>[] | undefined, home: string | undefined) {
  return frames?.map((frame) => {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frame)) {
      if (!FRAME_KEEP.has(key)) continue;
      kept[key] = key === "filename" || key === "abs_path" ? shortenPath(value, home) : value;
    }
    return kept;
  });
}

function scrubDebugMeta(debugMeta: unknown, home: string | undefined) {
  const images = (debugMeta as { images?: unknown } | undefined)?.images;
  if (!Array.isArray(images)) return debugMeta;
  return {
    images: images.map((image: Record<string, unknown>) => ({
      ...image,
      code_file: shortenPath(image["code_file"], home),
    })),
  };
}

/** One breadcrumb as it may be sent, or null to drop it. */
export function scrubBreadcrumb<B extends object>(input: B, options: ScrubOptions = {}): B | null {
  const envValues = options.envValues ?? [];
  const breadcrumb = input as ScrubbableBreadcrumb;
  const category = typeof breadcrumb.category === "string" ? breadcrumb.category : "";
  if (!BREADCRUMB_CATEGORIES.has(category)) return null;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(breadcrumb.data ?? {})) {
    if (!BREADCRUMB_DATA_KEEP.has(key)) continue;
    data[key] =
      key === "url" || key === "from" || key === "to"
        ? scrubUrl(value, envValues)
        : typeof value === "string"
          ? redact(value, envValues)
          : value;
  }
  const kept: ScrubbableBreadcrumb = {
    type: breadcrumb.type,
    category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
  };
  if (typeof breadcrumb.message === "string") kept.message = redact(breadcrumb.message, envValues);
  if (Object.keys(data).length > 0) kept.data = data;
  return kept as B;
}

/**
 * The event as it may be sent: only the fields listed above, with every remaining string
 * redacted. Returns a new object; the input is left alone.
 */
export function scrubEvent<E extends object>(input: E, options: ScrubOptions = {}): E {
  const envValues = options.envValues ?? [];
  const event = input as ScrubbableEvent;
  const out: ScrubbableEvent = {};
  for (const [key, value] of Object.entries(event)) if (EVENT_KEEP.has(key)) out[key] = value;
  if (event["debug_meta"]) out["debug_meta"] = scrubDebugMeta(event["debug_meta"], options.home);
  // Sentry must not take the IP address from the connection, nor the location it implies.
  // Without this it does for Node events (`legacy`), and showed the city even with IP storage off.
  const sdk = (event["sdk"] ?? {}) as { settings?: Record<string, unknown> };
  out["sdk"] = { ...sdk, settings: { ...sdk.settings, infer_ip: "never" } };

  // A message event is kept only when the SDK wrote it; the app's own would be content.
  if (typeof event.message === "string")
    out.message = SDK_MESSAGE.test(event.message) ? event.message : MESSAGE_REMOVED;
  const logentry = event.logentry as { message?: unknown } | undefined;
  if (typeof logentry?.message === "string")
    out.logentry = {
      message: SDK_MESSAGE.test(logentry.message) ? logentry.message : MESSAGE_REMOVED,
    };

  if (event.exception?.values) {
    out.exception = {
      values: event.exception.values.map((exception) => ({
        type:
          typeof exception.type === "string" ? redact(typeOf(exception), envValues) : exception.type,
        value:
          typeof exception.value !== "string"
            ? undefined
            : options.messagesLater
              ? exception.value
              : safeMessage(typeOf(exception), exception.value, options.envValues),
        mechanism: scrubMechanism(exception.mechanism),
        ...(exception.stacktrace
          ? { stacktrace: { frames: scrubFrames(exception.stacktrace.frames, options.home) } }
          : {}),
      })),
    };
  }

  if (event.breadcrumbs) {
    out.breadcrumbs = event.breadcrumbs
      .map((breadcrumb) => scrubBreadcrumb(breadcrumb, options))
      .filter((breadcrumb): breadcrumb is ScrubbableBreadcrumb => breadcrumb !== null);
  }

  // A member id is all the person is known by.
  const id = event.user?.id;
  if (typeof id === "string" && id) out.user = { id: redact(id, envValues) };

  if (event.tags) {
    const tags: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.tags))
      tags[key] = typeof value === "string" ? redact(value, envValues) : value;
    out.tags = tags;
  }

  if (event.contexts) {
    const contexts: Record<string, unknown> = {};
    for (const [name, context] of Object.entries(event.contexts)) {
      if (!CONTEXT_KEEP.has(name) || !context || typeof context !== "object") continue;
      // Trace and span ids are random, and Sentry needs them as they are.
      if (name === "trace") {
        const { trace_id, span_id, parent_span_id } = context as Record<string, unknown>;
        contexts[name] = { trace_id, span_id, parent_span_id };
        continue;
      }
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
        // `name` is a product name in most contexts ("macOS", "Chrome"), but in `device` it's the computer's.
        if (CONTEXT_DROP_KEYS.has(key) && (key !== "name" || name === "device")) continue;
        kept[key] = typeof value === "string" ? redact(value, envValues) : value;
      }
      contexts[name] = kept;
    }
    out.contexts = contexts;
  }

  // Where the error happened in the app, without query strings or fragments. Headers, cookies and bodies are dropped.
  const url = scrubUrl((event.request as { url?: unknown } | undefined)?.url, envValues);
  if (url) out.request = { url };

  return out as E;
}

/**
 * An exception's class. When the page's error event had no error object, Sentry builds one from
 * the message (`synthetic`) and knows only the standard names, so `Uncaught CompileError: …`
 * arrives as type `Error`: the class is taken back from the message.
 */
function typeOf(exception: ScrubbableException): string {
  const type = typeof exception.type === "string" ? exception.type : "";
  const named = typeof exception.value === "string" ? exception.value.match(/^Uncaught ([A-Z][A-Za-z]{2,40}): /) : null;
  return type === "Error" && named ? named[1]! : type;
}

/** How an error was caught (`onunhandledrejection`, `generic`), without the data some mechanisms attach. */
function scrubMechanism(mechanism: unknown) {
  if (!mechanism || typeof mechanism !== "object") return undefined;
  const { type, handled, synthetic, exception_id, parent_id, source, is_exception_group } =
    mechanism as Record<string, unknown>;
  return { type, handled, synthetic, exception_id, parent_id, source, is_exception_group };
}

/**
 * True when the person running this process turned error reports off: `UPLINK_NO_TELEMETRY` set
 * to anything but `0` or empty, or the cross-tool `DO_NOT_TRACK=1`.
 */
export function telemetryDisabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const off = env["UPLINK_NO_TELEMETRY"];
  return (Boolean(off) && off !== "0") || env["DO_NOT_TRACK"] === "1";
}

/**
 * A deliberate error that each process sends once when `UPLINK_TELEMETRY_TEST=1` is set, to check
 * that reports arrive with readable stack traces. Its type names it in Sentry; like every error
 * that isn't one of JavaScript's own types, it's sent without its message.
 */
export class TelemetryTestError extends Error {
  override name = "TelemetryTestError";
}

/** Whether `UPLINK_TELEMETRY_TEST=1` asks for a test error. */
export function telemetryTest(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  return env["UPLINK_TELEMETRY_TEST"] === "1";
}
