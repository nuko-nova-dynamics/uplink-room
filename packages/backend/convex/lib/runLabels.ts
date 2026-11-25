/**
 * Live runs as addresses (ADR 0026, ADR 0029): which runs are live, what each is called, and who
 * may address one where.
 *
 * A run is named by its harness and its driver, such as Claude Code (Julio). When one driver has
 * two or more live runs of one harness, the later ones are numbered by start order: Claude Code 2
 * (Julio). Names are worked out from the live runs each time, so when the first ends the second
 * becomes Claude Code (Julio); a message a run posted keeps the name it had then (`asRun.label`).
 *
 * A live run is a run with a driver, not sent to an A2A agent (that agent is a member, mentioned as
 * one), that is either in a terminal still starting or live (and not Stopped or Failed), or in a
 * T3 Code thread that isn't Stopped and is still going: working, waiting or unknown, or between
 * turns (Done or Failed) while T3 Code still lists the thread (`threadOpen`). A thread lasts until
 * it is stopped, T3 Code archives or deletes it, or its machine is unlinked, whatever its turn
 * does. A joined run (ADR 0027, ADR 0032) is live until it ends (`endedAt`), which the room writes
 * when it leaves or its heartbeat stops (lib/joinedRuns.ts); while live it shows Unknown.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Actor } from "./actor";
import { canSeeId, directRunIds, hasMemberList, isDirect, memberCanSee, memberIdsOf, runOutsideChannels, whereLabel } from "./channels";
import { harnessName } from "./harnesses";
import { runTokens } from "./messages";
import { isLive } from "./terminals";

/** At most this many live terminals, thread runs per state, and open threads are read for a team's live runs. */
export const LIVE_SCAN = 500;

const LIVE_THREAD_STATES = ["working", "waiting", "unknown"] as const;

export type Hears = "anyone" | "driver";

export function hearsOf(run: Pick<Doc<"runs">, "hears">): Hears {
  return run.hears ?? "anyone";
}

/** The token that addresses a run in a message body. */
export function runToken(runId: Id<"runs">): string {
  return `<@run:${runId}>`;
}

/** Whether a run is live, so it can be addressed. */
export async function isLiveRun(ctx: QueryCtx, run: Doc<"runs">): Promise<boolean> {
  if (run.harness === "a2a" || run.agentId || !run.driverId) return false;
  // Ended, or Stopped from the room: the room wrote it, so no clock is read here.
  if (run.joinedSessionId) return run.endedAt === undefined && run.state !== "stopped";
  if (run.terminalId) {
    // Stopped from the room: over, though the bridge may not have ended its terminal yet. Done and
    // Failed aren't: Claude Code reports Done between turns, and Failed for a turn that ended in an
    // API error (StopFailure), while its terminal stays open for the next prompt. A run that ends
    // with its terminal is over through the terminal.
    if (run.state === "stopped") return false;
    const terminal = await ctx.db.get(run.terminalId);
    return terminal !== null && isLive(terminal);
  }
  if (run.threadRef !== undefined) {
    if (run.state === "stopped") return false;
    // Done or Failed is how T3 Code reports a turn that ended; the thread still takes messages.
    return run.threadOpen === true || (LIVE_THREAD_STATES as readonly string[]).includes(run.state);
  }
  return false;
}

