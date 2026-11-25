/**
 * Tasks that wait for others and queue for a machine (ADR 0050).
 *
 * A task can need other tasks (`needs`): it waits until each of them is closed (tasks.keepRun). A
 * task can be queued for a machine (`taskQueue`): once every task it needs is closed, the room
 * starts a run for it there, as whoever queued it, when the machine has room. A terminal needs a
 * free slot, unless the machine is its starter's own; a T3 Code thread needs none. Queued tasks
 * start oldest first.
 *
 * The room looks at a machine's queue when a task is queued there, when a terminal on it ends, and
 * when a task closes (its dependents may be ready); a cron looks at every queue each minute too, so
 * a machine that came back online, or a slot freed some other way, is never missed for long.
 */
import { accessRank, DEFAULT_RUNTIME_MODE } from "@uplink-room/protocol";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentActorForKey, hasScope, memberStillActs, type Actor } from "./actor";
import { roomError } from "./errors";
import { refusalOf } from "./refusals";
import { isHarness, terminalModes, threadRefusal } from "./harnesses";
import { requireMayStart } from "./machines";
import { inTeam } from "./members";
import { aboveModeCap, bridgeHandles, modeCapText } from "./threads";

/** At most this many tasks one task waits for. */
export const MAX_NEEDS = 20;
/** At most this many tasks are visited when checking that a task's needs don't loop back to it. */
const NEEDS_WALK_MAX = 500;
/** The longest command line runs.start takes for a shell. */
export const MAX_COMMAND = 4000;

/**
 * Checks the tasks `taskId` is to wait for: each in the team and visible to the actor, not the task
 * itself, and none waiting (directly or through others) for `taskId`, which would never start.
 */
export async function checkNeeds(
  ctx: QueryCtx,
  actor: Actor,
  taskId: Id<"tasks"> | null,
  needs: Id<"tasks">[],
): Promise<Id<"tasks">[]> {
  const unique = [...new Set(needs)];
  if (unique.length > MAX_NEEDS) throw roomError("invalid", `A task can wait for at most ${MAX_NEEDS} tasks.`);
  for (const id of unique) {
    if (id === taskId) throw roomError("invalid", "A task can't wait for itself.");
    await inTeam(ctx, actor, id);
  }
  if (!taskId) return unique;
  // Walk what the needed tasks wait for: reaching taskId would make a loop that never starts.
  const seen = new Set<Id<"tasks">>();
  const todo = [...unique];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > NEEDS_WALK_MAX) throw roomError("invalid", "These tasks wait on too long a chain to check. Wait for fewer tasks.");
    const task = await ctx.db.get(id);
    for (const next of task?.needs ?? []) {
      // No title here: a task on the way may be one the caller can't see.
      if (next === taskId) throw roomError("invalid", "One of those tasks already waits for this task, directly or through others, so this task can't wait for it.");
      todo.push(next);
    }
  }
  return unique;
}

export type QueueSpec = Pick<
  Doc<"taskQueue">,
  "harness" | "via" | "cwd" | "repo" | "prompt" | "command" | "access" | "runtimeMode"
>;

/**
 * Why this start, by this actor on this machine, would be refused, or null when it can start. The
 * same checks runs.start makes before it writes anything, so a queued start that passes them
 * starts. A missing slot isn't a refusal: the task just waits for one (tasks.ts `hasRoom`).
 */
export async function queueRefusal(
  ctx: QueryCtx,
  actor: Actor,
  machine: Doc<"machines"> | null,
  task: Doc<"tasks">,
  spec: QueueSpec,
): Promise<string | null> {
  if (!hasScope(actor, "runs.start")) return `${actor.member.name} can't start runs (no runs.start scope).`;
  if (spec.command !== undefined) {
    const command = spec.command.trim();
    if (spec.harness !== "shell" || spec.via === "thread" || !command) return "command is only for a terminal with harness shell, and can't be empty.";
    if (command.length > MAX_COMMAND) return `command can be at most ${MAX_COMMAND} characters.`;
  }
  if (spec.command !== undefined && !hasScope(actor, "terminals.drive")) return `${actor.member.name} can't run a command (no terminals.drive scope).`;
  if (!machine || machine.teamId !== task.teamId) return "The machine is gone.";
  if (machine.unlinkedAt !== undefined) return `${machine.name} was unlinked.`;
  if (spec.via === "terminal" && machine.sharingStoppedAt !== undefined) return `Sharing is stopped on ${machine.name}.`;
  if (task.closedAt !== undefined) return "The task is closed.";
  try {
    await inTeam(ctx, actor, task._id);
    await inTeam(ctx, actor, machine._id);
    await requireMayStart(ctx, actor, machine, task.directChannelId);
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal.refused.message;
    throw error;
  }
  if (!isHarness(spec.harness)) return `Unknown harness ${spec.harness}.`;
  if (spec.via === "thread" && threadRefusal(spec.harness)) return threadRefusal(spec.harness)!;
  const access = spec.access ?? "watch";
  if (accessRank(access) > accessRank(machine.mostOpenAccess)) return `${machine.name} allows at most ${machine.mostOpenAccess}.`;
  const mode = spec.runtimeMode;
  if (mode && mode !== DEFAULT_RUNTIME_MODE) {
    if (aboveModeCap(machine, mode)) return modeCapText(machine);
    if (spec.via === "thread" ? !bridgeHandles(machine, "thread_modes") : !terminalModes(spec.harness).includes(mode)) {
      return `${machine.name} can't start a ${spec.harness} ${spec.via} in ${mode}.`;
    }
  }
  return null;
}

/** Whoever queued the task, with the rights they have now; null when they can no longer act. */
export async function queueActor(ctx: QueryCtx, row: Doc<"taskQueue">): Promise<Actor | null> {
  if (row.agentKeyId) {
    try {
      return await agentActorForKey(ctx, await ctx.db.get(row.agentKeyId), row.teamId);
    } catch {
      return null;
    }
  }
  const member = await ctx.db.get(row.queuedBy);
  if (!member || member.kind !== "person" || !(await memberStillActs(ctx, member._id))) return null;
  return { kind: "person", teamId: member.teamId, member, role: member.role, scopes: "all" };
}

/** Asks the room to look at a machine's queue now. */
export async function dispatchSoon(ctx: MutationCtx, machineId: Id<"machines">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.tasks.dispatchQueue, { machineId });
}

/** After a task closes: the machines whose queued tasks may have waited for it look again. */
export async function dispatchTeamSoon(ctx: MutationCtx, teamId: Id<"teams">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.tasks.dispatchTeam, { teamId, cursor: null });
}

/** After a terminal ends on a machine: its queue looks again, if it has one. */
export async function dispatchIfQueued(ctx: MutationCtx, machineId: Id<"machines">): Promise<void> {
  const queued = await ctx.db
    .query("taskQueue")
    .withIndex("by_machine_queued", (q) => q.eq("machineId", machineId))
    .first();
  if (queued) await dispatchSoon(ctx, machineId);
}
