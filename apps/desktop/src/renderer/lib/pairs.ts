/**
 * Pairs in the app (ADR 0027, ADR 0034, slice 12 of #139): what the Pair views show, worked out from
 * the `pairs.*` functions' answers. A Pair is outside every team, so these functions take no
 * teamId, and the app calls them with its Clerk session whether or not the person has a team.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQueries } from "convex/react";
import { getFunctionName, makeFunctionReference, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { api } from "./api";
import { errorMessage } from "./errors";
import { useToast } from "./session";

export type PairView = FunctionReturnType<typeof api.pairs.list>[number];
export type PairMessage = FunctionReturnType<typeof api.pairs.messagesPage>["page"][number];
export type PairCode = FunctionReturnType<typeof api.pairs.code>;

/**
 * A Pair or account query (no teamId) whose error, such as not_found for a Pair you left, comes back
 * as null instead of throwing during render. Undefined while it loads.
 */
export function useSoftAccountQuery<Q extends FunctionReference<"query">>(query: Q, args: Q["_args"] | "skip"): Q["_returnType"] | undefined | null {
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  // Keyed on the function's name and the args' text: useQueries resubscribes whenever its request
  // object changes, and `api.x.y` is a new reference on every render.
  const name = getFunctionName(query);
  const request = useMemo(
    () => (key === "skip" ? {} : { q: { query: makeFunctionReference<"query">(name), args: JSON.parse(key) as Record<string, unknown> } }),
    [name, key],
  );
  const result = (useQueries(request as never) as Record<string, unknown>)["q"];
  return result instanceof Error ? null : (result as Q["_returnType"] | undefined);
}

/** How long a pair code works, as the room says (ADR 0034). */
export const PAIR_CODE_MINUTES = 10;

/** A Pair's name: who else is in it, as a direct message is named after who it's with. */
export function pairTitle(pair: Pick<PairView, "people">): string {
  const others = pair.people.filter((p) => !("you" in p && p.you)).map((p) => p.name);
  if (others.length === 0) return "Waiting for someone to join";
  if (others.length === 1) return others[0]!;
  if (others.length === 2) return `${others[0]} and ${others[1]}`;
  return `${others[0]}, ${others[1]} and ${others.length - 2} more`;
}

/** The line an ended Pair shows where its message box was. */
export function pairEndedLine(pair: Pick<PairView, "endedAt" | "endReason">): string | undefined {
  if (pair.endedAt === undefined) return undefined;
  return pair.endReason === "too_few_people"
    ? "This Pair ended when only one person was left in it. You can still read it."
    : "This Pair has ended. You can still read it.";
}

/**
 * The line under the box when runs in the Pair didn't get a message (`pairs.post`'s notDelivered):
 * their inbox was full. The message is posted all the same.
 */
export function notDeliveredLine(labels: string[]): string | undefined {
  if (labels.length === 0) return undefined;
  const names = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
  return labels.length === 1
    ? `${names} didn't get it: its inbox is full. It's still in the Pair.`
    : `${names} didn't get it: their inboxes are full. It's still in the Pair.`;
}

/** "9:42" until a code expires, or null once it has. */
export function codeTimeLeft(expiresAt: number, now: number): string | null {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** A typed or pasted code in its own shape: capitals, words and digits joined by hyphens. */
export function readCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .join("-");
}

type Refusal = { refused: { code: string; message: string } };

/**
 * What a join with a code came to: the Pair, or the reason in plain words. The room refuses a
 * wrong, used or expired code with one answer, so it can't tell them apart either.
 */
export function joinOutcome(result: { pairId: string } | Refusal): { pairId: string } | { error: string } {
  if (!("refused" in result)) return { pairId: result.pairId };
  const { code, message } = result.refused;
  if (code === "not_found") {
    return { error: `That code didn't work. It may be mistyped, used already, or more than ${PAIR_CODE_MINUTES} minutes old. Ask for a new one.` };
  }
  const wait = /for (\d+ more minutes?)/.exec(message);
  if (code === "forbidden" && wait) return { error: `Too many wrong codes. No code works for you for ${wait[1]}.` };
  return { error: message };
}

/**
 * A Pair or account function (no teamId) that shows the room's error in a toast, as `useAct` does
 * for team functions, and returns undefined when it fails.
 */
export function useAccountAct<M extends FunctionReference<"mutation">>(
  mutation: M,
  options: { success?: string } = {},
): (args: M["_args"]) => Promise<M["_returnType"] | undefined> {
  const run = useMutation(mutation);
  const toast = useToast();
  const success = options.success;
  return useCallback(
    async (args) => {
      try {
        const result = await run(args);
        if (success) toast.show(success, true);
        return result ?? (true as M["_returnType"]);
      } catch (error) {
        toast.show(errorMessage(error));
        return undefined;
      }
    },
    [run, toast, success],
  );
}