/** The team's live runs, oldest first. */
export async function liveRunsOf(ctx: QueryCtx, teamId: Id<"teams">): Promise<Doc<"runs">[]> {
  const found = new Map<Id<"runs">, Doc<"runs">>();
  for (const status of ["starting", "live"] as const) {
    const terminals = await ctx.db
      .query("terminals")
      .withIndex("by_team_status", (q) => q.eq("teamId", teamId).eq("status", status))
      .take(LIVE_SCAN);
    for (const terminal of terminals) {
      if (!terminal.runId || found.has(terminal.runId)) continue;
      const run = await ctx.db.get(terminal.runId);
      if (run && run.teamId === teamId && run.terminalId === terminal._id && (await isLiveRun(ctx, run))) found.set(run._id, run);
    }
  }
  for (const state of LIVE_THREAD_STATES) {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_team_state", (q) => q.eq("teamId", teamId).eq("state", state))
      .order("desc")
      .take(LIVE_SCAN);
    for (const run of runs) {
      // Thread runs, and joined runs, which stay Unknown while live.
      if (run.terminalId || (run.threadRef === undefined && run.joinedSessionId === undefined) || found.has(run._id)) continue;
      if (await isLiveRun(ctx, run)) found.set(run._id, run);
    }
  }
  const open = await ctx.db
    .query("runs")
    .withIndex("by_team_thread_open", (q) => q.eq("teamId", teamId).eq("threadOpen", true))
    .order("desc")
    .take(LIVE_SCAN);
  for (const run of open) {
    if (run.terminalId || run.threadRef === undefined || found.has(run._id)) continue;
    if (await isLiveRun(ctx, run)) found.set(run._id, run);
  }
  return [...found.values()].sort((a, b) => a._creationTime - b._creationTime);
}

async function baseLabel(ctx: QueryCtx, run: Doc<"runs">, number = 1): Promise<string> {
  const driver = run.driverId ? await ctx.db.get(run.driverId) : null;
  const who = driver ? driver.name : "nobody driving";
  return `${harnessName(run.harness)}${number > 1 ? ` ${number}` : ""} (${who})`;
}

/** Each live run's name, numbered per driver and harness by start order. `live` is oldest first. */
export async function labelsOf(ctx: QueryCtx, live: Doc<"runs">[]): Promise<Map<Id<"runs">, string>> {
  const counts = new Map<string, number>();
  const labels = new Map<Id<"runs">, string>();
  for (const run of live) {
    const key = `${run.driverId}:${run.harness}`;
    const number = (counts.get(key) ?? 0) + 1;
    counts.set(key, number);
    labels.set(run._id, await baseLabel(ctx, run, number));
  }
  return labels;
}

/** At most this many of a driver's newest runs are read to number one of them. */
export const DRIVER_SCAN = 100;

/**
 * One run's name, numbered among its driver's live runs of its harness, from the driver's newest
 * runs: a message view naming a run then depends on that driver's runs, not the whole team's. Past
 * DRIVER_SCAN of them it reads the team's live runs instead, as runs.live does.
 * An ended run is named by its harness and last driver, unnumbered.
 */
export async function runLabel(ctx: QueryCtx, run: Doc<"runs">): Promise<string> {
  if (!run.driverId || !(await isLiveRun(ctx, run))) return baseLabel(ctx, run);
  const driverId = run.driverId;
  const newest = await ctx.db
    .query("runs")
    .withIndex("by_driver", (q) => q.eq("driverId", driverId))
    .order("desc")
    .take(DRIVER_SCAN);
  // A driver with more runs than the scan holds may have an older live run outside it: number this
  // one the way runs.live does, from the team's live runs, so the two never disagree.
  if (newest.length >= DRIVER_SCAN) {
    return (await labelsOf(ctx, await liveRunsOf(ctx, run.teamId))).get(run._id) ?? baseLabel(ctx, run);
  }
  let number = 1;
  for (const other of newest) {
    if (other._id === run._id || other.harness !== run.harness || other.teamId !== run.teamId) continue;
    if (other._creationTime < run._creationTime && (await isLiveRun(ctx, other))) number++;
  }
  return baseLabel(ctx, run, number);
}

/** Names runs, each once per query. */
export function runNamer(ctx: QueryCtx) {
  const named = new Map<Id<"runs">, Promise<string>>();
  return (run: Doc<"runs">): Promise<string> => {
    let label = named.get(run._id);
    if (!label) named.set(run._id, (label = runLabel(ctx, run)));
    return label;
  };
}

export type RunNamer = ReturnType<typeof runNamer>;

/** The person who answers for a run: its driver, or the person accountable for an agent driver. */
export async function runPerson(ctx: QueryCtx, run: Doc<"runs">): Promise<Doc<"members"> | null> {
  const driver = run.driverId ? await ctx.db.get(run.driverId) : null;
  if (!driver || driver.kind !== "agent" || !driver.agentId) return driver;
  const agent = await ctx.db.get(driver.agentId);
  return agent ? await ctx.db.get(agent.addedBy) : null;
}

