/**
 * The Inbox (ADR 0004, GLOSSARY.md): one person's work in three sections.
 * Needs you holds runs waiting on that person (their driver). Working holds
 * running work, including runs waiting on someone else. Done holds finished
 * work until it is settled. It is derived from runs; nothing is stored. Beside them, the tasks
 * proposed from calls that wait on that person (calls.ts, proposalsNeeding).
 */
import { runIsHidden } from "./lib/a2a/runs";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { actsFor, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { mayDriveThere } from "./lib/machines";
import { audit, inTeam, memberView, taskOutsideChannels } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import {
  isFinished,
  latestChange,
  runTitleFor,
  runView,
  settledSince,
  taskIsHidden,
  taskState,
  taskTitleFor,
} from "./lib/states";
import { actorRef } from "./lib/terminals";
import { isGiven } from "./lib/givenRuns";
import { bridgeHandles } from "./lib/threads";
import { seesRun } from "./lib/runLabels";
import { proposalsNeeding } from "./calls";

type Row = Awaited<ReturnType<typeof buildRow>>;

/** Settled or snoozed work stays out until one of its runs changes state again. */
function hidden(
  item: { settledAt?: number; snoozedUntil?: number; snoozedAt?: number },
  changedAt: number,
  now: number,
): boolean {
  if (settledSince(item, changedAt)) return true;
  return (
    item.snoozedUntil !== undefined && item.snoozedUntil > now && (item.snoozedAt ?? 0) >= changedAt
  );
}

async function buildRow(
  ctx: QueryCtx,
  item: { task: Doc<"tasks"> } | { run: Doc<"runs"> },
  runs: Doc<"runs">[],
  viewer: Actor,
) {
  const state = "task" in item && item.task.closedAt !== undefined ? "done" : taskState(runs);
  const waiting = runs.filter((r) => r.state === "waiting");
  const first = waiting[0] ?? runs.find((r) => r.state === "working") ?? runs[0];
  const base = "task" in item ? item.task._creationTime : item.run._creationTime;
  // A run sent from a direct message or private channel the viewer isn't in shows no question, and
  // a task from one shows no title (ADR 0015, ADR 0016).
  const [hidden, taskHidden] = await Promise.all([
    first ? runIsHidden(ctx, first, viewer) : false,
    "task" in item ? taskIsHidden(ctx, item.task, viewer) : false,
  ]);
  // Every read below at once: Convex counts each await's wait against the query's system time limit.
  const [title, owner, createdBy, waitingOn, runViews] = await Promise.all([
    "task" in item
      ? taskTitleFor(ctx, item.task, taskHidden)
      : runTitleFor(ctx, item.run, hidden).then((t) => t ?? `${item.run.harness} run`),
    "task" in item ? memberView(ctx, item.task.ownerId) : undefined,
    "task" in item && !taskHidden ? memberView(ctx, item.task.createdBy) : undefined,
    Promise.all(waiting.filter((r) => r.driverId).map((r) => memberView(ctx, r.driverId!))),
    Promise.all(runs.map((r) => runView(ctx, r, viewer))),
  ]);
  return {
    unfiled: !("task" in item),
    taskId: "task" in item ? item.task._id : undefined,
    /** The task's project; undefined for an unfiled run and for a task with no project. */
    projectId: "task" in item ? item.task.projectId : undefined,
    runId: "run" in item ? item.run._id : undefined,
    title,
    private: taskHidden || ("run" in item && hidden),
    owner,
    /** Who made or assigned the task; left out with its texts for a task you can't see. */
    createdBy,
    state,
    reason: hidden ? undefined : first?.prompt?.text,
    action: hidden ? undefined : first?.prompt?.action,
    waitingOn,
    changedAt: latestChange(runs, base),
    runs: runViews,
  };
}

export const { person: get, agent: getAgent } = roomQuery({
  name: "inbox.get",
  description:
    "Your Inbox, or for an agent with view 'person' the Inbox of the person who added it (what they see in the app): needsYou (runs waiting on its driver), working, and done (finished, not yet settled), each newest first. view: 'mine' (default: tasks you own and runs you drive; for an agent, the runs it drives and the runs given to it to report on with runs.report, harness agent, since an agent owns no tasks), 'person' (for an agent, its person's; for a person, the same as mine) or 'team' (everyone's, with every waiting run in needsYou). for names whose Inbox came back; for an agent's own view, personView says where its person's is. Each task row has its owner and createdBy; a run's prompt says what a waiting run asks. proposals lists tasks proposed from calls that wait for a yes or a no: those suggested for this person, or from a call they were in when no owner is suggested (in 'team', all of them). Answer them with calls.acceptProposal or calls.dismissProposal.",
  scope: "room.read",
  args: { view: v.optional(v.union(v.literal("mine"), v.literal("person"), v.literal("team"))) },
  argDocs: {
    view: "Whose Inbox: 'mine' (default), 'person' (an agent's person: use it when your person asks about their Inbox) or 'team'",
  },
  handler: async (ctx, actor, args) => {
    const team = args.view === "team";
    // 'person': the accountable person's Inbox. It is a part of the team view, read with the agent's
    // own visibility (private texts stay hidden), so it shows nothing the team view doesn't.
    const forMember = args.view === "person" && actor.accountable ? actor.accountable : actor.member;
    const me = forMember._id;
    // An agent's own view also lists the runs given to it (ADR 0044): it drives none of them, but
    // they are its work, and how a check-in agent finds a task given to it.
    const givenTo = !team && forMember._id === actor.member._id ? actor.member.agentId : undefined;
    const mineRun = (r: Doc<"runs">) => r.driverId === me || (givenTo !== undefined && r.agentId === givenTo && isGiven(r));
    const now = Date.now();
    // Every app window subscribes to this query, so its reads go out together, never one await per
    // row: Convex adds up the time a query waits on reads, and when its database is slow, reads
    // one after another pass the limit ("timed out performing too many system operations",
    // UPLINK-ROOM-BACKEND-K). `no-await-in-loop` keeps loops in this file from awaiting.
    const [allRuns, tasks, proposals] = await Promise.all([
      ctx.db
        .query("runs")
        .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
        .collect(),
      ctx.db
        .query("tasks")
        .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
        .collect(),
      proposalsNeeding(ctx, actor, me, team),
    ]);
    // A closed run (ADR 0044) is in its person's Inbox only. An agent key limited to some channels
    // (ADR 0049) sees only their projects' tasks.
    const [runSeen, taskOutside] = await Promise.all([
      Promise.all(allRuns.map((run) => seesRun(ctx, run, actor))),
      Promise.all(tasks.map((task) => taskOutsideChannels(ctx, actor, task))),
    ]);
    const runsByTask = new Map<Id<"tasks">, Doc<"runs">[]>();
    const unfiled: Doc<"runs">[] = [];
    allRuns.forEach((run, i) => {
      if (!runSeen[i]) return;
      if (run.taskId) runsByTask.set(run.taskId, [...(runsByTask.get(run.taskId) ?? []), run]);
      else unfiled.push(run);
    });

    type Section = "needsYou" | "working" | "done";
    type Item = { task: Doc<"tasks"> } | { run: Doc<"runs"> };
    // Where a row goes, or null for none, decided before any row is built: settled and snoozed work
    // costs no reads.
    const sectionFor = (item: Item, runs: Doc<"runs">[], mine: boolean): Section | null => {
      if (!team && !mine) return null;
      if (runs.length === 0 && !("task" in item && item.task.closedAt !== undefined)) return null;
      if (runs.some((r) => r.state === "waiting" && (team || r.driverId === me))) return "needsYou";
      const holder = "task" in item ? item.task : item.run;
      if (hidden(holder, latestChange(runs, holder._creationTime), now)) return null;
      // Done only once every run has finished. The row's state is the most urgent one, so a failed
      // attempt beside a retry that's still going shows as failed, but stays in Working.
      const closed = "task" in item && item.task.closedAt !== undefined;
      if (closed || runs.every((r) => isFinished(r.state))) return "done";
      return "working";
    };
    const placed: { item: Item; runs: Doc<"runs">[]; section: Section }[] = [];
    const place = (item: Item, runs: Doc<"runs">[], mine: boolean) => {
      const section = sectionFor(item, runs, mine);
      if (section) placed.push({ item, runs, section });
    };
    tasks.forEach((task, i) => {
      if (taskOutside[i]) return;
      const runs = runsByTask.get(task._id) ?? [];
      place({ task }, runs, task.ownerId === me || runs.some(mineRun));
    });
    for (const run of unfiled) place({ run }, [run], mineRun(run));

    const rows = await Promise.all(placed.map(({ item, runs }) => buildRow(ctx, item, runs, actor)));
    const sections: Record<Section, Row[]> = { needsYou: [], working: [], done: [] };
    placed.forEach(({ section }, i) => sections[section].push(rows[i]!));
    const newest = (a: Row, b: Row) => b.changedAt - a.changedAt;
    const ownAgentView = !team && args.view !== "person" && actor.accountable;
    return {
      /** Whose Inbox this is: the caller's, or for view 'person' the agent's person. Absent for 'team'. */
      for: team ? undefined : { memberId: forMember._id, name: forMember.name, kind: forMember.kind },
      /** For an agent reading its own Inbox: where its person's is. */
      personView: ownAgentView
        ? `This is your own Inbox: the runs you drive, and the runs given to you (report on those with runs.report). ${actor.accountable!.name}, who added you, sees theirs in the app; read it with inbox.get view: 'person'.`
        : undefined,
      needsYou: sections.needsYou.sort(newest),
      /** Tasks proposed from calls, waiting for a yes (calls.acceptProposal) or a no (calls.dismissProposal). */
      proposals,
      working: sections.working.sort(newest),
      done: sections.done.sort(newest),
    };
  },
});

export async function canAnswer(ctx: QueryCtx, actor: Actor, run: Doc<"runs">): Promise<boolean> {
  if (actor.kind === "agent" && actor.scopes !== "all" && !actor.scopes.has("approvals.answer"))
    return false;
  // As its driver only where they may still drive: not a teammate's wheel on a personal machine set
  // below Drive (ADR 0025). The task's owner and admins answer there as before (ADR 0005).
  if (run.driverId && actsFor(actor, run.driverId)) {
    const machine = run.machineId ? await ctx.db.get(run.machineId) : null;
    if (!machine || (await mayDriveThere(ctx, machine, run._id, run.driverId))) return true;
  }
  const task = run.taskId ? await ctx.db.get(run.taskId) : null;
  if (task && actsFor(actor, task.ownerId)) return true;
  return actor.role === "admin";
}

export const { person: answer, agent: answerAgent } = roomMutation({
  name: "inbox.answer",
  description:
    "Allow or deny a waiting run's approval. Pass promptId from the run's prompt.promptId (\"\" if the prompt has none); an answer naming any other approval is refused with conflict, so it can't land on a newer approval. Its driver, the task's owner or an admin can answer; an agent needs the approvals.answer scope and can answer only what its person could.",
  scope: "approvals.answer",
  args: {
    runId: v.id("runs"),
    answer: v.union(v.literal("allow"), v.literal("deny")),
    /** The approval being answered: the run's `prompt.promptId`, or "" for a prompt without one. An answer to any other approval is refused. */
    promptId: v.string(),
  },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (run.state !== "waiting" || run.prompt?.kind !== "approval") {
      throw roomError("conflict", "This run isn't waiting for an approval any more.");
    }
    if (!(await canAnswer(ctx, actor, run))) {
      throw roomError(
        "forbidden",
        "Only the run's driver, the task's owner or an admin can answer this.",
      );
    }
    if (args.promptId !== (run.prompt.promptId ?? "")) {
      throw roomError(
        "conflict",
        "That isn't the approval this run is waiting on now. Answer the current one.",
      );
    }
    const source = run.terminalId
      ? { kind: "terminal" as const, terminalId: run.terminalId as string }
      : run.threadRef
        ? { kind: "thread" as const, threadRef: run.threadRef }
        : null;
    if (!source) throw roomError("invalid", "This run has no terminal or thread to answer.");
    // The bridge takes answers only from the driver, so the room sends it as the driver's.
    // Whoever really answered is kept in lastAnswer and the activity log below.
    const terminal = run.terminalId ? await ctx.db.get(run.terminalId) : null;
    const driverId = terminal?.driverId ?? run.driverId;
    const driver = driverId ? await ctx.db.get(driverId) : null;
    if (!driver)
      throw roomError(
        "conflict",
        "This run has no driver right now, so the answer can't reach it.",
      );
    if (!run.machineId)
      throw roomError("invalid", "This run isn't on a machine, so there is no approval to answer.");
    await sendToBridge(ctx, run.machineId, {
      v: 1,
      type: "answer_prompt",
      source,
      from: actorRef(driver),
      // Prompts from a bridge that sends no ids get "", which no current bridge accepts.
      promptId: run.prompt.promptId ?? "",
      answer: args.answer,
    });
    await ctx.db.patch(run._id, {
      lastAnswer: {
        by: actor.member._id,
        answer: args.answer,
        ...(run.prompt.action ? { action: run.prompt.action } : {}),
        at: Date.now(),
      },
    });
    await audit(ctx, actor, "approval.answered", run._id, {
      answer: args.answer,
      action: run.prompt.action,
      ...(run.prompt.promptId ? { promptId: run.prompt.promptId } : {}),
    });
    return null;
  },
});

