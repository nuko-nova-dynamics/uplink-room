import { v } from "convex/values";
import { vAccess, vRuntimeMode } from "@uplink-room/protocol";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { accountableId, actsFor, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { audit, inTeam, taskOutsideChannels, teamMember } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { taskCard } from "./lib/states";
import { memberCanSee, whereLabel } from "./lib/channels";
import { IDEMPOTENCY_DOC, once, pruneIdempotentWrites as pruneKeys, vIdempotencyKey } from "./lib/idempotency";
import {
  checkNeeds,
  dispatchSoon,
  dispatchTeamSoon,
  MAX_NEEDS,
  queueActor,
  queueRefusal,
  type QueueSpec,
} from "./lib/taskQueue";
import { belongsToMember, isOnline } from "./lib/machines";
import { cloudFor, holdsQueue, wakeForWork } from "./lib/cloudMachines";
import { isLive } from "./lib/terminals";
import { parsePullRef } from "./lib/github/pulls";
import { repoKey } from "./lib/repos";
import { startRun } from "./runs";

async function personOwner(ctx: MutationCtx, actor: Actor, ownerId: Id<"members"> | undefined) {
  const id = ownerId ?? accountableId(actor);
  const owner = await teamMember(ctx, actor, id);
  if (owner.kind !== "person") throw roomError("invalid", "A task's owner must be a person, not an agent.");
  return owner;
}

const NEEDS_DOC = `Tasks this one waits for (ADR 0050), at most ${MAX_NEEDS}: queued (tasks.queue), it starts only once each of them is closed (tasks.keepRun). Never itself, or a task that already waits for it`;

/** Inserts a task as tasks.create does; `needs` already checked. */
async function insertTask(
  ctx: MutationCtx,
  actor: Actor,
  args: { title: string; description?: string; projectId?: Id<"projects">; ownerId?: Id<"members"> },
): Promise<Id<"tasks">> {
  const title = args.title.trim();
  if (!title) throw roomError("invalid", "A task needs a title.");
  if (args.projectId) await inTeam(ctx, actor, args.projectId);
  const owner = await personOwner(ctx, actor, args.ownerId);
  return await ctx.db.insert("tasks", {
    teamId: actor.teamId,
    title,
    ...(args.description ? { description: args.description } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ownerId: owner._id,
    createdBy: actor.member._id,
  });
}

export const { person: create, agent: createAgent } = roomMutation({
  name: "tasks.create",
  description:
    "Create a task, with or without a project. Its owner is a person: you, or for an agent, the person accountable for it, unless ownerId names another person. needs makes it wait for other tasks: queued with tasks.queue, it starts only once they are closed. To create several that wait for each other in one call, use tasks.createMany.",
  scope: "work.manage",
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
    ownerId: v.optional(v.id("members")),
    needs: v.optional(v.array(v.id("tasks"))),
    idempotencyKey: vIdempotencyKey,
  },
  argDocs: { needs: NEEDS_DOC, idempotencyKey: IDEMPOTENCY_DOC },
  handler: async (ctx, actor, { idempotencyKey, ...args }) =>
    once(ctx, actor, "tasks.create", idempotencyKey, args, async () => {
      const needs = args.needs ? await checkNeeds(ctx, actor, null, args.needs) : [];
      const taskId = await insertTask(ctx, actor, args);
      if (needs.length) await ctx.db.patch(taskId, { needs });
      return taskId;
    }),
});

export const { person: update, agent: updateAgent } = roomMutation({
  name: "tasks.update",
  description:
    "Change a task's title, description, project, owner (a person), or the tasks it waits for (needs; null for none). A task that waits starts from the queue only once each task it needs is closed.",
  scope: "work.manage",
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    ownerId: v.optional(v.id("members")),
    needs: v.optional(v.union(v.array(v.id("tasks")), v.null())),
  },
  argDocs: { needs: NEEDS_DOC },
  handler: async (ctx, actor, args) => {
    const task = await inTeam(ctx, actor, args.taskId);
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) {
      if (!args.title.trim()) throw roomError("invalid", "A task needs a title.");
      patch.title = args.title.trim();
    }
    if (args.description !== undefined) patch.description = args.description;
    if (args.projectId !== undefined) {
      if (args.projectId) await inTeam(ctx, actor, args.projectId);
      patch.projectId = args.projectId ?? undefined;
    }
    if (args.ownerId !== undefined) {
      const owner = await personOwner(ctx, actor, args.ownerId);
      // A task from a direct message or private channel is owned by one of its members (ADR 0016).
      const channel = task.directChannelId ? await ctx.db.get(task.directChannelId) : null;
      if (channel && !(await memberCanSee(ctx, channel, owner._id))) {
        throw roomError("invalid", `${owner.name} isn't in ${whereLabel(channel)}, so they can't own this task.`);
      }
      patch.ownerId = owner._id;
      await audit(ctx, actor, "task.owner_changed", task._id, { ownerId: args.ownerId });
    }
    if (args.needs !== undefined) {
      const needs = args.needs ? await checkNeeds(ctx, actor, task._id, args.needs) : [];
      patch.needs = needs.length ? needs : undefined;
      await audit(ctx, actor, "task.needs_changed", task._id, { needs });
    }
    await ctx.db.patch(task._id, patch);
    // Waiting for fewer tasks can make it ready to start from the queue.
    if (args.needs !== undefined) {
      const queued = await queueRowOf(ctx, task._id);
      if (queued) await dispatchSoon(ctx, queued.machineId);
    }
    return null;
  },
});

