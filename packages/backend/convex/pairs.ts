/**
 * Pairs (ADR 0027, ADR 0029 D9 to D13, ADR 0034): the Room API's Pair functions for the people a
 * Pair belongs to, in the app or with a CLI sign-in, and for agents with their agent key and the
 * `pairs.join` scope (D11). A joined run acts in its Pairs with its own run token instead, through
 * `joined.pairCode`, `joined.pairJoin`, `joined.pairResume`, `joined.take` and `joined.say`
 * (joined.ts). Library code is in lib/pairs.ts.
 *
 * Every function answers not_found for a Pair the caller isn't in, the same as for one that doesn't
 * exist, and shows only the Pair: names, pictures and run labels under ids that exist only in it,
 * never an email, a team, or anything in one (D12).
 */
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { publicQuery } from "./lib/refusals";
import { roomError, isRoomRefusal } from "./lib/errors";
import {
  CODE_FAILURE_WINDOW_MS,
  createPersonPair,
  endPair,
  failPairRows,
  FORGET_STEP,
  forgetMessagesStep,
  forgetPairsStep,
  forgetPersonInPairs,
  leavePair,
  livePair,
  makePairCode,
  PAIR_PAGE_MAX,
  pairForActor,
  pairMessagesPage,
  pairMessagesView,
  pairsOf,
  pairsPage,
  pairView,
  postInPair,
  redeemPairCode,
  removeAgent,
  type PairViewer,
} from "./lib/pairs";
import { pairMutation, pairQuery } from "./lib/room";
import { grantPairAttachment, pairAttachmentsOf, pairGrantFor, prunePairGrants, vNewPairAttachment } from "./lib/pairAttachments";
import { MAX_ATTACHMENTS } from "./lib/messages";
import { accountActorForIdentity, type PairActor } from "./lib/actor";
import { internal } from "./_generated/api";

function viewerOf(actor: PairActor): PairViewer {
  return actor.kind === "agent" ? { personId: actor.person._id, agentId: actor.agent._id } : { personId: actor.person._id };
}

export const { person: list, signIn: listBySignIn, agent: listAgent } = pairQuery({
  name: "pairs.list",
  description:
    "Your Pairs (ADR 0027): private conversations of 2 to 10 joined runs and agents, plus their people, in any teams or none. A person sees the Pairs they are in, newest first, ended ones too; an agent, those it is in now. Each has its pairId, its people (name and picture), its live runs (label) and its agents (name), each with an id that exists only in the Pair, unread (messages you haven't read) and seq (the newest message's number). Never anyone's email or team.",
  args: {},
  handler: async (ctx, actor) => {
    const views = [];
    for (const pair of await pairsOf(ctx, actor)) views.push(await pairView(ctx, pair, viewerOf(actor)));
    return views;
  },
});

export const { person: get, signIn: getBySignIn, agent: getAgent } = pairQuery({
  name: "pairs.get",
  description: "One of your Pairs, as pairs.list shows each: its people, live runs, agents, unread and seq.",
  args: { pairId: v.string() },
  argDocs: { pairId: "A pairId, from pairs.list" },
  handler: async (ctx, actor, args) => {
    const { pair } = await pairForActor(ctx, actor, args.pairId);
    return pairView(ctx, pair, viewerOf(actor));
  },
});

