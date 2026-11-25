import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { roomError } from "./errors";

/** Who Clerk says signed in: from the app's session token, or from an ID token (`uplink login`). */
export type SignedInPerson = { subject: string; name?: string; email?: string; avatarUrl?: string };

/**
 * Records the person Clerk signed in, keyed by Clerk's user ID (ADR 0014), and refreshes their
 * name, email and picture from what Clerk sent this time. With `onlyWhatWasSent`, a field Clerk
 * didn't send keeps its value: an ID token from `uplink login` has no picture when there is none
 * to send, which mustn't erase the one the app's session token gave.
 */
export async function recordPerson(
  ctx: MutationCtx,
  who: SignedInPerson,
  options: { onlyWhatWasSent?: boolean } = {},
): Promise<Id<"people">> {
  const existing = await ctx.db
    .query("people")
    .withIndex("by_subject", (q) => q.eq("subject", who.subject))
    .unique();
  // A token Clerk issued before it deleted the account doesn't bring the person back, nor makes
  // one for an account deleted before the room saw it (ADR 0035).
  const deleted = await ctx.db
    .query("accountDeletions")
    .withIndex("by_subject", (q) => q.eq("subject", who.subject))
    .first();
  if (existing?.deletedAt !== undefined || deleted) throw roomError("unauthenticated", "This account was deleted.");
  const name = who.name || who.email;
  if (existing && options.onlyWhatWasSent) {
    await ctx.db.patch(existing._id, {
      ...(name ? { name } : {}),
      ...(who.email ? { email: who.email } : {}),
      ...(who.avatarUrl ? { avatarUrl: who.avatarUrl } : {}),
    });
    return existing._id;
  }
  const fields = { name: name || "Someone", email: who.email, avatarUrl: who.avatarUrl };
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  return await ctx.db.insert("people", { subject: who.subject, ...fields });
}
