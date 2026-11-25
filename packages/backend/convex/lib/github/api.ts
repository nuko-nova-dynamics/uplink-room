/**
 * The GitHub REST calls the room makes (ADR 0020), over `fetch` in Convex's default runtime.
 * Tests stub `fetch` with a fake GitHub (tests/fakeGitHub.ts), so this code runs as written.
 *
 * Errors carry GitHub's status and its own `message`, never a token: callers show them to admins.
 */
import { appJwt } from "./crypto";
import type { GitHubConfig } from "./config";

export const API = "https://api.github.com";
/** The REST API version the room was written against. */
export const API_VERSION = "2026-03-10";
const TIMEOUT_MS = 20_000;
/** At most this many pages of installations for one person: 1,000 accounts. */
const MAX_INSTALLATION_PAGES = 10;
export const REPOS_PER_PAGE = 100;

export type AccountType = "Organization" | "User";
export type GitHubAccountInfo = { id: number; login: string; type: AccountType; avatarUrl?: string };
export type GitHubInstallation = {
  id: number;
  appId: number;
  account: GitHubAccountInfo;
  repositorySelection: "all" | "selected";
  /** When the account suspended the App, or null. */
  suspendedAt: number | null;
};
export type GitHubRepo = { id: number; fullName: string; private: boolean; archived: boolean; defaultBranch: string };

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown>;

async function call(url: string, init: RequestInit & { token?: string }): Promise<{ status: number; body: Json }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "user-agent": "uplink-room",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    let body: Json = {};
    try {
      body = text ? (JSON.parse(text) as Json) : {};
    } catch {
      body = {};
    }
    return { status: response.status, body };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new GitHubError(0, timedOut ? "GitHub didn't answer in time." : "Couldn't reach GitHub.");
  } finally {
    clearTimeout(timer);
  }
}