export const { person: board, agent: boardAgent } = roomQuery({
  name: "tasks.board",
  description:
    "A board of tasks, oldest first: each with its state and column, both from its runs. column is not_started (no run yet), needs_someone (a run is waiting or failed: someone should look, not necessarily you; inbox.get says whom a waiting run waits on), working (a run is working or unknown) or done (every run done or stopped, or settled with every run finished; settled says so, until a run changes state again), owner (the person accountable for it), createdBy (who made or assigned it) and createdAt (ms), its runs, and who a waiting run is waiting on. Closed tasks are left out unless includeClosed. Pass projectId for one project's board.",
  scope: "room.read",
  args: { projectId: v.optional(v.id("projects")), includeClosed: v.optional(v.boolean()) },
  handler: async (ctx, actor, args) => {
    const tasks = args.projectId
      ? await ctx.db
          .query("tasks")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect()
      : await ctx.db
          .query("tasks")
          .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
          .collect();
    const visible: typeof tasks = [];
    for (const task of tasks) {
      if (task.teamId !== actor.teamId || (!args.includeClosed && task.closedAt !== undefined)) continue;
      if (await taskOutsideChannels(ctx, actor, task)) continue;
      visible.push(task);
    }
    return Promise.all(visible.map((task) => taskCard(ctx, task, actor)));
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "tasks.get",
  description:
    "One task with its runs, for the task panel. A task from a direct message or private channel you aren't in shows without its title and description (private: true), and only that channel's members can change it.",
  scope: "room.read",
  args: { taskId: v.id("tasks") },
  handler: async (ctx, actor, args) => {
    // Not inTeam: a task from a private channel is still the team's to see, without its texts (ADR 0016).
    const task = await ctx.db.get(args.taskId);
    if (!task || task.teamId !== actor.teamId || (await taskOutsideChannels(ctx, actor, task))) {
      throw roomError("not_found", "Not found in this team.");
    }
    return taskCard(ctx, task, actor);
  },
});

export const { person: keepRun, agent: keepRunAgent } = roomMutation({
  name: "tasks.keepRun",
  description:
    "Mark one of a task's runs as the one we keep, and close the task: how a finished task is closed. Its owner can, or an agent for the person accountable for it. A closed task leaves the board (tasks.board includeClosed shows it, with closedAt and keptRunId), shows done in the Inbox whatever the kept run's state, and can't get new runs: a later run on the same work is unfiled. Closing is final: nothing reopens a task, so keep a run only once the task's work is done.",
  scope: "work.manage",
  args: { taskId: v.id("tasks"), runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const task = await inTeam(ctx, actor, args.taskId);
    if (!actsFor(actor, task.ownerId)) {
      throw roomError("forbidden", "Only the task's owner can choose the run to keep.");
    }
    const run = await inTeam(ctx, actor, args.runId);
    if (run.taskId !== task._id) throw roomError("invalid", "That run belongs to another task.");
    await ctx.db.patch(task._id, { keptRunId: run._id, closedAt: Date.now() });
    await audit(ctx, actor, "task.run_kept", task._id, { runId: run._id });
    // A closed task leaves the queue, and the tasks that waited for it may be ready now (ADR 0050).
    const queued = await queueRowOf(ctx, task._id);
    if (queued) await ctx.db.delete(queued._id);
    await dispatchTeamSoon(ctx, actor.teamId);
    return null;
  },
});

// ---------- the queue (ADR 0050) ----------

/** The task's place in a queue, if it has one. */
async function queueRowOf(ctx: MutationCtx, taskId: Id<"tasks">): Promise<Doc<"taskQueue"> | null> {
  return ctx.db
    .query("taskQueue")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .first();
}

const vQueueSpec = {
  machineId: v.id("machines"),
  harness: v.string(),
  via: v.optional(v.union(v.literal("terminal"), v.literal("thread"))),
  cwd: v.optional(v.string()),
  repo: v.optional(v.string()),
  prompt: v.optional(v.string()),
  command: v.optional(v.string()),
  access: v.optional(vAccess),
  runtimeMode: v.optional(vRuntimeMode),
};

const QUEUE_ARG_DOCS = {
  machineId: "The machine to start it on, from machines.list",
  harness: "What runs, as in runs.start: shell, claude-code, codex, grok-build, opencode, cursor or hermes-agent",
  via: "'terminal' (default: uses a slot unless the machine is yours) or 'thread' (a T3 Code thread: uses no slot)",
  cwd: "The folder it starts in, such as a checkout's absolute path",
  repo: "The repo the work touches, such as github.com/org/repo",
  prompt: "For a thread: the message the agent starts with",
  command: "For harness shell: one command line to run, as runs.start's command (needs terminals.drive)",
  access: "How much teammates may do in it, as runs.start's access",
  runtimeMode: "Its permission mode, as runs.start's runtimeMode",
} as const;

type QueueArgs = { machineId: Id<"machines">; harness: string; via?: "terminal" | "thread" } & Omit<QueueSpec, "harness" | "via">;

/**
 * Puts a task in a machine's queue, replacing its place in any other, after the checks a start
 * would make now; the room starts it when it is ready (lib/taskQueue.ts).
 */
async function enqueue(ctx: MutationCtx, actor: Actor, task: Doc<"tasks">, args: QueueArgs): Promise<Id<"taskQueue">> {
  if (task.closedAt !== undefined) throw roomError("invalid", "This task is closed, so it takes no new runs.");
  const machine = await inTeam(ctx, actor, args.machineId);
  const spec: QueueSpec = {
    harness: args.harness,
    via: args.via ?? "terminal",
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.repo ? { repo: args.repo } : {}),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.access ? { access: args.access } : {}),
    ...(args.runtimeMode ? { runtimeMode: args.runtimeMode } : {}),
  };
  const refusal = await queueRefusal(ctx, actor, machine, task, spec);
  if (refusal) throw roomError("invalid", refusal);
  const existing = await queueRowOf(ctx, task._id);
  // Moving a task's place in a queue is for whoever may take it out (tasks.unqueue).
  if (existing && !actsFor(actor, existing.queuedBy) && !actsFor(actor, task.ownerId)) {
    throw roomError("forbidden", "This task is already queued. Only whoever queued it, or its owner, can move it.");
  }
  if (existing) await ctx.db.delete(existing._id);
  const queueId = await ctx.db.insert("taskQueue", {
    teamId: actor.teamId,
    taskId: task._id,
    machineId: machine._id,
    queuedBy: actor.member._id,
    ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
    ...spec,
    queuedAt: Date.now(),
  });
  await audit(ctx, actor, "task.queued", task._id, { machineId: machine._id, harness: spec.harness, via: spec.via });
  await dispatchSoon(ctx, machine._id);
  return queueId;
}

