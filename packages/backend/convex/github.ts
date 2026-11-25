/**
 * GitHub (ADR 0020): connected GitHub accounts and the repos they give the team.
 *
 * An admin connects an organization they own on GitHub, and any person in the team can connect
 * their own personal account: they install the room's GitHub App there and pick all repos or some.
 * The room syncs those repos (`githubSync.ts`) and keeps them current with webhooks
 * (`githubHttp.ts`), so the repo pickers offer them to the whole team. An organization is the
 * team's, and admins manage it. A personal account is its person's: they sync it, change its repos
 * and disconnect it, an admin can only disconnect it, and it is disconnected when they leave the
 * team (`mayDo`, `disconnectMembersAccounts`). Agents connect nothing. Nothing is linked from the
 * browser: the person who started a connect confirms it in the app (`confirmConnect`), since only
 * the app knows which person is acting. Projects still keep repo strings; a project's synced repo
 * is also linked by GitHub's id, so a rename on GitHub renames it in the project.
 *
 * Webhooks and syncs both write the synced repos, and either can arrive late. A webhook stamps
 * what it changes (`webhookAt`) and leaves a tombstone for what it removes; a sync page carries
 * when the room asked GitHub for it (`fetchedAt`), and loses to any webhook applied after that.
 * Work that grows with the team (renaming a repo in its projects, linking new repos to projects)
 * runs as scheduled batches that continue until done.
 */
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { hasScope, type Actor } from "./lib/actor";
import { sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { audit } from "./lib/members";
import { githubRepoString, repoKey } from "./lib/repos";
import { roomMutation, roomQuery } from "./lib/room";
import { CONNECT_PATH, githubConfig, installationSettingsUrl, missingGitHubEnv } from "./lib/github/config";
import { randomToken, signState, stateKey } from "./lib/github/crypto";
import { applyPullEvent, pullRowLive, withCheck, withReview } from "./lib/github/pulls";
import {
  vAccountType,
  vGitHubEvent,
  vInstallationReposEvent,
  vRepositoryEvent,
  vSelection,
  type GitHubEvent,
  type InstallationReposEvent,
  type RepoInfo,
  type RepositoryEvent,
} from "./lib/github/events";

/** How long a connect flow's state lasts. Nobody confirming it in that time leaves nothing connected. */
export const CONNECT_TTL_MS = 30 * 60 * 1000;
/**
 * Confirm asks GitHub again in an action, which takes seconds. One that hasn't reported back after
 * this has died (a timeout or a crash), so Connect can be chosen again; a late report from it changes
 * nothing, since it no longer matches the flow's `confirming`.
 */
export const CHECK_STALE_MS = 2 * 60 * 1000;
/**
 * A sync that hasn't finished this long after it started is taken to have died (an action that
 * timed out or crashed reports nothing), so Settings says it didn't finish, and Sync now or the daily
 * sync starts another. Convex gives an action up to 30 minutes in this runtime (10 in Node); one sync
 * step reads at most 10 pages and takes seconds. If an old step is still running, its generation no
 * longer matches, so its late pages, finish and failure change nothing (`currentSync`).
 */
export const SYNC_STALE_MS = 15 * 60 * 1000;
/** The most repos one project lists. Linking and renaming read each project's list, so it is bounded. */
export const MAX_PROJECT_REPOS = 200;
/** Repos deleted per mutation when an account goes or a sync sweeps. */
const DELETE_BATCH = 500;
/** Project links per rename batch, and projects per linking batch: each batch stays far below Convex's read limits. */
const LINK_BATCH = 50;
const PROJECT_BATCH = 25;
/** New repos per linking job. */
const ASSOCIATE_IDS = 100;
/** Synced copies of one repo per webhook batch (one per team that connected its installation). */
const COPY_BATCH = 50;
/** At most this many results from the repo search or list. */
const MAX_REPOS = 50;
/** Tombstones are kept this long: longer than any sync takes. */
const TOMBSTONE_MS = 24 * 60 * 60 * 1000;

function notConfigured(): never {
  const missing = missingGitHubEnv();
  throw roomError(
    "not_configured",
    `GitHub isn't set up on this deployment yet${missing.length ? `: it needs ${missing.join(", ")}` : ""}. An admin registers the App with packages/backend/scripts/github-app.ts.`,
  );
}

async function activeAccounts(ctx: QueryCtx, teamId: Id<"teams">): Promise<Doc<"githubAccounts">[]> {
  // A team connects a handful of accounts; 200 is far above any real team.
  const rows = await ctx.db
    .query("githubAccounts")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .take(200);
  return rows.filter((a) => a.removedAt === undefined);
}

async function teamAccount(ctx: QueryCtx, teamId: Id<"teams">, accountId: Id<"githubAccounts">) {
  const account = await ctx.db.get(accountId);
  if (!account || account.teamId !== teamId || account.removedAt !== undefined) {
    throw roomError("not_found", "That GitHub account isn't connected to this team.");
  }
  return account;
}

// ---------- who may do what ----------

export type AccountAction = "sync" | "changeRepos" | "disconnect";
type Owned = Pick<Doc<"githubAccounts">, "type" | "connectedBy">;

/** True when the actor is the person who connected this personal account: it is theirs. Agents own none. */
export function isOwnAccount(actor: Actor, account: Owned): boolean {
  return actor.kind === "person" && account.type === "User" && account.connectedBy === actor.member._id;
}

/**
 * What the actor may do with a connected account (ADR 0020). An organization is the team's: admins
 * sync it, change which repos it gives and disconnect it. A personal account is its person's: they
 * do all three, and an admin can only disconnect it, to take its repos away from the team. An agent
 * has its effective role (never above its person's) and owns no account.
 */
export function mayDo(actor: Actor, account: Owned, action: AccountAction): boolean {
  const admin = actor.role === "admin" && hasScope(actor, "team.admin");
  if (account.type === "Organization") return admin;
  if (isOwnAccount(actor, account)) return true;
  return action === "disconnect" && admin;
}

async function requireMay(ctx: QueryCtx, actor: Actor, account: Doc<"githubAccounts">, action: AccountAction) {
  if (mayDo(actor, account, action)) return;
  const verb = { sync: "sync", changeRepos: "change which repos", disconnect: "disconnect" }[action];
  if (account.type === "Organization") {
    throw roomError("forbidden", `Only admins can ${verb} ${account.login}: it's an organization, and organizations are the team's.`);
  }
  const owner = (await ctx.db.get(account.connectedBy))?.name ?? "the person who connected it";
  throw roomError(
    "forbidden",
    action === "disconnect"
      ? `${account.login} is ${owner}'s personal GitHub account. Only ${owner} or an admin can disconnect it.`
      : `${account.login} is ${owner}'s personal GitHub account. Only ${owner} can ${verb} it.`,
  );
}

// ---------- reading ----------

export const { person: accounts, agent: accountsAgent } = roomQuery({
  name: "github.accounts",
  description:
    "The GitHub organizations and personal accounts connected to the team, each with how many repos it gives the team, its last sync, who connected it, and what you may do with it: canSync, canDisconnect, and canChangeRepos with settingsUrl, GitHub's page for changing which repos it gives. An organization is the team's, and admins manage it. A personal account belongs to the person who connected it (`mine` is true when that's you): they manage it, and an admin can only disconnect it. `configured` is false when this deployment has no GitHub App yet. `canConnect`: you can connect your own personal account (people only, not agents); `canConnectOrganizations`: you can also connect an organization you own on GitHub (admins).",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const rows = await activeAccounts(ctx, actor.teamId);
    const list = await Promise.all(
      rows
        .sort((a, b) => a.login.localeCompare(b.login))
        .map(async (a) => {
          const by = await ctx.db.get(a.connectedBy);
          const canChangeRepos = mayDo(actor, a, "changeRepos");
          return {
            accountId: a._id,
            login: a.login,
            type: a.type,
            avatarUrl: a.avatarUrl,
            repositorySelection: a.repositorySelection,
            repoCount: a.repoCount,
            suspended: a.suspendedAt !== undefined,
            syncState: a.syncState,
            /** A sync still "syncing" after this has stopped answering, and Sync now starts it again. */
            syncStaleAt: a.syncState === "syncing" && a.syncStartedAt !== undefined ? a.syncStartedAt + SYNC_STALE_MS : undefined,
            syncError: a.syncError,
            lastSyncedAt: a.lastSyncedAt,
            connectedAt: a.connectedAt,
            connectedBy: by?.name ?? "Former member",
            connectedById: a.connectedBy,
            /** Your own personal account. */
            mine: isOwnAccount(actor, a),
            canSync: mayDo(actor, a, "sync"),
            canChangeRepos,
            canDisconnect: mayDo(actor, a, "disconnect"),
            /** Only for whoever may change which repos it gives. */
            ...(canChangeRepos ? { settingsUrl: installationSettingsUrl(a, a.installationId) } : {}),
          };
        }),
    );
    const person = actor.kind === "person";
    return {
      configured: githubConfig() !== null,
      canConnect: person,
      canConnectOrganizations: person && actor.role === "admin",
      accounts: list,
    };
  },
});

