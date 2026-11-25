/**
 * Shared browsers (spec #7, ADR 0006): cloud browsers that people in a
 * channel use together, with the same access, driver and wheel as terminals.
 *
 * The backend alone talks to the provider. It holds each browser's session
 * (embed URL and admin token) and gives the mouse and keyboard only to the
 * driver's connections. People join with a one-time ticket that Hyperbeam
 * passes back to our auth webhook (`http.ts`), which is how the backend knows
 * which connection is which member.
 *
 * A browser is temporary unless whoever starts it keeps its logins: then it
 * loads and saves back to saved logins (`savedLogins.ts`, ADR 0011).
 */
import { canSeeId, channelAccess, hasMemberList, memberCanSee } from "./lib/channels";
import { v } from "convex/values";
import { accessRank, vAccess, type Access } from "@uplink-room/protocol";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { accountDeleted, accountableStands, activeAgentKeys, actsFor, requireAdmin, type Actor } from "./lib/actor";
import { browserProvider, PROVIDER_ENV_VAR, siteUrl } from "./lib/browserProvider";
import { randomSecret, sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { audit, inTeam, maybeView, memberView, teamMember } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { SAVE_BEFORE_END_MS, vKeep } from "./lib/savedLogins";
import { createSavedLogins, eraseWhenFree, loadableSavedLogins, recordProfile, usable, usedBy } from "./savedLogins";

const MINUTE = 60 * 1000;

/** A team's shared-browser limits until an admin changes them. */
export const BROWSER_DEFAULTS = {
  mostOpenAccess: "open" as Access,
  maxLive: 2,
  idleMinutes: 10,
  longestMinutes: 120,
};

/** The ranges an admin may pick from. */
export const BROWSER_LIMITS = {
  maxLive: { min: 1, max: 10 },
  idleMinutes: { min: 1, max: 60 },
  longestMinutes: { min: 10, max: 480 },
} as const;

/** With nobody connected for this long, Hyperbeam ends the browser. */
const OFFLINE_SEC = 5 * 60;
/** Hyperbeam warns this long before a timeout ends the browser. */
const WARNING_SEC = 60;
/** A join ticket works once, within this window. */
const TICKET_MS = 2 * MINUTE;
/** Watchers seen in this window count as watching. */
const WATCH_WINDOW_MS = 30 * 1000;

type EndReason = NonNullable<Doc<"browsers">["endReason"]>;

/** Starting or live: people can join it, and it shows in the channel. */
const isLive = (b: Doc<"browsers">) => b.status === "starting" || b.status === "live";
/** Running at the provider, or possibly still: it counts toward the team's limit. */
const holdsSlot = (b: Doc<"browsers">) => isLive(b) || b.status === "stopping";

async function settingsFor(ctx: QueryCtx, teamId: Id<"teams">) {
  const row = await ctx.db
    .query("browserSettings")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .unique();
  return {
    mostOpenAccess: row?.mostOpenAccess ?? BROWSER_DEFAULTS.mostOpenAccess,
    maxLive: row?.maxLive ?? BROWSER_DEFAULTS.maxLive,
    idleMinutes: row?.idleMinutes ?? BROWSER_DEFAULTS.idleMinutes,
    longestMinutes: row?.longestMinutes ?? BROWSER_DEFAULTS.longestMinutes,
  };
}

async function teamBrowsers(ctx: QueryCtx, teamId: Id<"teams">) {
  return ctx.db
    .query("browsers")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .collect();
}

/** A live browser the room asked the provider about within the last minute. */
function recentlyChecked(b: Doc<"browsers">) {
  return b.status !== "live" || (b.lastAliveCheckAt !== undefined && Date.now() - b.lastAliveCheckAt < MINUTE);
}

function limitMessage(maxLive: number) {
  return `This team allows ${maxLive} shared browser${maxLive === 1 ? "" : "s"} live at once. End one or join one.`;
}

/** Only web pages: never `javascript:`, `file:`, `chrome:` or the like. */
function webUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw roomError("invalid", "Only http and https URLs can be opened.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw roomError("invalid", "Only http and https URLs can be opened.");
  }
  // Keep what the person typed (it parsed as http or https), so it reads the same back.
  return raw.trim();
}

async function browserView(ctx: QueryCtx, b: Doc<"browsers">) {
  const channel = await ctx.db.get(b.channelId);
  const now = Date.now();
  const watchers = await ctx.db
    .query("browserWatchers")
    .withIndex("by_browser", (q) => q.eq("browserId", b._id))
    .collect();
  const saved = b.savedLoginId ? await ctx.db.get(b.savedLoginId) : null;
  // Never the session: the embed URL goes out only through `browsers.join`, the admin token never.
  return {
    browserId: b._id,
    channel: channel ? { channelId: channel._id, name: channel.name } : undefined,
    status: b.status,
    endReason: b.endReason,
    endedBy: await maybeView(ctx, b.endedBy),
    failReason: b.failReason,
    access: b.access,
    loweredFrom: b.loweredFrom,
    startUrl: b.startUrl,
    /** The last URL the room gave up opening, after retrying, and why. Cleared once a URL opens. */
    navigationError: b.navigationError,
    /** The saved logins it loads and saves back to; unset for a temporary browser. Never the profile id. */
    savedLogin: saved
      ? {
          savedLoginId: saved._id,
          name: saved.name,
          keep: saved.keep,
          // Past their deadline they count as forgotten, even before the scheduled job runs.
          ...(usable(saved) ? { expiresAt: saved.expiresAt } : {}),
          status: usable(saved) ? saved.status : ("forgotten" as const),
          savedBy: saved.savedBy,
        }
      : undefined,
    startedBy: await memberView(ctx, b.startedBy),
    driver: await memberView(ctx, b.driverId),
    watching: isLive(b)
      ? await Promise.all(
          watchers.filter((w) => now - w.lastSeenAt < WATCH_WINDOW_MS).map((w) => memberView(ctx, w.memberId)),
        )
      : [],
    idleMinutes: b.idleMinutes,
    longestMinutes: b.longestMinutes,
    startedAt: b.startedAt,
    liveAt: b.liveAt,
    endedAt: b.endedAt,
  };
}

export type BrowserView = Awaited<ReturnType<typeof browserView>>;

// ---------------------------------------------------------------------------
// Reading

export const { person: get, agent: getAgent } = roomQuery({
  name: "browsers.get",
  description:
    "One shared browser: its channel, status (starting, live, stopping, ended, failed), access, driver and who is watching, and the last URL it couldn't open after retrying, with why (`navigationError`). Never its embed URL; use browsers.join for that.",
  scope: "room.read",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => browserView(ctx, await inTeam(ctx, actor, args.browserId)),
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "browsers.list",
  description: "List the team's live shared browsers (starting or live), or one channel's.",
  scope: "room.read",
  args: { channelId: v.optional(v.id("channels")) },
  handler: async (ctx, actor, args) => {
    if (args.channelId) await channelAccess(ctx, actor, args.channelId);
    const rows = args.channelId
      ? await ctx.db
          .query("browsers")
          .withIndex("by_channel", (q) => q.eq("channelId", args.channelId!))
          .collect()
      : await teamBrowsers(ctx, actor.teamId);
    const visible = [];
    for (const b of rows) {
      if (b.teamId === actor.teamId && isLive(b) && (await canSeeId(ctx, actor, b.channelId))) visible.push(b);
    }
    return Promise.all(visible.map((b) => browserView(ctx, b)));
  },
});

export const { person: settings, agent: settingsAgent } = roomQuery({
  name: "browsers.settings",
  description:
    "Whether shared browsers are configured, the team's limits (most open access, how many may be live, idle timeout, longest session), how many are live and this month's browser minutes.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const now = Date.now();
    const start = new Date(now);
    const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const browsers = await teamBrowsers(ctx, actor.teamId);
    let ms = 0;
    for (const b of browsers) {
      if (b.liveAt === undefined) continue;
      const to = b.endedAt ?? now;
      const from = Math.max(b.liveAt, monthStart);
      if (to > from) ms += to - from;
    }
    return {
      configured: browserProvider() !== null,
      envVar: PROVIDER_ENV_VAR,
      ...(await settingsFor(ctx, actor.teamId)),
      limits: BROWSER_LIMITS,
      live: browsers.filter(holdsSlot).length,
      minutesThisMonth: Math.round(ms / MINUTE),
    };
  },
});

// ---------------------------------------------------------------------------
// Starting and ending

