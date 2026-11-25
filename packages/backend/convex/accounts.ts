/**
 * Deleting an account (ADR 0029 D10, ADR 0035, slice 15 of #139). Clerk sends `user.deleted` when a
 * person deletes their account or someone deletes it in the Clerk Dashboard or Backend API; the HTTP
 * route checks Svix's signature (lib/clerkWebhook.ts) and calls `deleteFromClerk`. That first step
 * stays small, so no amount of the person's data can make it fail: it records the deletion and marks
 * the person deleted, with "A deleted account" for a name and no email or picture. From then on
 * nothing acts as them: not a Clerk token issued before the deletion (lib/actor.ts, lib/people.ts),
 * a CLI sign-in, a run token, an agent they're accountable for, nor a personal machine's bridge.
 *
 * `cleanUp` then takes away what is left, in steps that each fit Convex's limits and save where they
 * got to, so a step that fails is run again from there:
 * - revokes their CLI sign-ins and ends every run their sessions joined, and so their runs in Pairs
 *   (ADR 0030, ADR 0032);
 * - takes them out of their Pairs: their agents leave too, their messages stay as "A deleted
 *   account", and a Pair left with fewer than two people ends;
 * - takes them out of each team they're in, as `members.remove` does, which also stops the agents
 *   they added there, and unlinks their personal machines; their messages there stay, under "A
 *   deleted account", as in their Pairs;
 * - does the same in teams an admin had already removed them from: their name there, and their
 *   personal machines.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { teamsOfPerson, type Actor } from "./lib/actor";
import { endJoinedSession } from "./lib/joinedRuns";
import { DELETED_ACCOUNT, FORGET_STEP, forgetMessagesStep, forgetPairsStep } from "./lib/pairs";
import { audit } from "./lib/members";
import { beginRemoval, leaveChannelsStep, leavingWith, takeBackMachineStep } from "./members";

/** How long an applied delivery's `svix-id` is kept: far past Svix's retries, which end within about a day. */
const DELIVERY_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * Applies one verified `user.deleted` delivery, once: a delivery with an `svix-id` already applied
 * changes nothing, and neither does another delivery for an account already deleted. The delivery is
 * recorded in the same transaction as the deletion, so one that fails isn't recorded and Svix's
 * retry applies it. It reads and writes a few rows, whatever the person has.
 */
