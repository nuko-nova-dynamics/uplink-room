/**
 * GitHub's side of the room, over HTTP (ADR 0020).
 *
 * Connecting an account, in a person's browser:
 *
 *   GET  /github/connect?state=…   from the app's Connect button. Keeps the state in a cookie and
 *                                  sends the person to GitHub to install the App.
 *   GET  /github/setup             GitHub's Setup URL, after an install or a change of repos. Its
 *                                  `installation_id` is only a claim. With a connect in progress
 *                                  (the state, from the cookie), it starts GitHub's web flow with
 *                                  PKCE so the person authorizes the App.
 *   GET  /github/callback          GitHub's Callback URL. Checks the state, trades the code for a
 *                                  user token, asks GitHub which installations that person can
 *                                  access (`GET /user/installations`) and whether they may share
 *                                  each, keeps that on the flow, and says to return to Uplink Room.
 *                                  The token is dropped here.
 *   POST /github/confirm           The confirm page's button, from before Confirm moved into the
 *                                  app. It links nothing now, and says to finish in the app.
 *
 * The browser knows who signed in to GitHub but not which person in the room is at the keyboard: a
 * Connect link can be opened by anyone it's sent to. So nothing is linked here. The person who started
 * the flow confirms in the app, signed in as themselves (`github.confirmConnect`), and the room asks
 * GitHub again before linking (githubConfirm.ts).
 *
 * Each step checks who started the flow as they are now (`starterRefused`): a person still in the team,
 * and still an admin if they started as one. A flow an agent started connects nothing.
 *
 * And GitHub's webhooks: POST /github/webhook, checked against `X-Hub-Signature-256`.
 */
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { sha256 } from "./lib/crypto";
import { readBody } from "./lib/requestBody";
import { exchangeCode, GitHubError, orgMembership, userIdentity, userInstallations, type GitHubInstallation } from "./lib/github/api";
import {
  CALLBACK_PATH,
  CONFIRM_PATH,
  CONNECT_PATH,
  githubConfig,
  SETUP_PATH,
  WEBHOOK_PATH,
  type GitHubConfig,
} from "./lib/github/config";
import { checkState, pkceChallenge, stateKey, stateNonce, verifyWebhookSignature } from "./lib/github/crypto";
import { parseEvent } from "./lib/github/events";
import { accountList, actions, escapeHtml, login, page, type AccountChoice } from "./lib/github/pages";

/** `__Host-`: only this exact origin, over https, at path `/`. */
const COOKIE = "__Host-uplink-github-connect";
const COOKIE_MAX_AGE = 30 * 60;

const AGAIN = "In Uplink Room, open Settings, then GitHub, and choose Connect a GitHub account or organization again.";
/** At most this many organizations are checked for ownership on one page. */
const MAX_OWNER_CHECKS = 25;

/**
 * Why an account can't be connected from this page: `owner`, the person doesn't own the
 * organization on GitHub; `admin`, whoever started the flow isn't an admin of the team, and only
 * admins connect organizations; `self`, it's someone else's personal account; `limit`, an
 * organization past the ones checked on one page.
 */
type Refusal = AccountChoice["refusal"];

type Authority = { canShare: boolean; why?: string; reason?: string; refusal?: Refusal };

/**
 * Whether the person may give a team this installation's every repo, including private repos they
 * can't see themselves (ADR 0020): an organization only as one of its active owners, and only in a
 * flow a team admin started; a personal account only as that person. Being able to access the
 * installation isn't enough: GitHub lists an installation to anyone who can read one of its repos.
 * `orgs`: "check" asks GitHub, "limit" is past the ones checked, "admins" means the flow's starter
 * isn't an admin, so no organization is asked about.
 */
