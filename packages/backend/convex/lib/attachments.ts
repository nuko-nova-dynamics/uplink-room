/**
 * Message attachments (spec #63). They are uploaded the way project files are (spec #9): an
 * upload URL from `messages.attachUrl` (an `uploads` row for this member and team), then the
 * bytes, then `messages.post` or `messages.edit` keeps them. A refused upload's bytes are deleted
 * by the hourly sweep (files.sweepUploads), which keeps bytes any file or attachment uses.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { roomError } from "./errors";
import { attachmentKind, cleanAttachmentName, MAX_ATTACHMENT_BYTES, sizeText, type AttachmentKind } from "./messages";

export const vNewAttachment = v.object({
  uploadId: v.id("uploads"),
  storageId: v.id("_storage"),
  name: v.string(),
});

export type NewAttachment = { uploadId: Id<"uploads">; storageId: Id<"_storage">; name: string };

export type CheckedAttachment = {
  uploadId: Id<"uploads">;
  storageId: Id<"_storage">;
  name: string;
  kind: AttachmentKind;
  contentType: string;
  size: number;
};

/** Whether any project file or attachment keeps these bytes, other than the ones named. */
export async function storageInUse(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  except: { fileId?: Id<"files">; attachmentId?: Id<"attachments"> } = {},
): Promise<boolean> {
  const files = await ctx.db
    .query("files")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(2);
  if (files.some((f) => f._id !== except.fileId)) return true;
  const attachments = await ctx.db
    .query("attachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(2);
  if (attachments.some((a) => a._id !== except.attachmentId)) return true;
  // A file sent into a thread from its box (ADR 0043).
  const sentToThread = await ctx.db
    .query("threadAttachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (sentToThread) return true;
  // A file sent in a Pair (ADR 0048).
  const sentInPair = await ctx.db
    .query("pairAttachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (sentInPair) return true;
  // A link preview's image copy (lib/linkPreview.ts).
  const preview = await ctx.db
    .query("linkPreviews")
    .withIndex("by_image", (q) => q.eq("imageStorageId", storageId))
    .first();
  return preview !== null;
}

/** Deletes stored bytes unless another file or attachment still uses them. */
export async function releaseStorage(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  except: { fileId?: Id<"files">; attachmentId?: Id<"attachments"> },
) {
  if (await storageInUse(ctx, storageId, except)) return;
  if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
}

/**
 * Checks an upload before a message keeps it. Errors roll the mutation back, so a refused upload's
 * bytes stay until the hourly sweep deletes them.
 */
export async function checkAttachment(ctx: QueryCtx, actor: Actor, item: NewAttachment): Promise<CheckedAttachment> {
  const upload = await ctx.db.get(item.uploadId);
  if (!upload || upload.teamId !== actor.teamId) {
    throw roomError("not_found", "No such upload. Ask messages.attachUrl for a new upload URL.");
  }
  if (upload.uploaderId !== actor.member._id) throw roomError("forbidden", "That's someone else's upload.");
  return { uploadId: item.uploadId, ...(await checkUploadedBytes(ctx, item, upload._creationTime)) };
}

/**
 * The checks every kept upload passes, whoever it was issued to: the bytes exist, nothing keeps them
 * yet, they came after the upload URL was issued (`issuedAt`), and their name, type and size are ones
 * a message takes. Used for a team's uploads and for a Pair's (ADR 0048).
 */
export async function checkUploadedBytes(
  ctx: QueryCtx,
  item: { storageId: Id<"_storage">; name: string },
  issuedAt: number,
): Promise<Omit<CheckedAttachment, "uploadId">> {
  const stored = await ctx.db.system.get(item.storageId);
  if (!stored) throw roomError("not_found", "No such upload. Upload the file again.");
  if (await storageInUse(ctx, item.storageId)) {
    throw roomError("invalid", "That upload is already kept. Upload the bytes again.");
  }
  if (stored._creationTime < issuedAt) {
    throw roomError("invalid", "Those bytes were stored before this upload URL was issued. Upload them to it again.");
  }
  const name = cleanAttachmentName(item.name);
  if (!name) throw roomError("invalid", "An attachment needs a file name.");
  const what = attachmentKind(name);
  if (what.kind === "refused") throw roomError("invalid", `${name}: ${what.reason}`);
  const contentType = stored.contentType ?? "";
  if (what.kind !== "file" && contentType !== what.type) {
    const expected = what.kind === "pdf" ? "a PDF" : `a ${what.type.replace("image/", "").toUpperCase()} image`;
    throw roomError(
      "invalid",
      `${name} isn't ${expected} (its type is ${contentType || "unknown"}). Give it the extension that matches what it is.`,
    );
  }
  const limit = MAX_ATTACHMENT_BYTES[what.kind];
  if (stored.size > limit) {
    const kind = what.kind === "image" ? "Images" : what.kind === "pdf" ? "PDFs" : "Files";
    throw roomError(
      "invalid",
      `${name} is ${sizeText(stored.size)}. ${kind} can be at most ${sizeText(limit)}; share a link to it instead.`,
    );
  }
  return {
    storageId: item.storageId,
    name,
    kind: what.kind,
    contentType: contentType || "application/octet-stream",
    size: stored.size,
  };
}

/** A random token for an attachment's download link. */
function newToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

/** Keeps checked uploads on a message, after `from` attachments it already has. */
export async function keepAttachments(
  ctx: MutationCtx,
  message: Pick<Doc<"messages">, "_id" | "teamId" | "channelId">,
  items: CheckedAttachment[],
  from: number,
) {
  for (const [i, item] of items.entries()) {
    await ctx.db.insert("attachments", {
      teamId: message.teamId,
      channelId: message.channelId,
      messageId: message._id,
      position: from + i,
      storageId: item.storageId,
      name: item.name,
      kind: item.kind,
      contentType: item.contentType,
      size: item.size,
      token: newToken(),
    });
    await ctx.db.delete(item.uploadId);
  }
}

/**
 * Keeps checked uploads on a message sent into a thread (ADR 0043). Like a chat message's, the upload
 * row goes, so the hourly sweep leaves the bytes alone.
 */
export async function keepThreadAttachments(
  ctx: MutationCtx,
  message: Pick<Doc<"threadMessages">, "_id" | "runId">,
  items: CheckedAttachment[],
) {
  for (const [position, item] of items.entries()) {
    await ctx.db.insert("threadAttachments", {
      runId: message.runId,
      threadMessageId: message._id,
      position,
      storageId: item.storageId,
      name: item.name,
      kind: item.kind,
      contentType: item.contentType,
      size: item.size,
    });
    await ctx.db.delete(item.uploadId);
  }
}

/** A thread message's files, in the order they were sent. */
export async function threadAttachmentsOf(ctx: QueryCtx, message: Pick<Doc<"threadMessages">, "_id" | "attachmentCount">) {
  if (!message.attachmentCount) return [];
  const rows = await ctx.db
    .query("threadAttachments")
    .withIndex("by_message", (q) => q.eq("threadMessageId", message._id))
    .collect();
  return rows.sort((a, b) => a.position - b.position);
}

/**
 * Files as a bridge gets them with a message (ADR 0043): each with the link it downloads the bytes
 * from once. The link is the storage URL, which only the bridge sees: it never reaches the run, the
 * room's views or the thread's conversation.
 */
export async function roomFilesOf(
  ctx: QueryCtx,
  rows: Pick<Doc<"attachments">, "storageId" | "name" | "kind" | "contentType" | "size">[],
) {
  const files = [];
  for (const row of rows) {
    const url = await ctx.storage.getUrl(row.storageId);
    if (url) files.push({ name: row.name, kind: row.kind, mimeType: row.contentType, size: row.size, url });
  }
  return files;
}

/**
 * Keeps files the room stored itself (an agent's file parts over A2A, ADR 0024) on a message it
 * posted, under the same rules as uploads: an SVG is dropped, an image or PDF keeps the type its
 * name says, anything else is only ever offered as a download. Bytes it can't keep are deleted.
 */
export async function keepRoomFiles(
  ctx: MutationCtx,
  message: Pick<Doc<"messages">, "_id" | "teamId" | "channelId">,
  files: { storageId: Id<"_storage">; name: string; contentType: string; size: number }[],
) {
  let position = 0;
  for (const file of files) {
    const name = cleanAttachmentName(file.name) || "file";
    const kind = attachmentKind(name);
    if (kind.kind === "refused" || file.size > MAX_ATTACHMENT_BYTES[kind.kind] || position >= 10) {
      await ctx.storage.delete(file.storageId);
      continue;
    }
    await ctx.db.insert("attachments", {
      teamId: message.teamId,
      channelId: message.channelId,
      messageId: message._id,
      position,
      storageId: file.storageId,
      name,
      kind: kind.kind,
      contentType: kind.kind === "file" ? "application/octet-stream" : kind.type,
      size: file.size,
      token: newToken(),
    });
    position++;
  }
  if (position) await ctx.db.patch(message._id, { attachmentCount: position });
}

export async function attachmentsOf(ctx: QueryCtx, message: Pick<Doc<"messages">, "_id" | "attachmentCount">) {
  if (!message.attachmentCount) return [];
  const rows = await ctx.db
    .query("attachments")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .collect();
  return rows.sort((a, b) => a.position - b.position);
}

/** Removes attachments from a message, deleting bytes nothing else uses. */
export async function dropAttachments(ctx: MutationCtx, rows: Doc<"attachments">[]) {
  for (const row of rows) {
    await ctx.db.delete(row._id);
    await releaseStorage(ctx, row.storageId, { attachmentId: row._id });
  }
}

/** The link that serves an attachment as a download (http.ts), on this deployment's site URL. */
export function downloadUrl(row: Pick<Doc<"attachments">, "token" | "name">): string {
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
  return `${site}/attachments/${row.token}/${encodeURIComponent(row.name)}`;
}

/** How long a link from messages.attachmentLink works. */
export const LINK_TTL_MS = 10 * 60 * 1000;

/**
 * How an attachment is shown. In a team channel, images and PDFs have a `url` the app shows them
 * from (an image inline, a PDF in the sandboxed PDF viewer), and every attachment has a
 * `downloadUrl`, which serves it with `Content-Disposition: attachment`, so other files are never
 * shown or run. In a direct message or private channel (`restricted`) neither is given: a link that
 * outlives someone's membership would let them keep reading what they lost (ADR 0016). Ask
 * messages.attachmentLink for a short-lived one instead.
 */
export async function attachmentView(ctx: QueryCtx, row: Doc<"attachments">, restricted: boolean) {
  return {
    index: row.position,
    name: row.name,
    kind: row.kind,
    contentType: row.contentType,
    size: row.size,
    restricted,
    url: restricted || row.kind === "file" ? null : await ctx.storage.getUrl(row.storageId),
    downloadUrl: restricted ? null : downloadUrl(row),
  };
}

/** The link a grant serves an attachment at (http.ts), on this deployment's site URL. */
export function grantUrl(token: string, name: string): string {
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
  return `${site}/attachments/grant/${token}/${encodeURIComponent(name)}`;
}

/** A `Content-Disposition` value that shows a file in place, under its name. */
export function inlineDisposition(name: string): string {
  return contentDisposition(name).replace(/^attachment;/, "inline;");
}

/** A `Content-Disposition` value that makes a browser save the file under its name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
