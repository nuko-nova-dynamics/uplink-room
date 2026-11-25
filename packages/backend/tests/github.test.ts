import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { SYNC_STALE_MS } from "../convex/github";
import type { Id } from "../convex/_generated/dataModel";
import { sha256 } from "../convex/lib/crypto";
import { appJwt, pkcs1ToPkcs8, randomToken, signState, stateKey, verifyWebhookSignature } from "../convex/lib/github/crypto";
import { APP, fakeGitHub, signedDelivery, SITE, type FakeGitHub } from "./fakeGitHub";
import { addAgent, addTeammate, bridgeInbox, callAsAgent, linkMachine, newLimitedRoom, newRoom, newTeam, settleScheduled, type Person, type Room } from "./setup";

/** ADR 0020: connected GitHub accounts and synced repos, against a fake GitHub (tests/fakeGitHub.ts). */

let gh: FakeGitHub;
const ORG = 51;
const PERSONAL = 52;

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
  vi.useRealTimers();
});

/** The app's Connect button: the link it opens, then GitHub's install page with the state kept in a cookie. */
async function startConnect(t: Room, person: Person, teamId: Id<"teams">) {
  const { url, connectId } = await person.as.mutation(api.github.connect, { teamId });
  return { ...(await openConnect(t, url)), connectId };
}

/** Opens a Connect link in the browser: GitHub's install page, with the state kept in a cookie. */
async function openConnect(t: Room, url: string) {
  expect(url.startsWith(`${SITE}/github/connect?state=`)).toBe(true);
  const response = await t.fetch(url.slice(SITE.length));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    `https://github.com/apps/${APP.slug}/installations/new?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}`,
  );
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  return { url, cookie: cookie.split(";")[0]! };
}

/** GitHub sends the person to the Setup URL, the room sends them to authorize, and GitHub back to the callback. */
async function finishOnGitHub(t: Room, cookie: string, installationId: number, login: string) {
  const setup = await t.fetch(`/github/setup?installation_id=${installationId}&setup_action=install`, { headers: { cookie } });
  expect(setup.status).toBe(302);
  const authorize = setup.headers.get("location")!;
  expect(new URL(authorize).searchParams.get("redirect_uri")).toBe(`${SITE}/github/callback`);
  const response = await t.fetch(gh.authorize(authorize, login));
  return { status: response.status, html: await response.text(), cookie: response.headers.get("set-cookie") };
}

/** A page's text without its tags, as a person reads it. */
const strip = (html: string) => html.replace(/<[^>]+>/g, "");

/** The person's connects waiting in the app (github.connects). */
async function pending(person: Person, teamId: Id<"teams">) {
  return person.as.query(api.github.connects, { teamId });
}

/**
 * Connect, in the app, signed in as `person`; then the room's check with GitHub runs. Returns the
 * flow as the app then shows it.
 */
async function confirmInApp(t: Room, person: Person, teamId: Id<"teams">, connectId: Id<"githubConnects">, installationId: number) {
  await person.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId });
  await settleScheduled(t);
  return (await pending(person, teamId)).find((c) => c.connectId === connectId);
}

/** The confirm page's button from before Confirm moved into the app, posted again. */
async function postOldConfirm(t: Room, fields: Record<string, string>) {
  const response = await t.fetch("/github/confirm", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, html: await response.text(), cookie: response.headers.get("set-cookie") };
}

/**
 * Holds the room's next call to `GET /app/installations/{id}` (Confirm's check with GitHub) until
 * `release`, so a test can change the team while the check is asking GitHub.
 */
function holdConfirmCheck() {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const asking = new Promise<void>((resolve) => (reached = resolve));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname.startsWith("/app/installations/")) {
      reached();
      await gate;
    }
    return gh.fetch(input, init);
  });
  return { asking, release };
}

/** Connects an installation end to end, confirming in the app, and lets its first sync finish. */
async function connectAccount(t: Room, person: Person, teamId: Id<"teams">, installationId: number, login = "julio") {
  const { cookie, connectId } = await startConnect(t, person, teamId);
  const { html } = await finishOnGitHub(t, cookie, installationId, login);
  expect(strip(html)).toContain("Return to Uplink Room to finish");
  expect(await confirmInApp(t, person, teamId, connectId, installationId)).toMatchObject({ status: "connected" });
  await settleScheduled(t);
}

async function deliver(t: Room, event: string, payload: unknown, delivery?: string) {
  const response = await t.fetch("/github/webhook", await signedDelivery(event, payload, delivery ? { delivery } : {}));
  return { status: response.status, text: await response.text() };
}

test("webhook signatures match GitHub's test vector, and a delivery that isn't signed changes nothing", async () => {
  const body = new TextEncoder().encode("Hello, World!");
  const good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  expect(await verifyWebhookSignature("It's a Secret to Everybody", body, good)).toBe(true);
  expect(await verifyWebhookSignature("It's a Secret to Everybody", body, good.replace(/7$/, "8"))).toBe(false);
  expect(await verifyWebhookSignature("It's a Secret to Everybody", body, good.replace("sha256=", "sha1="))).toBe(false);
  expect(await verifyWebhookSignature("It's a Secret to Everybody", body, null)).toBe(false);

  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const forged = await signedDelivery("installation", { action: "deleted", installation: { id: ORG } }, { secret: "not-the-secret" });
  expect((await t.fetch("/github/webhook", forged)).status).toBe(401);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toHaveLength(1);
});

test("the App's JWT is RS256 and signs with GitHub's PKCS #1 key as with PKCS #8", async () => {
  expect(pkcs1ToPkcs8(gh.pkcs1)).toEqual(gh.pkcs8);
  const jwt = await appJwt({ appId: APP.id, privateKeyPem: gh.privateKeyPkcs1Pem });
  const [h, p, s] = jwt.split(".");
  const decode = (part: string) => Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", gh.publicKey, decode(s!), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  const claims = JSON.parse(new TextDecoder().decode(decode(p!)));
  expect(claims.iss).toBe(APP.id);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
});

test("an admin connects an organization: the browser says to return to the app, she confirms there, and its repos sync", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko-nova", repos: [[1, "nuko-nova/uplink-room", true], [2, "nuko-nova/site"]] });
  gh.grant("julio", [ORG]);

  const { url, cookie, connectId } = await startConnect(t, admin, teamId);
  const { html, cookie: cleared } = await finishOnGitHub(t, cookie, ORG, "julio");
  // The browser part ends here: it names who signed in to GitHub and who confirms, and links nothing.
  expect(strip(html)).toContain("Return to Uplink Room to finish");
  expect(strip(html)).toContain("GitHub signed you in as julio, and the Uplink Room App is installed on nuko-nova.");
  expect(strip(html)).toContain("Julio started this in Uplink Room and confirms it there, in Settings, then GitHub. Nothing is connected to Nuko Nova until then.");
  expect(html).toContain(`uplink-room://open/team/${teamId}/settings/github`);
  expect(html).not.toContain("<form");
  expect(cleared).toMatch(/Max-Age=0/);
  // The state is good once: the Connect link no longer works.
  expect((await t.fetch(url.slice(SITE.length))).status).toBe(400);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);

  // In the app: who signed in to GitHub, and what it would connect.
  const [flow] = await pending(admin, teamId);
  expect(flow).toMatchObject({ connectId, githubLogin: "julio", status: "waiting", teamName: "Nuko Nova" });
  expect(flow!.accounts).toEqual([
    expect.objectContaining({ installationId: ORG, login: "nuko-nova", type: "Organization", claimed: true, connected: false, canConnect: true }),
  ]);
  expect(await confirmInApp(t, admin, teamId, connectId, ORG)).toMatchObject({ status: "connected", connectedLogin: "nuko-nova" });
  await settleScheduled(t);

  const { accounts } = await admin.as.query(api.github.accounts, { teamId });
  expect(accounts).toEqual([
    expect.objectContaining({ login: "nuko-nova", type: "Organization", repoCount: 2, syncState: "synced", suspended: false, connectedBy: "Julio" }),
  ]);
  expect(accounts[0]!.settingsUrl).toBe(`https://github.com/organizations/nuko-nova/settings/installations/${ORG}`);
  const repos = await admin.as.query(api.github.repos, { teamId });
  expect(repos.map((r) => [r.repo, r.private])).toEqual([
    ["github.com/nuko-nova/site", false],
    ["github.com/nuko-nova/uplink-room", true],
  ]);
  // Confirming twice links nothing twice, Done clears it from the app, and the user token GitHub gave was never stored.
  await expect(admin.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId: ORG })).rejects.toThrow("This connect expired or already finished.");
  await admin.as.mutation(api.github.endConnect, { teamId, connectId });
  expect(await pending(admin, teamId)).toEqual([]);
  const stored = await t.run(async (ctx) => JSON.stringify(await ctx.db.query("githubConnects").collect()));
  for (const token of gh.userTokens()) expect(stored).not.toContain(token);
});

