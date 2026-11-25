/**
 * A T3 Code thread's conversation in the room (ADR 0022): what its bridge sends while someone has
 * the thread open, kept in a bounded window like a terminal's output.
 */
import { ROOM_MESSAGE_PREFIX, THREAD_ITEM_LIMITS, type BridgeMessageOf, type ThreadItem } from "@uplink-room/protocol";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { utf8Bytes } from "./terminals";

/** The newest items kept per thread. Older ones come back from the bridge on request. */
export const THREAD_ITEMS_KEPT = 300;
/** How long older items someone loaded stay. */
export const HISTORY_KEPT_MS = 30 * 60 * 1000;
/** How long a fetched diff stays. */
export const DIFF_KEPT_MS = 24 * 60 * 60 * 1000;
/**
 * The longest item id the room keeps. Ids are T3 Code's own and opaque (an approval's runs to about
 * 300 characters); a cut id would mix up items and miss removals, so a longer one isn't kept at all.
 */
export const ITEM_ID_MAX = 1000;
/** History rows dropped per mutation; more go in a follow-up. */
const HISTORY_DROP_BATCH = 500;

type Machine = Doc<"machines">;

/** An item cut to THREAD_ITEM_LIMITS again, whatever the bridge sent. */
export function clampItem(item: ThreadItem): ThreadItem {
  const cut = { value: item.cut === true };
  const head = (text: string | undefined, limit: number) => {
    if (text === undefined || text.length <= limit) return text;
    cut.value = true;
    return text.slice(0, limit);
  };
  const tail = (text: string | undefined, limit: number) => {
    if (text === undefined || text.length <= limit) return text;
    cut.value = true;
    return text.slice(text.length - limit);
  };
  const list = <T>(values: T[] | undefined) => values?.slice(0, THREAD_ITEM_LIMITS.list);
  const out: ThreadItem = {
    ...item,
    messageRef: item.messageRef && item.messageRef.length <= ITEM_ID_MAX ? item.messageRef : undefined,
    text: head(item.text, THREAD_ITEM_LIMITS.text),
    title: head(item.title, 500),
    input: head(item.input, THREAD_ITEM_LIMITS.input),
    output: tail(item.output, THREAD_ITEM_LIMITS.output),
    diff: head(item.diff, THREAD_ITEM_LIMITS.diff),
    steps: list(item.steps)?.map((s) => ({ text: s.text.slice(0, 500), status: s.status.slice(0, 40) })),
    files: list(item.files)?.map((f) => ({ ...f, path: f.path.slice(0, 500) })),
    attachments: list(item.attachments)?.map((a) => ({ ...a, name: a.name.slice(0, 255), kind: a.kind.slice(0, 40) })),
  };
  for (const key of Object.keys(out) as (keyof ThreadItem)[]) if (out[key] === undefined) delete out[key];
  if (cut.value) out.cut = true;
  return out;
}

/** Whether the room can keep an item: one whose id it can store whole. */
const keepable = (item: ThreadItem) => item.itemId.length <= ITEM_ID_MAX;

/**
 * Drops up to HISTORY_DROP_BATCH of a thread's history rows, and schedules the rest. Returns how
 * many went.
 */
export async function dropHistoryRows(ctx: MutationCtx, runId: Id<"runs">): Promise<number> {
  const rows = await ctx.db
    .query("threadItems")
    .withIndex("by_run_history_order", (q) => q.eq("runId", runId).eq("history", true))
    .take(HISTORY_DROP_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === HISTORY_DROP_BATCH) await ctx.scheduler.runAfter(0, internal.threads.dropHistory, { runId, more: true });
  return rows.length;
}

/** The message the room sent that a thread item is, by its messageRef (ROOM_MESSAGE_PREFIX). */
export async function roomMessageOf(ctx: QueryCtx, runId: Id<"runs">, item: ThreadItem): Promise<Doc<"threadMessages"> | null> {
  if (item.role !== "user" || !item.messageRef?.startsWith(ROOM_MESSAGE_PREFIX)) return null;
  const id = ctx.db.normalizeId("threadMessages", item.messageRef.slice(ROOM_MESSAGE_PREFIX.length));
  const row = id ? await ctx.db.get(id) : null;
  return row && row.runId === runId ? row : null;
}

