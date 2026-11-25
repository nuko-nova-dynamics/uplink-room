import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { accessRank, vAccess } from "@uplink-room/protocol";
import { isTerminalReplies } from "@uplink-room/protocol/terminalReplies";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actsFor, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import {
  actorMayDriveThere,
  handTerminal,
  mayBeHandedWheel,
  mayDriveThere,
  nextDriverThere,
  ownerRunsOnly,
  personDrivesText,
  requireMachineControl,
  requireMayDriveThere,
} from "./lib/machines";
import { audit, hiddenByRun, inTeam, maybeView, memberView, nextDriverInChannel, runsInChannel, teamMember } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import { actorRef, cancelWhatAccessForbids, isLive, MAX_PENDING, OUTPUT_PAGE_BYTES, plainText, takeUnits, utf8Bytes } from "./lib/terminals";

/** Watchers seen in this window count as watching. */
const WATCH_WINDOW_MS = 30 * 1000;

async function terminalView(ctx: QueryCtx, terminal: Doc<"terminals">) {
  const machine = await ctx.db.get(terminal.machineId);
  const now = Date.now();
  const watchers = await ctx.db
    .query("watchers")
    .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
    .collect();
  return {
    terminalId: terminal._id,
    title: terminal.title,
    tool: terminal.tool,
    status: terminal.status,
    failReason: terminal.failReason,
    access: terminal.access,
    loweredFrom: terminal.loweredFrom,
    machine: machine
      ? { machineId: machine._id, name: machine.name, mostOpenAccess: machine.mostOpenAccess }
      : undefined,
    startedBy: await memberView(ctx, terminal.startedBy),
    driver: await maybeView(ctx, terminal.driverId),
    watching: await Promise.all(
      watchers.filter((w) => now - w.lastSeenAt < WATCH_WINDOW_MS).map((w) => memberView(ctx, w.memberId)),
    ),
    usesSlot: terminal.usesSlot,
    profileId: terminal.profileId,
    runId: terminal.runId,
    repo: terminal.repo,
    cwd: terminal.cwd,
    outputSeq: terminal.outputSeq,
    /** The screen whose own replies reach the program (terminals.claimReplies). */
    responderScreenId: terminal.responder?.screenId,
    endedAt: terminal.endedAt,
    /** Set when its process exited on its own: 0 means success. */
    exitCode: terminal.exitCode,
    /** `run` or `tab` for a terminal in Rex (ADR 0019); Rex sets its size, reported in `size`. */
    inRex: terminal.inRex,
    size: terminal.size,
  };
}

export const { person: get, agent: getAgent } = roomQuery({
  name: "terminals.get",
  description:
    "One shared terminal: its machine, access level, driver, who is watching, and its run.",
  scope: "room.read",
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => terminalView(ctx, await inTeam(ctx, actor, args.terminalId)),
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "terminals.list",
  description: "List the live shared terminals on every machine in the team, or on one machine.",
  scope: "room.read",
  args: { machineId: v.optional(v.id("machines")) },
  handler: async (ctx, actor, args) => {
    const terminals = args.machineId
      ? await ctx.db
          .query("terminals")
          .withIndex("by_machine", (q) => q.eq("machineId", args.machineId!))
          .collect()
      : await ctx.db
          .query("terminals")
          .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
          .collect();
    const visible = [];
    // A terminal on a run from a private channel is listed only for that channel's members (ADR 0016).
    for (const t of terminals) {
      if (t.teamId === actor.teamId && isLive(t) && !(await hiddenByRun(ctx, actor, t.runId))) visible.push(t);
    }
    return Promise.all(visible.map((t) => terminalView(ctx, t)));
  },
});

async function machineFor(ctx: QueryCtx, terminal: Doc<"terminals">) {
  const machine = await ctx.db.get(terminal.machineId);
  if (!machine) throw roomError("not_found", "This terminal's machine is gone.");
  return machine;
}

async function canControlMachine(ctx: QueryCtx, actor: Actor, machine: Doc<"machines">) {
  try {
    await requireMachineControl(ctx, actor, machine);
    return true;
  } catch {
    return false;
  }
}