export const { person: answerQuestion, agent: answerQuestionAgent } = roomMutation({
  name: "inbox.answerQuestion",
  description:
    "Answer a T3 Code thread's question: a waiting run whose prompt is a question with questions. answers maps each question's id to an option's label, several labels for a multiSelect question, or your own words where allowCustomAnswer is true. Pass promptId from the run's prompt.promptId; an answer to any other question is refused with conflict. Its driver, the task's owner or an admin can answer; an agent needs the approvals.answer scope. A question without questions is answered in T3 Code.",
  scope: "approvals.answer",
  args: {
    runId: v.id("runs"),
    promptId: v.string(),
    answers: v.record(v.string(), v.union(v.string(), v.array(v.string()))),
  },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    const questions = run.state === "waiting" && run.prompt?.kind === "question" ? run.prompt.questions : undefined;
    if (!questions?.length || !run.prompt?.promptId) {
      throw roomError("conflict", "This run isn't waiting for a question the room can answer.");
    }
    if (!(await canAnswer(ctx, actor, run))) {
      throw roomError("forbidden", "Only the run's driver, the task's owner or an admin can answer this.");
    }
    if (args.promptId !== run.prompt.promptId) {
      throw roomError("conflict", "That isn't the question this run is waiting on now. Answer the current one.");
    }
    for (const [id, value] of Object.entries(args.answers)) {
      const question = questions.find((q) => q.id === id);
      if (!question) throw roomError("invalid", `No question ${id} here.`);
      const values = Array.isArray(value) ? value : [value];
      if (Array.isArray(value) && !question.multiSelect) throw roomError("invalid", `${question.header} takes one answer.`);
      if (values.some((answer) => !answer.trim() || answer.length > 4000)) throw roomError("invalid", `${question.header} needs an answer of at most 4,000 characters.`);
      const labels = new Set(question.options.map((o) => o.label));
      if (!question.allowCustomAnswer && values.some((answer) => !labels.has(answer))) {
        throw roomError("invalid", `${question.header} takes one of its options: ${[...labels].join(", ")}.`);
      }
    }
    const missing = questions.filter((q) => !(q.id in args.answers));
    if (missing.length) throw roomError("invalid", `Answer every question: ${missing.map((q) => q.header).join(", ")}.`);
    const machine = run.machineId ? await ctx.db.get(run.machineId) : null;
    if (!run.threadRef || !machine) throw roomError("invalid", "This run has no thread to answer.");
    if (!bridgeHandles(machine, "thread_questions")) {
      throw roomError("invalid", `The bridge on ${machine.name} is too old to take answers to questions. Answer it in T3 Code.`);
    }
    // The bridge takes answers only from the driver, so the room sends it as the driver's.
    const driver = run.driverId ? await ctx.db.get(run.driverId) : null;
    if (!driver) throw roomError("conflict", "This run has no driver right now, so the answer can't reach it.");
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "answer_question",
      threadRef: run.threadRef,
      from: actorRef(driver),
      promptId: run.prompt.promptId,
      answers: args.answers,
    });
    await ctx.db.patch(run._id, { questionAnswer: { by: actor.member._id, promptId: run.prompt.promptId, at: Date.now() } });
    await audit(ctx, actor, "question.answered", run._id, {
      promptId: run.prompt.promptId,
      answers: Object.fromEntries(Object.entries(args.answers).map(([k, value]) => [k, Array.isArray(value) ? value.map((x) => x.slice(0, 200)) : value.slice(0, 200)])),
    });
    return null;
  },
});

