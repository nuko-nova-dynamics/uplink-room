/**
 * Reads a request's body with a byte cap and a deadline. Convex sets no limit on a request's size
 * (except multipart bodies) and gives an HTTP action 64 MiB of memory ("HTTP Actions", Limits), so
 * `request.text()` or `request.json()` on a body from outside lets any caller send one that is too
 * big, or one that never ends. Here a declared Content-Length over the cap is refused before
 * anything is read, the stream is counted as it arrives and cancelled once it passes the cap or
 * the deadline, and the bytes are kept once.
 */

/** How long a body may take to arrive. */
export const BODY_DEADLINE_MS = 10_000;

export type BodyLimit = { maxBytes: number; deadlineMs?: number };

export type ReadBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 413 | 408 | 400; message: string };

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

function tooLarge(maxBytes: number): ReadBody {
  return { ok: false, status: 413, message: `The body is larger than ${sizeText(maxBytes)}.` };
}

export async function readBody(request: Request, { maxBytes, deadlineMs = BODY_DEADLINE_MS }: BodyLimit): Promise<ReadBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    request.body?.cancel().catch(() => {});
    return tooLarge(maxBytes);
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const stop = () => {
    reader.cancel().catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array> | "late";
      try {
        next = await Promise.race([reader.read(), late]);
      } catch {
        stop();
        return { ok: false, status: 400, message: "The body couldn't be read." };
      }
      if (next === "late") {
        stop();
        return { ok: false, status: 408, message: `The body took longer than ${deadlineMs / 1000} seconds to arrive.` };
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        stop();
        return tooLarge(maxBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  if (chunks.length === 1) return { ok: true, bytes: chunks[0]! };
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** The body as text (UTF-8), under the same cap and deadline. */
export async function readText(request: Request, limit: BodyLimit): Promise<{ ok: true; text: string } | Extract<ReadBody, { ok: false }>> {
  const body = await readBody(request, limit);
  return body.ok ? { ok: true, text: new TextDecoder().decode(body.bytes) } : body;
}

/** The body as a JSON object, or null when it isn't one; an oversized or late body is an error. */
export async function readJsonObject<T>(
  request: Request,
  limit: BodyLimit,
): Promise<{ ok: true; value: T | null } | Extract<ReadBody, { ok: false }>> {
  const body = await readText(request, limit);
  if (!body.ok) return body;
  try {
    const value = JSON.parse(body.text) as unknown;
    return { ok: true, value: value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null };
  } catch {
    return { ok: true, value: null };
  }
}
