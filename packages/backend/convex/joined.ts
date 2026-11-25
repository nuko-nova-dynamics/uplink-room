/**
 * Joined runs (ADR 0027, ADR 0032, GLOSSARY "Joined run"): `uplink join` makes the harness session
 * it runs in a live run of its signed-in person in a team, with no bridge or app.
 *
 * `joined.start` is an account function: the person's CLI sign-in (ADR 0030) makes the join and gets
 * the run's own token back, once. Every other function here is a run function: it takes only that
 * run token (`urj_…`) and acts only as that run (ADR 0029 D8), so the hooks and commands in the
 * session never hold the person's sign-in. Library code is in lib/joinedRuns.ts.
 *
 * A session can join with no team (D13): it then has no `runs` row and can only pair (ADR 0034).
 * `joined.pairCode`, `joined.pairJoin` and `joined.pairResume` put it in Pairs (lib/pairs.ts), whose
 * messages it takes with the same `joined.take`, and answers with the same `joined.say`.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { memberForPerson, teamRunOf, type Actor, type JoinedRun } from "./lib/actor";
import { randomSecret, sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { grantPairAttachment, pairAttachmentsOf, vNewRunAttachment, type NewPairAttachment } from "./lib/pairAttachments";
import {
  CLAIM_MS,
  endJoinedSession,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  RUN_TOKEN_PREFIX,
  sayAsRun,
  scheduleExpiry,
  setRunOpen,
  settleClaim,
  takeWaiting,
} from "./lib/joinedRuns";
import { audit } from "./lib/members";
import {
  createPair,
  joinedLabel,
  livePair,
  makePairCode,
  pairPersonRow,
  pairPlace,
  pairRunLabel,
  pairRunsOfSession,
  pairView,
  postInPair,
  redeemPairCode,
  sessionPair,
  waitingPairRows,
  addRun,
} from "./lib/pairs";
import { MAX_WAITING } from "./lib/router";
import { accountMutation, joinedRunMutation, joinedRunQuery } from "./lib/room";
import { runLabel } from "./lib/runLabels";
import { isRoomRefusal } from "./lib/errors";

const vHearing = v.union(v.literal("mid_task"), v.literal("between_turns"), v.literal("none"));

/** A harness as runs name it: claude-code, codex, or another agent's own lower-case name. */
const HARNESS = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const { person: start, signIn: startBySignIn } = accountMutation({
  name: "joined.start",
  description:
    "Join the harness session this runs in to a team as a live run of yours (ADR 0027): what `uplink join --team <team>` calls. The session becomes a joined run named like any run, such as \"Claude Code (Pepe)\": listed in runs.live while its heartbeat lasts, mentionable with <@run:RUNID>, Unknown in the Inbox and in nobody's Needs you, since it reports no state. Returns open and its run token (urj_…) once: it acts only as this run, through the joined.* run functions (inbox, say, heartbeat, leave), and stops working when the run ends or the CLI sign-in it was made with is revoked or expires. The run ends with joined.leave, when runs.stop stops it, or after two minutes with no joined.heartbeat. Only with a CLI sign-in (uplink login), not in the app. A new run starts closed (ADR 0044): only its person and their agents can see it or message it, until it is opened with open: true here, joined.setOpen or runs.setOpen. Joining the same session again in the same team (or again in none) keeps its run, and whether it is open unless open: true, and gives it a new token; in another team, the old run ends. Without teamId the session joins in no team and can only pair (D13): it isn't a run in any team, and joined.pairCode, joined.pairJoin and joined.pairResume put it in Pairs with runs of anyone else signed in.",
  args: {
    teamId: v.optional(v.id("teams")),
    harness: v.string(),
    sessionRef: v.string(),
    title: v.optional(v.string()),
    hearing: vHearing,
    open: v.optional(v.boolean()),
  },
  argDocs: {
    teamId: "The team the run joins (people.me lists yours). Leave it out to join in no team, only to pair",
    harness: "The harness the session runs: claude-code, codex, or another agent's own lower-case name",
    sessionRef: "The harness's own id for the session: Claude Code's session id (CLAUDE_CODE_SESSION_ID), Codex's thread id (CODEX_THREAD_ID)",
    title: "What the run is about, shown beside its name in runs.live",
    hearing: "How the run hears messages, as runs.live shows it: mid_task (hooks or turn/steer during its turn), between_turns (at its next turn), none (it reads its inbox itself)",
    open: "true: the team can see and message the run (uplink join --open). Left out, a new run starts closed, so only you and your agents can, and the same session joining again keeps what it was (ADR 0044)",
  },
  handler: async (ctx, account, args) => {
    if (!account.signIn) {
      throw roomError("forbidden", "A session joins from its command line, signed in with `uplink login`: run `uplink join --team <team>` in it.");
    }
    const harness = args.harness.trim().toLowerCase();
    if (!HARNESS.test(harness)) throw roomError("invalid", "harness is a short lower-case name, such as claude-code or codex.");
    const sessionRef = args.sessionRef.trim();
    if (!sessionRef || sessionRef.length > 200) throw roomError("invalid", "sessionRef is the harness's session id, at most 200 characters.");
    const title = args.title?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
    if (!args.teamId) return joinWithoutTeam(ctx, account.person, account.signIn, harness, sessionRef, args.hearing);
    const teamId = args.teamId;
    const member = await memberForPerson(ctx, teamId, account.person._id);
    if (!member) throw roomError("forbidden", "You aren't in that team. uplink whoami lists yours.");
    const actor: Actor = { kind: "person", teamId, member, role: member.role, scopes: "all" };
    const team = (await ctx.db.get(teamId))!;
    const now = Date.now();
    const token = randomSecret(RUN_TOKEN_PREFIX.slice(0, -1));
    const keys = { hash: await sha256(token), prefix: token.slice(0, 8), signInId: account.signIn._id };

    const earlier = (
      await ctx.db
        .query("joinedSessions")
        .withIndex("by_person_session", (q) => q.eq("personId", account.person._id).eq("sessionRef", sessionRef))
        .collect()
    ).filter((s) => s.endedAt === undefined);
    for (const session of earlier) {
      const run = session.runId ? await ctx.db.get(session.runId) : null;
      if (session.teamId === teamId && session.harness === harness && run && run.endedAt === undefined) {
        // The same session in the same team: it keeps its run and its name, with a new token.
        await ctx.db.patch(session._id, { ...keys, lastSeenAt: now });
        await ctx.db.patch(run._id, {
          hearing: args.hearing,
          ...(title ? { title } : {}),
          ...(args.open ? { closed: false } : {}),
        });
        await audit(ctx, actor, "run.joined", run._id, { harness, again: true });
        return joinedView(token, (await ctx.db.get(run._id))!, team, args.hearing, await runLabel(ctx, run));
      }
      await endJoinedSession(ctx, session, "replaced");
    }

    const joinId = await ctx.db.insert("joinedSessions", {
      personId: account.person._id,
      ...keys,
      harness,
      sessionRef,
      teamId,
      createdAt: now,
      lastSeenAt: now,
    });
    const runId = await ctx.db.insert("runs", {
      teamId,
      harness,
      ...(title ? { title } : {}),
      driverId: member._id,
      startedBy: member._id,
      state: "unknown",
      stateChangedAt: now,
      hearing: args.hearing,
      joinedSessionId: joinId,
      // Closed until its person opens it (ADR 0044).
      closed: args.open !== true,
    });
    await ctx.db.patch(joinId, { runId });
    await scheduleExpiry(ctx, { _id: joinId, lastSeenAt: now });
    const run = (await ctx.db.get(runId))!;
    await audit(ctx, actor, "run.joined", runId, { harness });
    return joinedView(token, run, team, args.hearing, await runLabel(ctx, run));
  },
});

