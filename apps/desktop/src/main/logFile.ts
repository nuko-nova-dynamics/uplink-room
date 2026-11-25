/**
 * The app's diagnostic log (docs/logs.md): one line per event, in rotating files, with nothing in
 * it that the error-report rules (docs/error-reports.md) wouldn't send. No Electron here, so the
 * tests (logFile.test.ts) run it in plain Node; main/log.ts wires it to the app.
 *
 * A line is `<ISO time> <LEVEL> [<scope>] <message> key=value ...`. The message is a fixed text
 * from the app's code. Every field is scrubbed before it's written:
 *  - numbers and booleans as they are;
 *  - strings through the shared redaction (tokens, the room's secrets, emails, query strings and
 *    fragments, long hex and base64 runs, quoted text), cut to 120 characters;
 *  - field names that name content or secrets (`token`, `body`, `text`, `url` with a query…) are
 *    refused outright, so a mistake in a caller drops the value instead of writing it.
 * The home folder becomes `~` in any path.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { redact } from "@uplink-room/bridge/scrub";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];
/** A file rotates once it reaches this size; `<name>.1` … `<name>.<KEEP>` are kept. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const KEEP = 4;
/** Longest field value written. */
const FIELD_LIMIT = 120;
/** At most this many fields per line; the rest are counted, not written. */
export const MAX_FIELDS = 20;
/** Objects in a field are followed this deep; deeper ones are written as `[…]`. */
export const MAX_DEPTH = 2;
/** Longest line written, in bytes (a backstop: the caps above already keep lines far shorter). */
export const MAX_LINE_BYTES = 8 * 1024;
const CUT = " …[cut]";
/** Longest message written. Messages are the app's own fixed texts, so this only guards mistakes. */
const MESSAGE_LIMIT = 200;

/** Field names that can only hold content or secrets. Their values are never written. */
const REFUSED = /^(token|secret|password|auth|authorization|cookie|key|apiKey|body|text|content|message|query|input|output|data|email|name)$/i;

/** One field value as it may be written, or undefined to leave the field out. */
export function scrubField(key: string, value: unknown, home?: string): string | undefined {
  if (REFUSED.test(key)) return "[refused]";
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : String(value);
  if (typeof value === "boolean") return String(value);
  let text = typeof value === "string" ? value.slice(0, FIELD_LIMIT * 4) : safeJson(bounded(value, 0));
  if (home && home.length > 1) text = text.split(home).join("~");
  text = redact(text).replace(/\s+/g, " ");
  if (text.length > FIELD_LIMIT) text = `${text.slice(0, FIELD_LIMIT)}…`;
  // Values with spaces or `=` are quoted, so a line splits back into its fields.
  return /[\s="]/.test(text) ? JSON.stringify(text) : text;
}

/**
 * A copy of a value small enough to serialize: objects followed MAX_DEPTH deep and MAX_FIELDS wide,
 * strings cut short. A window could otherwise hand the log an object of any size.
 */
export function bounded(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return typeof value === "string" ? value.slice(0, FIELD_LIMIT) : value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_FIELDS).map((v) => bounded(v, depth + 1));
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key in value as Record<string, unknown>) {
    if (count++ >= MAX_FIELDS) break;
    out[key] = bounded((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

/** A string cut to at most `bytes` bytes of UTF-8, with the cut marker. */
export function cutToBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let end = Math.max(0, bytes - Buffer.byteLength(CUT));
  // Back off until the cut lands on a whole character.
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > bytes - Buffer.byteLength(CUT)) end--;
  return `${text.slice(0, end)}${CUT}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** One line of the log, scrubbed. */
export function formatLine(at: Date, level: Level, scope: string, message: string, fields: Fields = {}, home?: string): string {
  const parts = [at.toISOString(), level.toUpperCase().padEnd(5), `[${scrubScope(scope)}]`, scrubMessage(message, home)];
  let written = 0;
  let dropped = 0;
  for (const key in fields) {
    if (written >= MAX_FIELDS) {
      dropped++;
      continue;
    }
    if (!/^[A-Za-z][\w.-]{0,40}$/.test(key)) continue;
    const scrubbed = scrubField(key, fields[key], home);
    if (scrubbed === undefined) continue;
    parts.push(`${key}=${scrubbed}`);
    written++;
  }
  if (dropped > 0) parts.push(`fieldsDropped=${dropped}`);
  return cutToBytes(parts.join(" "), MAX_LINE_BYTES);
}

function scrubScope(scope: string): string {
  return /^[a-z][\w.:-]{0,40}$/i.test(scope) ? scope : "other";
}

function scrubMessage(message: string, home?: string): string {
  let text = home && home.length > 1 ? message.split(home).join("~") : message;
  text = redact(text).replace(/\s+/g, " ");
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
}

/**
 * An append-only file that rotates by size: `uplink-room.log` is the newest, `.1` the one before,
 * up to `.KEEP`. Writes are synchronous, so the last lines before a crash are on disk.
 */
export class RotatingFile {
  readonly path: string;
  #size: number;
  readonly #maxBytes: number;
  readonly #keep: number;

  constructor(dir: string, name: string, maxBytes = MAX_BYTES, keep = KEEP) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, name);
    this.#maxBytes = maxBytes;
    this.#keep = keep;
    this.#size = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  /** Writes one line. A line longer than the file's cap is cut to fit, so no file ever passes it. */
  write(line: string): void {
    this.append(`${cutToBytes(line, this.#maxBytes - 1)}\n`);
  }

  /**
   * Writes text as it comes (another process's output), rotating first when it wouldn't fit. A chunk
   * longer than the cap is cut to it.
   */
  append(text: string): void {
    if (!text) return;
    const chunk = Buffer.byteLength(text) > this.#maxBytes ? cutToBytes(text, this.#maxBytes - 1) + "\n" : text;
    const bytes = Buffer.byteLength(chunk);
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.rotate();
    appendFileSync(this.path, chunk, { mode: 0o600 });
    this.#size += bytes;
  }

  rotate(): void {
    rotateFiles(this.path, this.#keep);
    this.#size = 0;
  }

  /** The last `count` lines of the current file (and the one before, if this one is short). */
  tail(count: number): string[] {
    const lines: string[] = [];
    for (const path of [this.path, `${this.path}.1`]) {
      if (lines.length >= count || !existsSync(path)) continue;
      const text = readFileSync(path, "utf8").trimEnd();
      if (text) lines.unshift(...text.split("\n").slice(-(count - lines.length)));
    }
    return lines.slice(-count);
  }
}

/** `<path>` becomes `<path>.1`, `.1` becomes `.2`, and the oldest past `keep` is deleted. */
export function rotateFiles(path: string, keep: number): void {
  const oldest = `${path}.${keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  if (existsSync(path)) renameSync(path, `${path}.1`);
}

/**
 * Writes a child process's output stream into a rotating file as it arrives, so its log rotates
 * while it runs (main/bridge.ts, `bridge.log`). Text split across chunks is decoded whole.
 */
export function pipeToRotating(stream: Readable, file: RotatingFile): void {
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer | string) => {
    try {
      file.append(typeof chunk === "string" ? chunk : decoder.write(chunk));
    } catch {
      // A full or read-only disk loses the bridge's output, never the bridge.
    }
  });
  stream.on("end", () => {
    try {
      file.append(decoder.end());
    } catch {
      // As above.
    }
  });
}
