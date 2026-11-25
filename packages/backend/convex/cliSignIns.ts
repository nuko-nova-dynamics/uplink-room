/**
 * Command-line sign-ins (ADR 0030). `uplink login` asks the room for a nonce (`begin`), signs the
 * person in with Clerk in the browser, and hands the room Clerk's ID token once. The room checks
 * it (lib/clerkTokens.ts, in the HTTP action) and `finish` makes the sign-in: a token `urs_…`,
 * stored as its SHA-256, for 30 days. The Room API side, listing and revoking, is in people.ts.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { defaultTeamForCliSignIn, liveCliSignIn } from "./lib/actor";
import { base64url } from "./lib/github/crypto";
import { randomSecret, sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { endJoinedSessionsStep } from "./lib/joinedRuns";
import { recordPerson } from "./lib/people";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long `uplink login` has from asking for a nonce to handing over the ID token. */
export const SIGN_IN_REQUEST_MS = 15 * MINUTE;
/** How long a CLI sign-in works. */
export const CLI_SIGN_IN_MS = 30 * DAY;
/** `lastUsedAt` is written at most this often, so calls don't each write. */
export const LAST_USED_GRANULARITY_MS = HOUR;

/** The prefix that tells a CLI sign-in's token from an agent key (`urk_`). */
export const CLI_SIGN_IN_PREFIX = "urs_";

export function isCliSignInToken(token: string): boolean {
  return token.startsWith(CLI_SIGN_IN_PREFIX);
}

/** A sign-in starts: a nonce for Clerk to put in the ID token, good for 15 minutes and one sign-in. */
export const begin = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = now + SIGN_IN_REQUEST_MS;
    await ctx.db.insert("cliSignInRequests", { nonce, createdAt: now, expiresAt });
    return { nonce, expiresAt };
  },
});

/**
 * A checked ID token becomes a sign-in. Its nonce must be one `begin` gave out, unexpired and
 * unused; it is used up here. Records the person, as the app's `people.ensure` does, keeping
 * what the ID token leaves out.
 */
export const finish = internalMutation({
  args: {
    nonce: v.string(),
    subject: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    signInName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const request = await ctx.db
      .query("cliSignInRequests")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .unique();
    if (!request || request.expiresAt <= now) {
      throw roomError(
        "unauthenticated",
        "This sign-in was already used, took longer than 15 minutes, or was started on another deployment. Run `uplink login` again.",
      );
    }
    await ctx.db.delete(request._id);
    const personId = await recordPerson(ctx, args, { onlyWhatWasSent: true });
    const token = randomSecret("urs");
    const expiresAt = now + CLI_SIGN_IN_MS;
    const signInId = await ctx.db.insert("cliSignIns", {
      personId,
      hash: await sha256(token),
      prefix: token.slice(0, 8),
      name: args.signInName,
      createdAt: now,
      expiresAt,
    });
    // Ends any cached live query that checked this sign-in, the moment it expires (see `expire`).
    await scheduleExpiry(ctx, signInId, expiresAt);
    const person = (await ctx.db.get(personId))!;
    return {
      token,
      signInId,
      expiresAt,
      person: { personId, name: person.name, ...(person.email ? { email: person.email } : {}) },
    };
  },
});

/**
 * What the HTTP endpoint needs before it runs a function with a CLI sign-in: that the sign-in
 * works, and for a team function called without `teamId`, the person's only team. Throws the
 * Room API error otherwise. The action checks `expiresAt` again, since this answer may be cached.
 */
export const forCall = internalQuery({
  args: { signInHash: v.string(), needsTeam: v.boolean() },
  handler: async (ctx, { signInHash, needsTeam }) => {
    const signIn = await liveCliSignIn(ctx, signInHash);
    return {
      signInId: signIn._id,
      expiresAt: signIn.expiresAt,
      lastUsedAt: signIn.lastUsedAt,
      ...(needsTeam ? { teamId: await defaultTeamForCliSignIn(ctx, signIn) } : {}),
    };
  },
});

/**
 * Runs at a sign-in's expiresAt and marks it expired. Convex caches a query's result by its
 * arguments and the documents it read, and reruns it only when one of those changes, never because
 * time passed. Without this write, a `live:query` watch (or another client asking with the same
 * token and arguments) could keep getting a result computed while the sign-in still worked.
 */