type RepoView = {
  githubId: number;
  fullName: string;
  /** The string a project keeps for it, such as `github.com/nuko/billing`. */
  repo: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  account: string;
};

function repoView(row: Doc<"githubRepos">, account: Doc<"githubAccounts">): RepoView {
  return {
    githubId: row.githubId,
    fullName: row.fullName,
    repo: githubRepoString(row.fullName),
    private: row.private,
    archived: row.archived,
    defaultBranch: row.defaultBranch,
    account: account.login,
  };
}

/** The words of a search or a name, split as the search index splits them. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** True when every searched word starts a word of the name: `upl ro` matches `nuko/uplink-room`. */
export function nameMatches(fullName: string, query: string[]): boolean {
  const own = words(fullName);
  return query.every((q) => own.some((w) => w.startsWith(q)));
}

/**
 * The start of a `repoKey` that a search containing `/` names: `owner/na` and
 * `https://github.com/owner/na` both become `github.com/owner/na`.
 */
export function keyPrefix(text: string): string {
  const t = text.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^www\./, "");
  return t.startsWith("github.com/") ? t : `github.com/${t.replace(/^\/+/, "")}`;
}

export const { person: repos, agent: reposAgent } = roomQuery({
  name: "github.repos",
  description:
    "Synced repos: the repos the team's connected GitHub accounts give it. With `search`, the ones whose name has a word starting with each word searched, such as `uplink ro`, or, for a search with a slash such as `nuko/uplink-ro`, the ones whose owner/name starts with it; without, the first ones by name. Each has `repo`, the string to list in a project (projects.create, projects.setRepos) or to start a run in.",
  scope: "room.read",
  args: { search: v.optional(v.string()), limit: v.optional(v.number()) },
  argDocs: { limit: `How many to return, up to ${MAX_REPOS} (default 20).` },
  handler: async (ctx, actor, args) => {
    const limit = Math.max(1, Math.min(MAX_REPOS, Math.floor(args.limit ?? 20)));
    const accounts = new Map((await activeAccounts(ctx, actor.teamId)).map((a) => [a._id, a]));
    if (accounts.size === 0) return [];
    const text = (args.search ?? "").trim();
    const collect = (rows: Doc<"githubRepos">[]) => {
      const seen = new Set<number>();
      const out: RepoView[] = [];
      for (const row of rows) {
        const account = accounts.get(row.githubAccountId);
        if (!account || seen.has(row.githubId)) continue;
        seen.add(row.githubId);
        out.push(repoView(row, account));
      }
      return out;
    };
    // owner/name: the key index finds it directly, however many repos share the owner's words.
    if (text.includes("/")) {
      const prefix = keyPrefix(text);
      const byKey = collect(
        await ctx.db
          .query("githubRepos")
          .withIndex("by_team_key", (q) => q.eq("teamId", actor.teamId).gte("key", prefix).lt("key", `${prefix}￿`))
          .take(limit * 2),
      );
      if (byKey.length > 0) return byKey.slice(0, limit);
    }
    const query = words(text).slice(0, 8);
    // The index matches only its last term as a prefix, so it is asked for the longest word alone
    // and the rest are checked here. A search reads at most 200 candidates.
    const longest = query.reduce((a, b) => (b.length > a.length ? b : a), "");
    const rows = query.length
      ? (
          await ctx.db
            .query("githubRepos")
            .withSearchIndex("search_name", (q) => q.search("searchText", longest).eq("teamId", actor.teamId))
            .take(200)
        ).filter((r) => nameMatches(r.fullName, query))
      : await ctx.db
          .query("githubRepos")
          .withIndex("by_team_key", (q) => q.eq("teamId", actor.teamId))
          .take(limit * 2);
    const out = collect(rows);
    if (query.length) out.sort((a, b) => a.fullName.length - b.fullName.length || a.fullName.localeCompare(b.fullName));
    return out.slice(0, limit);
  },
});

export const { person: repoStatus, agent: repoStatusAgent } = roomQuery({
  name: "github.repoStatus",
  description:
    "For each repo string (up to 100, as a project lists them), the synced repo it is, or null when no connected GitHub account gives the team that repo.",
  scope: "room.read",
  args: { repos: v.array(v.string()) },
  handler: async (ctx, actor, args) => {
    if (args.repos.length > 100) throw roomError("invalid", "Ask about at most 100 repos at once.");
    const accounts = new Map((await activeAccounts(ctx, actor.teamId)).map((a) => [a._id, a]));
    return Promise.all(
      args.repos.map(async (repo) => {
        const rows = accounts.size
          ? await ctx.db
              .query("githubRepos")
              .withIndex("by_team_key", (q) => q.eq("teamId", actor.teamId).eq("key", repoKey(repo)))
              .take(5)
          : [];
        const row = rows.find((r) => accounts.has(r.githubAccountId));
        return { repo, synced: row ? repoView(row, accounts.get(row.githubAccountId)!) : null };
      }),
    );
  },
});

// ---------- connecting and disconnecting ----------

export const { person: connect, agent: connectAgent } = roomMutation({
  name: "github.connect",
  description:
    "People only. Starts connecting a GitHub account to the team: returns a link for you to open in your browser, where GitHub installs the room's GitHub App and you pick the repos, and `connectId`, the flow you then confirm with github.confirmConnect. The link works once, for 30 minutes. Nothing is connected until you, the person who started it, confirm in Uplink Room. Anyone in the team can connect their own personal GitHub account; its repos are then the team's to pick for projects and runs, and it stays theirs to sync, change and disconnect. Only an admin can connect an organization, and only as an owner of it on GitHub. Agents can't connect accounts.",
  scope: "team.admin",
  args: {},
  handler: async (ctx, actor) => {
    if (actor.kind !== "person") {
      throw roomError(
        "forbidden",
        "Agents can't connect GitHub accounts. A person connects their own account, or an admin an organization, in Settings, then GitHub.",
      );
    }
    const config = githubConfig();
    if (!config || !config.siteUrl) notConfigured();
    const nonce = randomToken();
    const expiresAt = Date.now() + CONNECT_TTL_MS;
    const state = await signState(await stateKey(config.clientSecret), nonce, {
      teamId: actor.teamId,
      memberId: actor.member._id,
      expiresAt,
    });
    // What the person may connect is decided at each step from who they are then (`starterNow`):
    // their own personal account, and organizations only while they're an admin. An admin who stops
    // being one before confirming cancels the flow (`starterRole`).
    const connectId = await ctx.db.insert("githubConnects", {
      teamId: actor.teamId,
      memberId: actor.member._id,
      nonceHash: await sha256(nonce),
      codeVerifier: randomToken(48),
      expiresAt,
      starterRole: actor.role,
    });
    return { url: `${config.siteUrl}${CONNECT_PATH}?state=${state}`, connectId };
  },
});

/**
 * Why a flow can't be confirmed any more, for its starter as they are now, or null while it can:
 * it's from before Confirm moved into the app, or an admin started it and is no longer one.
 */
function flowCancelled(row: Doc<"githubConnects">, role: "admin" | "member", teamName: string): string | null {
  if (row.starterRole === undefined) return "This connect started before Uplink Room asked for confirmation in the app, so it can't be confirmed. Choose Connect to start again.";
  if (row.starterRole === "admin" && (role !== "admin" || row.demotedAt !== undefined)) {
    return `You're no longer an admin of ${teamName}, so this connect was cancelled. Choose Connect to start again.`;
  }
  return null;
}

