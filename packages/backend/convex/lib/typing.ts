import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** A typing row older than this isn't typing any more (channels.whoIsTyping leaves it out). */
export const TYPING_FRESH_MS = 8000;
/** Rows this old are deleted: at each write in their channel, and by a cron (channels.pruneTyping). */
export const TYPING_KEEP_MS = 60_000;
/** At most this many stale rows are deleted per write. */
const PRUNE_ON_WRITE = 10;

/**
 * Records or ends a member's typing in a channel (one row per member and channel). Someone who
 * closes the app mid-draft never sends a stop, so each write also deletes a few of the channel's
 * rows that went quiet a minute ago.
 */
export async function setTyping(
  ctx: MutationCtx,
  channel: Doc<"channels">,
  memberId: Id<"members">,
  writing: { replyTo?: Id<"messages"> | undefined } | null,
) {
  const row = await ctx.db
    .query("typing")
    .withIndex("by_member_channel", (q) => q.eq("memberId", memberId).eq("channelId", channel._id))
    .unique();
  const at = Date.now();
  const stale = await ctx.db
    .query("typing")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id).lt("at", at - TYPING_KEEP_MS))
    .take(PRUNE_ON_WRITE);
  // An agent working on a run here (runId) stays until the run stops; channels.pruneTyping checks those.
  for (const r of stale) if (r._id !== row?._id && r.runId === undefined) await ctx.db.delete(r._id);
  if (!writing) {
    if (row) await ctx.db.delete(row._id);
    return;
  }
  if (row) await ctx.db.patch(row._id, { at, replyTo: writing.replyTo });
  else {
    await ctx.db.insert("typing", {
      teamId: channel.teamId,
      channelId: channel._id,
      memberId,
      at,
      ...(writing.replyTo ? { replyTo: writing.replyTo } : {}),
    });
  }
}
