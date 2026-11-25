import { v, type ObjectType } from "convex/values";
import { accessRank, DEFAULT_RUNTIME_MODE, REX_TABS_TOOL, vAccess, vRuntimeMode } from "@uplink-room/protocol";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actsFor, agentActorForKey, hasScope, memberStillActs, requireScope, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import {
  commandFor,
  commandWithMode,
  inRexCommand,
  inRexRefusal,
  isHarness,
  profileRefusal,
  STARTABLE_HARNESSES,
  terminalModes,
  threadRefusal,
} from "./lib/harnesses";
import { aboveModeCap, bridgeHandles, modeCapText } from "./lib/threads";
import { belongsToMember, requireMachineControl, requireMayStart } from "./lib/machines";
import { audit, inTeam, memberView, viewOf } from "./lib/members";
import { canSee, canSeeId, channelAccess, memberCanSee, messageAccess, privateTitle, whereLabel } from "./lib/channels";
import { sendToBridge } from "./lib/outbox";
import { normalizeRepo, repoKey } from "./lib/repos";
import { roomMutation, roomQuery } from "./lib/room";
import { runTitleFor, runView, taskIsHidden, taskTitleFor } from "./lib/states";
import { hearsFrom, hearsOf, isLiveRun, labelsOf, liveRunsOf, runLabel, runNamer, runPerson, runToken, seesRun } from "./lib/runLabels";
import { postMessage } from "./messages";
import { MAX_WAITING } from "./lib/router";
import { hearingOf, messageText, placeOf } from "./lib/runDelivery";
import { actorRef, isLive } from "./lib/terminals";
import { endSpace, isLiveSpace } from "./lib/spaces";
import {
  bindingForRun,
  canSteer,
  detachBinding,
  replyToRun,
  runIsHidden,
  startA2ARun,
  stopA2ARun,
} from "./lib/a2a/runs";
import { reachOf } from "./lib/deliveries";
import { isGiven, replyToGivenRun, reportGivenRun, startGivenRun, stopGivenRun } from "./lib/givenRuns";
import { wakeForWork } from "./lib/cloudMachines";
import { endJoinedSession, setRunOpen } from "./lib/joinedRuns";
import { IDEMPOTENCY_DOC, once, vIdempotencyKey } from "./lib/idempotency";
import { refusalOf, wroteAnything } from "./lib/refusals";
import { MAX_COMMAND } from "./lib/taskQueue";

async function freeSlots(ctx: MutationCtx, machine: Doc<"machines">): Promise<number> {
  const terminals = await ctx.db
    .query("terminals")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
  return machine.slots - terminals.filter((t) => isLive(t) && t.usesSlot).length;
}


const START_ARGS = {
  /** Required, except for an A2A or given run, which may be unfiled. */
  taskId: v.optional(v.id("tasks")),
  /** Required, except for an A2A run. */
  harness: v.optional(v.string()),
  /** Required, except for an A2A run. */
  machineId: v.optional(v.id("machines")),
  via: v.optional(v.union(v.literal("terminal"), v.literal("thread"), v.literal("a2a"), v.literal("rex"), v.literal("agent"))),
  /** For an A2A or given run: the agent to send the work to. */
  agentId: v.optional(v.id("agents")),
  repo: v.optional(v.string()),
  cwd: v.optional(v.string()),
  access: v.optional(vAccess),
  profileId: v.optional(v.id("profiles")),
  prompt: v.optional(v.string()),
  command: v.optional(v.string()),
  title: v.optional(v.string()),
  runtimeMode: v.optional(vRuntimeMode),
};

export type StartRunArgs = ObjectType<typeof START_ARGS>;

export const { person: start, agent: startAgent } = roomMutation({
  name: "runs.start",
  description:
    "Start a run on a task: work in a terminal (default), a T3 Code thread, or (via 'rex') a new tab in Rex on a machine, or (via 'a2a') work sent to an agent's own A2A gateway, such as Hermes or OpenClaw. This is also how you open a terminal: pass machineId (machines.list), harness 'shell', cwd for the folder, and taskId if the work is for a task (without one the run is unfiled). It returns runId and terminalId, and you drive it: type with terminals.input and read it with terminals.read. To run one command and finish, pass command instead of typing: the terminal ends when the command exits. An interactive shell's run shows unknown while it runs (the room can't tell what a plain shell is doing). Typing exit ends it with the last command's exit code, so after a failing command it ends failed: type exit 0 to end it done when the work you were asked to do is finished, and report what failed. runs.stop ends it stopped. Either way the terminal holds a slot until it ends, so end it when you're done. For terminals and threads, pick an access level for teammates (watch, suggest, drive, open; default watch) up to the machine's limit (threads.setAccess changes a thread's later). For terminals, optionally one of your profiles on that machine instead of the machine setup; only claude-code and opencode can use a profile, since only they keep its logins apart from the machine setup. Who may start: a personal machine whose mostOpenAccess (machines.list) is watch or suggest takes runs only from the person it belongs to and their agents (not from a private channel or direct message that person isn't in), and refuses anyone else with forbidden; at drive or open, teammates and their agents may start a terminal, thread or Rex tab there. A team machine takes runs from anyone on the team at any level. A terminal you start on someone else's machine uses one of its slots (an agent's always does, even on its own person's machine); a thread uses none. For 'a2a', pass agentId and prompt (the task is optional: without one the run is unfiled); the run shows the agent's task state as it reports it, and you answer its questions with runs.reply. For 'agent', pass agentId of any agent in the roster (teams.roster), with taskId, prompt or both: an agent reached over A2A gets an A2A run, as with 'a2a'; any other (one at a routine webhook, as Grok Bot, one that checks in on its own schedule, as dots, Muse and Duet, or one with only an agent key) gets a run it reports on itself with runs.report (ADR 0044). That run shows unknown until the agent reports; a webhook agent is sent the task at once, and any other finds it in its inbox.get when it checks in. runs.get given says how far the send got, and you reply with runs.reply.",
  scope: "runs.start",
  args: START_ARGS,
  argDocs: {
    taskId: "The task this work is for. It must be open: a closed task (tasks.keepRun) is refused. Required for a thread run. Without it a terminal, 'a2a' or 'agent' run is unfiled: it shows in runs.unfiled, and runs.file files it under a task later",
    harness: {
      description:
        "What runs in the terminal or thread: 'shell' for a plain terminal you type into (terminals.input), or a harness the terminal starts: claude-code, codex, grok-build, opencode, cursor or hermes-agent (Hermes Agent). Another CLI agent runs in 'shell': type its command. A thread ('via: thread') runs every harness but shell and hermes-agent. Required except for 'a2a' and 'agent'",
      enum: STARTABLE_HARNESSES,
    },
    machineId:
      "The machine to run on, from machines.list (it must be online). Someone else's personal machine must have mostOpenAccess drive or open: at watch or suggest it takes runs only from its person and their agents. Required except for 'a2a' and 'agent'",
    via: "'terminal' (default), 'thread' (a T3 Code thread on the machine), 'rex' (a terminal opened as a new tab in Rex, the terminal app, on the machine: needs a machine whose machines.list rex.available is true and where Rex is running; it uses the machine setup, never a profile) 'a2a' (work sent to an agent's A2A gateway) or 'agent' (work given to any agent in the roster: over A2A when it has an endpoint, else a run it reports on itself with runs.report)",
    agentId: "For 'a2a' or 'agent': the agent to send the work to, from teams.roster or teams.members. Not yourself",
    repo: "The repo the work touches, such as github.com/org/repo, from projects.list",
    cwd: "The folder on the machine the terminal or thread starts in, such as a checkout's absolute path",
    access:
      "How much teammates may do in the terminal or thread: watch (default), suggest, drive or open, up to the machine's mostOpenAccess. You drive it either way. On someone else's machine, if its person later lowers it to watch or suggest, they become the driver and the work keeps running",
    profileId: "One of your profiles on that machine (profiles.mine), for claude-code or opencode only",
    prompt: "For 'a2a', 'agent', 'thread' or 'rex': the message the agent starts with (for 'a2a' and 'agent', the task's description or title when left out) (in Rex, given to the harness's command, so not for a plain shell). A terminal ignores it: type with terminals.input",
    command: `For harness 'shell' only: one command line to run instead of an interactive shell, such as "node --version && npm test". On macOS and Linux it runs in the machine owner's login shell ($SHELL -l -i -c), so PATH and version managers (fnm, nvm, asdf) match their own terminal; on Windows, in the machine's shell. It runs with NO_COLOR=1, as every shell an agent opens does, so test diffs stay readable as text. The terminal ends when it exits, and the run's state is the exit code's: done for 0, failed for any other, so a failing test suite makes the run failed (say so when you report). Wait for it with wait_for_terminal (uplink wait-for-terminal), or read it with terminals.read. Needs the terminals.drive scope too, as typing does`,
    title: "For an unfiled terminal: what the run and its terminal are called. A run on a task takes the task's title",
    runtimeMode:
      "What the agent may do without asking (its permission mode): approval-required (default: it asks before commands and edits), auto-accept-edits (it edits files without asking), auto (a reviewer answers most approvals) or full-access (it asks for nothing), up to the machine's mostPermissiveMode (machines.list). For 'thread', any mode T3 Code's provider for the harness takes; threads.setMode changes it later. For a terminal, only claude-code (every mode) and codex (all but auto), as the flags it starts with; a terminal in approval-required starts as the machine sets the harness up",
  },
  handler: (ctx, actor, args) => startRun(ctx, actor, args),
});

