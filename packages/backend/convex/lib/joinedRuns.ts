/**
 * Joined runs (ADR 0027, ADR 0029 D8 and D13, ADR 0032): a session that joined the room by itself
 * with `uplink join`, as its signed-in person. With a team it is a `runs` row with no machine,
 * terminal or thread (`joinedSessionId`), driven by the person's member, Unknown while live (it
 * reports no state, so it is in nobody's Needs you), and live until it ends: when it leaves, its
 * session ends, its CLI sign-in is revoked or expires, someone stops it, or two minutes pass with no
 * heartbeat. It then shows Done (Stopped when someone stopped it), and its run token stops working.
 *
 * Its token acts only as the run (`joined.*` run functions): it reads its inbox, posts as the run,
 * and keeps it alive. The messages it posts are stored under its driver with `asRun` (D2), through
 * the same checks as `messages.post`, as `bridge:runSay` does for a run in a bridge terminal, so a
 * joined run can't post where its person can't (ADR 0016).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { postMessage } from "../messages";
import type { Actor, JoinedRun, TeamJoinedRun } from "./actor";
import type { NewAttachment } from "./attachments";
import { RUN_MESSAGE_TEXT_MAX } from "@uplink-room/protocol";
import { DELIVERY_TEXT_MAX, formatRunMessages, type RunDelivery } from "@uplink-room/protocol/runMessages";
import { canSee, channelAccess, isDirect, messageAccess } from "./channels";
import { roomError } from "./errors";
import { audit } from "./members";
import { endPairRunsOfSession, pairDelivery, settleEndedPairRun } from "./pairs";
import { CLAIM_MS, MAX_WAITING, messageText, placeOf, runEnded } from "./runDelivery";

// A joined run's claims last as long as the bridge's.
export { CLAIM_MS } from "./runDelivery";
import { hearsFrom, hearsIn, runLabel, runNamer } from "./runLabels";

/** The prefix of a joined run's token, beside agent keys' `urk_` and CLI sign-ins' `urs_`. */
export const RUN_TOKEN_PREFIX = "urj_";

export function isRunToken(token: string): boolean {
  return token.startsWith(RUN_TOKEN_PREFIX);
}

/** How often a joined session's keeper sends a heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** A joined run with no heartbeat for this long ends (joined.expire). */
export const HEARTBEAT_TIMEOUT_MS = 2 * 60_000;

/** The longest message a joined run posts, in characters, as for a run in a bridge terminal. */
export const SAY_TEXT_MAX = 20_000;
/** At most this many messages are taken from the inbox at once. */
export const TAKE_MAX = 20;

export type EndReason = NonNullable<Doc<"joinedSessions">["endReason"]>;

/** Checks again when the session's heartbeat would be two minutes old. */
export async function scheduleExpiry(ctx: MutationCtx, session: Pick<Doc<"joinedSessions">, "_id" | "lastSeenAt">): Promise<void> {
  await ctx.scheduler.runAt(session.lastSeenAt + HEARTBEAT_TIMEOUT_MS, internal.joined.expire, { joinId: session._id });
}

/**
 * Ends a joined session and its run, once: the token stops working and the run stops being live.
 * `stopped`: someone stopped the run (runs.stop has already marked it Stopped); every other reason
 * leaves it Done.
 */
export async function endJoinedSession(ctx: MutationCtx, session: Doc<"joinedSessions">, reason: EndReason): Promise<void> {
  if (session.endedAt !== undefined) return;
  const now = Date.now();
  await ctx.db.patch(session._id, { endedAt: now, endReason: reason });
  const run = session.runId ? await ctx.db.get(session.runId) : null;
  if (run && run.endedAt === undefined) {
    await ctx.db.patch(run._id, { state: "done", stateChangedAt: now, endedAt: now });
  }
  // Its token no longer works, so what waits for it, or is claimed, can't reach it: it fails as
  // run_ended, as a bridge terminal's does when it ends. Also when runs.stop ended the run first.
  if (session.runId) await runEnded(ctx, session.runId);
  // It leaves its Pairs, which go on: they belong to their people (ADR 0027).
  await endPairRunsOfSession(ctx, session._id);
}

/**
 * Opens or closes a joined run (ADR 0044): closed, only its person and their agents can see it,
 * address it or have it hear them. Only a joined run can be closed; a run started in the app is
 * always open. Returns whether it is open now.
 */
