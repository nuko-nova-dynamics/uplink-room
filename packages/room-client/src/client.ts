/**
 * A small client for the Room API over HTTP (ADR 0003).
 *
 *   GET  /api/v1/functions  -> the catalog of functions, with JSON Schema inputs
 *   POST /api/v1/call       -> { fn, args } with `Authorization: Bearer <agent key>`, or a
 *                              person's CLI sign-in token from `uplink login` (ADR 0030)
 *
 * The MCP server and the command-line tool are thin layers over this class.
 */

import { acceptingRefusals } from "@uplink-room/protocol/refusals";
import { TerminalText } from "@uplink-room/protocol/terminalText";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/** For the entry points of packages built on this one, such as uplink-notetaker. */
export { onClosedOutput } from "@uplink-room/protocol/closedOutput";

export const API_VERSION = "v1";

export type JsonSchema = Record<string, unknown>;

export type RoomFunction = {
  name: string;
  kind: "query" | "mutation";
  /**
   * `team` functions act in one team; `account` functions act for a person signed in with
   * `uplink login`, in no team, and agent keys can't call them; `run` functions act as one joined run,
   * with its own token only (ADR 0032). Older deployments don't say: team.
   */
  realm?: "team" | "account" | "pair" | "run";
  description: string;
  /** The scope an agent key needs; `account` for account functions. */
  scope: string;
  inputSchema: JsonSchema;
};

/** True for a person's CLI sign-in token (`urs_…`, from `uplink login`), false for an agent key. */
export function isCliSignInToken(key: string): boolean {
  return key.startsWith("urs_");
}

export type RoomCatalog = {
  version: string;
  scopes: Record<string, string>;
  functions: RoomFunction[];
};

export type RoomClientOptions = {
  /** The Convex deployment's site URL, such as `http://127.0.0.1:3211`. */
  url: string;
  /** An agent key, or a person's CLI sign-in token from `uplink login` (`urs_…`). */
  key: string;
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
  /**
   * The deployment's client URL for live queries (`watch`). By default it is
   * derived from `url`: `https://x.convex.site` becomes `https://x.convex.cloud`,
   * and a local backend's HTTP port 3211 becomes 3210.
   */
  convexUrl?: string;
};

/** This computer's own addresses, where plain HTTP never leaves the machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Throws `insecure_url` unless `url` is HTTPS (or WSS), or plain HTTP to this computer: an agent
 * key, a CLI sign-in or Clerk's ID token sent in the clear can be read on the network (RFC 6750,
 * section 5.2). A local backend on 127.0.0.1, ::1 or localhost still works over HTTP.
 */
export function requireSecureUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RoomApiError("invalid", `Not a URL: "${url}".`, 0);
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return;
  if ((parsed.protocol === "http:" || parsed.protocol === "ws:") && LOOPBACK_HOSTS.has(parsed.hostname)) return;
  throw new RoomApiError(
    "insecure_url",
    `${parsed.origin} isn't HTTPS, so a sign-in or key sent there could be read on the network. Use the deployment's https:// address (plain http:// works only for 127.0.0.1, ::1 or localhost).`,
    0,
  );
}

/** The client URL (WebSocket) of a deployment, from its site URL (HTTP actions). */
export function clientUrlFor(siteUrl: string): string {
  const url = new URL(siteUrl);
  if (url.hostname.endsWith(".convex.site")) url.hostname = url.hostname.replace(/\.convex\.site$/, ".convex.cloud");
  else if (url.port) url.port = String(Number(url.port) - 1);
  return url.toString().replace(/\/+$/, "");
}

/** What `RoomClient.upload` returns, exactly what a message's `attachments` take. */
export type UploadedAttachment = { uploadId: string; storageId: string; name: string };

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