/** Starts a run as runs.start does: also how a queued task starts (ADR 0050). */
export async function startRun(ctx: MutationCtx, actor: Actor, args: StartRunArgs): Promise<{ runId: Id<"runs">; terminalId: Id<"terminals"> | undefined }> {
  const task = args.taskId ? await inTeam(ctx, actor, args.taskId) : null;
  if (task && task.closedAt !== undefined) {
    throw roomError(
      "invalid",
      `This task is closed (tasks.keepRun kept run ${task.keptRunId ?? "one of its runs"}), so it takes no new runs. Leave out taskId to start an unfiled run, and link the task in your report with messages.post mentionedTasks.`,
    );
  }
  if (args.via === "a2a" || args.via === "agent") {
    if (!args.agentId)
      throw roomError("invalid", `${args.via === "a2a" ? "An A2A run" : "A run for an agent"} needs agentId: the agent to send it to.`);
    const work = {
      agentId: args.agentId,
      // The first of the prompt, the task's description and its title that has text.
      prompt: [args.prompt, task?.description, task?.title].find((t) => t?.trim()) ?? "",
      ...(task ? { task } : {}),
    };
    // Any agent (ADR 0044): over A2A when the room reaches it there, else given for it to report on.
    const viaA2A = args.via === "a2a" || (await reachOf(ctx, args.agentId)) === "a2a";
    const runId = viaA2A ? await startA2ARun(ctx, actor, work) : await startGivenRun(ctx, actor, work);
    return { runId, terminalId: undefined };
  }
  if (!task && args.via === "thread") {
    throw roomError(
      "invalid",
      "A thread run needs taskId: the task the work is for. Pick one from tasks.board, or make one with tasks.create.",
    );
  }
  const missing = [
    ...(args.machineId ? [] : ["machineId (from machines.list)"]),
    ...(args.harness ? [] : [`harness (${STARTABLE_HARNESSES.join(", ")}; 'shell' is a plain terminal)`]),
  ];
  if (!args.machineId || !args.harness) {
    throw roomError("invalid", `A run on a machine also needs ${missing.join(" and ")}.`);
  }
  const machine = await inTeam(ctx, actor, args.machineId);
  if (machine.unlinkedAt !== undefined) throw roomError("invalid", "This machine was unlinked.");
  // A personal machine set to Watch or Suggest takes runs only from its person (ADR 0025).
  await requireMayStart(ctx, actor, machine, task?.directChannelId);
  if (!isHarness(args.harness)) {
    throw roomError(
      "invalid",
      `Unknown harness ${args.harness}. Known: ${STARTABLE_HARNESSES.join(", ")}. Use shell for a plain terminal to type commands into.`,
    );
  }
  // T3 Code runs only the harnesses it has a provider for; the rest would fail on the machine.
  const noThread = args.via === "thread" ? threadRefusal(args.harness) : undefined;
  if (noThread) throw roomError("invalid", `${noThread} Leave out via, or pass via 'terminal'.`);
  // A profile only where the harness keeps its logins apart from the machine setup (#18).
  const refusal =
    args.profileId && args.via !== "thread" ? profileRefusal(args.harness) : undefined;
  if (refusal) throw roomError("invalid", refusal);
  // In Rex (ADR 0019): only where the machine's bridge opens Rex tabs and Rex runs.
  if (args.via === "rex") {
    if (!machine.tools.includes(REX_TABS_TOOL)) {
      throw roomError(
        "invalid",
        `${machine.name} can't open Rex tabs: Rex isn't installed there, it's a Windows machine, or its Uplink Room bridge is older than Rex tabs. Pick In a shared terminal.`,
      );
    }
    if (machine.rex && !machine.rex.running) {
      throw roomError("invalid", `Rex isn't running on ${machine.name}. Open Rex there, then start the run again.`);
    }
    if (args.profileId) {
      throw roomError(
        "invalid",
        "A run in Rex uses the machine setup: Rex starts the tab with its own environment, so a profile's logins can't be kept apart there.",
      );
    }
    const rexRefusal = inRexRefusal(args.harness, args.prompt);
    if (rexRefusal) throw roomError("invalid", rexRefusal);
  }
  const command = args.command?.trim();
  if (args.command !== undefined) {
    if (args.harness !== "shell" || args.via === "thread") {
      throw roomError("invalid", "command is only for a terminal run with harness shell. Other harnesses start their own program.");
    }
    if (!command) throw roomError("invalid", "command is empty. Leave it out for an interactive shell.");
    if (command.length > MAX_COMMAND) throw roomError("invalid", `command can be at most ${MAX_COMMAND} characters.`);
    // Running a command is typing one: it needs the scope typing does, so runs.start alone never runs code.
    requireScope(actor, "terminals.drive");
  }
  // The permission mode (ADR 0043): up to the machine's cap, and only where the room can set it.
  const runtimeMode = args.runtimeMode;
  if (runtimeMode && runtimeMode !== DEFAULT_RUNTIME_MODE) {
    if (aboveModeCap(machine, runtimeMode)) throw roomError("invalid", modeCapText(machine));
    if (args.via === "thread") {
      if (!bridgeHandles(machine, "thread_modes"))
        throw roomError(
          "invalid",
          `The bridge on ${machine.name} is too old to start a thread in ${runtimeMode}. Update Uplink Room there, or start it with approvals required.`,
        );
    } else if (args.via === "rex" || !terminalModes(args.harness).includes(runtimeMode)) {
      throw roomError(
        "invalid",
        args.via === "rex"
          ? "A run in Rex starts as the machine sets its harness up: leave out runtimeMode."
          : terminalModes(args.harness).length
            ? `A ${args.harness} terminal can start in ${terminalModes(args.harness).join(", ")}.`
            : `The room can't set a permission mode for a ${args.harness} terminal: it starts as the machine sets it up. Leave out runtimeMode, or run it as a thread.`,
      );
    }
  }
  const title = args.title?.trim() || undefined;
  const repo = args.repo ? normalizeRepo(args.repo) : undefined;
  const now = Date.now();
  // A run on a task from a direct message or private channel keeps its texts to that channel's
  // members, like the task (ADR 0016), and its terminal's title doesn't quote the task.
  const restricted = task?.directChannelId;
  // A terminal opened without a task is an unfiled run, named for what runs and where.
  const unfiledTitle = task ? undefined : (title ?? `${args.harness === "shell" ? "Terminal" : args.harness} on ${machine.name}`);
  const runId = await ctx.db.insert("runs", {
    teamId: actor.teamId,
    ...(task ? { taskId: task._id } : { title: unfiledTitle }),
    harness: args.harness,
    ...(repo ? { repo } : {}),
    machineId: machine._id,
    driverId: actor.member._id,
    startedBy: actor.member._id,
    state: "unknown",
    stateChangedAt: now,
    ...(restricted ? { directChannelId: restricted } : {}),
    ...(runtimeMode && runtimeMode !== DEFAULT_RUNTIME_MODE
      ? { runtimeMode, runtimeModeSetBy: actor.member._id, runtimeModeSetAt: now }
      : {}),
  });

  if (args.via === "thread") {
    const access = args.access ?? "watch";
    if (accessRank(access) > accessRank(machine.mostOpenAccess)) {
      throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
    }
    await ctx.db.patch(runId, { threadRef: runId, threadAccess: access });
    // Wake-before-start (#10): a stopped cloud machine starts, and the start waits in its bridge's queue.
    await wakeForWork(ctx, machine._id);
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "start_thread",
      runId,
      harness: args.harness,
      startedBy: actorRef(actor.member),
      ...(actor.accountable ? { accountable: actorRef(actor.accountable) } : {}),
      ...(repo ? { repo } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.prompt ? { prompt: args.prompt } : {}),
      access,
      // Only to a bridge that takes it (checked above): an older one would ask for approvals anyway.
      ...(runtimeMode && runtimeMode !== DEFAULT_RUNTIME_MODE ? { runtimeMode } : {}),
    });
    if (runtimeMode && runtimeMode !== DEFAULT_RUNTIME_MODE) await audit(ctx, actor, "run.mode_set", runId, { to: runtimeMode });
    return { runId, terminalId: undefined };
  }

  const terminalId = await openTerminal(ctx, actor, machine, {
    title: restricted ? privateTitle(await ctx.db.get(restricted), "task") : (task?.title ?? unfiledTitle!),
    tool: args.harness,
    command: command ?? (args.via === "rex" ? inRexCommand(args.harness, args.prompt) : commandWithMode(args.harness, commandFor(args.harness), runtimeMode)),
    access: args.access ?? "watch",
    ...(args.via === "rex" ? { inRex: true } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(repo ? { repo } : {}),
    ...(args.profileId ? { profileId: args.profileId } : {}),
    runId,
  });
  await ctx.db.patch(runId, { terminalId });
  if (runtimeMode && runtimeMode !== DEFAULT_RUNTIME_MODE) await audit(ctx, actor, "run.mode_set", runId, { to: runtimeMode });
  return { runId, terminalId };
}