test("a forged, reused or expired state connects nothing, and neither does a Setup URL hit without one", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);

  const { url } = await admin.as.mutation(api.github.connect, { teamId });
  const state = new URL(url).searchParams.get("state")!;
  const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
  expect((await t.fetch(`/github/connect?state=${tampered}`)).status).toBe(400);
  expect((await t.fetch(`/github/connect?state=${state.split(".")[0]}`)).status).toBe(400);

  // Someone hits the Setup URL with an installation id of their choosing and no flow.
  const spoofed = await t.fetch(`/github/setup?installation_id=${ORG}&setup_action=install`);
  expect(spoofed.status).toBe(200);
  expect(await spoofed.text()).toContain("can't tell which team");
  const forgedCookie = await t.fetch(`/github/setup?installation_id=${ORG}&setup_action=install`, {
    headers: { cookie: `__Host-uplink-github-connect=${tampered}` },
  });
  expect(await forgedCookie.text()).toContain("can't tell which team");

  // An hour later the real state has expired too.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * 60 * 1000 });
  expect((await t.fetch(`/github/connect?state=${state}`)).status).toBe(400);
  vi.useRealTimers();
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});

test("an installation GitHub doesn't confirm the person can access isn't connected", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "someone-elses-org", repos: [[1, "someone-elses-org/secret"]] });
  gh.install({ id: PERSONAL, login: "julio", type: "User", repos: [[2, "julio/dotfiles"]] });
  gh.grant("julio", [PERSONAL]);

  const { cookie, connectId } = await startConnect(t, admin, teamId);
  // The Setup URL claims ORG, which julio can't access on GitHub.
  const { html } = await finishOnGitHub(t, cookie, ORG, "julio");
  expect(html).toContain("GitHub didn't confirm that julio can access the account");
  expect(html).not.toContain("someone-elses-org");
  // The app offers only what GitHub listed; asking for ORG anyway is refused.
  expect((await pending(admin, teamId))[0]!.accounts.map((a) => a.login)).toEqual(["julio"]);
  await expect(admin.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId: ORG })).rejects.toThrow("GitHub didn't list that account for julio.");
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});

test("a member can't sync, change the repos of, or disconnect an organization; every member and agent with room.read sees its repos", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);

  await connectAccount(t, admin, teamId, ORG);
  const seen = await ana.as.query(api.github.accounts, { teamId });
  expect(seen).toMatchObject({ canConnect: true, canConnectOrganizations: false });
  // Change which repos is GitHub's page for the installation: a member isn't given it for an organization.
  expect(seen.accounts[0]).toMatchObject({ login: "nuko", mine: false, canSync: false, canChangeRepos: false, canDisconnect: false, connectedBy: "Julio" });
  expect(seen.accounts[0]!.settingsUrl).toBeUndefined();
  const accountId = seen.accounts[0]!.accountId;
  expect((await ana.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["nuko/billing"]);
  await expect(ana.as.mutation(api.github.sync, { teamId, accountId })).rejects.toThrow("Only admins can sync nuko: it's an organization");
  await expect(ana.as.mutation(api.github.disconnect, { teamId, accountId })).rejects.toThrow("Only admins can disconnect nuko: it's an organization");
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({
    canSync: true,
    canChangeRepos: true,
    canDisconnect: true,
    settingsUrl: `https://github.com/organizations/nuko/settings/installations/${ORG}`,
  });

  const { key } = await addAgent(t, teamId, admin, "Planner", ["room.read"]);
  const listed = await callAsAgent(t, key, "github.repos", { search: "bill" });
  expect(listed.result.map((r: { repo: string }) => r.repo)).toEqual(["github.com/nuko/billing"]);
  expect((await callAsAgent(t, key, "github.connect")).error?.code).toBe("forbidden");
});

test("webhooks add, remove and rename synced repos once per delivery, and a rename follows GitHub's id into projects", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  // A project made before GitHub was connected, listing the repo as a person typed it.
  const early = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: ["Nuko/Billing"] });
  gh.install({ id: ORG, login: "nuko", selection: "selected", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const picked = await admin.as.mutation(api.projects.create, { teamId, name: "Payments", repos: ["github.com/nuko/billing", "github.com/other/billing"] });

  const repo = (id: number, full_name: string) => ({ id, node_id: `R_${id}`, name: full_name.split("/")[1], full_name, private: false });
  const added = crypto.randomUUID();
  gh.installations.get(ORG)!.repos.push({ id: 2, full_name: "nuko/docs", private: false, archived: false, default_branch: "main" });
  await deliver(t, "installation_repositories", { action: "added", installation: { id: ORG }, repository_selection: "selected", repositories_added: [repo(2, "nuko/docs")], repositories_removed: [] }, added);
  await settleScheduled(t);
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["nuko/billing", "nuko/docs"]);
  gh.installations.get(ORG)!.repos.pop();

  await deliver(t, "installation_repositories", { action: "removed", installation: { id: ORG }, repository_selection: "selected", repositories_added: [], repositories_removed: [repo(2, "nuko/docs")] });
  // GitHub redelivers the "added" one: it was applied already, so docs stays removed.
  expect((await deliver(t, "installation_repositories", { action: "added", installation: { id: ORG }, repository_selection: "selected", repositories_added: [repo(2, "nuko/docs")], repositories_removed: [] }, added)).text).toBe("Already applied.");
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["nuko/billing"]);

  await deliver(t, "repository", {
    action: "renamed",
    installation: { id: ORG },
    changes: { repository: { name: { from: "billing" } } },
    repository: { id: 1, full_name: "nuko/payments", private: false, archived: false, default_branch: "main" },
  });
  await settleScheduled(t);
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => r.repo)).toEqual(["github.com/nuko/payments"]);
  const projects = await admin.as.query(api.projects.list, { teamId });
  expect(projects.find((p) => p.projectId === early)!.repos).toEqual(["github.com/nuko/payments"]);
  // The other repo named billing is a different repo on GitHub, and keeps its name.
  expect(projects.find((p) => p.projectId === picked)!.repos).toEqual(["github.com/nuko/payments", "github.com/other/billing"]);
});