/** Whether the run's driver, and for an agent driver the person accountable for it, are still in the team. */
async function stillInTeam(ctx: QueryCtx, run: Doc<"runs">): Promise<boolean> {
  const driver = run.driverId ? await ctx.db.get(run.driverId) : null;
  if (!driver || driver.removedAt !== undefined) return false;
  if (driver.kind !== "agent") return true;
  const person = await runPerson(ctx, run);
  return person !== null && person.removedAt === undefined;
}

/**
 * Whether a run hears this sender (`runs.setHears`): with `driver`, only the run's person and their
 * agents. A message from anyone else is still recorded as addressed to it; it isn't delivered.
 */
export async function hearsFrom(ctx: QueryCtx, run: Doc<"runs">, sender: Pick<Actor, "member" | "accountable">): Promise<boolean> {
  if (hearsOf(run) === "anyone" && run.closed !== true) return true;
  return isRunsPerson(ctx, run, sender);
}

/** Whether this actor is the run's person (its driver, or the person accountable for an agent driver) or one of their agents. */
async function isRunsPerson(ctx: QueryCtx, run: Doc<"runs">, actor: Pick<Actor, "member" | "accountable">): Promise<boolean> {
  const person = await runPerson(ctx, run);
  return person !== null && (actor.accountable?._id ?? actor.member._id) === person._id;
}

/**
 * Whether this actor may know the run exists (ADR 0044): any open run, and a closed one only for its
 * person and their agents. For everyone else in the team a closed run isn't there at all: it isn't
 * listed, read, counted or addressed, and a call that names it gets not_found.
 */
export async function seesRun(
  ctx: QueryCtx,
  run: Doc<"runs">,
  actor: Pick<Actor, "member" | "accountable" | "channelIds">,
): Promise<boolean> {
  if (run.closed === true && !(await isRunsPerson(ctx, run, actor))) return false;
  // Nor is a run outside a channel-limited key's channels (ADR 0049).
  return !(await runOutsideChannels(ctx, actor, run));
}

/**
 * Whether a direct message was opened with this run (ADR 0029 D4) and the run's person is still in
 * it: its person, not an agent driver, is the member there. A run whose wheel has passed to someone
 * outside the direct message isn't, so nothing said there reaches them.
 */
async function openedWith(ctx: QueryCtx, channel: Doc<"channels">, run: Doc<"runs">): Promise<boolean> {
  if (!(await directRunIds(ctx, channel)).includes(run._id)) return false;
  const person = await runPerson(ctx, run);
  return person !== null && (await memberCanSee(ctx, channel, person._id));
}

/**
 * Whether the run's driver now reads this channel, so its run may hear what is said there: anyone in
 * a team channel; a member of a private channel or direct message, or the run's person in a direct
 * message opened with the run (ADR 0016, ADR 0029 D4).
 */
export async function driverReads(ctx: QueryCtx, run: Doc<"runs">, channel: Doc<"channels">): Promise<boolean> {
  // A driver who left the team, or an agent whose person did, reads nothing here, though its
  // terminal may still be open: members.remove doesn't end it.
  if (run.driverId && !(await stillInTeam(ctx, run))) return false;
  if (!hasMemberList(channel)) return true;
  if (!run.driverId) return false;
  return (await memberCanSee(ctx, channel, run.driverId)) || (await openedWith(ctx, channel, run));
}

/**
 * Whether what the run hears from this channel stays among the channel's members (ADR 0039). A run
 * shows what it hears to everyone who can see its output: a thread's view shows a delivery as the
 * user's message, and Claude Code shows its hooks' context on the terminal's screen. So a message
 * from a direct message or private channel reaches a run only when everyone who can see the run's
 * output, now and later, is a member there: the run came from that place, or from a direct message
 * (whose members never grow) whose members are all in it. A team run is visible to the whole team,
 * and a run from another private channel to anyone its members add, so neither hears it. Anything
 * said in a team channel the whole team can read anyway.
 */