/** Opens a terminal on a machine, enforcing access, slots and profiles, and asks the bridge to start it. */
export async function openTerminal(
  ctx: MutationCtx,
  actor: Actor,
  machine: Doc<"machines">,
  opts: {
    title: string;
    tool: string;
    command: string | undefined;
    access: Doc<"terminals">["access"];
    cwd?: string;
    repo?: string;
    profileId?: Doc<"profiles">["_id"];
    runId?: Doc<"runs">["_id"];
    /** Open it as a new Rex tab on the machine (ADR 0019). */
    inRex?: boolean;
  },
) {
  if (machine.sharingStoppedAt !== undefined) {
    throw roomError("invalid", "Sharing is stopped on this machine.");
  }
  if (accessRank(opts.access) > accessRank(machine.mostOpenAccess)) {
    throw roomError("invalid", `This machine allows at most ${machine.mostOpenAccess}.`);
  }
  const usesSlot = !belongsToMember(machine, actor);
  if (usesSlot && (await freeSlots(ctx, machine)) <= 0) {
    const mine = (
      await ctx.db
        .query("terminals")
        .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
        .collect()
    ).filter((t) => isLive(t) && t.usesSlot && t.startedBy === actor.member._id);
    const whose =
      mine.length === machine.slots
        ? mine.length === 1 ? "It's yours" : "They're all yours"
        : mine.length === 1 ? "One of them is yours" : `${mine.length} of them are yours`;
    const yours = mine.length
      ? ` ${whose}: end ${mine.length === 1 ? "it" : "one"} with runs.stop (${mine.map((t) => `terminalId ${t._id}${t.runId ? `, runId ${t.runId}` : ""}`).join("; ")}).`
      : "";
    throw roomError(
      "no_free_slot",
      `${machine.name} has no free slot: ${machine.slots === 1 ? "its one slot is" : `all ${machine.slots} are`} in use.${yours} Or pick another machine, or ask whoever it belongs to.`,
    );
  }
  if (opts.profileId) {
    const profile = await inTeam(ctx, actor, opts.profileId);
    if (
      profile.machineId !== machine._id ||
      !actsFor(actor, profile.personId) ||
      profile.status !== "ready"
    ) {
      throw roomError(
        "invalid",
        "That profile isn't one of yours on this machine, or isn't ready.",
      );
    }
  }
  const terminalId = await ctx.db.insert("terminals", {
    teamId: actor.teamId,
    machineId: machine._id,
    startedBy: actor.member._id,
    driverId: actor.member._id,
    access: opts.access,
    usesSlot,
    title: opts.title,
    tool: opts.tool,
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.inRex ? { inRex: "run" as const } : {}),
    status: "starting",
    outputSeq: 0,
  });
  // Wake-before-start (#10): a stopped cloud machine starts, and the terminal waits as starting in its
  // bridge's queue until the bridge is back.
  await wakeForWork(ctx, machine._id);
  await sendToBridge(ctx, machine._id, {
    v: 1,
    type: "start_terminal",
    terminalId,
    startedBy: actorRef(actor.member),
    ...(actor.accountable ? { accountable: actorRef(actor.accountable) } : {}),
    usesSlot,
    access: opts.access,
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
    harness: opts.tool,
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    // An agent reads a plain shell's output as text (terminals.read), where colors lose information.
    ...(actor.kind === "agent" && opts.tool === "shell" ? { noColor: true } : {}),
    // Sent only to a bridge that lists rex-tabs (runs.start checks): an older one would ignore it.
    ...(opts.inRex ? { inRex: true, title: opts.title.slice(0, 128) } : {}),
  });
  await audit(ctx, actor, "terminal.started", terminalId, {
    machineId: machine._id,
    access: opts.access,
    usesSlot,
  });
  return terminalId;
}