export const { person: start, agent: startAgent } = roomMutation({
  name: "browsers.start",
  description:
    'Start a shared browser in a channel, optionally at a URL, with an access level (default drive). You become its driver. If the channel already has one, returns that one instead. It is temporary (keeps no logins) unless you pass `savedLoginId` (the channel\'s saved logins to load; see savedLogins.list) or `newSavedLogin: { name, keep }` to keep its logins as new saved logins for "1d", "7d", "30d" or "forever" (until someone forgets them). A browser with saved logins saves back to them when it ends.',
  scope: "browsers.use",
  args: {
    channelId: v.id("channels"),
    url: v.optional(v.string()),
    access: v.optional(vAccess),
    savedLoginId: v.optional(v.id("savedLogins")),
    newSavedLogin: v.optional(v.object({ name: v.string(), keep: vKeep })),
  },
  handler: async (ctx, actor, args) => {
    const channel = await inTeam(ctx, actor, args.channelId);
    if (channel.archivedAt !== undefined) throw roomError("invalid", "This channel is archived.");
    if (!browserProvider()) {
      throw roomError(
        "not_configured",
        `Shared browsers aren't configured yet. An admin sets ${PROVIDER_ENV_VAR} in the Convex environment.`,
      );
    }
    const inChannel = await ctx.db
      .query("browsers")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .collect();
    const existing = inChannel.find(isLive);
    if (existing) return existing._id;

    const limits = await settingsFor(ctx, actor.teamId);
    const access = args.access ?? "drive";
    if (accessRank(access) > accessRank(limits.mostOpenAccess)) {
      throw roomError("invalid", `Shared browsers in this team allow at most ${limits.mostOpenAccess}.`);
    }
    const startUrl = args.url?.trim() ? webUrl(args.url) : undefined;
    const running = (await teamBrowsers(ctx, actor.teamId)).filter(holdsSlot);
    // At the limit, Hyperbeam may still have ended some without a webhook reaching us. If any live
    // one wasn't checked in the last minute, accept the start: provisioning asks about those first,
    // then claims a slot or fails with this same reason.
    const waitsForSlot = running.length >= limits.maxLive && running.some((b) => !recentlyChecked(b));
    if (running.length >= limits.maxLive && !waitsForSlot) {
      throw roomError("conflict", limitMessage(limits.maxLive));
    }
    if (args.savedLoginId && args.newSavedLogin) {
      throw roomError("invalid", "Pass savedLoginId to load saved logins, or newSavedLogin to keep new ones, not both.");
    }
    const savedLoginId = args.savedLoginId
      ? (await loadableSavedLogins(ctx, actor, args.savedLoginId, channel._id))._id
      : args.newSavedLogin
        ? await createSavedLogins(ctx, actor, channel._id, args.newSavedLogin)
        : undefined;
    const browserId = await ctx.db.insert("browsers", {
      teamId: actor.teamId,
      channelId: channel._id,
      startedBy: actor.member._id,
      driverId: actor.member._id,
      access,
      ...(startUrl ? { startUrl } : {}),
      ...(savedLoginId ? { savedLoginId } : {}),
      status: "starting",
      idleMinutes: limits.idleMinutes,
      longestMinutes: limits.longestMinutes,
      startedAt: Date.now(),
      ...(waitsForSlot ? { waitsForSlot } : {}),
    });
    const provisionJobId = await ctx.scheduler.runAfter(0, internal.browsers.provision, { browserId });
    await ctx.db.patch(browserId, { provisionJobId });
    // Before provisioning runs: if it ends without reporting, the watchdog recovers the start.
    await ctx.scheduler.runAfter(PROVISION_CHECK_MS, internal.browsers.provisionWatchdog, { browserId });
    await audit(ctx, actor, "browser.started", browserId, {
      channelId: channel._id,
      access,
      ...(savedLoginId ? { savedLoginId } : {}),
    });
    return browserId;
  },
});

export const { person: end, agent: endAgent } = roomMutation({
  name: "browsers.end",
  description:
    "End a shared browser so it stops costing money. Whoever started it, its driver, or an admin can. It shows as stopping, and keeps its place in the team's limit, until Hyperbeam confirms it is gone. A browser with saved logins waits 30 seconds before Hyperbeam ends it, so the logins made just before are saved.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await inTeam(ctx, actor, args.browserId);
    if (!isLive(browser)) return null;
    if (!actsFor(actor, browser.startedBy) && browser.driverId !== actor.member._id && actor.role !== "admin") {
      throw roomError("forbidden", "Only whoever started this browser, its driver or an admin can end it.");
    }
    await beginStop(ctx, browser, "ended", { endedBy: actor.member._id });
    await audit(ctx, actor, "browser.ended", browser._id);
    return null;
  },
});

/** Cancels a scheduled job if there is one. */
async function cancelJob(ctx: MutationCtx, id: Id<"_scheduled_functions"> | undefined) {
  if (!id) return;
  const job = await ctx.db.system.get("_scheduled_functions", id);
  if (job && job.state.kind === "pending") await ctx.scheduler.cancel(id);
}

/**
 * Starts stopping a browser: it stays "stopping", and keeps its place in the
 * team's limit, until the provider confirms the session is gone. A browser
 * still starting has no session yet; `provisioned` stops it once it does.
 */
async function beginStop(
  ctx: MutationCtx,
  browser: Doc<"browsers">,
  reason: EndReason,
  opts: { endedBy?: Id<"members">; fromBackstop?: boolean } = {},
) {
  if (!isLive(browser)) return;
  await ctx.db.patch(browser._id, {
    status: "stopping",
    endReason: reason,
    ...(opts.endedBy ? { endedBy: opts.endedBy } : {}),
    stopAttempts: 0,
  });
  if (!opts.fromBackstop) await cancelJob(ctx, browser.endCheckId);
  await cancelJob(ctx, browser.aliveCheckId);
  await cancelPending(ctx, browser._id, "watch");
  if (browser.session) {
    // Nobody may watch or drive a browser that is stopping, though its session may run on for a
    // while to save its logins: forget its connections now, and take their roles and connections
    // away at the provider. Admission already refuses a browser that isn't live.
    const connections = await ctx.db
      .query("browserConnections")
      .withIndex("by_browser", (q) => q.eq("browserId", browser._id))
      .collect();
    for (const c of connections) await ctx.db.delete(c._id);
    await ctx.scheduler.runAfter(0, internal.browsers.cutAtStop, {
      browserId: browser._id,
      providerUserIds: [...new Set(connections.map((c) => c.providerUserId))],
    });
    // Saved logins: let the browser write its latest logins to disk before Hyperbeam saves the profile.
    const wait = browser.savedLoginId ? SAVE_BEFORE_END_MS : 0;
    await nextStopStep(ctx, browser._id, Date.now() + wait);
  }
}

/**
 * Marks a browser ended (or failed) once its session is known to be gone, and
 * clears what it was waiting on.
 */
async function settleEnded(
  ctx: MutationCtx,
  browser: Doc<"browsers">,
  reason: EndReason,
  opts: { failReason?: string } = {},
) {
  if (!holdsSlot(browser)) return;
  await ctx.db.patch(browser._id, {
    status: reason === "failed" ? "failed" : "ended",
    // A browser already stopping keeps the reason it was stopped for.
    endReason: browser.status === "stopping" ? (browser.endReason ?? reason) : reason,
    endedAt: Date.now(),
    ...(opts.failReason ? { failReason: opts.failReason } : {}),
  });
  for (const id of [browser.endCheckId, browser.aliveCheckId, browser.stopCheckId]) await cancelJob(ctx, id);
  await cancelPending(ctx, browser._id, "watch");
  // Saved logins forgotten while this browser ran are erased once their last browser has ended.
  if (browser.savedLoginId) await eraseWhenFree(ctx, browser.savedLoginId);
}

/** Below Drive, pending wheel requests are cancelled; below Suggest, pending suggestions are dismissed. */
async function cancelPending(ctx: MutationCtx, browserId: Id<"browsers">, access: Access) {
  if (accessRank(access) < accessRank("drive")) {
    const requests = await ctx.db
      .query("browserWheelRequests")
      .withIndex("by_browser", (q) => q.eq("browserId", browserId))
      .collect();
    for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  }
  if (accessRank(access) < accessRank("suggest")) {
    const suggestions = await ctx.db
      .query("browserSuggestions")
      .withIndex("by_browser", (q) => q.eq("browserId", browserId))
      .collect();
    for (const s of suggestions) if (s.status === "pending") await ctx.db.patch(s._id, { status: "dismissed" });
  }
}

/** Retry delays for provider calls the room must not give up on: 5 s, 10 s, 20 s … up to 10 minutes. */
function backoff(attempt: number): number {
  return Math.min(5_000 * 2 ** attempt, 10 * MINUTE);
}

// ---------------------------------------------------------------------------
// Talking to the provider (scheduled, since mutations can't call out)

export const forProvider = internalQuery({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => ctx.db.get(browserId),
});

export const provision = internalAction({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    // Ended before provisioning began: settle it, and create no session.
    if ((await ctx.runMutation(internal.browsers.stillStarting, { browserId })) !== "starting") return null;
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    if (!browser) return null;
    const provider = browserProvider();
    if (!provider) {
      await ctx.runMutation(internal.browsers.failed, {
        browserId,
        reason: `Shared browsers aren't configured: ${PROVIDER_ENV_VAR} is not set.`,
      });
      return null;
    }
    if (browser.waitsForSlot) {
      // Ask about the team's live browsers that weren't checked lately, then claim a slot.
      const unchecked = await ctx.runQuery(internal.browsers.uncheckedLive, { teamId: browser.teamId });
      for (const b of unchecked) {
        const ended = await provider.hasEnded(b.sessionId).catch(() => false);
        await ctx.runMutation(internal.browsers.aliveResult, { browserId: b.browserId, ended });
      }
      if (!(await ctx.runMutation(internal.browsers.claimSlot, { browserId }))) return null;
      // It may have been ended while the room checked the others.
      if ((await ctx.runMutation(internal.browsers.stillStarting, { browserId })) !== "starting") return null;
    }
    // Saved logins: a new profile, or the one they already have. Forgotten meanwhile: none.
    const profile = browser.savedLoginId
      ? await ctx.runQuery(internal.savedLogins.profileFor, { savedLoginId: browser.savedLoginId })
      : null;
    const secret = randomSecret("hbw", 32);
    let started;
    try {
      started = await provider.start({
        tag: browserId,
        ...(browser.startUrl ? { startUrl: browser.startUrl } : {}),
        ...(profile ? { profile } : {}),
        timeouts: {
          inactiveSec: browser.idleMinutes * 60,
          offlineSec: OFFLINE_SEC,
          absoluteSec: browser.longestMinutes * 60,
          warningSec: WARNING_SEC,
        },
        authWebhook: { url: `${siteUrl()}/hyperbeam/auth`, bearer: secret },
        timeoutWebhook: { url: `${siteUrl()}/hyperbeam/timeout`, bearer: secret },
      });
    } catch (error) {
      const reason = message(error);
      // With saved logins, a start whose answer was lost may still have made a session, which loads
      // and saves their profile. Until it is found and ended, nothing else may use or erase it.
      if (profile) await ctx.runMutation(internal.browsers.startUncertain, { browserId, reason });
      else await ctx.runMutation(internal.browsers.failed, { browserId, reason });
      return null;
    }
    const { profileId, openAfterStart, ...session } = started;
    await ctx.runMutation(internal.browsers.provisioned, {
      browserId,
      session,
      ...(profileId ? { profileId } : {}),
      ...(openAfterStart ? { openAfterStart } : {}),
      webhookSecretHash: await sha256(secret),
    });
    return null;
  },
});

