/**
 * Invite tokens and the links that carry them.
 *
 * The room checks a token against its SHA-256 (`invites.tokenHash`), as with every secret. It also
 * keeps the current token sealed with AES-GCM (`invites.sealedToken`), so the invite email, its
 * reminder and Copy link can hand out the same link later.
 *
 * The keys come from `INVITE_TOKEN_KEYS`: `id:key` entries separated by commas, each key 32
 * random bytes in base64 (docs/email.md). New tokens are sealed with the first entry, and a sealed
 * token names its key's id, so it opens with that entry wherever it sits in the list. To rotate,
 * put a new entry first and keep the old ones until the invites sealed with them have expired.
 * Without the variable nothing is sealed: invites still work, but no email can carry their link
 * and Copy link can't show it again.
 *
 * A seal is bound to its invite and token generation, so it opens for no other invite and no
 * older token.
 */
import type { Id } from "../_generated/dataModel";

export type SealedToken = { ciphertext: string; iv: string; keyId?: string };

export const KEYS_ENV = "INVITE_TOKEN_KEYS";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

type Key = { id: string; key: CryptoKey };

/**
 * The deployment's sealing keys, in order. A malformed entry is left out with a warning that names
 * its position or id, never its key.
 */
async function sealingKeys(): Promise<Key[]> {
  const keys: Key[] = [];
  const entries = (process.env[KEYS_ENV] ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  for (const [i, entry] of entries.entries()) {
    const colon = entry.indexOf(":");
    const id = entry.slice(0, colon);
    if (colon <= 0 || !KEY_ID.test(id)) {
      console.warn(`${KEYS_ENV}: entry ${i + 1} has no valid id (letters, digits, - and _), so it's skipped.`);
      continue;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = fromBase64(entry.slice(colon + 1).trim());
    } catch {
      bytes = null;
    }
    if (!bytes || bytes.length !== 32) {
      console.warn(`${KEYS_ENV}: key "${id}" isn't 32 bytes in base64, so it's skipped.`);
      continue;
    }
    if (keys.some((k) => k.id === id)) {
      console.warn(`${KEYS_ENV}: key id "${id}" appears twice; the first one counts.`);
      continue;
    }
    const key = await crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    keys.push({ id, key });
  }
  return keys;
}

function binding(inviteId: Id<"invites">, generation: number): Uint8Array {
  return new TextEncoder().encode(`${inviteId}|${generation}`);
}

/** Seals a token for this invite and generation with the first key, or null when there's none. */
export async function sealInviteToken(
  token: string,
  inviteId: Id<"invites">,
  generation: number,
): Promise<SealedToken | null> {
  const [first] = await sealingKeys();
  if (!first) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: binding(inviteId, generation) as BufferSource },
    first.key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: toBase64(new Uint8Array(data)), iv: toBase64(iv), keyId: first.id };
}

/**
 * The sealed token, or null when it can't be opened: its key's id is no longer in
 * `INVITE_TOKEN_KEYS`, or the seal is for another invite or token.
 */
export async function openInviteToken(
  sealed: SealedToken,
  inviteId: Id<"invites">,
  generation: number,
): Promise<string | null> {
  const key = (await sealingKeys()).find((k) => k.id === sealed.keyId);
  if (!key) return null;
  try {
    const data = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(sealed.iv) as BufferSource,
        additionalData: binding(inviteId, generation) as BufferSource,
      },
      key.key,
      fromBase64(sealed.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
}

/** Whether this deployment can seal tokens, which emailing an invite needs. */
export async function canSealTokens(): Promise<boolean> {
  return (await sealingKeys()).length > 0;
}

/**
 * The website the links point to: uplinkroom.com, or `UPLINK_SITE_URL` (an https origin), so a
 * development deployment can link to a preview of the site.
 */
export function siteOrigin(): string {
  const configured = process.env["UPLINK_SITE_URL"]?.trim().replace(/\/+$/, "");
  if (configured && /^https:\/\/[a-z0-9.-]+$/i.test(configured)) return configured;
  return "https://uplinkroom.com";
}

/**
 * The join link. The token rides in the fragment, which browsers never send to a server, so it
 * stays out of every request log on the way. The page (apps/site/app/invite) hands it to the app.
 */
export function inviteUrl(token: string): string {
  return `${siteOrigin()}/invite#${token}`;
}

/**
 * A link that opens a place in the app (apps/site/app/open), such as
 * `team/<teamId>/settings/machines`. Ids only, never a secret.
 */
export function openUrl(path: string): string {
  return `${siteOrigin()}/open#${path}`;
}

export function downloadUrl(): string {
  return `${siteOrigin()}/download`;
}
