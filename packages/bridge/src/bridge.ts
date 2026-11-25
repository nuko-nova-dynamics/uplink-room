import { hostname, platform } from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";
import { ThreadDeliveryError, ThreadStartError, type Adapter, type AdapterHandle, type RunUpdate, type T3Selection, type T3Status, type ThreadControl, type ThreadUpdate } from "./adapters/types.ts";
import { loadT3Sharing, parseShareRequest, saveT3Sharing, type SavedT3Sharing, type SavedT3Thread, type T3SharingView } from "./t3Sharing.ts";
import { batches, newestThatFit } from "./adapters/t3thread.ts";
import { available } from "./adapters/process.ts";
import {
  BRIDGE_FEATURES,
  PROTOCOL_VERSION,
  REX_FEATURE,
  REX_TABS_TOOL,
  MAX_MESSAGE_FILES,
  accessRank,
  isRuntimeMode,
  minAccess,
  runtimeModeRank,
  type Access,
  type ActorRef,
  type BridgeMessage,
  type MachineLimits,
  type RoomFeature,
  type RoomMessage,
  type RoomMessageOf,
  type RunMessageHow,
  type RunAttachTarget,
  type RunRef,
  type RunSaid,
  type RunSay,
  type RunSayAttachment,
  type RuntimeMode,
} from "@uplink-room/protocol";
import {
  formatRunMessages,
  RUN_CLAIM_FILES_MAX,
  RUN_CLAIM_HOLD_MAX_MS,
  RUN_CLAIM_MS,
  type RunMessageClaim,
  type RunMessageClaimRequest,
} from "@uplink-room/protocol/runMessages";
import { hookUpdate, hookDecision, type HookPayload } from "./adapters/claude.ts";
import { ACK_FIELD, ANSWER_HINT, RunInbox, RunKeys, launcherAnswerHint, threadAnswerHint, type ClaimHold, type Handed } from "./runMessages.ts";
import { HermesTerminal, type HermesHost } from "./hermesTerminal.ts";
import { hermesHome } from "./hermesGateway.ts";
import { claudeHooksSettings, withClaudeSettings } from "./claudeHooks.ts";
import { codexHookUpdate, type CodexHookPayload } from "./adapters/codex.ts";
import { CodexTerminal, type CodexHost } from "./codexTerminal.ts";
import { withCodexSession } from "./codexSession.ts";
import { relayedRequests } from "./codexRelay.ts";
import { RoomFilesIndex, removeRoomFiles, saveRoomFiles } from "./roomFiles.ts";
import { LocalRequestError } from "./localErrors.ts";
import { stillWanted, uploadRunFiles, type RunSayFile } from "./runFiles.ts";
import { isCommand } from "./adapters/process.ts";
import { validateLimits } from "./config.ts";
import { PROFILE_HARNESSES, Profiles, withoutMachineAuth } from "./profiles.ts";
import { expandHome, prependPath, quoteArgument, quoteCommand, terminalShell } from "./platform.ts";
import { nodePtyHost, type TerminalHost, type TerminalProcess } from "./terminal.ts";
import type { SpaceGateway } from "./spaces/gateway.ts";
import type { SpaceHost } from "./spaces/host.ts";
import { SpaceSharing, isSpaceMessage } from "./spaces/sharing.ts";
import { RexAdapter } from "./adapters/rex.ts";
import { isTerminalReplies } from "@uplink-room/protocol/terminalReplies";
import type { HostHello } from "./rex/host.ts";
import { bridgeCommand } from "./rex/rexCli.ts";
import { RexRequestError, RexTabError, RexTabs, type HostLink } from "./rex/tabs.ts";

/** What `bridge.send` answers: a room from before ADR 0021 answers null. */
export type RoomReply = { features?: string[] } | null | void;
export interface RoomLink {
  send(message: BridgeMessage): RoomReply | Promise<RoomReply>;
  onMessage(handler: (message: RoomMessage) => void | Promise<void>): void;
  /** `bridge:claimRunMessages`: a session's hook claims the messages waiting for its run (ADR 0026). */
  claimRunMessages?(request: RunMessageClaimRequest): Promise<RunMessageClaim>;
  /**
   * `bridge:holdRunMessages`: the bridge still moves a claim's files (ADR 0043), so the room keeps
   * its messages claimed for another RUN_CLAIM_MS. `held: false`: the claim lapsed, so nothing of it is sent.
   */
  holdRunMessages?(request: { claimId: string; deliveryIds: string[] }): Promise<{ held: boolean }>;
  /** `bridge:runSay`: a run in one of this bridge's terminals posts as itself (ADR 0026). */
  say?(request: RunSay): Promise<RunSaid>;
  /** `bridge:runAttachUrl`: where to upload one file a run sends with its next `say` (ADR 0047). */
  attachUrl?(ref: RunRef): Promise<RunAttachTarget>;
}
/** What `uplink-bridge say` and `reply` ask of the bridge: where to post, the text, and any files to send with it. */
export type RunSayRequest = Pick<RunSay, "text" | "in" | "replyTo"> & { files?: RunSayFile[] };
/**
 * Bridge messages a room from before ADR 0021 refuses, and the room feature that says it takes
 * them. A refused message would stop sharing, so these wait until the room names their feature.
 */
const NEEDS_FEATURE: Partial<Record<BridgeMessage["type"], RoomFeature>> = {
  bridge_features: "bridge_features",
  thread_access: "thread_access",
  t3_status: "t3_status",
  thread_items: "thread_view",
  thread_history_page: "thread_view",
  thread_diff: "thread_view",
  thread_message_result: "thread_messages",
  thread_closed: "thread_closed",
  run_message_result: "run_messages",
  run_hearing: "run_messages",
};
/** Claude Code hook events that hand a run its waiting messages, and how each delivers them. */
const DELIVERING_HOOKS: Record<string, RunMessageHow> = {
  PostToolUse: "mid_task",
  PostToolUseFailure: "mid_task",
  UserPromptSubmit: "next_turn",
};
export interface BridgeOptions {
  link: RoomLink;
  /** How the bridge uploads the files a run sends (ADR 0047); `fetch` unless a test gives another. */
  fetch?: typeof fetch;
  limits: MachineLimits;
  profilesDir: string;
  terminalHost?: TerminalHost;
  clock?: { now(): number };
  adapters?: Adapter[];
  onError?: (error: unknown) => void;
  env?: NodeJS.ProcessEnv;
  dropToken?: () => void | Promise<void>;
  /**
   * Who the machine belongs to, saved when it was paired: a member id, or null
   * for a team machine. Room-started terminals by anyone else use a slot, and
   * while the machine's own limit is below Drive they're refused unless an
   * agent of this person's starts them (ADR 0025). When unknown (undefined),
   * every room-started terminal uses one and none is refused.
   */
  belongsTo?: string | null;
  /** Who linked the machine, saved when it was paired. Terminals shared from the machine count as started by them. */
  linkedBy?: string;
  /**
   * Where to keep which threads the room launched and who drives each, so a restarted bridge still
   * knows: `{ v: 3, machineId, teamId, drivers: { [runId or threadId]: ActorRef }, launched:
   * { [runId]: threadId } }`. A file saved for another pairing is deleted unread.
   */
  threadsFile?: string;
  /**
   * Where to keep the T3 Code threads picked on this machine to share (t3Sharing.ts). Without it,
   * no thread T3 Code has is shared except those launched for room runs, and none can be picked.
   */
  t3SharingFile?: string;
  /**
   * The pairing this bridge runs for. The threads file and the profiles belong to one pairing: a
   * bridge started for another one (the machine was paired again, maybe with another team) deletes
   * them instead of reporting or using them. A profiles folder from before this was saved is
   * adopted by the current pairing.
   */
  pairing?: { machineId: string; teamId?: string };
  /**
   * The saved inbox cursor: the last room message seq this machine handled. Sent with
   * `register_machine`, so the room ends a starting terminal whose start the previous process
   * already handled instead of leaving it Starting.
   */
  afterSeq?: number;
  /**
   * Cua Spaces on this machine (spec #6): the Cua adapter and the Space gateway. Without it the
   * bridge shares no Spaces and refuses `share_space`.
   */
  spaces?: {
    host: SpaceHost;
    gateway: SpaceGateway;
    pollMs?: number;
    /** Problems with Cua or the gateway. They never stop terminal sharing, so they don't go to `onError`. */
    onError?: (error: unknown) => void;
  };
  /**
   * Rex tabs on this machine (ADR 0019): the Rex CLI, found with `rexExecutable()`. Without it the
   * bridge opens and shares no Rex tabs.
   */
  rex?: {
    executable: string | undefined;
    pollMs?: number;
    openWaitMs?: number;
    /** The words that start this bridge's CLI in a Rex tab; `bridgeCommand()` by default. */
    bridgeCommand?: () => string[];
  };
  /**
   * Claude Code hooks for the terminals this bridge starts with `claude` (ADR 0026, `claudeHooks.ts`):
   * the settings file it writes and passes with `--settings`, and the words that start this bridge's
   * CLI in a hook (`bridgeCommand()` by default). Without it, no terminal gets hooks.
   */
  claudeHooks?: { file: string; bridgeCommand?: string[] };
  /**
   * Codex in the terminals this bridge starts with `codex` (ADR 0038, `codexSession.ts`): it runs on an
   * app server of its own with the bridge's hooks, started by `uplink-bridge codex`, which these words
   * start (`bridgeCommand()` by default). Without it, `codex` runs as typed and hears no messages.
   */
  codex?: { bridgeCommand?: string[] };
  /**
   * Hermes Agent in the terminals this bridge starts with `hermes` (ADR 0040, `hermesTerminal.ts`): the
   * bridge follows the terminal's session on the profile's gateway, and writes each such terminal a
   * launcher in `dir` that posts as its run. The launcher runs these words (`bridgeCommand()` by
   * default). `pollMs`: how often the terminal's breadcrumb is read. Without it, `hermes` hears nothing.
   */
  hermes?: { dir: string; bridgeCommand?: string[]; pollMs?: number };
  /**
   * How long a hook that got a run's messages has to say it wrote them for Claude Code before the
   * room hears it's unsure whether they arrived (ADR 0026); 30 seconds by default.
   */
  ackWaitMs?: number;
  /** Makes the secret each terminal gets in its environment (`UPLINK_TERMINAL_SECRET`); 32 random bytes by default. */
  terminalSecret?: () => string;
  /**
   * How long the bridge waits before it claims a thread's messages again after T3 Code didn't take
   * them (ADR 0037); 30 seconds by default, doubling to 5 minutes while it keeps failing.
   */
  threadRetryMs?: number;
  /** How long the room keeps a claim without an answer (RUN_CLAIM_MS by default); for tests. */
  claimMs?: number;
  /**
   * Where to keep the workspaces this bridge saved files in for a run (ADR 0043, `RoomFilesIndex`),
   * so on start it removes the old ones a run whose end it never saw left behind.
   */
  roomFilesIndex?: string;
}
/** How long before a claim's end the bridge stops counting on it: a message dispatched later could land after the room gave it back. */
const CLAIM_MARGIN_MS = 15_000;
interface Terminal {
  id: string;
  localRef: string;
  /**
   * The secret in this terminal's environment (`UPLINK_TERMINAL_SECRET`), which the bridge sets when
   * it spawns the terminal. A local request that acts as the terminal (a hook, its waiter, `say`)
   * must give it with the terminal's id, so another process can't act as this terminal's run just
   * by naming its id. Absent for a terminal the bridge didn't spawn, such as a Rex tab.
   */
  secret?: string;
  process: TerminalProcess;
  access: Access;
  startedBy: ActorRef;
  driver?: ActorRef;
  usesSlot: boolean;
  roomStarted: boolean;
  profileId?: string;
  adapter?: AdapterHandle;
  shared: boolean;
  seq: number;
  output: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Settles once the process has exited (its `onExit`), however it ended. */
  exited: Promise<void>;
  /** The kill, once started; it settles when the kill is done (on Windows, in the background). */
  killed?: Promise<void>;
  /** For a Rex tab: its host. The tab's program is the host's, not a pty of the bridge's. */
  rex?: HostLink;
  /**
   * False for a Rex tab the person opened: the room never ends its program. Stopping it in the room,
   * stopping sharing and closing the bridge only unshare it.
   */
  ownsProgram?: boolean;
  /** Removes the listeners a Rex tab's share added to its host, so a later share starts clean. */
  release?: () => void;
  /** Messages from the room for the run in this terminal (ADR 0026), made when the first arrives. */
  inbox?: RunInbox;
  /** The terminal's Codex on its own app server (ADR 0038), once `uplink-bridge codex` registered it. */
  codex?: CodexTerminal;
  /** Requests relayed from inside Codex's sandbox already posted (`codexRelay.ts`), so each posts once. */
  relayed?: Set<string>;
  /** The terminal's Hermes Agent session on its gateway (ADR 0040), for a terminal started with `hermes`. */
  hermes?: HermesTerminal;
  /** The launcher that posts as this terminal's run, which Hermes's commands run (ADR 0040), and its folder. */
  launcher?: { file: string; dir: string };
  /** The folder the terminal started in, where files sent to its run are saved (ADR 0043). */
  cwd?: string;
  /** The deliveries whose files were saved in `cwd`, removed when the run ends (ADR 0043). */
  savedFiles?: Set<string>;
}
/** The image types a harness takes with a message by path (Codex's `localImage`, Hermes's `image.attach`). */
const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** How long closing waits for its last messages to reach the room. */
const CLOSE_WAIT_MS = 2000;
/** How long a hook that got a run's messages has to say it wrote them (`BridgeOptions.ackWaitMs`). */
const ACK_WAIT_MS = 30_000;
/** Messages the room handed this bridge for a hook (ADR 0026), until the hook says it wrote them. */
interface Claim {
  terminalId: string;
  deliveryIds: string[];
  how: RunMessageHow;
  timer?: ReturnType<typeof setTimeout>;
}
/** A thread's deliveries (ADR 0037): one claim at a time, another when a notice came meanwhile, and a pause after a failure. */
interface ThreadDeliveries {
  busy: boolean;
  again: boolean;
  retry?: ReturnType<typeof setTimeout>;
  wait: number;
}
/** How long a thread's deliveries pause after a failure, doubling up to this. */
const THREAD_RETRY_MAX_MS = 5 * 60 * 1000;
/** How long deleting a profile waits for its terminals' kills before killing them without the tree kill. */
const PROFILE_KILL_WAIT_MS = 3000;
/** How long deleting a profile then waits for its terminals to exit. */
const PROFILE_EXIT_WAIT_MS = 5000;
/** How often a profile whose terminals haven't all exited kills them again; its deletion runs on their exit. */
const PROFILE_RETRY_MS = 30_000;

/** Waits for `promise`, but no longer than `ms`. */
function waitAtMost(promise: Promise<unknown>, ms: number) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms).unref())]);
}
/** Removed item ids per `thread_items` message. */
const REMOVED_PER_MESSAGE = 500;

/**
 * A message as it may leave while sharing is stopped: terminal output and a thread's items not at
 * all, and a history page or diff the room waits on only as why it has none.
 */
function withoutContent(message: BridgeMessage): BridgeMessage | undefined {
  if (message.type === "terminal_output" || message.type === "thread_items") return undefined;
  if (message.type === "thread_history_page" && message.items.length)
    return { ...message, items: [], older: false, error: "sharing_stopped" };
  if (message.type === "thread_diff" && message.diff !== undefined)
    return { v: 1, type: "thread_diff", threadRef: message.threadRef, requestId: message.requestId, error: "sharing_stopped" };
  return message;
}

/** The sizes a terminal may be resized to (the room clamps to the same range). */
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;
/**
 * A shell's one-shot command (runs.start's command), and a shell an agent opens (`noColor`), is
 * read as text, and colored output loses information when its escape codes are removed: a test
 * runner's inline diff merges the two values. So it runs without colors (no-color.org).
 */
const plainColors = { NO_COLOR: "1" } as const;