export const { person: messages, signIn: messagesBySignIn, agent: messagesAgent } = pairQuery({
  name: "pairs.messages",
  description: `A Pair's messages, oldest first: its newest ${50} (or limit, at most ${PAIR_PAGE_MAX}), or with afterSeq those after it. Each has its messageId, seq, body, at, and from: who wrote it (kind person, run or agent, its name, and the person accountable for it), or "A deleted account" once that person deleted theirs. Mark them read with pairs.markRead.`,
  args: { pairId: v.string(), afterSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  argDocs: {
    pairId: "A pairId, from pairs.list",
    afterSeq: "Only messages after this seq, such as the last one you read",
    limit: `How many, at most ${PAIR_PAGE_MAX} (default 50)`,
  },
  handler: async (ctx, actor, args) => {
    const { pair } = await pairForActor(ctx, actor, args.pairId);
    return pairMessagesView(ctx, pair, args);
  },
});

export const { person: post, signIn: postBySignIn, agent: postAgent } = pairMutation({
  name: "pairs.post",
  description: `Write in one of your live Pairs. It reaches every run in it, through its inbox as its other messages do, and is unread for everyone else in it. Attach up to ${MAX_ATTACHMENTS} files uploaded through pairs.attachUrl (ADR 0048); with files the text may be empty. A run hears how many files came and saves them with uplink download. notDelivered names a run whose inbox was full. Returns messageId and seq.`,
  args: { pairId: v.string(), text: v.string(), attachments: v.optional(v.array(vNewPairAttachment)) },
  argDocs: {
    pairId: "A pairId, from pairs.list",
    text: "The message, at most 20,000 characters; may be empty with files",
    attachments: "Files to send with it: each { uploadId, storageId, name } from pairs.attachUrl and an upload to it",
  },
  handler: async (ctx, actor, args) => {
    const { pair, agentRow } = await pairForActor(ctx, actor, args.pairId);
    if (pair.endedAt !== undefined) throw roomError("invalid", "This Pair has ended.");
    const author = agentRow ? ({ kind: "agent", agentRow } as const) : ({ kind: "person", personId: actor.person._id } as const);
    const posted = await postInPair(ctx, pair, author, args.text, args.attachments ?? []);
    return { messageId: posted.messageId, seq: posted.seq, pairId: pair._id, ...(posted.notDelivered.length ? { notDelivered: posted.notDelivered } : {}) };
  },
});

export const { person: attachUrl, signIn: attachUrlBySignIn, agent: attachUrlAgent } = pairMutation({
  name: "pairs.attachUrl",
  description:
    "A URL to upload one file to send in a live Pair of yours (ADR 0048), valid for one hour, and its uploadId. POST the bytes with their Content-Type; the response is { storageId }. Then pass { uploadId, storageId, name } in pairs.post attachments, in the same Pair. Images (PNG, JPEG, GIF, WebP) up to 20 MB and PDFs up to 50 MB show in the app, and their Content-Type must match the name's extension; SVG is refused. Any other file, up to 50 MB, is only ever offered as a download. Uploads no message keeps are deleted within the hour.",
  args: { pairId: v.string() },
  argDocs: { pairId: "A pairId, from pairs.list: the Pair the file is for" },
  handler: async (ctx, actor, args) => {
    const { pair, agentRow } = await pairForActor(ctx, actor, args.pairId);
    if (pair.endedAt !== undefined) throw roomError("invalid", "This Pair has ended.");
    const uploadId = await ctx.db.insert("pairUploads", {
      personId: actor.person._id,
      by: agentRow ? { kind: "agent", pairAgentId: agentRow._id } : { kind: "person", pairId: pair._id },
    });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId, pairId: pair._id };
  },
});

export const { person: attachmentLink, signIn: attachmentLinkBySignIn, agent: attachmentLinkAgent } = pairMutation({
  name: "pairs.attachmentLink",
  description:
    "A link to one of a Pair message's files (attachmentIndex counts from 0), for you alone, that works for 10 minutes and only while you are still in the Pair (ADR 0048). A Pair's files have no other link: in pairs.messages their url and downloadUrl are null. download: true serves it as a download; otherwise images and PDFs are served to show in place and any other file as a download. Returns { url, expiresAt, pairId }.",
  args: { messageId: v.string(), attachmentIndex: v.number(), download: v.optional(v.boolean()) },
  argDocs: {
    messageId: "A Pair message's messageId, from pairs.messages",
    attachmentIndex: "Which of its files, from 0",
    download: "Serve it as a download rather than to show",
  },
  handler: async (ctx, actor, args) => {
    const id = ctx.db.normalizeId("pairMessages", args.messageId);
    const message = id ? await ctx.db.get(id) : null;
    if (!message) throw roomError("not_found", "No such message in your Pairs.");
    // not_found for a Pair the caller isn't in, as for every Pair function.
    const { pair, agentRow } = await pairForActor(ctx, actor, message.pairId);
    const row = (await pairAttachmentsOf(ctx, message)).find((a) => a.position === args.attachmentIndex);
    if (!row) throw roomError("not_found", `That message has no file ${args.attachmentIndex}.`);
    const agentKeyId = actor.kind === "agent" ? actor.actor.agentKeyId : undefined;
    const by = agentRow
      ? ({ kind: "agent", pairAgentId: agentRow._id, ...(agentKeyId ? { agentKeyId } : {}) } as const)
      : ({ kind: "person", personId: actor.person._id } as const);
    return { ...(await grantPairAttachment(ctx, row, by, args.download === true)), pairId: pair._id };
  },
});

