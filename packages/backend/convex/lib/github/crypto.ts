/**
 * The cryptography the GitHub App needs (ADR 0020), on Web Crypto so it runs in Convex's default
 * runtime: webhook signatures, the connect flow's signed state and PKCE, and the App's JWT.
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Compares in time that depends only on the lengths, which aren't secret here (a hex digest or a
 * fixed-size token), so a timing difference tells nothing about where two values differ.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function timingSafeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * GitHub signs each delivery with the webhook secret: `X-Hub-Signature-256: sha256=<hex HMAC of
 * the body>`. The body is the raw bytes GitHub sent, before any parsing.
 */
export async function verifyWebhookSignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = `sha256=${hex(await hmac(await hmacKey(encoder.encode(secret)), body))}`;
  return timingSafeEqualText(expected, header);
}

/**
 * The key that signs the connect flow's state. It comes from the App's client secret through
 * HKDF, so the deployment needs no extra secret, and the derived key is used for nothing else.
 */
export async function stateKey(clientSecret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(clientSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("uplink-room"), info: encoder.encode("github connect state v1") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** What a state is bound to: one team, one admin, one expiry. */
export type StateBinding = { teamId: string; memberId: string; expiresAt: number };

function stateMessage(nonce: string, b: StateBinding): Uint8Array {
  return encoder.encode(`uplink-room github connect:${nonce}:${b.teamId}:${b.memberId}:${b.expiresAt}`);
}

/** The state GitHub carries: a random nonce and its signature over the team, the admin and the expiry. */
export async function signState(key: CryptoKey, nonce: string, binding: StateBinding): Promise<string> {
  return `${nonce}.${base64url(await hmac(key, stateMessage(nonce, binding)))}`;
}

/** The state's nonce, if it has the right shape. The signature is checked against its row (`checkState`). */
export function stateNonce(state: string | null | undefined): string | null {
  if (!state || state.length > 200) return null;
  const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(state);
  return match ? match[1]! : null;
}

export async function checkState(key: CryptoKey, state: string, binding: StateBinding): Promise<boolean> {
  const nonce = stateNonce(state);
  if (!nonce) return false;
  return timingSafeEqualText(await signState(key, nonce, binding), state);
}

/** PKCE's S256 challenge for a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

// ---------- the App's JWT ----------

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let left = n; left > 0; left >>= 8) bytes.unshift(left & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const length = derLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** rsaEncryption (1.2.840.113549.1.1.1) with its NULL parameters. */
const RSA_ALGORITHM = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);

/** Wraps a PKCS #1 RSA key (GitHub's download, `BEGIN RSA PRIVATE KEY`) as PKCS #8, which Web Crypto imports. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), RSA_ALGORITHM, der(0x04, pkcs1)));
}

/** The DER inside a PEM, as PKCS #8. Accepts `BEGIN PRIVATE KEY` (PKCS #8) and `BEGIN RSA PRIVATE KEY` (PKCS #1). */
export function privateKeyDer(pem: string): Uint8Array {
  const text = pem.replaceAll("\\n", "\n").trim();
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!match) throw new Error("GITHUB_APP_PRIVATE_KEY isn't a PEM private key.");
  const body = fromBase64(match[2]!.replace(/\s+/g, ""));
  return match[1] ? pkcs1ToPkcs8(body) : body;
}

/**
 * A JWT that authenticates as the App, for 9 minutes: RS256, `iat` 60 seconds in the past for
 * clock drift and `exp` under GitHub's 10-minute limit ("Generating a JSON Web Token (JWT) for a
 * GitHub App"). GitHub takes the client ID or the App ID as `iss`; this sends the App ID, a JSON
 * number, which GitHub parses without a lookup (with an unknown client ID it answered "'Issuer'
 * claim ('iss') must be an Integer").
 */
export async function appJwt(opts: { appId: number; privateKeyPem: string; now?: number }): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer(opts.privateKeyPem) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 9 * 60, iss: opts.appId })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}
