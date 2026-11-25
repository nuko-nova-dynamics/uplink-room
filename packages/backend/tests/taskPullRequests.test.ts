/** ADR 0051: a task shows a linked pull request's state, reviews and checks, from GitHub's webhooks. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { APP, fakeGitHub, signedDelivery, SITE, type FakeGitHub } from "./fakeGitHub";
import { newRoom, newTeam, settleScheduled, type Person, type Room } from "./setup";

let gh: FakeGitHub;
const ORG = 61;
const OTHER = 62;
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

beforeEach(async () => {
  gh = await fakeGitHub();
  vi.stubEnv("GITHUB_APP_ID", String(APP.id));
  vi.stubEnv("GITHUB_APP_SLUG", APP.slug);
  vi.stubEnv("GITHUB_CLIENT_ID", APP.clientId);
  vi.stubEnv("GITHUB_CLIENT_SECRET", APP.clientSecret);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", APP.webhookSecret);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", gh.privateKeyPem);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubGlobal("fetch", gh.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Connects an installation end to end, as tests/github.test.ts does, and lets its sync finish. */
async function connect(t: Room, person: Person, teamId: Id<"teams">, installationId: number) {
  const { url, connectId } = await person.as.mutation(api.github.connect, { teamId });
  const opened = await t.fetch(url.slice(SITE.length));
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const setup = await t.fetch(`/github/setup?installation_id=${installationId}&setup_action=install`, { headers: { cookie } });
  await t.fetch(gh.authorize(setup.headers.get("location")!, "julio"));
  await person.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId });
  await settleScheduled(t);
}

async function deliver(t: Room, event: string, payload: unknown) {
  return (await t.fetch("/github/webhook", await signedDelivery(event, payload))).status;
}

const repository = { id: 1, full_name: "nuko/billing" };

test("a linked pull request shows its state, review and checks, and webhooks keep them current", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connect(t, admin, teamId, ORG);
  gh.pull({ repo: "nuko/billing", number: 7, title: "Fix totals", state: "open", head: HEAD, reviews: [{ login: "ana", state: "changes_requested" }], suites: [{ app: "github-actions", status: "in_progress" }] });
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });

  await expect(admin.as.mutation(api.tasks.linkPullRequest, { teamId, taskId, pullRequest: "someone/else#1" })).rejects.toThrow(/connected GitHub repos/);
  await admin.as.mutation(api.tasks.linkPullRequest, { teamId, taskId, pullRequest: "https://github.com/nuko/billing/pull/7" });
  await settleScheduled(t);
  const pr = async () => (await admin.as.query(api.tasks.get, { teamId, taskId })).pullRequests[0]!;
  expect(await pr()).toMatchObject({ repo: "nuko/billing", number: 7, title: "Fix totals", state: "open", review: "changes_requested", checks: "pending", headSha: HEAD });

  // Ana approves, CI passes on the head commit, and the pull request merges.
  const pull = { number: 7, title: "Fix totals", state: "open", draft: false, merged: false, html_url: "https://github.com/nuko/billing/pull/7", head: { sha: HEAD }, updated_at: "2026-11-19T10:00:00Z" };
  const review = (state: string, id: number, at: string) => ({ id, state, submitted_at: at, user: { login: "ana" } });
  expect(await deliver(t, "pull_request_review", { action: "submitted", installation: { id: ORG }, repository, pull_request: pull, review: review("approved", 2, "2026-11-19T10:05:00Z") })).toBe(200);
  // Her older review, delivered late, changes nothing.
  await deliver(t, "pull_request_review", { action: "submitted", installation: { id: ORG }, repository, pull_request: pull, review: review("changes_requested", 1, "2026-11-19T09:00:00Z") });
  await deliver(t, "check_suite", { action: "completed", installation: { id: ORG }, repository, check_suite: { head_sha: HEAD, status: "completed", conclusion: "success", updated_at: "2026-11-19T10:06:00Z", app: { slug: "github-actions" }, pull_requests: [{ number: 7 }] } });
  expect(await pr()).toMatchObject({ review: "approved", checks: "passing" });

  // Another installation's delivery about the same repo id changes nothing.
  await deliver(t, "pull_request", { action: "closed", installation: { id: OTHER }, repository, pull_request: { ...pull, state: "closed", updated_at: "2026-11-19T11:00:00Z" } });
  expect(await pr()).toMatchObject({ state: "open" });

  // A push: the new commit's suite arrives before the push itself, and counts once it is the head.
  await deliver(t, "check_suite", { action: "completed", installation: { id: ORG }, repository, check_suite: { head_sha: NEXT, status: "completed", conclusion: "failure", updated_at: "2026-11-19T11:01:00Z", app: { slug: "github-actions" }, pull_requests: [{ number: 7 }] } });
  await deliver(t, "pull_request", { action: "synchronize", installation: { id: ORG }, repository, pull_request: { ...pull, head: { sha: NEXT }, updated_at: "2026-11-19T11:02:00Z" } });
  expect(await pr()).toMatchObject({ headSha: NEXT, checks: "failing" });
  // A fork's suite names no pull request: it is matched by the head commit.
  await deliver(t, "check_suite", { action: "completed", installation: { id: ORG }, repository, check_suite: { head_sha: NEXT, status: "in_progress", updated_at: "2026-11-19T11:03:00Z", app: { slug: "vercel" }, pull_requests: [] } });
  expect((await pr()).checkSuites).toEqual(expect.arrayContaining([expect.objectContaining({ app: "vercel", status: "in_progress" })]));
  // The older synchronize, delivered late, doesn't take it back to the old commit.
  await deliver(t, "pull_request", { action: "synchronize", installation: { id: ORG }, repository, pull_request: { ...pull, updated_at: "2026-11-19T10:30:00Z" } });
  expect(await pr()).toMatchObject({ headSha: NEXT });
  await deliver(t, "pull_request", { action: "closed", installation: { id: ORG }, repository, pull_request: { ...pull, head: { sha: NEXT }, state: "closed", merged: true, updated_at: "2026-11-19T12:00:00Z" } });
  expect(await pr()).toMatchObject({ state: "merged" });

  // Disconnected, the account's webhooks reach the task no more.
  const [account] = (await admin.as.query(api.github.accounts, { teamId })).accounts;
  await admin.as.mutation(api.github.disconnect, { teamId, accountId: account!.accountId });
  await deliver(t, "pull_request", { action: "reopened", installation: { id: ORG }, repository, pull_request: { ...pull, head: { sha: NEXT }, updated_at: "2026-11-19T13:00:00Z" } });
  expect(await pr()).toMatchObject({ state: "merged" });
});

