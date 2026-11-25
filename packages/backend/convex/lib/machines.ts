import { accessRank, minAccess, type Access } from "@uplink-room/protocol";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actsFor, requireAdmin, type Actor } from "./actor";
import { roomError } from "./errors";
import { audit, memberView } from "./members";
import { sendToBridge } from "./outbox";
import { liveTerminalsOn } from "./terminals";
import { bridgeHandles, isThreadRun, threadIsOpen, type ThreadRun } from "./threads";
import { memberCanSee } from "./channels";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A bridge that hasn't been heard from in this long shows as offline. */
export const ONLINE_WINDOW_MS = 90 * 1000;

/** Personal machines start at Suggest, team machines at Drive (DESIGN.md). */
export function defaultSettings(team: boolean) {
  return {
    mostOpenAccess: (team ? "drive" : "suggest") as Access,
    slots: 2,
    longestProfileMs: 7 * DAY_MS,
  };
}

/**
 * Team machines can be changed only by admins; personal machines only by the
 * person they belong to (or that person's agent).
 */
export async function requireMachineControl(ctx: QueryCtx, actor: Actor, machine: Doc<"machines">) {
  if (machine.belongsTo.kind === "team") {
    requireAdmin(actor);
    return;
  }
  if (!actsFor(actor, machine.belongsTo.memberId)) {
    const owner = await memberView(ctx, machine.belongsTo.memberId);
    throw roomError("forbidden", `This machine belongs to ${owner.name}; only they can change it.`);
  }
}

/**
 * True when the actor is the person the machine belongs to, so their terminal
 * uses no slot. An agent uses a slot even on its person's machine: the bridge
 * decides slot use from who started the terminal and can't verify who an
 * agent belongs to, so the room counts the same way.
 */
export function belongsToMember(machine: Doc<"machines">, actor: Actor): boolean {
  return machine.belongsTo.kind === "person" && actor.member._id === machine.belongsTo.memberId;
}

/** The person a personal machine belongs to; undefined for a team machine. */
export function personOf(machine: Doc<"machines">): Id<"members"> | undefined {
  return machine.belongsTo.kind === "person" ? machine.belongsTo.memberId : undefined;
}

/**
 * True when only the person a machine belongs to, and that person's agents, may start work on it
 * and drive there: a personal machine whose most open access is Watch or Suggest. Teammates and
 * their agents start runs on a personal machine only at Drive or Open. A team machine belongs to
 * the whole team, so anyone on it starts runs there at any level (ADR 0025).
 */
export function ownerRunsOnly(machine: Doc<"machines">): boolean {
  return machine.belongsTo.kind === "person" && accessRank(machine.mostOpenAccess) < accessRank("drive");
}

/** What the room says to someone it won't let start work on a machine that takes runs only from its person. */
export function ownerRunsOnlyText(machineName: string, personName: string, access: Access): string {
  const first = personName.split(" ")[0] || personName;
  const can = access === "watch" ? "watch terminals" : "watch or suggest in terminals";
  return `${machineName} takes runs only from ${personName}. Teammates can ${can} ${first} shares. To run there, ask ${first} to set it to Drive or Open, or pick another machine.`;
}

/** Whether a private channel or direct message keeps out the person a machine belongs to (ADR 0016). */
async function channelHides(ctx: QueryCtx, channelId: Id<"channels">, person: Id<"members">): Promise<boolean> {
  const channel = await ctx.db.get(channelId);
  return !!channel && !(await memberCanSee(ctx, channel, person));
}

/** Whether a run came from a private channel or direct message the person isn't in. */
async function runHides(ctx: QueryCtx, runId: Id<"runs"> | undefined, person: Id<"members">): Promise<boolean> {
  const run = runId ? await ctx.db.get(runId) : null;
  return !!run?.directChannelId && (await channelHides(ctx, run.directChannelId, person));
}

/**
 * Refuses a terminal, thread or Rex tab on a machine that takes runs only from the person it
 * belongs to, unless the actor is that person or one of their agents (ADR 0025). Their agent is
 * refused too for work from a private channel or direct message the person isn't in (`channelId`):
 * nobody may drive that there (`mayDriveThere`).
 */