export async function setRunOpen(
  ctx: MutationCtx,
  actor: Actor,
  run: Doc<"runs">,
  open: boolean,
): Promise<boolean> {
  if (!run.joinedSessionId) {
    if (open) return true;
    throw roomError(
      "invalid",
      "Only a session that joined with uplink join can be closed: a run started in the app is open to its team.",
    );
  }
  // A task is the team's to see, and so are the runs on it.
  if (!open && run.taskId) throw roomError("invalid", "This run is filed under a task, which the team can see, so it stays open.");
  if ((run.closed !== true) !== open) {
    await ctx.db.patch(run._id, { closed: !open });
    await audit(ctx, actor, open ? "run.opened" : "run.closed", run._id);
  }
  return open;
}

/**
 * At most this many joined sessions end in one step. Ending one reads about ten index ranges (its
 * run, what waits for it, its Pairs), so a step stays far under Convex's 4,096.
 */
export const END_SESSIONS_STEP = 100;

/**
 * One step of ending the joined sessions made with a CLI sign-in that was revoked or expired. True
 * while more may be left. Their run tokens already refuse (joinedRunForToken checks the sign-in).
 */
export async function endJoinedSessionsStep(ctx: MutationCtx, signInId: Id<"cliSignIns">): Promise<boolean> {
  const sessions = await ctx.db
    .query("joinedSessions")
    .withIndex("by_sign_in_ended", (q) => q.eq("signInId", signInId).eq("endedAt", undefined))
    .take(END_SESSIONS_STEP);
  for (const session of sessions) await endJoinedSession(ctx, session, "signed_out");
  return sessions.length === END_SESSIONS_STEP;
}

/**
 * One message as a joined run takes it: a run delivery, labelled and cut as the bridge's are
 * (`@uplink-room/protocol/runMessages`; `deliveryId` is its `runInbox` or `pairInbox` row), with the
 * place it is in, which `uplink inbox --json` shows: a team's channel and thread, or a Pair (whose
 * `from` and `accountable` ids are the pair's own, lib/pairs.ts).
 */
export type Delivery = RunDelivery & ({ channelId: Id<"channels">; replyTo?: Id<"messages"> } | { pairId: Id<"pairs"> });

type Waiting = { kind: "team"; row: Doc<"runInbox"> } | { kind: "pair"; row: Doc<"pairInbox"> };

/** A team message as the run may read it now, or why it can't: deleted, out of its driver's sight, or not heard. */
async function teamDelivery(
  ctx: QueryCtx,
  joined: TeamJoinedRun,
  row: Doc<"runInbox">,
  name: ReturnType<typeof runNamer>,
): Promise<Delivery | "deleted" | "unseen" | "not_heard" | "visible_outside"> {
  const { run, actor } = joined;
  const message = await ctx.db.get(row.messageId);
  const channel = await ctx.db.get(row.channelId);
  const from = await ctx.db.get(row.from.memberId);
  const accountable = await ctx.db.get(row.accountableId);
  if (!message || message.deletedAt !== undefined) return "deleted";
  if (!channel || !from || !accountable || !(await canSee(ctx, actor, channel))) return "unseen";
  // A joined run is a team run, whose session may be shared: nothing from a private place reaches it,
  // except a direct message opened with it, which says so (ADR 0039, amended 2026-11-05).
  if (!(await hearsIn(ctx, run, channel))) return "visible_outside";
  // Its driver may have narrowed who the run hears (runs.setHears) since it was sent, as the
  // bridge's hand-over checks (lib/runDelivery.ts).
  if (!(await hearsFrom(ctx, run, { member: from, accountable }))) return "not_heard";
  const text = await messageText(ctx, run.teamId, message, name);
  const cut = text.length > RUN_MESSAGE_TEXT_MAX;
  return {
    deliveryId: row._id,
    messageId: message._id,
    channelId: channel._id,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    place: placeOf(channel, message),
    // A cut can split a surrogate pair, and Convex refuses a string with half of one.
    text: cut ? text.slice(0, RUN_MESSAGE_TEXT_MAX).toWellFormed() : text,
    ...(cut ? { cut: true } : {}),
    ...(message.attachmentCount ? { attachments: message.attachmentCount } : {}),
    from: { memberId: from._id, name: from.name, kind: from.kind === "agent" ? "agent" : "person", ...(message.asRun ? { run: message.asRun.label } : {}) },
    accountable: { memberId: accountable._id, name: accountable.name },
    fromDriver: row.fromDriver,
    at: row.at,
  };
}

