import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import type { Actor } from "./lib/actor";
import { canSeeId } from "./lib/channels";
import { auditIds, channelOfId, maybeView, memberView } from "./lib/members";
import { pairAgentsIn, pairPersonRow } from "./lib/pairs";
import { roomQuery } from "./lib/room";
import { seesRun } from "./lib/runLabels";

/**
 * Whether the viewer may see an entry: one about a direct message or private channel they aren't
 * in (its target, or an id among its details, lives there) is left out, so the log never gives away
 * what happens there or that it exists (ADR 0016). That includes an agent's own calls in one.
 */
async function visibleEntry(ctx: QueryCtx, actor: Actor, entry: Doc<"audit">, seen: Map<string, boolean>) {
  if (entry.action.startsWith("api.pairs.")) return visiblePairEntry(ctx, actor, entry, seen);
  // The channel kept when the entry was written comes first: it outlives a deleted message. Entries
  // from before it was kept are looked up by their ids.
  const channels: (Id<"channels"> | undefined)[] = [entry.channelId];
  for (const id of auditIds(entry.target, entry.details)) {
    // A closed run (ADR 0044) and what happens to it are its person's only.
    const runId = ctx.db.normalizeId("runs", id);
    const run = runId ? await ctx.db.get(runId) : null;
    if (run && !(await seesRun(ctx, run, actor))) return false;
    channels.push(await channelOfId(ctx, id));
  }
  for (const channelId of channels) {
    if (!channelId) continue;
    if (!seen.has(channelId)) seen.set(channelId, await canSeeId(ctx, actor, channelId));
    if (!seen.get(channelId)) return false;
  }
  return true;
}

/**
 * An agent's call to a Pair function (ADR 0034) is logged in its team's record, but the Pair is
 * outside every team (ADR 0029 D9), so only those in it see the entry: one of its people, or an
 * agent still in it. That the Pair exists, and when it is busy, isn't told to the rest of the team.
 * An entry naming no Pair (a refused pairs.join) is the agent's own and its accountable person's.
 */
async function visiblePairEntry(ctx: QueryCtx, actor: Actor, entry: Doc<"audit">, seen: Map<string, boolean>) {
  const pairId = ctx.db.normalizeId("pairs", entry.target);
  if (!pairId) return entry.actorId === actor.member._id || entry.accountableId === actor.member._id;
  const key = `pair:${pairId}`;
  if (!seen.has(key)) {
    let inPair = false;
    if (actor.kind === "agent") {
      const agentId = actor.member.agentId;
      inPair = !!agentId && (await pairAgentsIn(ctx, pairId)).some((a) => a.agentId === agentId);
    } else if (actor.member.personId) {
      inPair = (await pairPersonRow(ctx, pairId, actor.member.personId)) !== null;
    }
    seen.set(key, inPair);
  }
  return seen.get(key)!;
}

export const { person: list, agent: listAgent } = roomQuery({
  name: "activity.list",
  description:
    "The team's activity log, newest first: who changed access, slots, drivers, machine settings, keys and more. An agent's entries name the person accountable for it. Entries about a direct message, private channel or Pair you aren't in are left out.",
  scope: "room.read",
  args: { limit: v.optional(v.number()), target: v.optional(v.string()) },
  handler: async (ctx, actor, args) => {
    const limit = args.limit ?? 100;
    const entries = await ctx.db
      .query("audit")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .order("desc")
      .take(args.target ? 1000 : limit * 2);
    const seen = new Map<string, boolean>();
    const filtered = [];
    for (const e of entries) {
      if (args.target && e.target !== args.target) continue;
      if (!(await visibleEntry(ctx, actor, e, seen))) continue;
      filtered.push(e);
      if (filtered.length >= limit) break;
    }
    return Promise.all(
      filtered.map(async (e) => ({
        action: e.action,
        target: e.target,
        details: e.details,
        at: e.at,
        actor: await memberView(ctx, e.actorId),
        accountable: await maybeView(ctx, e.accountableId),
      })),
    );
  },
});