export const { person: queue, agent: queueAgent } = roomMutation({
  name: "tasks.queue",
  description:
    "Queue a task to start on a machine (ADR 0050): once every task it needs is closed, the room starts a run for it there as you, as runs.start would, when the machine has room: a free slot for a terminal (unless the machine is yours), none for a thread. Queued tasks start oldest first, each machine's in turn. Starting takes it out of the queue; so does closing the task, and tasks.unqueue. Queuing again moves it. A start the machine refuses later, such as after its person narrowed who may start runs there, waits with the reason on the task's card (queued.lastRefusal). Returns queueId.",
  scope: "runs.start",
  args: { taskId: v.id("tasks"), ...vQueueSpec },
  argDocs: QUEUE_ARG_DOCS,
  handler: async (ctx, actor, { taskId, ...args }) => {
    const task = await inTeam(ctx, actor, taskId);
    return { queueId: await enqueue(ctx, actor, task, args) };
  },
});

export const { person: unqueue, agent: unqueueAgent } = roomMutation({
  name: "tasks.unqueue",
  description: "Take a task out of its machine's queue, so it doesn't start by itself. Whoever queued it can, and the task's owner.",
  scope: "runs.start",
  args: { taskId: v.id("tasks") },
  handler: async (ctx, actor, args) => {
    const task = await inTeam(ctx, actor, args.taskId);
    const row = await queueRowOf(ctx, task._id);
    if (!row) throw roomError("not_found", "This task isn't queued.");
    if (!actsFor(actor, row.queuedBy) && !actsFor(actor, task.ownerId)) {
      throw roomError("forbidden", "Only whoever queued this task, or its owner, can take it out of the queue.");
    }
    await ctx.db.delete(row._id);
    await audit(ctx, actor, "task.unqueued", task._id);
    return null;
  },
});