/** The content type for a file name's extension, as the room checks it for images and PDFs. */
export function contentTypeFor(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * An error the Room API returned, or a failure to reach it.
 * `code` is the API's error code (`forbidden`, `not_found`, ...). Failures
 * outside the API use `network_error` (status 0) and `bad_response`.
 */
export class RoomApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "RoomApiError";
    this.code = code;
    this.status = status;
  }
}

export class RoomClient {
  readonly url: string;
  readonly key: string;
  #fetch: typeof fetch;
  #convexUrl: string;
  #live: ConvexClient | undefined;

  /** Throws `insecure_url` for an address that isn't HTTPS or this computer (requireSecureUrl). */
  constructor(options: RoomClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.key = options.key;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#convexUrl = options.convexUrl ?? clientUrlFor(this.url);
    // Every request carries the key: calls go to `url`, live watches to `convexUrl`.
    requireSecureUrl(this.url);
    requireSecureUrl(this.#convexUrl);
  }

  /**
   * Watches a Room API query live: `onUpdate` runs with its result now and
   * again whenever it changes. It goes over Convex's WebSocket with the agent
   * key or CLI sign-in (`live:query`), with the same checks as `call`. Returns a
   * function that stops watching.
   */
  watch(
    fn: string,
    args: Record<string, unknown>,
    onUpdate: (result: unknown) => void,
    onError?: (error: RoomApiError) => void,
  ): () => void {
    this.#live ??= new ConvexClient(this.#convexUrl);
    const ref = makeFunctionReference<"query", { key: string; fn: string; args: Record<string, unknown> }, unknown>(
      "live:query",
    );
    // With acceptsRefusals (ADR 0046): a refusal arrives as onError, as the thrown error did.
    return acceptingRefusals(this.#live).onUpdate(ref, { key: this.key, fn, args }, onUpdate, (error) => {
      const data = (error as { data?: { code?: string; message?: string } }).data;
      onError?.(new RoomApiError(data?.code ?? "watch_failed", data?.message ?? error.message, 0));
    });
  }

  /** Closes the live connection that `watch` opened, if any. */
  async close(): Promise<void> {
    await this.#live?.close();
    this.#live = undefined;
  }

  /** Lists every Room API function the deployment offers. */
  async functions(): Promise<RoomCatalog> {
    const body = await this.#request(`/api/${API_VERSION}/functions`, { method: "GET" });
    const catalog = body as Partial<RoomCatalog> | null;
    if (!catalog || !Array.isArray(catalog.functions)) {
      throw new RoomApiError("bad_response", "The function list had an unexpected shape.", 200);
    }
    return catalog as RoomCatalog;
  }

