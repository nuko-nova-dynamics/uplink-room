/**
 * Handing a run's waiting messages to the bridge that runs it (ADR 0026, slices 4 and 6 of #139). The
 * room keeps each message a run is sent as a `runInbox` row. For a run in a terminal on a machine
 * whose bridge named `run_messages`, or in a T3 Code thread on one whose bridge named
 * `thread_run_messages` (ADR 0037), it tells the bridge that messages wait (`run_messages_waiting`,
 * no text), and hands them over only when they are claimed (`bridge:claimRunMessages`), by the
 * session's hook for a terminal and by the bridge for a thread: labelled for the run's driver at
 * that moment, and only those the driver may still read. The bridge acknowledges them once the
 * session has them (`run_message_result`): a hook wrote them, or T3 Code took them; a claim that
 * is never acknowledged is handed over once more, then fails as unsure. A bridge from before gets
 * nothing, and the message waits in the run's inbox for someone to read it there.
 */
import { RUN_MESSAGE_TEXT_MAX, type BridgeMessageOf, type RunHearing, type RunMessageHow } from "@uplink-room/protocol";
import {
  DELIVERY_TEXT_MAX,
  formatRunMessages,
  RUN_CLAIM_FILES_MAX,
  RUN_CLAIM_HOLD_MAX_MS,
  RUN_CLAIM_MS,
  type RunDelivery,
  type RunMessageClaim,
  type RunMessageClaimRequest,
} from "@uplink-room/protocol/runMessages";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isDirect } from "./channels";
import { findTerminal } from "./bridgeMessages";
import { mentionTokens, withNames } from "./messages";
import { sendToBridge } from "./outbox";
import { driverReads, hearsFrom, hearsIn, isLiveRun, runNamer, runNamesIn, runPerson, type RunNamer } from "./runLabels";
import { bridgeHandles } from "./threads";
import { attachmentsOf, roomFilesOf } from "./attachments";

/** A message's text as a run reads it: names in place of mention tokens. */
export async function messageText(ctx: QueryCtx, teamId: Id<"teams">, message: Doc<"messages">, name: RunNamer = runNamer(ctx)): Promise<string> {
  if (message.format === "html") return "(an HTML page)";
  const names = new Map<string, string>();
  for (const id of mentionTokens(message.body)) {
    const memberId = ctx.db.normalizeId("members", id);
    const member = memberId ? await ctx.db.get(memberId) : null;
    if (member) names.set(id, member.name);
  }
  await runNamesIn(ctx, teamId, message.body, name, names);
  return withNames(message.body, (id) => names.get(id));
}

/** Where a message was posted, as a run reads it: "#payments", "a thread in #payments", "a direct message". */
export function placeOf(channel: Doc<"channels">, message: Pick<Doc<"messages">, "replyTo">): string {
  return `${message.replyTo ? "a thread in " : ""}${isDirect(channel) ? "a direct message" : `#${channel.name}`}`;
}

/**
 * At most this many messages wait in one run's inbox, counting those claimed and not yet answered;
 * past that, senders are told it isn't taking them. A claim reads at most this many.
 */
export const MAX_WAITING = 50;

/** How long a claim may go unanswered before the room counts it as unsure. */
export const CLAIM_MS = RUN_CLAIM_MS;

/** Why a message to a run failed, as `runs.inbox` gives it. */
export type RunInboxError = NonNullable<Doc<"runInbox">["error"]>;

/** A run on a machine: in one of its terminals, or in a T3 Code thread its bridge reports. */
function onMachine(run: Doc<"runs">): "terminal" | "thread" | null {
  if (!run.machineId) return null;
  if (run.terminalId) return "terminal";
  return run.threadRef !== undefined ? "thread" : null;
}

/**
 * Whether the room can hand this run's messages to its machine: a terminal run whose bridge takes
 * them, or a thread run whose bridge sends them into threads (ADR 0037).
 */
export async function deliversTo(ctx: QueryCtx, run: Doc<"runs">): Promise<Doc<"machines"> | null> {
  const where = onMachine(run);
  if (!where) return null;
  const machine = await ctx.db.get(run.machineId!);
  const feature = where === "terminal" ? "run_messages" : "thread_run_messages";
  return machine && machine.unlinkedAt === undefined && bridgeHandles(machine, feature) ? machine : null;
}