/**
 * Takes the run's oldest waiting messages, from its team and from its Pairs, in the order they came,
 * as many as fit in one delivery (at most TAKE_MAX), measured with the same function the session
 * writes them with (`formatRunMessages`), keeping `reserve` characters for the session's own lines.
 * It claims them `how` under a new claim id, as the bridge's claims are (lib/runDelivery.ts,
 * `CLAIM_MS`): they are delivered only when the session says it has them (`settleClaim`
 * "delivered", `joined.ack`), and a claim nobody answers within CLAIM_MS lapses (`expireClaim`). A
 * message deleted since, in a place its driver can no longer see, or in a Pair the run is no longer
 * in, is marked failed and left out. `waiting` is how many it left waiting.
 */
export async function takeWaiting(
  ctx: MutationCtx,
  joined: JoinedRun,
  how: "mid_task" | "next_turn",
  reserve = 0,
): Promise<{ claimId: string; messages: Delivery[]; waiting: number }> {
  const { run, session } = joined;
  const claimId = crypto.randomUUID();
  const now = Date.now();
  const teamRows = run
    ? await ctx.db
        .query("runInbox")
        .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "waiting"))
        .take(MAX_WAITING)
    : [];
  const pairRows = await ctx.db
    .query("pairInbox")
    .withIndex("by_session_status", (q) => q.eq("sessionId", session._id).eq("status", "waiting"))
    .take(MAX_WAITING);
  const rows: Waiting[] = [...teamRows.map((row) => ({ kind: "team" as const, row })), ...pairRows.map((row) => ({ kind: "pair" as const, row }))].sort(
    (a, b) => a.row.at - b.row.at || a.row._creationTime - b.row._creationTime,
  );
  const max = DELIVERY_TEXT_MAX - Math.min(Math.max(0, Math.floor(reserve)), DELIVERY_TEXT_MAX / 2);
  const name = runNamer(ctx);
  const messages: Delivery[] = [];
  let looked = 0;
  for (const entry of rows) {
    if (messages.length >= TAKE_MAX) break;
    const delivery: Delivery | string =
      entry.kind === "team" ? await teamDelivery(ctx, joined as TeamJoinedRun, entry.row, name) : await pairDelivery(ctx, session, entry.row);
    if (typeof delivery === "string") {
      const error = delivery === "unseen" ? undefined : (delivery as "deleted" | "not_heard" | "run_ended" | "visible_outside");
      await ctx.db.patch(entry.row._id, { status: "failed", ...(error ? { error } : {}) } as never);
      looked++;
      continue;
    }
    // Only whole messages that fit together; a single one longer than a delivery is cut to fit.
    if (messages.length && formatRunMessages([...messages, delivery], undefined, max).length > max) break;
    messages.push(delivery);
    looked++;
    await ctx.db.patch(entry.row._id, { status: "claimed", claim: { id: claimId, at: now, how } });
  }
  if (messages.length) {
    await ctx.scheduler.runAfter(CLAIM_MS, internal.joined.expireClaim, { ...(run ? { runId: run._id } : {}), sessionId: session._id, claimId });
  }
  return { claimId, messages, waiting: rows.length - looked };
}

/** One claimed row settled: delivered as claimed, back to waiting, or unsure (waits again once, then fails). */
async function settleRow(ctx: MutationCtx, row: Doc<"runInbox"> | Doc<"pairInbox">, status: "delivered" | "released" | "unsure"): Promise<void> {
  if (status === "delivered") {
    await ctx.db.patch(row._id, { status: "delivered", how: row.claim!.how, claim: undefined });
  } else if (status === "released") {
    await ctx.db.patch(row._id, { status: "waiting", claim: undefined });
  } else {
    const times = (row.unsure ?? 0) + 1;
    await ctx.db.patch(row._id, times > 1 ? { status: "failed", error: "unsure", claim: undefined, unsure: times } : { status: "waiting", claim: undefined, unsure: times });
  }
}

/**
 * Settles the messages of one claim that are still claimed, from the run's team inbox and its Pairs'
 * (`sessionId`): `delivered` (the session has them, as they were taken), `released` (they never
 * reached it: they wait again), or `unsure` (the claim lapsed: the session may have them). An unsure
 * message waits again once, then fails as unsure, so a session that keeps dying before it answers
 * doesn't get the same message forever. Returns how many it settled.
 */
