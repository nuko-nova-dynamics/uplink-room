/**
 * A Clerk instance that runs nothing, standing in for its Frontend API in tests through a stubbed
 * `fetch`, so the room's real token check (lib/clerkTokens.ts) and the command line's real OAuth
 * code (room-client src/signIn.ts) run. It does what Clerk documents for an OAuth application
 * that is public, requires PKCE and has the device authorization grant on:
 *  - metadata at /.well-known/oauth-authorization-server and its keys at /.well-known/jwks.json;
 *  - an authorization code works once, for the redirect URI and client it was issued to, with the
 *    verifier whose S256 challenge the authorize URL carried (RFC 7636, RFC 8252);
 *  - a device code answers authorization_pending until a person approves its user code, then
 *    tokens once (RFC 8628);
 *  - with the `openid` scope the token response has an ID token: RS256, `aud` a list holding the
 *    client ID, `iss` the issuer, the authorize request's `nonce`, `name` and `email`, and
 *    `picture` only when the user has one: what a real ID token from the development instance
 *    held on 2026-11-05;
 *  - every grant comes with a refresh token, since Clerk keeps `offline_access` on every OAuth
 *    application, whatever the request asks for.
 */
const encoder = new TextEncoder();

export const CLIENT_ID = "uplink_cli_test";
export const KID = "ins_test";

/**
 * Each instance gets its own issuer, as two Clerk instances have, so the room's JWKS cache (which
 * lives as long as the module does, across tests) never hands one test's keys to another's tokens.
 */
let instances = 0;
function newIssuer(): string {
  instances++;
  return `https://clerk-${instances}-${crypto.randomUUID().slice(0, 8)}.test`;
}

export type ClerkUser = { subject: string; name: string; email: string; picture?: string };

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function oauthError(error: string, status = 400): Response {
  return json(status, { error });
}

