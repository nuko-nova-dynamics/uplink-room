/**
 * `uplink login` for a person (ADR 0030). The room says where to sign in (its Clerk instance and
 * the command line's OAuth client ID) and gives a nonce; the person signs in with Clerk in the
 * browser; the command line hands the room Clerk's ID token once and keeps only the room's token.
 *
 * Two OAuth flows, both public-client flows Clerk documents:
 *  - `browser` (the default): authorization code with PKCE (RFC 7636) and a loopback redirect to
 *    127.0.0.1 on a port the system picks, as RFC 8252 (OAuth 2.0 for Native Apps) recommends;
 *  - `device`: the device authorization grant (RFC 8628), for a computer with no browser: the
 *    person enters a code on another device.
 * Only `openid profile email` is asked for. Clerk still issues a refresh token (it keeps
 * `offline_access` on every OAuth application), so both of Clerk's tokens are revoked once the
 * room has the sign-in: the command line keeps neither.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { API_VERSION, requireSecureUrl, RoomApiError } from "./client.ts";

/** What the room answers `POST /api/v1/cli-sign-in`. */
export type CliSignInStart = { issuer: string; clientId: string; scopes: string; nonce: string; expiresAt: number };

/** What the room answers `POST /api/v1/cli-sign-in/token`. `token` is the secret to keep. */
export type CliSignInResult = {
  token: string;
  signInId: string;
  expiresAt: number;
  person: { personId: string; name: string; email?: string };
};

export type SignInOptions = {
  /** The room's site URL. */
  url: string;
  fetch: typeof fetch;
  /** What to call this computer's sign-in. */
  name: string;
  method: "browser" | "device";
  /** Opens a URL in the person's browser. Without it, the link is only printed. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Tells the person what to do (the terminal's stderr). */
  say: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the browser, in ms (default 10 minutes, as long as Clerk's codes last). */
  timeoutMs?: number;
};

/** OAuth 2.0 Authorization Server Metadata (RFC 8414), the parts used here. */
type ServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
};

type TokenResponse = { id_token?: string; access_token?: string; refresh_token?: string };

const encoder = new TextEncoder();
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: 256 bits, for the PKCE verifier and the state. */
function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/** A failure of the sign-in itself, with the OAuth error code when Clerk sent one. */
function signInError(code: string, message: string): RoomApiError {
  return new RoomApiError(code, message, 0);
}

async function roomPost<T>(options: SignInOptions, path: string, body: unknown): Promise<T> {
  const url = `${options.url}/api/${API_VERSION}/${path}`;
  let response: Response;
  try {
    response = await options.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    throw new RoomApiError("network_error", `Could not reach ${options.url}: ${error instanceof Error ? error.message : String(error)}`, 0);
  }
  const answer = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { code?: string; message?: string } } | null;
  if (answer?.ok === true) return answer.result as T;
  if (typeof answer?.error?.code === "string") {
    throw new RoomApiError(answer.error.code, answer.error.message ?? answer.error.code, response.status);
  }
  if (response.status === 404) {
    throw new RoomApiError("not_found", `${options.url} doesn't offer command-line sign-in: update its deployment, or use an agent key (uplink login --key).`, 404);
  }
  throw new RoomApiError("bad_response", `HTTP ${response.status} from ${url}.`, response.status);
}

async function clerkJson(options: SignInOptions, url: string, form?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await options.fetch(
      url,
      form
        ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }
        : { method: "GET" },
    );
  } catch (error) {
    throw signInError("network_error", `Could not reach ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: body && typeof body === "object" ? body : {} };
}

function oauthFailure(body: Record<string, unknown>, what: string): RoomApiError {
  const code = typeof body.error === "string" ? body.error : "bad_response";
  const description = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
  return signInError(code, `${what} failed (${code}${description}).`);
}

/** The authorization server's endpoints, from its metadata (RFC 8414), which must name the same issuer. */
async function serverMetadata(options: SignInOptions, issuer: string): Promise<ServerMetadata> {
  const { status, body } = await clerkJson(options, `${issuer}/.well-known/oauth-authorization-server`);
  const metadata = body as Partial<ServerMetadata>;
  if (status !== 200 || metadata.issuer !== issuer || typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
    throw signInError("bad_response", `${issuer} didn't describe its sign-in endpoints.`);
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.device_authorization_endpoint, metadata.revocation_endpoint]) {
    if (endpoint !== undefined && new URL(endpoint).protocol !== "https:") {
      throw signInError("bad_response", `${issuer} named an endpoint that isn't HTTPS: ${endpoint}`);
    }
  }
  return metadata as ServerMetadata;
}

function page(text: string): string {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<!doctype html><meta charset="utf-8"><title>Uplink Room</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem"><p>${escaped}</p></body>`;
}

function respond(res: ServerResponse, status: number, text: string, then?: () => void): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  // The browser gets its page before the command line moves on, so it never hangs.
  res.end(page(text), then);
}