/**
 * What a Pair file link may serve (http.ts `/attachments/pair/<token>`), by its token's hash, and
 * whether whoever it was made for is still in the Pair.
 */
export const attachmentGrant = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => pairGrantFor(ctx, tokenHash),
});

export const { person: markRead, signIn: markReadBySignIn, agent: markReadAgent } = pairMutation({
  name: "pairs.markRead",
  description: "Mark a Pair's messages read, up to seq (default: all of them), so pairs.list counts none of them as unread.",
  args: { pairId: v.string(), seq: v.optional(v.number()) },
  argDocs: { pairId: "A pairId, from pairs.list", seq: "Read up to this message seq (default: the newest)" },
  handler: async (ctx, actor, args) => {
    const { pair, agentRow, personRow } = await pairForActor(ctx, actor, args.pairId);
    const seq = Math.min(pair.seq, Math.max(0, Math.floor(args.seq ?? pair.seq)));
    const row = agentRow ?? personRow!;
    if (seq > row.readSeq) await ctx.db.patch(row._id, { readSeq: seq });
    return { pairId: pair._id, readSeq: Math.max(seq, row.readSeq) };
  },
});

export const { person: code, signIn: codeBySignIn, agent: codeAgent } = pairMutation({
  name: "pairs.code",
  description:
    "Make a pair code, such as RIVER-4821-MAPLE-0937, for one of your live Pairs, as uplink pair does in a run that's in it: one more run (uplink pair <code>) or agent (pairs.join) can join with it. It works once, for 10 minutes. Only the Pair's people make codes; an agent can't.",
  args: { pairId: v.string() },
  argDocs: { pairId: "A pairId, from pairs.list" },
  handler: async (ctx, actor, args) => {
    if (actor.kind === "agent") throw roomError("forbidden", "Only a Pair's people make its codes: ask yours, or a run in the Pair (uplink pair).");
    const { pair } = await pairForActor(ctx, actor, args.pairId);
    await livePair(ctx, pair._id);
    return makePairCode(ctx, pair, actor.person._id);
  },
});

export const { person: create, signIn: createBySignIn, agent: createAgent } = pairMutation({
  name: "pairs.create",
  description:
    "Make a new Pair with only you in it, as the app's New Pair does: then make a code for it with pairs.code, so someone's run (uplink pair <code>), agent (pairs.join) or self in the app (pairs.join) joins. Returns the Pair as pairs.list shows each. Only a person makes one; a run makes its own with uplink pair.",
  args: {},
  handler: async (ctx, actor) => {
    if (actor.kind === "agent") throw roomError("forbidden", "Only a person makes a Pair. An agent joins one with a code its person passes on.");
    return pairView(ctx, await createPersonPair(ctx, actor.person._id), viewerOf(actor));
  },
});

export const { person: join, signIn: joinBySignIn, agent: joinAgent } = pairMutation({
  name: "pairs.join",
  description:
    "Join a Pair with a pair code someone passed on. An agent (ADR 0029 D11) then reads the Pair (pairs.messages, pairs.list's unread), writes in it (pairs.post) and leaves it (pairs.leave), and its person becomes one of the Pair's people; it needs the pairs.join scope. A person joins as one of its people, with no run, as the app does: their runs can then rejoin with uplink pair --resume. The Pair shows a name and picture, never a team. A code works once; a wrong, used or expired one is refused, and after 10 wrong codes in an hour no code works for that person (an agent's: its person) until the hour is over. To put a session's run in a Pair, run uplink pair <code> in that session instead.",
  args: { code: v.string() },
  argDocs: { code: "The pair code, such as RIVER-4821-MAPLE-0937, in any case" },
  handler: async (ctx, actor, args) => {
    const pair = await redeemPairCode(ctx, actor.person._id, args.code, actor.kind === "agent" ? { kind: "agent", agent: actor } : { kind: "person" });
    if (isRoomRefusal(pair)) return pair;
    return pairView(ctx, pair, viewerOf(actor));
  },
});

export const { person: leave, signIn: leaveBySignIn, agent: leaveAgent } = pairMutation({
  name: "pairs.leave",
  description:
    "Leave a Pair. An agent reads and writes there no more, and the Pair goes on. A person stops being one of its people and can't read it after: their runs and agents in it leave with them, their messages stay, and a Pair left with fewer than two people ends. To end it for everyone, use pairs.end.",
  args: { pairId: v.string() },
  argDocs: { pairId: "A pairId, from pairs.list" },
  handler: async (ctx, actor, args) => {
    const { pair, agentRow, personRow } = await pairForActor(ctx, actor, args.pairId);
    if (agentRow) await removeAgent(ctx, agentRow);
    else await leavePair(ctx, pair, personRow!);
    return null;
  },
});