/**
 * A message queued behind a turn shows in T3 Code as a pending user message, completed once its own
 * turn starts (`queued_turn` in T3 Code's Orchestrator): then it was sent.
 */
async function queuedMessagesRan(ctx: MutationCtx, runId: Id<"runs">, items: ThreadItem[]) {
  for (const item of items) {
    if (item.status === "pending") continue;
    const row = await roomMessageOf(ctx, runId, item);
    if (row?.status === "queued") await ctx.db.patch(row._id, { status: "sent" });
  }
}

async function threadRunFor(ctx: MutationCtx, machine: Machine, threadRef: string) {
  return await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", threadRef))
    .unique();
}

/**
 * Stores items as the thread's newest: replaces each by its id, and turns an item someone loaded
 * from history into a kept one. Returns how many kept items were added.
 */
async function upsertKept(ctx: MutationCtx, runId: Id<"runs">, items: ThreadItem[], older: boolean): Promise<number> {
  let added = 0;
  // With older items still in T3 Code, a new one from before the oldest the room has would sit
  // alone past a gap "Show earlier messages" can't fill; it comes with its page instead.
  const oldest = older
    ? await ctx.db
        .query("threadItems")
        .withIndex("by_run_order", (q) => q.eq("runId", runId))
        .first()
    : null;
  for (const raw of items.filter(keepable)) {
    const item = clampItem(raw);
    const existing = await ctx.db
      .query("threadItems")
      .withIndex("by_run_item", (q) => q.eq("runId", runId).eq("itemId", item.itemId))
      .first();
    if (existing) {
      if (existing.history) added++;
      await ctx.db.replace(existing._id, { runId, itemId: item.itemId, order: item.order, item, history: false });
    } else {
      if (oldest && item.order < oldest.order) continue;
      await ctx.db.insert("threadItems", { runId, itemId: item.itemId, order: item.order, item, history: false });
      added++;
    }
  }
  return added;
}

/** A watched thread's items from its bridge. */
export async function threadItemsReceived(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_items">) {
  const run = await threadRunFor(ctx, machine, m.threadRef);
  if (!run) return;
  let count = run.threadItemCount ?? 0;
  if (m.reset) {
    // The newest items T3 Code has now replace the window. A kept item they don't include goes,
    // older ones too, so no gap is left that "Show earlier messages" can't fill; so does history
    // loaded earlier, which may hold turns rolled back while nobody followed the thread (the bridge
    // sees no removals then).
    const fresh = new Set(m.items.map((i) => i.itemId));
    const kept = await ctx.db
      .query("threadItems")
      .withIndex("by_run_history_order", (q) => q.eq("runId", run._id).eq("history", false))
      .take(THREAD_ITEMS_KEPT + 200);
    count = 0;
    for (const row of kept) {
      if (fresh.has(row.itemId)) count++;
      else await ctx.db.delete(row._id);
    }
    await dropHistoryRows(ctx, run._id);
    // A page asked for before the reset belongs to the old window: it is refused when it comes.
    await ctx.db.patch(run._id, { threadHistoryExpiresAt: undefined, threadHistory: undefined });
  }
  for (const itemId of m.removed ?? []) {
    const row = await ctx.db
      .query("threadItems")
      .withIndex("by_run_item", (q) => q.eq("runId", run._id).eq("itemId", itemId))
      .first();
    if (!row) continue;
    await ctx.db.delete(row._id);
    if (!row.history) count--;
  }
  count = Math.max(0, count) + (await upsertKept(ctx, run._id, m.items, !m.reset && run.threadOlder === true));
  await queuedMessagesRan(ctx, run._id, m.items.slice(0, 200));
  let older = m.reset ? m.older === true : run.threadOlder;
  if (count > THREAD_ITEMS_KEPT) {
    const extra = await ctx.db
      .query("threadItems")
      .withIndex("by_run_history_order", (q) => q.eq("runId", run._id).eq("history", false))
      .take(count - THREAD_ITEMS_KEPT);
    // With older history loaded, what leaves the window joins it (and goes when it goes), so no gap
    // opens between them that "Show earlier messages" couldn't fill.
    const historyLoaded = !m.reset && run.threadHistoryExpiresAt !== undefined;
    for (const row of extra) {
      if (historyLoaded) await ctx.db.patch(row._id, { history: true });
      else await ctx.db.delete(row._id);
    }
    count -= extra.length;
    if (!historyLoaded) older = true;
  }
  await ctx.db.patch(run._id, { threadItemCount: count, threadOlder: older });
}

