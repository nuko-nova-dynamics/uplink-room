/**
 * Checks the OpenID Connect ID tokens Clerk issues to the `uplink` command line (ADR 0030), on
 * Web Crypto so it runs in Convex's default runtime. The checks are OpenID Connect Core's for an
 * ID token (3.1.3.7) as Clerk documents its claims ("Use OAuth for Single Sign-On", the ID token
 * table): RS256, signed by a key in the issuer's JWKS (`/.well-known/jwks.json`), `iss` the
 * issuer, `aud` the command line's client ID, not expired. The nonce is checked by its row
 * (cliSignIns.finish), so each ID token makes one sign-in.
 *
 * It also checks the OAuth access tokens Clerk issues to a remote connector (verifyAccessToken,
 * ADR 0031): RFC 9068's checks, with `aud` exactly the room's MCP endpoint.
 *
 * `convex/auth.config.ts` stays as it is (ADR 0014): these tokens never reach Convex auth.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The scopes `uplink login` asks for: no `offline_access`, so Clerk issues no refresh token. */
export const CLI_SCOPES = "openid profile email";

/** Clock difference allowed between Clerk and the room, in seconds. */
const LEEWAY_S = 60;

/** The Clerk instances this deployment trusts, read the way `auth.config.ts` reads them (ADR 0014). */
export function trustedIssuers(): string[] {
  return (process.env.CLERK_JWT_ISSUER_DOMAIN ?? "")
    .split(",")
    .map((domain) => domain.trim().replace(/\/+$/, ""))
    .filter((domain, i, all) => domain !== "" && all.indexOf(domain) === i);
}

export type CliSignInConfig = { issuer: string; clientId: string };

/**
 * Where `uplink login` signs in: the first Clerk instance in `CLERK_JWT_ISSUER_DOMAIN` (production
 * lists its own first), and `CLERK_CLI_CLIENT_ID`, the client ID of the command line's OAuth
 * application on that instance. Null until both are set.
 */
export function cliSignInConfig(): CliSignInConfig | null {
  const clientId = process.env.CLERK_CLI_CLIENT_ID?.trim();
  const issuer = trustedIssuers()[0];
  return clientId && issuer ? { issuer, clientId } : null;
}

/** Why a token was refused. The message is safe to show the person signing in. */
export class TokenRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRejected";
  }
}

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
  email?: string;
  picture?: string;
};

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TokenRejected("it isn't a JWT");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function jsonPart(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64url(value))) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TokenRejected) throw error;
  }
  throw new TokenRejected("it isn't a JWT");
}

/**
 * The issuers' signing keys, held in this isolate's memory and shared by every token check here
 * (the connector's access tokens and the command line's ID tokens). Anyone can send a token that
 * names a trusted issuer and any `kid`, so a token never decides on its own that Clerk is asked:
 *  - the keys are kept for JWKS_TTL_MS, Clerk's own verifier's TTL (`@clerk/backend`,
 *    MAX_CACHE_LAST_UPDATED_AT_SECONDS, 5 minutes);
 *  - a `kid` the cached keys lack fetches again only when the last fetch is UNKNOWN_KID_REFETCH_MS
 *    old, so a rotated key works within that time and made-up `kid`s fetch at most that often
 *    (Clerk's verifier fetches for every unknown `kid`);
 *  - callers that need the keys while a fetch is under way wait for that fetch;
 *  - a fetch gives up after JWKS_TIMEOUT_MS.
 */
const JWKS_TTL_MS = 5 * 60_000;
const UNKNOWN_KID_REFETCH_MS = 10_000;
const JWKS_TIMEOUT_MS = 5_000;
/** More keys than an issuer publishes; the rest of a JWKS is ignored. */
const MAX_KEYS = 20;

type IssuerKeys = { keys: Map<string, CryptoKey>; fetchedAt: number };
const issuerKeys = new Map<string, { known?: IssuerKeys; fetching?: Promise<IssuerKeys>; lastFetchAt: number }>();