/**
 * A join with no team (D13): a session row with no run, which can only pair. The same session joining
 * again in no team keeps its row, and its Pairs, with a new token; one joined in a team ends.
 */
async function joinWithoutTeam(
  ctx: MutationCtx,
  person: Doc<"people">,
  signIn: Doc<"cliSignIns">,
  harness: string,
  sessionRef: string,
  hearing: NonNullable<Doc<"runs">["hearing"]>,
) {
  const now = Date.now();
  const token = randomSecret(RUN_TOKEN_PREFIX.slice(0, -1));
  const keys = { hash: await sha256(token), prefix: token.slice(0, 8), signInId: signIn._id };
  const earlier = (
    await ctx.db
      .query("joinedSessions")
      .withIndex("by_person_session", (q) => q.eq("personId", person._id).eq("sessionRef", sessionRef))
      .collect()
  ).filter((s) => s.endedAt === undefined);
  let joinId = earlier.find((s) => s.teamId === undefined && s.harness === harness)?._id;
  for (const session of earlier) if (session._id !== joinId) await endJoinedSession(ctx, session, "replaced");
  if (joinId) {
    await ctx.db.patch(joinId, { ...keys, hearing, lastSeenAt: now });
  } else {
    joinId = await ctx.db.insert("joinedSessions", { personId: person._id, ...keys, harness, sessionRef, hearing, createdAt: now, lastSeenAt: now });
    await scheduleExpiry(ctx, { _id: joinId, lastSeenAt: now });
  }
  return { token, label: joinedLabel(harness, person), hearing, heartbeatMs: HEARTBEAT_MS, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS };
}