export async function outputStaysIn(ctx: QueryCtx, run: Doc<"runs">, channel: Doc<"channels">): Promise<boolean> {
  if (!hasMemberList(channel)) return true;
  if (!run.directChannelId) return false;
  if (run.directChannelId === channel._id) return true;
  const from = await ctx.db.get(run.directChannelId);
  if (!from || !isDirect(from)) return false;
  for (const memberId of await memberIdsOf(ctx, from)) if (!(await memberCanSee(ctx, channel, memberId))) return false;
  return true;
}

/**
 * Whether a message said in this channel may reach the run (ADR 0039, amended 2026-11-05): when
 * what the run hears stays among the channel's members, or the channel is a direct message opened
 * with this run (ADR 0029 D4). There the sender chose to message the run and the direct message
 * says whose output it is (`outputWarning`), so it hears every message even though more people
 * can see its output. A private channel, or a direct message the run wasn't opened with, keeps
 * the strict rule.
 */
export async function hearsIn(ctx: QueryCtx, run: Doc<"runs">, channel: Doc<"channels">): Promise<boolean> {
  return (await outputStaysIn(ctx, run, channel)) || (await directRunIds(ctx, channel)).includes(run._id);
}

/**
 * What a direct message opened with this run says about it, when people outside the direct
 * message can see the run's output, and who they are (`seenBy`): the whole team for a team run, or
 * people outside it for a run from another private place (whose name stays out of it). Undefined when its output stays among the
 * direct message's members, or the run isn't one it was opened with.
 */
export async function outputWarning(
  ctx: QueryCtx,
  run: Doc<"runs">,
  channel: Doc<"channels">,
  label: string,
): Promise<{ warning: string; seenBy: "team" | "outside" } | undefined> {
  if (!(await directRunIds(ctx, channel)).includes(run._id) || (await outputStaysIn(ctx, run, channel))) return undefined;
  const seenBy = run.directChannelId ? ("outside" as const) : ("team" as const);
  const who = seenBy === "team" ? "the whole team" : "people outside this direct message";
  return { warning: `${label}'s output is visible to ${who}, so what you send here won't stay private.`, seenBy };
}

/** The line a place gets when a message there can't reach a run whose output people outside it see. */
export function visibleOutsideLine(label: string, channel: Doc<"channels">): string {
  return `${label} is visible to people outside ${whereLabel(channel)}, so it can't hear messages from here.`;
}

/**
 * Why this actor can't address this run in this channel, or undefined when they can. A run from a
 * direct message or private channel is acted on only by that channel's members (ADR 0016). In a
 * direct message or private channel, the run's driver must be a member, or its messages there
 * would reach someone outside it; a direct message opened with the run needs its person instead.
 */
export async function addressRefusal(
  ctx: QueryCtx,
  actor: Actor,
  run: Doc<"runs">,
  channel: Doc<"channels">,
): Promise<{ code: "not_found" | "invalid" | "forbidden"; message: string } | undefined> {
  if (run.teamId !== actor.teamId || !(await seesRun(ctx, run, actor)))
    return { code: "not_found", message: "Not found in this team." };
  if (!(await isLiveRun(ctx, run))) {
    return { code: "invalid", message: "That run isn't live, so it can't be messaged. runs.live lists the runs that are." };
  }
  if (run.directChannelId && !(await canSeeId(ctx, actor, run.directChannelId))) {
    return { code: "forbidden", message: "That run came from a private conversation you aren't in, so only its members can message it." };
  }
  if (!(await driverReads(ctx, run, channel))) {
    const driver = await ctx.db.get(run.driverId!);
    return {
      code: "invalid",
      message: `That run's driver, ${driver?.name ?? "someone"}, isn't in ${whereLabel(channel)}, so the run can't be messaged in it.`,
    };
  }
  return undefined;
}

/** The names of the runs a body addresses with `<@run:runId>`, for text with names in it. */
export async function runNamesIn(ctx: QueryCtx, teamId: Id<"teams">, body: string, name: RunNamer, into: Map<string, string>) {
  for (const token of runTokens(body)) {
    const id = ctx.db.normalizeId("runs", token);
    const run = id ? await ctx.db.get(id) : null;
    if (run && run.teamId === teamId) into.set(token, await name(run));
  }
}