test("a sync drops what GitHub no longer gives, an uninstall drops the account, and projects keep their repo strings", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"], [2, "nuko/docs"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  await admin.as.mutation(api.projects.create, { teamId, name: "Docs", repos: ["github.com/nuko/docs"] });
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId;

  // Deleted on GitHub, which sends Apps no event: the next sync drops it.
  gh.installations.get(ORG)!.repos = gh.installations.get(ORG)!.repos.filter((r) => r.id !== 2);
  await admin.as.mutation(api.github.sync, { teamId, accountId });
  await settleScheduled(t);
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["nuko/billing"]);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ repoCount: 1, syncState: "synced" });
  const status = await admin.as.query(api.github.repoStatus, { teamId, repos: ["github.com/nuko/docs", "github.com/NUKO/billing"] });
  expect(status.map((s) => s.synced?.fullName ?? null)).toEqual([null, "nuko/billing"]);

  await deliver(t, "installation", { action: "deleted", installation: { id: ORG, account: { id: 1, login: "nuko", type: "Organization" } } });
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await admin.as.query(api.github.repos, { teamId })).toEqual([]);
  expect((await admin.as.query(api.projects.list, { teamId }))[0]!.repos).toEqual(["github.com/nuko/docs"]);
  expect(await t.run((ctx) => ctx.db.query("githubRepos").collect())).toEqual([]);
});

test("a suspended installation stays listed and marked, and syncs again once unsuspended", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId;

  await deliver(t, "installation", { action: "suspend", installation: { id: ORG } });
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ suspended: true, repoCount: 1 });
  await expect(admin.as.mutation(api.github.sync, { teamId, accountId })).rejects.toThrow(/suspended the App/);

  gh.installations.get(ORG)!.repos.push({ id: 3, full_name: "nuko/api", private: true, archived: false, default_branch: "trunk" });
  await deliver(t, "installation", { action: "unsuspend", installation: { id: ORG } });
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ suspended: false, repoCount: 2 });
  expect((await admin.as.query(api.github.repos, { teamId, search: "api" }))[0]).toMatchObject({ defaultBranch: "trunk", private: true });
});

test("the daily sync catches an unsuspend, and then an uninstall, whose webhooks never arrived", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  gh.installations.get(ORG)!.suspended_at = "2026-11-04T12:00:00Z";
  await deliver(t, "installation", { action: "suspend", installation: { id: ORG } });
  await t.mutation(internal.github.syncAll, {});
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ suspended: true, syncState: "synced" });

  // Unsuspended on GitHub, and the webhook was lost.
  gh.installations.get(ORG)!.suspended_at = null;
  gh.installations.get(ORG)!.repos.push({ id: 2, full_name: "nuko/ledger", private: true, archived: false, default_branch: "main" });
  await t.mutation(internal.github.syncAll, {});
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ suspended: false, repoCount: 2 });

  // Suspended and then uninstalled, and neither webhook arrived after the first: its repos leave the team.
  await deliver(t, "installation", { action: "suspend", installation: { id: ORG } });
  gh.installations.delete(ORG);
  await t.mutation(internal.github.syncAll, {});
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await admin.as.query(api.github.repos, { teamId })).toEqual([]);
});

test("the repo search matches the start of each word in a repo's name", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko-nova", repos: [[1, "nuko-nova/uplink-room"], [2, "nuko-nova/uplink-site"], [3, "nuko-nova/room-service"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const search = async (text: string) => (await admin.as.query(api.github.repos, { teamId, search: text })).map((r) => r.fullName);
  expect(await search("upl ro")).toEqual(["nuko-nova/uplink-room"]);
  expect(await search("room")).toEqual(["nuko-nova/uplink-room", "nuko-nova/room-service"]);
  expect(await search("ink")).toEqual([]);
  expect((await admin.as.query(api.github.repos, { teamId, limit: 2 })).length).toBe(2);
});

// ---------- Codex review round 1 (PR #116): one test per finding, each with its trigger ----------

test("P1: a member who reads one repo of an organization can't connect it, nor anyone else's personal account", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  // GitHub lists an installation to anyone with read access to one of its repos.
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"], [2, "nuko/payroll", true]] });
  gh.install({ id: PERSONAL, login: "julio", type: "User", repos: [[3, "julio/dotfiles"]] });
  gh.install({ id: 53, login: "ana", type: "User", repos: [[4, "ana/notes", true]] });
  gh.grant("julio", [ORG, PERSONAL, 53], "member");

  const org = await finishOnGitHub(t, (await startConnect(t, admin, teamId)).cookie, ORG, "julio");
  expect(strip(org.html)).toContain("Only an owner of nuko can connect it");
  expect(org.html).not.toContain("Return to Uplink Room to finish");
  const someoneElse = await finishOnGitHub(t, (await startConnect(t, admin, teamId)).cookie, 53, "julio");
  expect(strip(someoneElse.html)).toContain("Only ana can connect this account");
  // Those pages said everything: the app doesn't offer either flow.
  expect(await pending(admin, teamId)).toEqual([]);

  // His own account is his to connect; asking the app for the organization instead is refused.
  const own = await startConnect(t, admin, teamId);
  await finishOnGitHub(t, own.cookie, PERSONAL, "julio");
  const [flow] = await pending(admin, teamId);
  expect(flow!.accounts.map((a) => [a.login, a.canConnect, a.refusal])).toEqual([
    ["julio", true, undefined],
    ["nuko", false, "owner"],
    ["ana", false, "self"],
  ]);
  await expect(admin.as.mutation(api.github.confirmConnect, { teamId, connectId: own.connectId, installationId: ORG })).rejects.toThrow("Only an owner of nuko can connect it");
  await expect(admin.as.mutation(api.github.confirmConnect, { teamId, connectId: own.connectId, installationId: 53 })).rejects.toThrow("Only ana can connect their personal account");
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("githubRepos").collect())).toEqual([]);
});

test("P1: an owner demoted, or removed, between GitHub's callback and Confirm can't connect the organization", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"], [2, "nuko/payroll", true]] });
  gh.grant("julio", [ORG]);
  for (const after of ["member", null] as const) {
    gh.setRole("julio", "nuko", "admin");
    const { cookie, connectId } = await startConnect(t, admin, teamId);
    await finishOnGitHub(t, cookie, ORG, "julio");
    // GitHub said owner at the callback; by the time Julio chooses Connect in the app, it doesn't.
    gh.setRole("julio", "nuko", after);
    const flow = await confirmInApp(t, admin, teamId, connectId, ORG);
    expect(flow).toMatchObject({ status: "waiting" });
    expect(flow!.accounts[0]!.refused).toBe("Only an owner of nuko can connect it, and GitHub no longer lists julio as one.");
    await admin.as.mutation(api.github.endConnect, { teamId, connectId });
  }
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("githubRepos").collect())).toEqual([]);
});

test("a personal account whose App was uninstalled between GitHub's callback and Confirm isn't connected", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: PERSONAL, login: "julio", type: "User", repos: [[3, "julio/dotfiles"]] });
  gh.grant("julio", [PERSONAL]);
  const { cookie, connectId } = await startConnect(t, admin, teamId);
  await finishOnGitHub(t, cookie, PERSONAL, "julio");
  gh.installations.delete(PERSONAL);
  const flow = await confirmInApp(t, admin, teamId, connectId, PERSONAL);
  expect(flow!.accounts[0]!.refused).toBe("The Uplink Room App is no longer installed on julio.");
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});