/** The most tasks one plan creates. */
export const MAX_PLAN = 25;

export const { person: createMany, agent: createManyAgent } = roomMutation({
  name: "tasks.createMany",
  description: `Create a plan of up to ${MAX_PLAN} tasks at once, all or none: each with title and optionally key, description, projectId, ownerId, needs and queue. needs names tasks this one waits for, by another item's key or by an existing taskId; queue is tasks.queue's arguments without taskId, so the task starts by itself once what it needs is closed. A plan whose needs loop is refused. Returns tasks: each item's key (when given) and taskId, in order.`,
  scope: "work.manage",
  args: {
    tasks: v.array(
      v.object({
        key: v.optional(v.string()),
        title: v.string(),
        description: v.optional(v.string()),
        projectId: v.optional(v.id("projects")),
        ownerId: v.optional(v.id("members")),
        needs: v.optional(v.array(v.string())),
        queue: v.optional(v.object(vQueueSpec)),
      }),
    ),
    idempotencyKey: vIdempotencyKey,
  },
  argDocs: { idempotencyKey: IDEMPOTENCY_DOC },
  handler: async (ctx, actor, { idempotencyKey, ...args }) =>
    once(ctx, actor, "tasks.createMany", idempotencyKey, args, async () => {
      if (!args.tasks.length) throw roomError("invalid", "Pass at least one task.");
      if (args.tasks.length > MAX_PLAN) throw roomError("invalid", `A plan can create at most ${MAX_PLAN} tasks.`);
      const byKey = new Map<string, number>();
      args.tasks.forEach((item, i) => {
        if (item.key === undefined) return;
        if (byKey.has(item.key)) throw roomError("invalid", `Two tasks in the plan have the key ${item.key}.`);
        byKey.set(item.key, i);
      });
      // Every task first, then what each waits for, then the queue: a loop in the plan is refused by checkNeeds.
      const ids: Id<"tasks">[] = [];
      for (const item of args.tasks) ids.push(await insertTask(ctx, actor, item));
      for (const [i, item] of args.tasks.entries()) {
        if (!item.needs?.length) continue;
        const needs = item.needs.map((ref) => {
          const index = byKey.get(ref);
          if (index !== undefined) return ids[index]!;
          const id = ctx.db.normalizeId("tasks", ref);
          if (!id) throw roomError("invalid", `needs names ${ref}, which is neither a key in this plan nor a taskId.`);
          return id;
        });
        await ctx.db.patch(ids[i]!, { needs: await checkNeeds(ctx, actor, ids[i]!, needs) });
      }
      for (const [i, item] of args.tasks.entries()) {
        if (item.queue) await enqueue(ctx, actor, (await ctx.db.get(ids[i]!))!, item.queue);
      }
      await audit(ctx, actor, "task.plan_created", ids[0]!, { count: ids.length });
      return { tasks: args.tasks.map((item, i) => ({ ...(item.key !== undefined ? { key: item.key } : {}), taskId: ids[i]! })) };
    }),
});