export async function requireMayStart(
  ctx: QueryCtx,
  actor: Actor,
  machine: Doc<"machines">,
  channelId?: Id<"channels">,
): Promise<void> {
  const person = personOf(machine);
  if (!person || !ownerRunsOnly(machine)) return;
  if (!actsFor(actor, person)) {
    const owner = await memberView(ctx, person);
    throw roomError("forbidden", ownerRunsOnlyText(machine.name, owner.name, machine.mostOpenAccess));
  }
  if (channelId && (await channelHides(ctx, channelId, person))) {
    throw roomError("forbidden", await privateRunText(ctx, machine, person));
  }
}

/** True when the member is this person, or an agent this person added (and so answers for). */
export async function memberActsFor(ctx: QueryCtx, memberId: Id<"members">, personId: Id<"members">): Promise<boolean> {
  if (memberId === personId) return true;
  const member = await ctx.db.get(memberId);
  if (!member?.agentId) return false;
  const agent = await ctx.db.get(member.agentId);
  return agent?.addedBy === personId;
}

/**
 * Whether a member may drive a terminal or thread from this run on this machine. On a machine that
 * takes runs only from its person, that's the person and their agents, except on a run from a
 * private channel or direct message the person isn't in: nobody drives that there, their agents
 * included (ADR 0016, ADR 0025). Anywhere else anyone may, as the run's access allows.
 */
export async function mayDriveThere(
  ctx: QueryCtx,
  machine: Doc<"machines">,
  runId: Id<"runs"> | undefined,
  memberId: Id<"members">,
): Promise<boolean> {
  const person = personOf(machine);
  if (!person || !ownerRunsOnly(machine)) return true;
  if (!(await memberActsFor(ctx, memberId, person))) return false;
  return !(await runHides(ctx, runId, person));
}

/**
 * On a machine that takes runs only from the person it belongs to, who may be made the driver of a
 * terminal or thread there: that person, and whoever started it only when that's an agent of theirs,
 * as the bridge takes them below Drive; and only where they may drive (`mayDriveThere`). A teammate
 * who started it can't take it back (ADR 0025).
 */
export async function mayBeHandedWheel(
  ctx: QueryCtx,
  machine: Doc<"machines">,
  holder: { runId?: Id<"runs">; startedBy?: Id<"members"> },
  memberId: Id<"members">,
): Promise<boolean> {
  const person = personOf(machine);
  if (!person || (memberId !== person && memberId !== holder.startedBy)) return false;
  return await mayDriveThere(ctx, machine, holder.runId, memberId);
}

/**
 * Who drives a run from a private channel or direct message on a machine that takes runs only from
 * its person, once `leaving` is out of that channel (ADR 0016, ADR 0025): whoever started it, else
 * the person, the first still in the channel who may be handed the wheel there. Otherwise nobody.
 */
export async function nextDriverThere(
  ctx: QueryCtx,
  machine: Doc<"machines">,
  channelId: Id<"channels">,
  leaving: Id<"members">,
  holder: { runId: Id<"runs">; startedBy?: Id<"members"> },
): Promise<Id<"members"> | undefined> {
  const channel = await ctx.db.get(channelId);
  if (!channel) return undefined;
  for (const id of [holder.startedBy, personOf(machine)]) {
    if (!id || id === leaving) continue;
    const member = await ctx.db.get(id);
    if (!member || member.removedAt !== undefined || !(await memberCanSee(ctx, channel, id))) continue;
    if (await mayBeHandedWheel(ctx, machine, holder, id)) return id;
  }
  return undefined;
}

/** Why the wheel on a machine that takes runs only from its person can't go to someone. */
export async function personDrivesText(ctx: QueryCtx, machine: Doc<"machines">, what: string): Promise<string> {
  const person = personOf(machine);
  const name = person ? (await memberView(ctx, person)).name : "whoever it belongs to";
  return `${machine.name} is set to ${machine.mostOpenAccess}, so only ${name} drives there. Teammates can't ${what} until it's set to drive or open.`;
}

async function privateRunText(ctx: QueryCtx, machine: Doc<"machines">, person: Id<"members">): Promise<string> {
  const { name } = await memberView(ctx, person);
  return `${machine.name} is set to ${machine.mostOpenAccess}, so nobody drives a run there from a private channel or direct message ${name} isn't in.`;
}

/**
 * Whether the actor, driving, may still drive on this machine (`mayDriveThere`). The person passes
 * at once: `inTeam` already showed they can see the run's channel.
 */