test("an agent can't connect or confirm anything, an admin agent with team.admin included, and a flow an agent started earlier connects nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Deployer", ["team.admin", "room.read"]);
  const deployer = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Deployer")!;
  await admin.as.mutation(api.members.setRole, { teamId, memberId: deployer.memberId, role: "admin" });
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"]] });
  gh.install({ id: PERSONAL, login: "julio", type: "User", repos: [[2, "julio/dotfiles"]] });
  gh.grant("julio", [ORG, PERSONAL]);

  const refused = await callAsAgent(t, key, "github.connect");
  expect(refused.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("Agents can't connect GitHub accounts") });
  expect((await callAsAgent(t, key, "github.accounts")).result).toMatchObject({ canConnect: false, canConnectOrganizations: false });
  expect(await t.run((ctx) => ctx.db.query("githubConnects").collect())).toEqual([]);

  // Julio's connect, waiting for him in the app: the agent sees none, and can't confirm or cancel it.
  const julios = await startConnect(t, admin, teamId);
  await finishOnGitHub(t, julios.cookie, ORG, "julio");
  expect((await callAsAgent(t, key, "github.connects")).result).toEqual([]);
  const confirmed = await callAsAgent(t, key, "github.confirmConnect", { connectId: julios.connectId, installationId: ORG });
  expect(confirmed.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("Agents can't confirm GitHub connects") });
  expect((await callAsAgent(t, key, "github.endConnect", { connectId: julios.connectId })).error?.code).toBe("forbidden");

  // Flows the agent started before agents were refused, as if made today: still signed and live.
  // One not opened yet, and one GitHub already sent back to the room, waiting on Confirm.
  const agentFlow = async (verified: boolean) => {
    const nonce = randomToken();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const state = await signState(await stateKey(APP.clientSecret), nonce, { teamId, memberId: deployer.memberId, expiresAt });
    const connectId = await t.run(async (ctx) =>
      ctx.db.insert("githubConnects", {
        teamId,
        memberId: deployer.memberId as Id<"members">,
        nonceHash: await sha256(nonce),
        codeVerifier: randomToken(48),
        expiresAt,
        starterRole: "admin",
        ...(verified
          ? {
              githubLogin: "julio",
              githubUserId: 1,
              accessible: [{ installationId: PERSONAL, accountGithubId: 1, login: "julio", type: "User" as const, repositorySelection: "all" as const, suspended: false, canShare: true }],
              confirming: { installationId: PERSONAL, at: 1 },
            }
          : {}),
      }),
    );
    return { state, connectId };
  };
  const unopened = await agentFlow(false);
  const opened = await t.fetch(`/github/connect?state=${unopened.state}`);
  expect(opened.status).toBe(403);
  expect(strip(await opened.text())).toContain("Agents can't connect GitHub accounts");
  // The agent can't confirm its own flow: it's refused as an agent, before anything is checked.
  const waiting = await agentFlow(true);
  const own = await callAsAgent(t, key, "github.confirmConnect", { connectId: waiting.connectId, installationId: PERSONAL });
  expect(own.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("Agents can't confirm GitHub connects") });
  // And the last step refuses it, whatever called it.
  expect(await t.mutation(internal.github.confirm, { connectId: waiting.connectId, installationId: PERSONAL, at: 1, recheck: { ok: true } })).toEqual({ ok: false, why: "agent" });
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});

test("a sync page GitHub sent before a rename and a removal, applied after their webhooks, undoes neither", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", selection: "selected", repos: [[1, "nuko/billing"], [2, "nuko/docs"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: ["github.com/nuko/billing"] });
  await settleScheduled(t);
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId;
  const pagesBefore = gh.calls.filter((c) => c.endsWith("/installation/repositories")).length;
  const generation = () => t.run(async (ctx) => (await ctx.db.get(accountId as Id<"githubAccounts">))!.syncGeneration);
  const before = await generation();

  // A sync asks GitHub for its first page; GitHub answers with billing and docs, and the answer is in flight.
  const held = gh.holdNextReposPage();
  await admin.as.mutation(api.github.sync, { teamId, accountId });
  await held.reached;
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Meanwhile billing is renamed and docs removed on GitHub, and both webhooks are applied.
  gh.installations.get(ORG)!.repos = [{ id: 1, full_name: "nuko/payments", private: false, archived: false, default_branch: "main" }];
  await deliver(t, "repository", {
    action: "renamed",
    installation: { id: ORG },
    repository: { id: 1, full_name: "nuko/payments", private: false, archived: false, default_branch: "main" },
  });
  await deliver(t, "installation_repositories", {
    action: "removed",
    installation: { id: ORG },
    repository_selection: "selected",
    repositories_added: [],
    repositories_removed: [{ id: 2, full_name: "nuko/docs", private: false }],
  });
  held.release();
  await settleScheduled(t);

  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["nuko/payments"]);
  expect((await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === projectId)!.repos).toEqual(["github.com/nuko/payments"]);
  // The sync that started before the webhooks didn't finish as synced: another one read GitHub again.
  expect(await generation()).toBeGreaterThanOrEqual(before + 2);
  expect(gh.calls.filter((c) => c.endsWith("/installation/repositories")).length).toBeGreaterThanOrEqual(pagesBefore + 2);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ syncState: "synced", repoCount: 1 });
});

test("a transfer renames the repo in projects first, between two accounts of one team and for a team that only had the old owner", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const other = await newTeam(t, "Rosa");
  gh.install({ id: ORG, login: "old-org", repos: [[7, "old-org/tool"]] });
  gh.install({ id: 61, login: "new-org", repos: [[8, "new-org/site"]] });
  gh.grant("julio", [ORG, 61]);
  gh.grant("rosa", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  await connectAccount(t, admin, teamId, 61);
  await connectAccount(t, other.admin, other.teamId, ORG, "rosa");
  const here = await admin.as.mutation(api.projects.create, { teamId, name: "Tool", repos: ["github.com/old-org/tool"] });
  const there = await other.admin.as.mutation(api.projects.create, { teamId: other.teamId, name: "Tool", repos: ["github.com/old-org/tool"] });

  // GitHub sends the transfer only to the new owner's installation.
  const moved = { id: 7, full_name: "new-org/tool", private: false, archived: false, default_branch: "main" };
  gh.installations.get(ORG)!.repos = [];
  gh.installations.get(61)!.repos.push(moved);
  await deliver(t, "repository", { action: "transferred", installation: { id: 61 }, changes: { owner: { from: { user: { login: "old-org" } } } }, repository: moved });
  await settleScheduled(t);

  expect((await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === here)!.repos).toEqual(["github.com/new-org/tool"]);
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => [r.fullName, r.account])).toEqual([
    ["new-org/site", "new-org"],
    ["new-org/tool", "new-org"],
  ]);
  const counts = (await admin.as.query(api.github.accounts, { teamId })).accounts.map((a) => [a.login, a.repoCount]);
  expect(counts).toEqual([["new-org", 2], ["old-org", 0]]);
  // Rosa's team never connected new-org: the project still follows the repo's name, and it shows as not connected.
  expect((await other.admin.as.query(api.projects.list, { teamId: other.teamId })).find((p) => p.projectId === there)!.repos).toEqual(["github.com/new-org/tool"]);
  expect(await other.admin.as.query(api.github.repos, { teamId: other.teamId })).toEqual([]);
});

test("linking new repos to many projects that list them stays inside Convex's per-function limits", async () => {
  const t = newLimitedRoom();
  const { teamId, admin } = await newTeam(t);
  // 60 new repos in 30 projects: linking them in the sync page's mutation read about 53,000 documents.
  const names = Array.from({ length: 60 }, (_, i) => `nuko/r${i}`);
  for (let i = 0; i < 30; i++) {
    await admin.as.mutation(api.projects.create, { teamId, name: `P${i}`, repos: names.map((n) => `github.com/${n}`) });
  }
  gh.install({ id: ORG, login: "nuko", repos: names.map((n, i) => [1000 + i, n] as [number, string]) });
  gh.grant("julio", [ORG]);
  // One sync page brings all 60; each linking batch reads 25 projects.
  await connectAccount(t, admin, teamId, ORG);
  const links = (githubId: number) =>
    t.run(async (ctx) =>
      (await ctx.db.query("projectRepoLinks").withIndex("by_github", (q) => q.eq("githubId", githubId)).collect()).filter((l) => l.teamId === teamId).length,
    );
  expect([await links(1000), await links(1030), await links(1059)]).toEqual([30, 30, 30]);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ syncState: "synced", repoCount: 60 });
  // What keeps each batch bounded: a project lists at most 200 repos, and says so.
  await expect(
    admin.as.mutation(api.projects.create, { teamId, name: "Too many", repos: Array.from({ length: 201 }, (_, i) => `nuko/x${i}`) }),
  ).rejects.toThrow(/at most 200 repos/);
});

