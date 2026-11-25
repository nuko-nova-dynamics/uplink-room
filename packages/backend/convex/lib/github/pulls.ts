/**
 * Pull requests linked to tasks (ADR 0051): naming one, and keeping it up to date from the App's
 * `pull_request`, `pull_request_review` and `check_suite` webhooks.
 *
 * GitHub doesn't promise to deliver webhooks in order, so each kind of change carries GitHub's own
 * time, and an older one arriving late changes nothing: a pull request's `updated_at`, a review's
 * `submitted_at` (a dismissal removes only the review it names), a check suite's `updated_at`.
 * Check suites are kept per commit, so a suite that finishes before the push that made its commit
 * the head still counts once it is.
 */
import type { Doc } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

export type PullRef = { repo: string; number: number };

/**
 * The pull request a person or agent names: `owner/name#123`, or its github.com URL
 * (`https://github.com/owner/name/pull/123`, with anything after the number). Null for anything else.
 */
export function parsePullRef(input: string): PullRef | null {
  const text = input.trim();
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(text);
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text);
  const match = short ?? url;
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: `${match[1]}/${match[2]}`, number };
}

export type Review = NonNullable<Doc<"taskPullRequests">["reviews"]>[number];
export type Check = NonNullable<Doc<"taskPullRequests">["checks"]>[number];

/** At most this many reviewers and check suites are kept for one pull request. */
const MAX_REVIEWERS = 30;
const MAX_CHECKS = 30;

/** Whether review `a` is newer than `b`: by GitHub's time, then by id, which GitHub hands out in order. */
function newer(a: { at?: number; reviewId?: number }, b: { at?: number; reviewId?: number }): boolean {
  if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return a.at > b.at;
  if (a.reviewId !== undefined && b.reviewId !== undefined) return a.reviewId > b.reviewId;
  return true;
}

/**
 * A review changes what its reviewer last said: approved or changes requested replace an older
 * decision, a dismissal marks the review it names dismissed, and a comment changes nothing (GitHub's
 * rule for a pull request's review decision). The dismissed mark stays, so the review's own
 * submission delivered late, or an older review, doesn't bring a decision back.
 */
export function withReview(
  reviews: Review[],
  review: { login: string; state: string; reviewId?: number; at?: number },
): Review[] {
  if (review.state !== "approved" && review.state !== "changes_requested" && review.state !== "dismissed") return reviews;
  const kept = reviews.find((r) => r.login === review.login);
  if (kept) {
    const same = kept.reviewId !== undefined && kept.reviewId === review.reviewId;
    // A review GitHub dismissed stays dismissed whatever arrives about it later.
    if (same && kept.state === "dismissed") return reviews;
    if (!same && !newer(review, kept)) return reviews;
  }
  const next: Review = {
    login: review.login,
    state: review.state,
    ...(review.reviewId !== undefined ? { reviewId: review.reviewId } : {}),
    ...(review.at !== undefined ? { at: review.at } : kept?.at !== undefined ? { at: kept.at } : {}),
  };
  return [...reviews.filter((r) => r !== kept), next].slice(-MAX_REVIEWERS);
}

const STATUS_ORDER = ["queued", "requested", "pending", "waiting", "in_progress", "completed"];

/**
 * A check suite's status, kept per suite (GitHub's id; app and commit when there is none). An
 * older report of the same suite changes nothing; at the same moment, the later status wins
 * (completed after in progress). When the list is full, suites on other commits than the head go first.
 */
export function withCheck(checks: Check[], check: Check, headSha: string | undefined): Check[] {
  const same = checks.find((c) =>
    check.suiteId !== undefined && c.suiteId !== undefined ? c.suiteId === check.suiteId : c.app === check.app && c.sha === check.sha,
  );
  if (same?.at !== undefined && check.at !== undefined) {
    if (check.at < same.at) return checks;
    if (check.at === same.at && STATUS_ORDER.indexOf(check.status) < STATUS_ORDER.indexOf(same.status)) return checks;
  }
  const next = [...checks.filter((c) => c !== same), check];
  while (next.length > MAX_CHECKS) {
    const old = next.findIndex((c) => c.sha !== headSha);
    next.splice(old >= 0 ? old : 0, 1);
  }
  return next;
}