export const { person: stop, agent: stopAgent } = roomMutation({
  name: "runs.stop",
  description:
    "Stop a run. It shows stopped at once (runs.get), and its terminal is ended on the machine, which frees the terminal's slot, or its T3 Code thread is stopped there. To finish a shell run as done instead, type exit in it (terminals.input). Returns runId and its state (stopped), with its terminalId; for an A2A run, what the agent was asked. A run through a Space ends that share: every view closes and the bridge stops sharing it, but the Space itself keeps running in Cua. A run sent to an agent over A2A is asked to cancel, and shows Stopped only once the agent confirms; an agent whose gateway can't cancel is refused (use runs.detach). A run given to an agent that reports on it itself (harness agent) shows stopped at once: nothing at the agent is canceled, and its later runs.report is refused.",
  scope: "runs.start",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (isGiven(run)) return stopGivenRun(ctx, actor, run);
    if (run.agentId) {
      const binding = await bindingForRun(ctx, run._id);
      if (!binding) throw roomError("conflict", "This run has nothing left to stop.");
      if (!(await canSteer(ctx, actor, run)))
        throw roomError("forbidden", "You can't stop this run.");
      return { a2a: await stopA2ARun(ctx, actor, run, binding) };
    }
    const task = run.taskId ? await ctx.db.get(run.taskId) : null;
    const machine = run.machineId ? await ctx.db.get(run.machineId) : null;
    const allowed =
      actor.role === "admin" ||
      (run.driverId && actsFor(actor, run.driverId)) ||
      (run.startedBy && actsFor(actor, run.startedBy)) ||
      (task && actsFor(actor, task.ownerId));
    if (!allowed) {
      if (!machine) throw roomError("forbidden", "You can't stop this run.");
      await requireMachineControl(ctx, actor, machine);
    }
    const now = Date.now();
    await ctx.db.patch(run._id, {
      state: "stopped",
      stoppedBy: "room",
      prompt: undefined,
      stateChangedAt: now,
      endedAt: now,
    });
    // A joined run's token stops working with it (ADR 0032).
    const joined = run.joinedSessionId ? await ctx.db.get(run.joinedSessionId) : null;
    if (joined) await endJoinedSession(ctx, joined, "stopped");
    if (!run.machineId) {
      // No machine: nothing to tell a bridge.
    } else if (run.terminalId) {
      await sendToBridge(ctx, run.machineId, {
        v: 1,
        type: "stop_terminal",
        terminalId: run.terminalId,
      });
    } else if (run.threadRef !== undefined) {
      await sendToBridge(ctx, run.machineId, {
        v: 1,
        type: "stop_thread",
        threadRef: run.threadRef,
      });
    } else if (run.spaceId) {
      // A Space run is the share: stopping it unshares the Space. It never powers the Space off.
      const space = await ctx.db.get(run.spaceId);
      if (space && isLiveSpace(space)) {
        await endSpace(ctx, space);
        await sendToBridge(ctx, run.machineId, { v: 1, type: "unshare_space", spaceId: space._id });
        await audit(ctx, actor, "space.unshared", space._id, { runId: run._id });
      }
    }
    await audit(ctx, actor, "run.stopped", run._id);
    // What changed, so a caller needn't read the run back: the bridge ends its terminal next.
    return { runId: run._id, state: "stopped" as const, ...(run.terminalId ? { terminalId: run.terminalId } : {}) };
  },
});

export const { person: reply, agent: replyAgent } = roomMutation({
  name: "runs.reply",
  description:
    "Send a reply on a run sent to an agent over A2A, such as the answer to the question it is waiting on. While the agent's task is open (runs.get a2a.replies is \"task\") it goes to that same task. Once the task finished (a2a.replies is \"conversation\") it continues the conversation: a new task in the agent's same A2A context, as a new run, so the agent still has what was said before (ADR 0024). On a run from a channel, thread or direct message, the reply is posted there as your message, and the agent answers there, so an agent key needs the messages.post scope too. Returns runId, the run the reply went to. On a run given to an agent that reports on it itself (harness agent, ADR 0044), the reply is kept on the run, where the agent reads it with runs.get given.messages, and an agent at a routine webhook is sent the task again with the replies; it returns the same runId, and the run takes no replies once it ended. Its driver, whoever started it, the task's owner or an admin can reply (runs.get canReply says whether you can).",
  scope: "runs.start",
  args: { runId: v.id("runs"), text: v.string() },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (isGiven(run)) return { runId: await replyToGivenRun(ctx, actor, run, args.text) };
    return { runId: await replyToRun(ctx, actor, run, args.text) };
  },
});

export const { person: report, agent: reportAgent } = roomMutation({
  name: "runs.report",
  description:
    "Report on a run given to you (harness agent, ADR 0044): a task someone in the room gave you, which the room can't follow, so you say how it goes. Find it in inbox.get (view mine), or in the task your webhook was sent (run.runId). state is working when you start, waiting when you need an answer (message is your question: it lands in the Needs you of whoever gave you the run, and their answer comes back as a reply in runs.get given.messages), and done or failed when you finish (message says what you did, or what went wrong). message becomes the run's latest line. Only the agent the run was given to can report, and not once the run has ended: a run someone stopped is refused. Returns runId and state.",
  scope: "messages.post",
  args: {
    runId: v.id("runs"),
    state: v.union(v.literal("working"), v.literal("waiting"), v.literal("done"), v.literal("failed")),
    message: v.optional(v.string()),
    idempotencyKey: vIdempotencyKey,
  },
  argDocs: {
    runId: "The run given to you, from inbox.get or the task your webhook was sent",
    state: "working, waiting (you need an answer), done or failed",
    message: "What to show as the run's latest line: what you are doing, your question (required with waiting), or what you did or what failed",
    idempotencyKey: IDEMPOTENCY_DOC,
  },
  handler: async (ctx, actor, { idempotencyKey, ...args }) =>
    once(ctx, actor, "runs.report", idempotencyKey, args, async () => {
      const run = await inTeam(ctx, actor, args.runId);
      return reportGivenRun(ctx, actor, run, { state: args.state, message: args.message });
    }),
});

