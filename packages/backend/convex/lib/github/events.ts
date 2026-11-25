/**
 * GitHub's webhook payloads, cut down to what the room uses (ADR 0020). The HTTP action checks the
 * signature, then passes one of these to a mutation, so a mutation never sees a whole payload.
 */
import { v, type Infer } from "convex/values";
import { accountOf, repoOf } from "./api";

export const vAccountType = v.union(v.literal("Organization"), v.literal("User"));
export const vSelection = v.union(v.literal("all"), v.literal("selected"));

export const vAccountInfo = v.object({
  id: v.number(),
  login: v.string(),
  type: vAccountType,
  avatarUrl: v.optional(v.string()),
});

/** A repo as a payload gives it. `installation_repositories` lists only id, name and visibility. */
export const vRepoInfo = v.object({
  id: v.number(),
  fullName: v.string(),
  private: v.boolean(),
  archived: v.optional(v.boolean()),
  defaultBranch: v.optional(v.string()),
});

export const vInstallationReposEvent = v.object({
  kind: v.literal("installation_repositories"),
  installationId: v.number(),
  repositorySelection: vSelection,
  added: v.array(vRepoInfo),
  removed: v.array(v.number()),
  /** More repos changed than one delivery applies: the room syncs the account instead. */
  tooMany: v.boolean(),
});

export const vRepositoryEvent = v.object({
  kind: v.literal("repository"),
  action: v.string(),
  installationId: v.optional(v.number()),
  repo: vRepoInfo,
});

/** A pull request's state (ADR 0051): `pull_request` events, for the tasks that link it. */
export const vPullRequestEvent = v.object({
  kind: v.literal("pull_request"),
  installationId: v.number(),
  repoId: v.number(),
  repo: v.string(),
  number: v.number(),
  title: v.optional(v.string()),
  url: v.optional(v.string()),
  state: v.union(v.literal("open"), v.literal("draft"), v.literal("merged"), v.literal("closed")),
  headSha: v.optional(v.string()),
  /** GitHub's `updated_at` for the pull request, in ms. */
  updatedAt: v.optional(v.number()),
});

/** A review submitted, edited or dismissed (`pull_request_review`). */
export const vPullReviewEvent = v.object({
  kind: v.literal("pull_request_review"),
  installationId: v.number(),
  repoId: v.number(),
  repo: v.string(),
  number: v.number(),
  login: v.string(),
  state: v.string(),
  reviewId: v.optional(v.number()),
  /** The review's `submitted_at`, in ms. */
  at: v.optional(v.number()),
});

/** A check suite's status on a commit, with the pull requests it is for (`check_suite`). */
export const vCheckSuiteEvent = v.object({
  kind: v.literal("check_suite"),
  installationId: v.number(),
  repoId: v.number(),
  repo: v.string(),
  numbers: v.array(v.number()),
  headSha: v.string(),
  app: v.string(),
  status: v.string(),
  conclusion: v.optional(v.string()),
  /** The suite's `updated_at`, in ms. */
  at: v.optional(v.number()),
  /** GitHub's id for the suite: one app, such as GitHub Actions, runs one suite per workflow. */
  suiteId: v.optional(v.number()),
});

export const vGitHubEvent = v.union(
  v.object({
    kind: v.literal("installation"),
    action: v.string(),
    installationId: v.number(),
    account: v.optional(vAccountInfo),
    repositorySelection: v.optional(vSelection),
  }),
  vInstallationReposEvent,
  vRepositoryEvent,
  v.object({
    kind: v.literal("installation_target"),
    action: v.string(),
    installationId: v.number(),
    account: v.optional(vAccountInfo),
  }),
  vPullRequestEvent,
  vPullReviewEvent,
  vCheckSuiteEvent,
);

export type GitHubEvent = Infer<typeof vGitHubEvent>;
export type InstallationReposEvent = Infer<typeof vInstallationReposEvent>;
export type RepositoryEvent = Infer<typeof vRepositoryEvent>;
export type RepoInfo = Infer<typeof vRepoInfo>;

/** At most this many repos from one `installation_repositories` delivery; more, and the account is synced. */
export const MAX_REPOS_PER_DELIVERY = 100;

type Json = Record<string, unknown>;

