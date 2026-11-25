/**
 * Refusals answered, not thrown (ADR 0046).
 *
 * The room says no with `roomError(code, message)`, a thrown `ConvexError`. Convex's exception
 * reporting sends every error a function lets escape to Sentry (docs/error-reports.md), so a
 * refusal the room makes by design arrived there as an uncaught exception. Here a function answers
 * such a refusal as a returned `RoomRefusal` instead, which is a successful execution and is never
 * reported, while a real bug still throws.
 *
 * Who gets a returned refusal:
 * - The internal functions the HTTP endpoint, `live:query` and the remote MCP connector call. Their
 *   only callers ship with the backend and already answer a returned refusal as its error.
 * - A public function's caller that sends `acceptsRefusals: true`: the app, the bridge and
 *   room-client turn the refusal back into the `ConvexError` their code handles. A caller that
 *   doesn't send it (an older app, bridge or command line) gets the thrown error, as before.
 *
 * A mutation answers a refusal only when it has written nothing yet: no document, scheduled
 * function or file. Then answering it changes no data, exactly as throwing would. A refusal after
 * a write is thrown as before, so Convex rolls the writes back (and it is reported).
 */
import { ConvexError, v, type ObjectType, type PropertyValidators } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { ACCEPTS_REFUSALS } from "@uplink-room/protocol/refusals";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { isRoomRefusal, roomRefusal, type RoomErrorCode, type RoomRefusal } from "./errors";

/**
 * The codes of a refusal the room makes by design. `not_configured` isn't one: it means the
 * deployment lacks a setting, which someone has to fix, so it stays an error and stays reported.
 */
const REFUSAL_CODES: ReadonlySet<RoomErrorCode> = new Set<RoomErrorCode>([
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid",
  "conflict",
  "no_free_slot",
  "warning_required",
]);

export { ACCEPTS_REFUSALS };
/** The argument a public function's caller sends to get refusals answered rather than thrown. */
const acceptsRefusalsArg = { [ACCEPTS_REFUSALS]: v.optional(v.literal(true)) };

/**
 * The refusal a thrown error stands for: a `roomError` with one of the refusal codes, marked
 * `thrown` so a client throws it again, else null.
 */
export function refusalOf(error: unknown): RoomRefusal | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) return null;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string") return null;
  if (!REFUSAL_CODES.has(code as RoomErrorCode)) return null;
  return { ...roomRefusal(code as RoomErrorCode, message), thrown: true };
}

/** A refusal as the error a caller that doesn't take answered refusals gets. */
export function refusalError(refusal: RoomRefusal): ConvexError<{ code: RoomErrorCode; message: string }> {
  return new ConvexError({ code: refusal.refused.code, message: refusal.refused.message });
}

/** Runs a query's work, answering a refusal it throws. A query writes nothing, so it always can. */
export async function answerQuery<R>(run: () => Promise<R>): Promise<R | RoomRefusal> {
  try {
    return await run();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    throw error;
  }
}

/** Runs a mutation's work, answering a refusal it throws before writing anything; otherwise rethrows. */
export async function answerMutation<R>(ctx: MutationCtx, run: () => Promise<R>): Promise<R | RoomRefusal> {
  try {
    return await run();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal && !(await wroteAnything(ctx))) return refusal;
    throw error;
  }
}

/** Whether this mutation has written anything Convex would roll back on a throw. */
export async function wroteAnything(ctx: MutationCtx): Promise<boolean> {
  let metrics;
  try {
    metrics = await ctx.meta.getTransactionMetrics();
  } catch {
    // Unknown, so the refusal is thrown and whatever was written rolls back.
    return true;
  }
  // convex-test 0.0.66 reports no `filesWritten`; a mutation can't store a file, so it reads as none.
  const files = (metrics.filesWritten as typeof metrics.filesWritten | undefined)?.used ?? 0;
  return metrics.documentsWritten.used > 0 || metrics.functionsScheduled.used > 0 || files > 0;
}

type PublicDef<Args extends PropertyValidators, Ctx, R> = {
  args: Args;
  handler: (ctx: Ctx, args: ObjectType<Args>) => Promise<R>;
};

/** Splits off `acceptsRefusals`, which only this module reads. */
function split<Args extends PropertyValidators>(all: unknown): { accepts: boolean; args: ObjectType<Args> } {
  const { [ACCEPTS_REFUSALS]: accepts, ...args } = all as Record<string, unknown>;
  return { accepts: accepts === true, args: args as ObjectType<Args> };
}

/**
 * A public query that answers refusals to a caller that sends `acceptsRefusals: true`. Its type is
 * the handler's result: the clients that send the argument turn a `thrown` refusal back into the
 * `ConvexError` before their code sees the result. To any other caller a thrown refusal is thrown
 * again, even one an internal query it called answered (as `live:query` does).
 */
export function publicQuery<Args extends PropertyValidators, R>(
  def: PublicDef<Args, QueryCtx, R>,
): RegisteredQuery<"public", ObjectType<Args>, Promise<R>> {
  return query({
    args: { ...def.args, ...acceptsRefusalsArg },
    handler: async (ctx: QueryCtx, all: unknown) => {
      const { accepts, args } = split<Args>(all);
      if (accepts) return await answerQuery(() => def.handler(ctx, args));
      const result: unknown = await def.handler(ctx, args);
      if (isRoomRefusal(result) && result.thrown) throw refusalError(result);
      return result;
    },
  } as never) as RegisteredQuery<"public", ObjectType<Args>, Promise<R>>;
}

/**
 * A public mutation that answers refusals to a caller that sends `acceptsRefusals: true` (only
 * those thrown before it wrote anything). To any other caller it behaves as a plain mutation: a
 * thrown refusal is thrown, and a refusal the handler returns on purpose so its writes stay (a
 * wrong pair code counted) is returned, as it always was.
 */
export function publicMutation<Args extends PropertyValidators, R>(
  def: PublicDef<Args, MutationCtx, R>,
): RegisteredMutation<"public", ObjectType<Args>, Promise<R>> {
  return mutation({
    args: { ...def.args, ...acceptsRefusalsArg },
    handler: async (ctx: MutationCtx, all: unknown) => {
      const { accepts, args } = split<Args>(all);
      if (accepts) return await answerMutation(ctx, () => def.handler(ctx, args));
      return await def.handler(ctx, args);
    },
  } as never) as RegisteredMutation<"public", ObjectType<Args>, Promise<R>>;
}