function failure(what: string, status: number, body: Json): GitHubError {
  const said = typeof body["message"] === "string" ? `: ${(body["message"] as string).slice(0, 200)}` : "";
  return new GitHubError(status, `GitHub refused ${what} (${status})${said}.`);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function accountOf(raw: unknown): GitHubAccountInfo | null {
  const a = (raw ?? {}) as Json;
  const id = num(a["id"]);
  const login = str(a["login"]);
  if (id === undefined || !login) return null;
  const avatar = str(a["avatar_url"]);
  return {
    id,
    login,
    type: a["type"] === "Organization" ? "Organization" : "User",
    ...(avatar && avatar.startsWith("https://") ? { avatarUrl: avatar } : {}),
  };
}

export function installationOf(raw: unknown): GitHubInstallation | null {
  const i = (raw ?? {}) as Json;
  const id = num(i["id"]);
  const account = accountOf(i["account"]);
  if (id === undefined || !account) return null;
  const suspended = str(i["suspended_at"]);
  return {
    id,
    appId: num(i["app_id"]) ?? 0,
    account,
    repositorySelection: i["repository_selection"] === "selected" ? "selected" : "all",
    suspendedAt: suspended ? Date.parse(suspended) || Date.now() : null,
  };
}

export function repoOf(raw: unknown): GitHubRepo | null {
  const r = (raw ?? {}) as Json;
  const id = num(r["id"]);
  const fullName = str(r["full_name"]);
  if (id === undefined || !fullName || !fullName.includes("/")) return null;
  return {
    id,
    fullName,
    private: r["private"] === true,
    archived: r["archived"] === true,
    defaultBranch: str(r["default_branch"]) ?? "main",
  };
}

/**
 * Trades the authorization code for a user access token: the web application flow, with the PKCE
 * verifier and the same redirect URI ("Generating a user access token for a GitHub App").
 */
export async function exchangeCode(
  config: GitHubConfig,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<string> {
  const { status, body } = await call("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });
  const token = str(body["access_token"]);
  if (status === 200 && token) return token;
  const reason = str(body["error"]) ?? `HTTP ${status}`;
  throw new GitHubError(status, `GitHub didn't accept the authorization (${reason}).`);
}

/** Who a user access token belongs to (`GET /user`). */
export async function userIdentity(userToken: string): Promise<{ login: string; id: number }> {
  const { status, body } = await call(`${API}/user`, { token: userToken });
  const login = str(body["login"]);
  const id = num(body["id"]);
  if (status !== 200 || !login || id === undefined) throw failure("the account lookup", status, body);
  return { login, id };
}

/**
 * The person's membership in an organization (`GET /user/memberships/orgs/{org}`), or null when
 * GitHub shows none: not a member (404), or the organization blocks the App or wants a SAML
 * session first (403). With a user access token it needs the App's "Members" organization
 * permission (read), per "Permissions required for GitHub Apps".
 */
export async function orgMembership(userToken: string, org: string): Promise<{ role: string; state: string } | null> {
  const { status, body } = await call(`${API}/user/memberships/orgs/${encodeURIComponent(org)}`, { token: userToken });
  if (status === 404 || status === 403) return null;
  if (status !== 200) throw failure(`the membership lookup for ${org}`, status, body);
  return { role: str(body["role"]) ?? "", state: str(body["state"]) ?? "" };
}

/**
 * A person's membership of an organization, asked with the organization installation's own token
 * (`GET /orgs/{org}/memberships/{username}`, the App's Members: read permission), so it works after
 * the person's token is gone. Null when they aren't a member.
 */
export async function memberOf(
  installationToken: string,
  org: string,
  username: string,
): Promise<{ role: string; state: string; userId: number | undefined } | null> {
  const { status, body } = await call(`${API}/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`, {
    token: installationToken,
  });
  if (status === 404) return null;
  if (status !== 200) throw failure(`the owner check for ${org}`, status, body);
  const user = body["user"] && typeof body["user"] === "object" ? (body["user"] as Json) : {};
  return { role: str(body["role"]) ?? "", state: str(body["state"]) ?? "", userId: num(user["id"]) };
}

/** The App's installations this person can access (`GET /user/installations`), every page up to 1,000. */
export async function userInstallations(userToken: string): Promise<GitHubInstallation[]> {
  const all: GitHubInstallation[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const { status, body } = await call(`${API}/user/installations?per_page=100&page=${page}`, { token: userToken });
    if (status !== 200) throw failure("the list of installations", status, body);
    const list = Array.isArray(body["installations"]) ? (body["installations"] as unknown[]) : [];
    for (const raw of list) {
      const installation = installationOf(raw);
      if (installation) all.push(installation);
    }
    if (list.length < 100) break;
  }
  return all;
}

/** One installation of the App (`GET /app/installations/{id}`, as the App). Null when GitHub doesn't know it. */
export async function installation(config: GitHubConfig, installationId: number): Promise<GitHubInstallation | null> {
  const jwt = await appJwt({ appId: config.appId, privateKeyPem: config.privateKey });
  const { status, body } = await call(`${API}/app/installations/${installationId}`, { token: jwt });
  if (status === 404) return null;
  if (status !== 200) throw failure("the installation lookup", status, body);
  return installationOf(body);
}

/** An installation access token, good for an hour (`POST /app/installations/{id}/access_tokens`). */
export async function installationToken(config: GitHubConfig, installationId: number): Promise<string> {
  const jwt = await appJwt({ appId: config.appId, privateKeyPem: config.privateKey });
  const { status, body } = await call(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: jwt,
  });
  const token = str(body["token"]);
  if (status !== 201 || !token) throw failure("an installation token", status, body);
  return token;
}

/** One page of the repos an installation can access (`GET /installation/repositories`). */
export async function installationRepos(
  installationToken: string,
  page: number,
): Promise<{ repos: GitHubRepo[]; total: number; full: boolean }> {
  const { status, body } = await call(`${API}/installation/repositories?per_page=${REPOS_PER_PAGE}&page=${page}`, {
    token: installationToken,
  });
  if (status !== 200) throw failure("the list of repos", status, body);
  const list = Array.isArray(body["repositories"]) ? (body["repositories"] as unknown[]) : [];
  return {
    repos: list.map(repoOf).filter((r): r is GitHubRepo => r !== null),
    total: num(body["total_count"]) ?? list.length,
    full: list.length >= REPOS_PER_PAGE,
  };
}

/** A pull request as GitHub gives it now (ADR 0051): its state, its reviewers' decisions and its head commit's check suites. */
export type PullRequestRead = {
  title: string | undefined;
  url: string | undefined;
  state: "open" | "draft" | "merged" | "closed";
  headSha: string | undefined;
  /** GitHub's `updated_at` for the pull request, in ms. */
  updatedAt: number | undefined;
  /** Every review that decides or was dismissed, oldest first. */
  reviews: { login: string; state: "approved" | "changes_requested" | "dismissed"; reviewId?: number; at?: number }[];
  /** Absent when the App can't read checks (it lacks the Checks permission). */
  checks?: { app: string; suiteId?: number; sha: string; status: string; conclusion?: string; at?: number }[];
};

function ms(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** At most this many pages of 100 reviews are read for one pull request. */
const MAX_REVIEW_PAGES = 10;

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${API}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

/**
 * Reads one pull request with an installation token: `GET /repos/{owner}/{repo}/pulls/{number}`,
 * its reviews (`…/reviews`, the first 100, oldest first) and its head commit's check suites
 * (`GET /repos/{owner}/{repo}/commits/{sha}/check-suites`). Needs the Pull requests permission, and
 * Checks for the suites.
 */
export async function readPullRequest(installationToken: string, repo: string, number: number): Promise<PullRequestRead> {
  const base = repoPath(repo);
  const pr = await call(`${base}/pulls/${number}`, { token: installationToken });
  if (pr.status !== 200) throw failure(`pull request ${repo}#${number}`, pr.status, pr.body);
  const head = (pr.body["head"] ?? {}) as Json;
  const headSha = typeof head["sha"] === "string" ? (head["sha"] as string) : undefined;
  const state = pr.body["merged"] === true ? "merged" : pr.body["state"] === "closed" ? "closed" : pr.body["draft"] === true ? "draft" : "open";
  const reviews: PullRequestRead["reviews"] = [];
  // Every page, oldest first, as GitHub lists them (at most MAX_REVIEW_PAGES of 100); the room folds
  // them in as it does webhooks (withReview), so a later page's decision wins.
  const listed: Json[] = [];
  for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
    const reviewed = await call(`${base}/pulls/${number}/reviews?per_page=100&page=${page}`, { token: installationToken });
    if (reviewed.status !== 200 || !Array.isArray(reviewed.body)) break;
    const rows = reviewed.body as unknown as Json[];
    listed.push(...rows);
    if (rows.length < 100) break;
  }
  {
    for (const raw of listed) {
      const login = str(((raw["user"] ?? {}) as Json)["login"]);
      const said = str(raw["state"])?.toLowerCase();
      if (!login || (said !== "approved" && said !== "changes_requested" && said !== "dismissed")) continue;
      const reviewId = num(raw["id"]);
      const when = ms(raw["submitted_at"]);
      reviews.push({ login, state: said, ...(reviewId !== undefined ? { reviewId } : {}), ...(when !== undefined ? { at: when } : {}) });
    }
  }
  let checks: PullRequestRead["checks"];
  if (headSha) {
    const suites = await call(`${base}/commits/${encodeURIComponent(headSha)}/check-suites?per_page=100`, { token: installationToken });
    const list = Array.isArray(suites.body["check_suites"]) ? (suites.body["check_suites"] as Json[]) : null;
    if (suites.status === 200 && list) {
      checks = list
        .map((suite) => {
          const app = str(((suite["app"] ?? {}) as Json)["slug"]);
          const status = str(suite["status"]);
          const conclusion = str(suite["conclusion"]);
          const at = ms(suite["updated_at"]);
          const suiteId = num(suite["id"]);
          return app && status
            ? { app, sha: headSha, status, ...(suiteId !== undefined ? { suiteId } : {}), ...(conclusion ? { conclusion } : {}), ...(at !== undefined ? { at } : {}) }
            : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .slice(0, 30);
    }
  }
  return {
    title: str(pr.body["title"])?.slice(0, 500),
    url: str(pr.body["html_url"])?.startsWith("https://github.com/") ? str(pr.body["html_url"]) : undefined,
    state,
    headSha,
    updatedAt: ms(pr.body["updated_at"]),
    reviews,
    ...(checks ? { checks } : {}),
  };
}
