/**
 * Idempotency keys for the Room API's writes that callers retry (messages.post, tasks.create,
 * tasks.createMany, runs.report). An agent whose call timed out after the write landed sends the
 * same call again with the same key, and gets the first call's result instead of a second message
 * or task. A key is the caller's: the same member, function and key within a day count as one
 * write. The same key with different arguments is refused with conflict, so a reused key never
 * hides a different write.
 */
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { sha256 } from "./crypto";
import { roomError } from "./errors";

/** How long a key holds: past this, the same key writes again. */
export const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const MAX_KEY_LENGTH = 200;

export const vIdempotencyKey = v.optional(v.string());

export const IDEMPOTENCY_DOC = `A key you choose (at most ${MAX_KEY_LENGTH} characters), such as a UUID: sending the same call again with the same key within a day returns the first call's result and writes nothing again, so retry with it after a timeout. The same key with different arguments is refused with conflict`;

/** Object keys sorted, so the same arguments hash the same however a client ordered them. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/**
 * Runs `write` once per key: with no key, every time. With a key used within the day for the same
 * function and arguments, returns what that call returned and writes nothing.
 */
export async function once<R>(
  ctx: MutationCtx,
  actor: Actor,
  fn: string,
  key: string | undefined,
  args: Record<string, unknown>,
  write: () => Promise<R>,
): Promise<R> {
  if (key === undefined) return write();
  if (!key.trim() || key.length > MAX_KEY_LENGTH) {
    throw roomError("invalid", `idempotencyKey must be 1 to ${MAX_KEY_LENGTH} characters.`);
  }
  const { idempotencyKey: _ignored, ...rest } = args;
  const fingerprint = await sha256(JSON.stringify(stable(rest)));
  const now = Date.now();
  const seen = await ctx.db
    .query("idempotentWrites")
    .withIndex("by_member_fn_key", (q) => q.eq("memberId", actor.member._id).eq("fn", fn).eq("key", key))
    .first();
  if (seen && seen.at > now - IDEMPOTENCY_MS) {
    if (seen.fingerprint !== fingerprint) {
      throw roomError("conflict", `idempotencyKey ${key} was already used for a different ${fn} call. Use a new key for a new write.`);
    }
    return seen.result as R;
  }
  if (seen) await ctx.db.delete(seen._id);
  const result = await write();
  await ctx.db.insert("idempotentWrites", { teamId: actor.teamId, memberId: actor.member._id, fn, key, fingerprint, result: result ?? null, at: now });
  return result;
}

/** At most this many expired keys are deleted per step. */
const PRUNE_BATCH = 500;

/** Deletes keys past their day, a batch at a time, scheduling itself again while more remain. */
export async function pruneIdempotentWrites(ctx: MutationCtx): Promise<boolean> {
  const old = await ctx.db
    .query("idempotentWrites")
    .withIndex("by_at", (q) => q.lt("at", Date.now() - IDEMPOTENCY_MS))
    .take(PRUNE_BATCH);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length === PRUNE_BATCH;
}