async function authority(
  token: string,
  me: { login: string; id: number },
  installation: GitHubInstallation,
  orgs: "check" | "limit" | "admins",
  teamName: string,
): Promise<Authority> {
  const account = installation.account;
  if (account.type === "User") {
    const reason = `You're signed in to GitHub as ${me.login}.`;
    return account.id === me.id
      ? { canShare: true }
      : { canShare: false, why: `Only ${account.login} can connect their personal account. ${reason}`, reason, refusal: "self" };
  }
  if (orgs === "admins") {
    const reason = `Only an admin of ${teamName} can connect an organization to it. You can connect your own personal account.`;
    return { canShare: false, why: reason, reason, refusal: "admin" };
  }
  if (orgs === "limit") {
    const reason = `Uplink Room checks at most ${MAX_OWNER_CHECKS} organizations at once. Choose Connect again in Uplink Room and pick ${account.login} on GitHub's install page.`;
    return { canShare: false, why: reason, reason, refusal: "limit" };
  }
  const reason = `It gives Uplink Room every repo the organization picked for the App, including private repos you may not be able to see. GitHub doesn't list ${me.login} as an owner.`;
  const membership = await orgMembership(token, account.login);
  return membership?.state === "active" && membership.role === "admin"
    ? { canShare: true }
    : { canShare: false, why: `Only an owner of ${account.login} can connect it. ${reason}`, reason, refusal: "owner" };
}

function setCookie(state: string): string {
  return `${COOKIE}=${state}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function cookieState(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return null;
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function appLink(teamId: string): string {
  return `uplink-room://open/team/${teamId}/settings/github`;
}

const notConfigured = () =>
  page({
    title: "GitHub isn't set up",
    heading: "GitHub isn't set up on this deployment",
    paragraphs: ["An admin registers the Uplink Room GitHub App first. Nothing was connected."],
    status: 404,
  });

const expired = () =>
  page({
    title: "Link expired",
    heading: "This link expired or was already used",
    paragraphs: [`Nothing was connected. ${AGAIN}`],
    status: 400,
  });

/**
 * A page from before Confirm moved into the app (its form posts to /github/confirm), or a link
 * started then: it connects nothing, and says where connecting finishes now.
 */
const finishInApp = (teamId?: string) =>
  page({
    title: "Not connected",
    heading: "Connecting now finishes in Uplink Room",
    paragraphs: [
      "Whoever starts connecting a GitHub account confirms it in the Uplink Room app, signed in as themselves. This page is from before that change, so nothing was connected.",
      AGAIN,
    ],
    ...(teamId ? { extra: actions([{ href: appLink(teamId), label: "Open Uplink Room", primary: true }]) } : {}),
    status: 410,
  });

/**
 * A flow whose starter can connect nothing now gets this page at every step (ADR 0020): one an
 * agent started before agents were refused, one started by someone who has since left the team, one
 * an admin started who is no longer one, or one from before Confirm moved into the app.
 */
function starterRefused(flow: Flow): Response | null {
  const name = escapeHtml(flow.memberName);
  const team = escapeHtml(flow.teamName);
  if (flow.starter === "agent") {
    return page({
      title: "Not connected",
      heading: "Agents can't connect GitHub accounts",
      paragraphs: [
        `${name}, an agent, started this. A person connects their own GitHub account, or an admin an organization, in Uplink Room: Settings, then GitHub. Nothing was connected.`,
      ],
      status: 403,
    });
  }
  if (flow.starter === "gone") {
    return page({
      title: "Not connected",
      heading: `${name} is no longer in ${team}`,
      paragraphs: [`${name} started this link, so it can't connect anything to ${team} now. Nothing was connected.`],
      status: 403,
    });
  }
  if (flow.legacy) return finishInApp(flow.teamId);
  if (flow.demoted) {
    return page({
      title: "Not connected",
      heading: "This connect was cancelled",
      paragraphs: [`${name} started it as an admin of ${team} and is no longer one, so it can't connect anything now. Nothing was connected.`],
      status: 403,
    });
  }
  return null;
}

type Flow = NonNullable<Awaited<ReturnType<typeof loadFlowRow>>> & { state: string; nonceHash: string };

async function loadFlowRow(ctx: ActionCtx, nonceHash: string) {
  return ctx.runQuery(internal.github.connectFor, { nonceHash });
}