/** How long a queued task's start may take before the room counts it as failed. */
const START_STUCK_MS = 60_000;

/** What one look at a machine's queue reads once: which needed tasks are closed, and the slots in use. */
type Pass = { closed: Map<Id<"tasks">, boolean>; slotsUsed: number | undefined };

async function needsClosed(ctx: MutationCtx, task: Doc<"tasks">, pass: Pass): Promise<boolean> {
  for (const id of task.needs ?? []) {
    let closed = pass.closed.get(id);
    if (closed === undefined) {
      const need = await ctx.db.get(id);
      // A task deleted since counts as closed.
      closed = !need || need.closedAt !== undefined;
      pass.closed.set(id, closed);
    }
    if (!closed) return false;
  }
  return true;
}

async function hasRoom(ctx: MutationCtx, actor: Actor, machine: Doc<"machines">, via: "terminal" | "thread", pass: Pass): Promise<boolean> {
  if (via === "thread" || belongsToMember(machine, actor)) return true;
  if (pass.slotsUsed === undefined) {
    const live = await ctx.db
      .query("terminals")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    pass.slotsUsed = live.filter((t) => isLive(t) && t.usesSlot).length;
  }
  return machine.slots - pass.slotsUsed > 0;
}

/**
 * Whether a queued row can start now, and as whom: its task open with every need closed, whoever
 * queued it still able to start it there, and the machine online, taking starts, with room.
 * `wait` keeps its place; `refused` waits with the reason on the task's card.
 */
async function readiness(
  ctx: MutationCtx,
  row: Doc<"taskQueue">,
  machine: Doc<"machines"> | null,
  now: number,
  pass: Pass = { closed: new Map(), slotsUsed: undefined },
): Promise<{ kind: "gone" } | { kind: "wait"; offline?: true } | { kind: "refused"; why: string } | { kind: "ready"; actor: Actor; task: Doc<"tasks"> }> {
  const task = await ctx.db.get(row.taskId);
  if (!task || task.closedAt !== undefined) return { kind: "gone" };
  if (!(await needsClosed(ctx, task, pass))) return { kind: "wait" };
  const actor = await queueActor(ctx, row);
  if (!actor) return { kind: "refused", why: "Whoever queued it can no longer start runs." };
  const why = await queueRefusal(ctx, actor, machine, task, row);
  if (why || !machine) return { kind: "refused", why: why ?? "The machine is gone." };
  // Only to a bridge that takes the start now: one waiting in an offline or stopping machine's
  // outbox would run later, without the room checking again who may start it.
  if (!isOnline(machine, now) || holdsQueue(await cloudFor(ctx, machine._id))) return { kind: "wait", offline: true };
  if (!(await hasRoom(ctx, actor, machine, row.via, pass))) return { kind: "wait" };
  return { kind: "ready", actor, task };
}

/** How many queued rows one look at a machine's queue reads before going on in a new transaction. */
const DISPATCH_PAGE = 100;

/**
 * Starts the oldest ready task in one machine's queue (ADR 0050), one at a time: it marks the row
 * starting and hands it to tasks.startQueued, whose success looks at the queue again. While a start
 * is under way, wherever its row is, it does nothing; a start still marked a minute later failed,
 * and its row is marked stuck and skipped, so it never blocks the rest. It reads the queue a page
 * at a time, going on from where it stopped in a new transaction, so a long queue of tasks that
 * aren't ready never keeps the ones behind them from starting.
 */