async function fetchKeys(issuer: string, startedAt: number): Promise<IssuerKeys> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TokenRejected(`the room couldn't reach ${issuer} for its keys (no answer in ${JWKS_TIMEOUT_MS / 1000} seconds)`));
    }, JWKS_TIMEOUT_MS);
  });
  const load = async (): Promise<IssuerKeys> => {
    let response: Response;
    try {
      response = await fetch(`${issuer}/.well-known/jwks.json`, { signal: controller.signal });
    } catch {
      throw new TokenRejected(`the room couldn't reach ${issuer} for its keys`);
    }
    if (!response.ok) throw new TokenRejected(`${issuer} didn't return its keys (HTTP ${response.status})`);
    const jwks = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    const listed = Array.isArray(jwks?.keys) ? (jwks.keys as (JsonWebKey & { kid?: unknown })[]).slice(0, MAX_KEYS) : [];
    const keys = new Map<string, CryptoKey>();
    for (const jwk of listed) {
      if (typeof jwk.kid !== "string" || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      const key = await crypto.subtle
        .importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
          "verify",
        ])
        .catch(() => null);
      if (key) keys.set(jwk.kid, key);
    }
    return { keys, fetchedAt: startedAt };
  };
  try {
    return await Promise.race([load(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The public key `kid` names in the issuer's JWKS, or null. */
async function issuerKey(issuer: string, kid: string, now: number): Promise<CryptoKey | null> {
  let entry = issuerKeys.get(issuer);
  if (!entry) {
    entry = { lastFetchAt: 0 };
    issuerKeys.set(issuer, entry);
  }
  const fresh = entry.known && now - entry.known.fetchedAt < JWKS_TTL_MS ? entry.known : undefined;
  if (fresh?.keys.has(kid)) return fresh.keys.get(kid)!;
  if (fresh && !entry.fetching && now - entry.lastFetchAt < UNKNOWN_KID_REFETCH_MS) return null;
  let fetching = entry.fetching;
  if (!fetching) {
    const current = entry;
    current.lastFetchAt = now;
    fetching = current.fetching = fetchKeys(issuer, now)
      .then((known) => {
        current.known = known;
        return known;
      })
      .finally(() => {
        current.fetching = undefined;
      });
  }
  return (await fetching).keys.get(kid) ?? null;
}

/** The header and claims of a JWT, read but not yet checked. */
type ReadJwt = { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: string };

function readJwt(token: string, what: string): ReadJwt {
  if (token.length > 16_384) throw new TokenRejected(`it is too long to be ${what}`);
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenRejected("it isn't a JWT");
  const [headerPart, claimsPart, signature] = parts as [string, string, string];
  return { header: jsonPart(headerPart), claims: jsonPart(claimsPart), signed: `${headerPart}.${claimsPart}`, signature };
}

/**
 * Checks what every Clerk JWT must pass before its claims mean anything: RS256 (never `none`,
 * never a key the token names itself), `iss` exactly the issuer, and a signature by a key in the
 * issuer's JWKS.
 */
async function checkSignature(jwt: ReadJwt, issuer: string, now: number): Promise<void> {
  if (jwt.header.alg !== "RS256") throw new TokenRejected("it isn't signed with RS256");
  if (jwt.claims.iss !== issuer) throw new TokenRejected(`it wasn't issued by ${issuer}`);
  if (typeof jwt.header.kid !== "string" || !jwt.header.kid) throw new TokenRejected("it names no signing key");
  if (jwt.header.kid.length > 256) throw new TokenRejected("its signing key isn't one the issuer publishes");
  const key = await issuerKey(issuer, jwt.header.kid, now);
  if (!key) throw new TokenRejected("its signing key isn't one the issuer publishes");
  let signature: Uint8Array;
  try {
    signature = fromBase64url(jwt.signature);
  } catch {
    throw new TokenRejected("its signature doesn't match");
  }
  const signed = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, encoder.encode(jwt.signed));
  if (!signed) throw new TokenRejected("its signature doesn't match");
}

/** `exp`, `iat` and `nbf` against the clock, with LEEWAY_S either way, and a user in `sub`. */
function checkTimesAndSubject(claims: Record<string, unknown>, now: number): void {
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S <= seconds) throw new TokenRejected("it has expired");
  if (typeof claims.iat !== "number" || claims.iat - LEEWAY_S > seconds) throw new TokenRejected("it was issued in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - LEEWAY_S > seconds)) {
    throw new TokenRejected("it isn't valid yet");
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new TokenRejected("it names no user");
}

/**
 * The claims of `token` if it is an ID token from `expected.issuer` for the client
 * `expected.audience`, signed with a key the issuer publishes and not expired. Throws
 * TokenRejected otherwise. The issuer's keys come from the shared cache (issuerKeys).
 */
export async function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string },
  now = Date.now(),
): Promise<IdTokenClaims> {
  const jwt = readJwt(token, "an ID token");
  await checkSignature(jwt, expected.issuer, now);
  const { claims } = jwt;

  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.includes(expected.audience)) throw new TokenRejected("it was issued to another application");
  // With several audiences, OpenID Connect Core 3.1.3.7 wants azp to name this client.
  if (audiences.length > 1 && claims.azp !== expected.audience) throw new TokenRejected("it was issued to another application");

  checkTimesAndSubject(claims, now);
  return claims as unknown as IdTokenClaims;
}

