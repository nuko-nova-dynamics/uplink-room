/**
 * Files in Pairs (ADR 0048). A Pair message carries files the way a chat message does (spec #63):
 * the same kinds and sizes, up to MAX_ATTACHMENTS, uploaded to a URL the room issues and then kept
 * by the message. Pairs are outside every team, so their uploads (`pairUploads`) and files
 * (`pairAttachments`) are tables of their own, as every Pair table is (ADR 0029 D9).
 *
 * - An upload is issued to one author: one of a Pair's people for that Pair (`pairs.attachUrl`), one
 *   of its agents (`pairs.attachUrl` with its key), or a joined run in no team (`joined.attachUrl`).
 *   A joined run in a team uploads as its driver in the team (`uploads`), as it does for a team
 *   place (ADR 0047), and its Pair message keeps that upload too.
 * - A file has no lasting link. A Convex storage URL works for anyone who has it until the bytes are
 *   deleted, and someone who leaves a Pair must stop reading it, so each look goes through a
 *   short-lived grant (`pairAttachmentGrants`), served at `/attachments/pair/<token>` only while the
 *   person, agent or run it was made for is still in the Pair: what ADR 0016 does for a direct
 *   message's files.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { memberStillActs } from "./actor";
import { checkUploadedBytes, LINK_TTL_MS, type CheckedAttachment } from "./attachments";
import { sha256 } from "./crypto";
import { roomError } from "./errors";
import { MAX_ATTACHMENTS } from "./messages";

/** A file to send in a Pair: an upload issued for it, and the bytes stored there. */
export const vNewPairAttachment = v.object({
  uploadId: v.id("pairUploads"),
  storageId: v.id("_storage"),
  name: v.string(),
});

/** What `joined.say` takes: a team run's upload (`uploads`) or a Pair upload, for a team place or a Pair. */
export const vNewRunAttachment = v.object({
  uploadId: v.union(v.id("uploads"), v.id("pairUploads")),
  storageId: v.id("_storage"),
  name: v.string(),
});

export type NewPairAttachment = { uploadId: Id<"pairUploads"> | Id<"uploads">; storageId: Id<"_storage">; name: string };

/** Who posts a Pair message, as far as its files go: whose uploads it may keep. */
export type PairUploader =
  | { kind: "person"; personId: Id<"people"> }
  | { kind: "agent"; agentRow: Doc<"pairAgents"> }
  /** A joined run; `teamMemberId` is its driver's member when the run is in a team. */
  | { kind: "run"; pairRun: Doc<"pairRuns">; teamMemberId?: Id<"members"> };

export type CheckedPairAttachment = Omit<CheckedAttachment, "uploadId"> & {
  upload: { table: "pairUploads"; id: Id<"pairUploads"> } | { table: "uploads"; id: Id<"uploads"> };
};

const NO_UPLOAD = "No such upload. Ask for a new upload URL (pairs.attachUrl, or joined.attachUrl in a run).";
const NOT_YOURS = "That upload was issued to someone else, or for another Pair.";

/** Whether a Pair upload was issued to this author, for this Pair. */
function issuedTo(upload: Doc<"pairUploads">, pairId: Id<"pairs">, author: PairUploader): boolean {
  switch (author.kind) {
    case "person":
      return upload.by.kind === "person" && upload.by.pairId === pairId && upload.personId === author.personId;
    case "agent":
      return upload.by.kind === "agent" && upload.by.pairAgentId === author.agentRow._id;
    case "run":
      return upload.by.kind === "run" && upload.by.sessionId === author.pairRun.sessionId;
  }
}

/**
 * Checks the files a Pair message would keep, before anything is written: each upload was issued to
 * its author, for this Pair, and its bytes are ones a message takes (lib/attachments.ts). A refused
 * file refuses the message, and its bytes stay until the hourly sweep deletes them.
 */
export async function checkPairAttachments(
  ctx: QueryCtx,
  pairId: Id<"pairs">,
  author: PairUploader,
  items: { uploadId: string; storageId: Id<"_storage">; name: string }[],
): Promise<CheckedPairAttachment[]> {
  if (items.length > MAX_ATTACHMENTS) throw roomError("invalid", `A message can have at most ${MAX_ATTACHMENTS} attachments.`);
  const checked: CheckedPairAttachment[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    // The same bytes twice would be two rows over one stored file: nothing else keeps them yet, so
    // the per-file check can't see it.
    if (seen.has(item.storageId) || seen.has(item.uploadId)) throw roomError("invalid", "The same upload is attached twice.");
    seen.add(item.storageId);
    seen.add(item.uploadId);
    const pairUploadId = ctx.db.normalizeId("pairUploads", item.uploadId);
    if (pairUploadId) {
      const upload = await ctx.db.get(pairUploadId);
      if (!upload) throw roomError("not_found", NO_UPLOAD);
      if (!issuedTo(upload, pairId, author)) throw roomError("forbidden", NOT_YOURS);
      const bytes = await checkUploadedBytes(ctx, item, upload._creationTime);
      checked.push({ ...bytes, upload: { table: "pairUploads", id: pairUploadId } });
      continue;
    }
    // A joined run in a team uploads as its driver in that team (joined.attachUrl, ADR 0047).
    const teamUploadId = ctx.db.normalizeId("uploads", item.uploadId);
    if (!teamUploadId) throw roomError("not_found", NO_UPLOAD);
    const upload = await ctx.db.get(teamUploadId);
    if (!upload) throw roomError("not_found", NO_UPLOAD);
    if (author.kind !== "run" || !author.teamMemberId || upload.uploaderId !== author.teamMemberId) {
      throw roomError("forbidden", NOT_YOURS);
    }
    const bytes = await checkUploadedBytes(ctx, item, upload._creationTime);
    checked.push({ ...bytes, upload: { table: "uploads", id: teamUploadId } });
  }
  return checked;
}

