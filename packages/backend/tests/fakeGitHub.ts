/**
 * A GitHub that runs nothing, standing in for github.com and api.github.com in tests through a
 * stubbed `fetch`, so the room's real client code runs (lib/github/api.ts). It checks what GitHub
 * checks:
 *  - the App's JWT is RS256, signed by the App's private key, issued by its App ID, and lives
 *    at most 10 minutes;
 *  - an authorization code works once, with the client secret, the same redirect URI, and the
 *    PKCE verifier whose S256 challenge the authorize URL carried;
 *  - a user access token lists only the installations that person can access, and a person's
 *    organization membership says whether they own it (`GET /user/memberships/orgs/{org}`);
 *  - an organization installation's token reads that organization's members, and no other's
 *    (`GET /orgs/{org}/memberships/{username}`, the App's Members: read);
 *  - an installation token reads only its own installation's repos, 100 a page at most.
 */
const encoder = new TextEncoder();

export const APP = { id: 4242, slug: "uplink-room-test", clientId: "Iv23liTEST", clientSecret: "test-client-secret", webhookSecret: "test-webhook-secret" };
export const SITE = "https://some.convex.site";

export type FakeRepo = { id: number; full_name: string; private: boolean; archived: boolean; default_branch: string };
export type FakePull = {
  repo: string;
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  head: string;
  /** GitHub's `updated_at` (default: a fixed time). */
  updatedAt?: string;
  reviews: { login: string; state: "approved" | "changes_requested" | "commented" | "dismissed" }[];
  suites: { app: string; status: string; conclusion?: string }[];
};
export type FakeInstallation = {
  id: number;
  account: { id: number; login: string; type: "Organization" | "User"; avatar_url: string };
  repository_selection: "all" | "selected";
  suspended_at: string | null;
  repos: FakeRepo[];
};

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const s = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function pem(der: Uint8Array, label: string): string {
  let s = "";
  for (const b of der) s += String.fromCharCode(b);
  const body = btoa(s).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export async function fakeGitHub() {
  const keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  /** PKCS #1 is the OCTET STRING inside an RSA PKCS #8 key: its last part, after a 26-byte header. */
  const pkcs1 = pkcs8.slice(26);

  const installations = new Map<number, FakeInstallation>();
  /** Who can access which installations, by login. */
  const access = new Map<string, number[]>();
  const codes = new Map<string, { login: string; challenge: string; redirectUri: string; used: boolean }>();
  /** Each person's role in each organization: `${login} ${org}`. */
  const memberships = new Map<string, { role: string; state: string }>();
  /** A person's GitHub id: stable per login, so a personal installation's account id can be theirs. */
  const userId = (login: string) => [...login].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1_000_000, 7) + 1_000_000;
  /** A held repos request: GitHub answered (its body is fixed), and the test lets it arrive later. */
  let hold: { reached: () => void; released: Promise<void> } | null = null;
  const userTokens = new Map<string, string>();
  /** Pull requests by `owner/name#number`, readable by an installation that has the repo (ADR 0051). */
  const pulls = new Map<string, FakePull>();
  const calls: string[] = [];
  let next = 1;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function appFromJwt(auth: string | null): Promise<boolean> {
    const jwt = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return false;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, fromB64url(s) as BufferSource, encoder.encode(`${h}.${p}`));
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    const now = Math.floor(Date.now() / 1000);
    return ok && header.alg === "RS256" && claims.iss === APP.id && claims.exp > now && claims.exp - claims.iat <= 600 && claims.iat <= now;
  }

  function installationJson(i: FakeInstallation) {
    return { id: i.id, app_id: APP.id, account: i.account, repository_selection: i.repository_selection, suspended_at: i.suspended_at };
  }

  async function handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const grant = codes.get(body["code"] ?? "");
      if (body["client_id"] !== APP.clientId || body["client_secret"] !== APP.clientSecret) return json(200, { error: "incorrect_client_credentials" });
      if (!grant || grant.used) return json(200, { error: "bad_verification_code" });
      if (grant.redirectUri !== body["redirect_uri"]) return json(200, { error: "redirect_uri_mismatch" });
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body["code_verifier"] ?? ""))));
      if (challenge !== grant.challenge) return json(200, { error: "invalid_grant" });
      grant.used = true;
      const token = `ghu_${next++}_${grant.login}`;
      userTokens.set(token, grant.login);
      return json(200, { access_token: token, token_type: "bearer", scope: "" });
    }
    if (url.host !== "api.github.com") return json(404, { message: "Not Found" });
    if (headers.get("x-github-api-version") !== "2026-03-10") return json(400, { message: "Missing API version" });
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (url.pathname === "/user") {
      const login = userTokens.get(bearer);
      return login ? json(200, { login, id: userId(login) }) : json(401, { message: "Bad credentials" });
    }
    const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname);
    if (membership) {
      const login = userTokens.get(bearer);
      if (!login) return json(401, { message: "Bad credentials" });
      const found = memberships.get(`${login} ${decodeURIComponent(membership[1]!).toLowerCase()}`);
      return found ? json(200, { ...found, organization: { login: membership[1] } }) : json(404, { message: "Not Found" });
    }
    if (url.pathname === "/user/installations") {
      const login = userTokens.get(bearer);
      if (!login) return json(401, { message: "Bad credentials" });
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
      const mine = (access.get(login) ?? []).map((id) => installations.get(id)).filter((i): i is FakeInstallation => !!i);
      return json(200, { total_count: mine.length, installations: mine.slice((page - 1) * per, page * per).map(installationJson) });
    }
    const one = /^\/app\/installations\/(\d+)$/.exec(url.pathname);
    if (one && method === "GET") {
      if (!(await appFromJwt(auth))) return json(401, { message: "A JSON web token could not be decoded" });
      const found = installations.get(Number(one[1]));
      return found ? json(200, installationJson(found)) : json(404, { message: "Not Found" });
    }
    const tokens = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (tokens && method === "POST") {
      if (!(await appFromJwt(auth))) return json(401, { message: "A JSON web token could not be decoded" });
      const found = installations.get(Number(tokens[1]));
      if (!found) return json(404, { message: "Not Found" });
      if (found.suspended_at) return json(403, { message: "This installation has been suspended" });
      return json(201, { token: `ghs_${found.id}_${next++}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const member = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(url.pathname);
    if (member && method === "GET") {
      const id = /^ghs_(\d+)_/.exec(bearer)?.[1];
      const found = id ? installations.get(Number(id)) : undefined;
      if (!found) return json(401, { message: "Bad credentials" });
      const org = decodeURIComponent(member[1]!).toLowerCase();
      if (found.account.type !== "Organization" || found.account.login.toLowerCase() !== org) {
        return json(403, { message: "Resource not accessible by integration" });
      }
      const login = decodeURIComponent(member[2]!);
      const role = memberships.get(`${login} ${org}`);
      return role ? json(200, { ...role, user: { login, id: userId(login) }, organization: { login: found.account.login } }) : json(404, { message: "Not Found" });
    }
    if (url.pathname === "/installation/repositories") {
      const id = /^ghs_(\d+)_/.exec(bearer)?.[1];
      const found = id ? installations.get(Number(id)) : undefined;
      if (!found) return json(401, { message: "Bad credentials" });
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
      const answer = json(200, { total_count: found.repos.length, repositories: found.repos.slice((page - 1) * per, page * per) });
      if (hold) {
        const held = hold;
        hold = null;
        held.reached();
        await held.released;
      }
      return answer;
    }
    const pull = /^\/repos\/([^/]+)\/([^/]+)\/(?:pulls\/(\d+)(\/reviews)?|commits\/([0-9a-f]{40})\/check-suites)$/.exec(url.pathname);
    if (pull && method === "GET") {
      const id = /^ghs_(\d+)_/.exec(bearer)?.[1];
      const found = id ? installations.get(Number(id)) : undefined;
      if (!found) return json(401, { message: "Bad credentials" });
      const repo = `${decodeURIComponent(pull[1]!)}/${decodeURIComponent(pull[2]!)}`;
      if (!found.repos.some((r) => r.full_name.toLowerCase() === repo.toLowerCase())) return json(404, { message: "Not Found" });
      if (pull[5]) {
        const suites = [...pulls.values()].filter((p) => p.repo === repo && p.head === pull[5]).flatMap((p) => p.suites);
        return json(200, { total_count: suites.length, check_suites: suites.map((s) => ({ app: { slug: s.app }, status: s.status, conclusion: s.conclusion ?? null, head_sha: pull[5] })) });
      }
      const found2 = pulls.get(`${repo}#${pull[3]}`);
      if (!found2) return json(404, { message: "Not Found" });
      if (pull[4]) {
        // Pages of per_page, as GitHub's list endpoints give them.
        const per = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
        const page = Number(url.searchParams.get("page") ?? 1);
        return json(200, found2.reviews.slice((page - 1) * per, page * per).map((r, i) => ({ id: (page - 1) * per + i + 1, user: { login: r.login }, state: r.state.toUpperCase() })));
      }
      return json(200, {
        number: Number(pull[3]),
        title: found2.title,
        html_url: `https://github.com/${repo}/pull/${pull[3]}`,
        state: found2.state === "merged" ? "closed" : found2.state === "draft" ? "open" : found2.state,
        merged: found2.state === "merged",
        draft: found2.state === "draft",
        head: { sha: found2.head },
        updated_at: found2.updatedAt ?? "2026-11-19T09:00:00Z",
      });
    }
    return json(404, { message: "Not Found" });
  }

  return {
    /** Adds or replaces a pull request that installations with its repo can read. */
    pull(p: FakePull) {
      pulls.set(`${p.repo}#${p.number}`, p);
    },
    privateKeyPem: pem(pkcs8, "PRIVATE KEY"),
    /** The same key as GitHub's download gives it: PKCS #1. */
    privateKeyPkcs1Pem: pem(pkcs1, "RSA PRIVATE KEY"),
    pkcs8,
    pkcs1,
    publicKey: keys.publicKey,
    installations,
    calls,
    fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => handle(new URL(String(input instanceof Request ? input.url : input)), init),
    /** Every user token GitHub handed out, to check the room never stored one. */
    userTokens: () => [...userTokens.keys()],
    install(i: { id: number; login: string; type?: "Organization" | "User"; selection?: "all" | "selected"; repos?: [number, string, boolean?][] }) {
      const type = i.type ?? "Organization";
      const accountId = type === "User" ? userId(i.login) : i.id * 10;
      const installation: FakeInstallation = {
        id: i.id,
        account: { id: accountId, login: i.login, type, avatar_url: `https://avatars.githubusercontent.com/u/${accountId}?v=4` },
        repository_selection: i.selection ?? "all",
        suspended_at: null,
        repos: (i.repos ?? []).map(([id, name, priv]) => ({ id, full_name: name, private: priv ?? false, archived: false, default_branch: "main" })),
      };
      installations.set(i.id, installation);
      return installation;
    },
    /**
     * Lets `login` access these installations. For an organization's, they're also an active
     * member with `role`: an owner ("admin") unless a test says otherwise.
     */
    grant(login: string, installationIds: number[], role: "admin" | "member" = "admin") {
      access.set(login, installationIds);
      for (const id of installationIds) {
        const found = installations.get(id);
        if (found?.account.type === "Organization") memberships.set(`${login} ${found.account.login.toLowerCase()}`, { role, state: "active" });
      }
    },
    /** Changes `login`'s role in an organization, or removes them from it (null). */
    setRole(login: string, org: string, role: "admin" | "member" | null) {
      if (role) memberships.set(`${login} ${org.toLowerCase()}`, { role, state: "active" });
      else memberships.delete(`${login} ${org.toLowerCase()}`);
    },
    /**
     * Holds the next repos page: GitHub's answer is fixed when the request arrives, but reaches the
     * room only after `release()`. `reached` resolves once the request is in.
     */
    holdNextReposPage() {
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      hold = { reached, released: new Promise<void>((resolve) => (release = resolve)) };
      return { reached: arrived, release };
    },
    /**
     * What github.com/login/oauth/authorize does once the person accepts: a code for them, bound
     * to the challenge and redirect URI the authorize URL carries, sent back to the callback.
     */
    authorize(authorizeUrl: string, login: string): string {
      const url = new URL(authorizeUrl);
      if (url.searchParams.get("client_id") !== APP.clientId) throw new Error("wrong client_id");
      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("no PKCE");
      const code = `code_${next++}`;
      const redirectUri = url.searchParams.get("redirect_uri")!;
      codes.set(code, { login, challenge: url.searchParams.get("code_challenge")!, redirectUri, used: false });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      return back.pathname + back.search;
    },
  };
}

export type FakeGitHub = Awaited<ReturnType<typeof fakeGitHub>>;

/** A webhook delivery as GitHub signs it. */
export async function signedDelivery(event: string, payload: unknown, opts: { delivery?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", encoder.encode(opts.secret ?? APP.webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${hex}`,
    },
    body,
  };
}
