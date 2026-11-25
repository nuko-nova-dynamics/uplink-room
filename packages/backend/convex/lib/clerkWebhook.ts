/**
 * Clerk's webhooks (ADR 0035), which Clerk sends through Svix: `POST /clerk/webhook`. Checked by
 * hand against Svix's documented scheme ("Verifying Webhooks Manually", docs.svix.com), on Web
 * Crypto so it runs in Convex's default runtime, as the GitHub webhook's check does:
 *
 * - `svix-id`, `svix-timestamp` (seconds) and `svix-signature` must all be there.
 * - The timestamp must be within WEBHOOK_TOLERANCE_S of the room's clock, either way, as Svix's own
 *   libraries require ("Why Verify Webhooks"), so a delivery captured off the wire can't be sent
 *   again later.
 * - `svix-signature` is a space-separated list of `v1,<base64>`; one of them must equal the base64
 *   HMAC-SHA256 of `<svix-id>.<svix-timestamp>.<raw body>`, keyed with the signing secret's base64
 *   part (after `whsec_`), compared in constant time.
 *
 * A delivery sent again within the tolerance has the same `svix-id`, which the room keeps
 * (`clerkDeliveries`), so it changes nothing twice.
 */
import { timingSafeEqualText } from "./github/crypto";

export const CLERK_WEBHOOK_PATH = "/clerk/webhook";

/** How far a delivery's timestamp may be from the room's clock, either way: Svix's libraries' five minutes. */
export const WEBHOOK_TOLERANCE_S = 5 * 60;

/**
 * The largest body read. The room acts only on `user.deleted`, whose `data` is three fields; a
 * whole User object, which other events carry, is far below this.
 */
export const CLERK_WEBHOOK_BODY_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/**
 * The keys of the endpoint's signing secrets: `CLERK_WEBHOOK_SIGNING_SECRET`, Clerk's name for it,
 * or several separated by commas, as `CLERK_JWT_ISSUER_DOMAIN` lists instances (ADR 0014), for a
 * deployment that takes webhooks from two Clerk instances. Null when none is set. A secret that
 * isn't base64 after `whsec_` is a deployment mistake, and throws.
 */
export async function clerkWebhookKeys(): Promise<CryptoKey[] | null> {
  const secrets = (process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!secrets.length) return null;
  const keys: CryptoKey[] = [];
  for (const secret of secrets) {
    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
    } catch {
      throw new Error("CLERK_WEBHOOK_SIGNING_SECRET isn't a Clerk signing secret (whsec_ and base64).");
    }
    if (!raw.length) throw new Error("CLERK_WEBHOOK_SIGNING_SECRET isn't a Clerk signing secret (whsec_ and base64).");
    keys.push(await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  return keys;
}

export type WebhookCheck = { ok: true; id: string } | { ok: false; status: 400 | 401; message: string };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Checks one delivery's headers and raw body against the endpoint's keys, at `nowMs`. */
export async function verifyClerkWebhook(keys: CryptoKey[], headers: Headers, body: Uint8Array, nowMs: number): Promise<WebhookCheck> {
  const id = headers.get("svix-id") ?? "";
  const timestamp = headers.get("svix-timestamp") ?? "";
  const signatures = headers.get("svix-signature") ?? "";
  if (!id || !timestamp || !signatures) return { ok: false, status: 400, message: "Missing svix-id, svix-timestamp or svix-signature." };
  if (id.length > 200 || signatures.length > 4096) return { ok: false, status: 400, message: "A Svix header is too long." };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, status: 400, message: "svix-timestamp isn't a time in seconds." };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) {
    return { ok: false, status: 401, message: "This delivery's timestamp is more than five minutes from now." };
  }

  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const given = signatures
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice("v1,".length));
  for (const key of keys) {
    const expected = base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed as BufferSource)));
    // Every candidate is compared, so the time taken doesn't say which one matched.
    let match = false;
    for (const signature of given) if (timingSafeEqualText(expected, signature)) match = true;
    if (match) return { ok: true, id };
  }
  return { ok: false, status: 401, message: "This delivery isn't signed with this endpoint's signing secret." };
}

/** The Clerk user a verified `user.deleted` event names, or null for any other event. */
export function deletedUser(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const { type, data } = event as { type?: unknown; data?: { id?: unknown } | null };
  if (type !== "user.deleted" || !data || typeof data.id !== "string") return null;
  const id = data.id.trim();
  return id && id.length <= 200 ? id : null;
}