export const { person: end, signIn: endBySignIn, agent: endAgent } = pairMutation({
  name: "pairs.end",
  description:
    "End one of your Pairs, as any of its people may: its runs and agents leave it, its codes stop working, and nobody can write in it. Its people can still read it. Only a person ends a Pair; an agent leaves with pairs.leave.",
  args: { pairId: v.string() },
  argDocs: { pairId: "A pairId, from pairs.list" },
  handler: async (ctx, actor, args) => {
    if (actor.kind === "agent") throw roomError("forbidden", "Only a Pair's people end it. An agent leaves with pairs.leave.");
    const { pair } = await pairForActor(ctx, actor, args.pairId);
    await endPair(ctx, pair, actor.person._id, "ended");
    return null;
  },
});

/**
 * The app's pages of your Pairs (ADR 0036), the ones you joined last first, for Convex's
 * usePaginatedQuery: it reaches every one, however many there are, where pairs.list stops at its
 * first PAIRS_LISTED. Each is as pairs.list shows it. Only for the app's own session, so it isn't in
 * the Room API.
 */
export const listPage = publicQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const actor = await accountActorForIdentity(ctx);
    const result = await pairsPage(ctx, actor, args.paginationOpts);
    const page = [];
    for (const pair of result.page) page.push(await pairView(ctx, pair, viewerOf(actor)));
    return { ...result, page };
  },
});

/**
 * The app's pages of a Pair's messages, newest first, for usePaginatedQuery, so it loads older ones
 * as you scroll up back to the first (ADR 0036). Each is as pairs.messages shows it.
 */
export const messagesPage = publicQuery({
  args: { pairId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { pair } = await pairForActor(ctx, await accountActorForIdentity(ctx), args.pairId);
    return pairMessagesPage(ctx, pair, args.paginationOpts);
  },
});

/** One step of failing what waited for a run that left a pair, or every pair (lib/pairs.ts `settleEndedPairRun`). */
export const settleEnded = internalMutation({
  args: { sessionId: v.id("joinedSessions"), pairId: v.optional(v.id("pairs")) },
  handler: async (ctx, { sessionId, pairId }) => {
    await failPairRows(ctx, sessionId, pairId);
  },
});

/**
 * Account deletion's part in Pairs on its own (ADR 0029 D10; a whole deletion runs the same steps in
 * accounts.cleanUp, ADR 0035): their runs and agents leave their Pairs, their messages stay as "A deleted account",
 * and a Pair left with fewer than two people ends. It leaves their first Pairs and schedules
 * `forgetPairs` for the rest (`more`); calling it again resumes where the last step stopped.
 */
export const forgetPerson = internalMutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => forgetPersonInPairs(ctx, personId),
});

/** One step of leaving a deleted account's Pairs; schedules the next while more are left. */
export const forgetPairs = internalMutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    await forgetPairsStep(ctx, personId);
  },
});

/** One step of making a deleted account's Pair messages anonymous; schedules the next while more are left. */
export const forgetMessages = internalMutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    if ((await forgetMessagesStep(ctx, personId)) === FORGET_STEP) await ctx.scheduler.runAfter(0, internal.pairs.forgetMessages, { personId });
  },
});

/** At most this many rows of each kind are deleted in one run of `prune`; the next hour takes the rest. */
const PRUNE_STEP = 1000;

/**
 * Hourly: pair codes a day after they expire (a used one too: its pair keeps who joined), wrong
 * code counts whose hour is over, and expired links to Pair files, so no table grows without end.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const codes = await ctx.db
      .query("pairCodes")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now - 24 * 60 * 60_000))
      .take(PRUNE_STEP);
    for (const code of codes) await ctx.db.delete(code._id);
    const failures = await ctx.db
      .query("pairCodeFailures")
      .withIndex("by_window", (q) => q.lt("windowStart", now - CODE_FAILURE_WINDOW_MS))
      .take(PRUNE_STEP);
    for (const row of failures) await ctx.db.delete(row._id);
    // Pair file links that expired (ADR 0048).
    const links = await prunePairGrants(ctx, PRUNE_STEP);
    return { codes: codes.length, failures: failures.length, links };
  },
});