export const { person: setAccess, agent: setAccessAgent } = roomMutation({
  name: "terminals.setAccess",
  description:
    "Set a terminal's access: watch, suggest, drive or open, up to its machine's limit. Whoever started it picks the level; whoever the machine belongs to can always lower it.",
  scope: "terminals.drive",
  args: { terminalId: v.id("terminals"), access: vAccess },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    if (!isLive(terminal)) throw roomError("invalid", "This terminal has ended.");
    const machine = await machineFor(ctx, terminal);
    if (accessRank(args.access) > accessRank(machine.mostOpenAccess)) {
      throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
    }
    const lowering = accessRank(args.access) <= accessRank(terminal.access);
    const isStarter = actsFor(actor, terminal.startedBy);
    if (!isStarter && !(lowering && (await canControlMachine(ctx, actor, machine)))) {
      throw roomError(
        "forbidden",
        "Only whoever started this terminal can change its access; whoever the machine belongs to can lower it.",
      );
    }
    await ctx.db.patch(terminal._id, { access: args.access, loweredFrom: undefined });
    await cancelWhatAccessForbids(ctx, terminal._id, args.access);
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "change_access",
      terminalId: terminal._id,
      access: args.access,
    });
    await audit(ctx, actor, "terminal.access_changed", terminal._id, { from: terminal.access, to: args.access });
    return null;
  },
});

async function liveTerminal(ctx: QueryCtx, actor: Actor, terminalId: Id<"terminals">) {
  const terminal = await inTeam(ctx, actor, terminalId);
  if (!isLive(terminal)) throw roomError("invalid", "This terminal has ended.");
  return terminal;
}

function isDriver(actor: Actor, terminal: Doc<"terminals">): boolean {
  return terminal.driverId === actor.member._id;
}

function requireDriver(actor: Actor, terminal: Doc<"terminals">): void {
  if (!isDriver(actor, terminal)) {
    throw roomError("forbidden", "Only the terminal's driver can do this. Ask for the wheel first.");
  }
}

/**
 * As requireDriver, and the driver must still be someone who may drive on the terminal's machine:
 * on a personal machine set below Drive, its person or their agent (ADR 0025).
 */
async function requireDriverThere(ctx: QueryCtx, actor: Actor, terminal: Doc<"terminals">): Promise<void> {
  requireDriver(actor, terminal);
  await requireMayDriveThere(ctx, actor, await ctx.db.get(terminal.machineId), terminal.runId);
}

/** Makes someone the driver of a terminal (and of its run), and tells the bridge. */
async function setDriver(
  ctx: MutationCtx,
  actor: Actor,
  terminal: Doc<"terminals">,
  memberId: Id<"members">,
): Promise<void> {
  const member = await teamMember(ctx, actor, memberId);
  // The old driver's screen stops answering the program; the new driver's answers once it claims.
  // A reply on its way from the old screen is dropped: programs ask again at their next prompt.
  await ctx.db.patch(terminal._id, {
    driverId: member._id,
    ...(member._id === terminal.driverId ? {} : { responder: undefined }),
  });
  if (terminal.runId) await ctx.db.patch(terminal.runId, { driverId: member._id });
  const requests = await ctx.db
    .query("wheelRequests")
    .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
    .collect();
  for (const r of requests) {
    if (r.status === "pending" && r.fromId === member._id) await ctx.db.patch(r._id, { status: "granted", answeredBy: actor.member._id });
  }
  await sendToBridge(ctx, terminal.machineId, {
    v: 1,
    type: "driver_changed",
    terminalId: terminal._id,
    driver: actorRef(member),
  });
  await audit(ctx, actor, "terminal.driver_changed", terminal._id, {
    from: terminal.driverId,
    to: member._id,
  });
}

/**
 * Someone left a private channel or was removed from it (ADR 0016): a terminal on one of its runs
 * that they drive goes to nextDriverInChannel. With nobody there it stays put, and the room refuses
 * the old driver anyway: every terminal function checks the run's channel (inTeam).
 *
 * On a personal machine set below Drive the wheel goes only to someone who may drive there
 * (nextDriverThere), never back to a teammate, and with nobody who may, nobody drives (ADR 0025).
 */
