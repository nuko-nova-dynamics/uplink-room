/**
 * Runs given to an agent the room can't follow over A2A (ADR 0044): an agent reached at a routine
 * webhook (Grok Bot), one that checks in on its own schedule (dots, Muse, Duet), or one that holds
 * only an agent key. Such a run has harness "agent" and the agent's agentId; its driver and starter
 * are the sender, as on an A2A run, so a waiting run lands in the sender's Needs you. It starts
 * Unknown, and only its own agent moves it, with runs.report. A2A runs keep their single reporter,
 * the worker (ADR 0012); nothing here touches them.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { roomError } from "./errors";
import { audit, memberView } from "./members";
import {
  agentMaySee,
  agentMember,
  canSteer,
  checkRecipient,
  cleanText,
  givenTitle,
  sentFromRoom,
} from "./a2a/runs";
import { deliverRunToHosted, markRunSeen, reachOf, runDeliveries } from "./deliveries";

/** The harness a given run has. */
export const GIVEN = "agent";

/** What a run given to an agent keeps of what was sent to it: the first message and the last 19 replies. */
const KEPT_REPLIES = 19;
/** How many of those runs.get and the webhook show: the newest 10, as an A2A run's messages. */
export const SHOWN_MESSAGES = 10;

export type ReportState = "working" | "waiting" | "done" | "failed";
type Given = NonNullable<Doc<"runs">["given"]>;

function isFinal(state: Doc<"runs">["state"]): boolean {
  return state === "done" || state === "failed" || state === "stopped";
}

export function isGiven(run: Doc<"runs">): boolean {
  return run.harness === GIVEN && run.agentId !== undefined;
}

/**
 * Gives work to an agent the room reaches at a webhook, or not at all, as a new run: a task's run
 * (`task`), or an unfiled one. The checks are A2A's (checkRecipient): the agent is in the team, isn't
 * the sender, and can see the private channel a task came from. The task goes to its webhook, or
 * waits for it to check in.
 */
export async function startGivenRun(
  ctx: MutationCtx,
  actor: Actor,
  opts: { agentId: Id<"agents">; prompt: string; task?: Doc<"tasks"> },
): Promise<Id<"runs">> {
  const { agent, member, taskChannelId, fromTask } = await checkRecipient(
    ctx,
    actor,
    opts.agentId,
    opts.task,
  );
  const prompt = cleanText(opts.prompt, "A run for an agent");
  const now = Date.now();
  const runId = await ctx.db.insert("runs", {
    teamId: actor.teamId,
    ...(opts.task ? { taskId: opts.task._id } : {}),
    harness: GIVEN,
    agentId: agent._id,
    ...(taskChannelId ? { directChannelId: taskChannelId } : {}),
    title: givenTitle(agent, prompt, opts.task, fromTask),
    driverId: actor.member._id,
    startedBy: actor.member._id,
    state: "unknown",
    stateChangedAt: now,
    given: {
      messages: [
        {
          kind: "start",
          text: sentFromRoom(prompt, actor, opts.task),
          from: actor.member._id,
          at: now,
        },
      ],
    },
  });
  await deliverRunToHosted(ctx, actor, (await ctx.db.get(runId))!, member);
  await audit(ctx, actor, "run.given", runId, {
    agentId: agent._id,
    ...(opts.task ? { taskId: opts.task._id } : {}),
  });
  return runId;
}

async function stoppedText(ctx: QueryCtx, run: Doc<"runs">): Promise<string> {
  const by = run.given?.stoppedBy ? await ctx.db.get(run.given.stoppedBy) : null;
  return `This run was stopped${by ? ` by ${by.name}` : ""}, so it takes no more reports.`;
}

/**
 * The agent's own report on a run given to it (runs.report): its state, and what it says, which
 * becomes the run's latest line; with waiting, it is the question. Refused for anyone but the run's
 * agent, on any other run, and once the run has ended. Marks what waited for the agent as seen.
 */
export async function reportGivenRun(
  ctx: MutationCtx,
  actor: Actor,
  run: Doc<"runs">,
  report: { state: ReportState; message?: string | undefined },
) {
  if (!isGiven(run)) {
    throw roomError(
      "invalid",
      "Only a run given to an agent takes reports. The room follows every other run itself.",
    );
  }
  if (actor.member.agentId === undefined || actor.member.agentId !== run.agentId) {
    throw roomError("forbidden", "Only the agent a run was given to reports on it.");
  }
  if (run.state === "stopped") throw roomError("conflict", await stoppedText(ctx, run));
  if (isFinal(run.state)) {
    throw roomError(
      "conflict",
      `This run already ended ${run.state}, so it takes no more reports. Ask for the work to be given to you again.`,
    );
  }
  const text = report.message?.trim() ? cleanText(report.message, "A report's message") : undefined;
  if (report.state === "waiting" && !text) {
    throw roomError("invalid", "A waiting report needs message: the question you need answered.");
  }
  const now = Date.now();
  const question = report.state === "waiting" ? text : undefined;
  const changed =
    run.state !== report.state || (question !== undefined && question !== run.prompt?.text);
  await ctx.db.patch(run._id, {
    state: report.state,
    prompt: question !== undefined ? { kind: "question", text: question } : undefined,
    failReason: report.state === "failed" ? text : undefined,
    // A new question while already Waiting is news too: it is what notifies and un-settles.
    ...(changed ? { stateChangedAt: now } : {}),
    endedAt: isFinal(report.state) ? now : undefined,
    given: { ...run.given!, ...(text ? { lastMessage: { text, at: now } } : {}) },
  });
  await markRunSeen(ctx, actor.member._id, run._id);
  await audit(ctx, actor, "run.reported", run._id, { state: report.state });
  return { runId: run._id, state: report.state };
}