export const dispatchQueue = internalMutation({
  args: { machineId: v.id("machines"), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { machineId, cursor }) => {
    const now = Date.now();
    const underWay = await ctx.db
      .query("taskQueue")
      .withIndex("by_machine_starting", (q) => q.eq("machineId", machineId).gt("startingAt", 0))
      .take(10);
    let busy = false;
    for (const row of underWay) {
      if (now - row.startingAt! < START_STUCK_MS) busy = true;
      else {
        await ctx.db.patch(row._id, {
          startingAt: undefined,
          stuck: true,
          lastRefusal: "The room couldn't start it. Queue it again, or start a run by hand.",
        });
      }
    }
    if (busy) return null;
    const machine = await ctx.db.get(machineId);
    const page = await ctx.db
      .query("taskQueue")
      .withIndex("by_machine_queued", (q) => q.eq("machineId", machineId))
      .paginate({ numItems: DISPATCH_PAGE, cursor: cursor ?? null });
    const pass: Pass = { closed: new Map(), slotsUsed: undefined };
    for (const row of page.page) {
      if (row.stuck || row.startingAt !== undefined) continue;
      const ready = await readiness(ctx, row, machine, now, pass);
      if (ready.kind === "gone") {
        await ctx.db.delete(row._id);
        continue;
      }
      if (ready.kind === "refused") {
        if (row.lastRefusal !== ready.why) await ctx.db.patch(row._id, { lastRefusal: ready.why });
        continue;
      }
      if (row.lastRefusal !== undefined) await ctx.db.patch(row._id, { lastRefusal: undefined });
      if (ready.kind === "wait") {
        // A stopped cloud machine starts for its queue; it starts the task once its bridge is back.
        if (ready.offline) {
          await wakeForWork(ctx, machineId);
          return null;
        }
        continue;
      }
      await ctx.db.patch(row._id, { startingAt: now });
      await ctx.scheduler.runAfter(0, internal.tasks.startQueued, { queueId: row._id, startingAt: now });
      return null;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.dispatchQueue, { machineId, cursor: page.continueCursor });
    return null;
  },
});

/** Starts one queued task that tasks.dispatchQueue picked, after checking again that it still can. */
export const startQueued = internalMutation({
  args: { queueId: v.id("taskQueue"), startingAt: v.number() },
  handler: async (ctx, { queueId, startingAt }) => {
    const row = await ctx.db.get(queueId);
    if (!row || row.startingAt !== startingAt) return null;
    const machine = await ctx.db.get(row.machineId);
    const ready = await readiness(ctx, row, machine, Date.now());
    if (ready.kind !== "ready") {
      if (ready.kind === "gone") await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { startingAt: undefined, ...(ready.kind === "refused" ? { lastRefusal: ready.why } : {}) });
      await dispatchSoon(ctx, row.machineId);
      return null;
    }
    const { runId } = await startRun(ctx, ready.actor, {
      taskId: ready.task._id,
      machineId: row.machineId,
      harness: row.harness,
      via: row.via,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.repo ? { repo: row.repo } : {}),
      ...(row.prompt ? { prompt: row.prompt } : {}),
      ...(row.command !== undefined ? { command: row.command } : {}),
      ...(row.access ? { access: row.access } : {}),
      ...(row.runtimeMode ? { runtimeMode: row.runtimeMode } : {}),
    });
    await ctx.db.delete(row._id);
    await audit(ctx, ready.actor, "task.queue_started", ready.task._id, { runId, machineId: row.machineId });
    await dispatchSoon(ctx, row.machineId);
    return null;
  },
});

/** At most this many queued rows are read per page when looking for machines with a queue. */
const MACHINE_PAGE = 500;

/** Looks at the queues of a team's machines, such as after a task closed and others waited for it. */
export const dispatchTeam = internalMutation({
  args: { teamId: v.id("teams"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { teamId, cursor }) => {
    const page = await ctx.db
      .query("taskQueue")
      .withIndex("by_team_queued", (q) => q.eq("teamId", teamId))
      .paginate({ numItems: MACHINE_PAGE, cursor });
    for (const machineId of new Set(page.page.map((r) => r.machineId))) await dispatchSoon(ctx, machineId);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.dispatchTeam, { teamId, cursor: page.continueCursor });
    return null;
  },
});