function joinedView(token: string, run: Doc<"runs">, team: Doc<"teams">, hearing: Doc<"runs">["hearing"], label: string) {
  return {
    token,
    runId: run._id,
    label,
    teamId: team._id,
    team: team.name,
    hearing,
    open: run.closed !== true,
    heartbeatMs: HEARTBEAT_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
}

// ---------- run functions: the joined run's own token only ----------

export const { run: meByRun } = joinedRunQuery({
  name: "joined.me",
  description:
    "Which joined run this run token acts as: its name (label), harness and how it hears messages; with a team, its runId, team and title; and the Pairs it is in, each with its people, runs and agents.",
  args: {},
  handler: async (ctx, { run, session, person }) => {
    const pairs = [];
    for (const pairRun of await pairRunsOfSession(ctx, session._id)) {
      const pair = await ctx.db.get(pairRun.pairId);
      if (pair) pairs.push(await pairView(ctx, pair, { personId: person._id, sessionId: session._id }));
    }
    if (!run) {
      return { label: joinedLabel(session.harness, person), harness: session.harness, hearing: session.hearing ?? ("none" as const), startedAt: session.createdAt, pairs };
    }
    const team = await ctx.db.get(run.teamId);
    return {
      runId: run._id,
      label: await runLabel(ctx, run),
      harness: run.harness,
      teamId: run.teamId,
      team: team?.name ?? "",
      ...(run.title ? { title: run.title } : {}),
      hearing: run.hearing ?? ("none" as const),
      open: run.closed !== true,
      startedAt: run._creationTime,
      pairs,
    };
  },
});

export const { run: waitingByRun } = joinedRunQuery({
  name: "joined.waiting",
  description: `How many messages wait in this joined run's inbox, from its team and its Pairs (at most ${MAX_WAITING}), for a live watch that hands them to the session as they come. Fails once the run has ended.`,
  args: {},
  handler: async (ctx, { run, session }) => {
    const waiting = run
      ? await ctx.db
          .query("runInbox")
          .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "waiting"))
          .take(MAX_WAITING)
      : [];
    return { waiting: Math.min(MAX_WAITING, waiting.length + (await waitingPairRows(ctx, session._id)).length) };
  },
});

export const { run: heartbeatByRun } = joinedRunMutation({
  name: "joined.heartbeat",
  description: `Keeps this joined run live. Send one every ${HEARTBEAT_MS / 1000} seconds: after ${HEARTBEAT_TIMEOUT_MS / 60_000} minutes with none the run ends and its token stops working.`,
  args: {},
  handler: async (ctx, { session }) => {
    await ctx.db.patch(session._id, { lastSeenAt: Date.now() });
    return { heartbeatMs: HEARTBEAT_MS };
  },
});