async function holderFor(
  ctx: QueryCtx,
  actor: Actor,
  args: { taskId?: Id<"tasks">; runId?: Id<"runs"> },
): Promise<Doc<"tasks"> | Doc<"runs">> {
  if (args.taskId) return inTeam(ctx, actor, args.taskId);
  if (args.runId) {
    const run = await inTeam(ctx, actor, args.runId);
    if (run.taskId) return inTeam(ctx, actor, run.taskId);
    return run;
  }
  throw roomError("invalid", "Pass a taskId, or a runId for an unfiled run.");
}

export const { person: settle, agent: settleAgent } = roomMutation({
  name: "inbox.settle",
  description:
    "Settle finished work so it leaves the Inbox. It stays findable, and comes back if one of its runs changes state.",
  scope: "work.manage",
  args: { taskId: v.optional(v.id("tasks")), runId: v.optional(v.id("runs")) },
  handler: async (ctx, actor, args) => {
    const holder = await holderFor(ctx, actor, args);
    await ctx.db.patch(holder._id, { settledAt: Date.now() });
    return null;
  },
});

export const { person: snooze, agent: snoozeAgent } = roomMutation({
  name: "inbox.snooze",
  description:
    "Hide a task (or unfiled run) from the Inbox until a time (ms since epoch) or until one of its runs changes state.",
  scope: "work.manage",
  args: { taskId: v.optional(v.id("tasks")), runId: v.optional(v.id("runs")), until: v.number() },
  handler: async (ctx, actor, args) => {
    const holder = await holderFor(ctx, actor, args);
    const snoozedAt = Date.now();
    await ctx.db.patch(holder._id, { snoozedUntil: args.until, snoozedAt });
    await ctx.scheduler.runAt(args.until, internal.inbox.endSnooze, {
      holderId: holder._id,
      snoozedUntil: args.until,
      snoozedAt,
    });
    return null;
  },
});

/**
 * Ends a snooze at its time by clearing it, so subscribed Inboxes show the work
 * again: Convex re-runs a query only when data it read changes, never because
 * time passed. Does nothing if the snooze was changed or cleared since.
 */
export const endSnooze = internalMutation({
  args: {
    holderId: v.union(v.id("tasks"), v.id("runs")),
    snoozedUntil: v.number(),
    snoozedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const holder = await ctx.db.get(args.holderId);
    if (!holder || holder.snoozedUntil !== args.snoozedUntil || holder.snoozedAt !== args.snoozedAt)
      return null;
    await ctx.db.patch(holder._id, { snoozedUntil: undefined, snoozedAt: undefined });
    return null;
  },
});