/** How often the room asks the provider whether a live browser is still running. */
function aliveEvery(browser: Doc<"browsers">): number {
  return Math.max(browser.idleMinutes, 5) * MINUTE;
}

export const provisioned = internalMutation({
  args: {
    browserId: v.id("browsers"),
    session: v.object({ sessionId: v.string(), embedUrl: v.string(), adminToken: v.string() }),
    /** The profile the session saves its logins to, for a browser with saved logins. */
    profileId: v.optional(v.string()),
    /** A start URL the provider couldn't open at start; opened once the session is recorded. */
    openAfterStart: v.optional(v.string()),
    webhookSecretHash: v.string(),
  },
  handler: async (ctx, args) => {
    const browser = await ctx.db.get(args.browserId);
    if (!browser) return null;
    // The session saves to this profile when it ends, however it ends, so the saved logins learn it
    // first: forgotten ones erase it once this browser has ended.
    if (browser.savedLoginId && args.profileId) await recordProfile(ctx, browser.savedLoginId, args.profileId);
    if (browser.status === "stopping") {
      // Ended while it was starting: stop the session it just got.
      await ctx.db.patch(browser._id, { session: args.session });
      await nextStopStep(ctx, browser._id, Date.now());
      return null;
    }
    if (browser.status !== "starting") return null;
    const now = Date.now();
    // Our own end at the longest session, and a regular check that the session still runs, in case
    // Hyperbeam's timeout webhook never reaches us.
    const endCheckId = await ctx.scheduler.runAt(now + browser.longestMinutes * MINUTE, internal.browsers.expire, {
      browserId: browser._id,
    });
    const aliveCheckId = await ctx.scheduler.runAt(now + aliveEvery(browser), internal.browsers.checkAlive, {
      browserId: browser._id,
    });
    await ctx.db.patch(browser._id, {
      status: "live",
      session: args.session,
      webhookSecretHash: args.webhookSecretHash,
      liveAt: now,
      // It just started, so it counts as checked.
      lastAliveCheckAt: now,
      endCheckId,
      aliveCheckId,
    });
    if (browser.savedLoginId) await usedBy(ctx, browser.savedLoginId);
    // Best effort, in an action of its own: a stalled navigation can't undo recording the session.
    // It is the first navigation asked for, so any URL opened after it wins.
    if (args.openAfterStart) await requestNavigation(ctx, browser._id, args.openAfterStart);
    return null;
  },
});

/**
 * Whether provisioning should go on. A browser ended before it had a session
 * has nothing running at the provider, so it is settled as ended here, which
 * frees its slot. A session created by a start already in flight when it was
 * ended is stopped by `provisioned`.
 */
export const stillStarting = internalMutation({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }): Promise<"starting" | "cancelled" | "gone"> => {
    const browser = await ctx.db.get(browserId);
    if (!browser) return "gone";
    if (browser.status === "starting") return "starting";
    if (browser.status === "stopping" && !browser.session && browser.recoverUntil === undefined) {
      await settleEnded(ctx, browser, browser.endReason ?? "ended");
      return "cancelled";
    }
    return "gone";
  },
});

export const uncheckedLive = internalQuery({
  args: { teamId: v.id("teams") },
  handler: async (ctx, { teamId }) =>
    (await teamBrowsers(ctx, teamId))
      .filter((b) => b.status === "live" && b.session && !recentlyChecked(b))
      .map((b) => ({ browserId: b._id, sessionId: b.session!.sessionId })),
});

/** For a start accepted at the limit: true if a slot is free now, else it fails with the limit's reason. */
export const claimSlot = internalMutation({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.db.get(browserId);
    if (browser?.status === "stopping" && !browser.session && browser.recoverUntil === undefined) {
      await settleEnded(ctx, browser, browser.endReason ?? "ended");
      return false;
    }
    if (!browser || browser.status !== "starting") return false;
    const { maxLive } = await settingsFor(ctx, browser.teamId);
    const others = (await teamBrowsers(ctx, browser.teamId)).filter((b) => b._id !== browserId && holdsSlot(b));
    if (others.length >= maxLive) {
      await settleEnded(ctx, browser, "failed", { failReason: limitMessage(maxLive) });
      return false;
    }
    await ctx.db.patch(browserId, { waitsForSlot: undefined });
    return true;
  },
});

export const failed = internalMutation({
  args: { browserId: v.id("browsers"), reason: v.string() },
  handler: async (ctx, { browserId, reason }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser) return null;
    // Ended before it had a session: nothing runs at the provider.
    if (browser.status === "stopping" && !browser.session && browser.recoverUntil === undefined) {
      await settleEnded(ctx, browser, "ended");
    } else if (browser.status === "starting") await settleEnded(ctx, browser, "failed", { failReason: reason });
    return null;
  },
});

/** The longest-session backstop. */
export const expire = internalMutation({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.db.get(browserId);
    if (browser) await beginStop(ctx, browser, "longest_session", { fromBackstop: true });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Stopping at the provider
//
// A stopping browser stays stopping until the provider confirms its session is gone. Convex
// doesn't retry a scheduled action, so the tries hang on `stopStep`, a mutation that leases each
// one (moving `stopNextAt` a minute ahead, longer than a try's deadlines) before the action runs,
// and is scheduled again for then. A try that fails is tried again sooner, with backoff; one whose
// action dies or never reports back is tried again when its lease runs out. Each step is passed the
// time it was scheduled for, and one whose time is no longer `stopNextAt` was superseded.

/** How long one stop try may take before the next starts: its provider calls have 15 s deadlines. */
const STOP_TRY_MS = 60_000;

/** Sets when the browser's next stop try runs, and schedules it. */
async function nextStopStep(ctx: MutationCtx, browserId: Id<"browsers">, at: number) {
  const stopCheckId = await ctx.scheduler.runAt(at, internal.browsers.stopStep, { browserId, at });
  await ctx.db.patch(browserId, { stopNextAt: at, stopCheckId });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * The longest a session the room started for this browser can run: its absolute timeout (the
 * longest session), plus its offline timeout as margin, plus a minute for a start the provider
 * finished after the room's call gave up at its deadline.
 */
const sessionLifetimeMs = (browser: Doc<"browsers">) => browser.longestMinutes * MINUTE + OFFLINE_SEC * 1000 + MINUTE;

/**
 * A start with saved logins ended without saying whether the provider made a session: its answer
 * was lost, or its action died. Called once provisioning has ended, so no session can be made
 * later than now. The browser stays stopping, holding its saved logins, until the room has found
 * any session started with its tag and ended it, or until such a session can't be running any more.
 */
async function beginRecovery(ctx: MutationCtx, browser: Doc<"browsers">, reason: string) {
  await ctx.db.patch(browser._id, {
    status: "stopping",
    endReason: browser.status === "stopping" ? (browser.endReason ?? "ended") : "failed",
    failReason: reason,
    recoverUntil: Date.now() + sessionLifetimeMs(browser),
    stopAttempts: 0,
  });
  await nextStopStep(ctx, browser._id, Date.now());
}

/** Starting, or ended while starting, and provisioning hasn't reported a session or a failure. */
const awaitsProvisioning = (b: Doc<"browsers">) =>
  b.status === "starting" || (b.status === "stopping" && !b.session && b.recoverUntil === undefined);

export const startUncertain = internalMutation({
  args: { browserId: v.id("browsers"), reason: v.string() },
  handler: async (ctx, { browserId, reason }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser || browser.session) return null;
    if (browser.status !== "starting" && browser.status !== "stopping") return null;
    await beginRecovery(ctx, browser, reason);
    return null;
  },
});

/** How often the provisioning watchdog looks at the provisioning job. */
const PROVISION_CHECK_MS = 60_000;

/**
 * Scheduled with provisioning, before it runs. While the provisioning job is pending or running
 * (Convex ends an action at 10 minutes), it checks again later. Once that job has ended without
 * reporting, its start was abandoned: with saved logins, the room recovers it as it does a lost
 * answer; a temporary browser fails, or ends if it was ended meanwhile.
 */
export const provisionWatchdog = internalMutation({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser || !awaitsProvisioning(browser)) return null;
    const job = browser.provisionJobId ? await ctx.db.system.get("_scheduled_functions", browser.provisionJobId) : null;
    if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) {
      await ctx.scheduler.runAfter(PROVISION_CHECK_MS, internal.browsers.provisionWatchdog, { browserId });
      return null;
    }
    const reason = "The start never finished at Hyperbeam.";
    console.error(`Provisioning shared browser ${browserId} ended without reporting (${job?.state.kind ?? "no job"}).`);
    if (browser.savedLoginId) await beginRecovery(ctx, browser, reason);
    else if (browser.status === "starting") await settleEnded(ctx, browser, "failed", { failReason: reason });
    else await settleEnded(ctx, browser, browser.endReason ?? "ended");
    return null;
  },
});