/** RFC 8252: the authorization code flow with PKCE, through the browser, back to a loopback port. */
async function browserFlow(options: SignInOptions, start: CliSignInStart, metadata: ServerMetadata): Promise<TokenResponse> {
  const verifier = randomValue();
  const state = randomValue();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The loopback IP literal, not localhost, and a port the system picks (RFC 8252 7.3, 8.3).
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorize = new URL(metadata.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: start.clientId,
    redirect_uri: redirectUri,
    scope: start.scopes,
    state,
    nonce: start.nonce,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
  })) {
    authorize.searchParams.set(name, value);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(signInError("timeout", "Nobody finished signing in within 10 minutes. Run `uplink login` again.")),
        options.timeoutMs ?? 600_000,
      );
      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        // Only the answer to this request counts (RFC 8252 8.9); anything else is ignored.
        if (url.searchParams.get("state") !== state) {
          respond(res, 400, "This sign-in link isn't the one uplink login is waiting for.");
          return;
        }
        // The answer must come from the issuer the room named (RFC 9207, mix-up protection).
        const iss = url.searchParams.get("iss");
        if (iss !== null && iss !== start.issuer) {
          respond(res, 400, "This sign-in came from the wrong server.", () => reject(signInError("invalid", `The sign-in came from ${iss}, not ${start.issuer}.`)));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          respond(res, 200, "Sign-in canceled. You can close this tab.", () =>
            reject(signInError(error, error === "access_denied" ? "Sign-in was canceled in the browser." : `Clerk refused the sign-in (${error}).`)),
          );
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          respond(res, 400, "This sign-in link has no code.");
          return;
        }
        respond(res, 200, "Signed in to Uplink Room. You can close this tab and go back to the terminal.", () => resolve(code));
      });
      const link = authorize.toString();
      if (options.openBrowser) {
        options.say(`Opening your browser to sign in to Uplink Room. If it doesn't open, go to:\n  ${link}\n`);
        // If no browser opens, the printed link still works, so a failure here changes nothing.
        const open = options.openBrowser;
        Promise.resolve()
          .then(() => open(link))
          .catch(() => undefined);
      } else {
        options.say(`Open this link in a browser on this computer to sign in to Uplink Room:\n  ${link}\n`);
      }
    });

    const { status, body } = await clerkJson(options, metadata.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: start.clientId,
      code_verifier: verifier,
    });
    if (status !== 200) throw oauthFailure(body, "Getting the sign-in from Clerk");
    return body as TokenResponse;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

/** RFC 8628: a code the person enters on another device, while this polls Clerk. */
async function deviceFlow(options: SignInOptions, start: CliSignInStart, metadata: ServerMetadata): Promise<TokenResponse> {
  if (!metadata.device_authorization_endpoint) {
    throw signInError("not_configured", `${start.issuer} doesn't offer sign-in with a code. Run \`uplink login\` without --device.`);
  }
  const sleep = options.sleep ?? realSleep;
  const requested = await clerkJson(options, metadata.device_authorization_endpoint, {
    client_id: start.clientId,
    scope: start.scopes,
    nonce: start.nonce,
  });
  const device = requested.body as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (requested.status !== 200 || !device.device_code || !device.user_code || !device.verification_uri) {
    throw oauthFailure(requested.body, "Asking Clerk for a sign-in code");
  }
  options.say(
    `To sign in to Uplink Room, open ${device.verification_uri} in a browser on any device and enter the code ${device.user_code}` +
      `${device.verification_uri_complete ? `\n(or open ${device.verification_uri_complete})` : ""}.\nWaiting for you to approve it...\n`,
  );
  // Clerk's interval and expiry are authoritative; RFC 8628 says 5 seconds when none is given.
  let interval = (typeof device.interval === "number" ? device.interval : 5) * 1000;
  const deadline = Date.now() + (typeof device.expires_in === "number" ? device.expires_in : 600) * 1000;
  for (;;) {
    if (Date.now() >= deadline) throw signInError("expired_token", "The sign-in code expired. Run `uplink login --device` again.");
    await sleep(interval);
    let polled: { status: number; body: Record<string, unknown> };
    try {
      polled = await clerkJson(options, metadata.token_endpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: start.clientId,
      });
    } catch {
      // A connection failure: wait longer before trying again (RFC 8628 3.5).
      interval = Math.max(interval * 2, 1000);
      continue;
    }
    if (polled.status === 200) return polled.body as TokenResponse;
    const error = polled.body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (error === "access_denied") throw signInError("access_denied", "Sign-in was denied in the browser.");
    if (error === "expired_token") throw signInError("expired_token", "The sign-in code expired. Run `uplink login --device` again.");
    throw oauthFailure(polled.body, "Signing in with a code");
  }
}

/**
 * Revokes Clerk's tokens (RFC 7009), the refresh token first: the command line never uses them.
 * Revoking the access token also ended the refresh token on Clerk's development instance on
 * 2026-11-05, but RFC 7009 leaves that to the server, so both are revoked. Failures are ignored.
 */
async function revokeClerkTokens(options: SignInOptions, metadata: ServerMetadata, start: CliSignInStart, tokens: TokenResponse): Promise<void> {
  if (!metadata.revocation_endpoint) return;
  for (const [hint, token] of [
    ["refresh_token", tokens.refresh_token],
    ["access_token", tokens.access_token],
  ] as const) {
    if (typeof token !== "string") continue;
    await clerkJson(options, metadata.revocation_endpoint, { token, token_type_hint: hint, client_id: start.clientId }).catch(() => undefined);
  }
}

/** Signs the person in and returns the room's CLI sign-in. Nothing secret is passed to `say`. */
export async function signInFromCli(options: SignInOptions): Promise<CliSignInResult> {
  // Clerk's ID token goes to the room, and the room's token comes back: never in the clear.
  requireSecureUrl(options.url);
  const start = await roomPost<CliSignInStart>(options, "cli-sign-in", {});
  const metadata = await serverMetadata(options, start.issuer);
  const tokens = options.method === "device" ? await deviceFlow(options, start, metadata) : await browserFlow(options, start, metadata);
  try {
    if (typeof tokens.id_token !== "string") {
      throw signInError("bad_response", "Clerk returned no ID token. The command line's OAuth application needs the openid scope.");
    }
    return await roomPost<CliSignInResult>(options, "cli-sign-in/token", { idToken: tokens.id_token, name: options.name });
  } finally {
    await revokeClerkTokens(options, metadata, start, tokens);
  }
}