export async function releaseChannelTerminals(ctx: MutationCtx, actor: Actor, channelId: Id<"channels">, memberId: Id<"members">) {
  for (const run of await runsInChannel(ctx, channelId)) {
    const terminal = run.terminalId ? await ctx.db.get(run.terminalId) : null;
    if (!terminal || !isLive(terminal) || !terminal.driverId) continue;
    const machine = await ctx.db.get(terminal.machineId);
    if (machine && ownerRunsOnly(machine)) {
      if (terminal.driverId !== memberId && (await mayDriveThere(ctx, machine, run._id, terminal.driverId))) continue;
      const next = await nextDriverThere(ctx, machine, channelId, memberId, { runId: run._id, startedBy: terminal.startedBy });
      if (next) await setDriver(ctx, actor, terminal, next);
      else await handTerminal(ctx, terminal, undefined, actor, "left_channel");
      continue;
    }
    if (terminal.driverId !== memberId) continue;
    const next = await nextDriverInChannel(ctx, actor, channelId, memberId, terminal);
    if (next) await setDriver(ctx, actor, terminal, next);
  }
}

/**
 * Sends input to the bridge and records it in "who typed what": every character that reaches the
 * terminal is recorded, a reply too. A reply the member's screen made on its own (`reply`) is marked
 * so the log can show it apart from typing; it can still put text on a shell's line.
 */
async function sendInput(
  ctx: MutationCtx,
  actor: Actor,
  terminal: Doc<"terminals">,
  data: string,
  opts: { suggestionId?: Id<"suggestions">; reply?: boolean } = {},
): Promise<void> {
  const { suggestionId, reply } = opts;
  await sendToBridge(ctx, terminal.machineId, {
    v: 1,
    type: "input",
    terminalId: terminal._id,
    from: actorRef(actor.member),
    data,
    ...(reply ? { reply: true } : {}),
  });
  await ctx.db.insert("terminalInput", {
    terminalId: terminal._id,
    memberId: actor.member._id,
    ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
    data,
    ...(suggestionId ? { suggestionId } : {}),
    at: Date.now(),
    kind: reply ? "reply" : "typed",
  });
}

export const { person: watch, agent: watchAgent } = roomMutation({
  name: "terminals.watch",
  description: "Say you're watching a terminal. Call it every ~15 seconds while its screen is open.",
  scope: "room.read",
  // A presence heartbeat: logging each call would bury the activity log.
  agentAudit: false,
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    const existing = await ctx.db
      .query("watchers")
      .withIndex("by_terminal_member", (q) => q.eq("terminalId", terminal._id).eq("memberId", actor.member._id))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { lastSeenAt: Date.now() });
    const watcherId =
      existing?._id ??
      (await ctx.db.insert("watchers", { terminalId: terminal._id, memberId: actor.member._id, lastSeenAt: Date.now() }));
    const job = existing?.checkId ? await ctx.db.system.get("_scheduled_functions", existing.checkId) : null;
    if (!job || (job.state.kind !== "pending" && job.state.kind !== "inProgress")) {
      await scheduleWatcherCheck(ctx, watcherId, Date.now() + WATCH_WINDOW_MS);
    }
    return null;
  },
});

async function scheduleWatcherCheck(ctx: MutationCtx, watcherId: Id<"watchers">, at: number) {
  const checkId = await ctx.scheduler.runAt(at, internal.terminals.checkWatcher, { watcherId });
  await ctx.db.patch(watcherId, { checkId });
}

/**
 * Drops a watcher whose window passed with no `watch` call, so subscribed
 * terminal views stop listing them: Convex re-runs a query only when data it
 * read changes, never because time passed. If they watched since, it checks
 * again at the new window's end. One check is pending per watcher (`checkId`).
 */
export const checkWatcher = internalMutation({
  args: { watcherId: v.id("watchers") },
  handler: async (ctx, { watcherId }) => {
    const watcher = await ctx.db.get(watcherId);
    if (!watcher) return null;
    if (Date.now() - watcher.lastSeenAt >= WATCH_WINDOW_MS) await ctx.db.delete(watcher._id);
    else await scheduleWatcherCheck(ctx, watcher._id, watcher.lastSeenAt + WATCH_WINDOW_MS);
    return null;
  },
});