/** The pull request as people and agents read it on a task: its state, review decision and checks on its head. */
export function pullView(row: Doc<"taskPullRequests">) {
  const reviews = (row.reviews ?? []).filter((r) => r.state !== "dismissed").map(({ login, state }) => ({ login, state }));
  const checks = (row.checks ?? [])
    .filter((c) => row.headSha !== undefined && c.sha === row.headSha)
    .map(({ app, status, conclusion }) => ({ app, status, ...(conclusion ? { conclusion } : {}) }));
  const failed = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
  return {
    pullRequestId: row._id,
    repo: row.repo,
    number: row.number,
    title: row.title,
    url: row.url ?? `https://github.com/${row.repo}/pull/${row.number}`,
    /** open, draft, merged or closed; absent until the room has read it from GitHub. */
    state: row.state,
    headSha: row.headSha,
    /** changes_requested when any reviewer's latest review asks for changes, else approved when one approves, else none. */
    review: reviews.some((r) => r.state === "changes_requested")
      ? ("changes_requested" as const)
      : reviews.some((r) => r.state === "approved")
        ? ("approved" as const)
        : ("none" as const),
    reviews,
    /** failing when a check suite on the head commit failed, pending while one hasn't finished, passing when all passed, none with none. */
    checks: checks.some((c) => c.conclusion !== undefined && failed.has(c.conclusion))
      ? ("failing" as const)
      : checks.some((c) => c.status !== "completed")
        ? ("pending" as const)
        : checks.length
          ? ("passing" as const)
          : ("none" as const),
    checkSuites: checks,
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

/**
 * Whether the team still reaches this row's repo through its installation: the account is still
 * connected and the repo still synced. After a disconnect nothing reaches the row any more.
 */
export async function pullRowLive(ctx: QueryCtx, row: Doc<"taskPullRequests">): Promise<boolean> {
  const repo = await ctx.db
    .query("githubRepos")
    .withIndex("by_team_github", (q) => q.eq("teamId", row.teamId).eq("githubId", row.repoGithubId))
    .first();
  const account = repo ? await ctx.db.get(repo.githubAccountId) : null;
  return !!account && account.removedAt === undefined && account.installationId === row.installationId;
}

/** The live rows this installation keeps for a repo, by pull request number or by head commit. */
async function rowsFor(
  ctx: MutationCtx,
  installationId: number,
  repoGithubId: number,
  by: { number: number } | { headSha: string },
): Promise<Doc<"taskPullRequests">[]> {
  const rows =
    "number" in by
      ? await ctx.db
          .query("taskPullRequests")
          .withIndex("by_repo_number", (q) => q.eq("repoGithubId", repoGithubId).eq("number", by.number))
          .take(200)
      : await ctx.db
          .query("taskPullRequests")
          .withIndex("by_repo_head", (q) => q.eq("repoGithubId", repoGithubId).eq("headSha", by.headSha))
          .take(200);
  const live: Doc<"taskPullRequests">[] = [];
  for (const row of rows) if (row.installationId === installationId && (await pullRowLive(ctx, row))) live.push(row);
  return live;
}

export type PullRequestEvent = {
  kind: "pull_request";
  installationId: number;
  repoId: number;
  repo: string;
  number: number;
  title?: string;
  url?: string;
  state: "open" | "draft" | "merged" | "closed";
  headSha?: string;
  updatedAt?: number;
};

export type PullReviewEvent = {
  kind: "pull_request_review";
  installationId: number;
  repoId: number;
  repo: string;
  number: number;
  login: string;
  state: string;
  reviewId?: number;
  at?: number;
};

export type CheckSuiteEvent = {
  kind: "check_suite";
  installationId: number;
  repoId: number;
  repo: string;
  numbers: number[];
  headSha: string;
  app: string;
  status: string;
  conclusion?: string;
  at?: number;
  suiteId?: number;
};

export async function applyPullEvent(ctx: MutationCtx, event: PullRequestEvent | PullReviewEvent | CheckSuiteEvent, at: number): Promise<void> {
  if (event.kind === "pull_request") {
    for (const row of await rowsFor(ctx, event.installationId, event.repoId, { number: event.number })) {
      const known = row.pullUpdatedAt;
      if (known !== undefined && event.updatedAt !== undefined && event.updatedAt < known) continue;
      // The same second as what the row has, but saying something else: GitHub can't say which came
      // last, so the room asks it again.
      const differs =
        event.state !== row.state ||
        (event.headSha ?? row.headSha) !== row.headSha ||
        (event.title ?? row.title) !== row.title ||
        (event.url ?? row.url) !== row.url;
      if (known !== undefined && event.updatedAt === known && differs) {
        await ctx.scheduler.runAfter(0, internal.githubSync.readPullRequest, { pullRequestId: row._id });
        continue;
      }
      await ctx.db.patch(row._id, {
        repo: event.repo,
        state: event.state,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.url !== undefined ? { url: event.url } : {}),
        ...(event.headSha !== undefined ? { headSha: event.headSha } : {}),
        ...(event.updatedAt !== undefined ? { pullUpdatedAt: event.updatedAt } : {}),
        error: undefined,
        updatedAt: at,
      });
      // A new head: its check suites may have finished before this, a fork's naming no pull
      // request, so the room reads them from GitHub.
      if (event.headSha !== undefined && row.headSha !== undefined && event.headSha !== row.headSha) {
        await ctx.scheduler.runAfter(0, internal.githubSync.readPullRequest, { pullRequestId: row._id });
      }
    }
    return;
  }
  if (event.kind === "pull_request_review") {
    for (const row of await rowsFor(ctx, event.installationId, event.repoId, { number: event.number })) {
      const review = { login: event.login, state: event.state, ...(event.reviewId !== undefined ? { reviewId: event.reviewId } : {}), ...(event.at !== undefined ? { at: event.at } : {}) };
      await ctx.db.patch(row._id, { reviews: withReview(row.reviews ?? [], review), updatedAt: at });
    }
    return;
  }
  // By the pull requests the suite names, and by its commit for a suite that names none (a fork's).
  const rows = new Map<string, Doc<"taskPullRequests">>();
  for (const number of event.numbers.slice(0, 20)) {
    for (const row of await rowsFor(ctx, event.installationId, event.repoId, { number })) rows.set(row._id, row);
  }
  for (const row of await rowsFor(ctx, event.installationId, event.repoId, { headSha: event.headSha })) rows.set(row._id, row);
  for (const row of rows.values()) {
    const check: Check = {
      app: event.app,
      sha: event.headSha,
      status: event.status,
      ...(event.suiteId !== undefined ? { suiteId: event.suiteId } : {}),
      ...(event.conclusion ? { conclusion: event.conclusion } : {}),
      ...(event.at !== undefined ? { at: event.at } : {}),
    };
    await ctx.db.patch(row._id, { checks: withCheck(row.checks ?? [], check, row.headSha), updatedAt: at });
  }
}