  /** Calls one function, such as `tasks.create`, and returns its result. */
  async call(fn: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const body = (await this.#request(`/api/${API_VERSION}/call`, {
      method: "POST",
      body: JSON.stringify({ fn, args }),
      ...(options.signal ? { signal: options.signal } : {}),
    })) as { ok?: unknown; result?: unknown } | null;
    if (!body || body.ok !== true) {
      throw new RoomApiError("bad_response", "The response was not a Room API result.", 200);
    }
    return body.result ?? null;
  }

  /**
   * Uploads a file to attach to a message: asks `messages.attachUrl` for an upload URL, POSTs the
   * bytes there with their content type, and returns what `messages.post` and `messages.edit` take
   * in `attachments`. The room checks the file when a message keeps it (kinds, sizes, SVG refused).
   * `teamId` is the team whose message it's for, as every team function takes it: optional with an
   * agent key, and with a CLI sign-in when the person is in one team. A joined run's token uploads
   * for `joined.say` instead (`asRun`, ADR 0047), through `joined.attachUrl`, which takes no team.
   */
  async upload(
    bytes: Uint8Array,
    name: string,
    contentType = contentTypeFor(name),
    options: { teamId?: string; asRun?: boolean } = {},
  ): Promise<UploadedAttachment> {
    const fn = options.asRun ? "joined.attachUrl" : "messages.attachUrl";
    const target = (await this.call(fn, options.asRun ? {} : teamArg(options.teamId))) as { uploadUrl?: unknown; uploadId?: unknown } | null;
    if (typeof target?.uploadUrl !== "string" || typeof target.uploadId !== "string") {
      throw new RoomApiError("bad_response", `${fn} returned no upload URL.`, 200);
    }
    let response: Response;
    try {
      response = await this.#fetch(target.uploadUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RoomApiError("network_error", `Could not upload ${name}: ${reason}`, 0);
    }
    const body = (await response.json().catch(() => null)) as { storageId?: unknown } | null;
    if (!response.ok || typeof body?.storageId !== "string") {
      throw new RoomApiError("bad_response", `The upload of ${name} failed (HTTP ${response.status}).`, response.status);
    }
    // Only the fields messages.post and messages.edit accept; the room reads the type from the stored bytes.
    return { uploadId: target.uploadId, storageId: body.storageId, name };
  }

  async #request(path: string, init: { method: string; body?: string; signal?: AbortSignal }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RoomApiError("network_error", `Could not reach ${this.url}: ${reason}`, 0);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      if (typeof error?.code === "string") {
        throw new RoomApiError(error.code, String(error.message ?? error.code), response.status);
      }
      throw new RoomApiError(
        "bad_response",
        `HTTP ${response.status} from ${this.url}${path}: ${text.slice(0, 200)}`,
        response.status,
      );
    }
    if (body === undefined) {
      throw new RoomApiError(
        "bad_response",
        `${this.url}${path} did not return JSON.`,
        response.status,
      );
    }
    return body;
  }
}

/** `{ teamId }` for a call's arguments when there is one, else nothing. */
function teamArg(teamId: string | undefined): { teamId?: string } {
  return teamId === undefined ? {} : { teamId };
}

/**
 * The team a terminal helper's calls act in. A given `teamId` is used as is; an agent key, or a
 * person in one team, needs none. A person signed in with `uplink login` in several teams needs
 * one for every team function (ADR 0030), so it's the team whose terminals.get finds the terminal.
 */
export async function teamOfTerminal(client: RoomClient, terminalId: string, teamId?: string): Promise<string | undefined> {
  if (teamId !== undefined || !isCliSignInToken(client.key)) return teamId;
  const me = (await client.call("people.me")) as { teams?: { teamId: string }[] } | null;
  const teams = me?.teams ?? [];
  if (teams.length <= 1) return undefined;
  const found = await Promise.all(
    teams.map((team) =>
      client.call("terminals.get", { teamId: team.teamId, terminalId }).then(
        () => team.teamId,
        (error: unknown) => {
          // Not in this team; any other refusal is the answer.
          if (error instanceof RoomApiError && error.code === "not_found") return undefined;
          throw error;
        },
      ),
    ),
  );
  const match = found.find((id) => id !== undefined);
  if (!match) throw new RoomApiError("not_found", `No team of yours has the terminal ${terminalId}.`, 404);
  return match;
}

/** How a terminal stands, as terminals.read and terminals.output return it. */
type TerminalStatus = {
  status: "starting" | "live" | "ended" | "failed";
  exitCode?: number;
  runState?: string;
  failReason?: string;
};

/** What `terminals.read` returns (the parts used here). */
type TerminalRead = TerminalStatus & { text: string; cursor: number; cursorOffset?: number; more: boolean };

/** What `terminals.output` returns (the parts used here). */
type OutputPage = TerminalStatus & { chunks: { seq: number; data: string }[]; cursor: number; more: boolean };

/**
 * The most raw output run_in_terminal and wait_for_terminal read in one call. Past it they stop,
 * with `truncated` and the cursor to read the rest from, so a command that never stops printing
 * (`yes`), or one huge chunk, can't hold them or fill memory. The text they return is about as long.
 */
export const MAX_COLLECTED_CHARS = 50_000;