export async function actorMayDriveThere(
  ctx: QueryCtx,
  actor: Actor,
  machine: Doc<"machines"> | null,
  runId: Id<"runs"> | undefined,
): Promise<boolean> {
  const person = machine ? personOf(machine) : undefined;
  if (!machine || !person || !ownerRunsOnly(machine) || actor.member._id === person) return true;
  return await mayDriveThere(ctx, machine, runId, actor.member._id);
}

/**
 * Refuses what only a driver does (typing, resizing, a thread's messages, answering a wheel request)
 * when the actor drives on a machine that takes runs only from its person but may not drive there:
 * a teammate's wheel from before ADR 0025, say.
 */
export async function requireMayDriveThere(
  ctx: QueryCtx,
  actor: Actor,
  machine: Doc<"machines"> | null,
  runId: Id<"runs"> | undefined,
): Promise<void> {
  if (!machine || (await actorMayDriveThere(ctx, actor, machine, runId))) return;
  const person = personOf(machine)!;
  throw roomError(
    "forbidden",
    (await memberActsFor(ctx, actor.member._id, person))
      ? await privateRunText(ctx, machine, person)
      : await personDrivesText(ctx, machine, "drive its terminals or threads"),
  );
}

/**
 * Makes the machine's person the driver of a live terminal, or leaves it with nobody driving
 * (`next` undefined), and tells the bridge. Its pending wheel requests go: below Drive nobody else
 * may ask for the wheel (ADR 0025).
 */
export async function handTerminal(
  ctx: MutationCtx,
  terminal: Doc<"terminals">,
  next: Doc<"members"> | undefined,
  actor: Actor | undefined,
  reason: "machine_limit" | "left_channel",
): Promise<void> {
  await ctx.db.patch(terminal._id, { driverId: next?._id, responder: undefined });
  if (terminal.runId) await ctx.db.patch(terminal.runId, { driverId: next?._id });
  const requests = await ctx.db
    .query("wheelRequests")
    .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
    .collect();
  for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  await sendToBridge(ctx, terminal.machineId, {
    v: 1,
    type: "driver_changed",
    terminalId: terminal._id,
    ...(next ? { driver: { memberId: next._id, name: next.name } } : {}),
  });
  if (actor) await audit(ctx, actor, "terminal.driver_changed", terminal._id, { from: terminal.driverId, to: next?._id, reason });
}

/** The same for an open T3 Code thread, through a bridge that takes a thread's new driver. */
export async function handThread(
  ctx: MutationCtx,
  run: ThreadRun,
  next: Doc<"members"> | undefined,
  actor: Actor | undefined,
  reason: "machine_limit" | "left_channel",
): Promise<void> {
  await ctx.db.patch(run._id, { driverId: next?._id });
  const requests = await ctx.db
    .query("threadWheelRequests")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .collect();
  for (const r of requests) if (r.status === "pending") await ctx.db.patch(r._id, { status: "cancelled" });
  await sendToBridge(ctx, run.machineId, {
    v: 1,
    type: "thread_driver_changed",
    threadRef: run.threadRef,
    ...(next ? { driver: { memberId: next._id, name: next.name } } : {}),
    ...(run.startedBy ? { starterId: run.startedBy } : {}),
  });
  if (actor) await audit(ctx, actor, "thread.driver_changed", run._id, { from: run.driverId, to: next?._id, reason });
}

/**
 * A personal machine now takes runs only from the person it belongs to: that person becomes the
 * driver of every live terminal there that someone else drives (a teammate's run, a Rex run, or
 * their own terminal they passed to a teammate), and of every open T3 Code thread there that someone
 * else drives, so its approvals and messages are theirs to answer. An agent of theirs keeps what it
 * drives. A run from a private channel or direct message they aren't in is left with nobody driving,
 * their agent's included. The work keeps running; nothing is stopped (ADR 0025).
 *
 * Call it before lowering the terminals' and threads' access: a bridge whose terminal or thread is
 * still at Drive or Open takes the new driver even if it is older than this rule. It changes nothing
 * the second time, so the bridge's register, limits report and features each call it again.
 */