/**
 * The run a machine's bridge names: the run in one of its terminals, or in a T3 Code thread it
 * reported, as the room has it now. Null when the bridge names neither of the machine's own.
 */
export async function machineRun(
  ctx: MutationCtx,
  machine: Doc<"machines">,
  ref: { terminalRef: string } | { threadRef: string },
): Promise<{ run: Doc<"runs">; terminal?: Doc<"terminals"> } | null> {
  if ("terminalRef" in ref) {
    const terminal = await findTerminal(ctx, machine, ref.terminalRef);
    const run = terminal?.runId ? await ctx.db.get(terminal.runId) : null;
    if (!terminal || !run || run.machineId !== machine._id || run.terminalId !== terminal._id) return null;
    return { run, terminal };
  }
  const run = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id).eq("threadRef", ref.threadRef))
    .unique();
  return run && !run.terminalId ? { run } : null;
}

/**
 * How a run hears messages: `runs.hearing` as its bridge reported it (`mid_task`, `between_turns`,
 * `none`), or `unknown` until it says. A terminal or thread run whose bridge doesn't take its run
 * messages reads `unknown` whatever it reported before, with a note saying what to do about it.
 */
export async function hearingOf(ctx: QueryCtx, run: Doc<"runs">): Promise<{ hearing: RunHearing | "unknown"; hearingNote?: string }> {
  if (run.machineId && onMachine(run) && !(await deliversTo(ctx, run))) {
    const machine = await ctx.db.get(run.machineId);
    return { hearing: "unknown", hearingNote: `Update Uplink Room on ${machine?.name ?? "its machine"} so this run hears messages.` };
  }
  return { hearing: run.hearing ?? "unknown" };
}

/** Tells the run's bridge that messages wait for it, if the bridge takes run messages for it. */
export async function noticeRun(ctx: MutationCtx, run: Doc<"runs">): Promise<void> {
  const machine = await deliversTo(ctx, run);
  if (!machine) return;
  const source = run.terminalId ? { kind: "terminal" as const, terminalId: run.terminalId } : { kind: "thread" as const, threadRef: run.threadRef! };
  await sendToBridge(ctx, machine._id, { v: 1, type: "run_messages_waiting", source });
}

/**
 * Tells the run's bridge about messages that wait for it, if any do: for a thread run T3 Code lists
 * again (lib/bridgeMessages.ts), which a new bridge process reports after it registers.
 */
export async function noticeIfWaiting(ctx: MutationCtx, run: Doc<"runs">): Promise<void> {
  const waiting = await ctx.db
    .query("runInbox")
    .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "waiting"))
    .first();
  if (waiting) await noticeRun(ctx, run);
}

/** How many of a machine's live terminals one step of `noticeWaiting` reads. */
const NOTICE_STEP = 100;

/**
 * Tells the bridge about every live terminal on its machine whose run has messages waiting: called
 * when a bridge says it takes run messages, for messages sent while it didn't (or before it
 * registered). It claims them at the session's next hook. The terminals are read through the
 * machine's live ones only, in scheduled steps of NOTICE_STEP, so a machine with many terminals
 * stays within a transaction's limits.
 */
export async function deliverWaiting(ctx: MutationCtx, machineId: Id<"machines">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.runDelivery.noticeWaiting, { machineId, status: "live", cursor: null });
}

/** One step of `deliverWaiting`: a page of the machine's live (then starting) terminals, and the next step. */
export async function noticeWaiting(
  ctx: MutationCtx,
  machineId: Id<"machines">,
  status: "live" | "starting",
  cursor: string | null,
): Promise<void> {
  const page = await ctx.db
    .query("terminals")
    .withIndex("by_machine_status", (q) => q.eq("machineId", machineId).eq("status", status))
    .paginate({ numItems: NOTICE_STEP, cursor });
  for (const terminal of page.page) {
    const runId = terminal.runId;
    if (!runId) continue;
    const waiting = await ctx.db
      .query("runInbox")
      .withIndex("by_run_status", (q) => q.eq("runId", runId).eq("status", "waiting"))
      .first();
    const run = waiting ? await ctx.db.get(runId) : null;
    if (run && run.terminalId === terminal._id) await noticeRun(ctx, run);
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.runDelivery.noticeWaiting, { machineId, status, cursor: page.continueCursor });
  else if (status === "live") await ctx.scheduler.runAfter(0, internal.runDelivery.noticeWaiting, { machineId, status: "starting", cursor: null });
}

