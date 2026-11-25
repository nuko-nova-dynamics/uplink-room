/** Loading files and merging canvas shapes, shared by the files, canvas and comments modules. */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { roomError } from "./errors";
import { byteLength, cleanElement, isNewer, MAX_CANVAS_BYTES, MAX_ELEMENTS_PER_SAVE, sizeLabel } from "./files";
import { canSeeId } from "./channels";

/**
 * A file the actor can see, or "No such file.": one in the actor's team whose project the actor can
 * see, so a private channel's project files stay with its members and a channel-limited agent key
 * (ADR 0049) reaches only the files of its channels' projects.
 */
export async function fileInTeam(ctx: QueryCtx, actor: Actor, fileId: Id<"files">): Promise<Doc<"files">> {
  const file = await ctx.db.get(fileId);
  if (!file || file.teamId !== actor.teamId) throw roomError("not_found", "No such file.");
  if (!(await fileVisible(ctx, actor, file))) throw roomError("not_found", "No such file.");
  return file;
}

/** Whether the actor can see the channel of the file's project. */
export async function fileVisible(ctx: QueryCtx, actor: Actor, file: Pick<Doc<"files">, "projectId">): Promise<boolean> {
  const project = await ctx.db.get(file.projectId);
  return project !== null && (await canSeeId(ctx, actor, project.channelId));
}

/**
 * Merges shapes into a canvas, Excalidraw's way: a shape replaces the stored one
 * only when it is newer (ADR 0010). Returns how many shapes were taken.
 */
export async function mergeElements(ctx: MutationCtx, fileId: Id<"files">, raw: unknown[]): Promise<number> {
  if (raw.length > MAX_ELEMENTS_PER_SAVE) {
    throw roomError("invalid", `Save at most ${MAX_ELEMENTS_PER_SAVE} shapes at a time.`);
  }
  const file = (await ctx.db.get(fileId))!;
  let size = file.size ?? 0;
  let accepted = 0;
  for (const item of raw) {
    const { element, data } = cleanElement(item);
    const stored = await ctx.db
      .query("canvasElements")
      .withIndex("by_file_element", (q) => q.eq("fileId", fileId).eq("elementId", element.id))
      .unique();
    const row = {
      version: element.version,
      versionNonce: element.versionNonce,
      isDeleted: element.isDeleted === true,
      data,
    };
    if (stored) {
      if (!isNewer(element, stored)) continue;
      size += byteLength(data) - byteLength(stored.data);
      await ctx.db.patch(stored._id, row);
    } else {
      size += byteLength(data);
      await ctx.db.insert("canvasElements", { fileId, elementId: element.id, ...row });
    }
    accepted++;
  }
  if (size > MAX_CANVAS_BYTES) {
    throw roomError("invalid", `A canvas can hold at most ${sizeLabel(MAX_CANVAS_BYTES)} of shapes.`);
  }
  if (accepted > 0) await ctx.db.patch(fileId, { size });
  return accepted;
}