export async function handWheelsToOwner(
  ctx: MutationCtx,
  machine: Doc<"machines">,
  actor?: Actor,
  /**
   * From the bridge's features: tell it again who drives each thread the room already gave the
   * person. An older bridge may have refused that handoff and, upgraded, restored the teammate.
   */
  restate = false,
): Promise<void> {
  const person = personOf(machine);
  if (!person || !ownerRunsOnly(machine)) return;
  const owner = await ctx.db.get(person);
  if (!owner) return;
  // The private channel's rule comes first: it holds for the person's agents too (ADR 0016).
  const wheelFor = async (driverId: Id<"members"> | undefined, runId: Id<"runs"> | undefined) => {
    if (await runHides(ctx, runId, person)) return driverId ? { next: undefined } : null;
    if (driverId && (await memberActsFor(ctx, driverId, person))) return null;
    return { next: owner };
  };
  for (const terminal of await liveTerminalsOn(ctx, machine._id)) {
    const change = await wheelFor(terminal.driverId, terminal.runId);
    if (change) await handTerminal(ctx, terminal, change.next, actor, "machine_limit");
  }
  // Threads the same way, through a bridge that takes a thread's new driver (`thread_driver`,
  // ADR 0021). An older bridge would keep the first driver and refuse the person's answers, so
  // there the thread keeps its driver, as when someone leaves a private channel.
  if (!bridgeHandles(machine, "thread_driver")) return;
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_machine_thread", (q) => q.eq("machineId", machine._id))
    .collect();
  for (const run of runs) {
    if (!isThreadRun(run) || !threadIsOpen(run)) continue;
    const change = await wheelFor(run.driverId, run._id);
    if (change) await handThread(ctx, run, change.next, actor, "machine_limit");
    else if (restate && run.driverId) {
      const driver = await ctx.db.get(run.driverId);
      if (driver) {
        await sendToBridge(ctx, run.machineId, {
          v: 1,
          type: "thread_driver_changed",
          threadRef: run.threadRef,
          driver: { memberId: driver._id, name: driver.name },
          ...(run.startedBy ? { starterId: run.startedBy } : {}),
        });
      }
    }
  }
}

/** Settings capped at the machine's own limits. */
export function capToLimits(
  settings: { mostOpenAccess: Access; slots: number; longestProfileMs: number },
  limits: Doc<"machines">["limits"],
) {
  if (!limits) return settings;
  return {
    mostOpenAccess: minAccess(settings.mostOpenAccess, limits.mostOpenAccess),
    slots: Math.min(settings.slots, limits.slots),
    longestProfileMs: Math.min(settings.longestProfileMs, limits.longestProfileMs),
  };
}

export function exceedsLimits(
  settings: { mostOpenAccess?: Access; slots?: number; longestProfileMs?: number },
  limits: Doc<"machines">["limits"],
): string | null {
  if (!limits) return null;
  if (settings.mostOpenAccess && accessRank(settings.mostOpenAccess) > accessRank(limits.mostOpenAccess)) {
    return `The machine itself allows at most ${limits.mostOpenAccess}.`;
  }
  if (settings.slots !== undefined && settings.slots > limits.slots) {
    return `The machine itself allows at most ${limits.slots} slots.`;
  }
  if (settings.longestProfileMs !== undefined && settings.longestProfileMs > limits.longestProfileMs) {
    return "The machine itself keeps profiles for less time than that.";
  }
  return null;
}

/**
 * Online while the bridge was heard from within the window. `offlineSince` is
 * what makes a subscribed machine list change when a bridge goes quiet: Convex
 * re-runs a query only when data it read changes, never because time passed.
 */
export function isOnline(machine: Doc<"machines">, now: number): boolean {
  return (
    machine.lastSeenAt !== undefined &&
    machine.offlineSince === undefined &&
    now - machine.lastSeenAt < ONLINE_WINDOW_MS
  );
}

/**
 * Records that the machine's bridge was heard from, and makes sure one check is
 * pending to mark it offline if it then goes quiet.
 */
export async function markSeen(ctx: MutationCtx, machineId: Id<"machines">): Promise<void> {
  await ctx.db.patch(machineId, { lastSeenAt: Date.now(), offlineSince: undefined });
  const machine = await ctx.db.get(machineId);
  if (!machine) return;
  if (machine.onlineCheckId) {
    const job = await ctx.db.system.get("_scheduled_functions", machine.onlineCheckId);
    if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) return;
  }
  await scheduleOnlineCheck(ctx, machine);
}

/** Schedules the check for when the machine's online window ends. */
export async function scheduleOnlineCheck(ctx: MutationCtx, machine: Doc<"machines">): Promise<void> {
  const at = (machine.lastSeenAt ?? Date.now()) + ONLINE_WINDOW_MS;
  const onlineCheckId = await ctx.scheduler.runAt(at, internal.machines.checkOnline, { machineId: machine._id });
  await ctx.db.patch(machine._id, { onlineCheckId });
}