/**
 * One waiting message as the run may read it now, or why it can't: the message was deleted, its
 * driver changed to someone who can't read where it was posted (ADR 0016), people outside the
 * private place it came from can now see the run's output (ADR 0039), or its driver narrowed who
 * the run hears (`runs.setHears`) since it was sent. `fromDriver` is for the driver now.
 */
async function handOver(ctx: QueryCtx, run: Doc<"runs">, row: Doc<"runInbox">, name: RunNamer): Promise<RunDelivery | RunInboxError> {
  const message = await ctx.db.get(row.messageId);
  const channel = await ctx.db.get(row.channelId);
  const from = await ctx.db.get(row.from.memberId);
  const accountable = await ctx.db.get(row.accountableId);
  if (!message || message.deletedAt !== undefined || !channel || !from || !accountable) return "deleted";
  if (!(await driverReads(ctx, run, channel))) return "driver_changed";
  // Checked again: who is in the place, or in the direct message the run came from, may have changed (ADR 0039).
  if (!(await hearsIn(ctx, run, channel))) return "visible_outside";
  if (!(await hearsFrom(ctx, run, { member: from, accountable }))) return "not_heard";
  const person = await runPerson(ctx, run);
  const text = await messageText(ctx, run.teamId, message, name);
  const cut = text.length > RUN_MESSAGE_TEXT_MAX;
  return {
    deliveryId: row._id,
    messageId: message._id,
    place: placeOf(channel, message),
    // A cut can split a surrogate pair, and Convex refuses a string with half of one.
    text: cut ? text.slice(0, RUN_MESSAGE_TEXT_MAX).toWellFormed() : text,
    ...(cut ? { cut } : {}),
    ...(message.attachmentCount ? { attachments: message.attachmentCount } : {}),
    from: {
      memberId: from._id,
      name: from.name,
      kind: from.kind === "agent" ? "agent" : "person",
      ...(message.asRun ? { run: message.asRun.label } : {}),
    },
    accountable: { memberId: accountable._id, name: accountable.name },
    fromDriver: person !== null && person._id === accountable._id,
    at: row.at,
  };
}

/**
 * A session's hook claims the messages waiting for the run in one of this machine's terminals, or
 * the bridge for the run in a T3 Code thread (`bridge:claimRunMessages`). The room labels each for
 * the run's driver in this transaction, so
 * none is handed over under a driver it wasn't checked for, and fails those the driver may not read.
 * It hands over the oldest that fit in one delivery, keeping `reserve` characters for the bridge,
 * marks them claimed, and counts them unsure if the bridge doesn't answer within CLAIM_MS.
 */