test("a rename reaches every project in the team, past 500 links to the repo in other teams", async () => {
  const t = newRoom();
  const big = await newTeam(t);
  const small = await newTeam(t, "Rosa");
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  gh.grant("rosa", [ORG]);
  await connectAccount(t, big.admin, big.teamId, ORG);
  await connectAccount(t, small.admin, small.teamId, ORG, "rosa");
  // The other team's 501 links come first in GitHub-id order, then this team's one.
  for (let i = 0; i < 501; i++) {
    await big.admin.as.mutation(api.projects.create, { teamId: big.teamId, name: `P${i}`, repos: ["github.com/nuko/billing"] });
  }
  const mine = await small.admin.as.mutation(api.projects.create, { teamId: small.teamId, name: "Billing", repos: ["github.com/nuko/billing"] });

  await deliver(t, "repository", {
    action: "renamed",
    installation: { id: ORG },
    repository: { id: 1, full_name: "nuko/payments", private: false, archived: false, default_branch: "main" },
  });
  await settleScheduled(t);
  expect((await small.admin.as.query(api.projects.list, { teamId: small.teamId })).find((p) => p.projectId === mine)!.repos).toEqual([
    "github.com/nuko/payments",
  ]);
  const bigRepos = (await big.admin.as.query(api.projects.list, { teamId: big.teamId })).map((p) => p.repos[0]);
  expect(bigRepos).toHaveLength(501);
  expect(new Set(bigRepos)).toEqual(new Set(["github.com/nuko/payments"]));
});

test("a full owner/name search finds the repo however many repos share the owner's name", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  // 450 repos of one owner: the owner's word alone matches all of them, more than one search reads.
  gh.install({ id: ORG, login: "verylongorganization", repos: Array.from({ length: 450 }, (_, i) => [5000 + i, `verylongorganization/r${i + 1}`] as [number, string]) });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const search = async (text: string) => (await admin.as.query(api.github.repos, { teamId, search: text })).map((r) => r.fullName);
  expect((await search("verylongorganization/r225"))[0]).toBe("verylongorganization/r225");
  expect(await search("https://github.com/VeryLongOrganization/r225")).toContain("verylongorganization/r225");
  expect(await search("verylongorganization/r22")).toEqual(expect.arrayContaining(["verylongorganization/r22", "verylongorganization/r225"]));
});

// ---------- Codex review round 2 (PR #116, on 8e18504) ----------

test("a repo renamed while its account was disconnected is renamed in projects once the account is reconnected", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: ["github.com/nuko/billing"] });
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId;
  await admin.as.mutation(api.github.disconnect, { teamId, accountId });
  await settleScheduled(t);
  // Renamed on GitHub while nothing in the team followed it; the project's link by GitHub id stayed.
  gh.installations.get(ORG)!.repos = [{ id: 1, full_name: "nuko/payments", private: false, archived: false, default_branch: "main" }];
  await connectAccount(t, admin, teamId, ORG);
  expect((await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === projectId)!.repos).toEqual(["github.com/nuko/payments"]);
});

test("a rename that lands between a repo's first sync and its linking job still renames the projects that list the first name", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", selection: "selected", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Tools", repos: ["github.com/nuko/tools"] });
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId as Id<"githubAccounts">;

  // Scheduled work waits: a sync page brings tools and schedules its linking, and the rename's webhook lands first.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const generation = await t.run(async (ctx) => {
    const account = (await ctx.db.get(accountId))!;
    await ctx.db.patch(accountId, { syncState: "syncing", syncGeneration: account.syncGeneration + 1, syncStartedAt: Date.now() });
    return account.syncGeneration + 1;
  });
  await t.mutation(internal.github.syncPage, {
    accountId,
    generation,
    fetchedAt: Date.now(),
    repos: [{ id: 9, fullName: "nuko/tools", private: false, archived: false, defaultBranch: "main" }],
  });
  await deliver(t, "repository", {
    action: "renamed",
    installation: { id: ORG },
    repository: { id: 9, full_name: "nuko/toolkit", private: false, archived: false, default_branch: "main" },
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  expect((await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === projectId)!.repos).toEqual(["github.com/nuko/toolkit"]);
});

test("removing 100 repos from an installation that 25 teams connected stays inside Convex's per-function limits", async () => {
  const t = newLimitedRoom();
  const repos = Array.from({ length: 100 }, (_, i) => [3000 + i, `nuko/r${i}`] as [number, string]);
  gh.install({ id: ORG, login: "nuko", selection: "selected" });
  const teams: Awaited<ReturnType<typeof newTeam>>[] = [];
  for (let i = 0; i < 25; i++) {
    // The last two teams connect once the installation has its 100 repos, and sync them.
    if (i === 23) gh.installations.get(ORG)!.repos = repos.map(([id, full_name]) => ({ id, full_name, private: false, archived: false, default_branch: "main" }));
    const team = await newTeam(t, `Admin${i}`);
    gh.grant(`admin${i}`, [ORG]);
    await connectAccount(t, team.admin, team.teamId, ORG, `admin${i}`);
    teams.push(team);
  }
  // 100 changes is the most one delivery applies directly; 25 teams make it 2,500 removals.
  const removed = await deliver(t, "installation_repositories", {
    action: "removed",
    installation: { id: ORG },
    repository_selection: "selected",
    repositories_added: [],
    repositories_removed: repos.map(([id, full_name]) => ({ id, full_name, private: false })),
  });
  expect(removed.status).toBe(200);
  expect((await teams[24]!.admin.as.query(api.github.accounts, { teamId: teams[24]!.teamId })).accounts[0]!.repoCount).toBe(100);
  await settleScheduled(t);
  for (const team of teams) expect(await team.admin.as.query(api.github.repos, { teamId: team.teamId })).toEqual([]);
}, 60_000);

// ---------- Codex review round 3 (PR #116, on 45b2311 and bc57db0) ----------

test("the daily sync visits every connected account, past the first 1,000", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const memberId = (await admin.as.query(api.teams.members, { teamId }))[0]!.memberId as Id<"members">;
  await t.run(async (ctx) => {
    for (let i = 0; i < 1001; i++) {
      await ctx.db.insert("githubAccounts", {
        teamId,
        installationId: 70_000 + i,
        accountGithubId: 80_000 + i,
        login: `org${i}`,
        type: "Organization",
        repositorySelection: "all",
        connectedBy: memberId,
        connectedAt: Date.now(),
        repoCount: 0,
        syncState: "synced",
        syncGeneration: 0,
      });
    }
  });
  // The batches run now; the syncs they start wait their turn, spread over minutes.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  await t.mutation(internal.github.syncAll, {});
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
  const unvisited = await t.run(async (ctx) => (await ctx.db.query("githubAccounts").collect()).filter((a) => a.syncGeneration === 0).length);
  vi.useRealTimers();
  expect(unvisited).toBe(0);
});

test("a sync that didn't finish says when it went stale, and Sync now starts it again", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId as Id<"githubAccounts">;
  // Its action died without reporting: still "syncing", 16 minutes on.
  const startedAt = Date.now() - 16 * 60 * 1000;
  const generation = await t.run(async (ctx) => {
    const account = (await ctx.db.get(accountId))!;
    await ctx.db.patch(accountId, { syncState: "syncing", syncStartedAt: startedAt, syncGeneration: account.syncGeneration + 1 });
    return account.syncGeneration + 1;
  });
  const shown = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!;
  expect(SYNC_STALE_MS).toBe(15 * 60 * 1000);
  expect(shown.syncStaleAt).toBe(startedAt + SYNC_STALE_MS);
  expect(shown.syncStaleAt! < Date.now()).toBe(true);
  await admin.as.mutation(api.github.sync, { teamId, accountId });
  expect((await t.run((ctx) => ctx.db.get(accountId)))!.syncGeneration).toBe(generation + 1);
  await settleScheduled(t);
  const after = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!;
  expect(after.syncState).toBe("synced");
  expect(after.syncStaleAt).toBeUndefined();
});

