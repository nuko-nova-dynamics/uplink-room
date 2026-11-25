/**
 * Refusals answered, not thrown (ADR 0046): the half the room's clients share.
 *
 * A client that sends `acceptsRefusals: true` with a call gets a refusal the room threw (forbidden,
 * not_found and the rest) as the value `{ refused: { code, message }, thrown: true }` instead of a
 * thrown `ConvexError`, so Convex doesn't report it to Sentry as an uncaught exception. The client
 * turns it straight back into the `ConvexError` the room used to throw, so the code that called
 * sees no difference. A refusal a function returns on purpose (a wrong pair code, which `pairs.join`
 * counts) has no `thrown`, and stays the value the code that called reads.
 */
import { ConvexError } from "convex/values";
import type { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

/** The argument a client adds to every query and mutation it calls to take refusals answered. */
export const ACCEPTS_REFUSALS = "acceptsRefusals";

/** A refusal from the room. Its codes are the Room API's (packages/backend/convex/lib/errors.ts). */
export type Refusal = { refused: { code: string; message: string }; thrown?: true };

export function isRefusal(value: unknown): value is Refusal {
  if (typeof value !== "object" || value === null || !("refused" in value)) return false;
  const refused = (value as { refused: unknown }).refused;
  return (
    typeof refused === "object" &&
    refused !== null &&
    typeof (refused as { code?: unknown }).code === "string" &&
    typeof (refused as { message?: unknown }).message === "string"
  );
}

/** A refusal as the error the room threw for it: a `ConvexError` with `{ code, message }`. */
export function refusalError(refusal: Refusal): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: refusal.refused.code, message: refusal.refused.message });
}

/** A refusal the room threw and answered in its place, which the client throws again. */
export function isThrownRefusal(value: unknown): value is Refusal & { thrown: true } {
  return isRefusal(value) && value.thrown === true;
}

/** The value, or, when it is a refusal the room threw, its error thrown. */
export function unwrapRefusal<T>(value: T): T {
  if (isThrownRefusal(value)) throw refusalError(value);
  return value;
}

/** A call's arguments with `acceptsRefusals: true` added. */
export function withAcceptsRefusals(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...args, [ACCEPTS_REFUSALS]: true };
}

/** A call's arguments without `acceptsRefusals`, as the code that made the call passed them. */
export function withoutAcceptsRefusals(args: Record<string, unknown>): Record<string, unknown> {
  const { [ACCEPTS_REFUSALS]: _accepts, ...rest } = args;
  return rest;
}

/**
 * A `ConvexClient`'s calls with `acceptsRefusals`: a mutation's thrown refusal rejects with its
 * `ConvexError`, and a watched query's goes to `onError`, as the thrown error did.
 */
export function acceptingRefusals(client: ConvexClient) {
  return {
    async mutation<M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>> {
      return unwrapRefusal(await client.mutation(ref, withAcceptsRefusals(args) as FunctionArgs<M>));
    },
    onUpdate<Q extends FunctionReference<"query">>(
      ref: Q,
      args: FunctionArgs<Q>,
      onUpdate: (result: FunctionReturnType<Q>) => unknown,
      onError?: (error: Error) => unknown,
    ): () => void {
      return client.onUpdate(
        ref,
        withAcceptsRefusals(args) as FunctionArgs<Q>,
        (result) => {
          if (isThrownRefusal(result)) onError?.(refusalError(result));
          else onUpdate(result);
        },
        onError,
      );
    },
  };
}