/** Pages of raw output read in one pass, so a frozen clock can't make a pass endless. */
const PAGES_PER_PASS = 20;

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type RunInTerminalOptions = {
  terminalId: string;
  /**
   * The terminal's team, as team functions take it. Optional: with a CLI sign-in in several teams
   * it's found from the terminal (teamOfTerminal).
   */
  teamId?: string;
  /** One command line. A newline is added to run it. */
  command: string;
  /** The longest to wait for the command, in ms (default 30 s, at most 10 min). */
  waitMs?: number;
  /** Stop once the output has been quiet this long, in ms (default 2 s). */
  idleMs?: number;
};

export type RunInTerminalResult = {
  /** What the terminal printed in this call, as plain text (for run_in_terminal, the command's echo first). */
  text: string;
  /**
   * Where to read on from: pass as terminals.read afterSeq and afterOffset (or wait_for_terminal's).
   * It never points inside an escape sequence or a character, so the next read gets those whole.
   */
  cursor: number;
  cursorOffset: number;
  /**
   * Why it stopped waiting: the terminal `ended` (exitCode says how), the shell showed its `prompt`
   * again (the command finished), its output went `quiet` for idleMs (the command may still be
   * running), `timeout` after waitMs with output still coming, or `limit`: it read
   * MAX_COLLECTED_CHARS of output, so `text` holds the start of what's there.
   */
  stopped: "ended" | "prompt" | "quiet" | "timeout" | "limit";
  /** True when the command is known to have finished: the terminal ended or the prompt came back. */
  finished: boolean;
  /** Output was left unread (`limit`, or `timeout` with more waiting): read it from the cursor. */
  truncated: boolean;
  /** Output was dropped before it could be read: the room keeps a terminal's newest output only. */
  gap: boolean;
  /** What to do next when it isn't known to have finished. */
  hint?: string;
  status: TerminalStatus["status"];
  exitCode?: number;
  runState?: string;
  /** Why the terminal failed to start, when it did. */
  failReason?: string;
  waitedMs: number;
};

/** A stretch of the raw output a reader pushed: from chunk `seq`, starting `from` characters into it. */
type Pushed = { seq: number; from: number; at: number; length: number; chunkLength: number };

/**
 * Raw output from a cursor on, fed into one converter, so text split between chunks (an escape
 * sequence, a `\r`, a word) comes out exactly as printed: nothing lost, nothing added. It reads at
 * most MAX_COLLECTED_CHARS of input per call, taking part of a chunk when that's all that fits.
 */
class TerminalReader {
  readonly text = new TerminalText();
  status: TerminalStatus = { status: "live" };
  /** Raw output waits after what was read. */
  more = false;
  /** Stopped at MAX_COLLECTED_CHARS with output left. */
  truncated = false;
  /** Output was dropped between the cursor and what came next. */
  gap = false;
  readonly #client: RoomClient;
  readonly #terminalId: string;
  readonly #teamId: string | undefined;
  readonly #start: { cursor: number; cursorOffset: number };
  /** The last chunk pushed whole, and how much of the next one was pushed. */
  #seq: number;
  #offset: number;
  readonly #pushed: Pushed[] = [];

  constructor(client: RoomClient, terminalId: string, teamId: string | undefined, cursor: number, cursorOffset = 0) {
    this.#client = client;
    this.#terminalId = terminalId;
    this.#teamId = teamId;
    this.#start = { cursor, cursorOffset };
    this.#seq = cursor;
    this.#offset = cursorOffset;
  }