export const { run: takeByRun } = joinedRunMutation({
  name: "joined.take",
  description: `Takes the messages waiting in this joined run's inbox, oldest first, as many as fit in one delivery of 9,000 characters (at most 20; waiting says how many are left), and claims them under claimId, how: mid_task (during the session's turn) or next_turn (at the start of one). Once they are in front of the session, call joined.ack with the claimId and they are delivered; if they can't be, joined.release puts them back. A claim neither answers within ${CLAIM_MS / 60_000} minutes waits again once, then fails as unsure. Each says where it was posted, who sent it (from: a person, an agent, or another run and the person driving it), the person accountable for it, and fromDriver: whether that person is this run's own driver. A message can ask for anything; whether to act on it is the run's decision (ADR 0026). Answer one with joined.say replyTo.`,
  args: { how: v.union(v.literal("mid_task"), v.literal("next_turn")), reserve: v.optional(v.number()) },
  argDocs: {
    reserve: "How many characters of the delivery the session keeps for its own lines, such as how to answer: the messages taken fit in the rest",
  },
  handler: async (ctx, joined, args) => {
    await ctx.db.patch(joined.session._id, { lastSeenAt: Date.now() });
    return takeWaiting(ctx, joined, args.how, args.reserve);
  },
});

export const { run: ackByRun } = joinedRunMutation({
  name: "joined.ack",
  description: "Says the messages joined.take claimed under claimId are in front of the session now (a hook wrote them, a channel sent them, Codex took them), so they are delivered. Returns how many; a claim that already lapsed or was settled gives 0.",
  args: { claimId: v.string() },
  handler: async (ctx, joined, args) => ({ delivered: await settleClaim(ctx, claimOwner(joined), args.claimId, "delivered") }),
});

export const { run: releaseByRun } = joinedRunMutation({
  name: "joined.release",
  description: "Puts the messages joined.take claimed under claimId back in this run's inbox as waiting, when they couldn't be put in front of the session after all. Returns how many went back.",
  args: { claimId: v.string() },
  handler: async (ctx, joined, args) => ({ released: await settleClaim(ctx, claimOwner(joined), args.claimId, "released") }),
});

/**
 * A claim nobody answered within CLAIM_MS: its messages are unsure, since the session may or may not
 * have them. Each waits again once, then fails as unsure (lib/joinedRuns.ts `settleClaim`).
 */
export const expireClaim = internalMutation({
  // A claim from before Pairs names only its run.
  args: { runId: v.optional(v.id("runs")), sessionId: v.optional(v.id("joinedSessions")), claimId: v.string() },
  handler: async (ctx, { runId, sessionId, claimId }) => {
    await settleClaim(ctx, { ...(runId ? { runId } : {}), ...(sessionId ? { sessionId } : {}) }, claimId, "unsure");
  },
});

/** Whose inboxes a joined run's claim is in: its team run's, and its session's in its Pairs. */
function claimOwner(joined: JoinedRun) {
  return { ...(joined.run ? { runId: joined.run._id } : {}), sessionId: joined.session._id };
}