export const { person: detach, agent: detachAgent } = roomMutation({
  name: "runs.detach",
  description:
    "Stop following a run sent to an agent over A2A without asking the agent to cancel, for an agent whose gateway can't cancel. The run shows Unknown: the agent may still be running it.",
  scope: "runs.start",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    const binding = await bindingForRun(ctx, run._id);
    if (!binding)
      throw roomError("invalid", "Only a run sent to an agent over A2A can be detached.");
    if (!(await canSteer(ctx, actor, run)))
      throw roomError("forbidden", "You can't change this run.");
    if (!binding.following)
      throw roomError("conflict", "The room already stopped following this run.");
    await detachBinding(
      ctx,
      binding,
      `${actor.member.name} stopped following this run.`,
      actor.member._id,
    );
    await audit(ctx, actor, "run.detached", run._id);
    return null;
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "runs.get",
  description:
    "One run: its harness, state, what it's waiting for, driver, machine and terminal or thread. A run given to an agent that reports on it itself (harness agent, ADR 0044) has given: the agent, how far the send got, the agent's latest line and the messages sent to it (the first, then replies). That agent reading its own given run through the connector or its key marks what waited for it as seen; report on it with runs.report.",
  scope: "room.read",
  args: { runId: v.id("runs") },
  handler: async (ctx, actor, args) => {
    // Not inTeam: a run sent from a direct message is still the team's to see, without its texts.
    const run = await ctx.db.get(args.runId);
    if (!run || run.teamId !== actor.teamId || !(await seesRun(ctx, run, actor))) throw roomError("not_found", "Not found in this team.");
    return runView(ctx, run, actor);
  },
});

export const { person: unfiled, agent: unfiledAgent } = roomQuery({
  name: "runs.unfiled",
  description:
    "Runs no task points at yet, such as threads started straight in T3 Code, each with the projects that list its repo.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_team_task", (q) => q.eq("teamId", actor.teamId).eq("taskId", undefined))
      .collect();
    const projects = (
      await ctx.db
        .query("projects")
        .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
        .collect()
    ).filter((p) => p.archivedAt === undefined);
    const shown: Doc<"runs">[] = [];
    for (const r of runs)
      if (r.teamId === actor.teamId && (await seesRun(ctx, r, actor))) shown.push(r);
    return Promise.all(
      shown.map(async (r) => ({
        ...(await runView(ctx, r, actor)),
        suggestedProjects: r.repo
          ? projects
              // By repoKey: GitHub's names ignore case, and a thread's repo may differ in case from a synced repo's.
              .filter((p) => p.repos.some((repo) => repoKey(repo) === repoKey(r.repo!)))
              .map((p) => ({ projectId: p._id, name: p.name }))
          : [],
      })),
    );
  },
});

export const { person: file, agent: fileAgent } = roomMutation({
  name: "runs.file",
  description:
    "File an unfiled run under an existing task (taskId) or a new one (newTask: { title, projectId? }). A run from a direct message or private channel goes only under a task from the same one, or a new task, which then stays with that channel's members too; a run from anywhere else can't go under such a task.",
  scope: "work.manage",
  args: {
    runId: v.id("runs"),
    taskId: v.optional(v.id("tasks")),
    newTask: v.optional(v.object({ title: v.string(), projectId: v.optional(v.id("projects")) })),
  },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (run.taskId) throw roomError("conflict", "This run is already filed under a task.");
    // A task is the team's to see, so a closed run (ADR 0044) is opened before it goes under one.
    if (run.closed === true)
      throw roomError(
        "invalid",
        "This run is closed, so only you can see it: open it first (uplink open, or runs.setOpen) to file it under a task.",
      );
    let taskId = args.taskId;
    if (taskId) {
      const task = await inTeam(ctx, actor, taskId);
      // A run from a direct message or private channel, and a task from one, stay with that
      // channel's members (ADR 0016): either both come from the same channel, or neither does.
      if (task.directChannelId !== run.directChannelId) {
        throw roomError(
          "invalid",
          run.directChannelId
            ? "This run came from a private conversation, so it can only be filed under a task from the same one, or a new task."
            : "That task came from a private conversation, so only runs from the same one can be filed under it.",
        );
      }
    } else if (args.newTask) {
      const title = args.newTask.title.trim();
      if (!title) throw roomError("invalid", "A task needs a title.");
      if (args.newTask.projectId) await inTeam(ctx, actor, args.newTask.projectId);
      const ownerId = actor.accountable?._id ?? actor.member._id;
      const channel = run.directChannelId ? await ctx.db.get(run.directChannelId) : null;
      if (channel && !(await memberCanSee(ctx, channel, ownerId))) {
        const owner = await ctx.db.get(ownerId);
        throw roomError("invalid", `${owner?.name ?? "Its owner"} isn't in ${whereLabel(channel)}, so they can't own a task from it.`);
      }
      taskId = await ctx.db.insert("tasks", {
        teamId: actor.teamId,
        title,
        ...(args.newTask.projectId ? { projectId: args.newTask.projectId } : {}),
        ownerId,
        createdBy: actor.member._id,
        // A task made for a private run is as private as the run.
        ...(run.directChannelId ? { directChannelId: run.directChannelId } : {}),
      });
    } else {
      throw roomError("invalid", "Pass taskId or newTask.");
    }
    await ctx.db.patch(run._id, { taskId });
    await audit(ctx, actor, "run.filed", run._id, { taskId });
    return taskId;
  },
});

// ---------- live runs as addresses (ADR 0026) ----------

const LIVE_DESCRIPTION =
  "The live runs in the team you can message: Claude Code, Codex and other agents in a terminal still running or a T3 Code thread still open, working or between turns, or a session that joined by itself with uplink join (via: joined, ADR 0027), oldest first (ADR 0026). Each is named by its harness and its driver, such as \"Claude Code (Julio)\", numbered by start order when one driver has two of a harness (\"Claude Code 2 (Julio)\"). The driver at the time answers for what the run says (accountable is that person; for an agent driver, the person who added it). To message a run, write its token (\"<@run:RUNID>\", given as token) in a messages.post body, or pass its runId in addressedRuns. hears is who it takes messages from (runs.setHears): anyone, or only its driver and their agents; hearsYou says whether that includes you. hearing is how its machine puts messages into its session, as its bridge reports: mid_task (during a turn, after its next tool call, and at once when it is idle), between_turns (at its next turn), none (it reads the room itself with the uplink command), or unknown (its machine hasn't said, or its bridge can't deliver them: messages wait in its inbox, runs.inbox); hearingNote says when its machine's bridge needs an update first. A run from a direct message or private channel you aren't in shows without its title or its task's title (private: true), and only that channel's members can message it. visibleToTeam is true for a team run: the whole team can see its terminal or thread, which show what it hears, so a direct message opened with it doesn't stay private. A session that joined with uplink join starts closed (open: false, ADR 0044): only its person and their agents see it here, and for anyone else it isn't listed until its person opens it (runs.setOpen, uplink open). A2A agents aren't listed: mention the agent itself.";

