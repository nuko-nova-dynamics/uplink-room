/**
 * The token the room sends to an agent's gateway (ADR 0012). It is not an agent
 * key: an agent key lets the agent act in the room, while this lets the room
 * send work to the agent. It is kept in its own table, sealed with AES-GCM
 * under `A2A_CREDENTIALS_KEY` (32 random bytes, base64, in the deployment's
 * environment), and bound to its peer so a sealed value can't be moved to
 * another one. Only the A2A worker opens it: in an action, just before a call,
 * and in the mutation that saves what the agent reported, to take the token out
 * of it after streamed pieces are joined (a2aWorker.observed, ADR 0018). No
 * query, Room API answer or activity row carries it.
 */
import { roomError } from "../errors";

export const CREDENTIALS_KEY_ENV = "A2A_CREDENTIALS_KEY";

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function key(): Promise<CryptoKey> {
  const raw = process.env[CREDENTIALS_KEY_ENV];
  let bytes: Uint8Array | null = null;
  try {
    bytes = raw ? fromBase64(raw.trim()) : null;
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 32) {
    throw roomError(
      "not_configured",
      `Storing an agent's token needs ${CREDENTIALS_KEY_ENV} on the deployment: 32 random bytes in base64 (openssl rand -base64 32).`,
    );
  }
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export type Sealed = { ciphertext: string; iv: string };

export async function sealSecret(secret: string, boundTo: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(boundTo) },
    await key(),
    new TextEncoder().encode(secret),
  );
  return { ciphertext: toBase64(new Uint8Array(data)), iv: toBase64(iv) };
}

export async function openSecret(sealed: Sealed, boundTo: string): Promise<string> {
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(sealed.iv) as BufferSource,
      additionalData: new TextEncoder().encode(boundTo),
    },
    await key(),
    fromBase64(sealed.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(data);
}

/** What a token is sealed to: its endpoint and the origin it was given for, so it opens for no other. */
export function credentialBinding(peerId: string, origin: string): string {
  return `${peerId}|${origin}`;
}

/** The last four characters, for "…abcd" in the app. Short secrets show nothing. */
export function hintOf(secret: string): string {
  return secret.length >= 12 ? `…${secret.slice(-4)}` : "…";
}