/**
 * Older items someone asked for (`threads.loadOlder`). They go together, HISTORY_KEPT_MS after the
 * last page came: one page going before an older one would leave a gap nobody could load again.
 */
export async function threadHistoryReceived(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_history_page">) {
  const run = await threadRunFor(ctx, machine, m.threadRef);
  if (!run || run.threadHistory?.requestId !== m.requestId) return;
  if (m.error) {
    await ctx.db.patch(run._id, { threadHistory: { requestId: m.requestId, status: "failed", error: m.error.slice(0, 300), at: Date.now() } });
    return;
  }
  const expiresAt = Date.now() + HISTORY_KEPT_MS;
  for (const raw of m.items.slice(0, 200).filter(keepable)) {
    const item = clampItem(raw);
    const existing = await ctx.db
      .query("threadItems")
      .withIndex("by_run_item", (q) => q.eq("runId", run._id).eq("itemId", item.itemId))
      .first();
    if (existing && !existing.history) continue;
    if (existing) await ctx.db.replace(existing._id, { runId: run._id, itemId: item.itemId, order: item.order, item, history: true });
    else await ctx.db.insert("threadItems", { runId: run._id, itemId: item.itemId, order: item.order, item, history: true });
  }
  // A queued message whose turn ran before the window shows as sent once its page is loaded.
  await queuedMessagesRan(ctx, run._id, m.items.slice(0, 200));
  await ctx.db.patch(run._id, { threadOlder: m.older, threadHistory: undefined, threadHistoryExpiresAt: expiresAt });
  await ctx.scheduler.runAt(expiresAt, internal.threads.dropHistory, { runId: run._id });
}

/** A turn's diff someone asked for (`threads.requestDiff`). */
export async function threadDiffReceived(ctx: MutationCtx, machine: Machine, m: BridgeMessageOf<"thread_diff">) {
  const row = await ctx.db
    .query("threadDiffs")
    .withIndex("by_request", (q) => q.eq("requestId", m.requestId))
    .first();
  const run = row ? await ctx.db.get(row.runId) : null;
  if (!row || !run || run.machineId !== machine._id) return;
  if (m.error !== undefined || m.diff === undefined) {
    await ctx.db.patch(row._id, { status: "failed", error: (m.error ?? "No diff came back.").slice(0, 300), at: Date.now() });
    return;
  }
  let diff = m.diff;
  let cut = m.cut === true;
  if (utf8Bytes(diff) > THREAD_ITEM_LIMITS.turnDiff) {
    // Characters take at most 4 bytes: a quarter of the limit always fits.
    diff = diff.slice(0, Math.floor(THREAD_ITEM_LIMITS.turnDiff / 4));
    cut = true;
  }
  await ctx.db.patch(row._id, { status: "ready", diff, cut, error: undefined, at: Date.now() });
}

/**
 * A bridge registered: it follows no thread yet. The room forgets which it asked it to follow, so
 * the next `threads.watch` from someone with a view open asks again.
 */
export async function forgetFollows(ctx: MutationCtx, machineId: Id<"machines">) {
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machineId))
    .collect();
  for (const run of runs) if (run.threadWatchedAt !== undefined) await ctx.db.patch(run._id, { threadWatchedAt: undefined });
}