test("the daily sync restarts a sync that didn't finish, and the old sync's late page, finish and failure change nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/billing"], [2, "nuko/ledger"]] });
  gh.grant("julio", [ORG]);
  await connectAccount(t, admin, teamId, ORG);
  const accountId = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!.accountId as Id<"githubAccounts">;
  // Its action timed out without reporting, 16 minutes ago; GitHub has since dropped nuko/ledger.
  const old = await t.run(async (ctx) => {
    const account = (await ctx.db.get(accountId))!;
    await ctx.db.patch(accountId, { syncState: "syncing", syncStartedAt: Date.now() - 16 * 60 * 1000, syncGeneration: account.syncGeneration + 1 });
    return account.syncGeneration + 1;
  });
  gh.installations.get(ORG)!.repos = gh.installations.get(ORG)!.repos.filter((r) => r.id === 1);
  await t.mutation(internal.github.syncAll, {});
  expect((await t.run((ctx) => ctx.db.get(accountId)))!.syncGeneration).toBe(old + 1);
  await settleScheduled(t);
  const synced = async () => ({
    repos: (await admin.as.query(api.github.repos, { teamId })).map((r) => r.fullName),
    account: (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!,
  });
  const before = await synced();
  expect(before.repos).toEqual(["nuko/billing"]);
  expect(before.account.syncState).toBe("synced");
  // The old sync wakes up late: its page would bring nuko/ledger back, then it finishes and fails.
  const ledger = { id: 2, fullName: "nuko/ledger", private: false, archived: false, defaultBranch: "main" };
  expect(await t.mutation(internal.github.syncPage, { accountId, generation: old, fetchedAt: Date.now(), repos: [ledger] })).toBeFalsy();
  await t.mutation(internal.github.syncFinished, { accountId, generation: old });
  await t.mutation(internal.github.syncFailed, { accountId, generation: old, error: "late failure" });
  await settleScheduled(t);
  const after = await synced();
  expect(after.repos).toEqual(["nuko/billing"]);
  expect(after.account.syncState).toBe("synced");
  expect(after.account.syncError).toBeUndefined();
  expect(after.account.lastSyncedAt).toBe(before.account.lastSyncedAt);
});

test("a repo typed as owner/name is kept, and sent to the bridge, as github.com/owner/name", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  await admin.as.mutation(api.projects.create, { teamId, name: "Legacy", repos: ["nuko/legacy"] });
  expect((await admin.as.query(api.projects.list, { teamId }))[0]!.repos).toEqual(["github.com/nuko/legacy"]);
  const taskId = await admin.as.mutation(api.tasks.create, { teamId, title: "Port the legacy exporter" });
  const { machineId, token } = await linkMachine(t, teamId, admin, "julio-mbp");
  await admin.as.mutation(api.runs.start, { teamId, taskId, harness: "codex", machineId, via: "thread", repo: "nuko/legacy" });
  // T3 Code's repository key is github.com/nuko/legacy: the bridge matches the thread's repo against it.
  expect(await bridgeInbox(t, token)).toContainEqual(expect.objectContaining({ type: "start_thread", repo: "github.com/nuko/legacy" }));
});

// ---------- People's own GitHub accounts (2026-11-04): members connect their personal accounts ----------

const ANA = 53;

test("a member connects her own personal account: the team picks its repos, and it stays hers to sync, change and disconnect", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  gh.install({ id: ANA, login: "ana", type: "User", repos: [[4, "ana/notes", true], [5, "ana/tide-scripts"]] });
  gh.grant("ana", [ANA]);

  const { cookie, connectId } = await startConnect(t, ana, teamId);
  const { html } = await finishOnGitHub(t, cookie, ANA, "ana");
  expect(strip(html)).toContain("Return to Uplink Room to finish");
  expect(strip(html)).toContain("Ana started this in Uplink Room and confirms it there");
  expect((await pending(ana, teamId))[0]).toMatchObject({ githubLogin: "ana", accounts: [expect.objectContaining({ login: "ana", type: "User", canConnect: true })] });
  expect(await confirmInApp(t, ana, teamId, connectId, ANA)).toMatchObject({ status: "connected" });
  await settleScheduled(t);

  const hers = (await ana.as.query(api.github.accounts, { teamId })).accounts[0]!;
  expect(hers).toMatchObject({ login: "ana", type: "User", connectedBy: "Ana", mine: true, canSync: true, canChangeRepos: true, canDisconnect: true, repoCount: 2 });
  expect(hers.settingsUrl).toBe(`https://github.com/settings/installations/${ANA}`);
  // Its repos are the team's: Julio picks one for a project, and an agent finds them.
  const julios = (await admin.as.query(api.github.accounts, { teamId })).accounts[0]!;
  expect(julios).toMatchObject({ connectedBy: "Ana", mine: false, canSync: false, canChangeRepos: false, canDisconnect: true });
  expect(julios.settingsUrl).toBeUndefined();
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => [r.fullName, r.account])).toEqual([["ana/notes", "ana"], ["ana/tide-scripts", "ana"]]);
  await admin.as.mutation(api.projects.create, { teamId, name: "Notes", repos: ["github.com/ana/notes"] });
  expect((await admin.as.query(api.github.repoStatus, { teamId, repos: ["github.com/ana/notes"] }))[0]!.synced).toMatchObject({ fullName: "ana/notes", account: "ana" });
  const { key } = await addAgent(t, teamId, admin, "Planner", ["room.read"]);
  expect((await callAsAgent(t, key, "github.repos", { search: "tide" })).result.map((r: { repo: string }) => r.repo)).toEqual(["github.com/ana/tide-scripts"]);

  // Julio can't sync it for her. She syncs it, then disconnects it.
  await expect(admin.as.mutation(api.github.sync, { teamId, accountId: hers.accountId })).rejects.toThrow("ana is Ana's personal GitHub account. Only Ana can sync it.");
  await ana.as.mutation(api.github.sync, { teamId, accountId: hers.accountId });
  await settleScheduled(t);
  await ana.as.mutation(api.github.disconnect, { teamId, accountId: hers.accountId });
  await settleScheduled(t);
  expect(await admin.as.query(api.github.repos, { teamId })).toEqual([]);
});

test("a member can't connect an organization, even one she owns on GitHub, and GitHub isn't asked whether she owns it", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"], [2, "nuko/payroll", true]] });
  gh.install({ id: ANA, login: "ana", type: "User", repos: [[4, "ana/notes"]] });
  // She owns nuko on GitHub; in the team she is a member.
  gh.grant("ana", [ORG, ANA]);

  const org = await finishOnGitHub(t, (await startConnect(t, ana, teamId)).cookie, ORG, "ana");
  expect(strip(org.html)).toContain("Only an admin of Nuko Nova can connect nuko");
  expect(org.html).not.toContain("Return to Uplink Room to finish");

  // Her own account is hers to connect; asking the app for the organization instead is refused.
  const own = await startConnect(t, ana, teamId);
  expect(strip((await finishOnGitHub(t, own.cookie, ANA, "ana")).html)).toContain("Return to Uplink Room to finish");
  expect((await pending(ana, teamId))[0]!.accounts.find((a) => a.login === "nuko")).toMatchObject({ canConnect: false, refusal: "admin" });
  await expect(ana.as.mutation(api.github.confirmConnect, { teamId, connectId: own.connectId, installationId: ORG })).rejects.toThrow(
    "Only an admin of Nuko Nova can connect an organization.",
  );
  expect(gh.calls.filter((c) => c.includes("/memberships/"))).toEqual([]);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("githubRepos").collect())).toEqual([]);
});

