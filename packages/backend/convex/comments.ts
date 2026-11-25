import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { accountableId, actsFor, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { fileInTeam, fileVisible } from "./lib/fileAccess";
import { byteLength, checkPin, MAX_COMMENT_BYTES, sizeLabel, vPin } from "./lib/files";
import { maybeView, memberView } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";

function cleanBody(body: string): string {
  const text = body.trim();
  if (!text) throw roomError("invalid", "A comment needs some text.");
  if (byteLength(text) > MAX_COMMENT_BYTES) {
    throw roomError("invalid", `A comment can be at most ${sizeLabel(MAX_COMMENT_BYTES)}.`);
  }
  return text;
}

/** A comment on a file the actor can see (fileInTeam), or "No such comment." */
async function commentInTeam(ctx: QueryCtx, actor: Actor, commentId: Id<"comments">): Promise<Doc<"comments">> {
  const comment = await ctx.db.get(commentId);
  if (!comment || comment.teamId !== actor.teamId) throw roomError("not_found", "No such comment.");
  const file = await ctx.db.get(comment.fileId);
  if (!file || !(await fileVisible(ctx, actor, file))) throw roomError("not_found", "No such comment.");
  return comment;
}

/** A pinned comment, not a reply. */
async function pinnedComment(ctx: QueryCtx, actor: Actor, commentId: Id<"comments">) {
  const comment = await commentInTeam(ctx, actor, commentId);
  if (comment.replyTo) throw roomError("invalid", "Reply to the comment, not to a reply.");
  return comment;
}

function byWhom(actor: Actor) {
  return { authorId: actor.member._id, ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}) };
}

export const { person: add, agent: addAgent } = roomMutation({
  name: "comments.add",
  description:
    'Pin a comment (Markdown) to a file. `pin` says where: {kind:"file"} for the whole file; {kind:"page", page, x, y} on a PDF page; {kind:"spot", x, y} on an image (x and y are fractions from 0 to 1 of the width and height, from the top left); {kind:"text", quote, prefix?, suffix?} on a passage of a doc, quoted as it reads (prefix and suffix are up to 64 characters around it, to tell repeats apart); {kind:"point", x, y, elementId?} on a canvas, in canvas coordinates.',
  scope: "messages.post",
  args: { fileId: v.id("files"), body: v.string(), pin: vPin },
  handler: async (ctx, actor, args) => {
    const file = await fileInTeam(ctx, actor, args.fileId);
    checkPin(args.pin, file.format, file.content);
    return await ctx.db.insert("comments", {
      teamId: actor.teamId,
      fileId: file._id,
      body: cleanBody(args.body),
      pin: args.pin,
      ...byWhom(actor),
    });
  },
});

export const { person: reply, agent: replyAgent } = roomMutation({
  name: "comments.reply",
  description: "Reply (Markdown) to a pinned comment.",
  scope: "messages.post",
  args: { commentId: v.id("comments"), body: v.string() },
  handler: async (ctx, actor, args) => {
    const comment = await pinnedComment(ctx, actor, args.commentId);
    return await ctx.db.insert("comments", {
      teamId: actor.teamId,
      fileId: comment.fileId,
      body: cleanBody(args.body),
      replyTo: comment._id,
      ...byWhom(actor),
    });
  },
});

export const { person: resolve, agent: resolveAgent } = roomMutation({
  name: "comments.resolve",
  description: "Resolve a pinned comment: it leaves the file's open comments but stays listed under resolved, with who resolved it.",
  scope: "messages.post",
  args: { commentId: v.id("comments") },
  handler: async (ctx, actor, args) => {
    const comment = await pinnedComment(ctx, actor, args.commentId);
    if (comment.resolvedAt === undefined) {
      await ctx.db.patch(comment._id, { resolvedAt: Date.now(), resolvedBy: actor.member._id });
    }
    return null;
  },
});

export const { person: reopen, agent: reopenAgent } = roomMutation({
  name: "comments.reopen",
  description: "Reopen a resolved pinned comment.",
  scope: "messages.post",
  args: { commentId: v.id("comments") },
  handler: async (ctx, actor, args) => {
    const comment = await pinnedComment(ctx, actor, args.commentId);
    await ctx.db.patch(comment._id, { resolvedAt: undefined, resolvedBy: undefined });
    return null;
  },
});

// `delete` is a reserved word, so the person function is exported under it by alias.
const deleteFns = roomMutation({
  name: "comments.delete",
  description: "Delete a comment or reply (with a comment's replies). Only its author, or an admin, can.",
  scope: "messages.post",
  args: { commentId: v.id("comments") },
  handler: async (ctx, actor, args) => {
    const comment = await commentInTeam(ctx, actor, args.commentId);
    // An agent's comment is its accountable person's to take back, as everywhere in the Room API.
    const author = await ctx.db.get(comment.authorId);
    const agent = author?.kind === "agent" && author.agentId ? await ctx.db.get(author.agentId) : null;
    const authorsPerson = agent ? agent.addedBy : comment.authorId;
    if (!actsFor(actor, comment.authorId) && authorsPerson !== accountableId(actor) && actor.role !== "admin") {
      throw roomError("forbidden", "Only its author or an admin can delete a comment.");
    }
    const replies = await ctx.db
      .query("comments")
      .withIndex("by_reply", (q) => q.eq("replyTo", comment._id))
      .collect();
    for (const r of replies) await ctx.db.delete(r._id);
    await ctx.db.delete(comment._id);
    return null;
  },
});
const remove = deleteFns.person;
export const deleteAgent = deleteFns.agent;
export { remove as delete };

async function view(ctx: QueryCtx, c: Doc<"comments">) {
  return { commentId: c._id, body: c.body, author: await memberView(ctx, c.authorId), createdAt: c._creationTime };
}

export const { person: list, agent: listAgent } = roomQuery({
  name: "comments.list",
  description:
    "A file's pinned comments, oldest first, each with its pin, author, replies and whether it is resolved. `status` is open (the default), resolved or all.",
  scope: "room.read",
  args: {
    fileId: v.id("files"),
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"), v.literal("all"))),
  },
  handler: async (ctx, actor, args) => {
    const file = await fileInTeam(ctx, actor, args.fileId);
    const status = args.status ?? "open";
    const all = await ctx.db
      .query("comments")
      .withIndex("by_file", (q) => q.eq("fileId", file._id))
      .collect();
    const threads = all.filter(
      (c) =>
        c.pin !== undefined &&
        (status === "all" || (status === "open") === (c.resolvedAt === undefined)),
    );
    return Promise.all(
      threads.map(async (c) => ({
        ...(await view(ctx, c)),
        pin: c.pin!,
        resolvedAt: c.resolvedAt,
        resolvedBy: await maybeView(ctx, c.resolvedBy),
        replies: await Promise.all(all.filter((r) => r.replyTo === c._id).map((r) => view(ctx, r))),
      })),
    );
  },
});