/** Starts the next stop try: ending the session, or finding one started with the browser's tag. */
export const stopStep = internalMutation({
  args: { browserId: v.id("browsers"), at: v.number() },
  handler: async (ctx, { browserId, at }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser || browser.status !== "stopping" || browser.stopNextAt !== at) return null;
    if (!browser.session && browser.recoverUntil === undefined) return null;
    if (!browser.session && Date.now() > browser.recoverUntil!) {
      console.error(`Couldn't confirm that shared browser ${browserId} left no session: ${browser.stopError ?? "no answer"}`);
      await settleEnded(ctx, browser, browser.endReason ?? "failed");
      return null;
    }
    await ctx.db.patch(browserId, { stopAttempts: (browser.stopAttempts ?? 0) + 1 });
    if (browser.session) await ctx.scheduler.runAfter(0, internal.browsers.stopAtProvider, { browserId });
    else await ctx.scheduler.runAfter(0, internal.browsers.recoverAtProvider, { browserId });
    // The watchdog: if this try never reports back, the next one starts then.
    await nextStopStep(ctx, browserId, Date.now() + STOP_TRY_MS);
    return null;
  },
});

/** Hyperbeam's DELETE. */
export const stopAtProvider = internalAction({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    const provider = browserProvider();
    if (!browser || browser.status !== "stopping" || !browser.session || !provider) return null;
    let gone = false;
    let error: string | undefined;
    try {
      await provider.end(browser.session.sessionId);
      gone = true;
    } catch (e) {
      // A DELETE can fail because the session already ended; ask before retrying.
      error = message(e);
      gone = await provider.hasEnded(browser.session.sessionId).catch((e2: unknown) => {
        error = `${error}; asking whether it ended: ${message(e2)}`;
        return false;
      });
    }
    await ctx.runMutation(internal.browsers.stopResult, { browserId, gone, ...(error && !gone ? { error } : {}) });
    return null;
  },
});

/** Ends any session the provider made for a start whose answer was lost, found by the browser's tag. */
export const recoverAtProvider = internalAction({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    if (!browser || browser.status !== "stopping" || browser.session) return null;
    let gone = false;
    let error: string | undefined;
    try {
      const provider = browserProvider();
      if (!provider) throw new Error(`Shared browsers aren't configured: ${PROVIDER_ENV_VAR} is not set.`);
      gone = await provider.endTagged({ tag: browserId, authWebhookUrl: `${siteUrl()}/hyperbeam/auth` });
      if (!gone) error = "Hyperbeam hasn't ended the session started with this browser's tag yet.";
    } catch (e) {
      error = message(e);
    }
    await ctx.runMutation(internal.browsers.stopResult, { browserId, gone, ...(error ? { error } : {}) });
    return null;
  },
});

/** What a stop try found. A failed one keeps why, and is tried again with backoff. */
export const stopResult = internalMutation({
  args: { browserId: v.id("browsers"), gone: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { browserId, gone, error }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser || browser.status !== "stopping") return null;
    if (gone) {
      await settleEnded(ctx, browser, browser.endReason ?? "ended");
      return null;
    }
    await ctx.db.patch(browserId, { stopError: error ?? "Hyperbeam hasn't confirmed the session is gone." });
    await nextStopStep(ctx, browserId, Date.now() + backoff((browser.stopAttempts ?? 1) - 1));
    return null;
  },
});

/**
 * Asks the provider whether a live browser still runs, so one that Hyperbeam
 * ended without a webhook reaching us stops holding a slot. It runs every
 * idle window, and at once when a start hits the team's limit.
 */
export const checkAlive = internalAction({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    const provider = browserProvider();
    if (!browser || browser.status !== "live" || !browser.session || !provider) return null;
    const ended = await provider.hasEnded(browser.session.sessionId).catch(() => false);
    await ctx.runMutation(internal.browsers.aliveResult, { browserId, ended });
    return null;
  },
});

export const aliveResult = internalMutation({
  args: { browserId: v.id("browsers"), ended: v.boolean() },
  handler: async (ctx, { browserId, ended }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser || browser.status !== "live") return null;
    if (ended) {
      await settleEnded(ctx, browser, "timed_out");
      return null;
    }
    await cancelJob(ctx, browser.aliveCheckId);
    const aliveCheckId = await ctx.scheduler.runAfter(aliveEvery(browser), internal.browsers.checkAlive, { browserId });
    await ctx.db.patch(browserId, { aliveCheckId, lastAliveCheckAt: Date.now() });
    return null;
  },
});