export const { person: output, agent: outputAgent } = roomQuery({
  name: "terminals.output",
  description:
    "A terminal's raw screen output (with its escape codes, for drawing a terminal) after a sequence number, oldest first, up to about 4 MiB or `limit` chunks (default 1000, at most 2000). When `more` is true, call again with `afterSeq: cursor` for the next page. Subscribe to follow it live. To read what a command printed, use terminals.read, which returns plain text.",
  scope: "room.read",
  args: { terminalId: v.id("terminals"), afterSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    const afterSeq = args.afterSeq ?? 0;
    const limit = Math.max(1, Math.min(args.limit ?? 1000, 2000));
    const chunks: { seq: number; data: string }[] = [];
    let bytes = 0;
    // Read one chunk at a time and stop at the byte budget, so a noisy terminal's history never
    // reaches Convex's read or return limits. A page always has at least one chunk.
    for await (const chunk of ctx.db
      .query("terminalOutput")
      .withIndex("by_terminal_seq", (q) => q.eq("terminalId", terminal._id).gt("seq", afterSeq))) {
      const size = utf8Bytes(chunk.data);
      if (chunks.length > 0 && bytes + size > OUTPUT_PAGE_BYTES) break;
      chunks.push({ seq: chunk.seq, data: chunk.data });
      bytes += size;
      if (chunks.length >= limit) break;
    }
    const cursor = chunks.at(-1)?.seq ?? afterSeq;
    const run = terminal.runId ? await ctx.db.get(terminal.runId) : null;
    return {
      outputSeq: terminal.outputSeq,
      chunks,
      cursor,
      more: cursor < terminal.outputSeq,
      /** How the terminal stands, so a reader knows when it has everything: starting, live, ended or failed. */
      status: terminal.status,
      exitCode: terminal.exitCode,
      failReason: terminal.failReason,
      runState: run?.state,
    };
  },
});

/** terminals.read: the most text one call returns, and the default. */
const READ_MAX_CHARS = 50_000;
const READ_DEFAULT_CHARS = 8_000;

