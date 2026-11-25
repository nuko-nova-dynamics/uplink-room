/**
 * Saved logins for shared browsers (ADR 0011, spec #7).
 *
 * Saved logins are a named Hyperbeam profile that belongs to a channel: the
 * cookies, passwords, history and bookmarks of the shared browsers started
 * with them. Hyperbeam saves the profile when such a browser ends, and loads it
 * into the next one, so new logins carry over. They are kept for the time
 * someone picked (a day, a week, a month, or until someone forgets them), and
 * a scheduled function forgets them when it runs out.
 *
 * Hyperbeam has no call to delete a profile. Forgetting stops loading the
 * profile, and once the last browser with it has ended, the room erases it
 * with a short session that loads nothing and saves an empty profile over it
 * (#76). The profile id never leaves the backend.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actsFor, requireScope, type Actor } from "./lib/actor";
import { browserProvider, PROVIDER_ENV_VAR, siteUrl } from "./lib/browserProvider";
import { roomError } from "./lib/errors";
import { audit, inTeam, maybeView, memberView } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import {
  cleanName,
  ERASE_MAX_TRIES,
  eraseBackoffMs,
  KEEP_MS,
  NAME_MAX,
  SAVE_BEFORE_END_MS,
  SHOW_FORGOTTEN_MS,
  vKeep,
  type Keep,
} from "./lib/savedLogins";

/** Running at the provider, or possibly still: such a browser may still save to its profile. */
const browserHoldsSlot = (b: Doc<"browsers">) =>
  b.status === "starting" || b.status === "live" || b.status === "stopping";

/**
 * Kept, and not past their deadline. Saved logins past it count as forgotten
 * from that moment, even before the scheduled job marks them so.
 */
export function usable(s: Doc<"savedLogins">, now = Date.now()) {
  return s.status === "kept" && (s.expiresAt === undefined || s.expiresAt > now);
}

async function browsersUsing(ctx: QueryCtx, savedLoginId: Id<"savedLogins">) {
  return ctx.db
    .query("browsers")
    .withIndex("by_saved_login", (q) => q.eq("savedLoginId", savedLoginId))
    .collect();
}

/** What clients see of saved logins. Never the profile id. */
export async function savedLoginView(ctx: QueryCtx, s: Doc<"savedLogins">) {
  const channel = await ctx.db.get(s.channelId);
  const using = (await browsersUsing(ctx, s._id)).filter(browserHoldsSlot);
  // Past the deadline but not yet marked: show it as the scheduled job will leave it.
  const lapsed = s.status === "kept" && !usable(s);
  return {
    savedLoginId: s._id,
    channel: channel ? { channelId: channel._id, name: channel.name } : undefined,
    name: s.name,
    keep: s.keep,
    ...(lapsed ? {} : { expiresAt: s.expiresAt }),
    status: lapsed ? ("forgotten" as const) : s.status,
    savedBy: await memberView(ctx, s.savedBy),
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    /** A shared browser with these logins is running, or still saving them. */
    inUse: using.length > 0,
    forgottenAt: lapsed ? s.expiresAt : s.forgottenAt,
    forgetReason: lapsed ? ("expired" as const) : s.forgetReason,
    forgottenBy: await maybeView(ctx, s.forgottenBy),
  };
}

export type SavedLoginView = Awaited<ReturnType<typeof savedLoginView>>;

function expiryOf(keep: Keep, from: number): number | undefined {
  const ms = KEEP_MS[keep];
  return ms === null ? undefined : from + ms;
}

async function cancelJob(ctx: MutationCtx, id: Id<"_scheduled_functions"> | undefined) {
  if (!id) return;
  const job = await ctx.db.system.get("_scheduled_functions", id);
  if (job && job.state.kind === "pending") await ctx.scheduler.cancel(id);
}

/** Sets how long saved logins are kept, counting from now, and schedules them to be forgotten. */
async function applyKeep(ctx: MutationCtx, saved: Doc<"savedLogins">, keep: Keep) {
  await cancelJob(ctx, saved.expireCheckId);
  const now = Date.now();
  const expiresAt = expiryOf(keep, now);
  const expireCheckId =
    expiresAt === undefined
      ? undefined
      : await ctx.scheduler.runAt(expiresAt, internal.savedLogins.expire, { savedLoginId: saved._id });
  await ctx.db.patch(saved._id, { keep, keptFrom: now, expiresAt, expireCheckId });
}