export const finish = internalMutation({
  args: {
    browserId: v.id("browsers"),
    reason: v.union(v.literal("idle"), v.literal("nobody_connected"), v.literal("longest_session")),
  },
  handler: async (ctx, { browserId, reason }) => {
    const browser = await ctx.db.get(browserId);
    if (browser) await settleEnded(ctx, browser, reason);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Who may control the browser
//
// Hyperbeam's addRoles is additive, so two control updates that overlap could
// leave two people with control. Updates are serialized per browser: every
// change bumps `controlVersion`, at most one sync runs at a time (a lease), and
// the sync re-runs until the version it applied is still the latest.

/** A sync that hasn't renewed its lease for this long is presumed dead. */
const SYNC_LEASE_MS = 60_000;

/** Call after anything that changes who may control a browser: the driver, a connection, a removal. */
async function requestControlSync(ctx: MutationCtx, browserId: Id<"browsers">) {
  const browser = await ctx.db.get(browserId);
  if (!browser || browser.status !== "live") return;
  const now = Date.now();
  const leaseFree = browser.controlSyncUntil === undefined || browser.controlSyncUntil < now;
  await ctx.db.patch(browser._id, {
    controlVersion: (browser.controlVersion ?? 0) + 1,
    ...(leaseFree ? { controlSyncUntil: now + SYNC_LEASE_MS } : {}),
  });
  if (leaseFree) await ctx.scheduler.runAfter(0, internal.browsers.syncControl, { browserId, attempt: 0 });
}

/** The driver's connections may control the browser; nobody else's. Agents have no connection. */
export const beginControlSync = internalMutation({
  args: { browserId: v.id("browsers") },
  handler: async (ctx, { browserId }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser) return null;
    if (browser.status !== "live" || !browser.session) {
      await ctx.db.patch(browserId, { controlSyncUntil: undefined });
      return null;
    }
    await ctx.db.patch(browserId, { controlSyncUntil: Date.now() + SYNC_LEASE_MS });
    const connections = await ctx.db
      .query("browserConnections")
      .withIndex("by_browser", (q) => q.eq("browserId", browserId))
      .collect();
    const controllers = connections.filter((c) => c.memberId === browser.driverId).map((c) => c.providerUserId);
    return { version: browser.controlVersion ?? 0, session: browser.session, controllers: [...new Set(controllers)] };
  },
});

/**
 * Ends a control sync. "again": something changed while it ran. "done": the
 * lease is released. "revoke": the browser began stopping while the sync ran,
 * so the roles it just added must come off again (the stop's own cut may have
 * run before them).
 */
export const endControlSync = internalMutation({
  args: { browserId: v.id("browsers"), version: v.number() },
  handler: async (ctx, { browserId, version }): Promise<"again" | "done" | "revoke"> => {
    const browser = await ctx.db.get(browserId);
    if (!browser) return "done";
    if (browser.status === "live" && (browser.controlVersion ?? 0) !== version) return "again";
    await ctx.db.patch(browserId, { controlSyncUntil: undefined });
    return browser.status === "stopping" ? "revoke" : "done";
  },
});

/** A provider error: keep the lease and try again with backoff while the browser is live. */
export const retryControlSync = internalMutation({
  args: { browserId: v.id("browsers"), attempt: v.number() },
  handler: async (ctx, { browserId, attempt }) => {
    const browser = await ctx.db.get(browserId);
    if (!browser || browser.status !== "live") {
      if (browser) await ctx.db.patch(browserId, { controlSyncUntil: undefined });
      return null;
    }
    const delay = backoff(attempt);
    await ctx.db.patch(browserId, { controlSyncUntil: Date.now() + delay + SYNC_LEASE_MS });
    await ctx.scheduler.runAfter(delay, internal.browsers.syncControl, { browserId, attempt: attempt + 1 });
    return null;
  },
});

export const syncControl = internalAction({
  args: { browserId: v.id("browsers"), attempt: v.number() },
  handler: async (ctx, { browserId, attempt }) => {
    const provider = browserProvider();
    for (;;) {
      const state = await ctx.runMutation(internal.browsers.beginControlSync, { browserId });
      if (!state || !provider) return null;
      try {
        await provider.setControl(state.session, state.controllers);
      } catch {
        await ctx.runMutation(internal.browsers.retryControlSync, { browserId, attempt });
        return null;
      }
      const next = await ctx.runMutation(internal.browsers.endControlSync, { browserId, version: state.version });
      if (next === "revoke") {
        // This update's adds came after the stop began: take every role away again, after them.
        await provider.setControl(state.session, []).catch(() => {});
        return null;
      }
      if (next === "done") return null;
    }
  },
});

/** The first person still in a private channel's member list, by when they were added, to take its browser's wheel. */
async function remainingPerson(ctx: QueryCtx, browser: Doc<"browsers">, leaving: Set<Id<"members">>) {
  const rows = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", browser.channelId))
    .collect();
  for (const row of rows.sort((a, b) => a.addedAt - b.addedAt)) {
    if (leaving.has(row.memberId)) continue;
    const member = await ctx.db.get(row.memberId);
    if (member && member.kind === "person" && member.removedAt === undefined) return member._id;
  }
  return null;
}

/** Whether a member can still be in a browser: still in its channel (a private channel's members change). */
async function inBrowserChannel(ctx: QueryCtx, browser: Doc<"browsers">, memberId: Id<"members">) {
  const channel = await ctx.db.get(browser.channelId);
  return channel !== null && (await memberCanSee(ctx, channel, memberId));
}

/**
 * A stop began: takes every control role away and disconnects everyone who
 * was connected, at the same time, so neither waits on the other. Each call
 * has a deadline, and whichever fails is retried with backoff while the
 * browser is stopping: disconnects through `disconnect`, roles through
 * `removeRolesAtStop`.
 */
export const cutAtStop = internalAction({
  args: { browserId: v.id("browsers"), providerUserIds: v.array(v.string()) },
  handler: async (ctx, { browserId, providerUserIds }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    const provider = browserProvider();
    if (!browser?.session || browser.status !== "stopping" || !provider) return null;
    const [roles, users] = await Promise.allSettled([
      provider.setControl(browser.session, []),
      providerUserIds.length > 0 ? provider.disconnect(browser.session, providerUserIds) : Promise.resolve(),
    ]);
    if (roles.status === "rejected") {
      await ctx.scheduler.runAfter(backoff(0), internal.browsers.removeRolesAtStop, { browserId, attempt: 1 });
    }
    if (users.status === "rejected") {
      await ctx.scheduler.runAfter(backoff(0), internal.browsers.disconnect, { browserId, providerUserIds, attempt: 1 });
    }
    return null;
  },
});

/** Retries taking every control role away from a stopping browser, with backoff. */
export const removeRolesAtStop = internalAction({
  args: { browserId: v.id("browsers"), attempt: v.number() },
  handler: async (ctx, { browserId, attempt }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    const provider = browserProvider();
    if (!browser?.session || browser.status !== "stopping" || !provider) return null;
    try {
      await provider.setControl(browser.session, []);
    } catch {
      if (attempt < 6) {
        await ctx.scheduler.runAfter(backoff(attempt), internal.browsers.removeRolesAtStop, {
          browserId,
          attempt: attempt + 1,
        });
      }
    }
    return null;
  },
});

/**
 * Takes a member's access to the team's shared browsers away: their unused
 * tickets stop working (admission rechecks them), their connections are cut
 * at the provider, and any browser they drive goes back to whoever started
 * it (or to `fallback`, when that person is gone too). With `channelId`, only
 * that channel's browsers: they left a private channel or were removed from it.
 */
export async function revokeBrowserAccess(
  ctx: MutationCtx,
  actor: Actor,
  who: { memberIds?: Id<"members">[]; agentKeyId?: Id<"agentKeys">; channelId?: Id<"channels"> },
) {
  const memberIds = new Set(who.memberIds ?? []);
  // A revoked key doesn't remove its agent, but an agent with no other working key that has
  // the scope can't drive, so it loses the wheel too.
  let keylessAgent: Id<"members"> | undefined;
  if (who.agentKeyId) {
    const key = await ctx.db.get(who.agentKeyId);
    if (key && !(await hasUsableBrowserKey(ctx, key.agentId))) {
      const agentMember = await ctx.db
        .query("members")
        .withIndex("by_agent", (q) => q.eq("agentId", key.agentId))
        .unique();
      keylessAgent = agentMember?._id;
    }
  }
  const browsers = who.channelId
    ? await ctx.db
        .query("browsers")
        .withIndex("by_channel", (q) => q.eq("channelId", who.channelId!))
        .collect()
    : await teamBrowsers(ctx, actor.teamId);
  for (const browser of browsers) {
    // Stopping browsers too: until the provider confirms the session is gone, its connections still work.
    if (!holdsSlot(browser)) continue;
    const connections = await ctx.db
      .query("browserConnections")
      .withIndex("by_browser", (q) => q.eq("browserId", browser._id))
      .collect();
    const cut = connections.filter(
      (c) => memberIds.has(c.memberId) || (who.agentKeyId !== undefined && c.agentKeyId === who.agentKeyId),
    );
    for (const c of cut) await ctx.db.delete(c._id);
    if (cut.length > 0) {
      await ctx.scheduler.runAfter(0, internal.browsers.disconnect, {
        browserId: browser._id,
        providerUserIds: cut.map((c) => c.providerUserId),
        attempt: 0,
      });
    }
    const driverGone = memberIds.has(browser.driverId) || browser.driverId === keylessAgent;
    if (driverGone && isLive(browser)) {
      const starter = await ctx.db.get(browser.startedBy);
      const starterOk =
        starter &&
        starter.removedAt === undefined &&
        !memberIds.has(starter._id) &&
        starter._id !== keylessAgent &&
        (await inBrowserChannel(ctx, browser, starter._id));
      // The wheel never goes to someone outside the browser's channel (a private channel they
      // aren't in, or one they are leaving). In a private channel it goes to someone still in it;
      // with nobody left who could drive, the browser stops, so it doesn't hold a slot unusable.
      const actorOk = !memberIds.has(actor.member._id) && (await inBrowserChannel(ctx, browser, actor.member._id));
      // Decided by the browser's own channel, not by who.channelId: an admin outside a private
      // channel who removes its driver from the team still leaves it to someone in the channel.
      const channel = await ctx.db.get(browser.channelId);
      const restricted = !!channel && hasMemberList(channel);
      const remaining = restricted && !starterOk && !actorOk ? await remainingPerson(ctx, browser, memberIds) : null;
      const next = starterOk ? starter._id : actorOk ? actor.member._id : remaining;
      if (next && next !== browser.driverId) {
        await ctx.db.patch(browser._id, { driverId: next });
        await audit(ctx, actor, "browser.driver_changed", browser._id, { from: browser.driverId, to: next });
      } else if (!next && restricted) {
        await beginStop(ctx, browser, "ended", { endedBy: actor.member._id });
        await audit(ctx, actor, "browser.ended", browser._id, { channelId: browser.channelId });
        continue;
      }
    }
    if (cut.length > 0 || driverGone) await requestControlSync(ctx, browser._id);
  }
}

/** True when the agent still has an unrevoked key with the shared-browser scope. */
async function hasUsableBrowserKey(ctx: QueryCtx, agentId: Id<"agents">) {
  return (await activeAgentKeys(ctx, agentId)).some((k) => k.scopes.includes("browsers.use"));
}

export const disconnect = internalAction({
  args: { browserId: v.id("browsers"), providerUserIds: v.array(v.string()), attempt: v.number() },
  handler: async (ctx, { browserId, providerUserIds, attempt }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    const provider = browserProvider();
    // Stopping too: the session may outlive a failed DELETE, and these connections must not.
    if (!browser?.session || (browser.status !== "live" && browser.status !== "stopping") || !provider) return null;
    try {
      await provider.disconnect(browser.session, providerUserIds);
    } catch {
      if (attempt < 6) {
        await ctx.scheduler.runAfter(backoff(attempt), internal.browsers.disconnect, {
          browserId,
          providerUserIds,
          attempt: attempt + 1,
        });
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Opening URLs
//
// Every navigation of a browser (its start URL, openUrl, an opened suggestion) goes through one
// ordered path (#77). A request records its URL as the latest and bumps `navigationSeq`. At most
// one navigation runs at the provider at a time, under a lease on the browser row, and it runs
// again until the URL it opened is still the latest. So a later request always ends as the open
// page, even when an earlier one's provider call returns after it was made.
//
// The lease is renewed before the provider call and again right before the call that changes the
// page (the fence), so a navigation whose lease has passed on changes nothing. If one changed the
// page anyway (the change was already sent), the latest URL is opened again after it. A call that
// fails is tried again with backoff, up to NAVIGATION_TRIES, and the browser keeps why it gave up.

/**
 * How long a navigation holds the lease without renewing it. Longer than one call takes
 * (Hyperbeam's openUrl is two calls with a 10 s deadline each). A navigation that stops renewing
 * (its action died) loses the lease when it runs out, and `watchNavigation` hands it on, so a
 * stuck call can't hold up later ones for longer than this.
 */
const NAVIGATION_LEASE_MS = 60_000;
/** Tries at one URL before the room gives up on it: the first, then after 2 s and 4 s. */
const NAVIGATION_TRIES = 3;
const navigationRetryMs = (failures: number) => 1_000 * 2 ** failures;

/**
 * Opens `url` in a live browser, after every navigation asked for before it. `fromOldJob`: the
 * request came from a `navigate` job queued before #77, which later such jobs may still follow.
 */
async function requestNavigation(ctx: MutationCtx, browserId: Id<"browsers">, url: string, fromOldJob = false) {
  const browser = await ctx.db.get(browserId);
  if (!browser) return;
  const now = Date.now();
  const lease = browser.navigationLease;
  const navigationSeq = (browser.navigationSeq ?? 0) + 1;
  await ctx.db.patch(browserId, { navigationSeq, navigationUrl: url, navigationFromOldJob: fromOldJob || undefined });
  // A navigation running opens this URL when its provider call returns.
  if (lease?.until !== undefined && lease.until > now) return;
  await takeNavigationLease(ctx, browserId, (lease?.holder ?? 0) + 1);
}

/** Gives the lease to navigation `holder`, starts it, and watches that it keeps renewing the lease. */
async function takeNavigationLease(ctx: MutationCtx, browserId: Id<"browsers">, holder: number) {
  const until = Date.now() + NAVIGATION_LEASE_MS;
  await ctx.db.patch(browserId, { navigationLease: { holder, until } });
  await ctx.scheduler.runAfter(0, internal.browsers.navigate, { browserId, holder });
  await ctx.scheduler.runAt(until, internal.browsers.watchNavigation, { browserId, holder });
}

/** Renews navigation `holder`'s lease and says which URL to open, or null if it no longer holds it. */
export const beginNavigation = internalMutation({
  args: { browserId: v.id("browsers"), holder: v.number() },
  handler: async (ctx, { browserId, holder }) => {
    const browser = await ctx.db.get(browserId);
    const lease = browser?.navigationLease;
    if (!browser || lease?.holder !== holder || lease.until === undefined) return null;
    if (browser.status !== "live" || !browser.session || browser.navigationUrl === undefined) {
      await ctx.db.patch(browserId, { navigationLease: { holder } });
      return null;
    }
    await ctx.db.patch(browserId, { navigationLease: { holder, until: Date.now() + NAVIGATION_LEASE_MS } });
    return { seq: browser.navigationSeq ?? 0, url: browser.navigationUrl, session: browser.session };
  },
});

/**
 * The fence right before the call that changes the page: true, renewing the lease, while
 * navigation `holder` holds it. A lease that ran out but wasn't handed on yet is still its own,
 * so it takes it back. False once the lease has passed on or the browser stopped.
 */
export const holdsNavigation = internalMutation({
  args: { browserId: v.id("browsers"), holder: v.number() },
  handler: async (ctx, { browserId, holder }) => {
    const browser = await ctx.db.get(browserId);
    const lease = browser?.navigationLease;
    if (!browser || browser.status !== "live" || lease?.holder !== holder || lease.until === undefined) return false;
    await ctx.db.patch(browserId, { navigationLease: { holder, until: Date.now() + NAVIGATION_LEASE_MS } });
    return true;
  },
});

/**
 * After navigation `holder` tried request `seq`. "again": a later request came meanwhile, so it
 * runs again. "retry": the call failed and is tried again with backoff. "done": it released the
 * lease, or no longer held it.
 */
export const endNavigation = internalMutation({
  args: {
    browserId: v.id("browsers"),
    holder: v.number(),
    seq: v.number(),
    /** The call got past the fence, so the page may have changed. */
    changed: v.boolean(),
    /** The fence refused the change: nothing was opened. */
    refused: v.optional(v.boolean()),
    error: v.optional(v.string()),
    /** Failed tries at this request before this one. */
    failures: v.number(),
  },
  handler: async (ctx, args): Promise<"again" | "retry" | "done"> => {
    const browser = await ctx.db.get(args.browserId);
    if (!browser) return "done";
    const lease = browser.navigationLease;
    if (lease?.holder !== args.holder || lease.until === undefined) {
      // Its lease passed on. If its call changed the page anyway, that may have landed after the
      // newer navigation's, so the latest URL is opened again.
      if (args.changed && browser.status === "live" && browser.navigationUrl !== undefined) {
        await requestNavigation(ctx, browser._id, browser.navigationUrl);
      }
      return "done";
    }
    if (browser.status === "live" && (browser.navigationSeq ?? 0) !== args.seq) return "again";
    // Refused while it still holds the lease and the browser is live: nothing opened, so try again.
    if (args.refused && browser.status === "live") return "again";
    if (args.error !== undefined && browser.status === "live") {
      const failures = args.failures + 1;
      if (failures < NAVIGATION_TRIES) {
        const delay = navigationRetryMs(failures);
        await ctx.db.patch(browser._id, { navigationLease: { holder: args.holder, until: Date.now() + delay + NAVIGATION_LEASE_MS } });
        // The count belongs to this request: if a later one comes during the wait, it starts afresh.
        await ctx.scheduler.runAfter(delay, internal.browsers.navigate, {
          browserId: browser._id,
          holder: args.holder,
          failures,
          failedSeq: args.seq,
        });
        return "retry";
      }
      console.error(`Couldn't open ${browser.navigationUrl} in shared browser ${browser._id} after ${failures} tries: ${args.error}`);
      await ctx.db.patch(browser._id, {
        navigationLease: { holder: args.holder },
        navigationError: { url: browser.navigationUrl ?? "", message: args.error, at: Date.now() },
      });
      return "done";
    }
    await ctx.db.patch(browser._id, {
      navigationLease: { holder: args.holder },
      ...(args.error === undefined && !args.refused ? { navigationError: undefined } : {}),
    });
    return "done";
  },
});

/**
 * Checks, when navigation `holder`'s lease runs out, that it renewed it. If it didn't, its action
 * died: the lease goes to a new navigation, which opens the latest URL.
 */
export const watchNavigation = internalMutation({
  args: { browserId: v.id("browsers"), holder: v.number() },
  handler: async (ctx, { browserId, holder }) => {
    const browser = await ctx.db.get(browserId);
    const lease = browser?.navigationLease;
    // Released, or already handed on.
    if (!browser || lease?.holder !== holder || lease.until === undefined) return null;
    if (browser.status !== "live") {
      await ctx.db.patch(browserId, { navigationLease: { holder } });
      return null;
    }
    if (lease.until > Date.now()) {
      await ctx.scheduler.runAt(lease.until, internal.browsers.watchNavigation, { browserId, holder });
      return null;
    }
    await takeNavigationLease(ctx, browserId, holder + 1);
    return null;
  },
});

/**
 * A `navigate` job queued by the code before #77, which carried its URL (and, for a deferred
 * start URL, the count it was scheduled at): routed through the ordered path, keeping that guard.
 */
export const navigateQueuedBeforeOrdering = internalMutation({
  args: { browserId: v.id("browsers"), url: v.string(), unlessOpenedSince: v.optional(v.number()) },
  handler: async (ctx, { browserId, url, unlessOpenedSince }) => {
    const browser = await ctx.db.get(browserId);
    if (browser?.status !== "live" || !browser.session) return null;
    // A request made since the deploy came after this job was queued, so it is newer. One migrated
    // from an older job isn't: jobs run in the order they were queued, so this one follows it.
    if (browser.navigationUrl !== undefined && !browser.navigationFromOldJob) return null;
    // A deferred start URL is skipped if a URL was opened through the Room API since it was scheduled.
    if (unlessOpenedSince !== undefined && (browser.navigationSeq ?? 0) !== unlessOpenedSince) return null;
    await requestNavigation(ctx, browserId, url, true);
    return null;
  },
});

export const navigate = internalAction({
  args: {
    browserId: v.id("browsers"),
    holder: v.optional(v.number()),
    /** Failed tries at request `failedSeq`; a retry that finds a later request starts its count afresh. */
    failures: v.optional(v.number()),
    failedSeq: v.optional(v.number()),
    /** Only in jobs queued before #77: the URL itself, and a deferred start URL's guard. */
    url: v.optional(v.string()),
    unlessOpenedSince: v.optional(v.number()),
  },
  handler: async (ctx, { browserId, holder, failures = 0, failedSeq, url, unlessOpenedSince }) => {
    if (holder === undefined) {
      if (url !== undefined) {
        await ctx.runMutation(internal.browsers.navigateQueuedBeforeOrdering, {
          browserId,
          url,
          ...(unlessOpenedSince !== undefined ? { unlessOpenedSince } : {}),
        });
      }
      return null;
    }
    const provider = browserProvider();
    for (;;) {
      const next = await ctx.runMutation(internal.browsers.beginNavigation, { browserId, holder });
      if (!next) return null;
      if (failedSeq !== undefined && next.seq !== failedSeq) failures = 0;
      let changed = false;
      let refused = false;
      let error: string | undefined;
      if (provider) {
        try {
          const outcome = await provider.openUrl(next.session, next.url, async () => {
            changed = await ctx.runMutation(internal.browsers.holdsNavigation, { browserId, holder });
            return changed;
          });
          refused = outcome === "refused";
        } catch (e) {
          error = message(e);
        }
      }
      const result = await ctx.runMutation(internal.browsers.endNavigation, {
        browserId,
        holder,
        seq: next.seq,
        changed,
        failures,
        ...(refused ? { refused } : {}),
        ...(error !== undefined ? { error } : {}),
      });
      if (result !== "again") return null;
      failures = 0;
      failedSeq = undefined;
    }
  },
});

// ---------------------------------------------------------------------------
// Webhooks from Hyperbeam (routed in http.ts)

async function browserForSecret(ctx: QueryCtx, secretHash: string) {
  return ctx.db
    .query("browsers")
    .withIndex("by_webhook_secret", (q) => q.eq("webhookSecretHash", secretHash))
    .unique();
}

/**
 * The ticket's member is still in the browser's team and its channel (a private channel's members
 * change, ADR 0016), a person still has an account, and an agent still has a working key with the
 * scope and a person who answers for it.
 */
async function stillMayJoin(ctx: QueryCtx, browser: Doc<"browsers">, ticket: Doc<"browserTickets">) {
  const member = await ctx.db.get(ticket.memberId);
  if (!member || member.teamId !== browser.teamId || member.removedAt !== undefined) return false;
  if (!(await inBrowserChannel(ctx, browser, member._id))) return false;
  // A deleted account leaves its teams in steps after it is marked deleted (ADR 0035); a ticket it
  // got before then admits nobody.
  if (member.kind === "person" && (await accountDeleted(ctx, member._id))) return false;
  if (member.kind === "agent") {
    const agent = member.agentId ? await ctx.db.get(member.agentId) : null;
    const accountable = agent ? await ctx.db.get(agent.addedBy) : null;
    if (!(await accountableStands(ctx, accountable))) return false;
  }
  if (ticket.agentKeyId) {
    const key = await ctx.db.get(ticket.agentKeyId);
    if (!key || key.revokedAt !== undefined || !key.scopes.includes("browsers.use")) return false;
    // A key narrowed to some channels since the ticket was made (ADR 0049) joins only there.
    if (key.channelIds && !key.channelIds.includes(browser.channelId)) return false;
  }
  return true;
}

/**
 * Hyperbeam asks whether a new connection may join. Yes only for a live
 * browser, with an unused, unexpired ticket made for it. Then the backend
 * knows which member that connection is, and syncs control.
 */
export const admit = internalMutation({
  args: { secretHash: v.string(), providerUserId: v.string(), ticket: v.string() },
  handler: async (ctx, args): Promise<"unknown" | "denied" | "admitted"> => {
    const browser = await browserForSecret(ctx, args.secretHash);
    if (!browser) return "unknown";
    if (browser.status !== "live" || !args.ticket || !args.providerUserId) return "denied";
    const ticket = await ctx.db
      .query("browserTickets")
      .withIndex("by_hash", (q) => q.eq("ticketHash", args.ticket))
      .unique();
    // The ticket arrives hashed by the http action, so it never sits in a log in the clear.
    if (!ticket || ticket.browserId !== browser._id || ticket.usedAt !== undefined || ticket.expiresAt <= Date.now()) {
      return "denied";
    }
    await ctx.db.patch(ticket._id, { usedAt: Date.now() });
    // Whoever the ticket was made for may have lost access since: left the team, or had the key revoked.
    if (!(await stillMayJoin(ctx, browser, ticket))) return "denied";
    await ctx.db.insert("browserConnections", {
      browserId: browser._id,
      memberId: ticket.memberId,
      ...(ticket.agentKeyId ? { agentKeyId: ticket.agentKeyId } : {}),
      providerUserId: args.providerUserId,
      joinedAt: Date.now(),
    });
    await requestControlSync(ctx, browser._id);
    return "admitted";
  },
});

/**
 * Hyperbeam calls the timeout webhook when a timeout fires, and also to warn
 * before one does, so the room asks Hyperbeam whether the session really ended.
 */
export const timeoutReported = internalMutation({
  args: { secretHash: v.string(), type: v.string() },
  handler: async (ctx, args) => {
    const browser = await browserForSecret(ctx, args.secretHash);
    if (!browser) return false;
    if (browser.status === "live" || browser.status === "stopping") {
      await ctx.scheduler.runAfter(0, internal.browsers.confirmTimeout, { browserId: browser._id, type: args.type });
    }
    return true;
  },
});

const TIMEOUT_REASONS: Record<string, "idle" | "nobody_connected" | "longest_session"> = {
  inactive: "idle",
  offline: "nobody_connected",
  absolute: "longest_session",
};

export const confirmTimeout = internalAction({
  args: { browserId: v.id("browsers"), type: v.string() },
  handler: async (ctx, { browserId, type }) => {
    const browser = await ctx.runQuery(internal.browsers.forProvider, { browserId });
    const provider = browserProvider();
    if (!browser?.session || (browser.status !== "live" && browser.status !== "stopping") || !provider) return null;
    if (!(await provider.hasEnded(browser.session.sessionId))) return null;
    await ctx.runMutation(internal.browsers.finish, { browserId, reason: TIMEOUT_REASONS[type] ?? "idle" });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Joining and watching

async function liveBrowser(ctx: QueryCtx, actor: Actor, browserId: Id<"browsers">) {
  const browser = await inTeam(ctx, actor, browserId);
  if (!isLive(browser)) throw roomError("invalid", "This shared browser has ended.");
  return browser;
}

async function touchWatcher(ctx: MutationCtx, browserId: Id<"browsers">, memberId: Id<"members">) {
  const existing = await ctx.db
    .query("browserWatchers")
    .withIndex("by_browser_member", (q) => q.eq("browserId", browserId).eq("memberId", memberId))
    .unique();
  const now = Date.now();
  if (existing) await ctx.db.patch(existing._id, { lastSeenAt: now });
  const watcherId = existing?._id ?? (await ctx.db.insert("browserWatchers", { browserId, memberId, lastSeenAt: now }));
  const job = existing?.checkId ? await ctx.db.system.get("_scheduled_functions", existing.checkId) : null;
  if (!job || (job.state.kind !== "pending" && job.state.kind !== "inProgress")) {
    const checkId = await ctx.scheduler.runAt(now + WATCH_WINDOW_MS, internal.browsers.checkWatcher, { watcherId });
    await ctx.db.patch(watcherId, { checkId });
  }
}

/** Drops a watcher whose window passed with no `watch`, so subscribed views stop listing them. */
export const checkWatcher = internalMutation({
  args: { watcherId: v.id("browserWatchers") },
  handler: async (ctx, { watcherId }) => {
    const watcher = await ctx.db.get(watcherId);
    if (!watcher) return null;
    if (Date.now() - watcher.lastSeenAt >= WATCH_WINDOW_MS) {
      await ctx.db.delete(watcher._id);
    } else {
      const checkId = await ctx.scheduler.runAt(watcher.lastSeenAt + WATCH_WINDOW_MS, internal.browsers.checkWatcher, {
        watcherId,
      });
      await ctx.db.patch(watcher._id, { checkId });
    }
    return null;
  },
});

export const { person: join, agent: joinAgent } = roomMutation({
  name: "browsers.join",
  description:
    "Join a live shared browser: returns its embed URL and a one-time ticket (valid two minutes) to pass to Hyperbeam's web SDK as `webhookUserdata: { ticket }`. You watch until you're the driver.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    if (browser.status !== "live" || !browser.session) {
      throw roomError("conflict", "This shared browser is still starting. Try again in a moment.");
    }
    const ticket = randomSecret("hbt", 24);
    const expiresAt = Date.now() + TICKET_MS;
    await ctx.db.insert("browserTickets", {
      browserId: browser._id,
      memberId: actor.member._id,
      ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
      ticketHash: await sha256(ticket),
      expiresAt,
    });
    await touchWatcher(ctx, browser._id, actor.member._id);
    return { embedUrl: browser.session.embedUrl, ticket, expiresAt };
  },
});

export const { person: watch, agent: watchAgent } = roomMutation({
  name: "browsers.watch",
  description: "Say you're watching a shared browser. Call it every ~15 seconds while it's open.",
  scope: "room.read",
  agentAudit: false,
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    await touchWatcher(ctx, browser._id, actor.member._id);
    return null;
  },
});

export const { person: leave, agent: leaveAgent } = roomMutation({
  name: "browsers.leave",
  description: "Say you've closed a shared browser, so you drop off its watching list at once.",
  scope: "room.read",
  agentAudit: false,
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await inTeam(ctx, actor, args.browserId);
    const existing = await ctx.db
      .query("browserWatchers")
      .withIndex("by_browser_member", (q) => q.eq("browserId", browser._id).eq("memberId", actor.member._id))
      .unique();
    if (existing) {
      if (existing.checkId) await ctx.scheduler.cancel(existing.checkId);
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Access, the driver and the wheel: the same rules as terminals

function isDriver(actor: Actor, browser: Doc<"browsers">) {
  return browser.driverId === actor.member._id;
}

function requireDriver(actor: Actor, browser: Doc<"browsers">) {
  if (!isDriver(actor, browser)) {
    throw roomError("forbidden", "Only the browser's driver can do this. Ask for the wheel first.");
  }
}

function requireAtLeast(browser: Doc<"browsers">, access: "suggest" | "drive", what: string) {
  if (accessRank(browser.access) < accessRank(access)) {
    throw roomError("forbidden", `This browser is set to ${browser.access}, so teammates can't ${what}.`);
  }
}

async function setDriver(ctx: MutationCtx, actor: Actor, browser: Doc<"browsers">, memberId: Id<"members">) {
  const member = await teamMember(ctx, actor, memberId);
  await ctx.db.patch(browser._id, { driverId: member._id });
  const requests = await ctx.db
    .query("browserWheelRequests")
    .withIndex("by_browser", (q) => q.eq("browserId", browser._id))
    .collect();
  for (const r of requests) {
    if (r.status === "pending" && r.fromId === member._id) {
      await ctx.db.patch(r._id, { status: "granted", answeredBy: actor.member._id });
    }
  }
  await requestControlSync(ctx, browser._id);
  await audit(ctx, actor, "browser.driver_changed", browser._id, { from: browser.driverId, to: member._id });
}

/** Sets a browser's access, recording what it was if a limit lowered it. */
async function applyAccess(
  ctx: MutationCtx,
  actor: Actor,
  browser: Doc<"browsers">,
  access: Access,
  loweredFrom?: Access,
) {
  await ctx.db.patch(browser._id, { access, loweredFrom });
  await cancelPending(ctx, browser._id, access);
  // Below Drive only whoever started the browser drives, so the wheel goes back to them.
  if (accessRank(access) < accessRank("drive") && browser.driverId !== browser.startedBy) {
    const starter = await ctx.db.get(browser.startedBy);
    if (starter && starter.removedAt === undefined && (await inBrowserChannel(ctx, browser, starter._id))) {
      await ctx.db.patch(browser._id, { driverId: starter._id });
      await requestControlSync(ctx, browser._id);
      await audit(ctx, actor, "browser.driver_changed", browser._id, { from: browser.driverId, to: starter._id });
    }
  }
}

export const { person: setAccess, agent: setAccessAgent } = roomMutation({
  name: "browsers.setAccess",
  description:
    "Set a shared browser's access: watch, suggest, drive or open, up to the team's limit. Whoever started it picks the level; an admin can lower it.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers"), access: vAccess },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    const limits = await settingsFor(ctx, actor.teamId);
    if (accessRank(args.access) > accessRank(limits.mostOpenAccess)) {
      throw roomError("invalid", `Shared browsers in this team allow at most ${limits.mostOpenAccess}.`);
    }
    const lowering = accessRank(args.access) <= accessRank(browser.access);
    if (!actsFor(actor, browser.startedBy) && !(lowering && actor.role === "admin")) {
      throw roomError("forbidden", "Only whoever started this browser can change its access; an admin can lower it.");
    }
    await applyAccess(ctx, actor, browser, args.access);
    await audit(ctx, actor, "browser.access_changed", browser._id, { from: browser.access, to: args.access });
    return null;
  },
});

export const { person: openUrl, agent: openUrlAgent } = roomMutation({
  name: "browsers.openUrl",
  description: "As the driver, load an http or https URL in the shared browser's active tab. This is how an agent drives.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers"), url: v.string() },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    requireDriver(actor, browser);
    const url = webUrl(args.url);
    if (browser.status !== "live") throw roomError("conflict", "This shared browser is still starting.");
    await requestNavigation(ctx, browser._id, url);
    return null;
  },
});

export const { person: suggestUrl, agent: suggestUrlAgent } = roomMutation({
  name: "browsers.suggestUrl",
  description: "Suggest a URL on a Suggest (or more open) shared browser. It loads only if the driver opens it.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers"), url: v.string() },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    if (!isDriver(actor, browser)) requireAtLeast(browser, "suggest", "suggest URLs");
    return await ctx.db.insert("browserSuggestions", {
      browserId: browser._id,
      fromId: actor.member._id,
      url: webUrl(args.url),
      status: "pending",
    });
  },
});

export const { person: suggestions, agent: suggestionsAgent } = roomQuery({
  name: "browsers.suggestions",
  description: "A shared browser's pending suggested URLs.",
  scope: "room.read",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await inTeam(ctx, actor, args.browserId);
    const rows = await ctx.db
      .query("browserSuggestions")
      .withIndex("by_browser", (q) => q.eq("browserId", browser._id))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.status === "pending")
        .map(async (r) => ({ suggestionId: r._id, url: r.url, from: await memberView(ctx, r.fromId) })),
    );
  },
});

