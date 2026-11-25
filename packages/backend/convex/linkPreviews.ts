/** Stores what linkPreviewNode.fetchPreview found for a link (spec #63). */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";

async function previewRow(ctx: QueryCtx, url: string) {
  return await ctx.db
    .query("linkPreviews")
    .withIndex("by_url", (q) => q.eq("url", url))
    .unique();
}

/** The first of these teams that still has link previews on, if any. */
async function teamWithPreviewsOn(ctx: QueryCtx, teamIds: Id<"teams">[]): Promise<Id<"teams"> | null> {
  for (const teamId of teamIds) if ((await ctx.db.get(teamId))?.linkPreviews !== "off") return teamId;
  return null;
}

/** The teams a fetch is for: the one that started it, and any waiting on it since (#70). */
function fetchFor(row: Doc<"linkPreviews"> | null, teamId: Id<"teams">): Id<"teams">[] {
  const waiting = row?.status === "pending" ? (row.waitingTeams ?? []) : [];
  return [teamId, ...waiting.filter((id) => id !== teamId)];
}

export const settle = internalMutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    siteName: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await previewRow(ctx, args.url);
    const ready = args.title !== undefined || args.description !== undefined;
    const fields = {
      status: ready ? ("ready" as const) : ("failed" as const),
      title: args.title,
      description: args.description,
      siteName: args.siteName,
      imageStorageId: args.imageStorageId,
      error: args.error?.slice(0, 500),
      fetchedAt: Date.now(),
      waitingTeams: undefined,
    };
    if (!row) {
      await ctx.db.insert("linkPreviews", { url: args.url, requestedAt: Date.now(), ...fields });
      return null;
    }
    const oldImage = row.imageStorageId;
    await ctx.db.patch(row._id, fields);
    if (oldImage && oldImage !== args.imageStorageId && (await ctx.db.system.get(oldImage))) {
      await ctx.storage.delete(oldImage);
    }
    return null;
  },
});

/**
 * Whether the fetch should go on (asked before each request): the team that started it, or a team
 * waiting on it, still has link previews on. `url` is absent only in calls from before #70.
 */
export const stillOn = internalQuery({
  args: { teamId: v.id("teams"), url: v.optional(v.string()) },
  handler: async (ctx, { teamId, url }) => {
    const row = url === undefined ? null : await previewRow(ctx, url);
    return (await teamWithPreviewsOn(ctx, fetchFor(row, teamId))) !== null;
  },
});

/**
 * Every team the fetch was for turned previews off during it: drop the request without recording a
 * failure, so the link isn't marked as having no preview for anyone else. An older preview stays as
 * it was. A team that started waiting on the fetch after its last check, or turned previews back on,
 * takes the fetch over instead, so its message still gets its preview (#70).
 */
export const abandon = internalMutation({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const row = await previewRow(ctx, url);
    if (!row || row.status !== "pending") return null;
    const takeover = await teamWithPreviewsOn(ctx, row.waitingTeams ?? []);
    if (takeover) {
      await ctx.db.patch(row._id, { requestedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.linkPreviewNode.fetchPreview, { url, teamId: takeover });
      return null;
    }
    if (row.title !== undefined || row.description !== undefined) {
      await ctx.db.patch(row._id, { status: "ready", waitingTeams: undefined });
    } else {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
