/**
 * The GitHub App's settings (ADR 0020), from the Convex environment. `scripts/github-app.ts`
 * registers the App with GitHub's manifest flow and sets all six; nothing here is ever logged or
 * returned by a query.
 */
export const GITHUB_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

export type GitHubConfig = {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
  /** This deployment's `https://<name>.convex.site`, where GitHub sends people and webhooks. */
  siteUrl: string;
};

export function missingGitHubEnv(): string[] {
  return GITHUB_ENV.filter((name) => !process.env[name]);
}

/** The settings, or null when the deployment doesn't have them all yet. */
export function githubConfig(): GitHubConfig | null {
  if (missingGitHubEnv().length > 0) return null;
  const appId = Number(process.env["GITHUB_APP_ID"]);
  if (!Number.isSafeInteger(appId)) return null;
  return {
    appId,
    slug: process.env["GITHUB_APP_SLUG"]!,
    clientId: process.env["GITHUB_CLIENT_ID"]!,
    clientSecret: process.env["GITHUB_CLIENT_SECRET"]!,
    webhookSecret: process.env["GITHUB_WEBHOOK_SECRET"]!,
    privateKey: process.env["GITHUB_APP_PRIVATE_KEY"]!,
    siteUrl: (process.env["CONVEX_SITE_URL"] ?? "").replace(/\/+$/, ""),
  };
}

/** Where GitHub sends people after an install or a repo change (the App's Setup URL). */
export const SETUP_PATH = "/github/setup";
/** Where GitHub sends people after they authorize the App (its Callback URL). */
export const CALLBACK_PATH = "/github/callback";
export const CONNECT_PATH = "/github/connect";
export const CONFIRM_PATH = "/github/confirm";
export const WEBHOOK_PATH = "/github/webhook";

/** GitHub's page for changing which repos an installation has. */
export function installationSettingsUrl(account: { login: string; type: "Organization" | "User" }, installationId: number): string {
  return account.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
}
