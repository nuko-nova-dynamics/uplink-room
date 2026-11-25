import { afterEach, expect, test, vi } from "vitest";
import { ConvexReactClient, type Watch } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { acceptingStore, RoomConvexClient } from "./roomConvexClient";

const list = makeFunctionReference<"query", { teamId: string }, string[]>("channels:list");
const post = makeFunctionReference<"mutation", { body: string }, string>("messages:post");
const refused = { refused: { code: "forbidden", message: "You are not a member of this team." }, thrown: true };
/** A refusal returned on purpose, as pairs.join's for a wrong code: the code reads it as a value. */
const returned = { refused: { code: "not_found", message: "That pair code is wrong." } };

afterEach(() => vi.restoreAllMocks());

/** A client whose base methods are stubbed, so nothing connects. */
function client() {
  return new RoomConvexClient("https://example.convex.cloud");
}

function watchOf(value: unknown): Watch<unknown> {
  return { onUpdate: () => () => {}, localQueryResult: () => value, journal: () => undefined };
}

test("a query asks for answered refusals and reads a refusal as the ConvexError the room threw", () => {
  const base = vi.spyOn(ConvexReactClient.prototype, "watchQuery").mockReturnValueOnce(watchOf(["general"])).mockReturnValueOnce(watchOf(refused));
  const convex = client();

  expect(convex.watchQuery(list, { teamId: "t1" }).localQueryResult()).toEqual(["general"]);
  expect(base).toHaveBeenLastCalledWith(list, { teamId: "t1", acceptsRefusals: true }, undefined);

  const watch = convex.watchQuery(list, { teamId: "t1" });
  let thrown: unknown;
  try {
    watch.localQueryResult();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConvexError);
  expect((thrown as ConvexError<{ code: string; message: string }>).data).toEqual(refused.refused);
});

test("a mutation asks for answered refusals, rejects a thrown refusal as its ConvexError, and resolves one returned on purpose", async () => {
  const base = vi
    .spyOn(ConvexReactClient.prototype, "mutation")
    .mockResolvedValueOnce("m1")
    .mockResolvedValueOnce(refused)
    .mockResolvedValueOnce(returned);
  const convex = client();

  await expect(convex.mutation(post, { body: "hi" })).resolves.toBe("m1");
  expect(base).toHaveBeenLastCalledWith(post, { body: "hi", acceptsRefusals: true }, undefined);
  await expect(convex.mutation(post, { body: "hi" })).rejects.toMatchObject({ data: { code: "forbidden", message: refused.refused.message } });
  await expect(convex.mutation(post, { body: "hi" })).resolves.toEqual(returned);
});

test("an optimistic update reads and writes the queries as subscribed, with acceptsRefusals, and a refused one as nothing", () => {
  const entries = new Map<string, unknown>([
    [JSON.stringify({ teamId: "t1", acceptsRefusals: true }), ["general"]],
    [JSON.stringify({ teamId: "t2", acceptsRefusals: true }), refused],
  ]);
  const store = {
    getQuery: (_q: unknown, args: object) => entries.get(JSON.stringify(args)),
    getAllQueries: () => [...entries].map(([args, value]) => ({ args: JSON.parse(args) as Record<string, unknown>, value })),
    setQuery: (_q: unknown, args: object, value: unknown) => void entries.set(JSON.stringify(args), value),
  } as unknown as OptimisticLocalStore;
  const view = acceptingStore(store);

  expect(view.getQuery(list, { teamId: "t1" })).toEqual(["general"]);
  expect(view.getQuery(list, { teamId: "t2" })).toBeUndefined();
  view.setQuery(list, { teamId: "t1" }, ["general", "random"]);
  expect(entries.get(JSON.stringify({ teamId: "t1", acceptsRefusals: true }))).toEqual(["general", "random"]);
  expect(view.getAllQueries(list)).toEqual([
    { args: { teamId: "t1" }, value: ["general", "random"] },
    { args: { teamId: "t2" }, value: undefined },
  ]);
});