export const deleteFromClerk = internalMutation({
  args: { deliveryId: v.string(), subject: v.string() },
  handler: async (ctx, { deliveryId, subject }) => {
    const seen = await ctx.db
      .query("clerkDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId))
      .first();
    if (seen) return "duplicate" as const;
    const now = Date.now();
    await ctx.db.insert("clerkDeliveries", { deliveryId, at: now });
    const recorded = await ctx.db
      .query("accountDeletions")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .first();
    if (recorded) {
      // A replay from the Dashboard starts steps that stopped again (the cron does too, later).
      await resumeIfStalled(ctx, recorded);
      return "already_deleted" as const;
    }
    const person = await ctx.db
      .query("people")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .unique();
    // Recorded even for an account the room never saw: a sign-in Clerk started before the
    // deletion may still hand the room its token, and mustn't make a person (recordPerson).
    if (!person) {
      await ctx.db.insert("accountDeletions", { subject, deletedAt: now, stepAt: now, finishedAt: now });
      return "unknown_person" as const;
    }
    await ctx.db.patch(person._id, { deletedAt: now, name: DELETED_ACCOUNT, email: undefined, avatarUrl: undefined });
    const deletionId = await ctx.db.insert("accountDeletions", { subject, personId: person._id, deletedAt: now, stepAt: now });
    await ctx.scheduler.runAfter(0, internal.accounts.cleanUp, { deletionId });
    return "deleted" as const;
  },
});

/** At most this many CLI sign-ins are revoked in one step. Each is one write. */
const SIGN_INS_STEP = 500;
/**
 * At most this many joined runs are ended in one step. Ending one reads about ten index ranges (its
 * run, what waits for it, its Pairs), so a step stays far under Convex's 4,096.
 */
const SESSIONS_STEP = 100;

/**
 * One step of taking away what a deleted account left: the first kind of thing that is left, in a
 * batch that fits one transaction. Each kind is found by what is still there (a live sign-in, a live
 * run, a Pair or team they're still in), and a team's channels and machines by the membership the
 * deletion saves as `leaving`, so a step run again, or after one that failed, goes on where the last
 * one stopped. Schedules the next step until nothing is left.
 */
export const cleanUp = internalMutation({
  args: { deletionId: v.id("accountDeletions") },
  handler: async (ctx, { deletionId }) => {
    const deletion = await ctx.db.get(deletionId);
    if (!deletion?.personId || deletion.finishedAt !== undefined) return;
    const step = await cleanUpStep(ctx, deletion.personId, deletion);
    const now = Date.now();
    if (step === "done") {
      await ctx.db.patch(deletionId, { stepAt: now, finishedAt: now, leaving: undefined, formerCursor: undefined, successor: undefined });
      return;
    }
    const saved =
      step === "more"
        ? {}
        : "former" in step
          ? { formerCursor: step.former }
          : "successor" in step
            ? { successor: step.successor }
            : { leaving: step.leaving ?? undefined, successor: undefined };
    await ctx.db.patch(deletionId, { stepAt: now, ...saved });
    await ctx.scheduler.runAfter(0, internal.accounts.cleanUp, { deletionId });
  },
});

/** At most this many memberships of teams they had already left are walked in one step. */
const FORMER_STEP = 50;

type Search = { memberId: Id<"members">; cursor: string };

/**
 * Takes away one batch of the first kind of thing left: "more" when it took some, `leaving` when it
 * started on a team or finished one, `successor` when it searched a page of a team for its next
 * admin, `former` when it finished a page of the teams they had already left, "done" when nothing
 * was left.
 */
async function cleanUpStep(
  ctx: MutationCtx,
  personId: Id<"people">,
  { leaving, formerCursor, successor }: Pick<Doc<"accountDeletions">, "leaving" | "formerCursor" | "successor">,
): Promise<"more" | "done" | { leaving: Id<"members"> | null } | { successor: Search } | { former: string }> {
  const now = Date.now();
  // Every computer's sign-in stops working (it already acts as nobody: liveCliSignIn).
  const signIns = await ctx.db
    .query("cliSignIns")
    .withIndex("by_person_revoked", (q) => q.eq("personId", personId).eq("revokedAt", undefined))
    .take(SIGN_INS_STEP);
  for (const signIn of signIns) await ctx.db.patch(signIn._id, { revokedAt: now });
  if (signIns.length) return "more";
  // The runs their sessions joined end, and leave their Pairs.
  const sessions = await ctx.db
    .query("joinedSessions")
    .withIndex("by_person_ended", (q) => q.eq("personId", personId).eq("endedAt", undefined))
    .take(SESSIONS_STEP);
  for (const session of sessions) await endJoinedSession(ctx, session, "signed_out");
  if (sessions.length) return "more";
  // Their Pairs (lib/pairs.ts): their wrong-code count, their seats, then their messages' names.
  const failures = await ctx.db
    .query("pairCodeFailures")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .unique();
  if (failures) await ctx.db.delete(failures._id);
  if ((await forgetPairsStep(ctx, personId, { scheduleNext: false })).pairs) return "more";
  if ((await forgetMessagesStep(ctx, personId)) === FORGET_STEP) return "more";
  // The team they're leaving: its private channels and direct messages, then their machines there.
  const member = leaving ? await ctx.db.get(leaving) : null;
  if (member) {
    if (await leaveChannelsStep(ctx, await leavingWith(ctx, member))) return "more";
    if (await takeBackMachineStep(ctx, actorFor(member), member, "account_deleted")) return "more";
    return { leaving: null };
  }
  // The next team: once it has another admin, if they were one, out of it at once; what is left of
  // it goes in the steps above. Their messages there stay, under "A deleted account", as in their Pairs.
  const [next] = await teamsOfPerson(ctx, personId);
  if (next) {
    if (next.name !== DELETED_ACCOUNT) await ctx.db.patch(next._id, { name: DELETED_ACCOUNT });
    if (next.role === "admin") {
      const search = await handOverAdminStep(ctx, next, successor?.memberId === next._id ? successor.cursor : null);
      if (search !== "done") return { successor: { memberId: next._id, cursor: search } };
    }
    await beginRemoval(ctx, actorFor(next), next, { reason: "account_deleted" });
    return { leaving: next._id };
  }
  // Teams they had left before, an admin having removed them: their messages there show "A deleted
  // account" too, and a personal machine left linked there (`members.remove` unlinked none before
  // 2026-11-05) is unlinked, now that their bridge tokens refuse. A page at a time, however many times they rejoined:
  // the cursor saved past each finished page means a step run again goes on from there.
  const formers = await ctx.db
    .query("members")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .paginate({ numItems: FORMER_STEP, cursor: formerCursor ?? null });
  for (const former of formers.page) {
    if (former.name !== DELETED_ACCOUNT) await ctx.db.patch(former._id, { name: DELETED_ACCOUNT });
    if (await takeBackMachineStep(ctx, actorFor(former), former, "account_deleted")) return "more";
  }
  return formers.isDone ? "done" : { former: formers.continueCursor };
}

/**
 * A deleted account leaves a team as `members.remove` takes a person out, with the person
 * themselves as the one acting (the audit log says they left because the account was deleted).
 * A team's last admin leaves too, since a deletion can't be refused; `handOverAdminStep` gives the
 * team another.
 */
function actorFor(member: Doc<"members">): Actor {
  return { kind: "person", teamId: member.teamId, member, role: member.role, scopes: "all" };
}

/**
 * At most this many members are searched for a team's next admin in one step. Each that is a
 * person still in the team reads their person row, an index range of its own, so a step stays far
 * under Convex's 4,096.
 */
const SUCCESSOR_STEP = 1000;

/**
 * When a deleted person was their team's only admin, the person who has been in the team longest,
 * by when they joined, becomes its admin, and the activity log says so (ADR 0035). Only a person
 * counts, as for `members.setRole`'s "at least one admin": not an agent, nor someone whose account is
 * being deleted too. With no such person left, the team is left without an admin. Each step
 * rechecks the team's admins, then reads a page of its members in the order
 * they joined, until the first who counts, however many agents and deleted accounts come before
 * them. "done" when the team has an admin or nobody is left to make one; otherwise the cursor to go
 * on from.
 */
async function handOverAdminStep(ctx: MutationCtx, leaving: Doc<"members">, cursor: string | null): Promise<"done" | string> {
  for (const admin of await ctx.db
    .query("members")
    .withIndex("by_team_role", (q) => q.eq("teamId", leaving.teamId).eq("role", "admin"))
    .collect()) {
    if (admin._id !== leaving._id && (await counts(ctx, admin))) return "done";
  }
  // A person who joins again gets a new membership, so its creation time is when they joined.
  const members = await ctx.db
    .query("members")
    .withIndex("by_team", (q) => q.eq("teamId", leaving.teamId))
    .paginate({ numItems: SUCCESSOR_STEP, cursor });
  for (const member of members.page) {
    if (member._id === leaving._id || !(await counts(ctx, member))) continue;
    await ctx.db.patch(member._id, { role: "admin" });
    await audit(ctx, actorFor(leaving), "member.role_changed", member._id, { role: "admin", reason: "last_admin_deleted" });
    return "done";
  }
  return members.isDone ? "done" : members.continueCursor;
}

/** Whether a member counts as a team's admin, or as someone to make one: a person still in it, with an account. */
async function counts(ctx: MutationCtx, member: Doc<"members">): Promise<boolean> {
  if (member.kind !== "person" || member.removedAt !== undefined || !member.personId) return false;
  return (await ctx.db.get(member.personId))?.deletedAt === undefined;
}

/** A deletion whose last step ran this long ago, and didn't finish, is resumed. */
export const STALLED_MS = 10 * 60_000;

/**
 * Starts a deletion's steps again when they stopped: Convex doesn't retry a scheduled mutation that
 * failed. Each step goes on from what is left, so one that is still running loses nothing.
 */
async function resumeIfStalled(ctx: MutationCtx, deletion: Doc<"accountDeletions">): Promise<boolean> {
  if (deletion.finishedAt !== undefined || deletion.stepAt > Date.now() - STALLED_MS) return false;
  await ctx.db.patch(deletion._id, { stepAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.accounts.cleanUp, { deletionId: deletion._id });
  return true;
}

/** Every 10 minutes: the deletions whose steps stopped, started again. */
export const resumeStalled = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stalled = await ctx.db
      .query("accountDeletions")
      .withIndex("by_finished_step", (q) => q.eq("finishedAt", undefined).lt("stepAt", Date.now() - STALLED_MS))
      .take(100);
    for (const deletion of stalled) await resumeIfStalled(ctx, deletion);
    return stalled.length;
  },
});

/** At most this many deliveries are deleted in one run of `prune`; the next takes the rest. */
const PRUNE_STEP = 1000;

/** Daily: deliveries applied more than DELIVERY_KEEP_MS ago. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("clerkDeliveries")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - DELIVERY_KEEP_MS))
      .take(PRUNE_STEP);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === PRUNE_STEP) await ctx.scheduler.runAfter(0, internal.accounts.prune, {});
  },
});