test("two workflows of one app are two check suites, and a dismissal delivered first keeps a late approval out", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connect(t, admin, teamId, ORG);
  gh.pull({ repo: "nuko/billing", number: 8, title: "Lint", state: "open", head: HEAD, reviews: [], suites: [] });
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Tidy" });
  await admin.as.mutation(api.tasks.linkPullRequest, { teamId, taskId, pullRequest: "nuko/billing#8" });
  await settleScheduled(t);
  const pr = async () => (await admin.as.query(api.tasks.get, { teamId, taskId })).pullRequests[0]!;
  const pull = { number: 8, state: "open", head: { sha: HEAD }, updated_at: "2026-11-19T10:00:00Z" };
  const suite = (id: number, conclusion: string, at: string) => ({ id, head_sha: HEAD, status: "completed", conclusion, updated_at: at, app: { slug: "github-actions" }, pull_requests: [{ number: 8 }] });

  // Lint fails, then tests pass: both are GitHub Actions suites on the head, and the card says failing.
  await deliver(t, "check_suite", { action: "completed", installation: { id: ORG }, repository, check_suite: suite(101, "failure", "2026-11-19T10:01:00Z") });
  await deliver(t, "check_suite", { action: "completed", installation: { id: ORG }, repository, check_suite: suite(102, "success", "2026-11-19T10:02:00Z") });
  expect(await pr()).toMatchObject({ checks: "failing" });

  // The dismissal of Ana's approval arrives before the approval itself.
  const review = { id: 9, state: "approved", submitted_at: "2026-11-19T10:03:00Z", user: { login: "ana" } };
  await deliver(t, "pull_request_review", { action: "dismissed", installation: { id: ORG }, repository, pull_request: pull, review: { ...review, state: "dismissed" } });
  await deliver(t, "pull_request_review", { action: "submitted", installation: { id: ORG }, repository, pull_request: pull, review });
  expect(await pr()).toMatchObject({ review: "none" });
});

test("a read from GitHub at the same second as a newer webhook doesn't take the row back", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connect(t, admin, teamId, ORG);
  gh.pull({ repo: "nuko/billing", number: 9, title: "Fix", state: "open", head: HEAD, reviews: [], suites: [] });
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Fix" });
  const { pullRequestId } = await admin.as.mutation(api.tasks.linkPullRequest, { teamId, taskId, pullRequest: "nuko/billing#9" });
  await settleScheduled(t);
  const fetchedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The push lands while a read that began before it is still asking GitHub.
  const second = "2026-11-19T10:00:00Z";
  await deliver(t, "pull_request", { action: "synchronize", installation: { id: ORG }, repository, pull_request: { number: 9, state: "open", head: { sha: NEXT }, updated_at: second } });
  await t.mutation(internal.github.pullRequestRead, {
    pullRequestId,
    installationId: ORG,
    fetchedAt,
    read: { state: "open", headSha: HEAD, updatedAt: Date.parse(second), reviews: [] },
  });
  const [pr] = (await admin.as.query(api.tasks.get, { teamId, taskId })).pullRequests;
  expect(pr).toMatchObject({ headSha: NEXT });

  // So with a title edited in that same second: neither delivery nor read can say which is newer,
  // so the room asks GitHub, whose answer has the new title.
  gh.pull({ repo: "nuko/billing", number: 9, title: "Fix totals", state: "open", head: NEXT, updatedAt: second, reviews: [], suites: [] });
  await deliver(t, "pull_request", { action: "edited", installation: { id: ORG }, repository, pull_request: { number: 9, state: "open", title: "Fix totals", head: { sha: NEXT }, updated_at: second } });
  await t.mutation(internal.github.pullRequestRead, {
    pullRequestId,
    installationId: ORG,
    fetchedAt,
    read: { state: "open", title: "Fix", headSha: NEXT, updatedAt: Date.parse(second), reviews: [] },
  });
  await settleScheduled(t);
  expect((await admin.as.query(api.tasks.get, { teamId, taskId })).pullRequests[0]).toMatchObject({ title: "Fix totals" });
});

test("linking reads every page of a pull request's reviews, so a decision past the first 100 counts", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connect(t, admin, teamId, ORG);
  const comments = Array.from({ length: 120 }, () => ({ login: "ben", state: "commented" as const }));
  gh.pull({ repo: "nuko/billing", number: 10, title: "Busy", state: "open", head: HEAD, reviews: [...comments, { login: "ana", state: "approved" }], suites: [] });
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Busy" });
  await admin.as.mutation(api.tasks.linkPullRequest, { teamId, taskId, pullRequest: "nuko/billing#10" });
  await settleScheduled(t);
  expect((await admin.as.query(api.tasks.get, { teamId, taskId })).pullRequests[0]).toMatchObject({ review: "approved" });
});