/**
 * An admin was made a member: the connects they started as an admin stay cancelled even if they're
 * made an admin again, and a GitHub check already running for one links nothing.
 */
export async function cancelAdminConnects(ctx: MutationCtx, memberId: Id<"members">) {
  const now = Date.now();
  const rows = await ctx.db
    .query("githubConnects")
    .withIndex("by_member", (q) => q.eq("memberId", memberId).gt("expiresAt", now))
    .take(50);
  for (const row of rows) {
    if (row.starterRole !== "admin" || row.usedAt !== undefined || row.endedAt !== undefined || row.demotedAt !== undefined) continue;
    await ctx.db.patch(row._id, { demotedAt: now });
  }
}

/** Whether an organization or account choice is one the starter may connect, as they are now. */
function mayConnect(choice: Accessible, role: "admin" | "member"): boolean {
  return choice.canShare === true && (choice.type === "User" || role === "admin");
}

export const { person: connects, agent: connectsAgent } = roomQuery({
  name: "github.connects",
  description:
    "Your GitHub connects waiting for you to confirm: each one GitHub sent back to Uplink Room after you signed in there, with the GitHub login that signed in, the accounts GitHub listed for it, and which of them you may connect (`canConnect`, else `why`). Confirm one with github.confirmConnect, or cancel it with github.endConnect. A connect expires 30 minutes after it started. Agents have none.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    if (actor.kind !== "person") return [];
    const now = Date.now();
    // A person starts a handful at most; 20 live ones is far above any real use.
    const rows = await ctx.db
      .query("githubConnects")
      .withIndex("by_member", (q) => q.eq("memberId", actor.member._id).gt("expiresAt", now))
      .take(20);
    const team = (await ctx.db.get(actor.teamId))?.name ?? "your team";
    const connected = new Set((await activeAccounts(ctx, actor.teamId)).map((a) => a.installationId));
    return rows
      .filter((r) => r.teamId === actor.teamId && r.accessible !== undefined && r.endedAt === undefined)
      .filter((r) => r.usedAt === undefined || r.connectedLogin !== undefined)
      .map((r) => {
        const cancelled = r.usedAt === undefined ? flowCancelled(r, actor.role, team) : null;
        const checkStaleAt = r.confirming ? r.confirming.at + CHECK_STALE_MS : undefined;
        const status = r.connectedLogin !== undefined ? "connected" : cancelled ? "cancelled" : r.confirming ? "checking" : "waiting";
        return {
          connectId: r._id,
          teamName: team,
          githubLogin: r.githubLogin ?? "",
          expiresAt: r.expiresAt,
          status: status as "waiting" | "checking" | "connected" | "cancelled",
          ...(cancelled ? { cancelled } : {}),
          ...(r.connectedLogin !== undefined ? { connectedLogin: r.connectedLogin } : {}),
          /** While checking: after this, the check stopped answering, and Connect can be chosen again. */
          ...(status === "checking" && checkStaleAt !== undefined ? { checkStaleAt } : {}),
          accounts: (r.accessible ?? []).map((a) => {
            const already = connected.has(a.installationId);
            const may = mayConnect(a, actor.role);
            const why = may ? undefined : a.type === "Organization" && a.canShare === true ? `Only an admin of ${team} can connect an organization.` : a.why;
            return {
              installationId: a.installationId,
              login: a.login,
              type: a.type,
              ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
              repositorySelection: a.repositorySelection,
              suspended: a.suspended,
              claimed: a.installationId === r.claimedInstallationId,
              connected: already,
              canConnect: may && !already && (status === "waiting" || status === "checking"),
              ...(why ? { why } : {}),
              ...(!may ? { refusal: a.refusal ?? (a.type === "Organization" ? (a.canShare === true ? "admin" : "owner") : "self") } : {}),
              checking: r.confirming?.installationId === a.installationId,
              /** What GitHub or the room said the last time Connect was chosen for this account. */
              ...(r.refusal?.installationId === a.installationId ? { refused: r.refusal.why } : {}),
            };
          }),
        };
      });
  },
});

export const { person: confirmConnect, agent: confirmConnectAgent } = roomMutation({
  name: "github.confirmConnect",
  description:
    "People only, and only the person who started the connect. Connects one of the GitHub accounts a connect of yours lists (github.connects) to the team: the room asks GitHub again whether you may still connect it, then links it and starts its first sync, or says in github.connects why it didn't. An organization needs you to be a team admin still, and the GitHub user who signed in to be one of its owners; a personal account must be that GitHub user's own. Agents can't confirm.",
  scope: "team.admin",
  args: { connectId: v.id("githubConnects"), installationId: v.number() },
  handler: async (ctx, actor, args) => {
    if (actor.kind !== "person") {
      throw roomError("forbidden", "Agents can't confirm GitHub connects. The person who started one confirms it in Settings, then GitHub.");
    }
    if (!githubConfig()) notConfigured();
    const row = await ctx.db.get(args.connectId);
    if (!row || row.teamId !== actor.teamId) throw roomError("not_found", "That GitHub connect isn't in this team.");
    if (row.memberId !== actor.member._id) {
      const starter = (await ctx.db.get(row.memberId))?.name ?? "the person who started it";
      throw roomError("forbidden", `Only ${starter} can confirm this connect: ${starter} started it. To connect your own GitHub account, choose Connect in Settings, then GitHub.`);
    }
    const now = Date.now();
    if (row.usedAt !== undefined || row.endedAt !== undefined || row.expiresAt <= now) {
      throw roomError("conflict", "This connect expired or already finished. Choose Connect to start again.");
    }
    const team = (await ctx.db.get(actor.teamId))?.name ?? "your team";
    const cancelled = flowCancelled(row, actor.role, team);
    if (cancelled) throw roomError("forbidden", cancelled);
    if (!row.accessible) throw roomError("conflict", "GitHub hasn't sent you back to Uplink Room yet. Finish on GitHub first.");
    if (row.confirming && row.confirming.at + CHECK_STALE_MS > now) throw roomError("conflict", "Uplink Room is already checking this connect with GitHub.");
    const chosen = row.accessible.find((a) => a.installationId === args.installationId);
    if (!chosen) throw roomError("not_found", `GitHub didn't list that account for ${row.githubLogin ?? "the GitHub user who signed in"}.`);
    if (chosen.type === "Organization" && actor.role !== "admin") throw roomError("forbidden", `Only an admin of ${team} can connect an organization.`);
    if (chosen.canShare !== true) throw roomError("forbidden", chosen.why ?? `GitHub didn't confirm you may connect ${chosen.login}.`);
    // GitHub is asked again (githubConfirm.ts) before anything is linked: what it said at the callback can be minutes old.
    await ctx.db.patch(row._id, { confirming: { installationId: chosen.installationId, at: now }, refusal: undefined });
    await ctx.scheduler.runAfter(0, internal.githubConfirm.check, { connectId: row._id, installationId: chosen.installationId, at: now });
    return null;
  },
});

export const { person: endConnect, agent: endConnectAgent } = roomMutation({
  name: "github.endConnect",
  description:
    "People only, and only the person who started the connect. Cancels a connect of yours that's waiting for you to confirm, so nothing can be connected from it, or clears one that finished from github.connects.",
  scope: "team.admin",
  args: { connectId: v.id("githubConnects") },
  handler: async (ctx, actor, args) => {
    if (actor.kind !== "person") throw roomError("forbidden", "Agents can't cancel GitHub connects.");
    const row = await ctx.db.get(args.connectId);
    if (!row || row.teamId !== actor.teamId) throw roomError("not_found", "That GitHub connect isn't in this team.");
    if (row.memberId !== actor.member._id) {
      const starter = (await ctx.db.get(row.memberId))?.name ?? "the person who started it";
      throw roomError("forbidden", `Only ${starter} can cancel this connect: ${starter} started it.`);
    }
    if (row.endedAt === undefined) await ctx.db.patch(row._id, { endedAt: Date.now(), confirming: undefined });
    return null;
  },
});