/**
 * The connect flow a state names, if its signature matches the team, admin and expiry it was
 * made for, and it hasn't expired or been used. The time is checked here, in the action.
 */
async function loadFlow(ctx: ActionCtx, config: GitHubConfig, state: string | null): Promise<Flow | null> {
  const nonce = stateNonce(state);
  if (!state || !nonce) return null;
  const nonceHash = await sha256(nonce);
  const row = await loadFlowRow(ctx, nonceHash);
  if (!row || row.used || row.expiresAt <= Date.now()) return null;
  const signed = await checkState(await stateKey(config.clientSecret), state, {
    teamId: row.teamId,
    memberId: row.memberId,
    expiresAt: row.expiresAt,
  });
  return signed ? { ...row, state, nonceHash } : null;
}

const connect = httpAction(async (ctx, request) => {
  const config = githubConfig();
  if (!config) return notConfigured();
  const state = new URL(request.url).searchParams.get("state");
  const flow = await loadFlow(ctx, config, state);
  if (!flow || flow.verified) return expired();
  const refused = starterRefused(flow);
  if (refused) return refused;
  return redirect(
    `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(flow.state)}`,
    setCookie(flow.state),
  );
});

const setup = httpAction(async (ctx, request) => {
  const config = githubConfig();
  if (!config) return notConfigured();
  const params = new URL(request.url).searchParams;
  const action = params.get("setup_action");
  if (action === "request") {
    return page({
      title: "Request sent",
      heading: "Request sent to the organization's owners",
      paragraphs: [
        "GitHub asked an owner to approve installing Uplink Room. Once one approves it, choose Connect again in Uplink Room and pick the organization.",
      ],
    });
  }
  // The state, if GitHub passed it through, or else the cookie from /github/connect.
  const flow = (await loadFlow(ctx, config, params.get("state"))) ?? (await loadFlow(ctx, config, cookieState(request)));
  if (!flow || flow.verified) {
    if (action === "update") {
      return page({
        title: "Saved on GitHub",
        heading: "Saved on GitHub",
        paragraphs: ["Uplink Room picks up the change to your repos on its own. You can close this tab."],
      });
    }
    return page({
      title: "Not connected yet",
      heading: "Installed on GitHub, but not connected yet",
      paragraphs: [
        "This browser has no connect in progress, so Uplink Room can't tell which team the account is for.",
        `${AGAIN.replace(" again.", ".")} GitHub then shows this account as installed: choose Configure, then Save.`,
      ],
    });
  }
  const refused = starterRefused(flow);
  if (refused) return refused;
  const claimed = Number(params.get("installation_id"));
  await ctx.runMutation(internal.github.setupReached, {
    nonceHash: flow.nonceHash,
    ...(Number.isSafeInteger(claimed) && claimed > 0 ? { installationId: claimed } : {}),
  });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", `${config.siteUrl}${CALLBACK_PATH}`);
  authorize.searchParams.set("state", flow.state);
  authorize.searchParams.set("code_challenge", await pkceChallenge(flow.codeVerifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  return redirect(authorize.toString());
});

const callback = httpAction(async (ctx, request) => {
  const config = githubConfig();
  if (!config) return notConfigured();
  const params = new URL(request.url).searchParams;
  // The web flow returns the state in the query, as sent ("Generating a user access token").
  const flow = await loadFlow(ctx, config, params.get("state"));
  if (!flow || flow.verified) return expired();
  // Before GitHub's code is traded for a token: whoever started this may still connect something.
  const refused = starterRefused(flow);
  if (refused) return refused;
  const admin = flow.starter === "admin";
  if (params.get("error")) {
    return page({
      title: "Not connected",
      heading: "Nothing was connected",
      paragraphs: [`You didn't authorize Uplink Room on GitHub. ${AGAIN}`],
    });
  }
  const code = params.get("code");
  if (!code || code.length > 200) return expired();
  let githubLogin: string;
  let githubUserId: number;
  let installations: (GitHubInstallation & Authority)[];
  try {
    const token = await exchangeCode(config, {
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: `${config.siteUrl}${CALLBACK_PATH}`,
    });
    // The token checks who the person is, which installations they can access, and whether they own
    // each one's account, then is dropped.
    const [me, listed] = await Promise.all([userIdentity(token), userInstallations(token)]);
    githubLogin = me.login;
    githubUserId = me.id;
    const ours = listed.filter((i) => i.appId === 0 || i.appId === config.appId);
    // The claimed installation is checked first, so it is always among the organizations checked.
    ours.sort((a, b) => Number(b.id === flow.claimedInstallationId) - Number(a.id === flow.claimedInstallationId));
    // A member's flow asks GitHub about no organization: only admins connect those.
    let orgs = 0;
    const orgCheck = (i: GitHubInstallation) => (!admin ? "admins" : i.account.type === "User" || orgs++ < MAX_OWNER_CHECKS ? "check" : "limit");
    installations = await Promise.all(ours.map(async (i) => ({ ...i, ...(await authority(token, me, i, orgCheck(i), flow.teamName)) })));
  } catch (error) {
    const message = error instanceof GitHubError ? error.message : "GitHub didn't answer as expected.";
    return page({
      title: "Not connected",
      heading: "GitHub didn't finish the sign-in",
      paragraphs: [`${escapeHtml(message)} Nothing was connected. ${AGAIN}`],
      status: 502,
    });
  }
  const connected = new Set(flow.connectedInstallations);
  const choices: AccountChoice[] = installations.map((i) => ({
    installationId: i.id,
    login: i.account.login,
    type: i.account.type,
    ...(i.account.avatarUrl ? { avatarUrl: i.account.avatarUrl } : {}),
    repositorySelection: i.repositorySelection,
    suspended: i.suspendedAt !== null,
    connected: connected.has(i.id),
    canShare: i.canShare,
    ...(i.refusal ? { refusal: i.refusal } : {}),
  }));
  const claimed = flow.claimedInstallationId !== undefined ? choices.find((c) => c.installationId === flow.claimedInstallationId) : undefined;
  const connectable = choices.filter((c) => !c.connected && c.canShare);
  // When this page already says everything (the account it was opened for is connected, or can't be,
  // or nothing GitHub listed can be connected), the flow ends here and the app doesn't offer it.
  const ended = claimed !== undefined ? claimed.connected || !claimed.canShare : connectable.length === 0;
  const kept = await ctx.runMutation(internal.github.verified, {
    nonceHash: flow.nonceHash,
    githubLogin,
    githubUserId,
    ended,
    accessible: installations.map((i) => ({
      installationId: i.id,
      accountGithubId: i.account.id,
      login: i.account.login,
      type: i.account.type,
      ...(i.account.avatarUrl ? { avatarUrl: i.account.avatarUrl } : {}),
      repositorySelection: i.repositorySelection,
      suspended: i.suspendedAt !== null,
      canShare: i.canShare,
      ...(i.why ? { why: i.why } : {}),
      ...(i.refusal ? { refusal: i.refusal } : {}),
    })),
  });
  if (!kept) return expired();
  // The browser part of the flow is over either way.
  const done = (response: Response) => withCookie(response, clearCookie());
  const team = escapeHtml(flow.teamName);
  const starter = escapeHtml(flow.memberName);
  const who = `<strong>${escapeHtml(githubLogin)}</strong>`;
  const install = `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`;
  const back = actions([{ href: appLink(flow.teamId), label: "Return to Uplink Room", primary: true }]);

  if (claimed?.connected) {
    return done(
      page({
        title: "Already connected",
        heading: `${login(claimed.login)} is already connected to ${team}`,
        paragraphs: ["Its repos are already in Uplink Room's repo pickers."],
        extra: back,
      }),
    );
  }
  if (claimed && !claimed.canShare) {
    const reason = installations.find((i) => i.id === claimed.installationId)?.reason ?? "";
    const heading = {
      owner: `Only an owner of ${login(claimed.login)} can connect it`,
      admin: `Only an admin of ${team} can connect ${login(claimed.login)}`,
      self: `Only ${login(claimed.login)} can connect this account`,
      limit: `Uplink Room didn't check ${login(claimed.login)}`,
    }[claimed.refusal ?? (claimed.type === "Organization" ? "owner" : "self")];
    return done(page({ title: "Not connected", heading, paragraphs: [`${escapeHtml(reason)} Nothing was connected.`] }));
  }
  const notConfirmed =
    flow.claimedInstallationId !== undefined && !claimed
      ? `GitHub didn't confirm that ${escapeHtml(githubLogin)} can access the account this page was opened for, so it can't be connected. `
      : "";
  if (choices.filter((c) => !c.connected).length === 0) {
    return done(
      page({
        title: "No account to connect",
        heading: "No account to connect",
        paragraphs: [
          `${notConfirmed}GitHub lists no other account where ${escapeHtml(githubLogin)} can use the Uplink Room App. Install it on an account on GitHub, then choose Connect again in Uplink Room.`,
        ],
        extra: actions([{ href: install, label: "Install on GitHub", primary: true }]),
      }),
    );
  }
  if (connectable.length === 0) {
    const may = flow.starter === "admin" ? "an organization you own, or your own personal account" : "your own personal account";
    return done(
      page({
        title: "Not connected",
        heading: "No account here can be connected",
        paragraphs: [`${notConfirmed}These are the GitHub accounts where ${who} can use the Uplink Room App. From this link you can connect ${may}. Nothing was connected.`],
        extra: accountList(choices),
      }),
    );
  }
  // Nothing is linked from the browser: the person who started this confirms in the app.
  const found = claimed
    ? `GitHub signed you in as ${who}, and the Uplink Room App is installed on <strong>${escapeHtml(claimed.login)}</strong>.`
    : `${notConfirmed}GitHub signed you in as ${who}, and lists ${connectable.length === 1 ? "one account" : `${connectable.length} accounts`} with the Uplink Room App that can be connected.`;
  return done(
    page({
      title: "Return to Uplink Room",
      heading: "Return to Uplink Room to finish",
      paragraphs: [
        found,
        `${starter} started this in Uplink Room and confirms it there, in Settings, then GitHub. Nothing is connected to ${team} until then.`,
        `If you aren't ${starter}, you can close this tab.`,
      ],
      extra: back,
    }),
  );
});

/** The confirm page's button, from before Confirm moved into the app: it links nothing now. */
const confirm = httpAction(async () => withCookie(finishInApp(), clearCookie()));

/** GitHub caps a webhook's payload at 25 MB ("Webhook events and payloads", Payload cap). */
const WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

const webhook = httpAction(async (ctx, request) => {
  const config = githubConfig();
  if (!config) return new Response("GitHub isn't set up on this deployment.", { status: 404 });
  const read = await readBody(request, { maxBytes: WEBHOOK_BODY_BYTES });
  if (!read.ok) return new Response(read.message, { status: read.status });
  const body = read.bytes;
  if (!(await verifyWebhookSignature(config.webhookSecret, body, request.headers.get("x-hub-signature-256")))) {
    return new Response("Bad signature.", { status: 401 });
  }
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!deliveryId || deliveryId.length > 100) return new Response("Missing X-GitHub-Delivery.", { status: 400 });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("The body isn't JSON.", { status: 400 });
  }
  const event = parseEvent(request.headers.get("x-github-event"), payload);
  if (!event) return new Response("Ignored.", { status: 200 });
  const result = await ctx.runMutation(internal.github.applyWebhook, { deliveryId, event });
  return new Response(result === "duplicate" ? "Already applied." : "Applied.", { status: 200 });
});

export function githubRoutes(http: HttpRouter): void {
  http.route({ path: CONNECT_PATH, method: "GET", handler: connect });
  http.route({ path: SETUP_PATH, method: "GET", handler: setup });
  http.route({ path: CALLBACK_PATH, method: "GET", handler: callback });
  http.route({ path: CONFIRM_PATH, method: "POST", handler: confirm });
  http.route({ path: WEBHOOK_PATH, method: "POST", handler: webhook });
}