async function requireFreeName(ctx: QueryCtx, channelId: Id<"channels">, name: string, except?: Id<"savedLogins">) {
  const inChannel = await ctx.db
    .query("savedLogins")
    .withIndex("by_channel", (q) => q.eq("channelId", channelId))
    .collect();
  const taken = inChannel.some(
    (s) => s._id !== except && usable(s) && s.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw roomError("conflict", `This channel already has saved logins named "${name}".`);
}

function validName(raw: string): string {
  const name = cleanName(raw);
  if (!name) throw roomError("invalid", `Saved logins need a name of 1 to ${NAME_MAX} characters.`);
  return name;
}

/** Called by `browsers.start`: new saved logins in a channel, kept for `keep`. */
export async function createSavedLogins(
  ctx: MutationCtx,
  actor: Actor,
  channelId: Id<"channels">,
  args: { name: string; keep: Keep },
): Promise<Id<"savedLogins">> {
  const name = validName(args.name);
  await requireFreeName(ctx, channelId, name);
  const now = Date.now();
  const savedLoginId = await ctx.db.insert("savedLogins", {
    teamId: actor.teamId,
    channelId,
    name,
    savedBy: actor.member._id,
    createdAt: now,
    keep: args.keep,
    keptFrom: now,
    status: "kept",
  });
  const saved = (await ctx.db.get(savedLoginId))!;
  await applyKeep(ctx, saved, args.keep);
  await audit(ctx, actor, "saved_logins.created", savedLoginId, { channelId, name, keep: args.keep });
  return savedLoginId;
}

/**
 * Called by `browsers.start`: saved logins a new browser in `channelId` may
 * load. They must be kept, in that channel, and no other browser may still be
 * running with them, since Hyperbeam saves a profile when its session ends and
 * the later save would overwrite the other.
 */
export async function loadableSavedLogins(
  ctx: QueryCtx,
  actor: Actor,
  savedLoginId: Id<"savedLogins">,
  channelId: Id<"channels">,
) {
  const saved = await inTeam(ctx, actor, savedLoginId);
  if (saved.channelId !== channelId) {
    throw roomError("invalid", "These saved logins belong to another channel.");
  }
  if (!usable(saved)) throw roomError("conflict", `The saved logins "${saved.name}" were forgotten.`);
  if ((await browsersUsing(ctx, saved._id)).some(browserHoldsSlot)) {
    throw roomError(
      "conflict",
      `The last browser with "${saved.name}" is still saving its logins. Try again when it has ended.`,
    );
  }
  return saved;
}

/** The profile option a browser with these saved logins starts with. */
export const profileFor = internalQuery({
  args: { savedLoginId: v.id("savedLogins") },
  handler: async (ctx, { savedLoginId }): Promise<"new" | { id: string } | null> => {
    const saved = await ctx.db.get(savedLoginId);
    // Forgotten, or past their deadline, while the browser was starting: it starts temporary, and loads nothing.
    if (!saved || !usable(saved)) return null;
    return saved.profileId ? { id: saved.profileId } : "new";
  },
});

/**
 * A browser with these saved logins got a session, which saves to `profileId` when it ends, however
 * it ends: record the profile. Kept ones load it next time (past their deadline, the job that
 * forgets them erases it). Forgotten ones that never knew it, because they were forgotten while
 * their first browser was starting, erase it once that browser has ended.
 */
export async function recordProfile(ctx: MutationCtx, savedLoginId: Id<"savedLogins">, profileId: string) {
  const saved = await ctx.db.get(savedLoginId);
  if (!saved) return;
  if (saved.status === "kept") {
    if (saved.profileId !== profileId) await ctx.db.patch(saved._id, { profileId });
  } else if (!saved.erase) {
    await ctx.db.patch(saved._id, { erase: { state: "waiting", profileId, tries: 0, nextAt: Date.now() } });
    await eraseWhenFree(ctx, saved._id);
  }
}

/** A browser with these saved logins went live: record when they were used. */
export async function usedBy(ctx: MutationCtx, savedLoginId: Id<"savedLogins">) {
  const saved = await ctx.db.get(savedLoginId);
  if (saved && usable(saved)) await ctx.db.patch(saved._id, { lastUsedAt: Date.now() });
}

/**
 * Stops loading saved logins, and erases their profile once the last browser with it has ended.
 * The profile id moves to `erase`, and is dropped once the erase is done.
 */
async function forgetNow(
  ctx: MutationCtx,
  saved: Doc<"savedLogins">,
  reason: "expired" | "forgotten",
  by?: Id<"members">,
) {
  if (saved.status !== "kept") return;
  await cancelJob(ctx, saved.expireCheckId);
  const now = Date.now();
  await ctx.db.patch(saved._id, {
    status: "forgotten",
    forgottenAt: now,
    forgetReason: reason,
    ...(by ? { forgottenBy: by } : {}),
    profileId: undefined,
    expiresAt: undefined,
    expireCheckId: undefined,
    ...(saved.profileId ? { erase: { state: "waiting" as const, profileId: saved.profileId, tries: 0, nextAt: now } } : {}),
  });
  await eraseWhenFree(ctx, saved._id);
}

// ---------------------------------------------------------------------------
// Erasing forgotten saved logins at the provider (#76)
//
// Hyperbeam can't delete a profile, but a session that loads nothing and saves to it replaces it
// with an empty one when it ends (ADR 0011). The room starts that session only once every browser
// with the saved logins has ended, so the profile never has two sessions, and ends it after the
// same wait a browser gets before Hyperbeam saves (SAVE_BEFORE_END_MS). Forgetting doesn't wait
// for any of it.
//
// Convex doesn't retry a scheduled action, so the retries hang on `eraseStep`, a mutation that
// leases each try by moving `nextAt` ahead by the backoff before the action runs, as
// `calls.attemptRevocations` does. A try that fails, or an action that never reports back, is
// tried again when that comes. Each step is scheduled for `nextAt` and passed it; a step whose
// time is no longer `nextAt` was superseded (the session started, so its end comes sooner) and
// does nothing, so one erase never has two steps.

/** Sets when the erase's next step runs, and schedules it. */
async function nextEraseStep(ctx: MutationCtx, savedLoginId: Id<"savedLogins">, at: number) {
  await ctx.scheduler.runAt(at, internal.savedLogins.eraseStep, { savedLoginId, at });
}

/** Called when saved logins are forgotten and whenever a browser ends: starts the erase once no browser uses them. */
export async function eraseWhenFree(ctx: MutationCtx, savedLoginId: Id<"savedLogins">) {
  const saved = await ctx.db.get(savedLoginId);
  if (!saved?.erase || saved.erase.state !== "waiting") return;
  if ((await browsersUsing(ctx, saved._id)).some(browserHoldsSlot)) return;
  const at = Date.now();
  await ctx.db.patch(saved._id, { erase: { ...saved.erase, state: "pending", nextAt: at } });
  await nextEraseStep(ctx, saved._id, at);
}

/** Starts the next erase try: the session, or ending it once it has run long enough to save. */
export const eraseStep = internalMutation({
  args: { savedLoginId: v.id("savedLogins"), at: v.number() },
  handler: async (ctx, { savedLoginId, at }) => {
    const saved = await ctx.db.get(savedLoginId);
    const erase = saved?.erase;
    if (!saved || !erase || erase.state !== "pending" || !erase.profileId || erase.nextAt !== at) return null;
    const now = Date.now();
    if (!erase.sessionId && (await browsersUsing(ctx, saved._id)).some(browserHoldsSlot)) {
      // One profile, one session: wait for that browser to end (`eraseWhenFree` picks it up).
      await ctx.db.patch(saved._id, { erase: { ...erase, state: "waiting" } });
      return null;
    }
    if (erase.tries >= ERASE_MAX_TRIES) {
      // Hyperbeam's own deletion, three months after the profile was last loaded, is what's left.
      console.error(`Couldn't erase the profile of saved logins ${saved._id} after ${erase.tries} tries: ${erase.lastError ?? "no answer"}`);
      await ctx.db.patch(saved._id, {
        erase: { state: "gaveUp", tries: erase.tries, nextAt: erase.nextAt, ...(erase.lastError ? { lastError: erase.lastError } : {}) },
      });
      return null;
    }
    const tries = erase.tries + 1;
    const nextAt = now + eraseBackoffMs(tries);
    await ctx.db.patch(saved._id, { erase: { ...erase, tries, nextAt } });
    if (erase.sessionId) await ctx.scheduler.runAfter(0, internal.savedLogins.endEraseSession, { savedLoginId });
    else await ctx.scheduler.runAfter(0, internal.savedLogins.startEraseSession, { savedLoginId });
    await nextEraseStep(ctx, saved._id, nextAt);
    return null;
  },
});

/** What an erase try works on. Read by the actions, so the profile id is never a scheduled job's argument. */
export const eraseTarget = internalQuery({
  args: { savedLoginId: v.id("savedLogins") },
  handler: async (ctx, { savedLoginId }) => {
    const erase = (await ctx.db.get(savedLoginId))?.erase;
    if (!erase || erase.state !== "pending" || !erase.profileId) return null;
    return { profileId: erase.profileId, sessionId: erase.sessionId };
  },
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export const startEraseSession = internalAction({
  args: { savedLoginId: v.id("savedLogins") },
  handler: async (ctx, { savedLoginId }) => {
    const target = await ctx.runQuery(internal.savedLogins.eraseTarget, { savedLoginId });
    if (!target || target.sessionId) return null;
    try {
      const provider = browserProvider();
      if (!provider) throw new Error(`Shared browsers aren't configured: ${PROVIDER_ENV_VAR} is not set.`);
      const { sessionId } = await provider.startErase({
        // A retry while the last try's session still runs gets that session back, not a second one.
        tag: `${savedLoginId}:erase`,
        profileId: target.profileId,
        authWebhookUrl: `${siteUrl()}/hyperbeam/auth`,
      });
      await ctx.runMutation(internal.savedLogins.eraseStarted, { savedLoginId, sessionId });
    } catch (error) {
      await ctx.runMutation(internal.savedLogins.eraseFailed, { savedLoginId, error: message(error) });
    }
    return null;
  },
});

/** The erase session runs: it is ended once it has run as long as a browser runs on to save. */
export const eraseStarted = internalMutation({
  args: { savedLoginId: v.id("savedLogins"), sessionId: v.string() },
  handler: async (ctx, { savedLoginId, sessionId }) => {
    const erase = (await ctx.db.get(savedLoginId))?.erase;
    if (!erase || erase.state !== "pending" || erase.sessionId) return null;
    const nextAt = Date.now() + SAVE_BEFORE_END_MS;
    await ctx.db.patch(savedLoginId, {
      erase: { state: "pending", profileId: erase.profileId, sessionId, tries: erase.tries, nextAt },
    });
    await nextEraseStep(ctx, savedLoginId, nextAt);
    return null;
  },
});

export const endEraseSession = internalAction({
  args: { savedLoginId: v.id("savedLogins") },
  handler: async (ctx, { savedLoginId }) => {
    const target = await ctx.runQuery(internal.savedLogins.eraseTarget, { savedLoginId });
    if (!target?.sessionId) return null;
    try {
      const provider = browserProvider();
      if (!provider) throw new Error(`Shared browsers aren't configured: ${PROVIDER_ENV_VAR} is not set.`);
      if (!(await provider.endErase(target.sessionId))) throw new Error("Hyperbeam hasn't ended the erase session yet.");
      await ctx.runMutation(internal.savedLogins.erased, { savedLoginId, sessionId: target.sessionId });
    } catch (error) {
      await ctx.runMutation(internal.savedLogins.eraseFailed, { savedLoginId, error: message(error) });
    }
    return null;
  },
});

/** The erase session has ended, so the provider saved its empty profile: drop the profile id. */
export const erased = internalMutation({
  args: { savedLoginId: v.id("savedLogins"), sessionId: v.string() },
  handler: async (ctx, { savedLoginId, sessionId }) => {
    const erase = (await ctx.db.get(savedLoginId))?.erase;
    if (!erase || erase.state !== "pending" || erase.sessionId !== sessionId) return null;
    await ctx.db.patch(savedLoginId, { erase: { state: "erased", tries: erase.tries, nextAt: erase.nextAt, erasedAt: Date.now() } });
    return null;
  },
});

/** A try failed. `eraseStep` tries again when its lease runs out. */
export const eraseFailed = internalMutation({
  args: { savedLoginId: v.id("savedLogins"), error: v.string() },
  handler: async (ctx, { savedLoginId, error }) => {
    const erase = (await ctx.db.get(savedLoginId))?.erase;
    if (!erase || erase.state !== "pending") return null;
    await ctx.db.patch(savedLoginId, { erase: { ...erase, lastError: error } });
    return null;
  },
});

/** The scheduled end of saved logins' keep time. */
export const expire = internalMutation({
  args: { savedLoginId: v.id("savedLogins") },
  handler: async (ctx, { savedLoginId }) => {
    const saved = await ctx.db.get(savedLoginId);
    // The keep time may have changed since this was scheduled; only a deadline that has passed counts.
    if (!saved || saved.expiresAt === undefined || saved.expiresAt > Date.now()) return null;
    await forgetNow(ctx, saved, "expired");
    return null;
  },
});

/**
 * Whoever saved them may change them, and so may the person accountable for
 * the agent that saved them (and that person's agents), as elsewhere in the
 * room. An admin may change anyone's; an agent doing so as an admin also needs
 * the `team.admin` scope.
 */
async function requireMayChange(ctx: QueryCtx, actor: Actor, saved: Doc<"savedLogins">) {
  if (actsFor(actor, saved.savedBy)) return;
  const saver = await ctx.db.get(saved.savedBy);
  const agent = saver?.kind === "agent" && saver.agentId ? await ctx.db.get(saver.agentId) : null;
  if (agent && actsFor(actor, agent.addedBy)) return;
  if (actor.role !== "admin") {
    throw roomError("forbidden", "Only whoever saved these logins, or an admin, can change or forget them.");
  }
  requireScope(actor, "team.admin");
}

// ---------------------------------------------------------------------------
// Room API

export const { person: list, agent: listAgent } = roomQuery({
  name: "savedLogins.list",
  description:
    "A channel's saved logins for shared browsers: name, how long they're kept and when they'll be forgotten, who saved them, when they were last used and whether a browser is using them. Also those forgotten in the last 30 days, and why. Never the provider's profile id.",
  scope: "room.read",
  args: { channelId: v.id("channels") },
  handler: async (ctx, actor, args) => {
    const channel = await inTeam(ctx, actor, args.channelId);
    const rows = await ctx.db
      .query("savedLogins")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .collect();
    const now = Date.now();
    const shown = rows
      .filter((s) => s.status === "kept" || (s.forgottenAt !== undefined && now - s.forgottenAt < SHOW_FORGOTTEN_MS))
      .sort((a, b) =>
        a.status === b.status
          ? (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)
          : a.status === "kept"
            ? -1
            : 1,
      );
    return Promise.all(shown.map((s) => savedLoginView(ctx, s)));
  },
});

export const { person: rename, agent: renameAgent } = roomMutation({
  name: "savedLogins.rename",
  description: "Rename saved logins. Whoever saved them or an admin can.",
  scope: "browsers.use",
  args: { savedLoginId: v.id("savedLogins"), name: v.string() },
  handler: async (ctx, actor, args) => {
    const saved = await inTeam(ctx, actor, args.savedLoginId);
    await requireMayChange(ctx, actor, saved);
    if (!usable(saved)) throw roomError("conflict", "These saved logins were forgotten.");
    const name = validName(args.name);
    await requireFreeName(ctx, saved.channelId, name, saved._id);
    await ctx.db.patch(saved._id, { name });
    await audit(ctx, actor, "saved_logins.renamed", saved._id, { from: saved.name, to: name });
    return null;
  },
});

export const { person: setKeep, agent: setKeepAgent } = roomMutation({
  name: "savedLogins.setKeep",
  description:
    'Change how long saved logins are kept: "1d", "7d", "30d" or "forever" (until someone forgets them). The time counts from now. Whoever saved them or an admin can.',
  scope: "browsers.use",
  args: { savedLoginId: v.id("savedLogins"), keep: vKeep },
  handler: async (ctx, actor, args) => {
    const saved = await inTeam(ctx, actor, args.savedLoginId);
    await requireMayChange(ctx, actor, saved);
    if (!usable(saved)) throw roomError("conflict", "These saved logins were forgotten.");
    await applyKeep(ctx, saved, args.keep);
    await audit(ctx, actor, "saved_logins.keep_changed", saved._id, { from: saved.keep, to: args.keep });
    return null;
  },
});

export const { person: forget, agent: forgetAgent } = roomMutation({
  name: "savedLogins.forget",
  description:
    "Forget saved logins now: no shared browser loads them again. A browser running with them keeps going, and once the last one has ended, the room erases them at Hyperbeam by saving an empty browser over them, in a short session nobody can join. That runs in the background and is tried again for about a day if it fails; if it never works, Hyperbeam deletes them three months after their last use. Whoever saved them can forget them; an admin can forget anyone's (an agent also needs team.admin for that).",
  scope: "browsers.use",
  args: { savedLoginId: v.id("savedLogins") },
  handler: async (ctx, actor, args) => {
    const saved = await inTeam(ctx, actor, args.savedLoginId);
    await requireMayChange(ctx, actor, saved);
    if (saved.status !== "kept") return null;
    await forgetNow(ctx, saved, "forgotten", actor.member._id);
    await audit(ctx, actor, "saved_logins.forgotten", saved._id, { name: saved.name });
    return null;
  },
});
