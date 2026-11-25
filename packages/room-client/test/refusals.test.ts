/**
 * The clients' half of answered refusals (ADR 0046, @uplink-room/protocol/refusals): the bridge's
 * Convex link and `RoomClient.watch` add `acceptsRefusals` to each call and turn a refusal back
 * into the ConvexError the room used to throw.
 */
import { expect, test, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { acceptingRefusals } from "@uplink-room/protocol/refusals";

const heartbeat = makeFunctionReference<"mutation", { token: string }, null>("bridge:heartbeat");
const live = makeFunctionReference<"query", { key: string; fn: string; args: Record<string, unknown> }, unknown>("live:query");
const ended = { refused: { code: "unauthenticated", message: "This joined run ended, so its run token no longer works." }, thrown: true };

test("a mutation sends acceptsRefusals, rejects a thrown refusal as its ConvexError, and resolves one returned on purpose", async () => {
  const returned = { refused: { code: "not_found", message: "That pair code is wrong." } };
  const mutation = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(ended).mockResolvedValueOnce(returned);
  const room = acceptingRefusals({ mutation } as unknown as ConvexClient);

  await expect(room.mutation(heartbeat, { token: "t" })).resolves.toBeNull();
  expect(mutation).toHaveBeenLastCalledWith(heartbeat, { token: "t", acceptsRefusals: true });
  const error = await room.mutation(heartbeat, { token: "t" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as ConvexError<{ code: string }>).data).toEqual(ended.refused);
  // One returned on purpose (a wrong pair code) stays the value the caller reads.
  await expect(room.mutation(heartbeat, { token: "t" })).resolves.toEqual(returned);
});

test("a watched query sends acceptsRefusals, passes results on, and gives a refusal to onError", () => {
  let push: (value: unknown) => void = () => {};
  const onUpdate = vi.fn((_ref: unknown, _args: unknown, callback: (value: unknown) => void) => {
    push = callback;
    return () => {};
  });
  const room = acceptingRefusals({ onUpdate } as unknown as ConvexClient);
  const results: unknown[] = [];
  const errors: unknown[] = [];

  room.onUpdate(live, { key: "urj_x", fn: "joined.waiting", args: {} }, (r) => results.push(r), (e) => errors.push(e));
  expect(onUpdate.mock.calls[0]![1]).toEqual({ key: "urj_x", fn: "joined.waiting", args: {}, acceptsRefusals: true });
  push({ waiting: 1 });
  push(ended);

  expect(results).toEqual([{ waiting: 1 }]);
  expect(errors).toHaveLength(1);
  expect((errors[0] as ConvexError<{ code: string; message: string }>).data).toEqual(ended.refused);
});
