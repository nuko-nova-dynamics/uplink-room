/**
 * The window's side of the diagnostic log (docs/logs.md). Each line goes to the main process,
 * which writes it to `uplink-room.log` as `[renderer:<scope>]`, and becomes a Sentry breadcrumb
 * when error reports are on. The last lines stay in memory for "Copy diagnostics".
 *
 * Callers pass a fixed message and fields made of ids, counts, states and reasons: never message
 * bodies, terminal text, names, tokens or URLs with secrets. Fields are scrubbed here (strings
 * through the shared redaction, content-like field names refused) and again in the main process.
 *
 * Also here: the window's uncaught errors go to the log, with the error's type, a message cut to
 * what's safe to keep (`safeMessage`), and where it was thrown. A script run from a `blob:` URL
 * (Krisp's code, for one) is named by the bundle that made it, since no source map covers it.
 */
import * as Sentry from "@sentry/electron/renderer";
import { redact, safeMessage } from "@uplink-room/bridge/scrub";
import { desktop } from "./desktop";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, string | number | boolean | null | undefined>;
export type Line = { at: number; level: Level; scope: string; message: string; fields: Fields };

const REFUSED = /^(token|secret|password|auth|authorization|cookie|key|apiKey|body|text|content|message|query|input|output|data|email|name)$/i;
const KEPT = 400;
const recent: Line[] = [];
const listeners = new Set<() => void>();

function scrub(fields: Fields | undefined): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    if (REFUSED.test(key)) out[key] = "[refused]";
    else if (typeof value === "string") out[key] = redact(value).slice(0, 120);
    else out[key] = value;
  }
  return out;
}

function write(level: Level, scope: string, message: string, fields?: Fields) {
  const line: Line = { at: Date.now(), level, scope, message: redact(message).slice(0, 200), fields: scrub(fields) };
  recent.push(line);
  if (recent.length > KEPT) recent.splice(0, recent.length - KEPT);
  for (const listener of listeners) listener();
  try {
    desktop.log?.(level, scope, line.message, line.fields);
  } catch {
    // The main process went away; the line stays in memory.
  }
  if (level !== "debug") {
    try {
      Sentry.addBreadcrumb({ category: "uplink", level: level === "warn" ? "warning" : level, message: `[${scope}] ${format(line)}` });
    } catch {
      // Error reports aren't started.
    }
  }
  if (import.meta.env.DEV && level !== "debug") console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${scope}]`, format(line));
}

/** A line's message and fields, as the log file shows them. */
export function format(line: Pick<Line, "message" | "fields">): string {
  const fields = Object.entries(line.fields).map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v)}`);
  return [line.message, ...fields].join(" ");
}

export const log = {
  debug: (scope: string, message: string, fields?: Fields) => write("debug", scope, message, fields),
  info: (scope: string, message: string, fields?: Fields) => write("info", scope, message, fields),
  warn: (scope: string, message: string, fields?: Fields) => write("warn", scope, message, fields),
  error: (scope: string, message: string, fields?: Fields) => write("error", scope, message, fields),
};

/** The window's recent lines, newest last. */
export function recentLines(): readonly Line[] {
  return recent;
}

export function onLogLine(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------- errors ----------

/** An error's message as it may be kept: the shared rules (packages/bridge/src/telemetry/scrub.ts). */
export { safeMessage };

/**
 * An error's type and safe message, for a log line. The window doesn't know the environment's
 * values, so a message is kept only when it has nothing to template (safeMessage without them).
 */
export function errorFields(error: unknown): { type: string; reason: string } {
  if (error instanceof Error || (error && typeof error === "object" && "message" in error)) {
    const e = error as Error;
    const type = (e.name && e.name !== "Error" ? e.name : e.constructor?.name) || "Error";
    return { type, reason: safeMessage(type, String(e.message ?? "")) };
  }
  return { type: typeof error, reason: safeMessage(typeof error, String(error)) };
}

// ---------- blob scripts ----------

/** Which bundle made each `blob:` URL, by URL. */
const blobOrigins = new Map<string, string>();

/** The bundle file a stack's caller is in: `assets/dist-BFz9EMo2.js`, without the origin or query. */
function callerFile(stack: string | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n").slice(2)) {
    const match = line.match(/((?:https?|uplink-room|file):\/\/[^\s)]+?):\d+:\d+/);
    if (match) {
      try {
        return new URL(match[1]!).pathname.replace(/^\//, "");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Notes which bundle makes each script blob. Krisp's noise filter turns its code into a `blob:`
 * script; an error thrown there names only the blob, which no source map covers, so reports and
 * log lines name the bundle that made it instead.
 */
export function watchBlobScripts(): void {
  if (typeof URL === "undefined" || (URL as unknown as { __uplinkWatched?: boolean }).__uplinkWatched) return;
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = create(object);
    try {
      if (object instanceof Blob && /javascript|wasm|text\/plain|^$/.test(object.type)) {
        const origin = callerFile(new Error().stack) ?? "unknown";
        blobOrigins.set(url, origin);
        log.debug("blob", "script blob made", { origin, type: object.type || "none", bytes: object.size });
      }
    } catch {
      // Noting the origin is best effort.
    }
    return url;
  };
  (URL as unknown as { __uplinkWatched?: boolean }).__uplinkWatched = true;
}

/** `blob:<origin>/<uuid>` as the bundle that made it (`app:///blob/assets/dist-BFz9EMo2.js`), or the input. */
export function nameBlob(file: string): string {
  if (!file.startsWith("blob:")) return file;
  const made = blobOrigins.get(file);
  return made ? `app:///blob/${made}` : "app:///blob/unknown";
}

/** Rewrites an event's `blob:` frames to the bundle that made them, for a Sentry event. */
export function nameBlobFrames<E extends { exception?: { values?: { stacktrace?: { frames?: { filename?: string; abs_path?: string; in_app?: boolean }[] } }[] } }>(event: E): E {
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      for (const key of ["filename", "abs_path"] as const) {
        const file = frame[key];
        if (typeof file === "string" && file.startsWith("blob:")) {
          frame[key] = nameBlob(file);
          frame.in_app = false;
        }
      }
    }
  }
  return event;
}

/** The window's uncaught errors and rejections, in the log. */
export function logUncaught(): void {
  window.addEventListener("error", (event) => {
    const where = event.filename ? `${nameBlob(event.filename)}:${event.lineno}:${event.colno}` : "unknown";
    log.error("uncaught", "uncaught error", { ...errorFields(event.error ?? event.message), where: where.replace(/^[a-z-]+:\/\/app\//, "") });
  });
  window.addEventListener("unhandledrejection", (event) => {
    log.error("uncaught", "unhandled rejection", errorFields(event.reason));
  });
}