export const { person: read, agent: readAgent } = roomQuery({
  name: "terminals.read",
  description:
    "A terminal's output as plain text, the way an agent reads it: escape codes removed, and a line redrawn with carriage returns (a prompt, a progress bar) kept as last drawn. Without afterSeq: the last maxChars characters (default 8000), what the terminal shows now; older output is left out (truncated). With afterSeq and afterOffset (the cursor and cursorOffset an earlier read returned): what it printed since, oldest first, about maxChars characters of it, and nothing is skipped: when more is true, read again from the new cursor and cursorOffset. A cursor never stops inside an escape sequence or a character, so the next read gets it whole. gap is true when output between the cursor and this read was dropped: the room keeps a terminal's newest output only. Each read converts its own part, so a line redrawn across two reads can show in both; run_in_terminal and wait_for_terminal keep that state. Output reaches the room a moment after the machine prints it, so after terminals.input read again until the command's output is complete. status is starting, live, ended or failed; exitCode is set once its process exits on its own; runState is the run's state (a shell that exited 0 is done). Colors are removed, so a colored inline diff (node:test, jest) would read as merged text; a shell an agent opens, and a runs.start command, run with NO_COLOR=1 for that reason. Full-screen programs such as vim come out garbled.",
  scope: "room.read",
  args: {
    terminalId: v.id("terminals"),
    afterSeq: v.optional(v.number()),
    afterOffset: v.optional(v.number()),
    maxChars: v.optional(v.number()),
  },
  argDocs: {
    afterSeq: "The cursor an earlier terminals.read (or terminals.output) returned: read only what came after it",
    afterOffset: "The cursorOffset an earlier terminals.read returned with that cursor (default 0): how much of the next chunk it already read",
    maxChars: `The most characters to return, at most ${READ_MAX_CHARS}`,
  },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    const maxChars = Math.max(1, Math.min(Math.floor(args.maxChars ?? READ_DEFAULT_CHARS), READ_MAX_CHARS));
    const run = terminal.runId ? await ctx.db.get(terminal.runId) : null;
    const how = {
      status: terminal.status,
      failReason: terminal.failReason,
      endedAt: terminal.endedAt,
      exitCode: terminal.exitCode,
      runId: terminal.runId,
      runState: run?.state,
    };
    // Which chunk each stretch of `raw` came from, to turn a place in it into a cursor.
    const parts: OutputPart[] = [];
    let raw = "";

    if (args.afterSeq === undefined) {
      // The tail: newest chunks first, until there's enough text, then back in order.
      const chunks: { seq: number; data: string }[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of ctx.db
        .query("terminalOutput")
        .withIndex("by_terminal_seq", (q) => q.eq("terminalId", terminal._id))
        .order("desc")) {
        if (chunks.length > 0 && size >= maxChars * 2) {
          truncated = true;
          break;
        }
        chunks.push(chunk);
        size += chunk.data.length;
      }
      for (const chunk of chunks.reverse()) {
        parts.push({ seq: chunk.seq, from: 0, at: raw.length, length: chunk.data.length, chunkLength: chunk.data.length });
        raw += chunk.data;
      }
      // The cursor goes before an unfinished escape sequence at the end, so the next read gets it whole.
      const { end } = takeUnits(raw, raw.length);
      let text = plainText(raw.slice(0, end));
      if (text.length > maxChars) {
        // Keep the newest text, starting at a whole line when there is one.
        text = text.slice(text.length - maxChars);
        const newline = text.indexOf("\n");
        if (newline >= 0 && newline < text.length - 1) text = text.slice(newline + 1);
        truncated = true;
      }
      const at = placeIn(parts, end, { cursor: terminal.outputSeq, cursorOffset: 0 });
      return { text, ...at, more: false, truncated, gap: false, ...how };
    }

    // From a cursor: whole units of output from (afterSeq, afterOffset) on, about maxChars of them,
    // skipping nothing. Enough is loaded that an unfinished unit at the end means the output ends there.
    const load = maxChars + MAX_PENDING + 2;
    let loadedAll = true;
    let gap = false;
    for await (const chunk of ctx.db
      .query("terminalOutput")
      .withIndex("by_terminal_seq", (q) => q.eq("terminalId", terminal._id).gt("seq", args.afterSeq!))) {
      if (raw.length >= load) {
        loadedAll = false;
        break;
      }
      let from = 0;
      if (parts.length === 0) {
        // The room keeps only a terminal's newest chunks: if the one after the cursor is gone, the
        // cursor's offset no longer means anything, and output in between was lost.
        if (chunk.seq === args.afterSeq + 1) from = Math.min(Math.max(0, Math.floor(args.afterOffset ?? 0)), chunk.data.length);
        else gap = true;
      }
      parts.push({ seq: chunk.seq, from, at: raw.length, length: chunk.data.length - from, chunkLength: chunk.data.length });
      raw += from ? chunk.data.slice(from) : chunk.data;
    }
    const { end, incomplete } = takeUnits(raw, maxChars);
    const at = placeIn(parts, end, { cursor: args.afterSeq, cursorOffset: Math.max(0, Math.floor(args.afterOffset ?? 0)) });
    return {
      // The last line may go on in the next read, so its trailing spaces stay: parts join exactly.
      text: plainText(raw.slice(0, end), { partial: true }),
      ...at,
      /** Output waits after the cursor: read again from it. An unfinished sequence at the very end doesn't count. */
      more: !loadedAll || (end < raw.length && !incomplete),
      truncated: false,
      /** Output between the cursor and this read was dropped (the room keeps a terminal's newest output only). */
      gap,
      ...how,
    };
  },
});

/** A stretch of a read's raw output: from chunk `seq`, starting `from` characters into it. */
type OutputPart = { seq: number; from: number; at: number; length: number; chunkLength: number };

/** The cursor for place `p` in a read's raw output: the last whole chunk, and how far into the next. */
function placeIn(parts: OutputPart[], p: number, none: { cursor: number; cursorOffset: number }) {
  if (parts.length === 0) return none;
  for (const part of parts) {
    if (p < part.at + part.length) return { cursor: part.seq - 1, cursorOffset: part.from + (p - part.at) };
  }
  const last = parts.at(-1)!;
  return last.from + last.length === last.chunkLength
    ? { cursor: last.seq, cursorOffset: 0 }
    : { cursor: last.seq - 1, cursorOffset: last.from + last.length };
}