export const { person: sync, agent: syncAgent } = roomMutation({
  name: "github.sync",
  description:
    "Syncs one connected GitHub account's repos now, unless a sync is already running. An organization: admins. A personal account: only the person who connected it.",
  scope: "team.admin",
  args: { accountId: v.id("githubAccounts") },
  handler: async (ctx, actor, args) => {
    const account = await teamAccount(ctx, actor.teamId, args.accountId);
    await requireMay(ctx, actor, account, "sync");
    if (!githubConfig()) notConfigured();
    if (account.suspendedAt !== undefined) {
      throw roomError("conflict", `${account.login} suspended the App on GitHub, so there is nothing to sync until it's unsuspended.`);
    }
    await beginSync(ctx, account);
    return null;
  },
});

export const { person: disconnect, agent: disconnectAgent } = roomMutation({
  name: "github.disconnect",
  description:
    "Disconnects a GitHub account: its repos leave the repo pickers. Projects keep their repo strings, which then show as not connected. Admins can disconnect any account; a member, only the personal account they connected. The App stays installed on GitHub until the account's owner uninstalls it there.",
  scope: "team.admin",
  args: { accountId: v.id("githubAccounts") },
  handler: async (ctx, actor, args) => {
    const account = await teamAccount(ctx, actor.teamId, args.accountId);
    await requireMay(ctx, actor, account, "disconnect");
    await removeAccount(ctx, account);
    await audit(ctx, actor, "github.disconnected", account._id, { login: account.login });
    return null;
  },
});

/**
 * Members left the team (members.remove): the personal GitHub accounts they connected are
 * disconnected, so their repos leave the pickers, and projects keep their strings, as on any
 * disconnect. The organizations they connected stay: those are the team's. The App stays installed
 * on GitHub until the person uninstalls it there.
 */
export async function disconnectMembersAccounts(ctx: MutationCtx, actor: Actor, memberIds: Id<"members">[]) {
  for (const memberId of memberIds) {
    // A person connects a handful of accounts; 200 is far above any real one.
    const rows = await ctx.db
      .query("githubAccounts")
      .withIndex("by_connected_by", (q) => q.eq("connectedBy", memberId))
      .take(200);
    for (const account of rows) {
      if (account.type !== "User" || account.teamId !== actor.teamId || account.removedAt !== undefined) continue;
      await removeAccount(ctx, account);
      await audit(ctx, actor, "github.disconnected", account._id, { login: account.login, reason: "left_team" });
    }
  }
}

async function removeAccount(ctx: MutationCtx, account: Doc<"githubAccounts">) {
  if (account.removedAt !== undefined) return;
  await ctx.db.patch(account._id, { removedAt: Date.now(), syncGeneration: account.syncGeneration + 1 });
  await ctx.scheduler.runAfter(0, internal.github.deleteAccountRepos, { accountId: account._id });
}

/** Deletes a removed account's repos in batches, then the account. */
export const deleteAccountRepos = internalMutation({
  args: { accountId: v.id("githubAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.removedAt === undefined) return;
    const rows = await ctx.db
      .query("githubRepos")
      .withIndex("by_account_github", (q) => q.eq("githubAccountId", account._id))
      .take(DELETE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.github.deleteAccountRepos, args);
    } else {
      await ctx.db.delete(account._id);
    }
  },
});

// ---------- the connect flow (githubHttp.ts drives the browser part, githubConfirm.ts the last check) ----------

/**
 * Who started a connect flow, as they are now: "admin" or "member" for a person still in its team,
 * "agent" for a flow an agent started before agents were refused, "gone" when they left the team.
 * An admin may connect organizations they own and their own personal account; a member, only their
 * own personal account; an agent or someone gone, nothing. Only the starter confirms, in the app.
 */
export type Starter = "admin" | "member" | "agent" | "gone";

async function starterNow(ctx: QueryCtx, row: Doc<"githubConnects">): Promise<{ starter: Starter; member: Doc<"members"> | null }> {
  const member = await ctx.db.get(row.memberId);
  if (!member || member.teamId !== row.teamId || member.removedAt !== undefined) return { starter: "gone", member: null };
  if (member.kind !== "person") return { starter: "agent", member };
  return { starter: member.role, member };
}

/** A connect flow by its nonce, with what its pages show. The caller checks the signature and the time. */
export const connectFor = internalQuery({
  args: { nonceHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("githubConnects")
      .withIndex("by_nonce", (q) => q.eq("nonceHash", args.nonceHash))
      .unique();
    if (!row) return null;
    const team = await ctx.db.get(row.teamId);
    const member = await ctx.db.get(row.memberId);
    const connected = (await activeAccounts(ctx, row.teamId)).map((a) => a.installationId);
    const { starter } = await starterNow(ctx, row);
    return {
      teamId: row.teamId,
      memberId: row.memberId,
      expiresAt: row.expiresAt,
      codeVerifier: row.codeVerifier,
      claimedInstallationId: row.claimedInstallationId,
      used: row.usedAt !== undefined || row.endedAt !== undefined,
      verified: row.accessible !== undefined,
      teamName: team?.name ?? "your team",
      memberName: member?.name ?? "someone",
      starter,
      /** From before Confirm moved into the app: it connects nothing. */
      legacy: row.starterRole === undefined,
      /** An admin started it and is no longer one: it's cancelled. */
      demoted: row.starterRole === "admin" && starter === "member",
      connectedInstallations: connected,
    };
  },
});

async function liveConnect(ctx: MutationCtx, nonceHash: string) {
  const row = await ctx.db
    .query("githubConnects")
    .withIndex("by_nonce", (q) => q.eq("nonceHash", nonceHash))
    .unique();
  if (!row || row.usedAt !== undefined || row.endedAt !== undefined || row.expiresAt <= Date.now()) return null;
  return row;
}

/** GitHub's Setup URL was reached: keeps the installation id it named, as a claim to check later. */
export const setupReached = internalMutation({
  args: { nonceHash: v.string(), installationId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await liveConnect(ctx, args.nonceHash);
    if (!row || row.accessible !== undefined) return false;
    if (args.installationId !== undefined) await ctx.db.patch(row._id, { claimedInstallationId: args.installationId });
    return true;
  },
});

export const vRefusal = v.union(v.literal("owner"), v.literal("admin"), v.literal("self"), v.literal("limit"));

export const vAccessible = v.object({
  installationId: v.number(),
  accountGithubId: v.number(),
  login: v.string(),
  type: vAccountType,
  avatarUrl: v.optional(v.string()),
  repositorySelection: vSelection,
  suspended: v.boolean(),
  canShare: v.optional(v.boolean()),
  why: v.optional(v.string()),
  refusal: v.optional(vRefusal),
});
export type Accessible = Infer<typeof vAccessible>;

/**
 * The person authorized the App and GitHub listed the installations they can access, with whether
 * they may give each one's every repo to the team. Kept once: a second callback with the same state
 * (a replayed code) changes nothing. The starter then confirms in the app (`confirmConnect`).
 * `ended`: the page already said everything (the account it was for is connected, or can't be),
 * so the flow ends here and the app doesn't offer it.
 */
export const verified = internalMutation({
  args: {
    nonceHash: v.string(),
    githubLogin: v.string(),
    githubUserId: v.number(),
    accessible: v.array(vAccessible),
    ended: v.boolean(),
  },
  handler: async (ctx, args) => {
    const row = await liveConnect(ctx, args.nonceHash);
    if (!row || row.accessible !== undefined) return false;
    await ctx.db.patch(row._id, {
      githubLogin: args.githubLogin,
      githubUserId: args.githubUserId,
      accessible: args.accessible.slice(0, 1000),
      ...(args.ended ? { endedAt: Date.now() } : {}),
    });
    return true;
  },
});

/**
 * What the check asks GitHub about again before linking: who signed in to GitHub and the account the
 * starter chose. Null when the flow isn't waiting on this check any more (cancelled, expired, or a
 * newer Connect replaced it).
 */
export const confirmInput = internalQuery({
  args: { connectId: v.id("githubConnects"), installationId: v.number(), at: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectId);
    if (!row || row.usedAt !== undefined || row.endedAt !== undefined || row.expiresAt <= Date.now()) return null;
    if (row.confirming?.installationId !== args.installationId || row.confirming.at !== args.at) return null;
    if (!row.accessible || row.githubLogin === undefined || row.githubUserId === undefined) return null;
    const choice = row.accessible.find((i) => i.installationId === args.installationId);
    if (!choice) return null;
    return { person: { login: row.githubLogin, id: row.githubUserId }, choice };
  },
});