export const { run: sayByRun } = joinedRunMutation({
  name: "joined.say",
  description:
    "Post as this joined run, as its driver with the run's name beside theirs (ADR 0029 D2): in a place (in: a channel's name such as #payments, or a channelId), or under a message (replyTo: a messageId, from joined.take). Exactly one of in and replyTo. Mention people with <@memberId> and runs with <@run:RUNID>. The run can't post where its driver can't. In a Pair: in is \"pair\" (the run's only Pair) or a pairId, or replyTo is a Pair message's id; it reaches everyone in the Pair, and notDelivered names a run whose inbox was full. A run in no team posts only in its Pairs. Attach up to 10 files uploaded through joined.attachUrl (ADR 0047), in a team place or a Pair (ADR 0048); with files the text may be empty. Returns messageId, the run's label and the place.",
  args: { text: v.string(), in: v.optional(v.string()), replyTo: v.optional(v.string()), attachments: v.optional(v.array(vNewRunAttachment)) },
  argDocs: {
    in: "Where to post: a channel's name (#payments) or channelId, or pair (this run's Pair) or a pairId. Leave out with replyTo",
    replyTo: "A messageId to answer, in its place and thread. Leave out with in",
    attachments: "Files to send with the message: each { uploadId, storageId, name } from joined.attachUrl and an upload",
  },
  handler: async (ctx, joined, args) => {
    // A Pair message, or a Pair (its pairId, or "pair" for the run's only one): posted in the Pair.
    const replyTo = args.replyTo?.trim();
    const pairMessageId = replyTo ? ctx.db.normalizeId("pairMessages", replyTo) : null;
    const place = args.in?.trim();
    if (pairMessageId || (place && !replyTo && (place.toLowerCase() === "pair" || ctx.db.normalizeId("pairs", place)))) {
      if (!place === !replyTo) {
        throw roomError("invalid", 'Say where: uplink say --in pair "text" posts in this run\'s Pair, and uplink reply <messageId> "text" answers a message.');
      }
      let pairId = place?.toLowerCase() === "pair" ? undefined : place;
      if (pairMessageId) {
        const message = await ctx.db.get(pairMessageId);
        if (!message) throw roomError("not_found", "No such message in this run's Pairs.");
        pairId = message.pairId;
      }
      return sayInPair(ctx, joined, pairId, args.text, args.attachments ?? []);
    }
    // A team place keeps only the driver's team uploads (messages.post); a Pair upload isn't one.
    const attachments = (args.attachments ?? []).map((item) => {
      const uploadId = ctx.db.normalizeId("uploads", item.uploadId);
      if (!uploadId) throw roomError("invalid", "That upload was issued for a Pair. Upload the file again with joined.attachUrl.");
      return { ...item, uploadId };
    });
    return sayAsRun(ctx, teamRunOf(joined), { ...args, attachments });
  },
});

export const { run: attachUrlByRun } = joinedRunMutation({
  name: "joined.attachUrl",
  description:
    "A URL to upload one file this joined run sends with its next joined.say (ADR 0047), valid for one hour, and its uploadId: in a team, an upload of the run's driver, as messages.attachUrl gives them, which a team place or a Pair keeps; in no team, an upload for the run's Pairs (ADR 0048). POST the bytes with their Content-Type; the response is { storageId }. Then pass { uploadId, storageId, name } in joined.say attachments. Images (PNG, JPEG, GIF, WebP) up to 20 MB and PDFs up to 50 MB show in the app, and their Content-Type must match the name's extension; SVG is refused. Any other file, up to 50 MB, is offered as a download.",
  args: {},
  handler: async (ctx, joined) => {
    if (joined.run && joined.actor) {
      const { actor } = joined;
      const uploadId = await ctx.db.insert("uploads", { teamId: actor.teamId, uploaderId: actor.member._id });
      return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId };
    }
    // A run in no team posts only in its Pairs, so its files go only there.
    if (!(await pairRunsOfSession(ctx, joined.session._id)).length) {
      throw roomError("not_found", "This run is in no team and no Pair, so it has nowhere to send a file. uplink pair <code> joins a Pair.");
    }
    const uploadId = await ctx.db.insert("pairUploads", { personId: joined.person._id, by: { kind: "run", sessionId: joined.session._id } });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId };
  },
});

export const { run: downloadByRun } = joinedRunMutation({
  name: "joined.download",
  description:
    "Links to a Pair message's files (ADR 0048), what uplink download saves: one for each file, which works for 10 minutes and only while this run is still in the Pair. A run hears how many files a Pair message has, and fetches them this way. Returns messageId, pairId and files: each with its name, kind (image, pdf or file), contentType, size and url.",
  args: { messageId: v.string() },
  argDocs: { messageId: "A Pair message's id, from joined.take" },
  handler: async (ctx, joined, args) => {
    const id = ctx.db.normalizeId("pairMessages", args.messageId.trim());
    const message = id ? await ctx.db.get(id) : null;
    const pairRun = message ? (await pairRunsOfSession(ctx, joined.session._id)).find((r) => r.pairId === message.pairId) : undefined;
    if (!message || !pairRun) {
      throw roomError("not_found", "No such message in this run's Pairs. uplink download saves a Pair message's files; a team message's stay in the room.");
    }
    const files = [];
    for (const row of await pairAttachmentsOf(ctx, message)) {
      const link = await grantPairAttachment(ctx, row, { kind: "run", pairRunId: pairRun._id }, true);
      files.push({ name: row.name, kind: row.kind, contentType: row.contentType, size: row.size, url: link.url });
    }
    return { messageId: message._id, pairId: message.pairId, files };
  },
});

