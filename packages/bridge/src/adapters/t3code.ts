import { randomUUID } from "node:crypto";
import { isRuntimeMode, type Prompt, type ReportedRunState, type RoomFile, type RunMessageHow, type RunSource, type RuntimeMode } from "@uplink-room/protocol";
import { downloadRoomFile, RoomFileError } from "../roomFiles.ts";
import { isCommand, jsonCommand } from "./process.ts";
import { ROOM_MESSAGE_PREFIX, THREAD_ITEM_LIMITS, type ThreadItem } from "@uplink-room/protocol";
import { T3Error, T3Rpc, type T3Session } from "./t3client.ts";
import {
  FIRST_ITEMS,
  HISTORY_PAGE,
  byOrder,
  isVisible,
  newThreadContext,
  normalizeItem,
  type T3TurnItem,
  type ThreadContext,
} from "./t3thread.ts";
import {
  ThreadDeliveryError,
  ThreadStartError,
  type Adapter,
  type AdapterHandle,
  type BridgeEvents,
  type BridgeSaved,
  type RunUpdate,
  type T3Catalog,
  type T3CatalogThread,
  type T3Local,
  type T3Selection,
  type T3Status,
  type T3ThreadState,
  type ThreadControl,
  type ThreadUpdate,
} from "./types.ts";

type Report = (
  source: RunSource,
  update: RunUpdate,
  info: { title?: string; harness?: string; repo?: string },
) => void;

export interface T3CodeOptions {
  executable?: string;
  /** A registered project's id or a path inside it, used for room launches. Defaults to the bridge's cwd. */
  project?: string;
  /**
   * Threads picked on this machine, in any T3 Code environment (tests). The bridge passes what was
   * picked in Settings as `BridgeSaved.shared` instead, for the environment it was picked in. Every
   * other thread stays private, even in the same project; threads launched for room runs are always
   * shared.
   */
  sharedThreads?: readonly string[];
  pollMs?: number;
  /** A paired T3 Code client session. Without one, the adapter polls `t3 thread list` and can't launch, stop or answer. */
  session?: T3Session;
  /** How long to wait before reconnecting to T3 Code. */
  retryMs?: number;
  /**
   * Reads the saved T3 Code session again (`bridge.json`), so a pairing made with
   * `uplink-bridge t3-pair` while the bridge runs is used without a restart. Without it, a
   * session T3 Code refused stays refused until the bridge restarts.
   */
  loadSession?: () => Promise<T3Session | undefined>;
  /** While T3 Code refuses the session: how often to read the saved one again. Defaults to 30 seconds. */
  sessionPollMs?: number;
  /** While T3 Code refuses the session: how often to try the same one again anyway. Defaults to 5 minutes. */
  refusedRetryMs?: number;
  /**
   * Pairs with T3 Code on this machine by itself (the local `t3` CLI) and saves the session, or
   * resolves undefined when it couldn't. Used when the bridge starts without a session, when T3
   * refuses the session, and when the session ends within T3_RENEW_MS. At most once per
   * `refusedRetryMs`, so a T3 that issues sessions and then refuses them isn't asked in a loop.
   */
  pairAgain?: () => Promise<T3Session | undefined>;
  /** How long a followed thread's changes gather before they go to the room. Defaults to 250 ms. */
  threadFlushMs?: number;
  now?: () => number;
  /**
   * How long a launch or stop waits for T3 Code's connection and first shell snapshot, as when
   * one queued while the bridge was offline arrives just after it starts. Defaults to 15 seconds.
   */
  readyMs?: number;
}

/** How soon before a T3 Code session ends the bridge renews it by itself (the app warns 7 days out). */
export const T3_RENEW_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Room harnesses and the T3 Code provider drivers that run them. `shell` and `hermes-agent` have none:
 * the room refuses a thread run of them (`threads` in packages/backend/convex/lib/harnesses.ts).
 */
const HARNESS_DRIVERS: Record<string, string[]> = {
  "claude-code": ["claudeAgent", "claude"],
  codex: ["codex"],
  "grok-build": ["grok"],
  opencode: ["opencode"],
  cursor: ["cursor"],
};
/** The room harness a T3 Code provider driver runs, such as `claude-code` for `claudeAgent`. */
const DRIVER_HARNESS = new Map(Object.entries(HARNESS_DRIVERS).flatMap(([harness, drivers]) => drivers.map((d) => [d, harness] as const)));
/** A run status T3 Code counts as active (orchestration-v2 CommandPolicy.ts `isActiveRun`). */
const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
/** What a provider session says its turns do with a steer (contracts orchestrationV2.ts `OrchestrationV2TurnCapabilities`). */
interface TurnCapabilities {
  supportsActiveSteering?: boolean;
  activeSteeringInterruptsTools?: boolean;
}
/**
 * Whether a message can join a turn in progress without stopping anything: the provider steers
 * active turns and its steering doesn't cancel running tools. T3 Code makes the same choice for a
 * notification it must not interrupt a turn for (orchestration-v2 Orchestrator.ts). At
 * v0.1.8-nightly.20261105.4234 that is Codex only: Claude Code's steering stops the running tool, and
 * Grok's harness can only interrupt and restart (#138, test 7).
 */
function steersCleanly(turns: TurnCapabilities) {
  return turns.supportsActiveSteering === true && turns.activeSteeringInterruptsTools !== true;
}
/** The parts of a thread's projection that say how its active turn takes a message. */
interface SteerProjection {
  runs?: { id: string; status: string; providerThreadId?: string | null; activeAttemptId?: string | null }[];
  providerThreads?: { id: string; providerSessionId?: string | null }[];
  providerSessions?: { id: string; providerInstanceId: string; capabilities?: { turns?: TurnCapabilities } }[];
  providerTurns?: { runAttemptId?: string | null; status: string }[];
}
/** Runtime request kinds a person answers as an approval (contracts providerPolicy.ts `ProviderRequestKind`). */
const APPROVAL_KINDS = new Set(["command", "file-read", "file-change", "mcp-elicitation", "permission"]);

// The parts of T3 Code's shell and projection the adapter reads (contracts orchestrationV2.ts).
interface ProjectShell {
  id: string;
  title?: string;
  workspaceRoot: string;
  repositoryIdentity?: { canonicalKey: string; webUrl?: string } | null;
  defaultModelSelection: { instanceId: string; model: string } | null;
}
interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  providerInstanceId: string;
  lineage?: { relationshipToParent: string | null; sideChat?: boolean };
  status: string;
  activityRunStatus?: string | null;
  activeRunId: string | null;
  pendingRuntimeRequest: { id: string; kind: string; blocking?: boolean } | null;
  /** What its agent may do without asking (contracts providerPolicy.ts `RuntimeMode`, ADR 0043). */
  runtimeMode?: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  updatedAt?: string;
}
interface Provider {
  instanceId: string;
  driver: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  availability?: string;
  auth?: { status?: string };
  supportedRuntimeModes?: string[];
  models: { slug: string; isDefault?: boolean; isLegacy?: boolean }[];
}
interface ProjectionItem {
  type: string;
  id?: string;
  /** A secret request's label, such as "GitHub token". */
  label?: string;
  secretStatus?: string;
  linkStatus?: string;
  requestId?: string;
  requestKind?: string;
  prompt?: string;
  reason?: string;
  options?: { decision: string }[];
  questions?: {
    id?: string;
    header?: string;
    question: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
    allowCustomAnswer?: boolean;
  }[];
}