export const { person: live, agent: liveAgent } = roomQuery({
  name: "runs.live",
  description: LIVE_DESCRIPTION,
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    // A closed run (ADR 0044) is listed only for its person and their agents.
    // Numbered among all live runs, as every other view names them, then left out.
    const all = await liveRunsOf(ctx, actor.teamId);
    const labels = await labelsOf(ctx, all);
    const runs: Doc<"runs">[] = [];
    for (const run of all) if (await seesRun(ctx, run, actor)) runs.push(run);
    return Promise.all(
      runs.map(async (run) => {
        const hidden = await runIsHidden(ctx, run, actor);
        const task = run.taskId ? await ctx.db.get(run.taskId) : null;
        const person = await runPerson(ctx, run);
        const machine = run.machineId ? await ctx.db.get(run.machineId) : null;
        return {
          runId: run._id,
          token: runToken(run._id),
          label: labels.get(run._id)!,
          harness: run.harness,
          state: run.state,
          title: await runTitleFor(ctx, run, hidden),
          private: hidden,
          task: task ? { taskId: task._id, title: await taskTitleFor(ctx, task, await taskIsHidden(ctx, task, actor)) } : undefined,
          driver: await memberView(ctx, run.driverId!),
          accountable: person ? await viewOf(ctx, person) : undefined,
          machine: machine ? { machineId: machine._id, name: machine.name } : undefined,
          via: run.terminalId ? ("terminal" as const) : run.joinedSessionId ? ("joined" as const) : ("thread" as const),
          hears: hearsOf(run),
          // Closed (ADR 0044): listed only for its person and their agents, so only they see false.
          open: run.closed !== true,
          // Whether the whole team can see what it hears: a team run, not one from a private place (ADR 0039).
          visibleToTeam: run.directChannelId === undefined,
          hearsYou: !hidden && (await hearsFrom(ctx, run, actor)),
          ...(await hearingOf(ctx, run)),
          startedAt: run._creationTime,
        };
      }),
    );
  },
});

export const { person: setHears, agent: setHearsAgent } = roomMutation({
  name: "runs.setHears",
  description:
    "Choose who may message a run you drive (ADR 0026): anyone (the default: anyone who can see the run, person or agent) or driver (only you and your agents). Messages from anyone else are still posted and still name the run, but it doesn't get them. Only the run's driver can change it, or an agent of theirs. Returns runId and hears.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), hears: v.union(v.literal("anyone"), v.literal("driver")) },
  argDocs: {
    hears: "anyone: anyone who can see the run may message it. driver: only its driver and the driver's agents",
  },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (run.agentId) throw roomError("invalid", "A run sent to an A2A agent takes work as its agent does: change who the agent takes work from instead.");
    if (!run.driverId || !actsFor(actor, run.driverId)) throw roomError("forbidden", "Only the run's driver can choose who may message it.");
    if (hearsOf(run) !== args.hears) {
      await ctx.db.patch(run._id, { hears: args.hears });
      await audit(ctx, actor, "run.hears_changed", run._id, { hears: args.hears });
    }
    return { runId: run._id, hears: args.hears };
  },
});

export const { person: setOpen, agent: setOpenAgent } = roomMutation({
  name: "runs.setOpen",
  description:
    "Open or close a session you joined with uplink join (ADR 0044). A joined run starts closed: only you and your agents can see it, list it (runs.live) or message it, and for everyone else in the team it isn't there. Open, the team can see it and message it, as hears allows (runs.setHears). Runs started in the app are always open. Only the run's driver can change it, or an agent of theirs; the session itself does it with uplink open and uplink close. Returns runId and open.",
  scope: "terminals.drive",
  args: { runId: v.id("runs"), open: v.boolean() },
  argDocs: {
    open: "true: the team can see and message the run. false: only you and your agents can",
  },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (!run.driverId || !actsFor(actor, run.driverId))
      throw roomError("forbidden", "Only the run's driver can open or close it.");
    return { runId: run._id, open: await setRunOpen(ctx, actor, run, args.open) };
  },
});

/** At most this many of a run's newest inbox messages are listed. */
const INBOX_PAGE = 50;

export const { person: inbox, agent: inboxAgent } = roomQuery({
  name: "runs.inbox",
  description: `The messages sent to a live run (ADR 0026), newest first: messages that address it with <@run:RUNID> or addressedRuns, replies under a message it posted, and every message in a direct message it is in. Each says who sent it (from.member, and from.run when another run posted it as itself), the person accountable for it, and fromDriver: whether that person is this run's own driver, so the run can judge an instruction (a message can ask for anything; the run decides whether to do it). status is waiting until the run's machine, or a session that joined by itself, puts it into the run's session, then delivered (how: mid_task, during a turn, or next_turn) or failed, with error: run_ended (its terminal ended first), driver_changed (its driver changed to someone who can't read where it was posted), not_heard (its driver narrowed who it hears since), deleted, unsure (its session took it twice without saying it got it), or visible_outside (it was said in a direct message or private channel, and people outside it can see this run's terminal or thread, which show what it hears: only a run started from that place, from a direct message whose members are all in it, or that a direct message was opened with, hears there); hearing and hearingNote say how this run hears them, as in runs.live. Only the run's driver and the person accountable for it read the texts (messages); anyone else in the team gets only label and waiting, the count still waiting (at most ${MAX_WAITING}: past that, senders are told the run isn't taking messages).`,
  scope: "room.read",
  args: { runId: v.id("runs"), limit: v.optional(v.number()) },
  argDocs: { limit: `How many of the newest messages to list, at most ${INBOX_PAGE} (default 20)` },
  handler: async (ctx, actor, args) => {
    // Not inTeam: a run from a direct message or private channel is still the team's to see, without its texts.
    const run = await ctx.db.get(args.runId);
    if (!run || run.teamId !== actor.teamId || !(await seesRun(ctx, run, actor))) throw roomError("not_found", "Not found in this team.");
    const waiting = (
      await ctx.db
        .query("runInbox")
        .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "waiting"))
        .take(MAX_WAITING)
    ).length;
    const base = { runId: run._id, label: await runLabel(ctx, run), waiting, ...(await hearingOf(ctx, run)) };
    const person = await runPerson(ctx, run);
    const reads = (run.driverId !== undefined && actor.member._id === run.driverId) || (person !== null && actsFor(actor, person._id));
    if (!reads) return { ...base, messages: undefined };
    const limit = Math.max(1, Math.min(INBOX_PAGE, Math.floor(args.limit ?? 20)));
    const rows = await ctx.db
      .query("runInbox")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .order("desc")
      .take(limit);
    const name = runNamer(ctx);
    const messages = [];
    for (const row of rows) {
      const message = await ctx.db.get(row.messageId);
      const channel = await ctx.db.get(row.channelId);
      // A message deleted since, or in a place the reader can't see (an agent driver's private channel), shows no text.
      const shown = !!message && message.deletedAt === undefined && !!channel && (await canSee(ctx, actor, channel));
      messages.push({
        messageId: row.messageId,
        channelId: row.channelId,
        replyTo: shown ? message.replyTo : undefined,
        place: shown ? placeOf(channel, message) : undefined,
        text: shown ? await messageText(ctx, actor.teamId, message, name) : undefined,
        attachments: shown ? (message.attachmentCount ?? 0) : undefined,
        from: {
          member: await memberView(ctx, row.from.memberId),
          ...(row.from.runId ? { run: { runId: row.from.runId, label: message?.asRun?.label ?? "A run" } } : {}),
        },
        accountable: await memberView(ctx, row.accountableId),
        fromDriver: row.fromDriver,
        // A claimed message is on its way into the session: still waiting, as far as anyone reading knows.
        status: row.status === "claimed" ? ("waiting" as const) : row.status,
        how: row.how,
        error: row.error,
        at: row.at,
      });
    }
    return { ...base, messages };
  },
});

