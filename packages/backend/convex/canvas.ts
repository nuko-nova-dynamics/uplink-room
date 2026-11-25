import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { roomError } from "./lib/errors";
import { drawShapes, vShape } from "./lib/files";
import { roomMutation, roomQuery } from "./lib/room";
import { fileInTeam, mergeElements } from "./lib/fileAccess";


async function canvasFile(ctx: Parameters<typeof fileInTeam>[0], actor: Parameters<typeof fileInTeam>[1], fileId: Id<"files">) {
  const file = await fileInTeam(ctx, actor, fileId);
  if (file.format !== "canvas") throw roomError("invalid", "That file isn't a canvas.");
  return file;
}

export const { person: scene, agent: sceneAgent } = roomQuery({
  name: "canvas.scene",
  description:
    "Every shape on a canvas, as Excalidraw JSON (id, type, x, y, width, height, text, version, ...). Deleted shapes are included with isDeleted: true, so edits merge correctly.",
  scope: "room.read",
  args: { fileId: v.id("files") },
  handler: async (ctx, actor, args) => {
    const file = await canvasFile(ctx, actor, args.fileId);
    const rows = await ctx.db
      .query("canvasElements")
      .withIndex("by_file_element", (q) => q.eq("fileId", file._id))
      .collect();
    return { elements: rows.map((row) => JSON.parse(row.data) as Record<string, unknown>) };
  },
});

export const { person: save, agent: saveAgent } = roomMutation({
  name: "canvas.save",
  description:
    "Save changed shapes on a canvas (Excalidraw JSON). A shape replaces the stored one only if its `version` is higher (or equal with a lower `versionNonce`), so to change a shape, bump its version. To delete one, save it with isDeleted: true. Embedded web pages and images are refused.",
  scope: "work.manage",
  args: { fileId: v.id("files"), elements: v.array(v.any()) },
  handler: async (ctx, actor, args) => {
    const file = await canvasFile(ctx, actor, args.fileId);
    const accepted = await mergeElements(ctx, file._id, args.elements);
    if (accepted > 0) await ctx.db.patch(file._id, { updatedBy: actor.member._id, updatedAt: Date.now() });
    return { accepted };
  },
});

export const { person: draw, agent: drawAgent } = roomMutation({
  name: "canvas.draw",
  description:
    "Add shapes to a canvas by describing them: rectangle, ellipse, diamond (with an optional `label` inside), arrow (from x,y by width,height) or text. Positions are canvas coordinates; colours are hex strings. Returns the new shapes' ids.",
  scope: "work.manage",
  args: { fileId: v.id("files"), shapes: v.array(vShape) },
  handler: async (ctx, actor, args) => {
    const file = await canvasFile(ctx, actor, args.fileId);
    const elements = drawShapes(args.shapes);
    await mergeElements(ctx, file._id, elements);
    await ctx.db.patch(file._id, { updatedBy: actor.member._id, updatedAt: Date.now() });
    // A label is part of its shape, so only the shapes asked for are returned.
    const labels = new Set(elements.filter((e) => e["containerId"]).map((e) => e.id));
    return { elementIds: elements.filter((e) => !labels.has(e.id)).map((e) => e.id) };
  },
});