/** Posts as the joined run in one of its live Pairs, as the run with its pair label, with any files it sends (ADR 0048). */
async function sayInPair(ctx: MutationCtx, joined: JoinedRun, pairId: string | undefined, text: string, attachments: NewPairAttachment[]) {
  const { pair, pairRun } = await sessionPair(ctx, joined.session._id, pairId);
  const author = { kind: "run", pairRun, ...(joined.actor ? { teamMemberId: joined.actor.member._id } : {}) } as const;
  const posted = await postInPair(ctx, pair, author, text, attachments);
  return {
    messageId: posted.messageId,
    label: posted.label ?? (await pairRunLabel(ctx, pairRun)),
    place: await pairPlace(ctx, pair._id, joined.person._id),
    pairId: pair._id,
    ...(posted.notDelivered.length ? { notDelivered: posted.notDelivered } : {}),
  };
}

export const { run: setOpenByRun } = joinedRunMutation({
  name: "joined.setOpen",
  description:
    "Open or close this joined run (ADR 0044), what uplink open and uplink close do. Closed, as a run starts unless it joined with --open, only its person and their agents can see it, list it or message it; for everyone else in the team it isn't there. Open, the team can see it and message it. Returns runId and open.",
  args: { open: v.boolean() },
  argDocs: {
    open: "true: the team can see and message this run. false: only its person and their agents can",
  },
  handler: async (ctx, joined, args) => {
    const { run, actor } = teamRunOf(joined);
    return { runId: run._id, open: await setRunOpen(ctx, actor, run, args.open) };
  },
});

export const { run: leaveByRun } = joinedRunMutation({
  name: "joined.leave",
  description:
    "End this joined run: it leaves runs.live, shows Done, leaves its Pairs (which go on: uplink pair --resume puts a new run of yours back), and its run token stops working. reason: left (the default, uplink leave) or session_ended (the harness session ended).",
  args: { reason: v.optional(v.union(v.literal("left"), v.literal("session_ended"))) },
  handler: async (ctx, { session, run, actor }, args) => {
    const reason = args.reason ?? "left";
    await endJoinedSession(ctx, session, reason);
    if (run && actor) await audit(ctx, actor, "run.left", run._id, { reason });
    return null;
  },
});

// ---------- Pairs (ADR 0027, ADR 0034): this run's own ----------

/** What a run sees of a Pair it is in, and its own name there. */
async function inPair(ctx: MutationCtx, joined: JoinedRun, pairId: Doc<"pairs">["_id"]) {
  const pair = (await ctx.db.get(pairId))!;
  const pairRun = (await pairRunsOfSession(ctx, joined.session._id)).find((r) => r.pairId === pairId)!;
  return {
    ...(await pairView(ctx, pair, { personId: joined.person._id, sessionId: joined.session._id })),
    label: await pairRunLabel(ctx, pairRun),
    place: await pairPlace(ctx, pair._id, joined.person._id),
  };
}

export const { run: pairCodeByRun } = joinedRunMutation({
  name: "joined.pairCode",
  description:
    "Make a pair code, such as RIVER-4821-MAPLE-0937, for one more run or agent to join a Pair with this run (what `uplink pair` does): in this run's Pair, or with new, or when it is in none, in a new Pair of this run and its person. The code works once, for 10 minutes; pass it on any way you like to the person whose run (uplink pair <code>) or agent (pairs.join) should join. Anyone signed in can join with it, in any team or none. Returns the code, its pairId and when it expires.",
  args: { pairId: v.optional(v.string()), new: v.optional(v.boolean()) },
  argDocs: {
    pairId: "Which of this run's Pairs, when it is in several",
    new: "Start a new Pair even if this run is in one",
  },
  handler: async (ctx, joined, args) => {
    const runs = await pairRunsOfSession(ctx, joined.session._id);
    const pair = args.new || (!runs.length && args.pairId === undefined) ? await createPair(ctx, joined.session) : (await sessionPair(ctx, joined.session._id, args.pairId)).pair;
    return makePairCode(ctx, pair, joined.person._id);
  },
});