export async function claimRunMessages(ctx: MutationCtx, machine: Doc<"machines">, args: RunMessageClaimRequest): Promise<RunMessageClaim> {
  const claimId = crypto.randomUUID();
  const none = { claimId, deliveries: [], more: false };
  const found = await machineRun(ctx, machine, args);
  if (!found) return none;
  const { run } = found;
  if (!bridgeHandles(machine, "terminalRef" in args ? "run_messages" : "thread_run_messages") || !(await isLiveRun(ctx, run))) return none;
  // One past the bound, to tell whether more wait than this claim reads.
  const rows = await ctx.db
    .query("runInbox")
    .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "waiting"))
    .take(MAX_WAITING + 1);
  const max = DELIVERY_TEXT_MAX - Math.min(Math.max(0, Math.floor(args.reserve)), DELIVERY_TEXT_MAX / 2);
  // The files themselves go only to a bridge that gives them to the run (ADR 0043), at most as many
  // as it takes in one delivery: the claim stops before a message whose files would pass that, so the
  // bridge never has to leave one out. The first message goes whole, so none waits forever.
  const withFiles = bridgeHandles(machine, "run_message_files");
  const maxFiles = Math.min(Math.max(0, Math.floor(args.maxFiles ?? RUN_CLAIM_FILES_MAX)), RUN_CLAIM_FILES_MAX);
  let fileCount = 0;
  const name = runNamer(ctx);
  const taken: { row: Doc<"runInbox">; delivery: RunDelivery }[] = [];
  let more = rows.length > MAX_WAITING;
  for (const row of rows.slice(0, MAX_WAITING)) {
    const delivery = await handOver(ctx, run, row, name);
    if (typeof delivery === "string") {
      await ctx.db.patch(row._id, { status: "failed", error: delivery });
      continue;
    }
    const files = withFiles ? (delivery.attachments ?? 0) : 0;
    if (
      taken.length &&
      (fileCount + files > maxFiles || formatRunMessages([...taken.map((t) => t.delivery), delivery], undefined, max).length > max)
    ) {
      more = true;
      break;
    }
    fileCount += files;
    taken.push({ row, delivery });
  }
  if (!taken.length) return { ...none, more };
  // Only with the messages handOver already checked the run may hear, so a file goes wherever its message goes.
  if (withFiles) {
    for (const t of taken) {
      if (!t.delivery.attachments) continue;
      const message = await ctx.db.get(t.row.messageId);
      const files = message ? await roomFilesOf(ctx, await attachmentsOf(ctx, message)) : [];
      if (files.length) t.delivery.files = files;
    }
  }
  const at = Date.now();
  for (const { row, delivery } of taken) {
    await ctx.db.patch(row._id, { status: "claimed", claim: { id: claimId, at, how: args.how }, fromDriver: delivery.fromDriver });
  }
  await ctx.scheduler.runAfter(CLAIM_MS, internal.runDelivery.expireClaim, { claimId, deliveryIds: taken.map((t) => t.row._id) });
  return { claimId, deliveries: taken.map((t) => t.delivery), more };
}

/**
 * A claimed message the bridge gives back: `released` (no hook got it) waits again; `unsure` (a hook
 * got it and never said it wrote it) waits again once, then fails, since the session may have it.
 * Returns whether it waits again.
 */
async function giveBack(ctx: MutationCtx, row: Doc<"runInbox">, unsure: boolean): Promise<boolean> {
  const times = (row.unsure ?? 0) + (unsure ? 1 : 0);
  if (times > 1) {
    await ctx.db.patch(row._id, { status: "failed", error: "unsure", claim: undefined, unsure: times });
    return false;
  }
  await ctx.db.patch(row._id, { status: "waiting", claim: undefined, ...(unsure ? { unsure: times } : {}) });
  return true;
}

/** Settles the rows of one claim that are still claimed, and tells the bridge about those that wait again. */
async function settleClaim(
  ctx: MutationCtx,
  claimId: string,
  ids: string[],
  status: "delivered" | "released" | "unsure",
  how: RunMessageHow | undefined,
  machineId?: Id<"machines">,
): Promise<void> {
  const again = new Map<Id<"runs">, Doc<"runs">>();
  for (const raw of ids.slice(0, MAX_WAITING)) {
    const id = ctx.db.normalizeId("runInbox", raw);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.status !== "claimed" || row.claim?.id !== claimId) continue;
    const run = await ctx.db.get(row.runId);
    if (!run || (machineId !== undefined && run.machineId !== machineId)) continue;
    if (status === "delivered") await ctx.db.patch(row._id, { status: "delivered", how: how ?? row.claim.how, claim: undefined });
    else if (await giveBack(ctx, row, status === "unsure")) again.set(run._id, run);
  }
  for (const run of again.values()) await noticeRun(ctx, run);
}

/** The bridge's answer to a claim: only the run's own machine settles it, and only under its claim id. */
export async function runMessageResult(ctx: MutationCtx, machine: Doc<"machines">, m: BridgeMessageOf<"run_message_result">): Promise<void> {
  await settleClaim(ctx, m.claimId, m.deliveryIds, m.status, m.how, machine._id);
}

/** At most this many of an ended run's messages are settled in one step. */
const SETTLE_STEP = 100;

/**
 * A run's terminal ended (lib/bridgeMessages.ts `endTerminal`): its messages that wait or are
 * claimed can never reach it, so they fail with `run_ended`, in scheduled steps of SETTLE_STEP, so
 * a registration that ends many terminals stays within a transaction's limits.
 */