/** Each minute: every machine with a queue looks at it, so a slot freed or a machine back online is noticed. */
export const dispatchAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("taskQueue")
      .withIndex("by_queued")
      .paginate({ numItems: MACHINE_PAGE, cursor: cursor ?? null });
    for (const machineId of new Set(page.page.map((r) => r.machineId))) await dispatchSoon(ctx, machineId);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.dispatchAll, { cursor: page.continueCursor });
    return null;
  },
});

/** Hourly: idempotency keys past their day (lib/idempotency.ts). */
export const pruneIdempotentWrites = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (await pruneKeys(ctx)) await ctx.scheduler.runAfter(0, internal.tasks.pruneIdempotentWrites, {});
    return null;
  },
});

// ---------- pull requests (ADR 0051) ----------

/** The most pull requests one task links. */
export const MAX_TASK_PULLS = 10;

export const { person: linkPullRequest, agent: linkPullRequestAgent } = roomMutation({
  name: "tasks.linkPullRequest",
  description: `Link a GitHub pull request to a task (ADR 0051), in a repo the team connected (github.repos): the task then shows its state (open, draft, merged or closed), its review decision and its head commit's checks, kept up to date by GitHub's webhooks, in tasks.get and tasks.board pullRequests. At most ${MAX_TASK_PULLS} per task. Linking one already linked returns it. Returns pullRequestId.`,
  scope: "work.manage",
  args: { taskId: v.id("tasks"), pullRequest: v.string() },
  argDocs: { pullRequest: "owner/name#123, or the pull request's github.com URL" },
  handler: async (ctx, actor, args) => {
    const task = await inTeam(ctx, actor, args.taskId);
    const ref = parsePullRef(args.pullRequest);
    if (!ref) throw roomError("invalid", "Name the pull request as owner/name#123, or give its github.com URL.");
    const key = repoKey(ref.repo);
    const repo = await ctx.db
      .query("githubRepos")
      .withIndex("by_team_key", (q) => q.eq("teamId", actor.teamId).eq("key", key))
      .first();
    const account = repo ? await ctx.db.get(repo.githubAccountId) : null;
    if (!repo || !account || account.removedAt !== undefined) {
      throw roomError("invalid", `${ref.repo} isn't one of the team's connected GitHub repos (github.repos). Connect its account in Settings, GitHub.`);
    }
    const linked = await ctx.db
      .query("taskPullRequests")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(MAX_TASK_PULLS + 1);
    // By GitHub's id for the repo, so a link by the repo's old name and one by its new name are the same.
    const same = linked.find((r) => r.repoGithubId === repo.githubId && r.number === ref.number);
    if (same) return { pullRequestId: same._id };
    if (linked.length >= MAX_TASK_PULLS) throw roomError("invalid", `A task links at most ${MAX_TASK_PULLS} pull requests.`);
    const pullRequestId = await ctx.db.insert("taskPullRequests", {
      teamId: actor.teamId,
      taskId: task._id,
      repoGithubId: repo.githubId,
      repo: repo.fullName,
      number: ref.number,
      installationId: account.installationId,
      linkedBy: actor.member._id,
      updatedAt: 0,
    });
    await ctx.scheduler.runAfter(0, internal.githubSync.readPullRequest, { pullRequestId });
    await audit(ctx, actor, "task.pull_request_linked", task._id, { repo: repo.fullName, number: ref.number });
    return { pullRequestId };
  },
});

export const { person: unlinkPullRequest, agent: unlinkPullRequestAgent } = roomMutation({
  name: "tasks.unlinkPullRequest",
  description: "Unlink a pull request from a task.",
  scope: "work.manage",
  args: { pullRequestId: v.id("taskPullRequests") },
  handler: async (ctx, actor, args) => {
    const row = await ctx.db.get(args.pullRequestId);
    if (!row || row.teamId !== actor.teamId) throw roomError("not_found", "No such linked pull request.");
    const task = await inTeam(ctx, actor, row.taskId);
    await ctx.db.delete(row._id);
    await audit(ctx, actor, "task.pull_request_unlinked", task._id, { repo: row.repo, number: row.number });
    return null;
  },
});
