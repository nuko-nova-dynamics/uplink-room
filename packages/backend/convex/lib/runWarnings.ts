/**
 * The warning of a direct message opened with a run whose output people outside it can see (ADR 0039,
 * amended 2026-11-05): the line in its history, what channels.openDirect returns, and the refusal a
 * sender gets on messages.post until they acknowledge it, so a sender who reads neither the
 * history nor channels.list is still told before anything they write reaches the run.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { isDirect } from "./channels";
import { roomError } from "./errors";
import { runLine } from "./router";
import { outputWarning, runNamer } from "./runLabels";

export type RunWarning = { runId: Id<"runs">; label: string; warning: string; seenBy: "team" | "outside" };

/**
 * The warnings of a direct message's runs, oldest first. A run added before the warning existed
 * gets its line in the history now, once (`channelRuns.warnedAt`), so a direct message from before
 * this says whose output the run is before the next message reaches it.
 */
export async function directWarnings(ctx: MutationCtx, channel: Doc<"channels">): Promise<RunWarning[]> {
  if (!isDirect(channel)) return [];
  const rows = await ctx.db
    .query("channelRuns")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .take(10);
  const name = runNamer(ctx);
  const warnings: RunWarning[] = [];
  for (const row of rows.sort((a, b) => a.addedAt - b.addedAt)) {
    const run = await ctx.db.get(row.runId);
    // A closed run (ADR 0044) hears only its person, and its name stays out of the history until it opens.
    if (!run || run.closed === true) continue;
    const label = await name(run);
    const seen = await outputWarning(ctx, run, channel, label);
    if (seen) warnings.push({ runId: run._id, label, ...seen });
    if (row.warnedAt === undefined) {
      if (seen) await runLine(ctx, channel, undefined, run, seen.warning, "info");
      await ctx.db.patch(row._id, { warnedAt: Date.now() });
    }
  }
  return warnings;
}

/**
 * Refuses a post in a direct message with such a run until its sender has acknowledged the warning
 * once (`acknowledgeWarning: true`), as `warning_required`, naming each run. The app shows the
 * warning by the message box and acknowledges it when it sends.
 */
export async function requireAcknowledged(
  ctx: MutationCtx,
  actor: Actor,
  channel: Doc<"channels">,
  warnings: RunWarning[],
  acknowledged: boolean | undefined,
): Promise<void> {
  if (!warnings.length) return;
  const row = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel_member", (q) => q.eq("channelId", channel._id).eq("memberId", actor.member._id))
    .unique();
  if (row?.warningAcknowledgedAt !== undefined) return;
  if (!acknowledged) {
    throw roomError(
      "warning_required",
      `${warnings.map((w) => w.warning).join(" ")} Nothing was sent. To send it anyway, post it again with acknowledgeWarning: true; you won't be asked again in this direct message.`,
    );
  }
  if (row) await ctx.db.patch(row._id, { warningAcknowledgedAt: Date.now() });
}