// ---------- following runs and reminders (ADR 0049's neighbours: runs.changes, runs.remind) ----------

/** At most this many changed runs come back from one runs.changes call, past runs that changed at the same moment. */
export const CHANGES_PAGE = 50;
/** At most this many runs of each kind (driven, started) are read for one call. */
const CHANGES_SCAN = 500;
/** At most this many runIds can be followed by name. */
const FOLLOWED_MAX = 50;

/** Whether the actor may see this run the way inTeam checks it, without throwing. */
async function runVisible(ctx: QueryCtx, actor: Actor, run: Doc<"runs">): Promise<boolean> {
  try {
    await inTeam(ctx, actor, run._id);
    return true;
  } catch {
    return false;
  }
}

export const { person: changes, agent: changesAgent } = roomQuery({
  name: "runs.changes",
  description: `The runs you follow whose state changed after a point, oldest change first: by default the runs you drive or started (for an agent, the ones it drives or started), or the runs you name in runIds (at most ${FOLLOWED_MAX}). Each change is the run as runs.get shows it, with its state and stateChangedAt. Pass the cursor it returns as after next time, and nothing is missed between calls. Without after, it returns no changes and the cursor to start from. At most ${CHANGES_PAGE} come back; more says more changed, so call again from the cursor. wait_for_runs (uplink wait-for-runs) calls this until something changes, so an agent that started several runs waits on all of them at once instead of asking about each one.`,
  scope: "room.read",
  args: { after: v.optional(v.number()), runIds: v.optional(v.array(v.id("runs"))) },
  argDocs: {
    after: "The cursor an earlier call returned. Left out: no changes, only the cursor to start from",
    runIds: `Follow these runs instead of the ones you drive or started, at most ${FOLLOWED_MAX}`,
  },
  handler: async (ctx, actor, args) => {
    if (args.runIds && args.runIds.length > FOLLOWED_MAX) throw roomError("invalid", `Follow at most ${FOLLOWED_MAX} runs by name.`);
    const me = actor.member._id;
    const byTime = (a: Doc<"runs">, b: Doc<"runs">) => a.stateChangedAt - b.stateChangedAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
    if (args.after === undefined) {
      // The place to start from: the newest change among the runs followed, seen or not, so a
      // first wait never replays history.
      let newest = 0;
      if (args.runIds) {
        // Only runs the caller may see: a named run it can't see says nothing, not even when it changed.
        for (const id of new Set(args.runIds)) {
          const run = await ctx.db.get(id);
          if (run && run.teamId === actor.teamId && (await runVisible(ctx, actor, run))) newest = Math.max(newest, run.stateChangedAt);
        }
      } else {
        const driven = await ctx.db.query("runs").withIndex("by_driver_changed", (q) => q.eq("driverId", me)).order("desc").first();
        const started = await ctx.db.query("runs").withIndex("by_starter_changed", (q) => q.eq("startedBy", me)).order("desc").first();
        newest = Math.max(0, driven?.stateChangedAt ?? 0, started?.stateChangedAt ?? 0);
      }
      return { changes: [], cursor: newest, more: false };
    }
    const after = args.after;
    let raw: Doc<"runs">[];
    let limit = Number.POSITIVE_INFINITY;
    if (args.runIds) {
      raw = [];
      for (const id of new Set(args.runIds)) {
        const run = await ctx.db.get(id);
        if (run && run.teamId === actor.teamId && run.stateChangedAt > after && (await runVisible(ctx, actor, run))) raw.push(run);
      }
    } else {
      const driven = await ctx.db
        .query("runs")
        .withIndex("by_driver_changed", (q) => q.eq("driverId", me).gt("stateChangedAt", after))
        .take(CHANGES_SCAN + 1);
      const started = await ctx.db
        .query("runs")
        .withIndex("by_starter_changed", (q) => q.eq("startedBy", me).gt("stateChangedAt", after))
        .take(CHANGES_SCAN + 1);
      // A list cut short says nothing past its last row: only rows before both cuts are complete.
      for (const list of [driven, started]) if (list.length > CHANGES_SCAN) limit = Math.min(limit, list[CHANGES_SCAN - 1]!.stateChangedAt);
      raw = [...new Map([...driven, ...started].map((r) => [r._id, r])).values()];
    }
    raw.sort(byTime);
    const complete = raw.filter((r) => r.stateChangedAt < limit);
    const usable = complete.length ? complete : raw.filter((r) => r.stateChangedAt <= limit);
    const shown: Doc<"runs">[] = [];
    let cursor = after;
    let stopped = false;
    for (const run of usable) {
      // A page ends between two moments, never inside one, so runs that changed together come together.
      if (shown.length >= CHANGES_PAGE && run.stateChangedAt > cursor) {
        stopped = true;
        break;
      }
      cursor = run.stateChangedAt;
      if (await runVisible(ctx, actor, run)) shown.push(run);
    }
    return {
      changes: await Promise.all(shown.map((r) => runView(ctx, r, actor))),
      cursor,
      more: stopped || usable.length < raw.length,
    };
  },
});

/** The shortest and longest wait runs.remind takes. */
export const REMIND_MIN_MS = 10_000;
export const REMIND_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many reminders wait for one run. */
export const MAX_REMINDERS = 20;
const REMINDER_TEXT_MAX = 2000;

