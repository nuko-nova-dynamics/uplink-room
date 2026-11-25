import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { roomError } from "./lib/errors";
import {
  byteLength,
  excalidrawElements,
  formatOf,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  sizeLabel,
  typesFor,
} from "./lib/files";
import { inTeam, memberView } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { fileInTeam, mergeElements } from "./lib/fileAccess";
import { attachmentsOf, releaseStorage, storageInUse } from "./lib/attachments";
import { messageAccess } from "./lib/channels";


async function byName(ctx: QueryCtx, projectId: Id<"projects">, name: string) {
  return await ctx.db
    .query("files")
    .withIndex("by_project_name", (q) => q.eq("projectId", projectId).eq("name", name))
    .unique();
}

function checkText(content: string): number {
  const size = byteLength(content);
  if (size > MAX_TEXT_BYTES) throw roomError("invalid", `Docs and HTML pages can be at most ${sizeLabel(MAX_TEXT_BYTES)}.`);
  return size;
}

export const { person: save, agent: saveAgent } = roomMutation({
  name: "files.save",
  description:
    "Create or replace a doc (.md, Markdown), an HTML page (.html) or a canvas (.excalidraw) in a project. A doc renders as rich text and an HTML page in a sandboxed frame. For a canvas, `content` is an Excalidraw file's JSON (its shapes are merged in) or empty. To change a doc without overwriting someone's edits, use files.edit. With `onlyIfNew`, a name the project already has is refused instead of replaced.",
  scope: "work.manage",
  args: { projectId: v.id("projects"), name: v.string(), content: v.string(), onlyIfNew: v.optional(v.boolean()) },
  handler: async (ctx, actor, args) => {
    const project = await inTeam(ctx, actor, args.projectId);
    const name = args.name.trim();
    const format = formatOf(name);
    if (format === "pdf" || format === "image") {
      throw roomError("invalid", "Upload PDFs and images with files.uploadUrl and files.addUpload.");
    }
    const existing = await byName(ctx, project._id, name);
    // Creating a file must never replace one: the check and the insert are one transaction.
    if (existing && args.onlyIfNew) {
      throw roomError("conflict", `This project already has a file named ${name}. Pick another name, or open that file.`);
    }
    const stamp = { updatedBy: actor.member._id, updatedAt: Date.now() };

    if (format === "canvas") {
      const elements = excalidrawElements(args.content);
      const fileId =
        existing?._id ??
        (await ctx.db.insert("files", { teamId: actor.teamId, projectId: project._id, name, format, size: 0, ...stamp }));
      if (existing) await ctx.db.patch(existing._id, stamp);
      await mergeElements(ctx, fileId, elements);
      return fileId;
    }

    const size = checkText(args.content);
    if (existing) {
      await ctx.db.patch(existing._id, { content: args.content, size, version: (existing.version ?? 1) + 1, ...stamp });
      return existing._id;
    }
    return await ctx.db.insert("files", {
      teamId: actor.teamId,
      projectId: project._id,
      name,
      format,
      content: args.content,
      size,
      version: 1,
      ...stamp,
    });
  },
});

export const { person: edit, agent: editAgent } = roomMutation({
  name: "files.edit",
  description:
    "Change a doc's Markdown or an HTML page's source. `baseVersion` is the version you read (files.get); if someone saved since, this fails with `conflict` and nothing is overwritten. Returns the new version.",
  scope: "work.manage",
  args: { fileId: v.id("files"), content: v.string(), baseVersion: v.number() },
  handler: async (ctx, actor, args) => {
    const file = await fileInTeam(ctx, actor, args.fileId);
    if (file.format !== "markdown" && file.format !== "html") {
      throw roomError("invalid", "Only docs and HTML pages are edited as text.");
    }
    const version = file.version ?? 1;
    if (args.baseVersion !== version) {
      const by = await memberView(ctx, file.updatedBy);
      throw roomError(
        "conflict",
        `${by.name} changed this file since version ${args.baseVersion}; it is at version ${version}. Read it again, then save.`,
      );
    }
    const size = checkText(args.content);
    await ctx.db.patch(file._id, {
      content: args.content,
      size,
      version: version + 1,
      updatedBy: actor.member._id,
      updatedAt: Date.now(),
    });
    return { version: version + 1 };
  },
});

export const { person: uploadUrl, agent: uploadUrlAgent } = roomMutation({
  name: "files.uploadUrl",
  description:
    "A URL to upload a PDF or image to, valid for one hour, and its `uploadId`. POST the bytes with their Content-Type; the response is { storageId }. Then keep it with files.addUpload, passing both ids. PDFs can be up to 50 MB, images (PNG, JPEG, GIF, WebP) up to 20 MB.",
  scope: "work.manage",
  args: {},
  agentAudit: false,
  handler: async (ctx, actor) => {
    // Convex can't tag bytes as they arrive, so the upload is recorded here, with its team and
    // uploader, and files.addUpload binds the bytes to it (spec #9).
    const uploadId = await ctx.db.insert("uploads", { teamId: actor.teamId, uploaderId: actor.member._id });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId };
  },
});