export const { person: input, agent: inputAgent } = roomMutation({
  name: "terminals.input",
  description:
    "Type into a terminal you drive: data is sent as typed, so end a command with \\n (Enter) to run it, and send \\u0003 for Ctrl-C. Only the driver's input reaches the terminal (see terminals.get for who drives). Read what it printed with terminals.read.",
  scope: "terminals.drive",
  args: {
    terminalId: v.id("terminals"),
    data: v.string(),
    reply: v.optional(v.boolean()),
    screenId: v.optional(v.string()),
  },
  argDocs: {
    reply:
      "Only for an app that draws the terminal: true for what its screen answers the program on its own (focus reports \\u001b[I and \\u001b[O, device attributes \\u001b[?1;2c, cursor position and other status reports, at most 8 of them). It reaches the terminal and is recorded in terminals.inputLog as kind reply. It's taken only from the driver's screen that answers (terminals.claimReplies); any other is dropped, unsent and unrecorded. Data that isn't only such replies is typing",
    screenId: "With reply: the screen sending it, as given to terminals.claimReplies",
  },
  handler: async (ctx, actor, args) => {
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    if (args.reply && isTerminalReplies(args.data)) {
      // One screen answers the program: the driver's that claimed last. Another's reply goes nowhere.
      const responder = terminal.responder;
      const answers =
        responder !== undefined &&
        responder.screenId === args.screenId &&
        responder.memberId === actor.member._id &&
        terminal.driverId === actor.member._id;
      // A screen's replies from a driver who may no longer drive there are dropped too (ADR 0025).
      if (answers && (await actorMayDriveThere(ctx, actor, await ctx.db.get(terminal.machineId), terminal.runId))) {
        await sendInput(ctx, actor, terminal, args.data, { reply: true });
      }
      return null;
    }
    // Typing, or something marked as a reply that isn't only replies: it's typing, from the driver.
    await requireDriverThere(ctx, actor, terminal);
    await sendInput(ctx, actor, terminal, args.data);
    return null;
  },
});

export const { person: claimReplies, agent: claimRepliesAgent } = roomMutation({
  name: "terminals.claimReplies",
  description:
    "Only for an app that draws a terminal you drive: make your screen, named by screenId (any id unique to that screen), the one whose own replies (focus, cursor and status reports) reach the program. Call it when the screen opens the terminal, when you get the wheel, and when the screen gets focus; never because another screen claimed. One screen answers at a time, the latest to claim, and passing the wheel ends its turn. Reading the terminal with terminals.read needs none of this.",
  scope: "terminals.drive",
  // Each focus of the screen claims again: logging each call would bury the activity log.
  agentAudit: false,
  args: { terminalId: v.id("terminals"), screenId: v.string() },
  handler: async (ctx, actor, args) => {
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    await requireDriverThere(ctx, actor, terminal);
    if (!args.screenId.trim() || args.screenId.length > 100) throw roomError("invalid", "screenId must be 1 to 100 characters.");
    const responder = terminal.responder;
    if (responder?.screenId === args.screenId && responder.memberId === actor.member._id) return null;
    await ctx.db.patch(terminal._id, { responder: { screenId: args.screenId, memberId: actor.member._id } });
    return null;
  },
});

const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

export const { person: resize, agent: resizeAgent } = roomMutation({
  name: "terminals.resize",
  description:
    "Resize a terminal you drive. The terminal has one size for everyone, so only the driver can change it. Columns are clamped to 20-500 and rows to 5-200.",
  scope: "terminals.drive",
  args: { terminalId: v.id("terminals"), cols: v.number(), rows: v.number() },
  handler: async (ctx, actor, args) => {
    if (!Number.isFinite(args.cols) || !Number.isFinite(args.rows)) {
      throw roomError("invalid", "Columns and rows must be numbers.");
    }
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    await requireDriverThere(ctx, actor, terminal);
    await sendToBridge(ctx, terminal.machineId, {
      v: 1,
      type: "resize_terminal",
      terminalId: terminal._id,
      from: actorRef(actor.member),
      cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.round(args.cols))),
      rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(args.rows))),
    });
    return null;
  },
});

export const { person: inputLog, agent: inputLogAgent } = roomQuery({
  name: "terminals.inputLog",
  description:
    "Who typed or sent what in a terminal, newest first, including suggestions and who proposed them: everything that reached the terminal. kind is typed, or reply for what the member's screen answered the program on its own (focus, cursor and status reports); input recorded before replies were marked has no kind, and its replies are mixed in with typing. Paged: pass paginationOpts { numItems, cursor: null }, then each result's continueCursor, until isDone.",
  scope: "room.read",
  args: { terminalId: v.id("terminals"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    const result = await ctx.db
      .query("terminalInput")
      .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (r) => {
          const suggestion = r.suggestionId ? await ctx.db.get(r.suggestionId) : null;
          return {
            data: r.data,
            at: r.at,
            by: await memberView(ctx, r.memberId),
            suggestedBy: suggestion ? await memberView(ctx, suggestion.fromId) : undefined,
            kind: r.kind,
          };
        }),
      ),
    };
  },
});