/** Keeps checked files on a Pair message, in the order they were sent; their upload rows go. */
export async function keepPairAttachments(ctx: MutationCtx, message: Pick<Doc<"pairMessages">, "_id" | "pairId">, items: CheckedPairAttachment[]) {
  for (const [position, item] of items.entries()) {
    await ctx.db.insert("pairAttachments", {
      pairId: message.pairId,
      messageId: message._id,
      position,
      storageId: item.storageId,
      name: item.name,
      kind: item.kind,
      contentType: item.contentType,
      size: item.size,
    });
    await ctx.db.delete(item.upload.id);
  }
}

/** A Pair message's files, in the order they were sent. */
export async function pairAttachmentsOf(ctx: QueryCtx, message: Pick<Doc<"pairMessages">, "_id" | "attachmentCount">) {
  if (!message.attachmentCount) return [];
  const rows = await ctx.db
    .query("pairAttachments")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .collect();
  return rows.sort((a, b) => a.position - b.position);
}

/**
 * How a Pair's file is shown: as a direct message's is (lib/attachments.ts `attachmentView`), with no
 * lasting link. Ask pairs.attachmentLink for a short-lived one.
 */
export function pairAttachmentView(row: Doc<"pairAttachments">) {
  return {
    index: row.position,
    name: row.name,
    kind: row.kind,
    contentType: row.contentType,
    size: row.size,
    restricted: true as const,
    url: null,
    downloadUrl: null,
  };
}

/** Who a grant is for: one of a Pair's people, agents or runs. */
export type PairGrantee = Doc<"pairAttachmentGrants">["by"];

/** The link a Pair grant serves its file at (http.ts), on this deployment's site URL. */
export function pairGrantUrl(token: string, name: string): string {
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
  return `${site}/attachments/pair/${token}/${encodeURIComponent(name)}`;
}

/**
 * A short-lived link to one Pair file for `by`, which works for LINK_TTL_MS and only while `by` is
 * still in the Pair. `download` serves it as a download; a file that isn't an image or a PDF always is.
 */
export async function grantPairAttachment(ctx: MutationCtx, row: Doc<"pairAttachments">, by: PairGrantee, download: boolean) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = Date.now() + LINK_TTL_MS;
  await ctx.db.insert("pairAttachmentGrants", {
    attachmentId: row._id,
    by,
    tokenHash: await sha256(token),
    download: download || row.kind === "file",
    expiresAt,
  });
  return { url: pairGrantUrl(token, row.name), expiresAt };
}

/**
 * Whether a grant's person, agent or run is still in its file's Pair. A person reads an ended Pair
 * still (`pairs.end`); an agent or a run is in it only while it hasn't left, and none is once it ends.
 * An agent also acts only while it and its person are still in its team, as its key does
 * (`pairAgentForKey`): removing either stops its links too.
 */
async function stillIn(ctx: QueryCtx, pairId: Id<"pairs">, by: PairGrantee): Promise<boolean> {
  switch (by.kind) {
    case "person": {
      const row = await ctx.db
        .query("pairPeople")
        .withIndex("by_pair_person", (q) => q.eq("pairId", pairId).eq("personId", by.personId))
        .unique();
      return row !== null && row.removedAt === undefined;
    }
    case "agent": {
      const row = await ctx.db.get(by.pairAgentId);
      return (
        row !== null &&
        row.pairId === pairId &&
        row.leftAt === undefined &&
        (await keyStillJoins(ctx, by.agentKeyId)) &&
        (await memberStillActs(ctx, row.memberId))
      );
    }
    case "run": {
      const row = await ctx.db.get(by.pairRunId);
      return row !== null && row.pairId === pairId && row.endedAt === undefined;
    }
  }
}

/**
 * Whether the key an agent's link was made with still acts in Pairs: not revoked, and still holding
 * pairs.join. A link from before links recorded their key lasted minutes, so it serves nothing now.
 */
async function keyStillJoins(ctx: QueryCtx, agentKeyId: Id<"agentKeys"> | undefined): Promise<boolean> {
  if (!agentKeyId) return false;
  const key = await ctx.db.get(agentKeyId);
  return !!key && key.revokedAt === undefined && key.scopes.includes("pairs.join");
}

/**
 * What a Pair grant link may serve (http.ts), by its token's hash. The caller compares `expiresAt`
 * with the time itself: a query's answer may be a cached one.
 */
export async function pairGrantFor(ctx: QueryCtx, tokenHash: string) {
  const grant = await ctx.db
    .query("pairAttachmentGrants")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!grant) return null;
  const row = await ctx.db.get(grant.attachmentId);
  const allowed = row !== null && (await ctx.db.get(row.messageId)) !== null && (await stillIn(ctx, row.pairId, grant.by));
  if (!allowed || !row) return { allowed: false as const, expiresAt: grant.expiresAt };
  return {
    allowed: true as const,
    expiresAt: grant.expiresAt,
    download: grant.download,
    storageId: row.storageId,
    name: row.name,
    kind: row.kind,
    contentType: row.contentType,
  };
}

/** Deletes expired Pair file links, at most `step` of them; returns how many it deleted. */
export async function prunePairGrants(ctx: MutationCtx, step: number): Promise<number> {
  const old = await ctx.db
    .query("pairAttachmentGrants")
    .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
    .take(step);
  for (const grant of old) await ctx.db.delete(grant._id);
  return old.length;
}