/** Deletes a file's stored bytes unless another file, or a message attachment, still uses them. */
export async function releaseBytes(ctx: MutationCtx, storageId: Id<"_storage">, exceptFileId: Id<"files">) {
  await releaseStorage(ctx, storageId, { fileId: exceptFileId });
}

/**
 * Refuses an upload. Its bytes can't be deleted here: the error rolls the whole
 * mutation back, deletes included. `sweepUploads` deletes them within the hour.
 */
function refuse(message: string): never {
  throw roomError("invalid", message);
}

/** How long an upload may wait for files.addUpload before it is deleted. */
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;

/**
 * Deletes uploads more than an hour old that no file keeps (refused ones, and ones never
 * added), and upload records that were never used.
 */
export const sweepUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - UPLOAD_GRACE_MS;
    for await (const upload of ctx.db.query("uploads")) {
      if (upload._creationTime <= cutoff) await ctx.db.delete(upload._id);
    }
    // A Pair's upload URLs too (ADR 0048): a message keeps its file and deletes the row at once.
    for await (const upload of ctx.db.query("pairUploads")) {
      if (upload._creationTime <= cutoff) await ctx.db.delete(upload._id);
    }
    let deleted = 0;
    for await (const stored of ctx.db.system.query("_storage")) {
      if (stored._creationTime > cutoff) continue;
      // Kept by a project file, a message attachment (a Pair's too), or a link preview's image.
      const kept = await storageInUse(ctx, stored._id);
      if (!kept) {
        await ctx.storage.delete(stored._id);
        deleted++;
      }
    }
    return { deleted };
  },
});

export const { person: addUpload, agent: addUploadAgent } = roomMutation({
  name: "files.addUpload",
  description:
    "Keep an uploaded PDF or image in a project under `name`, replacing a file with the same name. Pass the `uploadId` files.uploadUrl gave you and the `storageId` the upload returned. The name's extension must match the upload's type.",
  scope: "work.manage",
  args: { projectId: v.id("projects"), name: v.string(), uploadId: v.id("uploads"), storageId: v.id("_storage") },
  handler: async (ctx, actor, args) => {
    const project = await inTeam(ctx, actor, args.projectId);
    // The bytes must come through an upload URL this member asked for in this team, after it was
    // issued, and no file may keep them yet: an id from another team or another file is refused.
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.teamId !== actor.teamId) {
      throw roomError("not_found", "No such upload. Ask files.uploadUrl for a new upload URL.");
    }
    if (upload.uploaderId !== actor.member._id) throw roomError("forbidden", "That's someone else's upload.");
    const stored = await ctx.db.system.get(args.storageId);
    if (!stored) throw roomError("not_found", "No such upload. Upload the file again.");
    if (await storageInUse(ctx, args.storageId)) {
      throw roomError("invalid", "That upload is already kept in a file. Upload the bytes again.");
    }
    if (stored._creationTime < upload._creationTime) {
      throw roomError("invalid", "Those bytes were stored before this upload URL was issued. Upload them to it again.");
    }
    const name = args.name.trim();
    let format;
    try {
      format = formatOf(name);
    } catch {
      refuse(`${name} can't be kept: upload a PDF or a PNG, JPEG, GIF or WebP image.`);
    }
    if (format !== "pdf" && format !== "image") {
      refuse("Only PDFs and images are uploaded. Save docs, HTML pages and canvases with files.save.");
    }
    const contentType = stored.contentType ?? "";
    if (!typesFor(name).includes(contentType)) {
      const what = format === "pdf" ? "a PDF" : `a ${typesFor(name)[0]?.replace("image/", "").toUpperCase()} image`;
      refuse(`This upload isn't ${what} (its type is ${contentType || "unknown"}).`);
    }
    const limit = MAX_UPLOAD_BYTES[format];
    if (stored.size > limit) {
      refuse(`${format === "pdf" ? "PDFs" : "Images"} can be at most ${sizeLabel(limit)}.`);
    }

    const fields = {
      storageId: args.storageId,
      contentType,
      size: stored.size,
      updatedBy: actor.member._id,
      updatedAt: Date.now(),
    };
    await ctx.db.delete(upload._id);
    const existing = await byName(ctx, project._id, name);
    if (existing) {
      const old = existing.storageId;
      await ctx.db.patch(existing._id, fields);
      if (old) await releaseBytes(ctx, old, existing._id);
      return existing._id;
    }
    return await ctx.db.insert("files", { teamId: actor.teamId, projectId: project._id, name, format, ...fields });
  },
});

async function openComments(ctx: QueryCtx, fileId: Id<"files">): Promise<number> {
  const comments = await ctx.db
    .query("comments")
    .withIndex("by_file", (q) => q.eq("fileId", fileId))
    .collect();
  return comments.filter((c) => c.pin !== undefined && c.resolvedAt === undefined).length;
}