async function pendingSuggestion(ctx: QueryCtx, actor: Actor, suggestionId: Id<"browserSuggestions">) {
  const suggestion = await ctx.db.get(suggestionId);
  if (!suggestion) throw roomError("not_found", "No such suggestion.");
  const browser = await liveBrowser(ctx, actor, suggestion.browserId);
  requireDriver(actor, browser);
  if (suggestion.status !== "pending") throw roomError("conflict", "This suggestion was already answered.");
  return { suggestion, browser };
}

export const { person: openSuggestion, agent: openSuggestionAgent } = roomMutation({
  name: "browsers.openSuggestion",
  description: "As the driver, open a suggested URL in the shared browser.",
  scope: "browsers.use",
  args: { suggestionId: v.id("browserSuggestions") },
  handler: async (ctx, actor, args) => {
    const { suggestion, browser } = await pendingSuggestion(ctx, actor, args.suggestionId);
    if (browser.status !== "live") throw roomError("conflict", "This shared browser is still starting.");
    await ctx.db.patch(suggestion._id, { status: "opened", answeredBy: actor.member._id });
    await requestNavigation(ctx, browser._id, suggestion.url);
    return null;
  },
});

export const { person: dismissSuggestion, agent: dismissSuggestionAgent } = roomMutation({
  name: "browsers.dismissSuggestion",
  description: "As the driver, dismiss a suggested URL.",
  scope: "browsers.use",
  args: { suggestionId: v.id("browserSuggestions") },
  handler: async (ctx, actor, args) => {
    const { suggestion } = await pendingSuggestion(ctx, actor, args.suggestionId);
    await ctx.db.patch(suggestion._id, { status: "dismissed", answeredBy: actor.member._id });
    return null;
  },
});