/** What the room takes from a connector's access token (ADR 0031). */
export type AccessTokenGrant = {
  /** Clerk's user ID of the person who signed in. */
  subject: string;
  /** The OAuth client it was issued to: a dynamically registered client's ID, or a CIMD URL. */
  clientId: string;
  /** When it stops working, in ms. */
  expiresAt: number;
};

/**
 * The person and client behind `token` if it is an OAuth access token Clerk issued for exactly
 * `expected.resource`, to a client other than those in `expected.refusedClients`. Throws
 * TokenRejected otherwise.
 *
 * RFC 9068's checks for a JWT access token (section 4): `typ` is `at+jwt`, `iss` is exactly the
 * issuer, RS256 by a key in its JWKS, `aud` names this resource, not expired. Clerk issues these
 * with JWT access tokens and the `aud` claim turned on, and sets `aud` to the RFC 8707 `resource`
 * the client asked for. The room takes only a single audience, this resource: a token valid at
 * several resources can be replayed by any of them (RFC 8707, section 3). The `typ` check also
 * refuses Clerk's ID tokens and session tokens (`typ: JWT`), and anything that isn't a JWT, such
 * as an agent key or a CLI sign-in's token, fails before any of it.
 */
export async function verifyAccessToken(
  token: string,
  expected: { issuer: string; resource: string; refusedClients: { clientId: string; why: string }[] },
  now = Date.now(),
): Promise<AccessTokenGrant> {
  if (token.split(".").length !== 3) {
    throw new TokenRejected("it isn't an access token: this endpoint takes only access tokens Clerk issues to a connector, not an agent key or a CLI sign-in");
  }
  const jwt = readJwt(token, "an access token");
  const typ = typeof jwt.header.typ === "string" ? jwt.header.typ.toLowerCase() : "";
  if (typ !== "at+jwt" && typ !== "application/at+jwt") {
    throw new TokenRejected(`it isn't an access token (its typ is ${String(jwt.header.typ ?? "missing")}, not at+jwt)`);
  }
  await checkSignature(jwt, expected.issuer, now);
  const { claims } = jwt;

  const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
  if (aud !== expected.resource) throw new TokenRejected(`it was issued for another resource, not ${expected.resource}`);

  const clientId = claims.client_id;
  if (typeof clientId !== "string" || !clientId) throw new TokenRejected("it names no client");
  if (clientId.length > 2048) throw new TokenRejected("its client ID is too long");
  const refused = expected.refusedClients.find((c) => c.clientId === clientId);
  if (refused) throw new TokenRejected(refused.why);

  checkTimesAndSubject(claims, now);
  return { subject: claims.sub as string, clientId, expiresAt: (claims.exp as number) * 1000 };
}