/** Maps T3 Code's run status to the room's. Idle and rolled-back threads report Unknown. */
function stateOf(shell: ThreadShell): ReportedRunState {
  const status = shell.activityRunStatus ?? shell.status;
  if (["running", "preparing", "queued", "starting", "waiting"].includes(status)) return "working";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "stopped";
  return "unknown";
}
function normalizeRepo(repo: string) {
  return repo
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
/** What the room is told when it asks for a thread nobody on its machine shared. */
const NOT_SHARED = "This T3 Code thread isn't shared from its machine.";
/** A thread T3 Code lists as its own: not archived or deleted, and not a subagent or side chat inside another (contracts `isListedThreadLineage`). */
function listed(thread: ThreadShell) {
  return !thread.archivedAt && !thread.deletedAt && thread.lineage?.relationshipToParent !== "subagent" && !thread.lineage?.sideChat;
}
/** The last part of a path, with either separator. */
function folderName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}
/** True when `path` is `root` or inside it, with either separator. */
function inside(root: string, path: string) {
  const base = root.replace(/[\\/]+$/, "");
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/**
 * The image types T3 Code gives a provider as images (contracts chatAttachment.ts
 * `PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES`) and the most an image may be (10 MiB); any other
 * file goes as a `file` attachment of up to 50 MiB, which T3 Code hands the agent by path.
 */
const T3_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const T3_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const T3_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** A message's attachment as T3 Code's `message.dispatch` takes it (contracts chatAttachment.ts `ChatAttachment`). */
interface T3Attachment {
  type: "image" | "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Hands the room's files to T3 Code as uploads (ADR 0043), as T3 Code's own client does
 * (web attachmentUploadQueue.ts): `attachments.createUploadUrl` names the file and gives a signed
 * upload path, the bytes go there with `POST` (server http.ts `layerAttachmentUploadRoute`, which
 * checks Content-Length against the size), and the returned id goes in `message.dispatch`'s
 * `attachments`, where T3 Code claims the pending upload for the thread
 * (orchestration-v2 ThreadMessageIntake.ts). All or none: a file that fails throws before any
 * message is sent, and the uploads already made are swept by T3 Code after 15 minutes.
 */
async function uploadToT3(rpc: T3Rpc, base: string, files: RoomFile[], fetchImpl: typeof fetch = fetch): Promise<T3Attachment[]> {
  const attachments: T3Attachment[] = [];
  for (const file of files) {
    const bytes = await downloadRoomFile(file, fetchImpl);
    if (!bytes.byteLength) throw new RoomFileError(`${file.name} is empty, and T3 Code takes no empty file.`);
    const mimeType = (file.mimeType || "application/octet-stream").toLowerCase().slice(0, 100);
    const image = T3_IMAGE_TYPES.has(mimeType) && bytes.byteLength <= T3_IMAGE_MAX_BYTES;
    if (!image && bytes.byteLength > T3_FILE_MAX_BYTES) throw new RoomFileError(`${file.name} is larger than the 50 MB T3 Code takes.`);
    const name = file.name.trim().slice(0, 255) || "file";
    const ticket = (await rpc.request("attachments.createUploadUrl", {
      ...(image ? { type: "image" } : { type: "file" }),
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
    })) as { attachmentId: string; relativeUrl: string };
    let response: Response;
    try {
      response = await fetchImpl(new URL(ticket.relativeUrl, base.endsWith("/") ? base : `${base}/`), {
        method: "POST",
        headers: { "content-type": mimeType, "content-length": String(bytes.byteLength) },
        body: bytes,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new T3Error("t3_unavailable", `Couldn't upload ${name} to T3 Code: ${(error as Error).message}`);
    }
    if (!response.ok) throw new T3Error("rpc", `T3 Code refused ${name}: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    attachments.push({ type: image ? "image" : "file", id: ticket.attachmentId, name, mimeType, sizeBytes: bytes.byteLength });
  }
  return attachments;
}

export class T3CodeAdapter implements Adapter {
  name = "t3code";
  executable: string;
  private options: T3CodeOptions;
  /** The threads picked on this machine, and the T3 Code environment they were picked in. */
  private selection: T3Selection;
  /** Each running handle's reaction to a new selection. */
  private selectionChanged = new Set<() => void>();
  constructor(options: T3CodeOptions = {}) {
    this.options = options;
    this.executable = options.executable ?? "t3";
    this.selection = { threads: [...(options.sharedThreads ?? [])] };
  }
  matches(command: string) {
    return isCommand(command, "t3");
  }
  private setSelection(selection: T3Selection) {
    this.selection = { ...(selection.environmentId ? { environmentId: selection.environmentId } : {}), threads: [...selection.threads] };
    for (const changed of this.selectionChanged) changed();
  }
  startBridge(report: Report, saved?: BridgeSaved, events?: BridgeEvents): AdapterHandle {
    if (saved?.shared) this.selection = { ...saved.shared, threads: [...saved.shared.threads] };
    if (this.options.session) return this.startClient(this.options.session, report, saved, events);
    if (!this.options.pairAgain) return this.startPolling(report);
    return this.startPairing(report, saved, events);
  }

  /** The last time the adapter paired by itself, so `pairAgain` runs at most once per `refusedRetryMs`. */
  private pairedAt: number | undefined;
  /**
   * Pairs by itself, unless it did within `refusedRetryMs`. `skipWait` skips that wait: without a
   * session there's none for T3 to refuse, so trying again can't loop.
   */
  private async pairBySelf(skipWait = false): Promise<T3Session | undefined> {
    const pairAgain = this.options.pairAgain;
    const now = (this.options.now ?? Date.now)();
    const recent = this.pairedAt !== undefined && now - this.pairedAt < (this.options.refusedRetryMs ?? 300_000);
    if (!pairAgain || (recent && !skipWait)) return undefined;
    this.pairedAt = now;
    const session = await pairAgain().catch(() => undefined);
    return session?.token ? session : undefined;
  }

  /**
   * No session yet: polls `t3 thread list` while it pairs with T3 Code by itself, then switches to
   * the client. It tries again every `refusedRetryMs`, and at once when the room asks for a thread.
   */
  private startPairing(report: Report, saved?: BridgeSaved, events?: BridgeEvents): AdapterHandle {
    let closed = false;
    let paired = false;
    let inner = this.startPolling(report);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let trying: Promise<void> | undefined;
    /** Threads the room follows, followed again once the client starts. */
    const watched = new Map<string, (update: ThreadUpdate) => void>();
    const attempt = () =>
      (trying ??= (async () => {
        const session = await this.pairBySelf(true);
        if (closed || paired) return;
        if (session) {
          paired = true;
          clearTimeout(timer);
          inner.close();
          inner = this.startClient(session, report, saved, events);
          for (const [threadRef, send] of watched) inner.threads?.watch?.(threadRef, send);
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => void attempt(), this.options.refusedRetryMs ?? 300_000);
        timer.unref();
      })().finally(() => {
        trying = undefined;
      }));
    void attempt();
    const notPaired = () =>
      new ThreadStartError("t3_not_paired", "The bridge couldn't pair with T3 Code on this machine. Is T3 Code open?");
    /** The client's method, once paired (pairing first if it isn't), or a refusal T3 Code's way. */
    const control = async <K extends keyof ThreadControl>(key: K): Promise<NonNullable<ThreadControl[K]>> => {
      if (!paired) await attempt();
      const method = inner.threads?.[key];
      if (!paired || !method) throw key === "start" ? notPaired() : new T3Error("t3_unavailable", notPaired().message);
      return (method as (...args: never[]) => unknown).bind(inner.threads) as NonNullable<ThreadControl[K]>;
    };
    return {
      close() {
        closed = true;
        clearTimeout(timer);
        inner.close();
      },
      local: {
        catalog: () => inner.local!.catalog(),
        share: (selection) => inner.local!.share(selection),
      },
      threads: {
        shares: (threadRef) => (paired ? inner.threads?.shares?.(threadRef) === true : false),
        start: async (request, bind) => (await control("start"))(request, bind),
        stop: async (threadRef) => (await control("stop"))(threadRef),
        answer: async (threadRef, promptId, answer) =>
          paired ? (await control("answer"))(threadRef, promptId, answer) : "no_pending_approval",
        watch: (threadRef, send) => {
          watched.set(threadRef, send);
          if (paired) inner.threads?.watch?.(threadRef, send);
        },
        unwatch: (threadRef) => {
          watched.delete(threadRef);
          if (paired) inner.threads?.unwatch?.(threadRef);
        },
        history: async (threadRef, beforeItemId) => (await control("history"))(threadRef, beforeItemId),
        diff: async (threadRef, turn) => (await control("diff"))(threadRef, turn),
        send: async (threadRef, message) => (await control("send"))(threadRef, message),
        interrupt: async (threadRef) => (await control("interrupt"))(threadRef),
        setMode: async (threadRef, mode) => (await control("setMode"))(threadRef, mode),
        answerQuestion: async (threadRef, promptId, answers) =>
          (await control("answerQuestion"))(threadRef, promptId, answers),
        deliver: async (threadRef, delivery) => {
          let deliver: NonNullable<ThreadControl["deliver"]>;
          try {
            deliver = await control("deliver");
          } catch (error) {
            throw new ThreadDeliveryError((error as Error).message, false);
          }
          return deliver(threadRef, delivery);
        },
      },
    };
  }

  /** Without a client session: `t3 thread list` shows run status, but no requests (issue #13). */
  private startPolling(report: Report): AdapterHandle {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const last = new Map<string, string>();
    // `t3 thread list` names no environment, so only a selection made for any environment applies.
    const shared = (id: string) => this.selection.environmentId === undefined && this.selection.threads.includes(id);
    /** Threads no longer picked: the room's run of each goes Unknown, and hears nothing more. */
    const withdraw = () => {
      for (const threadRef of last.keys())
        if (!shared(threadRef)) {
          last.delete(threadRef);
          report({ kind: "thread", threadRef }, { state: "unknown" }, {});
        }
    };
    this.selectionChanged.add(withdraw);
    const poll = async () => {
      try {
        const threads = (await jsonCommand(this.executable, [
          "thread",
          "list",
          "--project",
          this.options.project ?? process.cwd(),
          "--json",
        ])) as { threadId: string; title?: string; status?: string }[];
        for (const thread of threads) {
          if (closed) return;
          if (!shared(thread.threadId)) continue;
          // `waiting` means a request the CLI can't show, so it stays Unknown here.
          const update: RunUpdate = {
            state: thread.status === "waiting" ? "unknown" : stateOf({ status: thread.status ?? "" } as ThreadShell),
          };
          const key = JSON.stringify([update, thread.title]);
          if (last.get(thread.threadId) !== key) {
            last.set(thread.threadId, key);
            report({ kind: "thread", threadRef: thread.threadId }, update, {
              title: thread.title,
              harness: "t3code",
              repo: this.options.project,
            });
          }
        }
      } catch {
        if (!closed)
          for (const threadRef of last.keys())
            report({ kind: "thread", threadRef }, { state: "unknown" }, { harness: "t3code" });
        last.clear();
      }
      if (!closed) {
        timer = setTimeout(() => void poll(), this.options.pollMs ?? 3000);
        timer.unref();
      }
    };
    void poll();
    const notPaired = () =>
      new ThreadStartError("t3_not_paired", "Pair the bridge with T3 Code first: uplink-bridge t3-pair.");
    return {
      close: () => {
        closed = true;
        clearTimeout(timer);
        this.selectionChanged.delete(withdraw);
      },
      local: {
        catalog: () => ({ state: "not_paired", threads: [] }),
        share: (selection) => this.setSelection(selection),
      },
      threads: {
        shares: () => false,
        start: async () => {
          throw notPaired();
        },
        stop: async () => {
          throw notPaired();
        },
        answer: async () => "no_pending_approval",
      },
    };
  }

  /** With a client session: T3 Code pushes thread changes, and the bridge can launch, stop and answer. */
  private startClient(initial: T3Session, report: Report, saved?: BridgeSaved, events?: BridgeEvents): AdapterHandle {
    const root = this.options.project ?? process.cwd();
    const now = this.options.now ?? Date.now;
    let session = initial;
    let closed = false;
    let rpc: T3Rpc | undefined;
    let lastError = "T3 Code isn't connected yet.";
    let retry: ReturnType<typeof setTimeout> | undefined;
    /** When the session gets within T3_RENEW_MS of its end. */
    let renew: ReturnType<typeof setTimeout> | undefined;
    let providers: Provider[] = [];
    let threadStop = false;
    /** The pairing's last status, so each change is told once (ADR 0021). */
    let statusKey = "";
    const setStatus = (status: T3Status) => {
      const key = JSON.stringify(status);
      if (key === statusKey) return;
      statusKey = key;
      events?.t3Status?.(status);
    };
    /** Set while T3 Code refuses the session: the bridge waits for a new pairing instead of retrying it every few seconds. */
    let refusedSince: number | undefined;
    const projects = new Map<string, ProjectShell>();
    const threads = new Map<string, ThreadShell>();
    /** What was last reported for each thread. */
    const reported = new Map<string, string>();
    /** The run state last reported for each thread, so work the room already has as finished stays so. */
    const reportedState = new Map<string, ReportedRunState>();
    /**
     * Threads a lost connection left Unknown in the room and that haven't been reported since. One
     * withdrawn before it's reported again (T3 Code came back as another environment) still has a
     * run in the room, so the room still hears it closed.
     */
    const lostRuns = new Set<string>();
    /**
     * Threads launched for a room run: run id → thread id. Reported whatever their project. The
     * bridge saves them, so a restart or resumed sharing still reports one in another project.
     */
    const launched = new Map<string, string>(saved?.launched);
    const fromRoom = (id: string) => [...launched.values()].includes(id);
    /** The T3 Code environment this connection reached: a selection picked in another one shares nothing here. */
    let environmentId: string | undefined;
    /**
     * Threads picked on this machine that the room gets now, in this environment. Nothing else is
     * reported, followed, read for the room or sent into, except threads launched for room runs.
     */
    let admitted = new Set<string>();
    const allowed = (id: string) => admitted.has(id) || fromRoom(id);
    /** The room follows these, but they aren't shared: followed once they are. */
    const deferred = new Map<string, (update: ThreadUpdate) => void>();
    /** The request each thread waits on now, with the prompt the room was given. */
    const pending = new Map<
      string,
      { requestId: string; prompt: Prompt; answerable: boolean; decisions?: string[] }
    >();
    /** A stable prompt id per T3 request, so a reconnect doesn't make the room's answer stale. */
    const promptIds = new Map<string, string>();
    /** Bumped on each change to a thread, so a slow projection read can't report an old request. */
    const generation = new Map<string, number>();
    /**
     * How each provider instance's turns take a steer, from the last thread projection that showed
     * one of its sessions. A driver's capabilities are the same for each of its sessions, so one read
     * per instance tells the hearing of all its threads (ADR 0037).
     */
    const turnsOf = new Map<string, TurnCapabilities>();
    /** The hearing last told for each thread, so each change is told once. */
    const hearingTold = new Map<string, "mid_task" | "between_turns">();
    /** Threads whose hearing waits for a projection read, read one at a time. */
    const hearingQueue = new Set<string>();
    let readingHearing = false;
    const learnTurns = (projection: SteerProjection) => {
      for (const session of projection.providerSessions ?? [])
        if (session.capabilities?.turns) turnsOf.set(session.providerInstanceId, session.capabilities.turns);
    };
    const tellHearing = (thread: ThreadShell) => {
      const turns = turnsOf.get(thread.providerInstanceId);
      if (!turns) return false;
      const hearing = steersCleanly(turns) ? "mid_task" : "between_turns";
      if (hearingTold.get(thread.id) !== hearing) {
        hearingTold.set(thread.id, hearing);
        events?.threadHearing?.(thread.id, hearing);
      }
      return true;
    };
    /** Reads the queued threads' projections, one at a time, until each one's provider is known. */
    const readHearing = async () => {
      if (readingHearing) return;
      readingHearing = true;
      try {
        for (const id of hearingQueue) {
          hearingQueue.delete(id);
          const thread = threads.get(id);
          if (closed || !rpc || !thread || !allowed(id) || tellHearing(thread)) continue;
          const projection = (await rpc.request("orchestration.getThreadProjection", { threadId: id }).catch(() => undefined)) as SteerProjection | undefined;
          if (projection) learnTurns(projection);
          // Stopped being shared while it was read.
          if (!allowed(id)) continue;
          // Its provider may have run no session yet: its next report asks again.
          tellHearing(thread);
        }
      } finally {
        readingHearing = false;
      }
    };
    /**
     * The mode and provider modes last told for each thread (ADR 0043), so each change is told once.
     * Told only once the thread's run was reported (`send`): the room drops a mode for a run it
     * doesn't have yet, as for a thread found in T3 Code, and this would keep it from being told again.
     */
    const modeTold = new Map<string, string>();
    /** The modes a provider instance takes, as T3 Code lists them; undefined when it doesn't. */
    const modesOf = (instanceId: string): RuntimeMode[] | undefined =>
      providers.find((p) => p.instanceId === instanceId)?.supportedRuntimeModes?.filter(isRuntimeMode);
    const tellMode = (thread: ThreadShell) => {
      if (!reported.has(thread.id) || !isRuntimeMode(thread.runtimeMode)) return;
      const modes = modesOf(thread.providerInstanceId);
      const key = JSON.stringify([thread.runtimeMode, modes]);
      if (modeTold.get(thread.id) === key) return;
      modeTold.set(thread.id, key);
      events?.threadMode?.(thread.id, thread.runtimeMode, modes);
    };
    /** Tells how a reported thread's run hears messages, reading T3 Code for it when its provider is new. */
    const hearingFor = (thread: ThreadShell) => {
      if (tellHearing(thread)) return;
      hearingQueue.add(thread.id);
      void readHearing();
    };
    /** True once this connection's first shell snapshot arrived, so `projects` and `threads` are known. */
    let synced = false;
    /** Launches and stops waiting for the connection and its first snapshot. */
    const waiting = new Set<() => void>();
    const settle = () => {
      for (const done of waiting) done();
    };
    /** Resolves once connected and synced, or after `readyMs`, or on close; callers check `rpc`. */
    const ready = () =>
      new Promise<void>((resolve) => {
        if ((rpc && synced) || closed) return resolve();
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(done, this.options.readyMs ?? 15000);
        timer.unref();
        waiting.add(done);
      });

    const watchedProject = () => {
      let best: ProjectShell | undefined;
      for (const project of projects.values()) {
        if (project.id === root) return project;
        if (inside(project.workspaceRoot, root) && (!best || project.workspaceRoot.length > best.workspaceRoot.length))
          best = project;
      }
      return best;
    };
    const watched = (thread: ThreadShell) => {
      if (fromRoom(thread.id)) return true;
      // Subagents and side chats live inside their parent, so they're never shared on their own.
      return listed(thread) && admitted.has(thread.id);
    };
    const send = (thread: ThreadShell, update: RunUpdate) => {
      if (!allowed(thread.id)) return;
      const key = JSON.stringify([update, thread.title]);
      if (reported.get(thread.id) === key) return;
      reported.set(thread.id, key);
      reportedState.set(thread.id, update.state);
      lostRuns.delete(thread.id);
      const project = projects.get(thread.projectId);
      // The harness its provider runs, so the room names it Codex or Claude Code rather than T3 Code.
      // A provider T3 Code no longer lists, or one with no room harness, stays T3 Code.
      const driver = providers.find((p) => p.instanceId === thread.providerInstanceId)?.driver;
      report({ kind: "thread", threadRef: thread.id }, update, {
        title: thread.title,
        harness: (driver && DRIVER_HARNESS.get(driver)) || "t3code",
        repo: project?.repositoryIdentity?.canonicalKey ?? project?.workspaceRoot,
      });
      // After the report, so the room has the run its mode belongs to.
      tellMode(thread);
      hearingFor(thread);
    };
    const promptFor = async (thread: ThreadShell, requestId: string) => {
      const projection = (await rpc!.request("orchestration.getThreadProjection", { threadId: thread.id })) as {
        runtimeRequests: { id: string; kind: string; status: string; responseCapability: { type: string } }[];
        turnItems: ProjectionItem[];
      };
      const request = projection.runtimeRequests.find((r) => r.id === requestId);
      if (!request) {
        // T3 reports a secret card or a link card as a pending `user_input` named by the card's
        // turn item, not by a runtime request (ProjectionStore.ts `secretRequestAsPendingInput`). It
        // waits on a person all the same, but only in T3 Code: a secret never goes through the room.
        const card = projection.turnItems.find(
          (i) => i.id === requestId && (i.type === "secret_request" || i.type === "link_request"),
        );
        if (!card) return undefined;
        if (card.type === "secret_request" ? card.secretStatus !== "pending" : card.linkStatus !== "pending") return undefined;
        const text =
          card.type === "secret_request"
            ? `The agent asks for ${card.label?.trim() ? card.label.trim() : "a secret"}. Enter it in T3 Code; secrets never go through the room.`
            : "The agent asks to link another machine to T3 Code. Answer it in T3 Code.";
        return { requestId, answerable: false, prompt: { kind: "question" as const, text } };
      }
      if (request.status !== "pending") return undefined;
      const item = projection.turnItems.find((i) => i.requestId === requestId);
      if (request.kind === "user_input") {
        const questions = item?.questions ?? [];
        const text = questions
          .map((q) => (q.options?.length ? `${q.question} (${q.options.map((o) => o.label).join(" / ")})` : q.question))
          .join("\n");
        // A question T3 Code takes an answer for now, with questions the room can show, can be
        // answered from the room (ADR 0023); any other is answered in T3 Code.
        const answerable = request.responseCapability.type === "live" && questions.length > 0 && questions.every((q) => q.id);
        if (!answerable)
          return {
            requestId,
            answerable: false,
            prompt: { kind: "question" as const, text: text || "The agent asked a question. Answer it in T3 Code." },
          };
        let promptId = promptIds.get(requestId);
        if (!promptId) promptIds.set(requestId, (promptId = randomUUID()));
        return {
          requestId,
          answerable: true,
          prompt: {
            kind: "question" as const,
            text: text || "The agent asked a question.",
            promptId,
            questions: questions.slice(0, 20).map((q) => ({
              id: q.id!,
              header: (q.header ?? q.question).slice(0, 200),
              question: q.question.slice(0, 2000),
              options: (q.options ?? []).slice(0, 50).map((o) => ({ label: o.label.slice(0, 200), ...(o.description ? { description: o.description.slice(0, 500) } : {}) })),
              ...(q.multiSelect ? { multiSelect: true } : {}),
              ...(q.allowCustomAnswer !== false ? { allowCustomAnswer: true } : {}),
            })),
          },
        };
      }
      const action = item?.prompt;
      const text = item?.reason ?? action ?? `The agent asks to ${request.kind.replace("-", " ")}.`;
      // Only a request with a live response capability can be answered (server Orchestrator.ts
      // rejects `not_resumable`); any other is shown as a question to answer in T3 Code.
      if (request.responseCapability.type !== "live")
        return { requestId, answerable: false, prompt: { kind: "question" as const, text: `${text} Answer it in T3 Code.` } };
      let promptId = promptIds.get(requestId);
      if (!promptId) promptIds.set(requestId, (promptId = randomUUID()));
      return {
        requestId,
        answerable: true,
        decisions: item?.options?.map((o) => o.decision),
        prompt: { kind: "approval" as const, text, ...(action ? { action } : {}), promptId },
      };
    };
    /**
     * T3 deleted or archived a thread: drop what the bridge tracks for it and, if the room was told
     * about it and the run hadn't finished, give the room a final state, so a pending approval
     * doesn't stay in the Inbox with buttons that now fail. A thread never reported says nothing,
     * and one the room already has as Done, Failed or Stopped gets no second final state, which
     * would change the run and bring settled work back to the Inbox. Either way the room hears the
     * thread closed, so its run stops taking messages between turns (ADR 0026).
     */
    const finish = (thread: ThreadShell, state: ReportedRunState) => {
      generation.set(thread.id, (generation.get(thread.id) ?? 0) + 1);
      pending.delete(thread.id);
      const told = reported.has(thread.id);
      if (told && !finished(thread.id)) send(thread, { state });
      // Whatever its last state, the thread itself is gone: its run no longer takes messages.
      if (told) events?.threadClosed?.(thread.id);
      // Forgotten, so a lost connection doesn't turn this final state back into Unknown.
      reported.delete(thread.id);
      reportedState.delete(thread.id);
      lostRuns.delete(thread.id);
      // A thread T3 Code lists again is new to the room: its mode is told again.
      modeTold.delete(thread.id);
    };
    const finished = (id: string) => {
      const last = reportedState.get(id);
      return last === "done" || last === "failed" || last === "stopped";
    };
    /**
     * T3's shell stream sends the same `thread.removed` on the active list for a deleted thread and
     * for an archived one (ShellStream.ts `shellStreamItemFromThreadShell`), so the event can't say
     * which. The thread's own record can: T3 keeps a deleted thread's row with `deletedAt`, and an
     * archived one with `archivedAt`, and `getThreadProjection` reads both. Deleting ends the work
     * (Stopped); archiving puts a thread away without ending a run (Done). A thread whose record
     * can't be read, or has neither date, is Unknown: the room can't be told more than that.
     */
    const removed = (thread: ThreadShell) => {
      const gen = (generation.get(thread.id) ?? 0) + 1;
      generation.set(thread.id, gen);
      pending.delete(thread.id);
      const socket = rpc;
      // Nothing to correct in the room, so nothing to ask T3. Without a connection, `lost` already
      // reported every unfinished thread Unknown.
      if (!socket || !reported.has(thread.id) || finished(thread.id)) {
        if (socket) finish(thread, "unknown");
        return;
      }
      void socket.request("orchestration.getThreadProjection", { threadId: thread.id }).then(
        (projection) => {
          // A newer update for this thread (it was restored, say) already says where it stands.
          if (closed || generation.get(thread.id) !== gen) return;
          const record = (projection as { thread?: { archivedAt?: string | null; deletedAt?: string | null } }).thread;
          finish(thread, record?.deletedAt ? "stopped" : record?.archivedAt ? "done" : "unknown");
        },
        () => {
          if (closed || generation.get(thread.id) !== gen) return;
          finish(thread, "unknown");
        },
      );
    };
    const refresh = (thread: ThreadShell) => {
      if (thread.deletedAt) return finish(thread, "stopped");
      if (thread.archivedAt) return finish(thread, "done");
      const gen = (generation.get(thread.id) ?? 0) + 1;
      generation.set(thread.id, gen);
      if (!watched(thread)) return;
      tellMode(thread);
      const request = thread.pendingRuntimeRequest;
      // A pending request needs a person whatever the run status says; T3's list status can stay
      // `running` while it waits (issue #13). Tool calls and auth refreshes aren't a person's to answer.
      if (request && (request.kind === "user_input" || APPROVAL_KINDS.has(request.kind))) {
        const current = pending.get(thread.id);
        if (current?.requestId === request.id) return send(thread, { state: "waiting", prompt: current.prompt });
        pending.delete(thread.id);
        void promptFor(thread, request.id).then(
          (found) => {
            if (closed || generation.get(thread.id) !== gen) return;
            if (!found) return send(thread, { state: stateOf(thread) });
            pending.set(thread.id, found);
            send(thread, { state: "waiting", prompt: found.prompt });
          },
          () => {
            if (closed || generation.get(thread.id) !== gen) return;
            send(thread, {
              state: "waiting",
              prompt: { kind: "question", text: "T3 Code is waiting for an answer. Open the thread in T3 Code." },
            });
          },
        );
        return;
      }
      pending.delete(thread.id);
      send(thread, { state: stateOf(thread) });
    };
    /**
     * A thread no longer picked here, or picked in another environment: the room hears nothing more
     * of it and can't follow, message or answer it. Reads on their way are dropped (`generation`),
     * and its run in the room goes Unknown, unless it finished, and stops taking messages. Nothing
     * reaches T3 Code: its work goes on there, and what the room already has stays in the room.
     */
    const withdraw = (id: string) => {
      generation.set(id, (generation.get(id) ?? 0) + 1);
      pending.delete(id);
      hearingQueue.delete(id);
      hearingTold.delete(id);
      modeTold.delete(id);
      const f = follows.get(id);
      if (f) {
        follows.delete(id);
        clearTimeout(f.timer);
        f.sub?.cancel();
        // The room's view stays open: if the thread is shared again, it's followed again.
        deferred.set(id, f.send);
      }
      const told = reported.has(id);
      if (told && !finished(id)) report({ kind: "thread", threadRef: id }, { state: "unknown" }, {});
      // Left Unknown by a lost connection: it has a run in the room all the same.
      const lostRun = lostRuns.delete(id);
      if (told || lostRun) events?.threadClosed?.(id);
      reported.delete(id);
      reportedState.delete(id);
    };
    /** A thread just picked here: reported as T3 Code has it now, and followed if the room has it open. */
    const admit = (id: string) => {
      const thread = threads.get(id);
      // While connecting, the next snapshot reports it instead, as T3 Code has it then.
      if (thread && rpc && synced) refresh(thread);
      const send = deferred.get(id);
      if (!send) return;
      deferred.delete(id);
      threadControl.watch!(id, send);
    };
    /** Applies the selection, as picked and for this environment: withdraws what left it, admits what joined it. */
    const reconcile = () => {
      if (closed) return;
      const { environmentId: pickedIn, threads: picked } = this.selection;
      const next = pickedIn === undefined || (environmentId !== undefined && pickedIn === environmentId) ? new Set(picked) : new Set<string>();
      const before = admitted;
      admitted = next;
      for (const id of before) if (!next.has(id) && !fromRoom(id)) withdraw(id);
      for (const id of next) if (!before.has(id)) admit(id);
    };
    const onShell = (value: unknown) => {
      const item = value as {
        kind: string;
        snapshot?: { projects: ProjectShell[]; threads: ThreadShell[] };
        resolvedRepositoryIdentityRoots?: string[];
        project?: ProjectShell;
        projectId?: string;
        thread?: ThreadShell;
        threadId?: string;
        location?: string;
      };
      if (item.kind === "snapshot" && item.snapshot && item.resolvedRepositoryIdentityRoots) {
        // Not the whole shell: T3 Code resolved these projects' repositories, and sends only them,
        // with no threads (ShellStream.ts `shellStreamItemFromEnrichmentRefresh`). Its own client
        // takes just their repository identity (client-runtime shellReducer.ts
        // `mergeShellSnapshotProjects`); replacing the shell with it would forget every thread.
        const roots = new Set(item.resolvedRepositoryIdentityRoots);
        for (const next of item.snapshot.projects) {
          const known = projects.get(next.id);
          if (known && known.workspaceRoot === next.workspaceRoot && (roots.has(known.workspaceRoot) || (!known.repositoryIdentity && next.repositoryIdentity)))
            projects.set(next.id, { ...known, repositoryIdentity: next.repositoryIdentity ?? null });
        }
      } else if (item.kind === "snapshot" && item.snapshot) {
        projects.clear();
        for (const project of item.snapshot.projects) projects.set(project.id, project);
        threads.clear();
        for (const thread of item.snapshot.threads) threads.set(thread.id, thread);
        for (const thread of threads.values()) refresh(thread);
        synced = true;
        settle();
      } else if (item.kind === "project.updated" && item.project) {
        projects.set(item.project.id, item.project);
      } else if (item.kind === "project.removed" && item.projectId) {
        projects.delete(item.projectId);
      } else if (item.kind === "thread.updated" && item.thread) {
        if (item.location === "archive") {
          threads.delete(item.thread.id);
          finish(item.thread, "done");
        } else {
          threads.set(item.thread.id, item.thread);
          refresh(item.thread);
        }
      } else if (item.kind === "thread.removed" && item.threadId && item.location !== "archive") {
        // Removed from the archive list (unarchived, or deleted from it) says nothing about the active one.
        const thread = threads.get(item.threadId);
        threads.delete(item.threadId);
        // A thread this connection never saw was never reported.
        if (thread) removed(thread);
        else pending.delete(item.threadId);
      }
    };
    const lost = (error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      const refused = error instanceof T3Error && error.reason === "t3_auth";
      rpc = undefined;
      synced = false;
      pending.clear();
      if (closed) return;
      // Work the room has as Done, Failed or Stopped stays so: Unknown would bring it back to the
      // Inbox as ongoing work. Its entries stay too, so the next snapshot doesn't resend it, while
      // a real update after reconnecting still reports its new state.
      for (const threadRef of reported.keys()) {
        if (finished(threadRef)) continue;
        report({ kind: "thread", threadRef }, { state: "unknown" }, { harness: "t3code" });
        reported.delete(threadRef);
        reportedState.delete(threadRef);
        lostRuns.add(threadRef);
      }
      if (closed) return;
      if (refused) {
        // T3 refused the session: it expired or was revoked, and retrying it every few seconds
        // never helps (ADR 0021). The bridge pairs again by itself; only when it can't is the room
        // told, once, and the bridge then waits for a new pairing.
        refusedSince ??= now();
        void repair();
        return;
      }
      refusedSince = undefined;
      retry = setTimeout(() => void connect(), this.options.retryMs ?? 5000);
      retry.unref();
    };
    /** T3 refused the session: pairs again by itself, or tells the room and waits for a new pairing. */
    const repair = async () => {
      const fresh = await this.pairBySelf();
      if (closed) return;
      if (fresh && fresh.token !== session.token) {
        session = fresh;
        return connect();
      }
      const expired = session.expiresAt !== undefined && now() >= session.expiresAt;
      setStatus({
        state: "needs_pairing",
        reason: expired ? "expired" : "refused",
        ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
      });
      retry = setTimeout(() => void awaitPairing(), this.options.sessionPollMs ?? 30_000);
      retry.unref();
    };
    /** While T3 refuses the session: reads the saved one again, and tries it once a new one is saved or after a while. */
    const awaitPairing = async () => {
      if (closed) return;
      const saved = await this.options.loadSession?.().catch(() => undefined);
      if (closed) return;
      const fresh = saved && saved.token && (saved.token !== session.token || saved.url !== session.url);
      if (fresh) session = saved;
      if (fresh || now() - (refusedSince ?? 0) >= (this.options.refusedRetryMs ?? 300_000)) {
        refusedSince = now();
        return connect();
      }
      retry = setTimeout(() => void awaitPairing(), this.options.sessionPollMs ?? 30_000);
      retry.unref();
    };
    const connect = async () => {
      let socket: T3Rpc | undefined;
      try {
        // Run keys are hidden in every frame before the adapter reads it (ADR 0037).
        socket = await T3Rpc.connect(session, events?.redact ? { filter: events.redact } : {});
        if (closed) return socket.close();
        const config = (await socket.request("server.getConfig", {})) as {
          providers: Provider[];
          environment?: { environmentId?: string; capabilities?: { threadStop?: boolean } };
          shellThreadFamilies?: boolean;
          shellOlderSettled?: boolean;
        };
        providers = config.providers;
        threadStop = config.environment?.capabilities?.threadStop === true;
        // Before the shell's snapshot, so only threads picked in this environment are reported from it.
        environmentId = config.environment?.environmentId;
        reconcile();
        rpc = socket;
        refusedSince = undefined;
        const connected = () =>
          setStatus({
            state: "connected",
            ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
            ...(config.environment?.environmentId ? { environmentId: config.environment.environmentId } : {}),
          });
        connected();
        // A session ending soon is renewed by itself, now or once it gets that close: the open
        // socket stays, and the next connection uses the new session.
        clearTimeout(renew);
        const renewNow = () =>
          void this.pairBySelf().then((fresh) => {
            if (closed || rpc !== socket) return;
            if (!fresh || fresh.token === session.token) {
              // T3 Code wasn't open, or its CLI didn't answer: try again later while connected.
              renew = setTimeout(renewNow, this.options.refusedRetryMs ?? 300_000);
              renew.unref();
              return;
            }
            session = fresh;
            connected();
            scheduleRenew();
          });
        /** Renews when the current session gets within T3_RENEW_MS of its end, or now if it already is. */
        const scheduleRenew = () => {
          if (session.expiresAt === undefined) return;
          const wait = session.expiresAt - T3_RENEW_MS - now();
          if (wait <= 0) return renewNow();
          renew = setTimeout(renewNow, Math.min(wait, 2 ** 31 - 1));
          renew.unref();
        };
        scheduleRenew();
        socket.onClose(lost);
        void socket
          .stream(
            "orchestration.subscribeShell",
            {
              ...(config.shellThreadFamilies ? { omitIdleSubagents: true } : {}),
              ...(config.shellThreadFamilies && config.shellOlderSettled ? { omitOlderSettled: true } : {}),
            },
            onShell,
          )
          .catch(() => {})
          // A shell stream that ends leaves the bridge blind; reconnect.
          .finally(() => socket?.close());
        for (const f of follows.values()) subscribeFollow(f);
      } catch (error) {
        socket?.close();
        if (!closed && rpc === undefined) {
          // A refused session is reported from `lost`; anything else means T3 Code didn't answer.
          if (!(error instanceof T3Error && error.reason === "t3_auth")) setStatus({ state: "unreachable", ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}) });
          lost(error);
        }
      }
    };
    void connect();


    // -----------------------------------------------------------------------------------------
    // Followed threads (ADR 0022): `orchestration.subscribeThread` per thread someone has open in
    // the room, turned into the room's items (t3thread.ts) and sent in batches.
    // -----------------------------------------------------------------------------------------
    interface Follow {
      threadId: string;
      send: (update: ThreadUpdate) => void;
      sub?: { cancel(): void };
      context: ThreadContext;
      /** Every turn item seen, by id, to normalize again when its run, request or checkpoint changes. */
      raw: Map<string, T3TurnItem>;
      /** The visible items the bridge knows, by id: the first page of older history comes from here. */
      held: Map<string, ThreadItem>;
      pending: Map<string, ThreadItem>;
      removed: Set<string>;
      timer?: ReturnType<typeof setTimeout>;
      /** T3 Code holds items before the oldest the bridge got. */
      older: boolean;
      snapshotSequence: number;
    }
    /** Followed threads by T3 Code's thread id. */
    const follows = new Map<string, Follow>();
    /** Most turn items kept per followed thread; the oldest go first. */
    const HELD_MAX = 3000;
    const flushFollow = (f: Follow) => {
      clearTimeout(f.timer);
      f.timer = undefined;
      if (!f.pending.size && !f.removed.size) return;
      const items = [...f.pending.values()].sort(byOrder);
      const removed = [...f.removed];
      f.pending.clear();
      f.removed.clear();
      f.send({ items, ...(removed.length ? { removed } : {}) });
    };
    const queue = (f: Follow, item: ThreadItem) => {
      f.held.set(item.itemId, item);
      f.pending.set(item.itemId, item);
      f.removed.delete(item.itemId);
      f.timer ??= setTimeout(() => flushFollow(f), this.options.threadFlushMs ?? 250);
      f.timer.unref?.();
    };
    const drop = (f: Follow, id: string) => {
      if (!f.held.delete(id)) return;
      f.pending.delete(id);
      f.removed.add(id);
      f.timer ??= setTimeout(() => flushFollow(f), this.options.threadFlushMs ?? 250);
      f.timer.unref?.();
    };
    /** Normalizes an item again after what it depends on changed, sending it if it changed. */
    const renormalize = (f: Follow, item: T3TurnItem) => {
      const next = isVisible(item, f.context) ? normalizeItem(item, f.context) : undefined;
      if (!next) return drop(f, item.id);
      if (JSON.stringify(f.held.get(item.id)) !== JSON.stringify(next)) queue(f, next);
    };
    const trimHeld = (f: Follow) => {
      if (f.raw.size <= HELD_MAX) return;
      const oldest = [...f.raw.values()].sort((a, b) => a.ordinal - b.ordinal).slice(0, f.raw.size - HELD_MAX);
      for (const item of oldest) {
        f.raw.delete(item.id);
        f.held.delete(item.id);
      }
      f.older = true;
    };
    /**
     * Older items read for the room join what the bridge follows, so a turn rolled back later takes
     * them out of the room too, as it does the newer ones.
     */
    const remember = (f: Follow, raw: T3TurnItem[], visible: ThreadItem[]) => {
      for (const item of raw) if (!f.raw.has(item.id)) f.raw.set(item.id, item);
      for (const item of visible) if (!f.held.has(item.itemId)) f.held.set(item.itemId, item);
      trimHeld(f);
    };
    type Projection = {
      runs?: { id: string; status: string }[];
      runtimeRequests?: { id: string; status: string; decision?: string; answers?: unknown }[];
      checkpoints?: { id: string; appRunOrdinal: number | null }[];
      turnItems?: T3TurnItem[];
      visibleTurnItems?: { visibility: string; item: T3TurnItem }[];
    };
    const contextOf = (projection: Projection, context = newThreadContext()) => {
      for (const run of projection.runs ?? []) context.runs.set(run.id, run.status);
      for (const r of projection.runtimeRequests ?? [])
        context.requests.set(r.id, { status: r.status, ...(r.decision ? { decision: r.decision } : {}), ...(r.answers ? { answered: true } : {}) });
      for (const c of projection.checkpoints ?? []) if (c.appRunOrdinal !== null) context.checkpoints.set(c.id, c.appRunOrdinal);
      return context;
    };
    /** A thread's own visible items, oldest first. */
    const visibleItems = (projection: Projection, context: ThreadContext) => {
      const own = projection.visibleTurnItems
        ? projection.visibleTurnItems.filter((row) => row.visibility === "local").map((row) => row.item)
        : (projection.turnItems ?? []);
      return own
        .filter((item) => isVisible(item, context))
        .map((item) => normalizeItem(item, context))
        .filter((item): item is ThreadItem => !!item)
        .sort(byOrder);
    };
    const onThread = (f: Follow, value: unknown) => {
      const message = value as {
        kind: string;
        snapshotSequence?: number;
        projection?: Projection;
        hasMoreHistory?: boolean;
        event?: { type: string; payload?: Record<string, unknown> };
      };
      if (message.kind === "snapshot" && message.projection) {
        clearTimeout(f.timer);
        f.timer = undefined;
        f.pending.clear();
        f.removed.clear();
        f.context = contextOf(message.projection);
        f.raw = new Map((message.projection.turnItems ?? []).map((item) => [item.id, item]));
        for (const row of message.projection.visibleTurnItems ?? []) if (row.visibility === "local") f.raw.set(row.item.id, row.item);
        const visible = visibleItems(message.projection, f.context);
        f.held = new Map(visible.map((item) => [item.itemId, item]));
        f.snapshotSequence = message.snapshotSequence ?? 0;
        f.older = message.hasMoreHistory === true;
        const first = visible.slice(-FIRST_ITEMS);
        f.send({ items: first, reset: true, older: f.older || visible.length > first.length });
        trimHeld(f);
        return;
      }
      if (message.kind !== "event" || !message.event?.payload) return;
      const { type, payload } = message.event;
      if (type === "turn-item.updated") {
        const item = payload as unknown as T3TurnItem;
        f.raw.set(item.id, item);
        renormalize(f, item);
        trimHeld(f);
      } else if (type === "run.updated" && typeof payload.id === "string" && typeof payload.status === "string") {
        f.context.runs.set(payload.id, payload.status);
        if (payload.status === "rolled_back" || payload.status === "cancelled") {
          for (const item of f.raw.values()) if (item.runId === payload.id) renormalize(f, item);
          // The turn may have been all the room had: the newest items left fill its window again.
          for (const item of [...f.held.values()].sort(byOrder).slice(-FIRST_ITEMS)) if (!f.pending.has(item.itemId)) queue(f, item);
        }
      } else if (type === "runtime-request.updated" && typeof payload.id === "string") {
        f.context.requests.set(payload.id, {
          status: String(payload.status ?? "pending"),
          ...(typeof payload.decision === "string" ? { decision: payload.decision } : {}),
          ...(payload.answers ? { answered: true } : {}),
        });
        for (const item of f.raw.values()) if (item.requestId === payload.id) renormalize(f, item);
      } else if (type === "checkpoint.captured" && typeof payload.id === "string" && typeof payload.appRunOrdinal === "number") {
        f.context.checkpoints.set(payload.id, payload.appRunOrdinal);
        for (const item of f.raw.values()) if (item.checkpointId === payload.id) renormalize(f, item);
      }
    };
    /** Subscribes to a followed thread on the current connection. A snapshot comes first. */
    const subscribeFollow = (f: Follow) => {
      f.sub?.cancel();
      f.sub = undefined;
      if (!rpc) return;
      const sub = rpc.subscribe("orchestration.subscribeThread", { threadId: f.threadId, acceptBoundedSnapshot: true }, (value) => {
        if (follows.get(f.threadId) === f) onThread(f, value);
      });
      f.sub = sub;
      // A stream that ends while the socket stays up (the thread was deleted) is left ended; a lost
      // socket subscribes again on reconnect.
      sub.done.catch(() => {});
    };
    /** Reads older items with T3 Code's history route: the items before `beforeId`, oldest first. */
    const historyBefore = async (f: Follow | undefined, threadId: string, beforeId: string) => {
      // T3 Code's cursor names an item, and a page ends just before it (threadHistoryPaging.ts
      // `findCursorEndIndex`); its fields are read in that file at commit 9e85538.
      const cursor = Buffer.from(JSON.stringify({ v: 1, seq: f?.snapshotSequence ?? 0, st: threadId, si: beforeId, p: 0 })).toString("base64url");
      const response = await fetch(
        new URL(`api/orchestration/threads/${encodeURIComponent(threadId)}/history?cursor=${encodeURIComponent(cursor)}`, session.url.endsWith("/") ? session.url : `${session.url}/`),
        { headers: { authorization: `Bearer ${session.token}`, "x-t3-orchestration-protocol": "2" }, signal: AbortSignal.timeout(20000) },
      );
      if (!response.ok) throw new T3Error(response.status === 401 || response.status === 403 ? "t3_auth" : "rpc", `T3 Code's history answered HTTP ${response.status}`);
      const text = await response.text();
      const page = JSON.parse(events?.redact ? events.redact(text) : text) as { items: { visibility: string; item: T3TurnItem }[]; hasMoreHistory: boolean };
      const context = f?.context ?? newThreadContext();
      const own = page.items.filter((row) => row.visibility === "local").map((row) => row.item);
      const items = own
        .filter((item) => isVisible(item, context))
        .map((item) => normalizeItem(item, context))
        .filter((item): item is ThreadItem => !!item)
        .sort(byOrder);
      if (f) remember(f, own, items);
      return { items, older: page.hasMoreHistory };
    };

    const threadId = (threadRef: string) => launched.get(threadRef) ?? threadRef;
    /** T3 Code's id for a thread the room may reach, or a refusal. */
    const sharedId = (threadRef: string) => {
      const id = threadId(threadRef);
      if (!allowed(id)) throw new T3Error("rpc", NOT_SHARED);
      return id;
    };
    const dispatch = (command: Record<string, unknown>) => {
      if (!rpc) throw new T3Error("t3_unavailable", lastError);
      return rpc.request("orchestration.dispatchCommand", command);
    };
    const threadControl: ThreadControl = {
      start: async (request, bind) => {
        await ready();
        if (!rpc || closed) throw new ThreadStartError("t3_unavailable", lastError);
        const { cwd, repo } = request;
        // With neither, the watched project, which `project` may name by id or by a path inside it.
        const project =
          cwd || repo
            ? [...projects.values()]
                .filter((p) =>
                  cwd
                    ? inside(p.workspaceRoot, cwd)
                    : !!p.repositoryIdentity && normalizeRepo(p.repositoryIdentity.canonicalKey) === normalizeRepo(repo!),
                )
                .sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length)[0]
            : watchedProject();
        if (!project)
          throw new ThreadStartError(
            "project_not_registered",
            `No T3 Code project ${cwd ? `contains ${cwd}` : repo ? `has the repo ${repo}` : `matches ${root}`}. Add it with t3 project add.`,
          );
        const drivers = HARNESS_DRIVERS[request.harness] ?? [];
        const candidates = providers.filter(
          (p) => p.instanceId === request.harness || drivers.includes(p.driver),
        );
        const provider = candidates.find(
          (p) =>
            p.enabled && p.installed && p.status !== "error" && p.status !== "disabled" && p.availability !== "unavailable" && p.models.length,
        );
        if (!provider)
          throw new ThreadStartError(
            "harness_disabled",
            candidates.length
              ? `T3 Code's ${request.harness} provider isn't ready: ${candidates
                  .map((p) => `${p.instanceId} is ${p.enabled ? "" : "disabled, "}${p.installed ? "" : "not installed, "}status ${p.status}${p.auth?.status ? `, auth ${p.auth.status}` : ""}`)
                  .join("; ")}.`
              : `T3 Code has no provider for ${request.harness}.`,
          );
        // The mode the room asked for (ADR 0043), which the provider must list. With approvals
        // required, the default, approvals reach the room only when the provider asks for them.
        const runtimeMode = request.runtimeMode ?? "approval-required";
        if (provider.supportedRuntimeModes && !provider.supportedRuntimeModes.includes(runtimeMode))
          throw new ThreadStartError(
            "mode_unsupported",
            `T3 Code's ${provider.instanceId} provider can't run in ${runtimeMode}. It takes ${provider.supportedRuntimeModes.join(", ")}.`,
          );
        const model =
          project.defaultModelSelection?.instanceId === provider.instanceId
            ? project.defaultModelSelection.model
            : (provider.models.find((m) => m.isDefault) ?? provider.models.find((m) => !m.isLegacy) ?? provider.models[0])!.slug;
        // Derived from the run, so a start the room delivers again reuses T3's launch receipt.
        const id = `uplink-room-${request.runId}`;
        launched.set(request.runId, id);
        await bind(id);
        const prompt = request.prompt?.trim();
        try {
          await rpc.request(
            "orchestration.launchThread",
            {
              commandId: `uplink-room:start-thread:${request.runId}`,
              threadId: id,
              projectId: project.id,
              title: prompt ? prompt.split("\n")[0]!.slice(0, 80) : "Uplink Room run",
              generateTitle: !!prompt,
              modelSelection: { instanceId: provider.instanceId, model },
              runtimeMode,
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              ...(prompt ? { initialMessage: { text: prompt, attachments: [] } } : {}),
            },
            60000,
          );
        } catch (error) {
          const t3 = error instanceof T3Error ? error : undefined;
          const reason =
            t3?.reason === "t3_auth" || t3?.reason === "t3_unavailable"
              ? t3.reason
              : t3?.tag === "ThreadManagementProviderInstanceDisabledError"
                ? "harness_disabled"
                : /project not found/i.test(t3?.message ?? "")
                  ? "project_not_registered"
                  : "launch_failed";
          throw new ThreadStartError(reason, (error as Error).message);
        }
      },
      shares: (threadRef) => allowed(threadId(threadRef)),
      stop: async (threadRef) => {
        await ready();
        const id = sharedId(threadRef);
        const commandId = randomUUID();
        if (threadStop) {
          await dispatch({ type: "thread.stop", commandId, threadId: id, reason: "Stopped from Uplink Room" });
          return;
        }
        // Older servers: interrupt the active run (client-runtime operations/commands.ts).
        const runId = threads.get(id)?.activeRunId;
        if (runId) await dispatch({ type: "run.interrupt", commandId, threadId: id, runId, reason: "Stopped from Uplink Room" });
      },
      answer: async (threadRef, promptId, answer) => {
        const id = threadId(threadRef);
        if (!allowed(id)) return "no_pending_approval";
        const current = pending.get(id);
        if (!current?.answerable || current.prompt.kind !== "approval") return "no_pending_approval";
        if (current.prompt.promptId !== promptId) return "stale_prompt";
        // Allow once and deny only: never acceptForSession or acceptAlways.
        const decision = answer === "allow" ? "accept" : "decline";
        if (current.decisions && !current.decisions.includes(decision)) return "no_pending_approval";
        // Taken out while the answer is in flight, so a second answer can't be sent alongside it.
        pending.delete(id);
        const gen = generation.get(id);
        try {
          await dispatch({
            type: "runtime-request.respond",
            commandId: `uplink-room:answer:${promptId}`,
            threadId: id,
            requestId: current.requestId,
            decision,
          });
        } catch {
          // T3 refuses a request that was already answered or expired, but a timeout or a restart
          // fails the same way while the approval still waits. Ask T3: only a request it no longer
          // lists as pending is gone. If it can't say, the approval stays answerable.
          const thread = threads.get(id);
          const found = thread && rpc ? await promptFor(thread, current.requestId).catch(() => current) : current;
          if (!found) return "stale_prompt";
          // A newer shell update for this thread already says what it waits on.
          if (!closed && generation.get(id) === gen && !pending.has(id)) pending.set(id, found);
          return "answer_failed";
        }
        const thread = threads.get(id);
        if (thread) send(thread, { state: "working" });
        return undefined;
      },
      send: async (threadRef, message) => {
        await ready();
        const id = sharedId(threadRef);
        // The files first, so a message never goes without the files it was sent with (ADR 0043).
        let attachments: T3Attachment[] = [];
        if (message.files?.length) {
          if (!rpc) throw new T3Error("t3_unavailable", lastError);
          attachments = await uploadToT3(rpc, session.url, message.files);
        }
        // The run was stopped, or the sender lost the thread, while the files moved: nothing is sent.
        if (message.wanted && !message.wanted()) throw new Error("The message was no longer wanted when its files were in.");
        // Or it stopped being shared meanwhile.
        sharedId(threadRef);
        // Read once the files are in, as the turn may have ended meanwhile. A thread at work takes the
        // message after its turn, as `t3 thread send` does: nothing is interrupted, and no turn is
        // steered (steering wasn't verified, research experiment 2).
        const thread = threads.get(id);
        const busy =
          !!thread?.activeRunId || ["running", "preparing", "starting", "queued", "waiting"].includes(thread?.activityRunStatus ?? thread?.status ?? "");
        await dispatch({
          type: "message.dispatch",
          // Required by the command's schema; T3 Code's own client sends the same, and the server
          // records every socket message as the user's whatever is sent (ws.ts `withCreationProvenance`).
          createdBy: "user",
          creationSource: "web",
          // From the room's message id, so a message the room delivers again is sent once.
          commandId: `uplink-room:message:${message.messageId}`,
          threadId: id,
          messageId: `${ROOM_MESSAGE_PREFIX}${message.messageId}`,
          text: message.text,
          attachments,
          dispatchMode: busy ? { type: "queue_after_active" } : { type: "start_immediately" },
        });
        return busy ? "queued" : "sent";
      },
      setMode: async (threadRef, mode) => {
        await ready();
        const id = sharedId(threadRef);
        const thread = threads.get(id);
        const modes = thread ? modesOf(thread.providerInstanceId) : undefined;
        if (modes && !modes.includes(mode)) throw new T3Error("rpc", `This thread's provider takes ${modes.join(", ")}.`);
        await dispatch({ type: "thread.runtime-mode.set", commandId: randomUUID(), threadId: id, runtimeMode: mode });
      },
      interrupt: async (threadRef) => {
        await ready();
        const id = sharedId(threadRef);
        const runId = threads.get(id)?.activeRunId;
        if (!runId) return false;
        await dispatch({ type: "run.interrupt", commandId: randomUUID(), threadId: id, runId, reason: "Stopped from Uplink Room" });
        return true;
      },
      deliver: async (threadRef, delivery) => {
        await ready();
        const socket = rpc;
        if (!socket || closed) throw new ThreadDeliveryError(lastError, false);
        const id = threadId(threadRef);
        if (!allowed(id)) throw new ThreadDeliveryError(NOT_SHARED, false);
        // Read now, not from the shell: whether a turn runs, and how its provider takes a steer.
        let projection: SteerProjection;
        try {
          projection = (await socket.request("orchestration.getThreadProjection", { threadId: id })) as SteerProjection;
        } catch (error) {
          throw new ThreadDeliveryError((error as Error).message, false);
        }
        // Unshared while this projection was in flight: do not publish hearing metadata either.
        if (!allowed(id)) throw new ThreadDeliveryError(NOT_SHARED, false);
        learnTurns(projection);
        const thread = threads.get(id);
        if (thread) tellHearing(thread);
        const active = [...(projection.runs ?? [])].reverse().find((run) => ACTIVE_RUN.has(run.status));
        let dispatchMode: Record<string, unknown> = { type: "start_immediately" };
        let how: RunMessageHow = "next_turn";
        if (active) {
          // As T3 Code does: a run whose provider turn hasn't started yet, or has ended, takes no steer.
          const turnRuns = projection.providerTurns?.some((turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running");
          const providerThread = projection.providerThreads?.find((row) => row.id === active.providerThreadId);
          const turns = projection.providerSessions?.find((row) => row.id === providerThread?.providerSessionId)?.capabilities?.turns;
          if (turnRuns && turns && steersCleanly(turns)) {
            dispatchMode = { type: "steer_active", targetRunId: active.id };
            how = "mid_task";
          } else dispatchMode = { type: "queue_after_active" };
        }
        // Files can't steer a turn: T3 Code restarts it instead (contracts orchestrationV2.ts), so a
        // delivery with files waits for the turn.
        if (delivery.files?.length && how === "mid_task") {
          dispatchMode = { type: "queue_after_active" };
          how = "next_turn";
        }
        let attachments: T3Attachment[] = [];
        if (delivery.files?.length)
          try {
            attachments = await uploadToT3(socket, session.url, delivery.files);
          } catch (error) {
            throw new ThreadDeliveryError((error as Error).message, false);
          }
        // Stopped while the projection was read: a start_immediately now would start the thread again.
        if (delivery.wanted && !delivery.wanted()) throw new ThreadDeliveryError("The run was stopped before its messages were sent.", false);
        if (!allowed(id)) throw new ThreadDeliveryError(NOT_SHARED, false);
        try {
          await socket.request("orchestration.dispatchCommand", {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            // From the room's claim, so a delivery sent again is sent once.
            commandId: `uplink-room:run-message:${delivery.id}`,
            threadId: id,
            messageId: `${ROOM_MESSAGE_PREFIX}run:${delivery.id}`,
            text: delivery.text,
            attachments,
            dispatchMode,
          });
        } catch (error) {
          // T3 Code refused it (`rpc`); anything else may have reached it first.
          throw new ThreadDeliveryError((error as Error).message, !(error instanceof T3Error && error.reason === "rpc"));
        }
        return how;
      },
      answerQuestion: async (threadRef, promptId, answers) => {
        const id = threadId(threadRef);
        if (!allowed(id)) return "no_pending_question";
        const current = pending.get(id);
        if (!current?.answerable || current.prompt.kind !== "question") return "no_pending_question";
        if (current.prompt.promptId !== promptId) return "stale_prompt";
        const known = new Set(current.prompt.questions?.map((q) => q.id));
        const entries = Object.entries(answers);
        if (!entries.length || entries.some(([key, value]) => !known.has(key) || (Array.isArray(value) ? value.some((v) => v.length > 4000) : value.length > 4000)))
          return "invalid_answer";
        pending.delete(id);
        const gen = generation.get(id);
        try {
          await dispatch({
            type: "runtime-request.respond",
            commandId: `uplink-room:answer:${promptId}`,
            threadId: id,
            requestId: current.requestId,
            answers,
          });
        } catch {
          // As for an approval: only a request T3 no longer lists as pending is gone.
          const thread = threads.get(id);
          const found = thread && rpc ? await promptFor(thread, current.requestId).catch(() => current) : current;
          if (!found) return "stale_prompt";
          if (!closed && generation.get(id) === gen && !pending.has(id)) pending.set(id, found);
          return "answer_failed";
        }
        const thread = threads.get(id);
        if (thread) send(thread, { state: "working" });
        return undefined;
      },
      watch: (threadRef, sendItems) => {
        const id = threadId(threadRef);
        // Not shared: nothing is read from T3 Code for it until it is.
        if (!allowed(id)) return void deferred.set(id, sendItems);
        const existing = follows.get(id);
        if (existing) {
          existing.send = sendItems;
          // Someone opened it again: send the newest items again, as T3 Code sees them now.
          return subscribeFollow(existing);
        }
        const f: Follow = {
          threadId: id,
          send: sendItems,
          context: newThreadContext(),
          raw: new Map(),
          held: new Map(),
          pending: new Map(),
          removed: new Set(),
          older: false,
          snapshotSequence: 0,
        };
        follows.set(id, f);
        subscribeFollow(f);
      },
      unwatch: (threadRef) => {
        const id = threadId(threadRef);
        deferred.delete(id);
        const f = follows.get(id);
        if (!f) return;
        follows.delete(id);
        clearTimeout(f.timer);
        f.sub?.cancel();
      },
      history: async (threadRef, beforeItemId) => {
        const id = sharedId(threadRef);
        const page = await readHistory(id, beforeItemId);
        // It stopped being shared while T3 Code answered: none of it goes to the room.
        sharedId(threadRef);
        return page;
      },
      diff: async (threadRef, turn) => {
        const id = sharedId(threadRef);
        const diff = await readDiff(id, turn);
        sharedId(threadRef);
        return diff;
      },
    };
    const readHistory = async (id: string, beforeItemId: string) => {
      const f = follows.get(id);
      const before = f?.held.get(beforeItemId);
      // First from what the bridge already holds, then from T3 Code.
      const held = before && f ? [...f.held.values()].filter((item) => byOrder(item, before) < 0).sort(byOrder) : [];
      if (held.length >= HISTORY_PAGE || (held.length && f && !f.older && held.length < f.held.size))
        return { items: held.slice(-HISTORY_PAGE), older: held.length > HISTORY_PAGE || f!.older };
      if (!rpc) throw new T3Error("t3_unavailable", lastError);
      const oldest = held[0]?.itemId ?? beforeItemId;
      let fetched: { items: ThreadItem[]; older: boolean };
      try {
        fetched = await historyBefore(f, id, oldest);
      } catch (error) {
        if (error instanceof T3Error && error.reason === "t3_auth") throw error;
        // A server without the history route, or a cursor it refuses: read the whole thread once.
        const projection = (await rpc.request("orchestration.getThreadProjection", { threadId: id })) as Projection;
        const context = contextOf(projection);
        const all = visibleItems(projection, context);
        const at = all.findIndex((item) => item.itemId === oldest);
        const before2 = at < 0 ? [] : all.slice(0, at);
        fetched = { items: before2.slice(-HISTORY_PAGE), older: before2.length > HISTORY_PAGE };
        if (f) {
          const ids = new Set(fetched.items.map((item) => item.itemId));
          const own = projection.visibleTurnItems
            ? projection.visibleTurnItems.filter((row) => row.visibility === "local").map((row) => row.item)
            : (projection.turnItems ?? []);
          remember(f, own.filter((item) => ids.has(item.id)), fetched.items);
        }
      }
      const items = [...fetched.items, ...held].sort(byOrder);
      return { items: items.slice(-HISTORY_PAGE), older: fetched.older || items.length > HISTORY_PAGE };
    };
    /** One turn's diff, cut to THREAD_ITEM_LIMITS.turnDiff bytes. */
    const readDiff = async (id: string, turn: number) => {
      if (!rpc) throw new T3Error("t3_unavailable", lastError);
      if (!Number.isInteger(turn) || turn < 1) throw new T3Error("rpc", "No such turn.");
      const result = (await rpc.request("orchestration.getTurnDiff", {
        threadId: id,
        fromTurnCount: turn - 1,
        toTurnCount: turn,
      })) as { diff?: string };
      const diff = result.diff ?? "";
      const bytes = Buffer.from(diff);
      if (bytes.length <= THREAD_ITEM_LIMITS.turnDiff) return { diff, cut: false };
      // Cut at a line inside the limit, never inside a character.
      const kept = bytes.subarray(0, THREAD_ITEM_LIMITS.turnDiff).toString("utf8");
      return { diff: kept.slice(0, Math.max(0, kept.lastIndexOf("\n"))), cut: true };
    };
    /** Where a thread stands, for the person picking threads to share. */
    const catalogState = (thread: ThreadShell): T3ThreadState => {
      const request = thread.pendingRuntimeRequest;
      if (request && (request.kind === "user_input" || APPROVAL_KINDS.has(request.kind))) return "waiting";
      const state = stateOf(thread);
      return state === "unknown" ? "idle" : state;
    };
    const local: T3Local = {
      catalog: (): T3Catalog => {
        const ready = !!rpc && synced;
        return {
          state: ready ? "ready" : refusedSince !== undefined ? "needs_pairing" : "connecting",
          ...(environmentId ? { environmentId } : {}),
          threads: ready
            ? [...threads.values()].filter(listed).map((thread): T3CatalogThread => {
                const project = projects.get(thread.projectId);
                const room = fromRoom(thread.id);
                return {
                  id: thread.id,
                  title: thread.title,
                  projectId: thread.projectId,
                  project: project?.title?.trim() || (project ? folderName(project.workspaceRoot) : "No repo"),
                  ...(project ? { projectRoot: project.workspaceRoot } : {}),
                  state: catalogState(thread),
                  ...(typeof thread.updatedAt === "string" ? { updatedAt: thread.updatedAt } : {}),
                  shared: room || admitted.has(thread.id),
                  fromRoom: room,
                };
              })
            : [],
        };
      },
      share: (selection) => this.setSelection(selection),
    };
    this.selectionChanged.add(reconcile);
    reconcile();
    return {
      close: () => {
        closed = true;
        this.selectionChanged.delete(reconcile);
        clearTimeout(retry);
        clearTimeout(renew);
        for (const f of follows.values()) clearTimeout(f.timer);
        follows.clear();
        deferred.clear();
        rpc?.close();
        settle();
      },
      local,
      threads: threadControl,
    };
  }
}