test("an admin demoted before she confirms, or while the room asks GitHub, connects nothing: the connect is cancelled", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const setRole = (role: "admin" | "member") => admin.as.mutation(api.members.setRole, { teamId, memberId: ana.memberId, role });
  await setRole("admin");
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"]] });
  gh.install({ id: ANA, login: "ana", type: "User", repos: [[4, "ana/notes"]] });
  gh.grant("ana", [ORG, ANA]);

  // Demoted after GitHub sent her back: the app says the connect was cancelled, and Confirm is
  // refused, for her own personal account too.
  const first = await startConnect(t, ana, teamId);
  await finishOnGitHub(t, first.cookie, ORG, "ana");
  await setRole("member");
  const cancelled = "You're no longer an admin of Nuko Nova, so this connect was cancelled. Choose Connect to start again.";
  expect((await pending(ana, teamId))[0]).toMatchObject({ status: "cancelled", cancelled });
  await expect(ana.as.mutation(api.github.confirmConnect, { teamId, connectId: first.connectId, installationId: ANA })).rejects.toThrow(cancelled);

  // Demoted while the room asks GitHub about her own account: the connect she started as an admin
  // is cancelled, so even that isn't linked.
  await setRole("admin");
  const second = await startConnect(t, ana, teamId);
  await finishOnGitHub(t, second.cookie, ANA, "ana");
  const held = holdConfirmCheck();
  await ana.as.mutation(api.github.confirmConnect, { teamId, connectId: second.connectId, installationId: ANA });
  await held.asking;
  await setRole("member");
  held.release();
  await settleScheduled(t);
  expect(await t.run((ctx) => ctx.db.get(second.connectId))).toMatchObject({ refusal: { installationId: ANA, why: cancelled } });
  expect((await pending(ana, teamId)).find((c) => c.connectId === second.connectId)).toMatchObject({ status: "cancelled" });
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("githubRepos").collect())).toEqual([]);
});

test("an admin demoted and made an admin again keeps her connects cancelled, and a check already running links nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const setRole = (role: "admin" | "member") => admin.as.mutation(api.members.setRole, { teamId, memberId: ana.memberId, role });
  await setRole("admin");
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"]] });
  gh.grant("ana", [ORG]);
  const cancelled = "You're no longer an admin of Nuko Nova, so this connect was cancelled. Choose Connect to start again.";

  const first = await startConnect(t, ana, teamId);
  await finishOnGitHub(t, first.cookie, ORG, "ana");
  await setRole("member");
  await setRole("admin");
  expect((await pending(ana, teamId))[0]).toMatchObject({ status: "cancelled", cancelled });
  await expect(ana.as.mutation(api.github.confirmConnect, { teamId, connectId: first.connectId, installationId: ORG })).rejects.toThrow(cancelled);

  const second = await startConnect(t, ana, teamId);
  await finishOnGitHub(t, second.cookie, ORG, "ana");
  const held = holdConfirmCheck();
  await ana.as.mutation(api.github.confirmConnect, { teamId, connectId: second.connectId, installationId: ORG });
  await held.asking;
  await setRole("member");
  await setRole("admin");
  held.release();
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});

test("a member can't disconnect or sync someone else's personal account; an admin can disconnect it, and projects keep its repos as not connected", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const bo = await addTeammate(t, teamId, admin, "Bo");
  gh.install({ id: ANA, login: "ana", type: "User", repos: [[4, "ana/notes"]] });
  gh.grant("ana", [ANA]);
  await connectAccount(t, ana, teamId, ANA, "ana");
  const projectId = await bo.as.mutation(api.projects.create, { teamId, name: "Notes", repos: ["github.com/ana/notes"] });

  const seen = (await bo.as.query(api.github.accounts, { teamId })).accounts[0]!;
  expect(seen).toMatchObject({ login: "ana", connectedBy: "Ana", mine: false, canSync: false, canChangeRepos: false, canDisconnect: false });
  expect(seen.settingsUrl).toBeUndefined();
  await expect(bo.as.mutation(api.github.disconnect, { teamId, accountId: seen.accountId })).rejects.toThrow(
    "ana is Ana's personal GitHub account. Only Ana or an admin can disconnect it.",
  );
  await expect(bo.as.mutation(api.github.sync, { teamId, accountId: seen.accountId })).rejects.toThrow("Only Ana can sync it.");
  expect((await bo.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["ana/notes"]);

  await admin.as.mutation(api.github.disconnect, { teamId, accountId: seen.accountId });
  await settleScheduled(t);
  expect(await bo.as.query(api.github.repos, { teamId })).toEqual([]);
  expect((await bo.as.query(api.projects.list, { teamId })).find((p) => p.projectId === projectId)!.repos).toEqual(["github.com/ana/notes"]);
  expect((await bo.as.query(api.github.repoStatus, { teamId, repos: ["github.com/ana/notes"] }))[0]!.synced).toBeNull();
});

test("a member removed from the team takes her personal account with her; the organization she connected stays, and connects she started link nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  await admin.as.mutation(api.members.setRole, { teamId, memberId: ana.memberId, role: "admin" });
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"]] });
  gh.install({ id: ANA, login: "ana", type: "User", repos: [[4, "ana/notes"]] });
  gh.install({ id: 54, login: "ana-labs", repos: [[6, "ana-labs/kit"]] });
  gh.grant("ana", [ORG, ANA, 54]);
  await connectAccount(t, ana, teamId, ORG, "ana");
  await connectAccount(t, ana, teamId, ANA, "ana");
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Notes", repos: ["github.com/ana/notes", "github.com/nuko/site"] });
  // A link she never opened, and one she chose Connect on in the app, still being checked with GitHub when she's removed.
  const link = await ana.as.mutation(api.github.connect, { teamId });
  const checking = await startConnect(t, ana, teamId);
  await finishOnGitHub(t, checking.cookie, 54, "ana");
  const held = holdConfirmCheck();
  await ana.as.mutation(api.github.confirmConnect, { teamId, connectId: checking.connectId, installationId: 54 });
  await held.asking;

  await admin.as.mutation(api.members.remove, { teamId, memberId: ana.memberId });
  held.release();
  await settleScheduled(t);
  expect(await t.run((ctx) => ctx.db.get(checking.connectId))).toMatchObject({
    refusal: { installationId: 54, why: "Whoever started this is no longer in Nuko Nova, so nothing was connected." },
  });
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts.map((a) => [a.login, a.connectedBy])).toEqual([["nuko", "Ana"]]);
  expect((await admin.as.query(api.github.repos, { teamId })).map((r) => r.fullName)).toEqual(["nuko/site"]);
  expect((await admin.as.query(api.projects.list, { teamId })).find((p) => p.projectId === projectId)!.repos).toEqual([
    "github.com/ana/notes",
    "github.com/nuko/site",
  ]);
  expect((await admin.as.query(api.github.repoStatus, { teamId, repos: ["github.com/ana/notes"] }))[0]!.synced).toBeNull();
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.filter((a) => a.action === "github.disconnected").map((a) => a.details)).toEqual([{ login: "ana", reason: "left_team" }]);

  const opened = await t.fetch(link.url.slice(SITE.length));
  expect(opened.status).toBe(403);
  expect(strip(await opened.text())).toContain("Ana is no longer in Nuko Nova");
  await expect(ana.as.mutation(api.github.confirmConnect, { teamId, connectId: checking.connectId, installationId: 54 })).rejects.toThrow("You are not a member of this team.");
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toHaveLength(1);
});

// ---------- Codex review (PR #131): the person who started a connect confirms it in the app ----------