export class Bridge {
  private terminals = new Map<string, Terminal>();
  /**
   * Every terminal whose process hasn't exited yet, including ones already ended here and no longer
   * in `terminals` while their kill finishes. A profile's folders go only once none of its own is left.
   */
  private live = new Set<Terminal>();
  /** Profiles marked for deletion whose folders wait for their terminals to exit, and why they go. */
  private deleting = new Map<string, "deleted" | "expired">();
  /** Profiles in `deleting` whose deletion waits for their terminals' exit (`retryProfileDeletion`). */
  private retrying = new Set<string>();
  /** Profiles in `deleting` whose folders couldn't be removed (a busy file on Windows); retried. */
  private deleteFailed = new Set<string>();
  /** Room ids for terminals shared from the machine itself (`terminal_linked`). */
  private linked = new Map<string, string>();
  private work: Promise<void> = Promise.resolve();
  /**
   * Local profile changes (create, delete, expire), in order. Never waits on the room, so expiry
   * deletes logins on time while a send hangs.
   */
  private profileWork: Promise<void> = Promise.resolve();
  private outgoing: Promise<void> = Promise.resolve();
  private sharing = true;
  /** True only while sharing is stopped by the room's `stop_sharing`, which `resume_sharing` may undo. */
  private resumable = false;
  private closing = false;
  private profiles: Profiles;
  /** Approvals waiting on a Claude Code hook, by terminal, with the id the room must answer. */
  private pendingHooks = new Map<
    string,
    {
      promptId: string;
      resolve: (answer: "allow" | "deny") => void;
      /** How the approval ends unanswered; denied when absent. A Codex approval goes back to Codex's own prompt. */
      cancel?: () => void;
    }
  >();
  private socketPath?: string;
  private adapterHandles: AdapterHandle[] = [];
  /** Who drives each thread the room launched, by run id and thread id. */
  private threadDrivers = new Map<string, ActorRef>();
  /** Threads the room launched: run id → thread id. Saved with the drivers. */
  private launchedThreads = new Map<string, string>();
  /** Each thread's access (ADR 0021), by run id and thread id, clamped to the machine's limit. Absent: Watch. */
  private threadAccess = new Map<string, Access>();
  /** Who started each thread the room launched, by run id and thread id: below Drive only they get its wheel. */
  private threadStarters = new Map<string, string>();
  /** Each thread's permission mode as T3 Code last said it, and its provider's modes (ADR 0043), by thread id. */
  private threadModes = new Map<string, { mode: RuntimeMode; modes: RuntimeMode[] | undefined }>();
  /** What the room takes beyond the first protocol (ROOM_FEATURES), from `bridge.send`'s answers. */
  private roomFeatures = new Set<string>();
  /** Claims a hook got and hasn't acknowledged yet, by claim id. */
  private claims = new Map<string, Claim>();
  /** The workspaces this bridge saved files in for runs (ADR 0043). */
  private roomFiles: RoomFilesIndex;
  /** Saved files being removed, which closing waits for. */
  private removals = new Set<Promise<void>>();
  /** Run keys given to thread runs (ADR 0037), and what hides them in what the room gets. */
  private runKeys = new RunKeys(() => this.now());
  /** Each thread's deliveries while one is in flight or waits to be tried again, by the room's ref for it. */
  private threadDeliveries = new Map<string, ThreadDeliveries>();
  /**
   * Each thread's driver messages in flight, by the room's ref for it (ADR 0043): one after another
   * per thread, off the room's command queue, since moving their files can take minutes.
   */
  private threadSends = new Map<string, Promise<void>>();
  /** How many times each thread's run stopped or its thread closed, by T3 Code's id, so a message on its way sees it. */
  private threadStops = new Map<string, number>();
  /** How many times sharing stopped, so a message on its way sees it even once sharing resumed. */
  private sharingStops = 0;
  /** The T3 Code pairing's last status, sent again once the room says it takes `t3_status`. */
  private t3Status?: T3Status;
  /** The T3 Code threads picked here, as saved (t3Sharing.ts). */
  private t3Saved?: SavedT3Sharing;
  /** What the T3 Code adapter shares now: the saved choice, less any stop a failed save didn't keep. */
  private t3Applied?: T3Selection;
  /** Bumped on each saved choice, so a save made from an older list is refused. */
  private t3Revision = 0;
  /** Saves of the choice, one after another. */
  private t3Saving: Promise<unknown> = Promise.resolve();
  /**
   * Threads someone has open in the room (`watch_thread`, ADR 0022), by the room's thread ref. Kept
   * while sharing is stopped, and followed again when it resumes.
   */
  private watchedThreads = new Set<string>();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  /**
   * Settles once `register_machine` is queued. Expiry can delete profiles before then, but the room
   * hears `profile_expired` only after the registration.
   */
  private registered = Promise.withResolvers<void>();
  private options: BridgeOptions;
  private spaces?: SpaceSharing;
  private rexTabs?: RexTabs;
  /** What the room said it understands (`room_features`); a feature's messages wait for it. */
  private features = new Set<string>();
  constructor(options: BridgeOptions) {
    this.options = { ...options, limits: validateLimits(options.limits) };
    this.profiles = new Profiles(options.profilesDir);
    this.roomFiles = new RoomFilesIndex(options.roomFilesIndex);
    if (options.rex) {
      this.rexTabs = new RexTabs({
        executable: options.rex.executable,
        env: { ...process.env, ...options.env },
        bridgeCommand: options.rex.bridgeCommand ?? (() => bridgeCommand({ ...process.env, ...options.env })),
        socketPath: () => this.socketPath,
        emit: (message) => void this.emit(message),
        ...(options.rex.pollMs === undefined ? {} : { pollMs: options.rex.pollMs }),
        ...(options.rex.openWaitMs === undefined ? {} : { openWaitMs: options.rex.openWaitMs }),
      });
    }
    if (options.spaces) {
      this.spaces = new SpaceSharing({
        ...options.spaces,
        emit: (message) => this.emit(message),
        limits: () => this.options.limits,
      });
    }
  }
  private now() {
    return this.options.clock?.now() ?? Date.now();
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    // A profile already marked for deletion retries on its own (`retryProfileDeletion`).
    const next = Math.min(...[...this.profiles.entries].filter(([id]) => !this.deleting.has(id)).map(([, expiry]) => expiry));
    if (!Number.isFinite(next)) return;
    this.expiryTimer = setTimeout(
      () => {
        // Not through the command queue, which can be held up by a send the room never answers.
        this.expireProfiles().catch((error: unknown) => {
          if (!this.closing) this.options.onError?.(error);
        });
      },
      Math.max(1, Math.min(2147483647, next - this.now())),
    );
    this.expiryTimer.unref();
  }
  private enqueue(action: () => Promise<void>) {
    const result = this.work.then(action);
    this.work = result.catch(() => {});
    return result;
  }
  /** Runs a local profile change after the ones before it. */
  private profileTask<T>(action: () => Promise<T>) {
    const result = this.profileWork.then(action);
    this.profileWork = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /**
   * Deletes every expired profile, then reports each to the room without waiting for the room, so
   * a stalled link can't keep the next one's logins on disk.
   */
  expireProfiles() {
    return this.profileTask(async () => {
      // A deletion whose folders couldn't be removed is tried again here, whatever made it.
      for (const id of [...this.deleteFailed]) await this.removeProfile(id, this.deleting.get(id) ?? "deleted");
      for (const [id, expiry] of this.profiles.entries) {
        if (expiry > this.now() || this.deleting.has(id)) continue;
        await this.removeProfile(id, "expired");
      }
      this.scheduleExpiry();
    });
  }
  /** Waits for the profile queue, then holds it until the returned function is called (more calls do nothing). */
  private async holdProfiles() {
    const held = Promise.withResolvers<void>();
    await new Promise<void>((acquired) => {
      void this.profileTask(() => {
        acquired();
        return held.promise;
      });
    });
    return () => held.resolve();
  }
  private deleteProfile(id: string) {
    return this.profileTask(() => this.removeProfile(id, "deleted"));
  }
  /** Whether a terminal may start on the profile now: it exists, hasn't expired, and isn't going away. */
  private profileUsable(id: string) {
    const expiresAt = this.profiles.entries.get(id);
    return expiresAt !== undefined && expiresAt > this.now() && !this.deleting.has(id);
  }
  /**
   * Deletes a profile's folders once every process started on it has exited, so none writes a login
   * into a folder after it's deleted. That includes terminals already ended here whose kill is still
   * finishing (`live`). From the first call the profile is marked, and no terminal starts on it. On
   * Windows a kill ends the process tree first, which can take seconds: past PROFILE_KILL_WAIT_MS a
   * terminal still running is killed outright (`forceKill`), and past PROFILE_EXIT_WAIT_MS more the
   * folders stay and the deletion runs again when the last of them exits. An expired profile is
   * reported to the room once its folders are gone.
   */
  private async removeProfile(id: string, reason: "deleted" | "expired") {
    this.deleting.set(id, this.deleting.get(id) ?? reason);
    const processes = [...this.live].filter((terminal) => terminal.profileId === id);
    if (processes.length) {
      for (const terminal of processes) if (this.terminals.get(terminal.id) === terminal) void this.end(terminal);
      for (const terminal of processes) void this.stop(terminal);
      const exited = Promise.all(processes.map((terminal) => terminal.exited));
      await waitAtMost(exited, PROFILE_KILL_WAIT_MS);
      for (const terminal of processes) if (this.live.has(terminal)) this.forceKill(terminal);
      await waitAtMost(exited, PROFILE_EXIT_WAIT_MS);
      if (processes.some((terminal) => this.live.has(terminal))) {
        this.retryProfileDeletion(id, processes);
        return;
      }
    }
    try {
      await this.profiles.delete(id);
    } catch (error) {
      // Kept marked, so no terminal starts on it, and tried again on the next expiry pass or timer.
      this.deleteFailed.add(id);
      if (!this.closing) this.options.onError?.(error);
      const retry = setTimeout(() => {
        this.expireProfiles().catch((failure: unknown) => {
          if (!this.closing) this.options.onError?.(failure);
        });
      }, PROFILE_RETRY_MS);
      retry.unref();
      return;
    }
    this.deleteFailed.delete(id);
    const why = this.deleting.get(id);
    this.deleting.delete(id);
    this.scheduleExpiry();
    if (why === "expired")
      void this.registered.promise
        .then(() => this.emit({ v: 1, type: "profile_expired", profileId: id }))
        .catch(() => {});
  }
  /** Kills a terminal out of time: on Windows without the tree kill (`killNow`), elsewhere with SIGKILL. */
  private forceKill(terminal: Terminal) {
    if (terminal.process.killNow) void terminal.process.killNow();
    else void terminal.process.kill("SIGKILL");
  }
  /**
   * Runs a profile's deletion again once its remaining terminals have exited. No terminal starts on
   * it meanwhile, so none is added; every PROFILE_RETRY_MS those still running are killed again.
   */
  private retryProfileDeletion(id: string, processes: Terminal[]) {
    if (this.retrying.has(id)) return;
    this.retrying.add(id);
    const running = () => processes.filter((terminal) => this.live.has(terminal));
    const again = () => {
      for (const terminal of running()) this.forceKill(terminal);
      timer = setTimeout(again, PROFILE_RETRY_MS);
      timer.unref();
    };
    let timer = setTimeout(again, PROFILE_RETRY_MS);
    timer.unref();
    void Promise.all(processes.map((terminal) => terminal.exited)).then(() => {
      clearTimeout(timer);
      this.retrying.delete(id);
      this.profileTask(() => this.removeProfile(id, this.deleting.get(id) ?? "deleted")).catch((error: unknown) => {
        if (!this.closing) this.options.onError?.(error);
      });
    });
  }
  /**
   * Deletes the profiles if they were made for another pairing, then marks the folder with this
   * one. Profiles hold one team's people's logins; another team's bridge must never use or report them.
   */
  private async scopeProfiles() {
    const pairing = this.options.pairing;
    if (!pairing) return;
    const marker = join(this.options.profilesDir, ".pairing.json");
    let saved: { machineId?: string; teamId?: string } | undefined;
    try {
      saved = JSON.parse(await readFile(marker, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (saved && (saved.machineId !== pairing.machineId || saved.teamId !== pairing.teamId))
      await rm(this.options.profilesDir, { recursive: true, force: true });
    await mkdir(this.options.profilesDir, { recursive: true, mode: 0o700 });
    await writeFile(marker, JSON.stringify({ machineId: pairing.machineId, teamId: pairing.teamId }), { mode: 0o600 });
  }
  private emit(message: BridgeMessage) {
    // Every approval gets a fresh id, so an answer can only apply to the approval it names.
    if (
      message.type === "run_state_changed" &&
      message.prompt?.kind === "approval" &&
      message.prompt.promptId === undefined
    )
      message = { ...message, prompt: { ...message.prompt, promptId: randomUUID() } };
    // A room from before these messages refuses them, and with them the whole batch.
    if ((message.type === "rex_found" || message.type === "terminal_size") && !this.features.has(REX_FEATURE))
      return this.outgoing;
    this.outgoing = this.outgoing.then(async () => {
      // Checked as it leaves: a read that finished after sharing stopped sends nothing it read.
      const shown = this.sharing ? message : withoutContent(message);
      if (!shown) return;
      // A thread's conversation shows the run keys its deliveries gave and the commands that used
      // them, and so can an approval of such a command, a title or a terminal a key was pasted
      // into: the room never gets one, whatever the message (ADR 0037).
      const out = this.hideKeys(shown);
      const feature = NEEDS_FEATURE[out.type];
      if (feature && !this.roomFeatures.has(feature)) return;
      // A room that doesn't answer questions (ADR 0023) refuses a prompt with `questions`: it gets
      // the question as text, to answer on the machine.
      let sent = out;
      if (sent.type === "run_state_changed" && sent.prompt?.questions && !this.roomFeatures.has("thread_questions")) {
        const { questions: _questions, promptId: _promptId, ...prompt } = sent.prompt;
        sent = { ...sent, prompt };
      }
      this.learn(await this.options.link.send(sent));
    });
    void this.outgoing.catch((error) => {
      this.sharing = false;
      this.resumable = false;
      if (!this.closing) this.options.onError?.(error);
    });
    return this.outgoing;
  }
  /**
   * Notes what the room says it takes. Once it names `bridge_features`, the bridge says what it
   * handles; once it names `t3_status`, the T3 Code pairing's status goes again.
   */
  private learn(reply: RoomReply) {
    const features = reply && Array.isArray(reply.features) ? reply.features : undefined;
    if (!features) return;
    const fresh = features.filter((f) => !this.roomFeatures.has(f));
    if (!fresh.length) return;
    for (const f of fresh) this.roomFeatures.add(f);
    if (fresh.includes("bridge_features")) void this.emit({ v: 1, type: "bridge_features", features: [...BRIDGE_FEATURES] });
    if (fresh.includes("t3_status") && this.t3Status && this.sharing) void this.emit({ v: 1, type: "t3_status", ...this.t3Status });
  }
  async start() {
    await this.scopeProfiles();
    await this.profiles.load();
    // Before any send: a room that never acknowledges `register_machine` mustn't keep logins past their deadline.
    this.scheduleExpiry();
    await this.loadThreads();
    if (this.options.t3SharingFile) {
      this.t3Saved = await loadT3Sharing(this.options.t3SharingFile, this.options.pairing);
      if (this.t3Saved) this.t3Applied = { environmentId: this.t3Saved.environmentId, threads: this.t3Saved.threads.map((t) => t.id) };
    }
    // Files saved for runs whose end a bridge before this one never saw (ADR 0043), in the background.
    this.track(this.roomFiles.prune());
    const registration = this.emit({
      v: 1,
      type: "register_machine",
      hostname: hostname(),
      os: platform(),
      bridgeVersion: "0.1.0",
      tools: (
        await Promise.all(
          (this.options.adapters ?? []).map(async (a) =>
            (await available(a.executable)) ? a.name : undefined,
          ),
        )
      )
        .filter((name): name is string => !!name)
        .concat(this.rexTabs?.available() ? [REX_TABS_TOOL] : []),
      limits: this.options.limits,
      ...(this.options.afterSeq === undefined ? {} : { afterSeq: this.options.afterSeq }),
    });
    this.registered.resolve();
    await registration;
    await this.expireProfiles();
    this.startAdapterBridges();
    // A Space gateway that can't listen, or a Cua that doesn't answer, never stops terminal sharing.
    await this.spaces?.start().catch((error) => this.options.spaces?.onError?.(error));
    this.rexTabs?.start();
    this.options.link.onMessage((message) => {
      const result = this.work.then(() => this.receive(message));
      this.work = result.catch(() => {});
      return result;
    });
  }
  private startAdapterBridges() {
    for (const adapter of this.options.adapters ?? []) {
      const handle = adapter.startBridge?.(
        (source, update, info) => {
          if (source.kind === "thread") {
            this.runKeys.threadWorks(source.threadRef, update.state === "working" || update.state === "waiting");
            // Stopped in T3 Code: as when the room stops it, nothing on its way starts it again.
            if (update.state === "stopped") this.stopDeliveries(source.threadRef);
          }
          if (this.sharing)
            void this.emit({ v: 1, type: "run_state_changed", source, ...update, ...info });
        },
        { launched: new Map(this.launchedThreads), ...(this.t3Applied ? { shared: this.t3Applied } : {}) },
        {
          t3Status: (status) => {
            this.t3Status = status;
            if (this.sharing) void this.emit({ v: 1, type: "t3_status", ...status });
          },
          threadClosed: (threadRef) => {
            this.forgetThread(threadRef);
            if (this.sharing) void this.emit({ v: 1, type: "thread_closed", threadRef });
          },
          threadHearing: (threadRef, hearing) => {
            if (this.sharing && this.roomFeatures.has("thread_run_messages"))
              void this.emit({ v: 1, type: "run_hearing", source: { kind: "thread", threadRef }, hearing });
          },
          threadMode: (threadRef, mode, modes) => {
            this.threadModes.set(threadRef, { mode, modes });
            this.tellThreadMode(threadRef);
          },
          redact: (raw) => this.runKeys.hide(raw),
        },
      );
      if (handle) this.adapterHandles.push(handle);
    }
    for (const threadRef of this.watchedThreads) this.followThread(threadRef);
  }
  /** The ref the room has for a thread now: T3 Code's id once the launch bound it. */
  private roomThreadRef(threadRef: string) {
    return this.launchedThreads.get(threadRef) ?? threadRef;
  }
  /** Tells the room a thread's mode as T3 Code last said it, with its provider's modes (ADR 0043). */
  private tellThreadMode(threadRef: string) {
    const known = this.threadModes.get(threadRef);
    if (!known || !this.sharing || !this.roomFeatures.has("thread_modes")) return;
    void this.emit({ v: 1, type: "thread_mode", threadRef, runtimeMode: known.mode, ...(known.modes ? { modes: known.modes } : {}) });
  }
  /** Starts following a thread's conversation for the room, if the adapter can. */
  private followThread(threadRef: string) {
    this.threadControl()?.watch?.(threadRef, (update) => this.sendThreadUpdate(threadRef, update));
  }
  private sendThreadUpdate(threadRef: string, update: ThreadUpdate) {
    if (!this.sharing || !this.watchedThreads.has(threadRef)) return;
    const ref = this.roomThreadRef(threadRef);
    if (update.reset) {
      // One message, so the room drops only what T3 Code no longer has.
      const { items, left } = newestThatFit(update.items);
      void this.emit({ v: 1, type: "thread_items", threadRef: ref, items, reset: true, older: update.older === true || left });
      return;
    }
    const groups = batches(update.items);
    // Removals go 500 to a message, the first with the first items, so none is lost.
    const removed: string[][] = [];
    for (let i = 0; i < (update.removed?.length ?? 0); i += REMOVED_PER_MESSAGE) removed.push(update.removed!.slice(i, i + REMOVED_PER_MESSAGE));
    while (groups.length < removed.length) groups.push([]);
    groups.forEach((items, i) =>
      void this.emit({ v: 1, type: "thread_items", threadRef: ref, items, ...(removed[i] ? { removed: removed[i] } : {}) }),
    );
  }
  /** A thread view's request: watching, older history or a diff (ADR 0022). */
  private threadView(
    message: Extract<RoomMessage, { type: "watch_thread" | "unwatch_thread" | "thread_history" | "thread_diff_request" }>,
  ) {
    const threads = this.threadControl();
    if (message.type === "watch_thread") {
      this.watchedThreads.add(message.threadRef);
      if (this.sharing) this.followThread(message.threadRef);
      return;
    }
    if (message.type === "unwatch_thread") {
      // A view opened before the launch bound the thread watched it by its run id; the room now
      // names T3 Code's id. Both are the same thread.
      const thread = this.roomThreadRef(message.threadRef);
      const refs = new Set([message.threadRef, ...[...this.watchedThreads].filter((ref) => this.roomThreadRef(ref) === thread)]);
      for (const ref of refs) {
        this.watchedThreads.delete(ref);
        threads?.unwatch?.(ref);
      }
      return;
    }
    const ref = this.roomThreadRef(message.threadRef);
    const why = (error: unknown) =>
      !this.sharing ? "sharing_stopped" : (error as { reason?: string })?.reason === "t3_unavailable" ? "t3_unavailable" : ((error as Error)?.message ?? "failed").slice(0, 300);
    // Not in the command queue: a slow read from T3 Code mustn't hold up a terminal's input.
    if (message.type === "thread_history") {
      void (async () => {
        try {
          if (!this.sharing || !threads?.history) throw new Error(this.sharing ? "t3_unavailable" : "sharing_stopped");
          const page = await threads.history(message.threadRef, message.beforeItemId);
          const { items, left } = newestThatFit(page.items);
          await this.emit({ v: 1, type: "thread_history_page", threadRef: ref, requestId: message.requestId, items, older: page.older || left });
        } catch (error) {
          await this.emit({ v: 1, type: "thread_history_page", threadRef: ref, requestId: message.requestId, items: [], older: false, error: why(error) });
        }
      })().catch(() => {});
      return;
    }
    void (async () => {
      try {
        if (!this.sharing || !threads?.diff) throw new Error(this.sharing ? "t3_unavailable" : "sharing_stopped");
        const { diff, cut } = await threads.diff(message.threadRef, message.turn);
        await this.emit({ v: 1, type: "thread_diff", threadRef: ref, requestId: message.requestId, diff, ...(cut ? { cut } : {}) });
      } catch (error) {
        await this.emit({ v: 1, type: "thread_diff", threadRef: ref, requestId: message.requestId, error: why(error) });
      }
    })().catch(() => {});
  }
  private flush(terminal: Terminal) {
    clearTimeout(terminal.timer);
    terminal.timer = undefined;
    if (!terminal.shared || !terminal.output) return;
    // Convex refuses a string with an unpaired surrogate, and with it the whole batch, which would stop
    // sharing: whatever cut the output (a buffer's trim, a split pair), it goes out well formed.
    const data = terminal.output.toWellFormed();
    terminal.output = "";
    void this.emit({
      v: 1,
      type: "terminal_output",
      terminalId: terminal.id,
      seq: ++terminal.seq,
      data,
    });
  }
  /** Terminal starts under way that aren't in `terminals` yet (they await a profile, a Rex tab). */
  private starting = 0;
  /** Counts a start as busy (busyTerminals) from the moment it begins until it's registered or refused. */
  private async counted(start: () => Promise<unknown>) {
    this.starting += 1;
    try {
      await start();
    } finally {
      this.starting -= 1;
    }
  }
  private startTerminal(message: Extract<RoomMessage, { type: "start_terminal" }>, personal = false) {
    return this.counted(() => this.startTerminalNow(message, personal));
  }
  private async startTerminalNow(
    message: Extract<RoomMessage, { type: "start_terminal" }>,
    personal = false,
  ) {
    const stopped = () =>
      personal
        ? undefined
        : this.emit({
            v: 1,
            type: "terminal_start_failed",
            terminalId: message.terminalId,
            reason: "sharing_stopped",
          });
    if (!this.sharing) return stopped();
    if (this.terminals.has(message.terminalId)) return;
    if (!personal && this.refusesStart(message.startedBy, message.accountable)) {
      await this.emit({ v: 1, type: "terminal_start_failed", terminalId: message.terminalId, reason: "owner_only" });
      return;
    }
    // A profile only under a harness that keeps its logins apart from the machine setup, whatever the room asks.
    if (message.profileId !== undefined && !PROFILE_HARNESSES.has(message.harness ?? "")) {
      await this.emit({
        v: 1,
        type: "terminal_start_failed",
        terminalId: message.terminalId,
        reason: "profile_not_supported",
      });
      return;
    }
    // Slot use is decided here, from who the machine belongs to, never from the room's `usesSlot`.
    const usesSlot =
      !personal &&
      (this.options.belongsTo == null || message.startedBy.memberId !== this.options.belongsTo);
    if (
      usesSlot &&
      [...this.terminals.values()].filter((t) => t.usesSlot).length >= this.options.limits.slots
    ) {
      await this.emit({
        v: 1,
        type: "terminal_start_failed",
        terminalId: message.terminalId,
        reason: "no_free_slot",
      });
      return;
    }
    await this.expireProfiles();
    if (!["watch", "suggest", "drive", "open"].includes(message.access))
      throw new Error("Invalid access");
    const host = this.options.terminalHost ?? nodePtyHost;
    const profileGone = () =>
      this.emit({ v: 1, type: "terminal_start_failed", terminalId: message.terminalId, reason: "profile_expired" });
    // From the profile check until the terminal is registered, the profile queue is held, so expiry
    // can't delete the profile in between and leave behind a terminal (and folders) it doesn't know.
    // On Windows the spawn mustn't overlap a kill that is ending a shell (node-pty 1.1.0 can crash
    // then, `PtyGate`). That wait comes before the profile queue, so expiry and deletion never wait
    // behind a kill; if a kill started meanwhile, the queue is let go and the wait starts over.
    // A terminal that starts Claude Code gets the bridge's hooks for that session (ADR 0026).
    const oneShot = message.harness === "shell" && message.command !== undefined;
    let runCommand = message.command;
    if (runCommand !== undefined && !oneShot && isCommand(runCommand, "claude")) {
      const file = await this.writeClaudeHooks();
      if (file) runCommand = withClaudeSettings(runCommand, file, { ...process.env, ...this.options.env });
    }
    // And one that starts Codex runs it on an app server of its own, with the bridge's hooks (ADR 0038).
    if (runCommand !== undefined && !oneShot && this.options.codex && process.platform !== "win32" && isCommand(runCommand, "codex"))
      runCommand = withCodexSession(runCommand, this.options.codex.bridgeCommand ?? bridgeCommand({ ...process.env, ...this.options.env }));
    let release = () => {};
    let profileEnv: Record<string, string> = {};
    for (;;) {
      await host.whenIdle?.();
      if (message.profileId !== undefined) {
        release = await this.holdProfiles();
        if (!this.profileUsable(message.profileId)) {
          release();
          await profileGone();
          return;
        }
        try {
          profileEnv = await this.profiles.environment(message.profileId);
        } catch (error) {
          // A failed folder read or write must not keep the queue: expiry and deletion wait on it.
          release();
          throw error;
        }
      }
      if (host.isIdle?.() ?? true) break;
      release();
    }
    let baseEnv: NodeJS.ProcessEnv;
    let command: string;
    let terminal: Terminal;
    try {
      if (!this.sharing) return stopped();
      // Checked again right before the spawn, after the last wait: the profile may have expired meanwhile.
      if (message.profileId !== undefined && !this.profileUsable(message.profileId)) {
        release();
        await profileGone();
        return;
      }
      const localRef = message.terminalId;
      // A profile terminal signs in with the profile's own logins, never the machine's.
      baseEnv = message.profileId === undefined
        ? { ...process.env, ...this.options.env }
        : withoutMachineAuth({ ...process.env, ...this.options.env });
      // A command the room asks a plain shell to run gets the person's shell setup (platform.ts).
      const noColor = oneShot || message.noColor === true;
      const shell = terminalShell(runCommand, baseEnv, process.platform, { userShell: oneShot });
      // The room and the adapters see the command it asked for, without the hooks' settings.
      command = message.command ?? shell.label;
      // `uplink-bridge` must be on a terminal's PATH for Claude Code's hooks to reach this bridge, and
      // the terminal's secret in its environment, for them to act as this terminal (`asTerminal`).
      const secret = this.options.terminalSecret?.() ?? randomBytes(32).toString("base64url");
      const env = prependPath(
        {
          ...baseEnv,
          ...profileEnv,
          ...(noColor ? plainColors : {}),
          UPLINK_TERMINAL_REF: message.terminalId,
          UPLINK_TERMINAL_SECRET: secret,
          UPLINK_BRIDGE_SOCKET: this.socketPath,
        },
        baseEnv.UPLINK_BRIDGE_BIN_DIR,
      );
      if (noColor) delete env.FORCE_COLOR;
      const child = host.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: expandHome(message.cwd) ?? process.cwd(),
        env,
      });
      terminal = {
        id: message.terminalId,
        localRef,
        secret,
        process: child,
        access: minAccess(message.access, this.options.limits.mostOpenAccess),
        startedBy: message.startedBy,
        driver: message.startedBy,
        usesSlot,
        roomStarted: !personal,
        profileId: message.profileId,
        shared: true,
        seq: 0,
        output: "",
        exited: new Promise<void>((exited) => child.onExit(() => exited())),
        cwd: expandHome(message.cwd) ?? process.cwd(),
      };
      const started = terminal;
      this.terminals.set(started.id, started);
      this.live.add(started);
      void started.exited.then(() => this.live.delete(started));
    } finally {
      release();
    }
    const { localRef } = terminal;
    const child = terminal.process;
    const adapter = this.options.adapters?.find((a) => a.matches(command));
    void this.emit({
      v: 1,
      type: "terminal_started",
      ...(personal ? {} : { terminalId: terminal.id }),
      localRef,
      title: command,
      tool: adapter?.name ?? "shell",
      cwd: message.cwd,
      access: terminal.access,
    });
    void this.emit({
      v: 1,
      type: "run_state_changed",
      source: { kind: "terminal", terminalId: terminal.id },
      state: "unknown",
    });
    terminal.adapter = adapter?.start?.({
      command,
      cwd: expandHome(message.cwd) ?? process.cwd(),
      env: { ...baseEnv, ...profileEnv },
      report: (update) => {
        if (terminal.shared)
          void this.emit({
            v: 1,
            type: "run_state_changed",
            source: { kind: "terminal", terminalId: terminal.id },
            ...update,
          });
      },
    });
    // And one that starts Hermes Agent follows its session on the profile's gateway (ADR 0040).
    if (runCommand !== undefined && !oneShot && this.options.hermes && process.platform !== "win32" && isCommand(runCommand, "hermes") && child.ptsName)
      void this.followHermes(terminal, hermesHome({ ...baseEnv, ...profileEnv }, runCommand), child.ptsName);
    if (terminal.access !== message.access)
      void this.emit({
        v: 1,
        type: "terminal_access",
        terminalId: terminal.id,
        access: terminal.access,
      });
    child.onData((data) => {
      if (!terminal.shared) return;
      terminal.output += data;
      if (Buffer.byteLength(terminal.output) >= 16384) this.flush(terminal);
      else terminal.timer ??= setTimeout(() => this.flush(terminal), 30);
    });
    child.onExit(({ exitCode, signal }) => {
      this.cancelHook(terminal.id);
      this.endCodex(terminal);
      this.endHermes(terminal);
      this.dropInbox(terminal);
      terminal.adapter?.close();
      this.flush(terminal);
      this.terminals.delete(terminal.id);
      if (terminal.shared)
        void this.emit({
          v: 1,
          type: "terminal_ended",
          terminalId: terminal.id,
          // A shell reports a process killed by signal N as 128 + N; node-pty gives exitCode 0 and the
          // signal. It goes in exitCode, not the message's signal field, because a room from before
          // that field refuses the whole message (bridge.send validates strictly).
          exitCode: signal ? 128 + signal : exitCode,
          reason: "exited",
        });
      terminal.shared = false;
    });
  }
  /** Starts a run the room asked for "In Rex": a new Rex tab whose host runs the command (ADR 0019). */
  private startRexTerminal(message: Extract<RoomMessage, { type: "start_terminal" }>) {
    return this.counted(() => this.startRexTerminalNow(message));
  }
  private async startRexTerminalNow(message: Extract<RoomMessage, { type: "start_terminal" }>) {
    const fail = (reason: string) =>
      this.emit({ v: 1, type: "terminal_start_failed", terminalId: message.terminalId, reason });
    if (this.terminals.has(message.terminalId)) return;
    // The machine's own check, as for a plain terminal (`startTerminal`, ADR 0025).
    if (this.refusesStart(message.startedBy, message.accountable)) return fail("owner_only");
    if (!this.rexTabs?.available()) return fail("rex_unavailable");
    // The tab gets Rex's own environment, where a profile's logins can't be kept apart from the machine's.
    if (message.profileId !== undefined) return fail("profile_not_supported");
    if (!["watch", "suggest", "drive", "open"].includes(message.access)) throw new Error("Invalid access");
    // Slots are decided here as for every room-started terminal (see `startTerminal`).
    const usesSlot = this.options.belongsTo == null || message.startedBy.memberId !== this.options.belongsTo;
    if (usesSlot && [...this.terminals.values()].filter((t) => t.usesSlot).length >= this.options.limits.slots)
      return fail("no_free_slot");
    const oneShot = message.harness === "shell" && message.command !== undefined;
    let host: HostLink;
    try {
      host = await this.rexTabs.open({
        terminalId: message.terminalId,
        command: message.command,
        cwd: message.cwd,
        title: message.title,
        // As in a plain terminal (`startTerminal`): a shell's one-shot command runs in the person's own
        // shell setup, and it and a shell an agent opens run without colors.
        userShell: oneShot,
        noColor: oneShot || message.noColor === true,
      });
    } catch (error) {
      return fail(error instanceof RexTabError ? error.reason : "rex_tab_failed");
    }
    if (!this.sharing || this.closing) {
      host.send({ type: "kill" });
      return fail("sharing_stopped");
    }
    this.shareHost(host, {
      id: message.terminalId,
      localRef: message.terminalId,
      roomAsked: true,
      access: message.access,
      startedBy: message.startedBy,
      usesSlot,
      roomStarted: true,
      ownsProgram: true,
    });
  }
  /** Shares a Rex tab the bridge found, for the room (`share_rex_tab`). Its program stays the person's. */
  private async shareRexTab(message: Extract<RoomMessage, { type: "share_rex_tab" }>) {
    const fail = (reason: string) =>
      this.emit({ v: 1, type: "terminal_start_failed", terminalId: message.terminalId, reason });
    if (this.terminals.has(message.terminalId)) return;
    if (!this.rexTabs?.available()) return fail("rex_unavailable");
    const host = this.rexTabs.hosts.get(message.tabRef);
    if (!host || host.ended) return fail("rex_tab_not_found");
    if (this.rexTabs.sharedAs.has(host.tabRef)) return fail("rex_tab_shared");
    if (!["watch", "suggest", "drive", "open"].includes(message.access)) throw new Error("Invalid access");
    this.shareHost(host, {
      id: message.terminalId,
      localRef: host.tabRef,
      roomAsked: true,
      access: message.access,
      startedBy: message.sharedBy,
      usesSlot: false,
      roomStarted: false,
      ownsProgram: false,
    });
  }
  /**
   * Shares a Rex tab from the machine itself (`uplink-bridge share-rex`). As with `share`, the room
   * links it and counts whoever linked the machine as its starter and driver. Returns its local ref.
   */
  shareRexTabLocally(target: string, access?: Access) {
    let ref = "";
    return this.enqueue(async () => {
      if (!this.sharing)
        throw new RexRequestError("Sharing has stopped. Restart the bridge, or resume sharing from the room if it was stopped there.");
      if (!this.rexTabs?.available()) throw new RexRequestError("Rex tabs aren't available here: no Rex CLI, or this is Windows.");
      const host = this.rexTabs.find(target);
      if (!host) throw new RexRequestError(`No shareable Rex tab matches ${target}. List them with uplink-bridge rex-tabs.`);
      if (this.rexTabs.sharedAs.has(host.tabRef)) throw new RexRequestError("That Rex tab is already shared.");
      this.shareHost(host, {
        id: host.tabRef,
        localRef: host.tabRef,
        roomAsked: false,
        access: minAccess(access ?? this.options.limits.mostOpenAccess, this.options.limits.mostOpenAccess),
        startedBy: { memberId: this.options.linkedBy ?? "local", name: "Local" },
        usesSlot: false,
        roomStarted: false,
        ownsProgram: false,
      });
      ref = host.tabRef;
      await this.outgoing;
    }).then(() => ref);
  }
  /** Stops sharing a Rex tab from the machine (`uplink-bridge unshare-rex`). Its program keeps running. */
  unshareRexTabLocally(target: string) {
    return this.enqueue(async () => {
      const host = this.rexTabs?.find(target);
      const ref = host && this.rexTabs!.sharedAs.get(host.tabRef);
      const terminal = ref === undefined ? undefined : this.terminals.get(ref);
      if (!terminal) throw new RexRequestError(`No shared Rex tab matches ${target}.`);
      // A run the room started owns its program, so ending its share would end the run (as rex.stopSharing refuses too).
      if (terminal.ownsProgram)
        throw new RexRequestError("That Rex tab is a run the room started, and unsharing it would end it. Stop the run in the room instead.");
      await this.end(terminal);
      await this.outgoing;
    });
  }
  /**
   * How many terminals closing this bridge would end: every running terminal except Rex tabs the
   * person opened, whose programs outlive the bridge (ADR 0019), and every start still under way.
   * The app restarts itself to update only while this is 0 (apps/desktop/src/main/updateSpec.ts).
   */
  busyTerminals() {
    let count = this.starting;
    for (const terminal of this.terminals.values()) if (terminal.ownsProgram !== false) count += 1;
    return count;
  }
  /** The Rex tabs this bridge can share, with the terminal sharing each (`uplink-bridge rex-tabs`). */
  rexTabList() {
    return this.rexTabs?.list() ?? [];
  }
  /** A `rex-host` connected over the private local socket. */
  rexHost(socket: Socket, hello: HostHello, rest: string) {
    if (
      !this.rexTabs?.available() ||
      this.closing ||
      typeof hello.session !== "string" ||
      typeof hello.block !== "string" ||
      !Number.isFinite(hello.cols) ||
      !Number.isFinite(hello.rows)
    ) {
      socket.destroy();
      return;
    }
    this.rexTabs.attach(socket, hello, rest);
  }
  /**
   * Shares a host's tab as a terminal: its output, the driver's input, its size and its exit, with
   * the tab's Rex program status as the run's state (Rex's events on the tab's block).
   */
  private shareHost(
    host: HostLink,
    share: {
      id: string;
      localRef: string;
      /** The room asked for it, so `terminal_started` names its room id. */
      roomAsked: boolean;
      access: Access;
      startedBy: ActorRef;
      usesSlot: boolean;
      roomStarted: boolean;
      ownsProgram: boolean;
    },
  ) {
    const rexTabs = this.rexTabs!;
    const child = rexTabs.process(host, { ownsProgram: share.ownsProgram });
    const terminal: Terminal = {
      id: share.id,
      localRef: share.localRef,
      process: child,
      access: minAccess(share.access, this.options.limits.mostOpenAccess),
      startedBy: share.startedBy,
      driver: share.startedBy,
      usesSlot: share.usesSlot,
      roomStarted: share.roomStarted,
      shared: true,
      seq: 0,
      output: "",
      exited: new Promise<void>((exited) => host.onEnded(() => exited())),
      rex: host,
      ownsProgram: share.ownsProgram,
    };
    this.terminals.set(terminal.id, terminal);
    // Only a program the bridge may end is waited for as its own (profile cleanup, `close`).
    if (share.ownsProgram) {
      this.live.add(terminal);
      void terminal.exited.then(() => this.live.delete(terminal));
    }
    rexTabs.sharedAs.set(host.tabRef, terminal.id);
    void this.emit({
      v: 1,
      type: "terminal_started",
      ...(share.roomAsked ? { terminalId: terminal.id } : {}),
      localRef: terminal.localRef,
      title: host.hello.command,
      tool: "rex",
      cwd: host.hello.cwd,
      access: terminal.access,
      // Which Rex tab it is, so the room doesn't depend on `rex_found` arriving first.
      ...(this.features.has(REX_FEATURE) ? { rex: { sessionRef: host.sessionRef, tabRef: host.tabRef } } : {}),
    });
    void this.emit({ v: 1, type: "run_state_changed", source: { kind: "terminal", terminalId: terminal.id }, state: "unknown" });
    if (share.roomAsked && terminal.access !== share.access)
      void this.emit({ v: 1, type: "terminal_access", terminalId: terminal.id, access: terminal.access });
    void this.emit({ v: 1, type: "terminal_size", terminalId: terminal.id, cols: host.cols, rows: host.rows });
    let disposers: { dispose(): void }[] = [];
    terminal.release = () => {
      for (const disposer of disposers.splice(0)) disposer.dispose();
      if (rexTabs.sharedAs.get(host.tabRef) === terminal.id) rexTabs.sharedAs.delete(host.tabRef);
      for (const [roomId, ref] of this.linked) if (ref === terminal.id) this.linked.delete(roomId);
      rexTabs.report();
    };
    // Before the exit listener, which closes it: a host whose program already ended (a run that exited
    // before `open` returned) calls that listener at once, and gets no adapter at all.
    if (!host.ended)
      terminal.adapter = new RexAdapter({
        executable: this.options.rex?.executable,
        target: host.sessionRef,
        block: host.tabRef,
      }).start({
        command: host.hello.command,
        cwd: host.hello.cwd,
        env: { ...process.env, ...this.options.env },
        report: (update) => {
          if (terminal.shared)
            void this.emit({ v: 1, type: "run_state_changed", source: { kind: "terminal", terminalId: terminal.id }, ...update });
        },
      });
    disposers = [
      child.onData((data) => {
        if (!terminal.shared) return;
        terminal.output += data;
        if (Buffer.byteLength(terminal.output) >= 16384) this.flush(terminal);
        else terminal.timer ??= setTimeout(() => this.flush(terminal), 30);
      }),
      host.onSize((cols, rows) => {
        if (terminal.shared) void this.emit({ v: 1, type: "terminal_size", terminalId: terminal.id, cols, rows });
      }),
      child.onExit(({ exitCode }) => {
        this.dropInbox(terminal);
        terminal.adapter?.close();
        this.flush(terminal);
        this.terminals.delete(terminal.id);
        const closed = host.ended?.closed === true;
        if (terminal.shared)
          void this.emit({
            v: 1,
            type: "terminal_ended",
            terminalId: terminal.id,
            // A tab closed in Rex, or Rex quitting, ended the program: someone stopped it.
            ...(closed ? { reason: "stopped" as const } : { exitCode, reason: "exited" as const }),
          });
        terminal.shared = false;
        terminal.release?.();
      }),
    ];
    host.send({ type: "stream", on: true });
    rexTabs.report();
  }
  private async receive(message: RoomMessage) {
    if (message.v !== PROTOCOL_VERSION) throw new Error("Unsupported bridge protocol version");
    if (isSpaceMessage(message)) {
      if (this.spaces) await this.spaces.receive(message, this.sharing && !this.closing);
      else if (message.type === "share_space")
        await this.emit({ v: 1, type: "space_share_failed", spaceId: message.spaceId, reason: "spaces_unavailable" });
      return;
    }
    if (message.type === "room_features") {
      for (const feature of message.features) this.features.add(feature);
      if (this.features.has(REX_FEATURE)) this.rexTabs?.enableReports();
      return;
    }
    if (message.type === "unlink") {
      await this.unlink();
      return;
    }
    if (message.type === "stop_sharing") {
      await this.stopSharing("room");
      return;
    }
    if (message.type === "resume_sharing") {
      this.resumeSharing();
      return;
    }
    // Deleting a profile removes logins from the machine, so stopping sharing never holds it back.
    // (Expiry runs on its own timer, also regardless of sharing.)
    if (message.type === "delete_profile") {
      await this.deleteProfile(message.profileId);
      return;
    }
    // A thread's access and driver are the room's bookkeeping for a thread that goes on in T3 Code
    // while sharing is stopped, so they apply whatever the sharing state (ADR 0021).
    if (message.type === "change_thread_access" || message.type === "thread_driver_changed") {
      await this.threadMessage(message);
      return;
    }
    if (
      message.type === "watch_thread" ||
      message.type === "unwatch_thread" ||
      message.type === "thread_history" ||
      message.type === "thread_diff_request"
    ) {
      this.threadView(message);
      return;
    }
    // Making a profile only prepares folders on this machine; no terminal starts, so it doesn't
    // wait for sharing either. Dropping it while stopped would leave the room's profile "creating"
    // forever, since the command is acknowledged either way.
    if (message.type === "create_profile") {
      if (!Number.isFinite(message.expiresAt)) throw new Error("Invalid profile expiry");
      // A replayed command (after a restart) gets the profile it already made, with its saved expiry.
      const expiresAt = await this.profileTask(async () => {
        const saved = await this.profiles.create(
          message.profileId,
          Math.min(message.expiresAt, this.now() + this.options.limits.longestProfileMs),
        );
        // Before `profile_created`, which a stalled room may never acknowledge.
        this.scheduleExpiry();
        return saved;
      });
      await this.emit({ v: 1, type: "profile_created", profileId: message.profileId, expiresAt });
      await this.expireProfiles();
      return;
    }
    if (!this.sharing) {
      // Say so, rather than leave the room waiting on a terminal that never starts.
      if (message.type === "start_terminal") await this.startTerminal(message);
      if (message.type === "share_rex_tab")
        await this.emit({ v: 1, type: "terminal_start_failed", terminalId: message.terminalId, reason: "sharing_stopped" });
      if (message.type === "start_thread")
        await this.emit({ v: 1, type: "thread_start_failed", runId: message.runId, reason: "sharing_stopped" });
      if (message.type === "send_thread_message")
        await this.emit({ v: 1, type: "thread_message_result", threadRef: this.roomThreadRef(message.threadRef), messageId: message.messageId, status: "failed", error: "sharing_stopped" });
      // A run's messages stay in the room, which fails them once the terminal ends.
      return;
    }
    if (message.type === "run_messages_waiting") {
      this.runMessagesWaiting(message);
      return;
    }
    if (
      message.type === "send_thread_message" ||
      message.type === "interrupt_thread" ||
      message.type === "answer_question" ||
      message.type === "set_thread_mode"
    ) {
      await this.threadInput(message);
      return;
    }
    if (
      message.type === "start_thread" ||
      message.type === "stop_thread" ||
      (message.type === "answer_prompt" && message.source.kind === "thread")
    ) {
      await this.threadMessage(message);
      return;
    }
    if (message.type === "share_rex_tab") {
      await this.shareRexTab(message);
      return;
    }
    if (message.type === "start_terminal" && message.inRex) {
      await this.startRexTerminal(message);
      return;
    }
    if (message.type === "start_terminal") {
      try {
        await this.startTerminal(message);
      } catch {
        await this.emit({
          v: 1,
          type: "terminal_start_failed",
          terminalId: message.terminalId,
          reason: "start_failed",
        });
      }
    }
    if (message.type === "terminal_linked") {
      if (this.terminals.has(message.localRef)) this.linked.set(message.terminalId, message.localRef);
      return;
    }
    const local = (ref: string) => this.terminals.get(this.linked.get(ref) ?? ref);
    const terminal =
      message.type === "answer_prompt" && message.source.kind === "terminal"
        ? local(message.source.terminalId)
        : "terminalId" in message
          ? local(message.terminalId)
          : undefined;
    if (!terminal?.shared) {
      if (message.type === "input")
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: message.terminalId,
          memberId: message.from.memberId,
          reason: "terminal_not_shared",
        });
      return;
    }
    if (message.type === "driver_changed") {
      // Below Drive (after the local clamp) the wheel can only go back to whoever started the
      // terminal, or to whoever the machine belongs to (ADR 0025: a machine set below Drive hands
      // teammates' terminals to its person), so a room can't hand a Watch or Suggest terminal to a
      // teammate and type as them.
      const next = message.driver;
      if (
        !next ||
        accessRank(terminal.access) >= accessRank("drive") ||
        next.memberId === terminal.startedBy.memberId ||
        (typeof this.options.belongsTo === "string" && next.memberId === this.options.belongsTo)
      )
        terminal.driver = next;
      else
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: terminal.id,
          memberId: next.memberId,
          reason: "driver_change_rejected",
        });
    }
    if (message.type === "change_access") {
      if (!["watch", "suggest", "drive", "open"].includes(message.access))
        throw new Error("Invalid access");
      terminal.access = minAccess(message.access, this.options.limits.mostOpenAccess);
      if (terminal.access !== message.access)
        await this.emit({
          v: 1,
          type: "terminal_access",
          terminalId: terminal.id,
          access: terminal.access,
        });
    }
    // The room hears at once; the kill finishes in the background, and other commands don't wait for it.
    if (message.type === "stop_terminal") void this.end(terminal);
    if (message.type === "answer_prompt") {
      // Access limits teammates, never the driver: only the driver's answer counts, and only
      // for the approval that is pending now.
      const pending = this.pendingHooks.get(terminal.id);
      const reason =
        terminal.driver?.memberId !== message.from.memberId
          ? "not_driver"
          : !pending
            ? "no_pending_approval"
            : pending.promptId !== message.promptId
              ? "stale_prompt"
              : undefined;
      if (reason)
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: terminal.id,
          memberId: message.from.memberId,
          reason,
        });
      else pending!.resolve(message.answer);
    }
    if (message.type === "resize_terminal") {
      // The terminal has one size, so as with input only the current driver sets it. The bridge
      // clamps the size itself, whatever the room sends.
      if (terminal.driver?.memberId !== message.from.memberId) {
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: terminal.id,
          memberId: message.from.memberId,
          reason: "not_driver",
        });
      } else if (Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
        terminal.process.resize(
          Math.min(MAX_COLS, Math.max(MIN_COLS, Math.round(message.cols))),
          Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(message.rows))),
        );
      }
    }
    if (message.type === "input") {
      // A Rex tab's program gets its terminal's own replies from Rex, which answers queries even with
      // no Rex app open (ADR 0019). The room's screen answers them too, so its automatic replies, as the
      // room marks them and only in #115's shapes, are dropped here: one answer per query. Typing,
      // marked or not, always passes.
      if (terminal.rex && message.reply === true && isTerminalReplies(message.data)) return;
      // At every access level, only the current driver's input reaches the terminal.
      if (terminal.driver?.memberId !== message.from.memberId || !this.sharing) {
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: terminal.id,
          memberId: message.from.memberId,
          reason: "not_driver",
        });
      } else terminal.process.write(message.data);
    }
  }
  /** The adapter that runs threads (T3 Code), while sharing. */
  private threadControl() {
    return this.adapterHandles.find((handle) => handle.threads)?.threads;
  }
  /**
   * A thread's driver: whoever started a launched thread, or whoever linked the machine for one
   * found there, until the room passes its wheel (`thread_driver_changed`, ADR 0021).
   */
  private threadDriver(threadRef: string) {
    return this.threadDrivers.get(threadRef)?.memberId ?? this.options.linkedBy;
  }
  /** Whoever started a thread: for one found on the machine, whoever linked the machine. */
  private threadStarter(threadRef: string) {
    return this.threadStarters.get(threadRef) ?? this.options.linkedBy;
  }
  private threadAccessOf(threadRef: string): Access {
    return this.threadAccess.get(threadRef) ?? "watch";
  }
  /** Every key a thread is known by: the room names a launched thread by its run id until `thread_bound`. */
  private threadKeys(threadRef: string) {
    const keys = new Set([threadRef]);
    const bound = this.launchedThreads.get(threadRef);
    if (bound) keys.add(bound);
    for (const [runId, threadId] of this.launchedThreads) if (threadId === threadRef) keys.add(runId);
    return [...keys];
  }
  /**
   * While the machine's own limit is below Drive, a personal machine takes the room's terminals and
   * threads only for whoever it belongs to, or for an agent of theirs (`accountable`, ADR 0025). The
   * room refuses them first, by its own setting; this is the machine's own check. A team machine
   * (null) and a pairing that never saved who the machine belongs to (undefined) take them from
   * anyone, as before.
   */
  private refusesStart(startedBy: ActorRef, accountable: ActorRef | undefined): boolean {
    const person = this.options.belongsTo;
    if (typeof person !== "string") return false;
    if (accessRank(this.options.limits.mostOpenAccess) >= accessRank("drive")) return false;
    return startedBy.memberId !== person && accountable?.memberId !== person;
  }
  private async setThreadDriver(threadRef: string, driver: ActorRef | undefined) {
    for (const key of this.threadKeys(threadRef)) {
      if (driver) this.threadDrivers.set(key, driver);
      else this.threadDrivers.delete(key);
    }
    await this.saveThreads();
  }
  /** Sets a thread's access, clamped to the machine's limit, and says so when it was clamped. */
  private async setThreadAccess(threadRef: string, asked: Access) {
    if (!["watch", "suggest", "drive", "open"].includes(asked)) throw new Error("Invalid access");
    const access = minAccess(asked, this.options.limits.mostOpenAccess);
    for (const key of this.threadKeys(threadRef)) this.threadAccess.set(key, access);
    await this.saveThreads();
    if (access !== asked) await this.emit({ v: 1, type: "thread_access", threadRef, access });
  }
  /**
   * Restores the threads the room launched and their drivers, if they were saved for this pairing.
   * Otherwise the file is deleted unread: another pairing's threads, titles and prompts must not
   * reach this room, and its member ids would refuse this room's drivers. A file from an earlier
   * bridge names no pairing, so it's deleted too.
   */
  private async loadThreads() {
    const file = this.options.threadsFile;
    if (!file) return;
    let saved: {
      v?: number;
      machineId?: string;
      teamId?: string;
      drivers?: Record<string, ActorRef>;
      launched?: Record<string, string>;
      /** From ADR 0021 on; a file without them is still version 3. */
      access?: Record<string, Access>;
      starters?: Record<string, string>;
    };
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pairing = this.options.pairing;
    if (saved.v !== 3 || saved.machineId !== pairing?.machineId || saved.teamId !== pairing?.teamId) {
      await rm(file, { force: true });
      return;
    }
    for (const [threadRef, driver] of Object.entries(saved.drivers ?? {})) this.threadDrivers.set(threadRef, driver);
    for (const [runId, threadRef] of Object.entries(saved.launched ?? {})) this.launchedThreads.set(runId, threadRef);
    for (const [threadRef, access] of Object.entries(saved.access ?? {}))
      if (["watch", "suggest", "drive", "open"].includes(access))
        this.threadAccess.set(threadRef, minAccess(access, this.options.limits.mostOpenAccess));
    for (const [threadRef, memberId] of Object.entries(saved.starters ?? {}))
      if (typeof memberId === "string") this.threadStarters.set(threadRef, memberId);
  }
  private async saveThreads() {
    if (!this.options.threadsFile) return;
    await mkdir(dirname(this.options.threadsFile), { recursive: true, mode: 0o700 });
    const saved = {
      v: 3,
      machineId: this.options.pairing?.machineId,
      teamId: this.options.pairing?.teamId,
      drivers: Object.fromEntries(this.threadDrivers),
      launched: Object.fromEntries(this.launchedThreads),
      access: Object.fromEntries(this.threadAccess),
      starters: Object.fromEntries(this.threadStarters),
    };
    await writeFile(this.options.threadsFile, JSON.stringify(saved), { mode: 0o600 });
  }
  private async threadMessage(
    message: Extract<
      RoomMessage,
      { type: "start_thread" | "stop_thread" | "answer_prompt" | "change_thread_access" | "thread_driver_changed" }
    >,
  ) {
    const threads = this.threadControl();
    if (message.type === "change_thread_access") {
      await this.setThreadAccess(message.threadRef, message.access);
      return;
    }
    if (message.type === "thread_driver_changed") {
      // A thread saved by a bridge from before ADR 0021 has no starter here; the room knows it.
      if (message.starterId && !this.threadStarters.has(message.threadRef)) {
        this.threadStarters.set(message.threadRef, message.starterId);
        await this.saveThreads();
      }
      // As for terminals: below Drive (after the local clamp) the wheel only goes back to whoever
      // started the thread, or to whoever the machine belongs to (ADR 0025), so a room can't hand a
      // Watch or Suggest thread to a teammate.
      const next = message.driver;
      if (
        !next ||
        accessRank(this.threadAccessOf(message.threadRef)) >= accessRank("drive") ||
        next.memberId === this.threadStarter(message.threadRef) ||
        (typeof this.options.belongsTo === "string" && next.memberId === this.options.belongsTo)
      )
        await this.setThreadDriver(message.threadRef, next);
      else
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: message.threadRef,
          memberId: next.memberId,
          reason: "driver_change_rejected",
        });
      return;
    }
    if (message.type === "start_thread") {
      if (this.refusesStart(message.startedBy, message.accountable)) {
        await this.emit({ v: 1, type: "thread_start_failed", runId: message.runId, reason: "owner_only" });
        return;
      }
      try {
        if (!threads) throw new ThreadStartError("t3_unavailable", "T3 Code isn't available on this machine.");
        const asked = message.access ?? "watch";
        if (!["watch", "suggest", "drive", "open"].includes(asked)) throw new Error("Invalid access");
        if (message.runtimeMode !== undefined && !isRuntimeMode(message.runtimeMode)) throw new ThreadStartError("mode_unsupported", "Unknown permission mode.");
        const access = minAccess(asked, this.options.limits.mostOpenAccess);
        this.threadStarters.set(message.runId, message.startedBy.memberId);
        this.threadAccess.set(message.runId, access);
        await this.setThreadDriver(message.runId, message.startedBy);
        await threads.start(message, async (threadRef) => {
          this.launchedThreads.set(message.runId, threadRef);
          this.threadStarters.set(threadRef, message.startedBy.memberId);
          this.threadAccess.set(threadRef, access);
          await this.setThreadDriver(threadRef, message.startedBy);
          // Before any report names the thread, so the room binds the run first.
          await this.emit({ v: 1, type: "thread_bound", runId: message.runId, threadRef });
          if (access !== asked) await this.emit({ v: 1, type: "thread_access", threadRef, access });
        });
      } catch (error) {
        await this.emit({
          v: 1,
          type: "thread_start_failed",
          runId: message.runId,
          reason: error instanceof ThreadStartError ? error.reason : "launch_failed",
          detail: (error as Error).message,
        });
      }
      return;
    }
    if (message.type === "stop_thread") {
      // Nothing on its way into the thread may start it again once it is stopped (ADR 0037).
      this.stopDeliveries(this.launchedThreads.get(message.threadRef) ?? message.threadRef);
      // The room has marked the run Stopped. A stop T3 Code refuses or can't receive (it's
      // restarting, or the connection is down) is this thread's failure, never the bridge's: it's
      // reported as `input_rejected` (`stop_failed`), which the room records, and the thread is left
      // to T3 Code. It must not reach `onError`, which closes the room link and every terminal.
      try {
        await threads?.stop(message.threadRef);
      } catch {
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: message.threadRef,
          memberId: this.threadDriver(message.threadRef) ?? "local",
          reason: "stop_failed",
        });
      }
      return;
    }
    if (message.source.kind !== "thread") return;
    const threadRef = message.source.threadRef;
    // As with terminals, only the driver's answer counts, and only for the approval pending now.
    // `input_rejected` names the thread in `terminalId`. An answer that fails is reported the same
    // way (`answer_failed`), not as a bridge error.
    const reason =
      this.threadDriver(threadRef) !== message.from.memberId
        ? "not_driver"
        : ((await threads?.answer(threadRef, message.promptId, message.answer).catch(() => "answer_failed" as const)) ??
          (threads ? undefined : "no_pending_approval"));
    if (reason)
      await this.emit({
        v: 1,
        type: "input_rejected",
        terminalId: threadRef,
        memberId: message.from.memberId,
        reason,
      });
  }
  /**
   * A thread driver's input (ADR 0023): a message, stopping the turn, or a question's answer. As
   * with terminal input, only the thread's driver's counts; anyone else gets `not_driver`.
   */
  private async threadInput(
    message: Extract<RoomMessage, { type: "send_thread_message" | "interrupt_thread" | "answer_question" | "set_thread_mode" }>,
  ) {
    const threads = this.threadControl();
    const ref = this.roomThreadRef(message.threadRef);
    const notDriver = this.threadDriver(message.threadRef) !== message.from.memberId;
    if (message.type === "set_thread_mode") {
      // The driver's choice (ADR 0043), or a lower mode from anyone: the machine's cap lowers a
      // thread whoever drives it, and asking for less is never a risk.
      const current = this.threadModes.get(ref)?.mode;
      const lowering = current !== undefined && runtimeModeRank(message.runtimeMode) < runtimeModeRank(current);
      let reason: string | undefined;
      if (!isRuntimeMode(message.runtimeMode)) reason = "mode_failed";
      else if (notDriver && !lowering) reason = "not_driver";
      else if (!threads?.setMode) reason = "t3_unavailable";
      else reason = await threads.setMode(message.threadRef, message.runtimeMode).then(() => undefined, () => "mode_failed");
      // The room keeps the mode asked for pending until T3 Code reports it, and drops it when this
      // says it was refused, naming the mode, so the thread shows the one still in effect.
      if (reason)
        await this.emit({
          v: 1,
          type: "input_rejected",
          terminalId: ref,
          memberId: message.from.memberId,
          reason,
          ...(isRuntimeMode(message.runtimeMode) ? { runtimeMode: message.runtimeMode } : {}),
        });
      // The thread had that mode already, so T3 Code reports no change: say it again for the room.
      else if (current === message.runtimeMode) this.tellThreadMode(ref);
      return;
    }
    if (message.type === "send_thread_message") {
      let error: string | undefined;
      if (notDriver) error = "not_driver";
      else if (!threads?.send) error = "t3_unavailable";
      else if (!message.text.trim() && !message.attachments?.length) error = "empty";
      if (error || !threads?.send) {
        await this.emit({ v: 1, type: "thread_message_result", threadRef: ref, messageId: message.messageId, status: "failed", error: error ?? "t3_unavailable" });
        return;
      }
      // Files can take minutes to move, and the room's commands for this machine wait on each other:
      // a message with files, or one behind it, goes on its own, after the thread's earlier messages,
      // so a stop or an answer for any run is handled meanwhile (ADR 0043).
      // A stop counts against every message the room had sent before it, so the baseline is taken
      // now, not when the message's turn in the line comes.
      const baseline = { stops: this.threadStopsOf(message.threadRef), sharingStops: this.sharingStops };
      const before = this.threadSends.get(ref);
      const sending = (before ?? Promise.resolve()).then(() => this.sendToThread(threads, message, baseline));
      if (!before && !message.attachments?.length) return await sending;
      const tracked = sending.finally(() => {
        if (this.threadSends.get(ref) === tracked) this.threadSends.delete(ref);
      });
      this.threadSends.set(ref, tracked);
      return;
    }
    let reason: string | undefined;
    if (notDriver) reason = "not_driver";
    else if (message.type === "interrupt_thread")
      reason = threads?.interrupt
        ? await threads.interrupt(message.threadRef).then(
            (stopped) => (stopped ? undefined : "nothing_running"),
            () => "stop_failed",
          )
        : "t3_unavailable";
    else
      reason = threads?.answerQuestion
        ? await threads.answerQuestion(message.threadRef, message.promptId, message.answers).catch(() => "answer_failed" as const)
        : "no_pending_question";
    if (reason) await this.emit({ v: 1, type: "input_rejected", terminalId: ref, memberId: message.from.memberId, reason });
  }
  /**
   * Sends a driver's message into its thread and tells the room how it went. Whether it is still
   * wanted is asked again right before T3 Code gets it, after its files moved: not once the run was
   * stopped or its thread closed, sharing stopped, or the sender no longer drives the thread.
   */
  private async sendToThread(
    threads: ThreadControl,
    message: RoomMessageOf<"send_thread_message">,
    { stops, sharingStops }: { stops: number; sharingStops: number },
  ): Promise<void> {
    const ref = this.roomThreadRef(message.threadRef);
    const unwanted = (): string | undefined =>
      !this.sharing || this.closing || this.sharingStops !== sharingStops
        ? "sharing_stopped"
        : this.threadStopsOf(message.threadRef) !== stops
          ? "run_stopped"
          : this.threadDriver(message.threadRef) !== message.from.memberId
            ? "not_driver"
            : undefined;
    let status: "sent" | "queued" | "failed" = "failed";
    let error = unwanted();
    if (!error)
      try {
        status = await threads.send!(message.threadRef, {
          messageId: message.messageId,
          text: message.text.slice(0, 100_000),
          ...(message.attachments?.length ? { files: message.attachments.slice(0, MAX_MESSAGE_FILES) } : {}),
          wanted: () => !unwanted(),
        });
      } catch (failure) {
        error =
          unwanted() ??
          ((failure as { reason?: string }).reason === "t3_unavailable" ? "t3_unavailable" : ((failure as Error).message ?? "failed")).slice(0, 300);
      }
    await this.emit({ v: 1, type: "thread_message_result", threadRef: ref, messageId: message.messageId, status, ...(error ? { error } : {}) });
  }
  /** How many times the run in a thread (by either of the room's refs for it) stopped or its thread closed. */
  private threadStopsOf(threadRef: string): number {
    return this.threadStops.get(this.launchedThreads.get(threadRef) ?? threadRef) ?? 0;
  }
  /** Starts a terminal's kill, once; the promise settles when the kill is done (on Windows, in the background). */
  private stop(terminal: Terminal): Promise<void> {
    terminal.killed ??= Promise.resolve(terminal.process.kill());
    return terminal.killed;
  }
  /**
   * Ends a terminal here; the promise settles when its kill is done. It stays in `live` until its
   * process exits.
   */
  private end(terminal: Terminal): Promise<void> {
    this.cancelHook(terminal.id);
    this.dropInbox(terminal);
    this.flush(terminal);
    const wasShared = terminal.shared;
    terminal.shared = false;
    terminal.adapter?.close();
    // A Rex tab the person opened only stops sending its output (`RexTabs.process`); its program stays.
    const killed = this.stop(terminal);
    terminal.release?.();
    this.terminals.delete(terminal.id);
    if (wasShared)
      void this.emit({ v: 1, type: "terminal_ended", terminalId: terminal.id, reason: "stopped" });
    return killed;
  }
  /**
   * Stops sharing every terminal. A stop made on the machine (`by: "machine"`, the default)
   * can't be undone by the room; only a restart shares again.
   */
  async stopSharing(by: "machine" | "room" = "machine") {
    if (by === "machine") this.resumable = false;
    else if (this.sharing) this.resumable = true;
    this.sharing = false;
    this.sharingStops++;
    for (const id of this.pendingHooks.keys()) this.cancelHook(id);
    this.dropThreadDeliveries();
    for (const handle of this.adapterHandles.splice(0)) handle.close();
    // Every Space view is cut at once too; the room hears that each Space ended.
    void this.spaces?.stopAll("stopped");
    // Cut off every terminal before any network operation can yield.
    for (const terminal of this.terminals.values()) {
      this.dropInbox(terminal);
      terminal.adapter?.close();
      clearTimeout(terminal.timer);
      terminal.output = "";
      const wasShared = terminal.shared;
      terminal.shared = false;
      // A Rex tab is let go either way, so it can be shared again; the person's own keeps running.
      if (terminal.roomStarted || terminal.rex) {
        void this.stop(terminal);
        terminal.release?.();
        this.terminals.delete(terminal.id);
      }
      if (wasShared)
        void this.emit({ v: 1, type: "terminal_ended", terminalId: terminal.id, reason: "stopped" });
    }
  }
  private resumeSharing() {
    if (this.sharing || !this.resumable || this.closing) return;
    this.sharing = true;
    this.resumable = false;
    this.startAdapterBridges();
  }
  setSocketPath(path: string) {
    this.socketPath = path;
  }
  private cancelHook(id: string) {
    const pending = this.pendingHooks.get(id);
    this.pendingHooks.delete(id);
    if (pending) (pending.cancel ?? (() => pending.resolve("deny")))();
  }
  async hook(
    terminalId: string,
    secret: unknown,
    event: string,
    payload: HookPayload,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Only the terminal's own processes know its secret: anything else naming it is denied.
    const terminal = this.asTerminal(terminalId, secret);
    if (!terminal) return event === "PermissionRequest" ? hookDecision("deny") : {};
    const update = hookUpdate(event, payload);
    if (!update) return {};
    this.cancelHook(terminalId);
    const inbox = this.inboxOf(terminal);
    // A subagent's tool calls run the same hooks, with agent_id in their input. They say nothing
    // about the main session: a background subagent works on after the main session's turn ended,
    // and the idle session's waiter must still wake it. Nor does a subagent take the run's messages:
    // what it is handed reaches only the subagent, not the run the message was for.
    const subagent = typeof payload.agent_id === "string" && payload.agent_id !== "";
    if (event !== "PermissionRequest") {
      // Not awaited: a hook runs after every tool call, and the room's answer mustn't hold the session up.
      void this.emit({
        v: 1,
        type: "run_state_changed",
        source: { kind: "terminal", terminalId },
        ...update,
      });
      if (subagent) return {};
      // A turn ended: a message from now on goes to the idle session's waiter, which wakes it.
      if (update.state === "done" || update.state === "failed" || update.state === "waiting") {
        inbox.idle = true;
        this.wake(terminal);
        return {};
      }
      inbox.idle = false;
      const how = DELIVERING_HOOKS[event];
      if (!how) return {};
      this.heard(terminal);
      // A hook has HOOK_TIMEOUT_S: it hands over only a claim whose files are in, never waiting on a download (ADR 0043).
      const handed = await this.claim(terminal, how, ANSWER_HINT, "hook");
      if (!handed) return {};
      // The hook went (its socket closed) or the terminal stopped being shared while the room answered.
      if (signal?.aborted || !terminal.shared || !this.sharing) {
        this.settleClaim(handed.ack, "released");
        return {};
      }
      this.handedOver(handed.ack);
      return { hookSpecificOutput: { hookEventName: event, additionalContext: handed.text }, [ACK_FIELD]: handed.ack };
    }
    if (!subagent) inbox.idle = false;
    const promptId = randomUUID();
    return new Promise((resolve) => {
      const abort = () => this.cancelHook(terminalId);
      this.pendingHooks.set(terminalId, {
        promptId,
        resolve: (answer) => {
          this.pendingHooks.delete(terminalId);
          signal?.removeEventListener("abort", abort);
          resolve(hookDecision(answer));
          if (terminal.shared && this.sharing)
            void this.emit({
              v: 1,
              type: "run_state_changed",
              source: { kind: "terminal", terminalId },
              state: answer === "allow" ? "working" : "unknown",
            });
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else
        void this.emit({
          v: 1,
          type: "run_state_changed",
          source: { kind: "terminal", terminalId },
          ...update,
          ...(update.prompt ? { prompt: { ...update.prompt, promptId } } : {}),
        });
    });
  }
  /**
   * Writes the Claude Code hooks file (`claudeHooks.ts`) before each terminal that starts `claude`,
   * so a file removed meanwhile is back. Without the option, or when it can't be written, the
   * terminal starts without hooks: its run then hears messages only through hooks of its own.
   */
  private async writeClaudeHooks(): Promise<string | undefined> {
    const hooks = this.options.claudeHooks;
    if (!hooks) return undefined;
    try {
      const words = hooks.bridgeCommand ?? bridgeCommand({ ...process.env, ...this.options.env });
      await mkdir(dirname(hooks.file), { recursive: true, mode: 0o700 });
      await writeFile(hooks.file, JSON.stringify(claudeHooksSettings(words), null, 2) + "\n", { mode: 0o600 });
      return hooks.file;
    } catch {
      return undefined;
    }
  }
  /**
   * The run in one of this bridge's terminals posts as itself (`uplink-bridge say` and `reply`, ADR
   * 0026): the room finds the terminal's live run and posts as its driver. The terminal is the one
   * whose `UPLINK_TERMINAL_REF` the command ran with. Refusals come back as the room wrote them.
   */
  async say(terminalId: string, secret: unknown, request: RunSayRequest, signal?: AbortSignal): Promise<RunSaid> {
    const terminal = this.asTerminal(terminalId, secret);
    if (!terminal) throw new LocalRequestError("This terminal isn't shared with the room, so it can't post as a run.");
    if (!this.options.link.say || !this.roomFeatures.has("run_say"))
      throw new LocalRequestError("This room is too old to take messages from runs. Its backend needs an update first.");
    return await this.postAsRun({ terminalRef: terminal.id }, request, signal);
  }
  /**
   * Posts for a run (ADR 0026), first uploading any files it sends with the message (ADR 0047), each
   * to its own URL from `bridge:runAttachUrl`. A file that fails fails the message: nothing is posted.
   * Nor is it once `signal` says the command stopped waiting, so a retry can't post it twice.
   */
  private async postAsRun(ref: RunRef, { files, ...request }: RunSayRequest, signal?: AbortSignal): Promise<RunSaid> {
    const link = this.options.link;
    try {
      let attachments: RunSayAttachment[] | undefined;
      if (files?.length) {
        if (!link.attachUrl || !this.roomFeatures.has("run_say_files"))
          throw new LocalRequestError("This room is too old to take files from runs. Its backend needs an update first; send the text alone meanwhile.");
        attachments = await uploadRunFiles(files, () => link.attachUrl!(ref), this.options.fetch, signal);
        stillWanted(signal);
      }
      // Whatever the run quotes, a run key in it never reaches room chat (ADR 0037).
      return await link.say!({ ...this.hideKeys({ ...ref, ...request }), ...(attachments ? { attachments } : {}) });
    } catch (error) {
      // Includes a file that can't go (RunFileError), whose message says why.
      if (error instanceof LocalRequestError) throw error;
      const message = (error as { data?: { message?: unknown } }).data?.message;
      throw new LocalRequestError(typeof message === "string" ? message : "The room didn't take the message. Try again.");
    }
  }
  /**
   * `uplink-bridge codex` started the terminal's Codex on an app server of its own and says where
   * (ADR 0038), or with `ended` that it stopped that server. From then on the terminal's run hears
   * messages through the server, and the session's hooks (`codexHook`) name its thread.
   */
  codexServer(terminalId: string, secret: unknown, request: { socket?: unknown; pid?: unknown; ended?: unknown }): Record<string, never> {
    const terminal = this.asTerminal(terminalId, secret);
    if (!terminal) return {};
    terminal.codex?.close();
    terminal.codex = undefined;
    if (request.ended === true || typeof request.socket !== "string" || !request.socket) return {};
    const pid = typeof request.pid === "number" && Number.isInteger(request.pid) && request.pid > 0 ? request.pid : undefined;
    terminal.codex = new CodexTerminal(request.socket, pid, this.codexHost(terminal));
    this.heard(terminal);
    if (terminal.inbox?.waiting) terminal.codex.kick();
    return {};
  }
  /** What a Codex terminal's delivery needs from the bridge: the room's claims, and the run's state. */
  private codexHost(terminal: Terminal): CodexHost {
    const inbox = this.inboxOf(terminal);
    const live = () => terminal.shared && this.sharing;
    return {
      claim: async (how) => {
        const handed = await this.claim(terminal, how);
        // The terminal stopped being shared while the room answered.
        if (handed && !live()) {
          this.settleClaim(handed.ack, "released");
          return undefined;
        }
        return handed;
      },
      settle: (ack, status, how) => this.settleClaim(ack, status, how),
      waiting: () => inbox.waiting && live(),
      waitAgain: () => void (inbox.waiting = true),
      failed: () => {
        if (live()) void this.emit({ v: 1, type: "run_state_changed", source: { kind: "terminal", terminalId: terminal.id }, state: "failed" });
      },
    };
  }
  /**
   * A Codex hook in one of this bridge's terminals (`uplink-bridge codex-hook EVENT`, `codexHooks.ts`):
   * it names the session's thread, reports the run's state, posts what `say` or `reply` couldn't send
   * from inside Codex's sandbox (`PostToolUse`), and sends an approval to the room (`PermissionRequest`).
   * Answers the JSON Codex reads from the hook; `{}` changes nothing.
   */
  async codexHook(terminalId: string, secret: unknown, event: string, payload: CodexHookPayload, signal?: AbortSignal): Promise<unknown> {
    const terminal = this.asTerminal(terminalId, secret);
    if (!terminal) return {};
    if (typeof payload.session_id === "string" && payload.session_id) terminal.codex?.bind(payload.session_id);
    const update = codexHookUpdate(event, payload);
    // A command running beside one that waits on an approval says it works, which would take the
    // approval out of the room while Codex still waits on it: the room hears Working once it's answered.
    const progress = update?.state === "working" && this.pendingHooks.has(terminal.id);
    if (update && event !== "PermissionRequest" && !progress)
      void this.emit({ v: 1, type: "run_state_changed", source: { kind: "terminal", terminalId: terminal.id }, ...update });
    if (update && event === "PermissionRequest") return this.codexApproval(terminal, update, signal);
    if (event === "PostToolUse") {
      const posted = await this.relay(terminal, payload, signal);
      if (posted) return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: posted } };
    }
    return {};
  }
  /**
   * A Codex approval, answered by the run's driver in the room as a Claude Code one is (README,
   * Adapters). One at a time: another that Codex asks meanwhile, from a command running beside the
   * first, gets no decision, so Codex asks in the terminal. An approval that ends unanswered (the hook
   * timed out, or the terminal ended) also goes back to Codex's own prompt, never to a decision.
   */
  private codexApproval(terminal: Terminal, update: RunUpdate, signal?: AbortSignal): Promise<unknown> {
    if (this.pendingHooks.has(terminal.id) || !update.prompt) return Promise.resolve({});
    const prompt = update.prompt;
    const promptId = randomUUID();
    const source = { kind: "terminal" as const, terminalId: terminal.id };
    const live = () => terminal.shared && this.sharing;
    return new Promise((resolve) => {
      const abort = () => this.cancelHook(terminal.id);
      const settle = (answer: unknown) => {
        signal?.removeEventListener("abort", abort);
        resolve(answer);
      };
      this.pendingHooks.set(terminal.id, {
        promptId,
        resolve: (answer) => {
          this.pendingHooks.delete(terminal.id);
          settle(hookDecision(answer));
          if (live()) void this.emit({ v: 1, type: "run_state_changed", source, state: "working" });
        },
        cancel: () => {
          settle({});
          // Codex now asks in the terminal, where the room can't answer.
          if (live()) void this.emit({ v: 1, type: "run_state_changed", source, state: "waiting", prompt: { kind: "question", text: `${prompt.text} Answer it in the terminal.` } });
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else void this.emit({ v: 1, type: "run_state_changed", source, ...update, prompt: { ...prompt, promptId } });
    });
  }
  /** Posts the requests a command in Codex's sandbox printed for its terminal (`codexRelay.ts`), each once. */
  private async relay(terminal: Terminal, payload: CodexHookPayload, signal?: AbortSignal): Promise<string | undefined> {
    if (!terminal.secret || payload.tool_response === undefined) return undefined;
    const lines: string[] = [];
    for (const request of relayedRequests(terminal.secret, JSON.stringify(payload.tool_response))) {
      const posted = (terminal.relayed ??= new Set());
      if (posted.has(request.nonce)) continue;
      posted.add(request.nonce);
      const { nonce: _nonce, ...say } = request;
      try {
        const said = await this.say(terminal.id, terminal.secret, say, signal);
        lines.push(`Uplink Room: posted as ${said.label} in ${said.place} (message ${said.messageId}).`);
      } catch (error) {
        // A hook that timed out while files uploaded posted nothing, so the same request may post later.
        if (signal?.aborted) posted.delete(request.nonce);
        lines.push(`Uplink Room didn't post it: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return lines.length ? lines.join("\n") : undefined;
  }
  /** Stops delivering to the terminal's Codex; its server goes with the terminal (`endCodex`). */
  private dropCodex(terminal: Terminal) {
    terminal.codex?.close();
  }
  /**
   * The terminal's process exited. `uplink-bridge codex` stops its Codex server and says so before it
   * exits; a server still registered here outlived it (it was killed), so the bridge ends it.
   */
  private endCodex(terminal: Terminal) {
    const pid = terminal.codex?.pid;
    this.dropCodex(terminal);
    terminal.codex = undefined;
    if (pid === undefined || process.platform === "win32") return;
    try {
      // The server runs in its own process group, with the MCP servers it started.
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  /**
   * Follows the session of a terminal started with `hermes` on its profile's gateway (ADR 0040), and
   * writes the launcher its run posts with: Hermes runs the agent's commands in the gateway, with the
   * terminal's PATH but not its `UPLINK_TERMINAL_*` variables, so each delivery names the launcher.
   */
  private async followHermes(terminal: Terminal, home: string, tty: string) {
    const options = this.options.hermes!;
    const launcher = await this.writeLauncher(terminal, options).catch(() => undefined);
    // The terminal ended or stopped being shared while the launcher was written.
    if (this.terminals.get(terminal.id) !== terminal || !terminal.shared) {
      if (launcher) await rm(launcher.dir, { recursive: true, force: true });
      return;
    }
    terminal.launcher = launcher;
    const env = { ...process.env, ...this.options.env };
    const hint = launcher ? launcherAnswerHint(quoteArgument(launcher.file, env)) : ANSWER_HINT;
    terminal.hermes = new HermesTerminal({ home, tty, host: this.hermesHost(terminal, hint), ...(options.pollMs ? { pollMs: options.pollMs } : {}) });
    terminal.hermes.start();
  }
  /** A launcher that runs this bridge's CLI as the terminal's own processes do: with its id, secret and socket. */
  private async writeLauncher(terminal: Terminal, options: NonNullable<BridgeOptions["hermes"]>) {
    if (!terminal.secret || !this.socketPath) return undefined;
    const env = { ...process.env, ...this.options.env };
    const words = options.bridgeCommand ?? bridgeCommand(env);
    const q = (word: string) => quoteArgument(word, env, "linux");
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    const dir = join(options.dir, randomUUID());
    await mkdir(dir, { mode: 0o700 });
    const file = join(dir, "uplink-bridge");
    await writeFile(
      file,
      [
        "#!/bin/sh",
        "# Posts as the run in one terminal an Uplink Room bridge shares (ADR 0040). The bridge removes it when the terminal ends.",
        `UPLINK_TERMINAL_REF=${q(terminal.id)} UPLINK_TERMINAL_SECRET=${q(terminal.secret)} UPLINK_BRIDGE_SOCKET=${q(this.socketPath)}`,
        "export UPLINK_TERMINAL_REF UPLINK_TERMINAL_SECRET UPLINK_BRIDGE_SOCKET",
        `exec ${words.map(q).join(" ")} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    return { file, dir };
  }
  /** What a Hermes terminal's delivery needs from the bridge: the room's claims, and the run's state. */
  private hermesHost(terminal: Terminal, hint: string): HermesHost {
    const inbox = this.inboxOf(terminal);
    const live = () => terminal.shared && this.sharing;
    return {
      claim: async (how) => {
        const handed = await this.claim(terminal, how, hint);
        if (handed && !live()) {
          this.settleClaim(handed.ack, "released");
          return undefined;
        }
        return handed;
      },
      settle: (ack, status, how) => this.settleClaim(ack, status, how),
      waiting: () => inbox.waiting && live(),
      waitAgain: () => void (inbox.waiting = true),
      report: (update) => {
        if (live()) void this.emit({ v: 1, type: "run_state_changed", source: { kind: "terminal", terminalId: terminal.id }, ...update });
      },
      heard: () => this.heard(terminal),
    };
  }
  /** The terminal ended: the bridge stops following its Hermes session and removes its launcher. */
  private endHermes(terminal: Terminal) {
    terminal.hermes?.close();
    terminal.hermes = undefined;
    const launcher = terminal.launcher;
    terminal.launcher = undefined;
    if (launcher) void rm(launcher.dir, { recursive: true, force: true }).catch(() => {});
  }
  private inboxOf(terminal: Terminal): RunInbox {
    return (terminal.inbox ??= new RunInbox());
  }
  /** A terminal by the room's id, or for one shared from the machine, its local ref. */
  private localTerminal(ref: string) {
    return this.terminals.get(this.linked.get(ref) ?? ref);
  }
  /**
   * The room says messages wait for the run in one of this bridge's terminals (ADR 0026). They stay
   * in the room until the session's next hook claims them: a tool call's or prompt's, or the idle
   * session's waiter, which claims them at once and wakes the session. A terminal that isn't shared
   * claims nothing; the room fails its messages once the terminal ends.
   */
  private runMessagesWaiting(message: RoomMessageOf<"run_messages_waiting">) {
    if (message.source.kind === "thread") return this.deliverToThread(message.source.threadRef);
    const terminal = this.localTerminal(message.source.terminalId);
    if (!terminal?.shared) return;
    const inbox = this.inboxOf(terminal);
    inbox.waiting = true;
    inbox.notices++;
    // Codex takes them through its app server at once, idle or not (ADR 0038), and Hermes through its gateway (ADR 0040).
    if (terminal.codex) terminal.codex.kick();
    else if (terminal.hermes) terminal.hermes.kick();
    else if (inbox.idle) this.wake(terminal);
    // A Claude Code turn is running: the bridge claims now, so a message's files move before the
    // next tool call's hook, which then hands them over without waiting (ADR 0043).
    else this.prefetch(terminal);
  }
  /**
   * Claims the messages waiting for a terminal's run mid-turn, before a hook asks, and keeps the
   * claim held until the next hook or the waiter takes it.
   */
  private prefetch(terminal: Terminal) {
    const inbox = this.inboxOf(terminal);
    if (inbox.prefetching || inbox.saving || inbox.ready) return;
    inbox.prefetching = true;
    void this.claim(terminal, "mid_task", ANSWER_HINT, "prefetch").finally(() => (inbox.prefetching = false));
  }
  /**
   * Claims the messages waiting in the room for a terminal's run, for a hook that delivers them
   * `how`. Nothing when none wait, the room doesn't take run messages, or it can't be reached (they
   * keep waiting there for the next hook).
   *
   * A claim with files (ADR 0043) has them saved in the run's workspace first, under the claim's
   * hold. `wait` (Codex, Hermes Agent, the idle session's waiter) waits for them. A Claude Code hook
   * (`hook`) never does: the files move outside it, and it gets nothing until they are in, when the
   * next hook, or the waiter, takes the claim (`inbox.ready`). `prefetch` claims before any hook
   * asks and keeps even a claim with no files held for the next one.
   */
  private async claim(
    terminal: Terminal,
    how: RunMessageHow,
    answerHint = ANSWER_HINT,
    mode: "wait" | "hook" | "prefetch" = "wait",
  ): Promise<Handed | undefined> {
    const inbox = this.inboxOf(terminal);
    while (inbox.acquiring) {
      if (mode !== "wait") return undefined;
      await inbox.acquiring;
    }
    let release!: () => void;
    inbox.acquiring = new Promise<void>((resolve) => (release = resolve));
    try {
      return await this.claimAcquired(terminal, how, answerHint, mode);
    } finally {
      inbox.acquiring = undefined;
      release();
    }
  }
  private async claimAcquired(
    terminal: Terminal,
    how: RunMessageHow,
    answerHint: string,
    mode: "wait" | "hook" | "prefetch",
  ): Promise<Handed | undefined> {
    const inbox = this.inboxOf(terminal);
    if (inbox.saving) {
      if (mode !== "wait") return undefined;
      await inbox.saving;
    }
    const ready = this.takeReady(terminal, how);
    if (ready) return ready;
    const link = this.options.link;
    if (!inbox.waiting || !link.claimRunMessages || !this.roomFeatures.has("run_messages"))
      return undefined;
    const notices = inbox.notices;
    // Once the room takes `uplink-bridge say` and `reply`, each delivery ends saying the run can use them.
    const hint = this.roomFeatures.has("run_say") ? answerHint : undefined;
    let claim: RunMessageClaim;
    // The room's clock for the claim starts once it gets the request: counted from before it's sent.
    const claimed = Date.now();
    try {
      claim = await link.claimRunMessages({
        terminalRef: terminal.id,
        how,
        reserve: hint ? hint.length + 2 : 0,
        ...this.claimFiles(),
      });
    } catch {
      return undefined;
    }
    if (!claim.more && inbox.notices === notices) inbox.waiting = false;
    if (!claim.deliveries.length) return undefined;
    this.claims.set(claim.claimId, {
      terminalId: terminal.id,
      deliveryIds: claim.deliveries.map((d) => d.deliveryId),
      how,
    });
    const files = !!terminal.cwd && claim.deliveries.some((d) => d.files?.length);
    if (!files && mode !== "prefetch")
      return { text: formatRunMessages(claim.deliveries, hint), ack: claim.claimId };
    // A message's files, saved in the run's workspace, whose paths the message names (ADR 0043).
    // Saving can outlast the claim, so the bridge holds it meanwhile and hands over nothing it lost.
    const hold = this.holdClaim(claim, claimed, mode === "prefetch");
    const saving = this.saveClaimFiles(terminal, claim, hint).then(
      (handed) => {
        if (inbox.saving === saving) inbox.saving = undefined;
        // The terminal ended, or stopped being shared, while the files moved.
        if (this.terminals.get(terminal.id) !== terminal || !terminal.shared || !this.sharing) {
          hold.stop();
          this.settleClaim(claim.claimId, "released");
          this.removeSavedFiles(terminal);
          return;
        }
        inbox.ready = { handed, hold };
        // An idle session's waiter takes it now; a running turn's next hook otherwise.
        this.wake(terminal);
      },
      () => {
        if (inbox.saving === saving) inbox.saving = undefined;
        hold.stop();
        this.settleClaim(claim.claimId, "released");
        inbox.waiting = true;
      },
    );
    inbox.saving = saving;
    if (mode !== "wait") return undefined;
    await saving;
    return this.takeReady(terminal, how);
  }
  /** Saves a claim's files in the run's workspace and writes its messages with their paths. */
  private async saveClaimFiles(terminal: Terminal, claim: RunMessageClaim, hint: string | undefined): Promise<Handed> {
    const images: string[] = [];
    const deliveries = [];
    for (const delivery of claim.deliveries) {
      if (!delivery.files?.length || !terminal.cwd) {
        deliveries.push(delivery);
        continue;
      }
      (terminal.savedFiles ??= new Set()).add(delivery.deliveryId);
      void this.roomFiles.add(terminal.cwd);
      const saved = await saveRoomFiles(terminal.cwd, delivery.deliveryId, delivery.files.slice(0, MAX_MESSAGE_FILES)).catch(() => []);
      for (const file of saved) if (file.kind === "image" && NATIVE_IMAGE_TYPES.has(file.mimeType)) images.push(file.path);
      deliveries.push({ ...delivery, delivered: { saved: saved.map((f) => ({ name: f.name, path: f.path })) } });
    }
    return { text: formatRunMessages(deliveries, hint), ack: claim.claimId, ...(images.length ? { images } : {}) };
  }
  /**
   * The claim whose files are in, for a hook or the waiter that delivers it `how`, if the room still
   * counts it the bridge's. One it gave back is released: its messages wait again, and the caller
   * claims them afresh.
   */
  private takeReady(terminal: Terminal, how: RunMessageHow): Handed | undefined {
    const inbox = this.inboxOf(terminal);
    const ready = inbox.ready;
    if (!ready) return undefined;
    inbox.ready = undefined;
    ready.hold.stop();
    const claim = this.claims.get(ready.handed.ack);
    if (!claim || !ready.hold.held()) {
      this.settleClaim(ready.handed.ack, "released");
      inbox.waiting = true;
      return undefined;
    }
    claim.how = how;
    return ready.handed;
  }
  /**
   * The files budget a claim names (ADR 0043), only to a room that takes it: a room from before
   * refuses a claim with `maxFiles` in its argument validator, which would stop every delivery.
   * Without it the room hands no files anyway.
   */
  private claimFiles(): { maxFiles?: number } {
    return this.roomFeatures.has("run_message_files") ? { maxFiles: RUN_CLAIM_FILES_MAX } : {};
  }
  /**
   * Whether a claim is still the bridge's (ADR 0043): it is for `claimMs` after the bridge asked for
   * it, less a margin, and the bridge holds it longer (`bridge:holdRunMessages`) while it moves the
   * claim's files, every third of that, up to RUN_CLAIM_HOLD_MAX_MS, and then until a hook takes
   * it. A claim with no files is held only when claimed before any hook asked (`keep`); otherwise its
   * messages go at once. Once a hold fails, or the end passes, the claim is lost:
   * the room gave its messages back to wait, and nothing of it may be sent.
   */
  private holdClaim(claim: RunMessageClaim, claimedAt: number, keep = false): ClaimHold {
    const leaseMs = this.options.claimMs ?? RUN_CLAIM_MS;
    const margin = Math.min(CLAIM_MARGIN_MS, leaseMs / 4);
    let end = claimedAt + leaseMs - margin;
    let lost = false;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    // A room from before ADR 0043 has no `bridge:holdRunMessages` (and hands no files to hold for).
    const hold = this.roomFeatures.has("run_message_files") ? this.options.link.holdRunMessages?.bind(this.options.link) : undefined;
    const deliveryIds = claim.deliveries.map((d) => d.deliveryId);
    const renew = async () => {
      timer = undefined;
      const asked = Date.now();
      if (lost || asked - claimedAt >= RUN_CLAIM_HOLD_MAX_MS) return;
      try {
        const answer = await hold!({ claimId: claim.claimId, deliveryIds });
        if (!answer.held) lost = true;
        else end = Math.max(end, Math.min(asked + leaseMs, claimedAt + RUN_CLAIM_HOLD_MAX_MS) - margin);
      } catch {
        // The room may not have answered: the claim still ends when it would have.
      }
      if (!lost && !stopped) schedule();
    };
    const schedule = () => {
      timer = setTimeout(() => void renew(), leaseMs / 3);
      timer.unref?.();
    };
    if (hold && (keep || claim.deliveries.some((d) => d.files?.length))) schedule();
    return {
      held: () => !lost && Date.now() < end,
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }
  /** A hook got a claim's messages: it has `ackWaitMs` to say it wrote them, or the room hears it's unsure. */
  private handedOver(claimId: string) {
    const claim = this.claims.get(claimId);
    if (!claim) return;
    claim.timer = setTimeout(() => this.settleClaim(claimId, "unsure"), this.options.ackWaitMs ?? ACK_WAIT_MS);
    claim.timer.unref?.();
  }
  /**
   * A hook's CLI wrote a claim's messages for Claude Code (`uplink-bridge hook` and `inbox --wait`
   * send this after their output): the room hears they were delivered.
   */
  ack(terminalId: string, secret: unknown, claimId: string): Record<string, never> {
    const terminal = this.asTerminal(terminalId, secret);
    if (terminal && this.claims.get(claimId)?.terminalId === terminal.id) this.settleClaim(claimId, "delivered");
    return {};
  }
  /**
   * The shared terminal a local request acts as, when it gives the terminal's id and the secret the
   * bridge put in that terminal's environment. Node exposes no peer process for a Unix socket or a
   * named pipe (nodejs.org/api/net.html), so the secret is the check: a process outside the
   * terminal can't act as its run by naming its id, though one running as the same OS user can
   * still read the terminal's environment (README, Messages to runs).
   */
  private asTerminal(terminalId: unknown, secret: unknown): Terminal | undefined {
    if (typeof terminalId !== "string" || typeof secret !== "string" || !this.sharing) return undefined;
    const terminal = this.terminals.get(terminalId);
    if (!terminal?.shared || !terminal.secret) return undefined;
    const given = Buffer.from(secret);
    const expected = Buffer.from(terminal.secret);
    return given.length === expected.length && timingSafeEqual(given, expected) ? terminal : undefined;
  }
  private settleClaim(claimId: string, status: "delivered" | "released" | "unsure", how?: RunMessageHow) {
    const claim = this.claims.get(claimId);
    if (!claim) return;
    this.claims.delete(claimId);
    clearTimeout(claim.timer);
    void this.emit({
      v: 1,
      type: "run_message_result",
      claimId,
      deliveryIds: claim.deliveryIds,
      status,
      ...(status === "delivered" ? { how: how ?? claim.how } : {}),
    });
  }
  /** Claims the messages waiting for an idle session's waiter, so it wakes the session with them. */
  private wake(terminal: Terminal) {
    const inbox = this.inboxOf(terminal);
    if (!inbox.waiter || !inbox.idle || !(inbox.waiting || inbox.ready) || inbox.waking) return;
    inbox.waking = true;
    const notices = inbox.notices;
    void this.claim(terminal, "next_turn").then((handed) => {
      inbox.waking = false;
      // A notice that came while this claim was out couldn't start one of its own: claim again for
      // it. Only then, so a room that can't be reached isn't asked again and again.
      if (!handed) return inbox.notices !== notices ? this.wake(terminal) : undefined;
      const waiter = inbox.waiter;
      // The waiter went, or a turn started meanwhile: the messages wait for the next hook instead.
      if (!waiter || !inbox.idle || !terminal.shared || !this.sharing) return this.settleClaim(handed.ack, "released");
      inbox.waiter = undefined;
      waiter(handed);
      this.handedOver(handed.ack);
    });
  }
  /** `value` with every run key hidden, for anything the bridge sends the room (ADR 0037). */
  private hideKeys<T>(value: T): T {
    return this.runKeys.hideIn(value);
  }
  /** Sharing stopped: no thread is delivered to again, and no run key posts any more. */
  private dropThreadDeliveries() {
    for (const deliveries of this.threadDeliveries.values()) clearTimeout(deliveries.retry);
    this.threadDeliveries.clear();
    this.runKeys.clear();
  }
  /**
   * T3 Code archived or deleted a thread (by T3 Code's id): its run keys stop working, and nothing
   * more is delivered to it, whether the room names it by that id or by the run it was launched for.
   */
  private forgetThread(threadId: string) {
    this.runKeys.forget(threadId);
    this.stopDeliveries(threadId);
  }
  /**
   * The run in a thread (by T3 Code's id) stopped, or its thread closed: deliveries on their way
   * send nothing, and the room gets their messages back to wait. The room may name the thread by
   * that id or by the run it was launched for.
   */
  private stopDeliveries(threadId: string) {
    // A driver's message still moving its files sees it too, and sends nothing.
    this.threadStops.set(threadId, (this.threadStops.get(threadId) ?? 0) + 1);
    for (const ref of [threadId, ...[...this.launchedThreads].filter(([, id]) => id === threadId).map(([runId]) => runId)]) {
      clearTimeout(this.threadDeliveries.get(ref)?.retry);
      this.threadDeliveries.delete(ref);
    }
  }
  /**
   * The room says messages wait for the run in a T3 Code thread (ADR 0037): the bridge claims them
   * by the thread and sends them into it, one claim at a time per thread, again while more wait or
   * a notice came meanwhile, and after a pause when T3 Code didn't take them.
   */
  private deliverToThread(threadRef: string) {
    const threads = this.threadControl();
    if (!threads?.deliver || !this.options.link.claimRunMessages || !this.roomFeatures.has("thread_run_messages")) return;
    // A thread nobody here shared: its messages wait in the room, unclaimed.
    if (threads.shares && !threads.shares(threadRef)) return;
    let state = this.threadDeliveries.get(threadRef);
    if (!state) this.threadDeliveries.set(threadRef, (state = { busy: false, again: false, wait: 0 }));
    if (state.busy || state.retry) {
      state.again = true;
      return;
    }
    const deliveries = state;
    deliveries.busy = true;
    void (async () => {
      try {
        do {
          deliveries.again = false;
          const outcome = await this.deliverOnce(threadRef, threads, () => this.sharing && this.threadDeliveries.get(threadRef) === deliveries);
          if (outcome === "stopped") return;
          if (outcome === "failed") {
            deliveries.wait = Math.min(deliveries.wait ? deliveries.wait * 2 : (this.options.threadRetryMs ?? 30_000), THREAD_RETRY_MAX_MS);
            deliveries.retry = setTimeout(() => {
              deliveries.retry = undefined;
              if (this.sharing && !this.closing) this.deliverToThread(threadRef);
            }, deliveries.wait);
            deliveries.retry.unref?.();
            return;
          }
          if (outcome === "more") deliveries.again = true;
        } while (deliveries.again && this.sharing && !this.closing);
        deliveries.wait = 0;
      } finally {
        deliveries.busy = false;
        // Nothing in flight or waiting to be tried again: a thread costs nothing until its next notice.
        if (!deliveries.retry && this.threadDeliveries.get(threadRef) === deliveries) this.threadDeliveries.delete(threadRef);
      }
    })();
  }
  /**
   * One claim of a thread's messages, sent into the thread with a new run key in its last lines when
   * the room takes posts from runs. The room hears they were delivered once T3 Code took them, or
   * that they wait again (`released`), or, when T3 Code may have taken them, `unsure`.
   */
  private async deliverOnce(threadRef: string, threads: ThreadControl, wanted: () => boolean): Promise<"done" | "more" | "failed" | "stopped"> {
    const link = this.options.link;
    const threadId = this.launchedThreads.get(threadRef) ?? threadRef;
    const key = this.roomFeatures.has("run_say") && link.say ? this.runKeys.make(threadId) : undefined;
    const hint = key ? this.threadHint(key) : undefined;
    let claim: RunMessageClaim;
    const claimed = Date.now();
    try {
      claim = await link.claimRunMessages!({ threadRef, how: "next_turn", reserve: hint ? hint.length + 2 : 0, ...this.claimFiles() });
    } catch {
      if (key) this.runKeys.drop(key);
      return "failed";
    }
    if (!claim.deliveries.length) {
      if (key) this.runKeys.drop(key);
      return claim.more ? "more" : "done";
    }
    const deliveryIds = claim.deliveries.map((d) => d.deliveryId);
    const result = (status: "delivered" | "released" | "unsure", how?: RunMessageHow) =>
      void this.emit({ v: 1, type: "run_message_result", claimId: claim.claimId, deliveryIds, status, ...(how ? { how } : {}) });
    // The run stopped while the claim was on its way: its messages wait again, and nothing starts the thread.
    if (!wanted()) {
      if (key) this.runKeys.drop(key);
      result("released");
      return "stopped";
    }
    // Files go in as the message's attachments, all or none (ADR 0043): the text says they came with it.
    // The room bounds a claim to RUN_CLAIM_FILES_MAX, so every file of the claim goes.
    const files = claim.deliveries.flatMap((d) => d.files ?? []);
    const deliveries = claim.deliveries.map((d) => (d.files?.length ? { ...d, delivered: { with_message: d.files.length } } : d));
    // Moving the files can outlast the claim: held meanwhile, and a claim the room gave back sends nothing.
    const hold = this.holdClaim(claim, claimed);
    try {
      result(
        "delivered",
        await threads.deliver!(threadRef, {
          id: claim.claimId,
          text: formatRunMessages(deliveries, hint),
          ...(files.length ? { files } : {}),
          wanted: () => wanted() && hold.held(),
        }),
      );
    } catch (error) {
      const maybeSent = error instanceof ThreadDeliveryError && error.maybeSent;
      // The run never saw a key T3 Code didn't take.
      if (key && !maybeSent) this.runKeys.drop(key);
      result(maybeSent ? "unsure" : "released");
      return wanted() ? "failed" : "stopped";
    } finally {
      hold.stop();
    }
    return claim.more ? "more" : "done";
  }
  /** The lines that end a delivery into a thread: this bridge's own command and socket, and the run's key. */
  private threadHint(key: string): string {
    const env = { ...process.env, ...this.options.env };
    const words = this.options.claudeHooks?.bridgeCommand ?? bridgeCommand(env);
    return threadAnswerHint(quoteCommand(words, env), quoteArgument(this.socketPath ?? "", env), key);
  }
  /**
   * The run in a T3 Code thread posts as itself (`uplink-bridge say` and `reply` with `--key`, ADR
   * 0037): the key names the thread. `threadId` is `T3CODE_THREAD_ID` from the command's
   * environment, when T3 Code set one: a key for another thread is refused.
   */
  async threadSay(key: unknown, threadId: unknown, request: RunSayRequest, signal?: AbortSignal): Promise<RunSaid> {
    const made = this.runKeys.check(key);
    if (made === "unknown" || !this.sharing)
      throw new LocalRequestError("That isn't a run key this bridge holds: newer messages replaced it, its thread closed, or the bridge restarted since. Use the key from the newest message this run got; a new one comes with the next.");
    if (made === "expired")
      throw new LocalRequestError("That run key expired: it works while its thread's turn runs and for an hour after, for 12 hours at most. A new one comes with the next message this run gets.");
    if (typeof threadId === "string" && threadId && threadId !== made.threadId)
      throw new LocalRequestError("That run key belongs to another thread's run (T3CODE_THREAD_ID names this one). Use the key from a message this thread got.");
    if (!this.options.link.say || !this.roomFeatures.has("run_say") || !this.roomFeatures.has("thread_run_messages"))
      throw new LocalRequestError("This room is too old to take messages from runs in threads. Its backend needs an update first.");
    // A run reporting a problem may quote its own command, key and all (ADR 0037): postAsRun hides it.
    return await this.postAsRun({ threadRef: made.threadId }, request, signal);
  }
  /** Tells the room, once per terminal, that its run hears messages mid-task: its hooks reach the bridge. */
  private heard(terminal: Terminal) {
    const inbox = this.inboxOf(terminal);
    if (inbox.heard) return;
    inbox.heard = true;
    void this.emit({ v: 1, type: "run_hearing", source: { kind: "terminal", terminalId: terminal.id }, hearing: "mid_task" });
  }
  /** A terminal ended, or stopped being shared: its waiter goes quietly. The room fails what never reached the run. */
  private dropInbox(terminal: Terminal) {
    this.dropCodex(terminal);
    terminal.hermes?.close();
    // The run ended: the files saved for it go (ADR 0043).
    this.removeSavedFiles(terminal);
    const inbox = terminal.inbox;
    if (!inbox) return;
    const waiter = inbox.waiter;
    inbox.waiter = undefined;
    inbox.waiting = false;
    waiter?.(undefined);
    const ready = inbox.ready;
    inbox.ready = undefined;
    if (ready) {
      ready.hold.stop();
      this.settleClaim(ready.handed.ack, "released");
    }
  }
  /** Removes the delivery folders saved for a terminal's run from its workspace, following no link (ADR 0043). */
  private removeSavedFiles(terminal: Terminal) {
    // A save may not have created its folders yet. Keep its delivery IDs until it finishes.
    if (terminal.inbox?.saving) {
      this.track(terminal.inbox.saving.then(() => this.removeSavedFiles(terminal)));
      return;
    }
    const saved = terminal.savedFiles;
    if (!saved?.size || !terminal.cwd) return;
    terminal.savedFiles = undefined;
    this.track(removeRoomFiles(terminal.cwd, [...saved]));
  }
  /** Work on saved files that closing waits for. */
  private track(work: Promise<void>) {
    const tracked = work.catch(() => {}).finally(() => this.removals.delete(tracked));
    this.removals.add(tracked);
  }
  /**
   * An idle Claude Code session's waiter (`uplink-bridge inbox --wait`, run by its `Stop` and
   * `SessionStart` hooks with `asyncRewake`): answers with the next messages for the terminal's run,
   * at once if some wait, else when one arrives; or with nothing when the terminal ends, the socket
   * closes, or a newer waiter for the same terminal takes over, so only one waits per session.
   * `event` is the hook event that started it.
   */
  inboxWait(terminalId: string, secret: unknown, signal?: AbortSignal, event?: string): Promise<{ text?: string; ack?: string }> {
    const terminal = this.asTerminal(terminalId, secret);
    if (!terminal) return Promise.resolve({});
    const inbox = this.inboxOf(terminal);
    this.heard(terminal);
    inbox.waiter?.(undefined);
    // A turn's end (Stop) leaves the session idle. SessionStart doesn't say: it also fires when
    // Claude Code compacts during a turn, so a session keeps the state it had (idle when new).
    if (event !== "SessionStart") inbox.idle = true;
    return new Promise((resolve) => {
      const abort = () => {
        if (inbox.waiter === waiter) inbox.waiter = undefined;
        resolve({});
      };
      const waiter = (handed: Handed | undefined) => {
        signal?.removeEventListener("abort", abort);
        resolve(handed ?? {});
      };
      inbox.waiter = waiter;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.wake(terminal);
    });
  }
  async setLimits(limits: MachineLimits) {
    this.options.limits = validateLimits(limits);
    for (const terminal of this.terminals.values()) {
      const access = minAccess(terminal.access, limits.mostOpenAccess);
      if (access !== terminal.access) {
        terminal.access = access;
        await this.emit({ v: 1, type: "terminal_access", terminalId: terminal.id, access });
      }
    }
    await this.spaces?.setLimits(this.options.limits);
    // Threads too (ADR 0021). A launched thread is known by its run id and its thread id; the room
    // hears its bound id once.
    const lowered = new Set<string>();
    for (const [threadRef, current] of this.threadAccess) {
      const access = minAccess(current, limits.mostOpenAccess);
      if (access === current) continue;
      this.threadAccess.set(threadRef, access);
      if (this.launchedThreads.has(threadRef) && this.launchedThreads.get(threadRef) !== threadRef) continue;
      lowered.add(threadRef);
    }
    if (lowered.size) await this.saveThreads();
    for (const threadRef of lowered) await this.emit({ v: 1, type: "thread_access", threadRef, access: this.threadAccess.get(threadRef)! });
    // Not `register_machine`: the room ends every terminal when a bridge registers.
    await this.emit({ v: 1, type: "limits_changed", limits: this.options.limits });
    return limits;
  }
  /** Forgets this pairing: its profiles, the threads the room launched and their drivers, and its token. */
  async unlink() {
    await this.stopSharing();
    for (const id of Array.from(this.profiles.entries.keys())) await this.deleteProfile(id);
    this.threadDrivers.clear();
    this.launchedThreads.clear();
    this.threadAccess.clear();
    this.threadStarters.clear();
    this.watchedThreads.clear();
    if (this.options.threadsFile) await rm(this.options.threadsFile, { force: true });
    this.t3Saved = undefined;
    this.t3Applied = { threads: [] };
    if (this.options.t3SharingFile) await rm(this.options.t3SharingFile, { force: true });
    await this.options.dropToken?.();
  }
  /** The T3 Code adapter's local side, while sharing. */
  private t3Local() {
    return this.adapterHandles.find((handle) => handle.local)?.local;
  }
  /**
   * This machine's T3 Code threads and which of them the room gets, for the person here (the local
   * socket's `t3-threads`). Nothing of it goes to the room.
   */
  t3Threads(): T3SharingView {
    const machineId = this.options.pairing?.machineId ?? null;
    const base = { machineId, revision: this.t3Revision, threads: [], missing: [] };
    const local = this.t3Local();
    if (!local) return { ...base, state: this.sharing || !(this.options.adapters ?? []).some((a) => a.name === "t3code") ? "no_t3" : "sharing_stopped" };
    const catalog = local.catalog();
    const saved = this.t3Saved;
    const here = saved && catalog.environmentId !== undefined && saved.environmentId === catalog.environmentId;
    const listed = new Set(catalog.threads.map((t) => t.id));
    return {
      ...base,
      ...catalog,
      missing: here && catalog.state === "ready" ? saved.threads.filter((t) => !listed.has(t.id)) : [],
      ...(saved && catalog.environmentId !== undefined && !here && saved.threads.length ? { otherEnvironment: saved.threads.length } : {}),
    };
  }
  /**
   * Shares exactly the threads named (the local socket's `t3-share`), from the list `revision` named,
   * in the T3 Code environment it named. Stops take effect at once, saved or not; new shares only
   * once saved, so a thread is never shared on a choice the bridge would forget.
   */
  shareT3Threads(request: unknown): Promise<T3SharingView> {
    const run = this.t3Saving.then(() => this.applyT3Share(parseShareRequest(request)));
    this.t3Saving = run.catch(() => {});
    return run;
  }
  private async applyT3Share(ask: ReturnType<typeof parseShareRequest>): Promise<T3SharingView> {
    const local = this.t3Local();
    const file = this.options.t3SharingFile;
    const pairing = this.options.pairing;
    if (!file || !pairing) throw new LocalRequestError("This bridge can't share T3 Code threads.");
    if (ask.machineId !== pairing.machineId)
      throw new LocalRequestError("This computer's bridge runs for another pairing now. Open its machine's settings again.");
    if (!local) throw new LocalRequestError("Sharing is stopped on this machine, so its T3 Code threads can't be shared. Resume sharing first.");
    if (ask.revision !== this.t3Revision) throw new LocalRequestError("The threads shared here changed meanwhile. Check the list again, then save.");
    const catalog = local.catalog();
    if (catalog.state !== "ready" || !catalog.environmentId) throw new LocalRequestError("T3 Code isn't connected to the bridge right now. Open T3 Code, then try again.");
    if (catalog.environmentId !== ask.environmentId)
      throw new LocalRequestError("T3 Code on this computer is another environment now. Check the list again, then save.");
    const environmentId = catalog.environmentId;
    const listed = new Map(catalog.threads.map((t) => [t.id, t]));
    const before = this.t3Saved?.environmentId === environmentId ? this.t3Saved.threads : [];
    const kept = new Map(before.map((t) => [t.id, t]));
    const next: SavedT3Thread[] = [];
    for (const id of ask.threads) {
      const thread = listed.get(id);
      // Launched for a room run: always shared, never saved here.
      if (thread?.fromRoom) continue;
      if (thread) next.push({ id, title: thread.title.slice(0, 200), project: thread.project.slice(0, 200) });
      else if (kept.has(id)) next.push(kept.get(id)!);
      else throw new LocalRequestError("A thread picked isn't in T3 Code's list on this computer any more. Check the list again, then save.");
    }
    const picked = new Set(next.map((t) => t.id));
    // Stops first, at once: if the save fails, they hold until the bridge restarts.
    const applied = this.t3Applied?.environmentId === environmentId ? this.t3Applied.threads : [];
    const stillShared = applied.filter((id) => picked.has(id));
    this.applyT3({ environmentId, threads: stillShared });
    const saved: SavedT3Sharing = { v: 1, machineId: pairing.machineId, ...(pairing.teamId !== undefined ? { teamId: pairing.teamId } : {}), environmentId, threads: next };
    try {
      await saveT3Sharing(file, saved);
    } catch (error) {
      const held = stillShared.length < applied.length
        ? "Threads you stopped sharing are private now, but would be shared again after the bridge restarts."
        : "Nothing new is shared.";
      throw new LocalRequestError(`Couldn't save the choice on this computer (${(error as Error).message}). ${held} Try again.`);
    }
    this.t3Saved = saved;
    this.t3Revision++;
    this.applyT3({ environmentId, threads: next.map((t) => t.id) });
    return this.t3Threads();
  }
  private applyT3(selection: T3Selection) {
    this.t3Applied = selection;
    this.t3Local()?.share(selection);
  }
  share(options: { command?: string; cwd?: string; access?: Access }) {
    const id = randomUUID();
    return this.enqueue(async () => {
      if (!this.sharing)
        throw new Error(
          "Sharing has stopped. Restart the bridge, or resume sharing from the room if it was stopped there.",
        );
      await this.startTerminal(
        {
          v: 1,
          type: "start_terminal",
          terminalId: id,
          command: options.command,
          cwd: options.cwd,
          access: options.access ?? this.options.limits.mostOpenAccess,
          usesSlot: false,
          // The room treats whoever linked the machine as the starter and driver of this terminal.
          startedBy: { memberId: this.options.linkedBy ?? "local", name: "Local" },
        },
        true,
      );
      await this.outgoing;
    }).then(() => id);
  }
  async close() {
    this.closing = true;
    this.sharing = false;
    this.resumable = false;
    clearTimeout(this.expiryTimer);
    for (const id of this.pendingHooks.keys()) this.cancelHook(id);
    this.dropThreadDeliveries();
    // Claims a hook never acknowledged expire in the room, which counts them unsure.
    for (const claim of this.claims.values()) clearTimeout(claim.timer);
    this.claims.clear();
    for (const handle of this.adapterHandles.splice(0)) handle.close();
    void this.spaces?.stopAll("bridge_stopped");
    const spacesClosed = this.spaces?.close().catch(() => {});
    // Local teardown comes first and never waits on queued work, which can be stuck on a send the
    // room never answers. With sharing off, queued work can't start another terminal. Every
    // terminal's kill starts now; on Windows each finishes in the background (its process-tree kill),
    // all of them together within the same wait below.
    for (const terminal of this.terminals.values()) {
      this.dropInbox(terminal);
      const wasShared = terminal.shared;
      terminal.shared = false;
      terminal.adapter?.close();
      clearTimeout(terminal.timer);
      // A Rex tab the person opened isn't ended: it only stops sending output, and its host
      // connects again when a bridge is back.
      void this.stop(terminal);
      terminal.release?.();
      // Otherwise the room keeps counting this terminal, and its slot, as live. No exit code: the
      // work didn't finish, the bridge stopped it.
      if (wasShared)
        void this.emit({
          v: 1,
          type: "terminal_ended",
          terminalId: terminal.id,
          reason: "bridge_stopped",
        });
    }
    this.terminals.clear();
    // The hosts of runs the room started in Rex end their programs when the bridge goes.
    this.rexTabs?.close();
    // Those kills, and those of terminals ended earlier whose processes are still stopping.
    const kills = [...this.live].map((terminal) => this.stop(terminal));
    // Wait a little for queued work, the kills and the room to hear it, but don't hang on a lost link
    // or a slow kill.
    await Promise.race([
      Promise.all([this.work, this.outgoing.catch(() => {}), spacesClosed, ...kills, ...this.removals]),
      new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
    ]);
  }
}