export const { run: pairJoinByRun } = joinedRunMutation({
  name: "joined.pairJoin",
  description:
    "Join a Pair with a pair code someone passed on (what `uplink pair <code>` does): this run and its person join it, and from then on every message there reaches this run as its other messages do (joined.take), and what it says with joined.say in:pair reaches everyone there. The code works once; a wrong, used or expired one fails, and after 10 wrong codes in an hour no code works for this person until the hour is over. Returns the Pair: its people, runs and agents, and this run's name in it.",
  args: { code: v.string() },
  argDocs: { code: "The pair code, such as RIVER-4821-MAPLE-0937, in any case" },
  handler: async (ctx, joined, args) => {
    const pair = await redeemPairCode(ctx, joined.person._id, args.code, { kind: "run", session: joined.session });
    if (isRoomRefusal(pair)) return pair;
    return inPair(ctx, joined, pair._id);
  },
});

export const { run: pairResumeByRun } = joinedRunMutation({
  name: "joined.pairResume",
  description:
    "Put this run back in a Pair its person is in, after their earlier run there ended (what `uplink pair --resume` does). With no pairId, the person's only live Pair this run isn't in. Returns the Pair and this run's name in it.",
  args: { pairId: v.optional(v.string()) },
  argDocs: { pairId: "Which Pair, when its person is in several" },
  handler: async (ctx, joined, args) => {
    const mine = new Set((await pairRunsOfSession(ctx, joined.session._id)).map((r) => r.pairId));
    let pair: Doc<"pairs">;
    if (args.pairId !== undefined) {
      const pairId = ctx.db.normalizeId("pairs", args.pairId.trim());
      if (!pairId || !(await pairPersonRow(ctx, pairId, joined.person._id))) throw roomError("not_found", "No such Pair, or you aren't in it.");
      pair = await livePair(ctx, pairId);
    } else {
      const rows = await ctx.db
        .query("pairPeople")
        .withIndex("by_person_removed", (q) => q.eq("personId", joined.person._id).eq("removedAt", undefined))
        .order("desc")
        .take(200);
      const open: Doc<"pairs">[] = [];
      for (const row of rows) {
        if (mine.has(row.pairId)) continue;
        const p = await ctx.db.get(row.pairId);
        if (p && p.endedAt === undefined) open.push(p);
      }
      if (!open.length) throw roomError("not_found", "You're in no live Pair this run could rejoin. uplink pair makes a code for a new one.");
      if (open.length > 1) {
        const which = [];
        for (const p of open) which.push(`${p._id} (${await pairPlace(ctx, p._id, joined.person._id)})`);
        throw roomError("invalid", `You're in ${open.length} live Pairs: pass one, uplink pair --resume <pairId>. ${which.join("; ")}.`);
      }
      pair = open[0]!;
    }
    await addRun(ctx, pair, joined.session);
    return inPair(ctx, joined, pair._id);
  },
});

/**
 * Ends a joined run whose heartbeat stopped. Runs at its last heartbeat plus two minutes, and waits
 * again when a newer heartbeat came. Convex reruns a query only when a document it read changes, not
 * when time passes, so runs.live drops the run only because this writes it.
 */
export const expire = internalMutation({
  args: { joinId: v.id("joinedSessions") },
  handler: async (ctx, { joinId }) => {
    const session = await ctx.db.get(joinId);
    if (!session || session.endedAt !== undefined) return;
    if (session.lastSeenAt + HEARTBEAT_TIMEOUT_MS > Date.now()) {
      await scheduleExpiry(ctx, session);
      return;
    }
    await endJoinedSession(ctx, session, "heartbeat");
  },
});