export const { person: remind, agent: remindAgent } = roomMutation({
  name: "runs.remind",
  description: `Set a reminder for a live run: after inMs (${REMIND_MIN_MS / 1000} seconds to 7 days), the room posts text in channelId (in the thread under replyTo, if given) as you, addressed to the run, so it reaches the run's session like any message to it. Use it so a run checks back on its own, such as "check CI on the pull request in 5 minutes". Only the run's driver, or an agent of theirs, sets one; at most ${MAX_REMINDERS} wait per run. If the run has ended by then, or you can no longer post there, the reminder is skipped. Returns reminderId; runs.cancelReminder cancels it.`,
  scope: "messages.post",
  args: {
    runId: v.id("runs"),
    text: v.string(),
    inMs: v.number(),
    channelId: v.id("channels"),
    replyTo: v.optional(v.id("messages")),
  },
  argDocs: {
    text: "What the run should do then, such as \"Check CI for the pull request linked in this thread\"",
    inMs: `How long from now, in ms, from ${REMIND_MIN_MS} to ${REMIND_MAX_MS}`,
    channelId: "Where to post it: a channel or direct message you and the run's driver can see",
    replyTo: "A message in that channel to post it under, as a reply in its thread",
  },
  handler: async (ctx, actor, args) => {
    const run = await inTeam(ctx, actor, args.runId);
    if (!run.driverId || !actsFor(actor, run.driverId)) throw roomError("forbidden", "Only the run's driver, or an agent of theirs, can set its reminders.");
    if (!(await isLiveRun(ctx, run))) throw roomError("invalid", "This run isn't live, so nothing would reach it.");
    const text = args.text.trim();
    if (!text) throw roomError("invalid", "A reminder needs text.");
    if (text.length > REMINDER_TEXT_MAX) throw roomError("invalid", `A reminder's text can be at most ${REMINDER_TEXT_MAX} characters.`);
    if (!Number.isFinite(args.inMs) || args.inMs < REMIND_MIN_MS || args.inMs > REMIND_MAX_MS) {
      throw roomError("invalid", `inMs must be from ${REMIND_MIN_MS} to ${REMIND_MAX_MS}.`);
    }
    await channelAccess(ctx, actor, args.channelId);
    if (args.replyTo) {
      const { message } = await messageAccess(ctx, actor, args.replyTo);
      if (message.channelId !== args.channelId) throw roomError("invalid", "replyTo must be a message in channelId.");
    }
    const pending = await ctx.db
      .query("runReminders")
      .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "pending"))
      .take(MAX_REMINDERS);
    if (pending.length >= MAX_REMINDERS) throw roomError("conflict", `${MAX_REMINDERS} reminders already wait for this run. Cancel one first.`);
    const at = Date.now() + Math.floor(args.inMs);
    const reminderId = await ctx.db.insert("runReminders", {
      teamId: actor.teamId,
      runId: run._id,
      setBy: actor.member._id,
      ...(actor.agentKeyId ? { agentKeyId: actor.agentKeyId } : {}),
      channelId: args.channelId,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      text,
      at,
      status: "pending",
    });
    await ctx.db.patch(reminderId, { scheduledId: await ctx.scheduler.runAt(at, internal.runs.fireReminder, { reminderId }) });
    await audit(ctx, actor, "run.reminder_set", run._id, { reminderId, at });
    return { reminderId, at };
  },
});

export const { person: cancelReminder, agent: cancelReminderAgent } = roomMutation({
  name: "runs.cancelReminder",
  description: "Cancel a reminder runs.remind set, before it is posted. Whoever set it can, and the run's driver.",
  scope: "messages.post",
  args: { reminderId: v.id("runReminders") },
  handler: async (ctx, actor, args) => {
    const reminder = await ctx.db.get(args.reminderId);
    if (!reminder || reminder.teamId !== actor.teamId) throw roomError("not_found", "No such reminder.");
    const run = await inTeam(ctx, actor, reminder.runId);
    if (!actsFor(actor, reminder.setBy) && !(run.driverId && actsFor(actor, run.driverId))) {
      throw roomError("forbidden", "Only whoever set this reminder, or the run's driver, can cancel it.");
    }
    if (reminder.status !== "pending") throw roomError("conflict", `This reminder was already ${reminder.status}.`);
    if (reminder.scheduledId) await ctx.scheduler.cancel(reminder.scheduledId);
    await ctx.db.patch(reminder._id, { status: "canceled" });
    await audit(ctx, actor, "run.reminder_canceled", run._id, { reminderId: reminder._id });
    return null;
  },
});

/** Who a reminder posts as when it fires: its setter, with the rights they have now; null if none. */
async function reminderActor(ctx: MutationCtx, reminder: Doc<"runReminders">): Promise<Actor | null> {
  if (reminder.agentKeyId) {
    const key = await ctx.db.get(reminder.agentKeyId);
    try {
      return await agentActorForKey(ctx, key, reminder.teamId);
    } catch {
      return null;
    }
  }
  const member = await ctx.db.get(reminder.setBy);
  if (!member || member.kind !== "person" || !(await memberStillActs(ctx, member._id))) return null;
  return { kind: "person", teamId: member.teamId, member, role: member.role, scopes: "all" };
}

export const fireReminder = internalMutation({
  args: { reminderId: v.id("runReminders") },
  handler: async (ctx, { reminderId }) => {
    const reminder = await ctx.db.get(reminderId);
    if (!reminder || reminder.status !== "pending") return null;
    const skip = (why: string) => ctx.db.patch(reminder._id, { status: "skipped", why });
    const run = await ctx.db.get(reminder.runId);
    if (!run || !(await isLiveRun(ctx, run))) return skip("The run had ended.");
    const actor = await reminderActor(ctx, reminder);
    if (!actor || !hasScope(actor, "messages.post")) return skip("Whoever set it can no longer post.");
    // Only while they could still set it: the run's driver or an agent of theirs, who can still see the run.
    if (!run.driverId || !actsFor(actor, run.driverId) || !(await runVisible(ctx, actor, run))) {
      return skip("Whoever set it no longer drives the run.");
    }
    if (!(await canSeeId(ctx, actor, reminder.channelId))) return skip("Whoever set it can no longer see that channel.");
    const parent = reminder.replyTo ? await ctx.db.get(reminder.replyTo) : null;
    if (reminder.replyTo && (!parent || parent.deletedAt !== undefined)) return skip("The message it was to reply under was deleted.");
    let messageId: Id<"messages">;
    try {
      messageId = await postMessage(ctx, actor, {
        channelId: reminder.channelId,
        body: `Reminder: ${reminder.text}`,
        ...(reminder.replyTo ? { replyTo: reminder.replyTo } : {}),
        addressedRuns: [run._id],
      });
    } catch (error) {
      // A refusal by design (an archived channel, a direct message's warning) before anything was
      // written: the reminder is skipped with the reason. Anything else throws and rolls back.
      const refusal = refusalOf(error);
      if (!refusal || (await wroteAnything(ctx))) throw error;
      return skip(refusal.refused.message);
    }
    await ctx.db.patch(reminder._id, { status: "sent", messageId });
    return null;
  },
});