export async function runEnded(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  const open =
    (await ctx.db
      .query("runInbox")
      .withIndex("by_run_status", (q) => q.eq("runId", runId).eq("status", "waiting"))
      .first()) ??
    (await ctx.db
      .query("runInbox")
      .withIndex("by_run_status", (q) => q.eq("runId", runId).eq("status", "claimed"))
      .first());
  if (open) await ctx.scheduler.runAfter(0, internal.runDelivery.settleEnded, { runId });
}

/** One step of `runEnded`: fails up to SETTLE_STEP of the run's open messages, and schedules the next. */
export async function settleEnded(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  let settled = 0;
  for (const status of ["waiting", "claimed"] as const) {
    const rows = await ctx.db
      .query("runInbox")
      .withIndex("by_run_status", (q) => q.eq("runId", runId).eq("status", status))
      .take(SETTLE_STEP - settled);
    for (const row of rows) await ctx.db.patch(row._id, { status: "failed", error: "run_ended", claim: undefined });
    settled += rows.length;
  }
  if (settled === SETTLE_STEP) await ctx.scheduler.runAfter(0, internal.runDelivery.settleEnded, { runId });
}

/**
 * A claim the bridge never answered: unsure, as if the hook got it and never said it wrote it. A
 * claim the bridge held since (`holdRunMessages`) lapses only at its new end, which the hold scheduled.
 */
export async function expireClaim(ctx: MutationCtx, claimId: string, deliveryIds: Id<"runInbox">[]): Promise<void> {
  const now = Date.now();
  const lapsed: Id<"runInbox">[] = [];
  for (const id of deliveryIds.slice(0, MAX_WAITING)) {
    const row = await ctx.db.get(id);
    if (row?.claim?.id === claimId && (row.claim.until === undefined || row.claim.until <= now)) lapsed.push(id);
  }
  await settleClaim(ctx, claimId, lapsed, "unsure", undefined);
}

/**
 * The bridge still works on a claim (ADR 0043): it moves the claim's files before it sends the
 * messages, which can take longer than CLAIM_MS. Holding it keeps the messages claimed for another
 * CLAIM_MS, up to RUN_CLAIM_HOLD_MAX_MS after the claim was made. Held only when every message of the
 * claim is still claimed under it, on a run of this machine; otherwise the claim lapsed or was
 * settled, and the bridge must not send its messages.
 */
export async function holdRunMessages(
  ctx: MutationCtx,
  machine: Doc<"machines">,
  claimId: string,
  deliveryIds: string[],
): Promise<{ held: boolean }> {
  const now = Date.now();
  const rows: Doc<"runInbox">[] = [];
  for (const raw of deliveryIds.slice(0, MAX_WAITING + 1)) {
    const id = ctx.db.normalizeId("runInbox", raw);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.status !== "claimed" || row.claim?.id !== claimId) return { held: false };
    if (now - row.claim.at >= RUN_CLAIM_HOLD_MAX_MS || (row.claim.until ?? row.claim.at + CLAIM_MS) <= now) return { held: false };
    const run = await ctx.db.get(row.runId);
    if (!run || run.machineId !== machine._id) return { held: false };
    rows.push(row);
  }
  if (!rows.length || deliveryIds.length > MAX_WAITING) return { held: false };
  const until = Math.min(now + CLAIM_MS, rows[0]!.claim!.at + RUN_CLAIM_HOLD_MAX_MS);
  for (const row of rows) await ctx.db.patch(row._id, { claim: { ...row.claim!, until } });
  await ctx.scheduler.runAt(until, internal.runDelivery.expireClaim, { claimId, deliveryIds: rows.map((r) => r._id) });
  return { held: true };
}

/**
 * How a chat message's files reach a run (ADR 0043), for the composer to say: `with_message` where
 * the harness takes files with a message (a T3 Code thread's attachments), `saved` where the bridge
 * saves copies in the run's workspace and names their paths (a terminal's harness, though Codex and
 * Hermes Agent also get the images themselves), and `stay` where they stay in the room (an older
 * bridge, or a run with no bridge).
 */
export async function filesReach(ctx: QueryCtx, run: Doc<"runs">): Promise<"with_message" | "saved" | "stay"> {
  const machine = run.machineId ? await ctx.db.get(run.machineId) : null;
  if (!machine || !bridgeHandles(machine, "run_message_files")) return "stay";
  if (run.threadRef !== undefined) return "with_message";
  return run.terminalId !== undefined ? "saved" : "stay";
}
