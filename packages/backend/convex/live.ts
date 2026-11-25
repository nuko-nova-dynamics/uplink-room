/**
 * Live Room API queries for agents, for people signed in from the command line, and for joined runs.
 *
 * Agents call the Room API over HTTP, which can't push. This public query runs
 * any Room API query as the agent whose key is passed, or as the person whose
 * CLI sign-in's token is passed (ADR 0030), so either can subscribe to it over
 * Convex's WebSocket (`RoomClient.watch`) and hear about a call invite the
 * moment it's made. A joined run's token watches its run functions only, such
 * as `joined.waiting` (ADR 0032). The bridge subscribes the same way with its bridge token.
 * The internal function does the scope check and validates the arguments,
 * exactly as for an HTTP call.
 *
 * Revoking a sign-in ends its watches at once, and so does its expiry: Convex
 * reruns a cached query only when a document it read changes, so a scheduled
 * function writes the sign-in's row when it expires (cliSignIns.expire).
 */
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { publicQuery } from "./lib/refusals";
import { isCliSignInToken } from "./cliSignIns";
import { defaultTeamForCliSignIn, liveCliSignIn } from "./lib/actor";
import { accountFunctionPath, agentFunctionPath, catalogEntry, runFunctionPath } from "./lib/catalog";
import { sha256 } from "./lib/crypto";
import { isRunToken } from "./lib/joinedRuns";
import { roomError } from "./lib/errors";
// Each module registers its functions in the catalog when it loads.
import "./roomModules";

const watched = publicQuery({
  args: { key: v.string(), fn: v.string(), args: v.optional(v.any()) },
  handler: async (ctx, { key, fn, args }): Promise<unknown> => {
    const entry = catalogEntry(fn);
    if (!entry) throw roomError("not_found", `No Room API function named ${fn}.`);
    if (entry.kind !== "query") throw roomError("invalid", `${fn} changes things; only a query can be watched.`);
    const given = { ...(args as Record<string, unknown> | undefined) };
    const hash = await sha256(key);

    if (isRunToken(key)) {
      if (entry.realm !== "run") throw roomError("forbidden", `A run token acts only as its joined run, so it can't watch ${fn}.`);
      return await ctx.runQuery(makeFunctionReference<"query">(runFunctionPath(entry.name)) as never, { ...given, runTokenHash: hash } as never);
    }
    if (entry.realm === "run") throw roomError("forbidden", `${fn} is for a joined run, with that run's token.`);

    if (isCliSignInToken(key)) {
      const signIn = await liveCliSignIn(ctx, hash);
      if (entry.realm === "account" || entry.realm === "pair") {
        return await ctx.runQuery(makeFunctionReference<"query">(accountFunctionPath(entry.name)) as never, { ...given, signInHash: hash } as never);
      }
      const teamId = given.teamId ?? (await defaultTeamForCliSignIn(ctx, signIn));
      const callArgs = { ...given, teamId, signInHash: hash };
      return await ctx.runQuery(makeFunctionReference<"query">(agentFunctionPath(entry.name)) as never, callArgs as never);
    }

    if (entry.realm === "account") {
      throw roomError("forbidden", `${fn} is for a person signed in with \`uplink login\`, not for an agent key.`);
    }
    // A Pair function (ADR 0034) runs outside every team: the key's own checks are all there is.
    if (entry.realm === "pair") {
      return await ctx.runQuery(makeFunctionReference<"query">(agentFunctionPath(entry.name)) as never, { ...given, agentKeyHash: hash } as never);
    }
    const agentKey = await ctx.db
      .query("agentKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (!agentKey || agentKey.revokedAt !== undefined) {
      throw roomError("unauthenticated", "This agent key is not valid or was revoked.");
    }
    const callArgs = { teamId: agentKey.teamId, ...given, agentKeyHash: hash };
    return await ctx.runQuery(makeFunctionReference<"query">(agentFunctionPath(entry.name)) as never, callArgs as never);
  },
});

/** `live:query`, the only function here. */
export { watched as query };