export type ConfirmWhy = "stale" | "expired" | "agent" | "not_member" | "cancelled" | "no_access" | "not_admin" | "no_authority" | "github";

/**
 * The end of Confirm, after the check asked GitHub again (githubConfirm.ts): links the installation to
 * the team, if the starter's Connect is still the one this check was for, the flow is live, GitHub
 * listed the installation and said the GitHub user may give the team all of it, GitHub still says so
 * (`recheck`), and the starter may connect it now: a person still in the team, still an admin if they
 * started as one, and an admin for an organization. Otherwise the app says why (`refusal`), and the
 * starter can choose Connect again until the flow expires.
 */
export const confirm = internalMutation({
  args: {
    connectId: v.id("githubConnects"),
    installationId: v.number(),
    at: v.number(),
    recheck: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), why: v.string() })),
  },
  handler: async (ctx, args): Promise<{ ok: true; login: string; already: boolean } | { ok: false; why: ConfirmWhy }> => {
    const row = await ctx.db.get(args.connectId);
    // A newer Connect, a cancel, or a check that went stale and was replaced: this report changes nothing.
    if (!row || row.confirming?.installationId !== args.installationId || row.confirming.at !== args.at) return { ok: false, why: "stale" };
    const now = Date.now();
    const refuse = async (why: Exclude<ConfirmWhy, "stale">, text: string) => {
      await ctx.db.patch(row._id, { confirming: undefined, refusal: { installationId: args.installationId, why: text } });
      return { ok: false as const, why };
    };
    if (row.usedAt !== undefined || row.endedAt !== undefined || row.expiresAt <= now || !row.accessible) {
      return refuse("expired", "This connect expired. Choose Connect to start again.");
    }
    const team = (await ctx.db.get(row.teamId))?.name ?? "the team";
    // Who started it is checked as they are now: they may have left the team, or stopped being an admin.
    const { starter, member } = await starterNow(ctx, row);
    if (starter === "agent") return refuse("agent", "Agents can't connect GitHub accounts.");
    if (starter === "gone" || !member) return refuse("not_member", `Whoever started this is no longer in ${team}, so nothing was connected.`);
    const cancelled = flowCancelled(row, starter, team);
    if (cancelled) return refuse("cancelled", cancelled);
    const chosen = row.accessible.find((i) => i.installationId === args.installationId);
    if (!chosen) return refuse("no_access", "GitHub didn't confirm access to that account.");
    if (chosen.type === "Organization" && starter !== "admin") return refuse("not_admin", `Only an admin of ${team} can connect an organization.`);
    if (chosen.canShare !== true) return refuse("no_authority", chosen.why ?? `GitHub didn't confirm you may connect ${chosen.login}.`);
    if (!args.recheck.ok) return refuse("github", args.recheck.why);
    await ctx.db.patch(row._id, { usedAt: now, confirming: undefined, refusal: undefined, connectedLogin: chosen.login });
    const existing = (await activeAccounts(ctx, row.teamId)).find((a) => a.installationId === chosen.installationId);
    if (existing) return { ok: true, login: existing.login, already: true };
    const accountId = await ctx.db.insert("githubAccounts", {
      teamId: row.teamId,
      installationId: chosen.installationId,
      accountGithubId: chosen.accountGithubId,
      login: chosen.login,
      type: chosen.type,
      ...(chosen.avatarUrl ? { avatarUrl: chosen.avatarUrl } : {}),
      repositorySelection: chosen.repositorySelection,
      ...(chosen.suspended ? { suspendedAt: now } : {}),
      connectedBy: member._id,
      connectedAt: now,
      repoCount: 0,
      syncState: "synced",
      syncGeneration: 0,
    });
    await ctx.db.insert("audit", {
      teamId: row.teamId,
      actorId: member._id,
      action: "github.connected",
      target: accountId,
      details: { login: chosen.login, githubUser: row.githubLogin },
      at: now,
    });
    const account = (await ctx.db.get(accountId))!;
    if (!chosen.suspended) await beginSync(ctx, account);
    return { ok: true, login: chosen.login, already: false };
  },
});

// ---------- syncing (githubSync.ts makes the calls) ----------

/** Starts a sync with a new generation, unless one is running (or `force`, to replace it). */
async function beginSync(ctx: MutationCtx, account: Doc<"githubAccounts">, opts: { delayMs?: number; force?: boolean } = {}) {
  const now = Date.now();
  const running = account.syncState === "syncing" && (account.syncStartedAt ?? 0) > now - SYNC_STALE_MS;
  if (running && !opts.force) return;
  const generation = account.syncGeneration + 1;
  await ctx.db.patch(account._id, { syncState: "syncing", syncGeneration: generation, syncStartedAt: now, syncError: undefined });
  await ctx.scheduler.runAfter(opts.delayMs ?? 0, internal.githubSync.run, { accountId: account._id, generation, page: 1 });
}

