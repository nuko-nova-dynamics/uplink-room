import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { maybeView, memberView } from "./members";
import { a2aView, canSteer, runIsHidden } from "./a2a/runs";
import type { Actor } from "./actor";
import { canSeeId, privateTitle, taskOutsideChannels } from "./channels";
import { givenView, isGiven, mayReplyGiven } from "./givenRuns";
import { pullView } from "./github/pulls";

export type RunState = Doc<"runs">["state"];
export type TaskState = RunState | "not_started";
export type Column = "not_started" | "needs_someone" | "working" | "done";

/** Most urgent first (GLOSSARY.md, "Run state"). Unknown sits with Working. */
const URGENCY: RunState[] = ["waiting", "failed", "working", "unknown", "done", "stopped"];

/** A task shows the most urgent state among its runs. */
export function taskState(runs: Pick<Doc<"runs">, "state">[]): TaskState {
  if (runs.length === 0) return "not_started";
  return [...runs].sort((a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state))[0]!.state;
}

/** Board columns come from run states, so nobody drags cards (DESIGN.md, "Project board"). */
export function columnFor(state: TaskState): Column {
  switch (state) {
    case "not_started":
      return "not_started";
    case "waiting":
    case "failed":
      return "needs_someone";
    case "working":
    case "unknown":
      return "working";
    case "done":
    case "stopped":
      return "done";
  }
}

export function isFinished(state: TaskState): boolean {
  return state === "done" || state === "stopped" || state === "failed";
}

/** When a task's or unfiled run's runs last changed state: its newest run's change, else `fallback`. */
export function latestChange(runs: Pick<Doc<"runs">, "stateChangedAt">[], fallback: number): number {
  return runs.reduce((max, r) => Math.max(max, r.stateChangedAt), fallback);
}

/**
 * Settled and still put away (GLOSSARY.md, "Settle"): settled since its runs last changed state, so
 * a run changing state brings it back.
 */
export function settledSince(holder: { settledAt?: number }, changedAt: number): boolean {
  return holder.settledAt !== undefined && holder.settledAt >= changedAt;
}

/**
 * Whether the board and the task panel show a task as settled: settled since its runs last changed
 * and none of them still going. Work settled while a run works (an agent can) stays in Working.
 */
export function taskIsSettled(task: Doc<"tasks">, runs: Doc<"runs">[]): boolean {
  return (
    runs.length > 0 &&
    runs.every((r) => isFinished(r.state)) &&
    settledSince(task, latestChange(runs, task._creationTime))
  );
}

/**
 * A run as callers see it. A run sent from a direct message or private channel the viewer isn't in,
 * or on a task from one, shows without its texts (`private`): no question, failure reason, message
 * or answer (ADR 0015, ADR 0016).
 */
/**
 * The title a viewer sees for a run. For a hidden run only a title the room wrote itself is kept:
 * an A2A run's or a given run's ("Message from Ana in a private channel", "A run from a private channel"). A run on a machine takes its title from
 * the bridge, which can quote the prompt (T3 Code titles a thread by its first line), so it shows
 * only where it came from.
 */
export async function runTitleFor(ctx: QueryCtx, run: Doc<"runs">, hidden: boolean): Promise<string | undefined> {
  if (!hidden || run.harness === "a2a" || isGiven(run)) return run.title;
  return privateTitle(run.directChannelId ? await ctx.db.get(run.directChannelId) : null, "run");
}

export async function runView(ctx: QueryCtx, run: Doc<"runs">, viewer: Actor) {
  const machine = run.machineId ? await ctx.db.get(run.machineId) : null;
  const hidden = await runIsHidden(ctx, run, viewer);
  return {
    runId: run._id,
    taskId: run.taskId,
    harness: run.harness,
    title: await runTitleFor(ctx, run, hidden),
    repo: run.repo,
    state: run.state,
    failReason: hidden ? undefined : run.failReason,
    prompt: hidden ? undefined : run.prompt,
    private: hidden,
    driver: await maybeView(ctx, run.driverId),
    machine: machine ? { machineId: machine._id, name: machine.name } : undefined,
    terminalId: run.terminalId,
    spaceId: run.spaceId,
    threadRef: run.threadRef,
    /** A session that joined by itself (uplink join, ADR 0032): chat only, with no terminal, thread or machine. */
    ...(run.joinedSessionId !== undefined ? { joined: true as const } : {}),
    // The approved action is the question's text by another name: hidden with it.
    lastAnswer: run.lastAnswer && !hidden
      ? {
          answer: run.lastAnswer.answer,
          action: run.lastAnswer.action,
          at: run.lastAnswer.at,
          by: await memberView(ctx, run.lastAnswer.by),
        }
      : undefined,
    /** The last answer sent from the room to a thread's question: for which prompt, and when. */
    questionAnswer: run.questionAnswer && !hidden
      ? { promptId: run.questionAnswer.promptId, at: run.questionAnswer.at, by: await memberView(ctx, run.questionAnswer.by) }
      : undefined,
    startedAt: run._creationTime,
    stateChangedAt: run.stateChangedAt,
    /** A finished unfiled run settled since it last changed state. A task's run settles with its task (its card's settled). */
    settled: run.taskId === undefined && isFinished(run.state) && settledSince(run, run.stateChangedAt),
    endedAt: run.endedAt,
    /** For a run sent to an agent over A2A (ADR 0012): the agent, its own task state, and what it answered. */
    a2a: await a2aView(ctx, run, hidden),
    /**
     * For a run given to an agent the room can't follow over A2A (harness "agent", ADR 0044): the
     * agent, how the room reaches it, how far the latest send got, the agent's latest line
     * (runs.report) and what was sent to it.
     */
    given: await givenView(ctx, run, hidden),
    /**
     * Whether you may send this agent run a reply (runs.reply): its driver, whoever started it, the
     * task's owner or an admin; for a given run, only until it ends.
     */
    canReply: run.harness === "a2a" ? await canSteer(ctx, viewer, run) : isGiven(run) ? await mayReplyGiven(ctx, viewer, run) : false,
  };
}