function requireAtLeast(terminal: Doc<"terminals">, access: "suggest" | "drive", what: string) {
  if (accessRank(terminal.access) < accessRank(access)) {
    throw roomError("forbidden", `This terminal is set to ${terminal.access}, so teammates can't ${what}.`);
  }
}

/**
 * On a machine that takes runs only from its person, refuses a new driver who may not be handed the
 * wheel there (mayBeHandedWheel, ADR 0025), whatever the terminal's own level. Returns whether the
 * machine is such a machine, so the caller skips the usual level rules only there.
 */
async function requireMayBeHandedWheel(
  ctx: QueryCtx,
  terminal: Doc<"terminals">,
  memberId: Id<"members">,
  what: string,
): Promise<boolean> {
  const machine = await machineFor(ctx, terminal);
  if (!ownerRunsOnly(machine)) return false;
  if (!(await mayBeHandedWheel(ctx, machine, { runId: terminal.runId, startedBy: terminal.startedBy }, memberId))) {
    throw roomError("forbidden", await personDrivesText(ctx, machine, what));
  }
  return true;
}

export const { person: suggest, agent: suggestAgent } = roomMutation({
  name: "terminals.suggest",
  description: "Propose a command on a Suggest (or more open) terminal. It runs only if the driver sends it.",
  scope: "terminals.drive",
  args: { terminalId: v.id("terminals"), command: v.string() },
  handler: async (ctx, actor, args) => {
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    // A driver who may no longer drive there (ADR 0025) suggests like any teammate.
    const drives = isDriver(actor, terminal) && (await actorMayDriveThere(ctx, actor, await ctx.db.get(terminal.machineId), terminal.runId));
    if (!drives) requireAtLeast(terminal, "suggest", "suggest commands");
    if (!args.command.trim()) throw roomError("invalid", "A suggestion needs a command.");
    return await ctx.db.insert("suggestions", {
      terminalId: terminal._id,
      fromId: actor.member._id,
      command: args.command,
      status: "pending",
    });
  },
});

export const { person: suggestions, agent: suggestionsAgent } = roomQuery({
  name: "terminals.suggestions",
  description: "A terminal's pending suggestions.",
  scope: "room.read",
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    const rows = await ctx.db
      .query("suggestions")
      .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.status === "pending")
        .map(async (r) => ({ suggestionId: r._id, command: r.command, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: sendSuggestion, agent: sendSuggestionAgent } = roomMutation({
  name: "terminals.sendSuggestion",
  description: "As the driver, send a suggested command, optionally edited first.",
  scope: "terminals.drive",
  args: { suggestionId: v.id("suggestions"), command: v.optional(v.string()) },
  handler: async (ctx, actor, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) throw roomError("not_found", "No such suggestion.");
    const terminal = await liveTerminal(ctx, actor, suggestion.terminalId);
    await requireDriverThere(ctx, actor, terminal);
    if (suggestion.status !== "pending") throw roomError("conflict", "This suggestion was already answered.");
    const command = args.command ?? suggestion.command;
    await ctx.db.patch(suggestion._id, { status: "sent", sentCommand: command, answeredBy: actor.member._id });
    await sendInput(ctx, actor, terminal, `${command}\r`, { suggestionId: suggestion._id });
    return null;
  },
});

export const { person: dismissSuggestion, agent: dismissSuggestionAgent } = roomMutation({
  name: "terminals.dismissSuggestion",
  description: "As the driver, dismiss a suggested command.",
  scope: "terminals.drive",
  args: { suggestionId: v.id("suggestions") },
  handler: async (ctx, actor, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) throw roomError("not_found", "No such suggestion.");
    const terminal = await liveTerminal(ctx, actor, suggestion.terminalId);
    await requireDriverThere(ctx, actor, terminal);
    await ctx.db.patch(suggestion._id, { status: "dismissed", answeredBy: actor.member._id });
    return null;
  },
});

export const { person: requestWheel, agent: requestWheelAgent } = roomMutation({
  name: "terminals.requestWheel",
  description: "Ask the driver of a Drive (or Open) terminal for the wheel.",
  scope: "terminals.drive",
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => {
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    if (isDriver(actor, terminal)) throw roomError("conflict", "You already drive this terminal.");
    requireAtLeast(terminal, "drive", "ask for the wheel");
    return await ctx.db.insert("wheelRequests", { terminalId: terminal._id, fromId: actor.member._id, status: "pending" });
  },
});

export const { person: wheelRequests, agent: wheelRequestsAgent } = roomQuery({
  name: "terminals.wheelRequests",
  description: "Pending requests for a terminal's wheel.",
  scope: "room.read",
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => {
    const terminal = await inTeam(ctx, actor, args.terminalId);
    const rows = await ctx.db
      .query("wheelRequests")
      .withIndex("by_terminal", (q) => q.eq("terminalId", terminal._id))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.status === "pending")
        .map(async (r) => ({ requestId: r._id, from: await memberView(ctx, r.fromId) })),
    );
  },
});