export const forSync = internalQuery({
  args: { accountId: v.id("githubAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.removedAt !== undefined) return null;
    return { installationId: account.installationId, generation: account.syncGeneration };
  },
});

async function currentSync(ctx: MutationCtx, accountId: Id<"githubAccounts">, generation: number) {
  const account = await ctx.db.get(accountId);
  if (!account || account.removedAt !== undefined || account.syncGeneration !== generation || account.syncState !== "syncing") return null;
  return account;
}

/**
 * What GitHub says about the installation now: its account's name and picture, all repos or some,
 * and whether it's suspended. Returns whether the sync goes on (not while suspended).
 */
export const syncInstallation = internalMutation({
  args: {
    accountId: v.id("githubAccounts"),
    generation: v.number(),
    account: v.object({ id: v.number(), login: v.string(), type: vAccountType, avatarUrl: v.optional(v.string()) }),
    repositorySelection: vSelection,
    suspended: v.boolean(),
  },
  handler: async (ctx, args) => {
    const account = await currentSync(ctx, args.accountId, args.generation);
    if (!account) return false;
    await ctx.db.patch(account._id, {
      login: args.account.login,
      type: args.account.type,
      avatarUrl: args.account.avatarUrl,
      accountGithubId: args.account.id,
      repositorySelection: args.repositorySelection,
      suspendedAt: args.suspended ? (account.suspendedAt ?? Date.now()) : undefined,
      ...(args.suspended ? { syncState: "synced" as const, syncStartedAt: undefined } : {}),
    });
    return !args.suspended;
  },
});

const vGitHubRepo = v.object({
  id: v.number(),
  fullName: v.string(),
  private: v.boolean(),
  archived: v.boolean(),
  defaultBranch: v.string(),
});

/**
 * One page of the installation's repos, as GitHub sent it after `fetchedAt`. Returns false when a
 * newer sync or a disconnect overtook this one. A repo a webhook changed or removed after
 * `fetchedAt` keeps the webhook's state.
 */
export const syncPage = internalMutation({
  args: { accountId: v.id("githubAccounts"), generation: v.number(), fetchedAt: v.number(), repos: v.array(vGitHubRepo) },
  handler: async (ctx, args) => {
    const account = await currentSync(ctx, args.accountId, args.generation);
    if (!account) return false;
    const inserted: Discovered[] = [];
    for (const repo of args.repos) {
      const result = await upsertRepo(ctx, account, repo, { generation: args.generation, fetchedAt: args.fetchedAt });
      if (result.inserted) inserted.push({ githubId: repo.id, key: repoKey(repo.fullName) });
    }
    if (inserted.length) await ctx.db.patch(account._id, { repoCount: account.repoCount + inserted.length });
    await scheduleAssociate(ctx, account.teamId, inserted);
    return true;
  },
});

/**
 * The last page came in: deletes the repos this sync didn't see, in batches. If a webhook changed
 * the account's repos after this sync started, its pages may be older than that change, so the
 * account isn't marked synced: a new sync starts instead.
 */
export const syncFinished = internalMutation({
  args: { accountId: v.id("githubAccounts"), generation: v.number() },
  handler: async (ctx, args) => {
    const account = await currentSync(ctx, args.accountId, args.generation);
    if (!account) return;
    const stale = await ctx.db
      .query("githubRepos")
      .withIndex("by_account_generation", (q) => q.eq("githubAccountId", account._id).lt("syncGeneration", args.generation))
      .take(DELETE_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    if (stale.length) await ctx.db.patch(account._id, { repoCount: Math.max(0, account.repoCount - stale.length) });
    if (stale.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.github.syncFinished, args);
      return;
    }
    if (account.lastWebhookAt !== undefined && account.lastWebhookAt >= (account.syncStartedAt ?? 0)) {
      await beginSync(ctx, (await ctx.db.get(account._id))!, { force: true });
      return;
    }
    await ctx.db.patch(account._id, { syncState: "synced", lastSyncedAt: Date.now(), syncStartedAt: undefined, syncError: undefined });
  },
});

/**
 * The sync couldn't finish. `gone`: GitHub no longer knows the installation, so it was uninstalled
 * while the room missed the webhook, and the account goes as on an uninstall.
 */
export const syncFailed = internalMutation({
  args: { accountId: v.id("githubAccounts"), generation: v.number(), error: v.string(), gone: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const account = await currentSync(ctx, args.accountId, args.generation);
    if (!account) return;
    if (args.gone) {
      await removeAccount(ctx, account);
      return;
    }
    await ctx.db.patch(account._id, { syncState: "failed", syncError: args.error.slice(0, 300), syncStartedAt: undefined });
  },
});

type UpsertOpts = {
  /** Marks the repo seen by this sync, so the sweep keeps it. */
  generation: number;
  /** A sync page: when the room asked GitHub for it. Older than a webhook's change, it loses. */
  fetchedAt?: number;
  /** A webhook: when it was applied. Stamped on the repo, and it clears a tombstone. */
  webhookAt?: number;
};

/**
 * Inserts or updates a synced repo by GitHub's id. A new name is renamed in the team's projects
 * that link it (a scheduled batch). Returns whether it inserted, or `skipped` when a newer webhook
 * state won over a sync page.
 */
async function upsertRepo(
  ctx: MutationCtx,
  account: Doc<"githubAccounts">,
  repo: RepoInfo,
  opts: UpsertOpts,
): Promise<{ inserted: boolean; skipped: boolean }> {
  const tomb = await ctx.db
    .query("githubRepoTombstones")
    .withIndex("by_account_github", (q) => q.eq("githubAccountId", account._id).eq("githubId", repo.id))
    .first();
  // A tie goes to the webhook: it reports a change GitHub made; a later sync corrects a wrong guess.
  if (tomb && opts.fetchedAt !== undefined && tomb.at >= opts.fetchedAt) return { inserted: false, skipped: true };
  if (tomb) await ctx.db.delete(tomb._id);
  const existing = await ctx.db
    .query("githubRepos")
    .withIndex("by_account_github", (q) => q.eq("githubAccountId", account._id).eq("githubId", repo.id))
    .unique();
  const key = repoKey(repo.fullName);
  if (existing) {
    if (opts.fetchedAt !== undefined && existing.webhookAt !== undefined && existing.webhookAt >= opts.fetchedAt) {
      if (existing.syncGeneration < opts.generation) await ctx.db.patch(existing._id, { syncGeneration: opts.generation });
      return { inserted: false, skipped: true };
    }
    await ctx.db.patch(existing._id, {
      fullName: repo.fullName,
      key,
      searchText: words(repo.fullName).join(" "),
      private: repo.private,
      archived: repo.archived ?? existing.archived,
      defaultBranch: repo.defaultBranch ?? existing.defaultBranch,
      syncGeneration: Math.max(existing.syncGeneration, opts.generation),
      ...(opts.webhookAt !== undefined ? { webhookAt: opts.webhookAt } : {}),
    });
    if (existing.key !== key) await scheduleRename(ctx, account.teamId, repo.id, existing.key, repo.fullName);
    return { inserted: false, skipped: false };
  }
  await ctx.db.insert("githubRepos", {
    teamId: account.teamId,
    githubAccountId: account._id,
    githubId: repo.id,
    fullName: repo.fullName,
    key,
    searchText: words(repo.fullName).join(" "),
    private: repo.private,
    archived: repo.archived ?? false,
    defaultBranch: repo.defaultBranch ?? "main",
    syncGeneration: opts.generation,
    ...(opts.webhookAt !== undefined ? { webhookAt: opts.webhookAt } : {}),
  });
  // Links a disconnect kept: if the repo was renamed meanwhile, its projects still list the old
  // name, and the rename job brings each link's name up to date.
  const retained = await ctx.db
    .query("projectRepoLinks")
    .withIndex("by_team_github_project", (q) => q.eq("teamId", account.teamId).eq("githubId", repo.id))
    .first();
  if (retained) await scheduleRename(ctx, account.teamId, repo.id, retained.key ?? key, repo.fullName);
  return { inserted: true, skipped: false };
}

// ---------- projects and synced repos ----------

async function scheduleRename(ctx: MutationCtx, teamId: Id<"teams">, githubId: number, oldKey: string, fullName: string) {
  await ctx.scheduler.runAfter(0, internal.github.renameInProjects, { teamId, githubId, oldKey, fullName, cursor: null });
}

/**
 * Renames a repo in the team's projects that link it by GitHub's id, 50 links a batch, continuing
 * until every link is done. Each link keeps the name its project lists (its key; `oldKey` for a link
 * from before keys were kept), and that string becomes the repo's current name in the team (or
 * `fullName` when the team no longer has it). So batches that run out of order, and links a
 * disconnect kept through a rename, still end on the newest name.
 */
export const renameInProjects = internalMutation({
  args: { teamId: v.id("teams"), githubId: v.number(), oldKey: v.string(), fullName: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("githubRepos")
      .withIndex("by_team_github", (q) => q.eq("teamId", args.teamId).eq("githubId", args.githubId))
      .first();
    const fullName = current?.fullName ?? args.fullName;
    const newKey = repoKey(fullName);
    const page = await ctx.db
      .query("projectRepoLinks")
      .withIndex("by_team_github_project", (q) => q.eq("teamId", args.teamId).eq("githubId", args.githubId))
      .paginate({ numItems: LINK_BATCH, cursor: args.cursor });
    for (const link of page.page) {
      const project = await ctx.db.get(link.projectId);
      if (!project) {
        await ctx.db.delete(link._id);
        continue;
      }
      const from = link.key ?? args.oldKey;
      if (from !== newKey && project.repos.some((r) => repoKey(r) === from)) {
        const renamed = project.repos.map((r) => (repoKey(r) === from ? githubRepoString(fullName) : r));
        await ctx.db.patch(project._id, { repos: [...new Set(renamed)] });
      }
      if (link.key !== newKey) await ctx.db.patch(link._id, { key: newKey });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.github.renameInProjects, { ...args, cursor: page.continueCursor });
    }
  },
});

/** A repo as it was first synced: its GitHub id and the key of the name it had then. */
type Discovered = { githubId: number; key: string };
const vDiscovered = v.object({ githubId: v.number(), key: v.string() });

async function scheduleAssociate(ctx: MutationCtx, teamId: Id<"teams">, repos: Discovered[]) {
  for (let i = 0; i < repos.length; i += ASSOCIATE_IDS) {
    await ctx.scheduler.runAfter(0, internal.github.associateRepos, { teamId, repos: repos.slice(i, i + ASSOCIATE_IDS), cursor: null });
  }
}

/**
 * Links new synced repos to the team's projects that already list them by name: 25 projects a
 * batch, continuing until every project is read. A project may list the name the repo had when it
 * was found or the one it has now: a rename that lands before this job reaches the project renames
 * it here, since the rename job found no link to follow. Safe to run twice: a link that exists is kept.
 */
