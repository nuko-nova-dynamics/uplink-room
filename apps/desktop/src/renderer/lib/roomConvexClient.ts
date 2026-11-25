/**
 * The app's Convex client: it takes refusals answered, not thrown (ADR 0046).
 *
 * Every query and mutation it runs carries `acceptsRefusals: true`, so the room answers a refusal
 * (forbidden, not_found and the rest) as a value marked `thrown` instead of throwing it, and Convex
 * doesn't report it to Sentry as an uncaught exception. Here the value becomes the same
 * `ConvexError` the room used to throw, so `useQuery`, `usePaginatedQuery`, `useMutation`, error boundaries and every
 * `error instanceof ConvexError` check work as before. A refusal returned on purpose (`pairs.join`'s
 * for a wrong code) has no `thrown` and still reaches the code as a value. Every hook reaches the room through
 * `watchQuery` or `mutation` below; the room has no public actions.
 */
import { ConvexReactClient, type MutationOptions, type Watch, type WatchQueryOptions } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import type { ArgsAndOptions, FunctionArgs, FunctionReference, FunctionReference_future, FunctionReturnType } from "convex/server";
import type { Value } from "convex/values";
import { isThrownRefusal, unwrapRefusal, withAcceptsRefusals, withoutAcceptsRefusals } from "@uplink-room/protocol/refusals";

type Args = Record<string, Value>;

export class RoomConvexClient extends ConvexReactClient {
  override watchQuery<Query extends FunctionReference<"query"> | FunctionReference_future<"query">>(
    query: Query,
    ...argsAndOptions: ArgsAndOptions<Query, WatchQueryOptions>
  ): Watch<FunctionReturnType<Query>> {
    const [args, options] = argsAndOptions as [Args | undefined, WatchQueryOptions | undefined];
    const watch = super.watchQuery(query, ...([withAcceptsRefusals(args), options] as unknown as ArgsAndOptions<Query, WatchQueryOptions>));
    return {
      // onUpdate, journal and the logs, as they are.
      ...watch,
      // A refusal reads as the error it was: localQueryResult throws a failed query's error.
      localQueryResult: () => unwrapRefusal(watch.localQueryResult()),
    };
  }

  override async mutation<Mutation extends FunctionReference<"mutation"> | FunctionReference_future<"mutation">>(
    mutation: Mutation,
    ...argsAndOptions: ArgsAndOptions<Mutation, MutationOptions<FunctionArgs<Mutation>>>
  ): Promise<FunctionReturnType<Mutation>> {
    const [args, options] = argsAndOptions as [Args | undefined, MutationOptions<Args> | undefined];
    const update = options?.optimisticUpdate;
    const sent = [
      withAcceptsRefusals(args),
      update ? { ...options, optimisticUpdate: (store: OptimisticLocalStore, a: Args) => update(acceptingStore(store), withoutAcceptsRefusals(a) as Args) } : options,
    ];
    return unwrapRefusal(await super.mutation(mutation, ...(sent as unknown as ArgsAndOptions<Mutation, MutationOptions<FunctionArgs<Mutation>>>)));
  }
}

/**
 * The optimistic update's view of the local store, keyed as the code wrote it: each query there was
 * subscribed with `acceptsRefusals`, so it is looked up and set with it, and a refused one reads as
 * no result.
 */
export function acceptingStore(store: OptimisticLocalStore): OptimisticLocalStore {
  const read = <T>(value: T): T | undefined => (isThrownRefusal(value) ? undefined : value);
  return {
    getQuery: ((query: FunctionReference<"query">, args?: Args) =>
      read(store.getQuery(query, withAcceptsRefusals(args) as never))) as unknown as OptimisticLocalStore["getQuery"],
    getAllQueries: ((query: FunctionReference<"query">) =>
      store
        .getAllQueries(query)
        .map(({ args, value }) => ({ args: withoutAcceptsRefusals(args), value: read(value) }))) as unknown as OptimisticLocalStore["getAllQueries"],
    setQuery: ((query: FunctionReference<"query">, args: Args, value: unknown) =>
      store.setQuery(query, withAcceptsRefusals(args) as never, value as never)) as unknown as OptimisticLocalStore["setQuery"],
  };
}