test("only the person who started a connect confirms it: Ana finishing Bo's link on GitHub, then confirming it as herself, connects nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const ana = await addTeammate(t, teamId, admin, "Ana");
  const bo = await addTeammate(t, teamId, admin, "Bo");
  gh.install({ id: ANA, login: "ana", type: "User", repos: [[4, "ana/notes", true]] });
  gh.grant("ana", [ANA]);

  // Bo starts a connect and sends Ana the link. She opens it and signs in to GitHub as herself.
  const { url, connectId } = await bo.as.mutation(api.github.connect, { teamId });
  const { html } = await finishOnGitHub(t, (await openConnect(t, url)).cookie, ANA, "ana");
  expect(strip(html)).toContain("Bo started this in Uplink Room and confirms it there");
  expect(strip(html)).toContain("If you aren't Bo, you can close this tab.");
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);

  // In her app, Ana neither sees Bo's connect nor can confirm or cancel it.
  expect(await pending(ana, teamId)).toEqual([]);
  await expect(ana.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId: ANA })).rejects.toThrow("Only Bo can confirm this connect: Bo started it.");
  await expect(ana.as.mutation(api.github.endConnect, { teamId, connectId })).rejects.toThrow("Only Bo can cancel this connect");

  // Bo sees who signed in to GitHub, so he can tell it isn't him, and cancels it.
  const [flow] = await pending(bo, teamId);
  expect(flow).toMatchObject({ connectId, githubLogin: "ana", status: "waiting" });
  await bo.as.mutation(api.github.endConnect, { teamId, connectId });
  expect(await pending(bo, teamId)).toEqual([]);
  await expect(bo.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId: ANA })).rejects.toThrow("This connect expired or already finished.");

  // From her own link, Ana's account is hers.
  await connectAccount(t, ana, teamId, ANA, "ana");
  expect((await ana.as.query(api.github.accounts, { teamId })).accounts).toEqual([expect.objectContaining({ login: "ana", connectedBy: "Ana", mine: true, canSync: true })]);
  expect((await bo.as.query(api.github.accounts, { teamId })).accounts[0]).toMatchObject({ mine: false, canSync: false, canDisconnect: false });
});

test("an admin's link forwarded to an organization owner who isn't a team admin connects nothing until the admin confirms in the app", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const carol = await addTeammate(t, teamId, admin, "Carol");
  gh.install({ id: ORG, login: "nuko", repos: [[1, "nuko/site"], [2, "nuko/payroll", true]] });
  // Carol owns nuko on GitHub; in the team she is a member.
  gh.grant("carol", [ORG]);

  const { url, connectId } = await admin.as.mutation(api.github.connect, { teamId });
  // Julio forwards the link; Carol finishes it in her browser.
  const { html } = await finishOnGitHub(t, (await openConnect(t, url)).cookie, ORG, "carol");
  expect(strip(html)).toContain("Return to Uplink Room to finish");
  expect(strip(html)).toContain("Julio started this in Uplink Room and confirms it there");
  // The old page's Connect button, posted with this flow's state, links nothing either.
  const posted = await postOldConfirm(t, { state: new URL(url).searchParams.get("state")!, token: "anything", installation: String(ORG) });
  expect(posted.status).toBe(410);
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("githubRepos").collect())).toEqual([]);
  await expect(carol.as.mutation(api.github.confirmConnect, { teamId, connectId, installationId: ORG })).rejects.toThrow("Only Julio can confirm this connect");

  // Julio sees that carol signed in to GitHub, and confirms. GitHub is asked again whether carol owns nuko.
  expect((await pending(admin, teamId))[0]).toMatchObject({ githubLogin: "carol", accounts: [expect.objectContaining({ login: "nuko", canConnect: true })] });
  const before = gh.calls.length;
  expect(await confirmInApp(t, admin, teamId, connectId, ORG)).toMatchObject({ status: "connected" });
  expect(gh.calls.slice(before)).toContain("GET api.github.com/orgs/nuko/memberships/carol");
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([expect.objectContaining({ login: "nuko", type: "Organization", connectedBy: "Julio", repoCount: 2 })]);
});

test("a connect nobody confirms expires: the app stops offering it, Confirm is refused, and a check still asking GitHub links nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: PERSONAL, login: "julio", type: "User", repos: [[2, "julio/dotfiles"]] });
  gh.grant("julio", [PERSONAL]);
  const later = () => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * 60 * 1000 });

  const idle = await startConnect(t, admin, teamId);
  await finishOnGitHub(t, idle.cookie, PERSONAL, "julio");
  expect(await pending(admin, teamId)).toHaveLength(1);
  later();
  expect(await pending(admin, teamId)).toEqual([]);
  await expect(admin.as.mutation(api.github.confirmConnect, { teamId, connectId: idle.connectId, installationId: PERSONAL })).rejects.toThrow(
    "This connect expired or already finished.",
  );
  vi.useRealTimers();

  // Confirmed a moment before it expired, and still asking GitHub when it did.
  const late = await startConnect(t, admin, teamId);
  await finishOnGitHub(t, late.cookie, PERSONAL, "julio");
  const held = holdConfirmCheck();
  await admin.as.mutation(api.github.confirmConnect, { teamId, connectId: late.connectId, installationId: PERSONAL });
  await held.asking;
  later();
  held.release();
  await settleScheduled(t);
  vi.useRealTimers();
  expect(await t.run((ctx) => ctx.db.get(late.connectId))).toMatchObject({ refusal: { installationId: PERSONAL, why: "This connect expired. Choose Connect to start again." } });
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});

test("links and pages from before Confirm moved into the app connect nothing, and say where connecting finishes now", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  gh.install({ id: PERSONAL, login: "julio", type: "User", repos: [[2, "julio/dotfiles"]] });
  gh.grant("julio", [PERSONAL]);
  const me = (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Julio")!;
  // Rows as the old flow made them: no starterRole; the verified one with its page's form token.
  const oldFlow = async (verified: boolean) => {
    const nonce = randomToken();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const state = await signState(await stateKey(APP.clientSecret), nonce, { teamId, memberId: me.memberId, expiresAt });
    const token = randomToken();
    const connectId = await t.run(async (ctx) =>
      ctx.db.insert("githubConnects", {
        teamId,
        memberId: me.memberId as Id<"members">,
        nonceHash: await sha256(nonce),
        codeVerifier: randomToken(48),
        expiresAt,
        ...(verified
          ? {
              githubLogin: "julio",
              githubUserId: 1,
              accessible: [{ installationId: PERSONAL, accountGithubId: 1, login: "julio", type: "User" as const, repositorySelection: "all" as const, suspended: false, canShare: true }],
              confirmTokenHash: await sha256(token),
            }
          : {}),
      }),
    );
    return { state, token, connectId };
  };
  const finishInApp = "Connecting now finishes in Uplink Room";

  const unopened = await oldFlow(false);
  const opened = await t.fetch(`/github/connect?state=${unopened.state}`);
  expect(opened.status).toBe(410);
  expect(strip(await opened.text())).toContain(finishInApp);

  const old = await oldFlow(true);
  const posted = await postOldConfirm(t, { state: old.state, token: old.token, installation: String(PERSONAL) });
  expect(posted.status).toBe(410);
  expect(strip(posted.html)).toContain(`${finishInApp}`);
  expect(strip(posted.html)).toContain("This page is from before that change, so nothing was connected.");
  expect(posted.cookie).toMatch(/Max-Age=0/);
  // Nor can the app confirm it.
  expect((await pending(admin, teamId))[0]).toMatchObject({ connectId: old.connectId, status: "cancelled" });
  await expect(admin.as.mutation(api.github.confirmConnect, { teamId, connectId: old.connectId, installationId: PERSONAL })).rejects.toThrow(
    "This connect started before Uplink Room asked for confirmation in the app",
  );
  await settleScheduled(t);
  expect((await admin.as.query(api.github.accounts, { teamId })).accounts).toEqual([]);
});