export const associateRepos = internalMutation({
  args: { teamId: v.id("teams"), repos: v.array(vDiscovered), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const byKey = new Map<string, { githubId: number; key: string; fullName: string }>();
    for (const found of args.repos) {
      const row = await ctx.db
        .query("githubRepos")
        .withIndex("by_team_github", (q) => q.eq("teamId", args.teamId).eq("githubId", found.githubId))
        .first();
      if (!row) continue;
      const now = { githubId: found.githubId, key: row.key, fullName: row.fullName };
      byKey.set(found.key, now);
      byKey.set(row.key, now);
    }
    if (byKey.size === 0) return;
    const page = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .paginate({ numItems: PROJECT_BATCH, cursor: args.cursor });
    for (const project of page.page) {
      let renamed = false;
      const repos = project.repos.map((listed) => {
        const found = byKey.get(repoKey(listed));
        if (!found || repoKey(listed) === found.key) return listed;
        renamed = true;
        return githubRepoString(found.fullName);
      });
      if (renamed) await ctx.db.patch(project._id, { repos: [...new Set(repos)] });
      for (const listed of new Set(project.repos.map(repoKey))) {
        const found = byKey.get(listed);
        if (!found) continue;
        const link = await ctx.db
          .query("projectRepoLinks")
          .withIndex("by_team_github_project", (q) => q.eq("teamId", args.teamId).eq("githubId", found.githubId).eq("projectId", project._id))
          .first();
        if (!link) await ctx.db.insert("projectRepoLinks", { teamId: args.teamId, projectId: project._id, githubId: found.githubId, key: found.key });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.github.associateRepos, { ...args, cursor: page.continueCursor });
    }
  },
});

/**
 * After a project's repos change: links each one that is a synced repo by GitHub's id, and drops
 * the links to repos it no longer lists. A link keeps its repo's key, so a link to a repo that isn't
 * synced now (its account was disconnected) stays while the project still lists that name, and a
 * rename seen after reconnecting still finds the project. projects.create and projects.setRepos
 * call it with at most MAX_PROJECT_REPOS repos, so a project has at most twice that many links.
 */
export async function linkProjectRepos(ctx: MutationCtx, teamId: Id<"teams">, projectId: Id<"projects">, repoStrings: string[]) {
  const keys = new Set(repoStrings.map(repoKey));
  const wanted = new Map<number, string>();
  for (const key of keys) {
    const rows = await ctx.db
      .query("githubRepos")
      .withIndex("by_team_key", (q) => q.eq("teamId", teamId).eq("key", key))
      .take(5);
    for (const row of rows) wanted.set(row.githubId, key);
  }
  const links = await ctx.db
    .query("projectRepoLinks")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(4 * MAX_PROJECT_REPOS);
  const kept = new Set<number>();
  for (const link of links) {
    const keep = wanted.has(link.githubId) || (link.key !== undefined && keys.has(link.key));
    if (!keep || kept.has(link.githubId)) {
      await ctx.db.delete(link._id);
      continue;
    }
    kept.add(link.githubId);
    const key = wanted.get(link.githubId);
    if (key !== undefined && link.key !== key) await ctx.db.patch(link._id, { key });
  }
  for (const [githubId, key] of wanted) {
    if (!kept.has(githubId)) await ctx.db.insert("projectRepoLinks", { teamId, projectId, githubId, key });
  }
}

// ---------- webhooks ----------

/**
 * Applies one verified delivery, once: a redelivery with the same `X-GitHub-Delivery` changes
 * nothing. The delivery is recorded in the same transaction as its first batch of changes, so a
 * delivery that fails to apply isn't recorded, and GitHub's redelivery of it is applied.
 */
export const applyWebhook = internalMutation({
  args: { deliveryId: v.string(), event: vGitHubEvent },
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("githubDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (seen) return "duplicate" as const;
    const at = Date.now();
    await ctx.db.insert("githubDeliveries", { deliveryId: args.deliveryId, at });
    await applyEvent(ctx, args.event, at);
    return "applied" as const;
  },
});

/** The live accounts connected to one installation, one per team that connected it. */
async function accountsFor(ctx: MutationCtx, installationId: number) {
  const rows = await ctx.db
    .query("githubAccounts")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .take(1001);
  if (rows.length > 1000) throw new Error(`Installation ${installationId} is connected to more than 1000 teams.`);
  return rows.filter((a) => a.removedAt === undefined);
}

async function touched(ctx: MutationCtx, accountId: Id<"githubAccounts">, at: number) {
  await ctx.db.patch(accountId, { lastWebhookAt: at });
}

/** A webhook removed a repo from an account: deletes its row, and leaves a tombstone so an older sync page can't bring it back. */
async function removeRepo(ctx: MutationCtx, account: Doc<"githubAccounts">, githubId: number, at: number) {
  const row = await ctx.db
    .query("githubRepos")
    .withIndex("by_account_github", (q) => q.eq("githubAccountId", account._id).eq("githubId", githubId))
    .unique();
  if (row) {
    await ctx.db.delete(row._id);
    const fresh = (await ctx.db.get(account._id))!;
    await ctx.db.patch(account._id, { repoCount: Math.max(0, fresh.repoCount - 1) });
  }
  const tomb = await ctx.db
    .query("githubRepoTombstones")
    .withIndex("by_account_github", (q) => q.eq("githubAccountId", account._id).eq("githubId", githubId))
    .first();
  if (tomb) await ctx.db.patch(tomb._id, { at });
  else await ctx.db.insert("githubRepoTombstones", { githubAccountId: account._id, githubId, at });
  await touched(ctx, account._id, at);
}

/** A webhook added or changed a repo in an account. */
async function webhookRepo(ctx: MutationCtx, account: Doc<"githubAccounts">, repo: RepoInfo, at: number) {
  const fresh = (await ctx.db.get(account._id))!;
  const result = await upsertRepo(ctx, fresh, repo, { generation: fresh.syncGeneration, webhookAt: at });
  if (result.inserted) {
    await ctx.db.patch(account._id, { repoCount: fresh.repoCount + 1 });
    await scheduleAssociate(ctx, account.teamId, [{ githubId: repo.id, key: repoKey(repo.fullName) }]);
  }
  await touched(ctx, account._id, at);
}

async function applyEvent(ctx: MutationCtx, event: GitHubEvent, at: number): Promise<void> {
  if (event.kind === "installation") {
    for (const account of await accountsFor(ctx, event.installationId)) {
      if (event.action === "deleted") await removeAccount(ctx, account);
      else if (event.action === "suspend") await ctx.db.patch(account._id, { suspendedAt: at });
      else if (event.action === "unsuspend") {
        await ctx.db.patch(account._id, { suspendedAt: undefined });
        await beginSync(ctx, { ...account, suspendedAt: undefined });
      } else if (event.action === "new_permissions_accepted") await beginSync(ctx, account);
    }
    return;
  }
  if (event.kind === "installation_target") {
    // The account was renamed: every repo's full name changed, and a sync renames them by id.
    for (const account of await accountsFor(ctx, event.installationId)) {
      if (event.account) await ctx.db.patch(account._id, { login: event.account.login, avatarUrl: event.account.avatarUrl });
      await touched(ctx, account._id, at);
      await beginSync(ctx, (await ctx.db.get(account._id))!);
    }
    return;
  }
  if (event.kind === "installation_repositories") {
    // Each connected team's account in its own mutation: one delivery's 100 changes times every
    // team that connected the installation would pass a mutation's limits. The first is applied
    // with the delivery, the rest right after.
    const accounts = await accountsFor(ctx, event.installationId);
    for (const [i, account] of accounts.entries()) {
      if (i === 0) await installationReposChange(ctx, account, event, at);
      else await ctx.scheduler.runAfter(0, internal.github.applyInstallationRepos, { accountId: account._id, event, at });
    }
    return;
  }
  if (event.kind === "pull_request" || event.kind === "pull_request_review" || event.kind === "check_suite") {
    await applyPullEvent(ctx, event, at);
    return;
  }
  await repoEventBatch(ctx, event, at, null);
}

async function installationReposChange(ctx: MutationCtx, account: Doc<"githubAccounts">, event: InstallationReposEvent, at: number) {
  await ctx.db.patch(account._id, { repositorySelection: event.repositorySelection });
  await touched(ctx, account._id, at);
  // Too many to apply here, or a switch to all repos (GitHub lists none): a sync brings them.
  if (event.tooMany || (event.added.length === 0 && event.removed.length === 0)) {
    await beginSync(ctx, (await ctx.db.get(account._id))!);
    return;
  }
  for (const repo of event.added) await webhookRepo(ctx, account, repo, at);
  for (const githubId of event.removed) await removeRepo(ctx, account, githubId, at);
  // This payload has no default branch or archived flag for added repos: a sync fills them in.
  if (event.added.length) await beginSync(ctx, (await ctx.db.get(account._id))!);
}