export const { person: answerWheelRequest, agent: answerWheelRequestAgent } = roomMutation({
  name: "terminals.answerWheelRequest",
  description: "As the driver, hand the wheel to whoever asked (grant: true) or say no.",
  scope: "terminals.drive",
  args: { requestId: v.id("wheelRequests"), grant: v.boolean() },
  handler: async (ctx, actor, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw roomError("not_found", "No such request.");
    const terminal = await liveTerminal(ctx, actor, request.terminalId);
    await requireDriverThere(ctx, actor, terminal);
    if (request.status !== "pending") throw roomError("conflict", "This request was already answered.");
    if (args.grant) {
      // Access may have dropped since the request was made.
      requireAtLeast(terminal, "drive", "be handed the wheel");
      await requireMayBeHandedWheel(ctx, terminal, request.fromId, "be handed the wheel");
      await setDriver(ctx, actor, terminal, request.fromId);
    } else {
      await ctx.db.patch(request._id, { status: "denied", answeredBy: actor.member._id });
    }
    return null;
  },
});

export const { person: takeWheel, agent: takeWheelAgent } = roomMutation({
  name: "terminals.takeWheel",
  description:
    "Take the wheel of an Open terminal at once. On a Drive terminal, ask for it instead. On Watch and Suggest terminals only whoever started it (not their agent) can take it back. On a personal machine set to Watch or Suggest, only the person it belongs to drives: they can take the wheel of any terminal there, and a teammate who started one can't take it back.",
  scope: "terminals.drive",
  args: { terminalId: v.id("terminals") },
  handler: async (ctx, actor, args) => {
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    if (isDriver(actor, terminal)) return null;
    // On a machine that takes runs only from its person, only whoever may be handed the wheel there
    // takes it, whatever the terminal's own level (ADR 0025).
    if (!(await requireMayBeHandedWheel(ctx, terminal, actor.member._id, "take the wheel"))) {
      if (terminal.access === "drive") {
        throw roomError("forbidden", "This terminal is set to drive: ask the driver for the wheel.");
      }
      // Below Drive the bridge accepts a new driver only if it is exactly whoever started the
      // terminal, so their agent can't take it here either: the room and the bridge would disagree.
      if (terminal.access !== "open" && actor.member._id !== terminal.startedBy) {
        throw roomError(
          "forbidden",
          `This terminal is set to ${terminal.access}, so only whoever started it can take the wheel.`,
        );
      }
    }
    await setDriver(ctx, actor, terminal, actor.member._id);
    return null;
  },
});

export const { person: passWheel, agent: passWheelAgent } = roomMutation({
  name: "terminals.passWheel",
  description:
    "As the driver, pass the wheel to a teammate or an agent. On Watch and Suggest terminals the wheel can only go back to whoever started it. On a personal machine set to Watch or Suggest it can go only to the person the machine belongs to, or back to their agent that started it.",
  scope: "terminals.drive",
  args: { terminalId: v.id("terminals"), to: v.id("members") },
  handler: async (ctx, actor, args) => {
    const terminal = await liveTerminal(ctx, actor, args.terminalId);
    const isStarter = actsFor(actor, terminal.startedBy);
    if (!isDriver(actor, terminal) && !isStarter) {
      throw roomError("forbidden", "Only the driver, or whoever started the terminal, can pass the wheel.");
    }
    const restricted = await requireMayBeHandedWheel(ctx, terminal, args.to, "be handed the wheel");
    if (!restricted && args.to !== terminal.startedBy) requireAtLeast(terminal, "drive", "be handed the wheel");
    await setDriver(ctx, actor, terminal, args.to);
    return null;
  },
});