export const { person: requestWheel, agent: requestWheelAgent } = roomMutation({
  name: "browsers.requestWheel",
  description: "Ask the driver of a Drive (or Open) shared browser for the wheel.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    if (isDriver(actor, browser)) throw roomError("conflict", "You already drive this browser.");
    requireAtLeast(browser, "drive", "ask for the wheel");
    return await ctx.db.insert("browserWheelRequests", { browserId: browser._id, fromId: actor.member._id, status: "pending" });
  },
});

export const { person: wheelRequests, agent: wheelRequestsAgent } = roomQuery({
  name: "browsers.wheelRequests",
  description: "Pending requests for a shared browser's wheel.",
  scope: "room.read",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await inTeam(ctx, actor, args.browserId);
    const rows = await ctx.db
      .query("browserWheelRequests")
      .withIndex("by_browser", (q) => q.eq("browserId", browser._id))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.status === "pending")
        .map(async (r) => ({ requestId: r._id, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: answerWheelRequest, agent: answerWheelRequestAgent } = roomMutation({
  name: "browsers.answerWheelRequest",
  description: "As the driver, hand the wheel to whoever asked (grant: true) or say no.",
  scope: "browsers.use",
  args: { requestId: v.id("browserWheelRequests"), grant: v.boolean() },
  handler: async (ctx, actor, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw roomError("not_found", "No such request.");
    const browser = await liveBrowser(ctx, actor, request.browserId);
    requireDriver(actor, browser);
    if (request.status !== "pending") throw roomError("conflict", "This request was already answered.");
    if (args.grant) {
      requireAtLeast(browser, "drive", "be handed the wheel");
      await setDriver(ctx, actor, browser, request.fromId);
    } else {
      await ctx.db.patch(request._id, { status: "denied", answeredBy: actor.member._id });
    }
    return null;
  },
});

export const { person: takeWheel, agent: takeWheelAgent } = roomMutation({
  name: "browsers.takeWheel",
  description:
    "Take the wheel of an Open shared browser at once. On a Drive browser, ask for it instead. On Watch and Suggest browsers only whoever started it can take it back.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers") },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    if (isDriver(actor, browser)) return null;
    if (browser.access === "drive") {
      throw roomError("forbidden", "This browser is set to drive: ask the driver for the wheel.");
    }
    if (browser.access !== "open" && actor.member._id !== browser.startedBy) {
      throw roomError(
        "forbidden",
        `This browser is set to ${browser.access}, so only whoever started it can take the wheel.`,
      );
    }
    await setDriver(ctx, actor, browser, actor.member._id);
    return null;
  },
});