/** One more team's share of an `installation_repositories` delivery. */
export const applyInstallationRepos = internalMutation({
  args: { accountId: v.id("githubAccounts"), event: vInstallationReposEvent, at: v.number() },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.removedAt !== undefined) return;
    await installationReposChange(ctx, account, args.event, args.at);
  },
});

type RepoEvent = RepositoryEvent;

/**
 * One batch of a `repository` event over the repo's synced copies (one per account that has it):
 * renamed, archived, unarchived, privatized, publicized and edited update each copy by GitHub's id.
 * A transfer reaches only the new owner's installation: each other copy is renamed in its team's
 * projects first (the scheduled rename reads the new name), then removed. The last batch adds the
 * repo to the event's installations that give all repos and lack it, for a transfer or a new repo.
 * `deleted`, which GitHub says Apps don't receive, removes every copy; the daily sync covers it.
 */
async function repoEventBatch(ctx: MutationCtx, event: RepoEvent, at: number, cursor: string | null) {
  const repo = event.repo;
  const accounts = event.installationId !== undefined ? await accountsFor(ctx, event.installationId) : [];
  const mine = new Set(accounts.map((a) => a._id));
  const page = await ctx.db
    .query("githubRepos")
    .withIndex("by_github", (q) => q.eq("githubId", repo.id))
    .paginate({ numItems: COPY_BATCH, cursor });
  for (const row of page.page) {
    const account = await ctx.db.get(row.githubAccountId);
    if (!account || account.removedAt !== undefined) continue;
    if (event.action === "deleted") {
      await removeRepo(ctx, account, repo.id, at);
      continue;
    }
    if (event.action === "transferred" && !mine.has(account._id)) {
      if (row.key !== repoKey(repo.fullName)) await scheduleRename(ctx, row.teamId, repo.id, row.key, repo.fullName);
      await removeRepo(ctx, account, repo.id, at);
      continue;
    }
    await webhookRepo(ctx, account, repo, at);
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.github.applyRepoEvent, { event, at, cursor: page.continueCursor });
    return;
  }
  if (event.action !== "created" && event.action !== "transferred") return;
  for (const account of accounts) {
    const has = await ctx.db
      .query("githubRepos")
      .withIndex("by_account_github", (q) => q.eq("githubAccountId", account._id).eq("githubId", repo.id))
      .unique();
    if (has) continue;
    if (account.repositorySelection === "all") await webhookRepo(ctx, account, repo, at);
    else {
      // A selected-repos installation gets a repo only if someone picked it: a sync finds out.
      await touched(ctx, account._id, at);
      await beginSync(ctx, (await ctx.db.get(account._id))!);
    }
  }
}

/** The rest of a `repository` event, when the repo has more synced copies than one batch. */
export const applyRepoEvent = internalMutation({
  args: { event: vRepositoryEvent, at: v.number(), cursor: v.string() },
  handler: async (ctx, args) => {
    await repoEventBatch(ctx, args.event, args.at, args.cursor);
  },
});

// ---------- housekeeping ----------

/**
 * The daily sync of every connected account, 200 accounts a batch until every one is visited,
 * spread over a few minutes: GitHub sends Apps no event when a repo is deleted.
 */
export const syncAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), started: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!githubConfig()) return;
    const page = await ctx.db
      .query("githubAccounts")
      .withIndex("by_removed", (q) => q.eq("removedAt", undefined))
      .paginate({ numItems: 200, cursor: args.cursor ?? null });
    let i = args.started ?? 0;
    for (const account of page.page) {
      // Suspended ones too: the sync asks GitHub first, so a missed unsuspend or uninstall webhook
      // is caught here (still suspended, it stops before reading repos).
      await beginSync(ctx, account, { delayMs: (i++ % 300) * 1000 });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.github.syncAll, { cursor: page.continueCursor, started: i });
  },
});

/** Deletes connect flows a day past their expiry, deliveries older than 7 days, and tombstones older than a day. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const flows = await ctx.db
      .query("githubConnects")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now - 24 * 60 * 60 * 1000))
      .take(DELETE_BATCH);
    for (const row of flows) await ctx.db.delete(row._id);
    const deliveries = await ctx.db
      .query("githubDeliveries")
      .withIndex("by_at", (q) => q.lt("at", now - 7 * 24 * 60 * 60 * 1000))
      .take(DELETE_BATCH);
    for (const row of deliveries) await ctx.db.delete(row._id);
    const tombs = await ctx.db
      .query("githubRepoTombstones")
      .withIndex("by_at", (q) => q.lt("at", now - TOMBSTONE_MS))
      .take(DELETE_BATCH);
    for (const row of tombs) await ctx.db.delete(row._id);
    if (flows.length === DELETE_BATCH || deliveries.length === DELETE_BATCH || tombs.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.github.prune, {});
    }
  },
});

// ---------- pull requests linked to tasks (ADR 0051) ----------

export const pullRequestRow = internalQuery({
  args: { pullRequestId: v.id("taskPullRequests") },
  handler: async (ctx, { pullRequestId }) => {
    const row = await ctx.db.get(pullRequestId);
    // A team that disconnected the account reads nothing more from it.
    if (!row || !(await pullRowLive(ctx, row))) return null;
    return { repo: row.repo, number: row.number, installationId: row.installationId };
  },
});

const vPullRead = v.object({
  title: v.optional(v.string()),
  url: v.optional(v.string()),
  state: v.union(v.literal("open"), v.literal("draft"), v.literal("merged"), v.literal("closed")),
  headSha: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
  reviews: v.array(
    v.object({
      login: v.string(),
      state: v.union(v.literal("approved"), v.literal("changes_requested"), v.literal("dismissed")),
      reviewId: v.optional(v.number()),
      at: v.optional(v.number()),
    }),
  ),
  checks: v.optional(
    v.array(
      v.object({
        app: v.string(),
        suiteId: v.optional(v.number()),
        sha: v.string(),
        status: v.string(),
        conclusion: v.optional(v.string()),
        at: v.optional(v.number()),
      }),
    ),
  ),
});

/**
 * What readPullRequest found, folded in field by field as webhooks are: the pull request's own
 * fields only when GitHub's `updated_at` is at least the row's, each review and check suite by its
 * own time. So a webhook that landed while the read was asking GitHub keeps what it said, and the
 * read still fills in the rest. An error shows only while the room knows nothing of the pull request.
 */
export const pullRequestRead = internalMutation({
  args: {
    pullRequestId: v.id("taskPullRequests"),
    installationId: v.number(),
    read: v.optional(vPullRead),
    fetchedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pullRequestId);
    if (!row || row.installationId !== args.installationId || !(await pullRowLive(ctx, row))) return null;
    if (args.error !== undefined) {
      if (row.state === undefined) await ctx.db.patch(row._id, { error: args.error });
      return null;
    }
    const read = args.read!;
    // At the same second as the row, the read wins only if nothing changed the row since it began;
    // otherwise neither can say which is newer, so the room asks GitHub again.
    const same = row.pullUpdatedAt !== undefined && read.updatedAt === row.pullUpdatedAt;
    const untouched = args.fetchedAt !== undefined && row.updatedAt <= args.fetchedAt;
    const differs =
      read.state !== row.state ||
      (read.headSha ?? row.headSha) !== row.headSha ||
      (read.title ?? row.title) !== row.title ||
      (read.url ?? row.url) !== row.url;
    if (same && differs && !untouched) {
      await ctx.scheduler.runAfter(0, internal.githubSync.readPullRequest, { pullRequestId: row._id });
    }
    const fresher =
      row.pullUpdatedAt === undefined ||
      (read.updatedAt !== undefined && (read.updatedAt > row.pullUpdatedAt || (same && (untouched || !differs))));
    const headSha = fresher ? (read.headSha ?? row.headSha) : row.headSha;
    let reviews = row.reviews ?? [];
    for (const review of read.reviews) reviews = withReview(reviews, review);
    let checks = row.checks ?? [];
    for (const check of read.checks ?? []) checks = withCheck(checks, check, headSha);
    await ctx.db.patch(row._id, {
      ...(fresher
        ? { state: read.state, title: read.title, url: read.url, headSha: read.headSha, pullUpdatedAt: read.updatedAt }
        : {}),
      reviews,
      checks,
      error: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});
