/**
 * Syncing a connected GitHub account's repos (ADR 0020). Mutations can't call out, so
 * `github.ts` schedules this action, and it reports each page back through a mutation that
 * carries the sync's generation: a page from an older sync, or one that lands after a disconnect,
 * changes nothing.
 *
 * It authenticates as the App's installation (a JWT, then an installation access token, both made
 * here and never stored), and reads the repos 100 at a time, 10 pages per step.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { GitHubError, installation, installationRepos, installationToken, readPullRequest as readPullRequestFromGitHub } from "./lib/github/api";
import { githubConfig } from "./lib/github/config";

const PAGES_PER_STEP = 10;

export const run = internalAction({
  args: { accountId: v.id("githubAccounts"), generation: v.number(), page: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const fail = async (error: string, gone = false): Promise<null> => {
      await ctx.runMutation(internal.github.syncFailed, { accountId: args.accountId, generation: args.generation, error, gone });
      return null;
    };
    const config = githubConfig();
    if (!config) return fail("GitHub isn't set up on this deployment.");
    const account = await ctx.runQuery(internal.github.forSync, { accountId: args.accountId });
    if (!account || account.generation !== args.generation) return null;
    try {
      if (args.page === 1) {
        const found = await installation(config, account.installationId);
        if (!found) return fail("GitHub no longer has this installation: the App was uninstalled.", true);
        const goOn = await ctx.runMutation(internal.github.syncInstallation, {
          accountId: args.accountId,
          generation: args.generation,
          account: found.account,
          repositorySelection: found.repositorySelection,
          suspended: found.suspendedAt !== null,
        });
        if (!goOn) return null;
      }
      const token = await installationToken(config, account.installationId);
      for (let page = args.page; page < args.page + PAGES_PER_STEP; page++) {
        // When the room asked: a webhook applied after this wins over what this page says.
        const fetchedAt = Date.now();
        const { repos, full } = await installationRepos(token, page);
        const current = await ctx.runMutation(internal.github.syncPage, {
          accountId: args.accountId,
          generation: args.generation,
          fetchedAt,
          repos,
        });
        if (!current) return null;
        if (!full) {
          await ctx.runMutation(internal.github.syncFinished, { accountId: args.accountId, generation: args.generation });
          return null;
        }
      }
      await ctx.scheduler.runAfter(0, internal.githubSync.run, { ...args, page: args.page + PAGES_PER_STEP });
      return null;
    } catch (error) {
      const message = error instanceof GitHubError ? error.message : "The sync stopped on an unexpected error.";
      if (!(error instanceof GitHubError)) console.error("GitHub sync failed", error instanceof Error ? error.name : typeof error);
      return fail(message);
    }
  },
});

/**
 * Reads a pull request a task just linked (ADR 0051), so it shows its state before the next webhook:
 * as the installation the team reaches its repo through. The result lands only if the row is still
 * there and still that installation's.
 */
export const readPullRequest = internalAction({
  args: { pullRequestId: v.id("taskPullRequests") },
  handler: async (ctx, { pullRequestId }): Promise<null> => {
    const config = githubConfig();
    const row = await ctx.runQuery(internal.github.pullRequestRow, { pullRequestId });
    if (!row) return null;
    if (!config) {
      await ctx.runMutation(internal.github.pullRequestRead, { pullRequestId, installationId: row.installationId, error: "GitHub isn't set up on this deployment." });
      return null;
    }
    // Before asking: a webhook applied after this moment is newer than what the read returns.
    const fetchedAt = Date.now();
    try {
      const token = await installationToken(config, row.installationId);
      const read = await readPullRequestFromGitHub(token, row.repo, row.number);
      await ctx.runMutation(internal.github.pullRequestRead, { pullRequestId, installationId: row.installationId, read, fetchedAt });
    } catch (error) {
      const message = error instanceof GitHubError ? error.message : "Couldn't read the pull request from GitHub.";
      // 403 and 404 mean the App can't see pull requests there: its new permissions aren't accepted yet.
      const why =
        error instanceof GitHubError && (error.status === 403 || error.status === 404)
          ? `${message} If the pull request exists, the GitHub App may need its Pull requests permission accepted on that account.`
          : message;
      await ctx.runMutation(internal.github.pullRequestRead, { pullRequestId, installationId: row.installationId, error: why });
    }
    return null;
  },
});