export const expire = internalMutation({
  args: { signInId: v.id("cliSignIns") },
  handler: async (ctx, { signInId }) => {
    const signIn = await ctx.db.get(signInId);
    if (!signIn || signIn.expired) return;
    if (signIn.expiresAt > Date.now()) {
      await scheduleExpiry(ctx, signInId, signIn.expiresAt);
      return;
    }
    await ctx.db.patch(signInId, { expired: true });
    // The runs its sessions joined end with it (ADR 0032).
    await endJoinedRunsOf(ctx, signInId);
  },
});

/**
 * Ends the runs a revoked or expired sign-in's sessions joined, in scheduled steps
 * (`endJoinedRuns`), so a sign-in with hundreds of joined runs stays within Convex's limits. The
 * caller has already marked the sign-in, and this only schedules, so the mark commits whatever the
 * steps meet: its run tokens refuse before their runs end. Should a step fail, which Convex doesn't
 * retry, each run still ends when its heartbeat stops (joined.expire), since a run whose token
 * refuses can't send one.
 */
export async function endJoinedRunsOf(ctx: MutationCtx, signInId: Id<"cliSignIns">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.cliSignIns.endJoinedRuns, { signInId });
}

/** One step of ending a revoked or expired sign-in's joined runs, then the next, scheduled (`endJoinedRunsOf`). */
export const endJoinedRuns = internalMutation({
  args: { signInId: v.id("cliSignIns") },
  handler: async (ctx, { signInId }) => {
    if (await endJoinedSessionsStep(ctx, signInId)) await endJoinedRunsOf(ctx, signInId);
  },
});

/**
 * The longest wait before `expire` runs again. A wait longer than a JavaScript timer holds (2^31 ms,
 * about 24.8 days) fires at once in convex-test, so a 30-day sign-in is waited out in steps.
 */
const EXPIRY_STEP_MS = 7 * DAY;

async function scheduleExpiry(ctx: MutationCtx, signInId: Id<"cliSignIns">, expiresAt: number): Promise<void> {
  await ctx.scheduler.runAt(Math.min(expiresAt, Date.now() + EXPIRY_STEP_MS), internal.cliSignIns.expire, { signInId });
}

/** Notes that a sign-in was used (at most hourly: see LAST_USED_GRANULARITY_MS). */
export const touch = internalMutation({
  args: { signInId: v.id("cliSignIns") },
  handler: async (ctx, { signInId }) => {
    const signIn = await ctx.db.get(signInId);
    if (signIn && signIn.revokedAt === undefined) await ctx.db.patch(signInId, { lastUsedAt: Date.now() });
  },
});

/**
 * How many documents one step of `prune` deletes at most. A Convex transaction may write 16,000
 * (docs.convex.dev/production/state/limits), and 33 sign-ins with 500 joined sessions each already
 * pass that, so the work goes in steps of this many, each scheduling the next.
 */
export const PRUNE_WRITES = 4000;

/**
 * Deletes sign-in requests nobody finished, and sign-ins 30 days after they expired (revoked
 * ones included), so the app can still show recently ended ones, with the sessions that joined
 * with them (ended since the sign-in did). Hourly, in steps of at most PRUNE_WRITES deletes: a
 * step that runs out schedules the next. A sign-in is deleted only once none of its joined
 * sessions is left, so none is left pointing at a sign-in that's gone.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let budget = PRUNE_WRITES;
    let more = false;
    const requests = await ctx.db
      .query("cliSignInRequests")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(budget);
    for (const request of requests) await ctx.db.delete(request._id);
    budget -= requests.length;
    if (budget === 0) more = true;

    let signIns = 0;
    let sessions = 0;
    const ended = budget
      ? await ctx.db
          .query("cliSignIns")
          .withIndex("by_expires", (q) => q.lt("expiresAt", now - 30 * DAY))
          .take(Math.min(budget, 500))
      : [];
    if (ended.length === 500) more = true;
    for (const signIn of ended) {
      const joined = await ctx.db
        .query("joinedSessions")
        .withIndex("by_sign_in_ended", (q) => q.eq("signInId", signIn._id))
        .take(budget + 1);
      const deleting = joined.slice(0, budget);
      for (const session of deleting) await ctx.db.delete(session._id);
      budget -= deleting.length;
      sessions += deleting.length;
      // Sessions left, or no write left for the sign-in itself: the next step goes on from here.
      if (joined.length > deleting.length || budget === 0) {
        more = true;
        break;
      }
      await ctx.db.delete(signIn._id);
      budget--;
      signIns++;
    }
    // The last write went: more ended sign-ins may wait.
    if (budget === 0) more = true;
    if (more) await ctx.scheduler.runAfter(0, internal.cliSignIns.prune, {});
    return { requests: requests.length, signIns, sessions, more };
  },
});
