/**
 * The last step of connecting a GitHub account (ADR 0020). The person who started the connect chose
 * Connect in the app (`github.confirmConnect`, which checks that they are that person). What GitHub
 * said at the callback can be minutes old by then, and the user token is gone, so this action asks
 * GitHub again as the App, then reports to `github.confirm`, which checks the starter again in its
 * transaction and links the installation, or records why not for the app to show.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { GitHubError, installation, installationToken, memberOf } from "./lib/github/api";
import { githubConfig, type GitHubConfig } from "./lib/github/config";

/**
 * Whether the GitHub user who signed in may still connect the account. Their user token is gone by
 * now, so this asks as the App: the installation's account (`GET /app/installations/{id}`), then, for
 * an organization, the person's membership with the installation's own token
 * (`GET /orgs/{org}/memberships/{username}`, Members: read). Null when they may; otherwise why not.
 */
export async function stillOwner(
  config: GitHubConfig,
  person: { login: string; id: number },
  choice: { installationId: number; accountGithubId: number; login: string },
): Promise<string | null> {
  const found = await installation(config, choice.installationId);
  if (!found || found.account.id !== choice.accountGithubId) return `The Uplink Room App is no longer installed on ${choice.login}.`;
  const account = found.account;
  if (account.type === "User") {
    return account.id === person.id ? null : `Only ${account.login} can connect their personal account, and ${person.login} signed in to GitHub.`;
  }
  if (found.suspendedAt !== null) return `${account.login} has suspended the Uplink Room App on GitHub, so Uplink Room can't check its owners. Unsuspend it there, then connect again.`;
  const membership = await memberOf(await installationToken(config, choice.installationId), account.login, person.login);
  const owner = membership?.state === "active" && membership.role === "admin" && membership.userId === person.id;
  return owner ? null : `Only an owner of ${account.login} can connect it, and GitHub no longer lists ${person.login} as one.`;
}

export const check = internalAction({
  args: { connectId: v.id("githubConnects"), installationId: v.number(), at: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const config = githubConfig();
    const input = await ctx.runQuery(internal.github.confirmInput, args);
    // Cancelled, expired, or replaced by a newer Connect: nothing to check.
    if (!input) return null;
    let refused: string | null;
    if (!config) {
      refused = "GitHub isn't set up on this deployment.";
    } else {
      try {
        refused = await stillOwner(config, input.person, input.choice);
      } catch (error) {
        const message = error instanceof GitHubError ? error.message : "GitHub didn't answer as expected.";
        refused = `Uplink Room couldn't check with GitHub that ${input.person.login} may still connect ${input.choice.login}. ${message}`;
      }
    }
    await ctx.runMutation(internal.github.confirm, { ...args, recheck: refused === null ? { ok: true } : { ok: false, why: refused } });
    return null;
  },
});