/** Whether `actor` may reply on a given run now: who may steer it, while it hasn't ended. */
export async function mayReplyGiven(
  ctx: QueryCtx,
  actor: Actor,
  run: Doc<"runs">,
): Promise<boolean> {
  return !isFinal(run.state) && (await canSteer(ctx, actor, run));
}

/**
 * A reply on a run given to an agent (runs.reply): kept on the run, where the agent reads it with
 * runs.get, and sent to a webhook agent again with the task, as a new POST with the replies. Who may
 * reply is who may on an A2A run (replyToRun): its driver, whoever started it, the task's owner or
 * an admin.
 */
export async function replyToGivenRun(
  ctx: MutationCtx,
  actor: Actor,
  run: Doc<"runs">,
  text: string,
): Promise<Id<"runs">> {
  if (!(await canSteer(ctx, actor, run))) {
    throw roomError(
      "forbidden",
      "Only the run's driver, whoever started it, the task's owner or an admin can reply.",
    );
  }
  if (run.state === "stopped")
    throw roomError(
      "conflict",
      "This run was stopped, so it takes no replies. Give the task to the agent again (runs.start).",
    );
  if (isFinal(run.state))
    throw roomError(
      "conflict",
      `This run already ended ${run.state}, so it takes no replies. Give the task to the agent again (runs.start).`,
    );
  const recipient = await agentMember(ctx, run.agentId!);
  if (
    !recipient ||
    recipient.removedAt !== undefined ||
    !(await agentMaySee(ctx, run, recipient._id))
  ) {
    throw roomError(
      "conflict",
      "The agent isn't in the conversation this run came from any more, so it can't be sent more of it.",
    );
  }
  const body = cleanText(text, "A reply");
  const [start, ...replies] = run.given!.messages;
  const given: Given = {
    ...run.given!,
    messages: [
      start!,
      ...replies.slice(-(KEPT_REPLIES - 1)),
      { kind: "reply", text: body, from: actor.member._id, at: Date.now() },
    ],
  };
  await ctx.db.patch(run._id, { given });
  await deliverRunToHosted(ctx, actor, { ...run, given }, recipient);
  await audit(ctx, actor, "run.replied", run._id);
  return run._id;
}

/** Stops a given run at once (runs.stop): nothing at the agent can be canceled, so a later report is refused. */
export async function stopGivenRun(ctx: MutationCtx, actor: Actor, run: Doc<"runs">) {
  if (!(await canSteer(ctx, actor, run))) throw roomError("forbidden", "You can't stop this run.");
  if (isFinal(run.state)) throw roomError("conflict", "This run is already finished.");
  const now = Date.now();
  await ctx.db.patch(run._id, {
    state: "stopped",
    stoppedBy: "room",
    prompt: undefined,
    stateChangedAt: now,
    endedAt: now,
    given: { ...run.given!, stoppedBy: actor.member._id },
  });
  await audit(ctx, actor, "run.stopped", run._id);
  return { runId: run._id, state: "stopped" as const };
}

/**
 * The given side of a run, for runView: the agent, how the room reaches it, how far the latest send
 * got, its latest line, and what was sent to it. `hidden`: the viewer isn't in the direct message or
 * private channel the run came from, so the texts are left out (ADR 0015, ADR 0016).
 */
export async function givenView(ctx: QueryCtx, run: Doc<"runs">, hidden: boolean) {
  if (!isGiven(run)) return undefined;
  const agentId = run.agentId!;
  const agent = await ctx.db.get(agentId);
  const member = await agentMember(ctx, agentId);
  const reach = await reachOf(ctx, agentId);
  const [latest] = await runDeliveries(ctx, run._id);
  const given = run.given ?? { messages: [] };
  return {
    agent: {
      memberId: member?._id,
      agentId,
      name: agent?.name ?? member?.name ?? "Former agent",
      character: agent?.character,
    },
    /** How the room reaches the agent now: its routine webhook, or none (it reads the run when it checks in). */
    reach: reach === "webhook" || reach === "checks_in" ? reach : ("none" as const),
    /** How far the latest send got: sending, sent or failed at a webhook; waiting or seen for an agent that checks in. */
    delivery: latest
      ? { status: latest.status, ...(latest.reason && !hidden ? { reason: latest.reason } : {}) }
      : undefined,
    /** The agent's latest line (runs.report). */
    lastMessage: hidden ? undefined : given.lastMessage,
    /** What was sent to it, oldest first: the first message, then replies (runs.reply). */
    messages: await Promise.all(
      given.messages.slice(-SHOWN_MESSAGES).map(async (m) => ({
        kind: m.kind,
        text: hidden ? "" : m.text,
        from: await memberView(ctx, m.from),
        at: m.at,
      })),
    ),
  };
}