export const { person: list, agent: listAgent } = roomQuery({
  name: "files.list",
  description:
    "List a project's files by name: docs (markdown), HTML pages, canvases, PDFs and images, with size, version, who changed each last, and how many open pinned comments each has.",
  scope: "room.read",
  args: { projectId: v.id("projects") },
  handler: async (ctx, actor, args) => {
    const project = await inTeam(ctx, actor, args.projectId);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project_name", (q) => q.eq("projectId", project._id))
      .collect();
    return Promise.all(
      files.map(async (f) => ({
        fileId: f._id,
        name: f.name,
        format: f.format,
        size: f.size ?? (f.content !== undefined ? byteLength(f.content) : 0),
        ...(f.format === "markdown" || f.format === "html" ? { version: f.version ?? 1 } : {}),
        updatedAt: f.updatedAt,
        updatedBy: await memberView(ctx, f.updatedBy),
        openComments: await openComments(ctx, f._id),
      })),
    );
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "files.get",
  description:
    "One file. Docs and HTML pages come with their text (`content`) and `version`; PDFs and images with a download `url`, `size` and `contentType`; canvases with their shape count (read the shapes with canvas.scene).",
  scope: "room.read",
  args: { fileId: v.id("files") },
  handler: async (ctx, actor, args) => {
    const file = await fileInTeam(ctx, actor, args.fileId);
    const common = {
      fileId: file._id,
      projectId: file.projectId,
      name: file.name,
      format: file.format,
      updatedAt: file.updatedAt,
      updatedBy: await memberView(ctx, file.updatedBy),
    };
    switch (file.format) {
      case "markdown":
      case "html":
        return { ...common, content: file.content ?? "", version: file.version ?? 1 };
      case "pdf":
      case "image":
        return {
          ...common,
          url: file.storageId ? await ctx.storage.getUrl(file.storageId) : null,
          size: file.size ?? 0,
          contentType: file.contentType ?? "",
        };
      case "canvas": {
        const elements = await ctx.db
          .query("canvasElements")
          .withIndex("by_file_element", (q) => q.eq("fileId", file._id))
          .collect();
        return { ...common, size: file.size ?? 0, elementCount: elements.filter((e) => !e.isDeleted).length };
      }
    }
  },
});

// `delete` is a reserved word, so the person function is exported under it by alias.
const deleteFns = roomMutation({
  name: "files.delete",
  description: "Delete a file from its project, with its stored bytes, its canvas shapes and its pinned comments.",
  scope: "work.manage",
  args: { fileId: v.id("files") },
  handler: async (ctx, actor, args) => {
    const file = await fileInTeam(ctx, actor, args.fileId);
    if (file.storageId) await releaseBytes(ctx, file.storageId, file._id);
    for (const element of await ctx.db
      .query("canvasElements")
      .withIndex("by_file_element", (q) => q.eq("fileId", file._id))
      .collect()) {
      await ctx.db.delete(element._id);
    }
    for (const comment of await ctx.db
      .query("comments")
      .withIndex("by_file", (q) => q.eq("fileId", file._id))
      .collect()) {
      await ctx.db.delete(comment._id);
    }
    await ctx.db.delete(file._id);
    return null;
  },
});
const remove = deleteFns.person;
export const deleteAgent = deleteFns.agent;
export { remove as delete };

export const { person: saveAttachment, agent: saveAttachmentAgent } = roomMutation({
  name: "files.saveAttachment",
  description:
    "Keep a message's image or PDF attachment in a project's files (attachmentIndex counts from 0), under its own name or `name`. The project file shares the stored bytes, so deleting the message later leaves the project's copy. A name the project already has is refused. Other kinds of attachment can't be project files.",
  scope: "work.manage",
  args: {
    messageId: v.id("messages"),
    attachmentIndex: v.number(),
    projectId: v.id("projects"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, actor, args) => {
    const { message } = await messageAccess(ctx, actor, args.messageId);
    const attachment = (await attachmentsOf(ctx, message)).find((a) => a.position === args.attachmentIndex);
    if (!attachment) throw roomError("not_found", `That message has no attachment ${args.attachmentIndex}.`);
    if (attachment.kind === "file") {
      throw roomError("invalid", "Only images and PDFs can be kept in a project's files. Download this one instead.");
    }
    const project = await inTeam(ctx, actor, args.projectId);
    if (project.archivedAt !== undefined) throw roomError("invalid", "That project is archived.");
    const name = (args.name ?? attachment.name).trim();
    if (formatOf(name) !== attachment.kind || !typesFor(name).includes(attachment.contentType)) {
      throw roomError("invalid", `${name} doesn't match what the attachment is. Keep its extension.`);
    }
    if (await byName(ctx, project._id, name)) {
      throw roomError("conflict", `This project already has a file named ${name}. Pick another name.`);
    }
    return await ctx.db.insert("files", {
      teamId: actor.teamId,
      projectId: project._id,
      name,
      format: attachment.kind,
      storageId: attachment.storageId,
      contentType: attachment.contentType,
      size: attachment.size,
      updatedBy: actor.member._id,
      updatedAt: Date.now(),
    });
  },
});