export async function runsOfTask(ctx: QueryCtx, taskId: Id<"tasks">) {
  return ctx.db
    .query("runs")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
}

/**
 * Whether the viewer can't see the direct message or private channel a task came from (ADR 0016):
 * then it shows without its title and description, and only the channel's members can act on it.
 */
export async function taskIsHidden(ctx: QueryCtx, task: Doc<"tasks">, viewer: Actor): Promise<boolean> {
  return task.directChannelId !== undefined && !(await canSeeId(ctx, viewer, task.directChannelId));
}

/** The title the viewer sees for a task: its own, or for a hidden one, where it came from. */
export async function taskTitleFor(ctx: QueryCtx, task: Doc<"tasks">, hidden: boolean): Promise<string> {
  return hidden && task.directChannelId ? privateTitle(await ctx.db.get(task.directChannelId), "task") : task.title;
}

/** A card: the task, its owner, its runs, and who a waiting run is waiting on. */
export async function taskCard(ctx: QueryCtx, task: Doc<"tasks">, viewer: Actor) {
  const runs = await runsOfTask(ctx, task._id);
  const state = taskState(runs);
  const settled = taskIsSettled(task, runs);
  const column: Column = settled ? "done" : columnFor(state);
  const waiting = runs.filter((r) => r.state === "waiting");
  const hidden = await taskIsHidden(ctx, task, viewer);
  return {
    taskId: task._id,
    projectId: task.projectId,
    title: await taskTitleFor(ctx, task, hidden),
    description: hidden ? undefined : task.description,
    /** It came from a direct message or private channel you aren't in: its texts are left out. */
    private: hidden,
    owner: await memberView(ctx, task.ownerId),
    /** When it was made (ms). The board lists tasks oldest first. */
    createdAt: task._creationTime,
    /**
     * Who made it: whoever assigned it, when that isn't its owner. Left out, like the texts, for a
     * task from a direct message or private channel you aren't in.
     */
    createdBy: hidden ? undefined : await memberView(ctx, task.createdBy),
    state,
    /** Settled since its runs last changed (GLOSSARY.md, "Settle"): it sits in Done, whatever its runs' state. */
    settled,
    column,
    waitingOn: await Promise.all(
      waiting.filter((r) => r.driverId).map((r) => memberView(ctx, r.driverId!)),
    ),
    keptRunId: task.keptRunId,
    closedAt: task.closedAt,
    runs: await Promise.all(runs.map((r) => runView(ctx, r, viewer))),
    /**
     * The tasks it waits for (ADR 0050), each with whether it is closed yet: only those you can see.
     * Left out, with its pull requests, for a task from a direct message or private channel you
     * aren't in.
     */
    needs: hidden ? [] : await needsView(ctx, task, viewer),
    /** Its place in a machine's queue (ADR 0050): it starts there by itself once every task it needs is closed. */
    queued: await queuedView(ctx, task),
    /** Linked GitHub pull requests (ADR 0051), with their state, review decision and checks. */
    pullRequests: hidden
      ? []
      : (
          await ctx.db
            .query("taskPullRequests")
            .withIndex("by_task", (q) => q.eq("taskId", task._id))
            .take(20)
        ).map(pullView),
  };
}

async function needsView(ctx: QueryCtx, task: Doc<"tasks">, viewer: Actor) {
  const views = [];
  for (const id of task.needs ?? []) {
    const need = await ctx.db.get(id);
    if (!need) {
      views.push({ taskId: id, title: "A deleted task", closed: true });
      continue;
    }
    // A task outside a channel-limited key's channels (ADR 0049) isn't there for it at all.
    if (await taskOutsideChannels(ctx, viewer, need)) continue;
    views.push({ taskId: id, title: await taskTitleFor(ctx, need, await taskIsHidden(ctx, need, viewer)), closed: need.closedAt !== undefined });
  }
  return views;
}

async function queuedView(ctx: QueryCtx, task: Doc<"tasks">) {
  const row = await ctx.db
    .query("taskQueue")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .first();
  if (!row) return undefined;
  const machine = await ctx.db.get(row.machineId);
  return {
    machine: { machineId: row.machineId, name: machine?.name ?? "A removed machine" },
    harness: row.harness,
    via: row.via,
    queuedAt: row.queuedAt,
    queuedBy: await memberView(ctx, row.queuedBy),
    /** Why the last try couldn't start it: until that changes, it waits. */
    lastRefusal: row.lastRefusal,
  };
}