  /** Reads what's new, page by page, until none is left, `deadline` passes or the budget. True if any came. */
  async readNew(deadline: number, clock: Clock): Promise<boolean> {
    let got = false;
    for (let page = 0; page < PAGES_PER_PASS; page++) {
      const out = (await this.#client.call("terminals.output", {
        ...teamArg(this.#teamId),
        terminalId: this.#terminalId,
        afterSeq: this.#seq,
        limit: 16,
      })) as OutputPage;
      this.status = { status: out.status, exitCode: out.exitCode, runState: out.runState, failReason: out.failReason };
      this.more = out.more;
      for (const chunk of out.chunks) {
        let from = 0;
        if (chunk.seq === this.#seq + 1) from = Math.min(this.#offset, chunk.data.length);
        else this.gap = true; // The chunks after the cursor were dropped; its offset meant one of them.
        const room = MAX_COLLECTED_CHARS - this.text.consumed;
        const take = Math.min(chunk.data.length - from, Math.max(room, 0));
        if (take > 0) {
          this.#pushed.push({ seq: chunk.seq, from, at: this.text.consumed, length: take, chunkLength: chunk.data.length });
          this.text.push(chunk.data.slice(from, from + take));
          got = true;
        }
        if (from + take < chunk.data.length) {
          // Out of budget inside this chunk: stop here, with the rest for the next call.
          this.#seq = chunk.seq - 1;
          this.#offset = from + take;
          this.truncated = true;
          this.more = true;
          return got;
        }
        this.#seq = chunk.seq;
        this.#offset = 0;
      }
      if (!out.more || clock.now() >= deadline) break;
    }
    return got;
  }

  get ended(): boolean {
    return this.status.status === "ended" || this.status.status === "failed";
  }

