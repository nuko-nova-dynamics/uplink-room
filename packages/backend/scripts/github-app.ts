/**
 * Registers the Uplink Room GitHub App with GitHub's manifest flow and puts its settings straight
 * into a Convex deployment's environment (ADR 0020). Nothing it receives is printed.
 *
 *   cd packages/backend
 *   node scripts/github-app.ts                 # the dev deployment in .env.local
 *   node scripts/github-app.ts --prod          # this project's production deployment
 *   node scripts/github-app.ts --org nuko-nova-dynamics --name "Uplink Room"
 *
 * Options:
 *   --prod                  use the production deployment
 *   --deployment <name>     use this deployment instead
 *   --org <login>           register the App under this organization (default: your personal account)
 *   --name <name>           the App's name on GitHub, unique across GitHub, 34 characters at most
 *   --port <port>           where the local page listens (default 3443)
 *   --site-url <url>        the deployment's https://<name>.convex.site, if it can't be read
 *   --force                 register even if the deployment already has a GitHub App
 *   --no-open               don't open the browser; print the local page's address
 *
 * It serves a page on 127.0.0.1 with GitHub's form, already filled with the manifest: the App
 * reads repository metadata and, in organizations, membership (only to check that whoever
 * connects an organization owns it), receives `repository` events (it gets `installation` and
 * `installation_repositories` without asking), and sends webhooks, the Setup URL and the Callback
 * URL to that deployment's `.convex.site`. GitHub then redirects back here with a one-hour code,
 * which this script exchanges (`POST /app-manifests/{code}/conversions`) for the App's id, slug,
 * client id, client secret, webhook secret and private key. Each goes to `npx convex env set` on
 * stdin, so no secret is ever in a command line, a file, or this terminal.
 */
import { spawn } from "node:child_process";
import { createPrivateKey, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const target = flag("prod") ? ["--prod"] : option("deployment") ? ["--deployment", option("deployment")!] : [];
const where = flag("prod") ? "the production deployment" : option("deployment") ?? "the dev deployment in .env.local";
const port = Number(option("port") ?? 3443);
const org = option("org");
const name = option("name") ?? (flag("prod") ? "Uplink Room" : "Uplink Room Dev");
const API_VERSION = "2026-03-10";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (name.length > 34) die("GitHub App names are at most 34 characters.");

/** Runs the Convex CLI from packages/backend; `input` goes to its stdin and nothing it prints is echoed. */
function convex(cli: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["convex", ...cli, ...target], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

async function siteUrl(): Promise<string> {
  const given = option("site-url");
  if (given) return given.replace(/\/+$/, "");
  const { code, stdout } = await convex(["run", "--inline-query", "process.env.CONVEX_SITE_URL"]);
  const url = code === 0 ? (JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as string | null) : null;
  if (!url) die(`Couldn't read ${where}'s site URL. Pass --site-url https://<name>.convex.site.`);
  return url.replace(/\/+$/, "");
}

const site = await siteUrl();
if (!site.startsWith("https://") && !flag("force")) {
  die(`${site} isn't https, so GitHub can't reach it. Use a cloud deployment, or --force for a dry run.`);
}
const existing = await convex(["env", "list", "--names-only"]);
if (existing.stdout.split(/\s+/).includes("GITHUB_APP_ID") && !flag("force")) {
  die(`${where} already has a GitHub App (GITHUB_APP_ID is set). Pass --force to register another and replace it.`);
}

const state = randomBytes(24).toString("base64url");
const local = `http://127.0.0.1:${port}`;
const manifest = {
  name,
  url: "https://uplinkroom.com",
  description: "Lists the repos you give it, so Uplink Room's projects and runs can pick them, and shows the state, reviews and checks of pull requests linked to tasks. It reads repository metadata, pull requests and checks, and organization membership only to check that whoever connects an organization owns it.",
  hook_attributes: { url: `${site}/github/webhook`, active: true },
  redirect_url: `${local}/registered`,
  callback_urls: [`${site}/github/callback`],
  setup_url: `${site}/github/setup`,
  setup_on_update: true,
  request_oauth_on_install: false,
  // Any account: team admins install it on their organizations and on their own personal accounts.
  public: true,
  // Members (read): `GET /user/memberships/orgs/{org}` needs it with a user token, to check that
  // whoever connects an organization is an owner (ADR 0020). The room makes no other call with it.
  // Pull requests and Checks (read): a task shows a linked pull request's state, reviews and checks
  // (ADR 0051), from these events and one read when it is linked.
  default_permissions: { metadata: "read", members: "read", pull_requests: "read", checks: "read" },
  default_events: ["repository", "pull_request", "pull_request_review", "check_suite"],
};
const action = org
  ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Register the Uplink Room GitHub App</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px}button{font:inherit;font-weight:700;padding:8px 14px}code{font-size:13px}</style>${body}`;

const ENV: [string, (app: Record<string, unknown>) => string][] = [
  ["GITHUB_APP_ID", (a) => String(a["id"])],
  ["GITHUB_APP_SLUG", (a) => String(a["slug"])],
  ["GITHUB_CLIENT_ID", (a) => String(a["client_id"])],
  ["GITHUB_CLIENT_SECRET", (a) => String(a["client_secret"])],
  ["GITHUB_WEBHOOK_SECRET", (a) => String(a["webhook_secret"])],
  // PKCS #8, which the backend imports with Web Crypto (GitHub's download is PKCS #1).
  ["GITHUB_APP_PRIVATE_KEY", (a) => createPrivateKey(String(a["pem"])).export({ type: "pkcs8", format: "pem" }).toString()],
];

let finished = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", local);
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      page(`<h1>Register the GitHub App</h1>
<p>GitHub opens with the App <b>${escape(name)}</b> filled in${org ? ` for <b>${escape(org)}</b>` : ""}. It reads repository metadata and organization membership, and sends its webhooks to <code>${escape(site)}</code>.</p>
<form action="${escape(action)}" method="post"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button type="submit">Continue on GitHub</button></form>`),
    );
    return;
  }
  if (url.pathname !== "/registered" || finished) {
    response.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("<p>This redirect doesn't match the registration started here.</p>"));
    return;
  }
  finished = true;
  try {
    const converted = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION, "user-agent": "uplink-room" },
    });
    if (converted.status !== 201) throw new Error(`GitHub refused the manifest code (${converted.status}).`);
    const app = (await converted.json()) as Record<string, unknown>;
    for (const [envName, value] of ENV) {
      const result = await convex(["env", "set", envName], value(app));
      if (result.code !== 0) throw new Error(`npx convex env set ${envName} failed on ${where}.`);
      console.log(`Set ${envName} on ${where}.`);
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page(`<h1>Registered</h1><p>The App's settings are in ${escape(where)}'s environment. You can close this tab.</p>`));
    console.log(`\nRegistered the GitHub App. Next: deploy the backend to ${where} if it doesn't have the GitHub code yet, then in Uplink Room open Settings, then GitHub, and choose Connect.`);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    response.end(page(`<p>${escape(error instanceof Error ? error.message : "The registration failed.")}</p>`));
    console.error(error instanceof Error ? error.message : "The registration failed.");
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Registering "${name}"${org ? ` under ${org}` : ""} for ${where} (${site}).`);
  console.log(`Open ${local} and continue on GitHub. The code GitHub sends back works for an hour.`);
  if (!flag("no-open")) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [local], { stdio: "ignore", detached: true }).unref();
});