async function rsaKeys() {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function fakeClerk(options: { issuer?: string; clientId?: string } = {}) {
  const issuer = options.issuer ?? newIssuer();
  const clientId = options.clientId ?? CLIENT_ID;
  let keys = await rsaKeys();
  let kid = KID;
  // Another key the instance never published, for forged tokens.
  const stranger = await rsaKeys();
  const published = [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, alg: "RS256", use: "sig" }];
  /** While set, the JWKS endpoint never answers, as a Frontend API that hangs. */
  let stalled = false;

  /** Signs claims as this instance would, or with `key`/`header` changed for a forged token. */
  async function sign(claims: Record<string, unknown>, opts: { key?: CryptoKey; header?: Record<string, unknown> } = {}) {
    const part = (value: unknown) => b64url(encoder.encode(JSON.stringify(value)));
    const unsigned = `${part({ alg: "RS256", typ: "JWT", kid, ...opts.header })}.${part(claims)}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, encoder.encode(unsigned)),
    );
    return `${unsigned}.${b64url(signature)}`;
  }

  /** An ID token for `user`, as Clerk issues one with `openid profile email`. `claims` override. */
  async function idToken(user: ClerkUser, claims: Record<string, unknown> = {}, opts: { forged?: boolean; header?: Record<string, unknown> } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        iss: issuer,
        sub: user.subject,
        aud: [clientId],
        iat: now,
        exp: now + 86_400,
        jti: crypto.randomUUID(),
        name: user.name,
        email: user.email,
        email_verified: true,
        ...(user.picture ? { picture: user.picture } : {}),
        ...claims,
      },
      { ...(opts.forged ? { key: stranger.privateKey } : {}), ...(opts.header ? { header: opts.header } : {}) },
    );
  }

  /**
   * An OAuth access token for `user`, as the instance issues one with JWT access tokens and the
   * `aud` claim turned on (`oauth_jwt_access_tokens`, `aud_claim_enabled`): header `typ: at+jwt`,
   * `aud` the RFC 8707 `resource` the client asked for (absent when it asked for none),
   * `client_id`, `scope` and a `jti` starting `oat_`. What a real token from the development
   * instance held on 2026-11-05. `claims` override; `opts.forged` signs with a key the instance
   * never published.
   */
  async function accessToken(
    user: Pick<ClerkUser, "subject">,
    options: { clientId: string; resource?: string },
    claims: Record<string, unknown> = {},
    opts: { forged?: boolean; header?: Record<string, unknown> } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        ...(options.resource !== undefined ? { aud: options.resource } : {}),
        client_id: options.clientId,
        exp: now + 86_400,
        iat: now,
        iss: issuer,
        jti: `oat_${crypto.randomUUID().replaceAll("-", "")}`,
        nbf: now - 10,
        scope: "openid offline_access",
        sub: user.subject,
        ...claims,
      },
      {
        ...(opts.forged ? { key: stranger.privateKey } : {}),
        header: { typ: "at+jwt", ...opts.header },
      },
    );
  }

  type Grant = { user: ClerkUser; nonce?: string; scope: string };
  const codes = new Map<string, Grant & { redirectUri: string; challenge: string; clientId: string }>();
  const devices = new Map<string, { userCode: string; nonce?: string; scope: string; grant?: Grant; denied?: boolean; polls: number }>();
  const requests: { path: string; form?: Record<string, string> }[] = [];
  const revoked: string[] = [];

  async function tokens(grant: Grant) {
    const access = `oat_${crypto.randomUUID()}`;
    return {
      access_token: access,
      refresh_token: `ort_${crypto.randomUUID()}`,
      token_type: "Bearer",
      expires_in: 86_400,
      scope: [...new Set([...grant.scope.split(" "), "offline_access"])].sort().join(" "),
      ...(grant.scope.split(" ").includes("openid") ? { id_token: await idToken(grant.user, grant.nonce ? { nonce: grant.nonce } : {}) } : {}),
    };
  }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== new URL(issuer).origin) throw new Error(`fake Clerk got a request for ${url.origin}`);
    const form =
      request.method === "POST" ? Object.fromEntries(new URLSearchParams(await request.text())) : undefined;
    requests.push({ path: url.pathname, ...(form ? { form } : {}) });

    if (url.pathname === "/.well-known/jwks.json") {
      if (stalled) {
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      return json(200, { keys: published });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        revocation_endpoint: `${issuer}/oauth/token/revoke`,
        device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/oauth/device_authorization" && form) {
      if (form.client_id !== clientId) return oauthError("invalid_client", 401);
      const deviceCode = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const userCode = `WDJB-${devices.size.toString().padStart(4, "0")}`;
      devices.set(deviceCode, { userCode, ...(form.nonce ? { nonce: form.nonce } : {}), scope: form.scope ?? "", polls: 0 });
      return json(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${issuer}/device`,
        verification_uri_complete: `${issuer}/device?user_code=${userCode}`,
        expires_in: 600,
        // Zero so tests don't wait; Clerk sends 5.
        interval: 0,
      });
    }
    if (url.pathname === "/oauth/token" && form) {
      if (form.client_id !== clientId) return oauthError("invalid_client", 401);
      if (form.grant_type === "authorization_code") {
        const code = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        if (!code || code.redirectUri !== form.redirect_uri || code.clientId !== form.client_id) return oauthError("invalid_grant");
        if (!form.code_verifier || (await s256(form.code_verifier)) !== code.challenge) return oauthError("invalid_grant");
        return json(200, await tokens(code));
      }
      if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const device = devices.get(form.device_code ?? "");
        if (!device) return oauthError("invalid_grant");
        device.polls++;
        if (device.denied) return oauthError("access_denied");
        if (!device.grant) return oauthError("authorization_pending");
        devices.delete(form.device_code!);
        return json(200, await tokens(device.grant));
      }
      return oauthError("unsupported_grant_type");
    }
    if (url.pathname === "/oauth/token/revoke" && form) {
      if (form.token) revoked.push(`${form.token_type_hint ?? "token"}:${form.token.slice(0, 4)}`);
      return new Response(null, { status: 200 });
    }
    return json(404, { error: "not_found" });
  };

  return {
    issuer,
    clientId,
    fetch,
    idToken,
    accessToken,
    /** Every request the instance got, with its form fields. */
    requests,
    /** How many times the room fetched this instance's JWKS. */
    get keyFetches() {
      return requests.filter((r) => r.path === "/.well-known/jwks.json").length;
    },
    /** Makes the JWKS endpoint hang (true) or answer again (false). */
    stallKeys(stall: boolean) {
      stalled = stall;
    },
    /** Rotates the signing key, as Clerk does: a new `kid`, published beside the old one; new tokens use it. */
    async rotate() {
      keys = await rsaKeys();
      kid = `${KID}_${published.length + 1}`;
      published.push({ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, alg: "RS256", use: "sig" });
    },
    /** What the client revoked: `<token_type_hint>:<the token's prefix>`, such as `refresh_token:ort_`. */
    revoked,
    /**
     * A person signs in and approves in the browser at `authorizeUrl`. Returns the URL Clerk
     * redirects the browser to, as RFC 6749 4.1.2 and RFC 9207 describe, or an error redirect.
     */
    async authorize(authorizeUrl: string, user: ClerkUser, decision: "approve" | "deny" = "approve"): Promise<string> {
      const url = new URL(authorizeUrl);
      const p = url.searchParams;
      if (url.origin + url.pathname !== `${issuer}/oauth/authorize`) throw new Error(`not an authorize URL: ${authorizeUrl}`);
      if (p.get("client_id") !== clientId || p.get("response_type") !== "code") throw new Error("bad authorize request");
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("PKCE is required");
      const redirect = new URL(p.get("redirect_uri")!);
      // Clerk takes any port on the loopback redirect it has registered (RFC 8252 7.3).
      if (redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback") throw new Error("redirect URI not registered");
      if (p.get("state")) redirect.searchParams.set("state", p.get("state")!);
      redirect.searchParams.set("iss", issuer);
      if (decision === "deny") {
        redirect.searchParams.set("error", "access_denied");
        return redirect.toString();
      }
      const code = b64url(crypto.getRandomValues(new Uint8Array(24)));
      codes.set(code, {
        user,
        scope: p.get("scope") ?? "",
        ...(p.get("nonce") ? { nonce: p.get("nonce")! } : {}),
        redirectUri: p.get("redirect_uri")!,
        challenge: p.get("code_challenge")!,
        clientId: p.get("client_id")!,
      });
      redirect.searchParams.set("code", code);
      return redirect.toString();
    },
    /** A person enters `userCode` at the verification page, signs in and approves (or denies). */
    approveDevice(userCode: string, user: ClerkUser, decision: "approve" | "deny" = "approve") {
      const device = [...devices.values()].find((d) => d.userCode === userCode);
      if (!device) throw new Error(`no device request with user code ${userCode}`);
      if (decision === "deny") device.denied = true;
      else device.grant = { user, scope: device.scope, ...(device.nonce ? { nonce: device.nonce } : {}) };
    },
  };
}

export type FakeClerk = Awaited<ReturnType<typeof fakeClerk>>;