  /** Where to read on from: after what was pushed, less what the converter holds back unfinished. */
  get resume(): { cursor: number; cursorOffset: number } {
    const p = this.text.consumed - this.text.pendingLength;
    if (this.#pushed.length === 0) return this.#start;
    for (const part of this.#pushed) {
      if (p < part.at + part.length) return { cursor: part.seq - 1, cursorOffset: part.from + (p - part.at) };
    }
    const last = this.#pushed.at(-1)!;
    return last.from + last.length === last.chunkLength
      ? { cursor: last.seq, cursorOffset: 0 }
      : { cursor: last.seq - 1, cursorOffset: last.from + last.length };
  }

  /** The resume position as terminals.read arguments, for hints, with the team when one was named or found. */
  get resumeArgs(): string {
    const { cursor, cursorOffset } = this.resume;
    const team = this.#teamId === undefined ? "" : `teamId: ${this.#teamId}, `;
    return cursorOffset ? `${team}afterSeq: ${cursor}, afterOffset: ${cursorOffset}` : `${team}afterSeq: ${cursor}`;
  }

  result(stopped: RunInTerminalResult["stopped"], waitedMs: number, hint: string | undefined): RunInTerminalResult {
    const finished = stopped === "ended" || stopped === "prompt";
    return {
      // The last line may go on past the cursor, so its trailing spaces stay: resumed reads join exactly.
      text: this.text.text({ partial: true }),
      ...this.resume,
      stopped,
      finished,
      truncated: this.truncated || (stopped === "timeout" && this.more),
      gap: this.gap,
      ...(finished || !hint ? {} : { hint }),
      status: this.status.status,
      ...(this.status.exitCode !== undefined ? { exitCode: this.status.exitCode } : {}),
      ...(this.status.runState !== undefined ? { runState: this.status.runState } : {}),
      ...(this.status.failReason ? { failReason: this.status.failReason } : {}),
      waitedMs,
    };
  }
}

/** The hint for output left unread at the budget. */
function limitHint(reader: TerminalReader): string {
  return `It read ${MAX_COLLECTED_CHARS} characters of output, so text holds the start of what's there. Read the rest with terminals.read {terminalId, ${reader.resumeArgs}}.`;
}

/**
 * Types one command into a terminal the caller drives and waits for what it prints: until the
 * terminal ends, the prompt comes back, its output goes quiet for `idleMs`, `waitMs` passes, or
 * it has read MAX_COLLECTED_CHARS of output. The deadline holds whatever the terminal prints.
 * Built on terminals.read, terminals.input and terminals.output, so it needs room.read and terminals.drive.
 */
export async function runInTerminal(
  client: RoomClient,
  options: RunInTerminalOptions,
  clock: Clock = realClock,
): Promise<RunInTerminalResult> {
  const waitMs = Math.max(1000, Math.min(options.waitMs ?? 30_000, 600_000));
  const idleMs = Math.max(250, Math.min(options.idleMs ?? 2_000, waitMs));
  const teamId = await teamOfTerminal(client, options.terminalId, options.teamId);
  // The tail before typing: its last line is the shell's prompt, which comes back when the command ends.
  const before = (await client.call("terminals.read", { ...teamArg(teamId), terminalId: options.terminalId, maxChars: 2000 })) as TerminalRead;
  const prompt = before.text.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (before.status === "ended" || before.status === "failed") {
    throw new RoomApiError(
      "invalid",
      `This terminal has ${before.status === "ended" ? "ended" : "failed to start"}${before.failReason ? ` (${before.failReason})` : ""}. Start another with runs.start.`,
      400,
    );
  }
  const command = options.command.replace(/[\r\n]+$/, "");
  if (!command.trim()) throw new RoomApiError("invalid", "Pass a command to run.", 400);
  await client.call("terminals.input", { ...teamArg(teamId), terminalId: options.terminalId, data: `${command}\n` });

  const started = clock.now();
  const deadline = started + waitMs;
  const reader = new TerminalReader(client, options.terminalId, teamId, before.cursor, before.cursorOffset ?? 0);
  let lastOutput = started;
  for (;;) {
    await clock.sleep(400);
    if (await reader.readNew(deadline, clock)) lastOutput = clock.now();
    const now = clock.now();
    const waited = now - started;
    if (reader.truncated) return reader.result("limit", waited, limitHint(reader));
    if (!reader.more && reader.ended) return reader.result("ended", waited, undefined);
    const lines = reader.text.text().trimEnd().split("\n");
    if (!reader.more && prompt && lines.length > 1 && lines.at(-1)!.trim() === prompt) {
      return reader.result("prompt", waited, undefined);
    }
    const next = `the command may still be running. Read the rest with terminals.read {terminalId, ${reader.resumeArgs}} until the shell's prompt comes back.`;
    if (now >= deadline) {
      const coming = reader.more || now - lastOutput < idleMs;
      return reader.result(
        coming ? "timeout" : "quiet",
        waited,
        coming ? `Still printing after ${waitMs} ms; ${next}` : `No output for ${idleMs} ms; ${next}`,
      );
    }
    if (!reader.more && reader.text.length > 0 && now - lastOutput >= idleMs) {
      return reader.result("quiet", waited, `No output for ${idleMs} ms; ${next}`);
    }
  }
}

export type WaitForTerminalOptions = {
  terminalId: string;
  /** The terminal's team, as in RunInTerminalOptions: found from the terminal when left out. */
  teamId?: string;
  /** The longest to wait, in ms (default 60 s, at most 10 min). */
  waitMs?: number;
  /** Read only what came after this cursor (default: everything the terminal printed). */
  afterSeq?: number;
  /** With afterSeq, how far into the next chunk an earlier read got (its cursorOffset). */
  afterOffset?: number;
};

/**
 * Waits for a terminal to end, such as a runs.start `command`, and returns everything it printed,
 * as plain text, with its exit code: until it ends, `waitMs` passes, or it has read
 * MAX_COLLECTED_CHARS of output. Needs only room.read. Returns the same shape as runInTerminal,
 * with `stopped` "ended", "timeout" or "limit".
 */
export async function waitForTerminal(
  client: RoomClient,
  options: WaitForTerminalOptions,
  clock: Clock = realClock,
): Promise<RunInTerminalResult> {
  const waitMs = Math.max(1000, Math.min(options.waitMs ?? 60_000, 600_000));
  const teamId = await teamOfTerminal(client, options.terminalId, options.teamId);
  const started = clock.now();
  const deadline = started + waitMs;
  const reader = new TerminalReader(client, options.terminalId, teamId, options.afterSeq ?? 0, options.afterOffset ?? 0);
  for (let first = true; ; first = false) {
    if (!first) await clock.sleep(500);
    await reader.readNew(deadline, clock);
    const waited = clock.now() - started;
    if (reader.truncated) return reader.result("limit", waited, limitHint(reader));
    if (!reader.more && reader.ended) return reader.result("ended", waited, undefined);
    if (clock.now() >= deadline) {
      return reader.result(
        "timeout",
        waited,
        `The terminal is still ${reader.status.status} after ${waitMs} ms. Wait again with ${reader.resumeArgs}, or read it with terminals.read; an interactive shell ends only when you type exit.`,
      );
    }
  }
}

export type WaitForRunsOptions = {
  /** The cursor an earlier result returned. Without it, the wait starts from now. */
  after?: number;
  /** Follow these runs instead of the ones you drive or started (at most 50). */
  runIds?: string[];
  /** The team, when you're in several. */
  teamId?: string;
  /** The longest to wait, in ms (default 50 s, under an MCP client's usual 60 s timeout; at most 10 min). */
  waitMs?: number;
  /** Stops the wait early, such as when the MCP client cancels the call. */
  signal?: AbortSignal;
};

export type WaitForRunsResult = {
  /** The runs that changed, oldest change first, as runs.get shows them. */
  changes: unknown[];
  /** Pass as after next time, so nothing is missed between waits. */
  cursor: number;
  /** More changed than one call returns: wait again from cursor, which returns at once. */
  more: boolean;
  stopped: "changed" | "timeout" | "cancelled";
  waitedMs: number;
};

/**
 * Waits until a run you follow changes state (runs.changes): the runs you drive or started, or
 * those you name. It asks every 2 s, so an agent that started several runs waits on all of them in
 * one call instead of asking about each in turn.
 */
export async function waitForRuns(client: RoomClient, options: WaitForRunsOptions = {}, clock: Clock = realClock): Promise<WaitForRunsResult> {
  const waitMs = Math.max(1000, Math.min(options.waitMs ?? 50_000, 600_000));
  const base = { ...teamArg(options.teamId), ...(options.runIds ? { runIds: options.runIds } : {}) };
  type Page = { changes: unknown[]; cursor: number; more: boolean };
  const started = clock.now();
  const signal = options.signal;
  const cancelled = (cursor: number): WaitForRunsResult => ({ changes: [], cursor, more: false, stopped: "cancelled", waitedMs: clock.now() - started });
  // A call the caller cancelled mid-request ends at once (the signal aborts its fetch).
  const ask = async (args: Record<string, unknown>) => (await client.call("runs.changes", { ...base, ...args }, signal ? { signal } : {})) as Page;
  let cursor = options.after;
  try {
    if (cursor === undefined) cursor = (await ask({})).cursor;
    let backlog = false;
    for (let first = true; ; first = false) {
      if (signal?.aborted) return cancelled(cursor);
      if (clock.now() - started >= waitMs && !first) return { changes: [], cursor, more: false, stopped: "timeout", waitedMs: clock.now() - started };
      // More changed than one page shows, all runs this caller can't see: go on from there at once.
      if (!first && !backlog) await clock.sleep(Math.min(2000, Math.max(0, waitMs - (clock.now() - started))));
      if (signal?.aborted) return cancelled(cursor);
      const page = await ask({ after: cursor });
      if (page.changes.length) return { ...page, stopped: "changed", waitedMs: clock.now() - started };
      cursor = page.cursor;
      backlog = page.more;
    }
  } catch (error) {
    if (signal?.aborted) return cancelled(cursor ?? 0);
    throw error;
  }
}