export const { person: passWheel, agent: passWheelAgent } = roomMutation({
  name: "browsers.passWheel",
  description:
    "As the driver, pass the wheel of a shared browser to a teammate or an agent. On Watch and Suggest browsers the wheel can only go back to whoever started it.",
  scope: "browsers.use",
  args: { browserId: v.id("browsers"), to: v.id("members") },
  handler: async (ctx, actor, args) => {
    const browser = await liveBrowser(ctx, actor, args.browserId);
    if (!isDriver(actor, browser) && !actsFor(actor, browser.startedBy)) {
      throw roomError("forbidden", "Only the driver, or whoever started the browser, can pass the wheel.");
    }
    if (args.to !== browser.startedBy) requireAtLeast(browser, "drive", "be handed the wheel");
    await setDriver(ctx, actor, browser, args.to);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Team limits

function inRange(name: keyof typeof BROWSER_LIMITS, value: number | undefined) {
  if (value === undefined) return;
  const { min, max } = BROWSER_LIMITS[name];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw roomError("invalid", `${name} must be a whole number from ${min} to ${max}.`);
  }
}

export const { person: setSettings, agent: setSettingsAgent } = roomMutation({
  name: "browsers.setSettings",
  description:
    "As an admin, set the team's shared-browser limits: most open access, how many may be live at once (1-10), the idle timeout (1-60 minutes) and the longest session (10-480 minutes). New limits apply to browsers started afterwards, except a lower access limit, which lowers live browsers at once.",
  scope: "team.admin",
  args: {
    mostOpenAccess: v.optional(vAccess),
    maxLive: v.optional(v.number()),
    idleMinutes: v.optional(v.number()),
    longestMinutes: v.optional(v.number()),
  },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    inRange("maxLive", args.maxLive);
    inRange("idleMinutes", args.idleMinutes);
    inRange("longestMinutes", args.longestMinutes);
    const before = await settingsFor(ctx, actor.teamId);
    const next = {
      mostOpenAccess: args.mostOpenAccess ?? before.mostOpenAccess,
      maxLive: args.maxLive ?? before.maxLive,
      idleMinutes: args.idleMinutes ?? before.idleMinutes,
      longestMinutes: args.longestMinutes ?? before.longestMinutes,
    };
    const row = await ctx.db
      .query("browserSettings")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .unique();
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert("browserSettings", { teamId: actor.teamId, ...next });

    if (accessRank(next.mostOpenAccess) < accessRank(before.mostOpenAccess)) {
      for (const browser of await teamBrowsers(ctx, actor.teamId)) {
        if (isLive(browser) && accessRank(browser.access) > accessRank(next.mostOpenAccess)) {
          await applyAccess(ctx, actor, browser, next.mostOpenAccess, browser.access);
        }
      }
    }
    await audit(ctx, actor, "browser.settings_changed", actor.teamId, { from: before, to: next });
    return null;
  },
});