export async function settleClaim(
  ctx: MutationCtx,
  owner: { runId?: Id<"runs">; sessionId?: Id<"joinedSessions"> },
  claimId: string,
  status: "delivered" | "released" | "unsure",
): Promise<number> {
  let settled = 0;
  if (owner.runId) {
    const runId = owner.runId;
    // A claim that lapses or is let go after its run ended has nowhere to wait again.
    if (status !== "delivered" && (await ctx.db.get(runId))?.endedAt !== undefined) {
      await runEnded(ctx, runId);
    } else {
      const rows = (
        await ctx.db
          .query("runInbox")
          .withIndex("by_run_status", (q) => q.eq("runId", runId).eq("status", "claimed"))
          .take(MAX_WAITING * 2)
      ).filter((row) => row.claim?.id === claimId);
      for (const row of rows) await settleRow(ctx, row, status);
      settled += rows.length;
    }
  }
  if (owner.sessionId) {
    const sessionId = owner.sessionId;
    if (status !== "delivered" && (await ctx.db.get(sessionId))?.endedAt !== undefined) {
      await settleEndedPairRun(ctx, sessionId);
    } else {
      const rows = (
        await ctx.db
          .query("pairInbox")
          .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "claimed"))
          .take(MAX_WAITING * 2)
      ).filter((row) => row.claim?.id === claimId);
      for (const row of rows) await settleRow(ctx, row, status);
      settled += rows.length;
    }
  }
  return settled;
}

/** At most this many of a team's channels are read to find one by name. */
const CHANNEL_SCAN = 1000;

/** A place a run names: a channel id, or a channel's name with or without `#`, that its driver can see. */
async function placeFor(ctx: QueryCtx, actor: Actor, place: string): Promise<Doc<"channels">> {
  const raw = place.trim();
  const id = ctx.db.normalizeId("channels", raw);
  if (id) return channelAccess(ctx, actor, id);
  const name = raw.replace(/^#/, "").trim().toLowerCase();
  const channels = await ctx.db
    .query("channels")
    .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
    .take(CHANNEL_SCAN);
  for (const channel of channels) {
    if (isDirect(channel) || channel.archivedAt !== undefined || channel.name.toLowerCase() !== name) continue;
    if (await canSee(ctx, actor, channel)) return channel;
  }
  throw roomError("not_found", `No channel named #${name} that ${actor.member.name} can see. Name a channel, such as #general, or give a channel id.`);
}

/**
 * Posts as the joined run (`uplink say --in <place>` and `uplink reply <messageId>`, ADR 0029 D5): in a
 * place, or under a message, as the run's driver with `asRun`, through `messages.post`'s checks.
 */
export async function sayAsRun(
  ctx: MutationCtx,
  joined: TeamJoinedRun,
  args: { text: string; in?: string; replyTo?: string; attachments?: NewAttachment[] },
): Promise<{ messageId: Id<"messages">; label: string; place: string }> {
  const { run, actor } = joined;
  const text = args.text.trim();
  const attachments = args.attachments ?? [];
  if (!text && !attachments.length) throw roomError("invalid", "A message needs text or a file.");
  if (text.length > SAY_TEXT_MAX) throw roomError("invalid", `A message can be at most ${SAY_TEXT_MAX} characters.`);
  if (!args.in?.trim() === !args.replyTo?.trim()) {
    throw roomError("invalid", 'Say where: uplink say --in "#place" "text" posts in a place, and uplink reply <messageId> "text" answers a message.');
  }
  let channel: Doc<"channels">;
  let replyTo: Id<"messages"> | undefined;
  if (args.replyTo?.trim()) {
    const id = ctx.db.normalizeId("messages", args.replyTo.trim());
    if (!id) throw roomError("not_found", "Not found in this team.");
    ({ channel } = await messageAccess(ctx, actor, id));
    replyTo = id;
  } else {
    channel = await placeFor(ctx, actor, args.in!);
  }
  const label = await runLabel(ctx, run);
  const messageId = await postMessage(
    ctx,
    actor,
    { channelId: channel._id, body: text, ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments } : {}) },
    { runId: run._id, label },
  );
  await audit(ctx, actor, "run.said", run._id, {
    messageId,
    label,
    driverId: actor.member._id,
    accountableId: actor.member._id,
    ...(attachments.length ? { files: attachments.length } : {}),
  });
  return { messageId, label, place: placeOf(channel, { replyTo }) };
}