function installationIdOf(payload: Json): number | undefined {
  const id = (payload["installation"] as Json | undefined)?.["id"];
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

function liteRepo(raw: unknown): RepoInfo | null {
  const r = (raw ?? {}) as Json;
  const id = r["id"];
  const fullName = r["full_name"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof fullName !== "string" || !fullName.includes("/")) return null;
  return { id, fullName, private: r["private"] === true };
}

function accountInfo(raw: unknown) {
  const account = accountOf(raw);
  return account ? { account } : {};
}

/** The event a delivery carries, or null for one the room ignores (`ping`, other events, malformed payloads). */
export function parseEvent(name: string | null, payload: unknown): GitHubEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Json;
  const action = typeof p["action"] === "string" ? (p["action"] as string) : "";
  const installationId = installationIdOf(p);
  if (name === "installation") {
    if (installationId === undefined) return null;
    const installation = p["installation"] as Json;
    const selection = installation["repository_selection"];
    return {
      kind: "installation",
      action,
      installationId,
      ...accountInfo(installation["account"]),
      ...(selection === "all" || selection === "selected" ? { repositorySelection: selection } : {}),
    };
  }
  if (name === "installation_repositories") {
    if (installationId === undefined) return null;
    const added = Array.isArray(p["repositories_added"]) ? (p["repositories_added"] as unknown[]) : [];
    const removed = Array.isArray(p["repositories_removed"]) ? (p["repositories_removed"] as unknown[]) : [];
    const tooMany = added.length + removed.length > MAX_REPOS_PER_DELIVERY;
    return {
      kind: "installation_repositories",
      installationId,
      repositorySelection: p["repository_selection"] === "selected" ? "selected" : "all",
      added: tooMany ? [] : added.map(liteRepo).filter((r): r is RepoInfo => r !== null),
      removed: tooMany ? [] : removed.map((r) => (r as Json)?.["id"]).filter((id): id is number => typeof id === "number"),
      tooMany,
    };
  }
  if (name === "repository") {
    const repo = repoOf(p["repository"]);
    if (!repo) return null;
    return {
      kind: "repository",
      action,
      ...(installationId !== undefined ? { installationId } : {}),
      repo: { id: repo.id, fullName: repo.fullName, private: repo.private, archived: repo.archived, defaultBranch: repo.defaultBranch },
    };
  }
  if (name === "installation_target") {
    if (installationId === undefined) return null;
    return { kind: "installation_target", action, installationId, ...accountInfo(p["account"]) };
  }
  if (name === "pull_request" || name === "pull_request_review" || name === "check_suite") {
    return pullEvent(name, action, installationId, p);
  }
  return null;
}

function text(value: unknown, max = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function sha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

function time(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A pull request event (ADR 0051), cut down to what a linked task shows; null when it isn't one the room keeps. */
function pullEvent(name: "pull_request" | "pull_request_review" | "check_suite", action: string, installationId: number | undefined, p: Json): GitHubEvent | null {
  const repository = (p["repository"] ?? {}) as Json;
  const repo = text(repository["full_name"], 200);
  const repoId = repository["id"];
  if (installationId === undefined || !repo || !repo.includes("/") || typeof repoId !== "number" || !Number.isSafeInteger(repoId)) return null;
  if (name === "check_suite") {
    const suite = (p["check_suite"] ?? {}) as Json;
    const headSha = sha(suite["head_sha"]);
    const app = text(((suite["app"] ?? {}) as Json)["slug"], 100);
    const status = text(suite["status"], 40);
    if (!headSha || !app || !status) return null;
    const pulls = Array.isArray(suite["pull_requests"]) ? (suite["pull_requests"] as unknown[]) : [];
    // A fork's suite names no pull request (GitHub's check suites docs): the room matches it by commit.
    const numbers = pulls
      .map((pr) => (pr as Json | null)?.["number"])
      .filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0)
      .slice(0, 20);
    const conclusion = text(suite["conclusion"], 40);
    const at = time(suite["updated_at"]);
    const suiteId = typeof suite["id"] === "number" && Number.isSafeInteger(suite["id"]) ? (suite["id"] as number) : undefined;
    return {
      kind: "check_suite",
      installationId,
      repoId,
      repo,
      numbers,
      headSha,
      app,
      status,
      ...(conclusion ? { conclusion } : {}),
      ...(at !== undefined ? { at } : {}),
      ...(suiteId !== undefined ? { suiteId } : {}),
    };
  }
  const pr = (p["pull_request"] ?? {}) as Json;
  const number = pr["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  if (name === "pull_request_review") {
    if (action !== "submitted" && action !== "edited" && action !== "dismissed") return null;
    const review = (p["review"] ?? {}) as Json;
    const login = text(((review["user"] ?? {}) as Json)["login"], 100);
    const state = action === "dismissed" ? "dismissed" : text(review["state"], 40)?.toLowerCase();
    if (!login || !state) return null;
    const reviewId = typeof review["id"] === "number" && Number.isSafeInteger(review["id"]) ? (review["id"] as number) : undefined;
    const at = time(review["submitted_at"]);
    return {
      kind: "pull_request_review",
      installationId,
      repoId,
      repo,
      number,
      login,
      state,
      ...(reviewId !== undefined ? { reviewId } : {}),
      ...(at !== undefined ? { at } : {}),
    };
  }
  const merged = pr["merged"] === true;
  const state = merged ? "merged" : pr["state"] === "closed" ? "closed" : pr["draft"] === true ? "draft" : "open";
  const title = text(pr["title"]);
  const url = text(pr["html_url"]);
  const headSha = sha(((pr["head"] ?? {}) as Json)["sha"]);
  const updatedAt = time(pr["updated_at"]);
  return {
    kind: "pull_request",
    installationId,
    repoId,
    repo,
    number,
    state,
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined && url.startsWith("https://github.com/") ? { url } : {}),
    ...(headSha ? { headSha } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}
