/**
 * The bridge-to-room protocol (spec #3, "the second test seam").
 *
 * Every message carries `v`, the protocol version. The room and the bridge
 * reject messages from a version they don't speak.
 */
import { v, type Infer } from "convex/values";

export const PROTOCOL_VERSION = 1 as const;

/** Access levels, ordered from least to most open. */
export const ACCESS_LEVELS = ["watch", "suggest", "drive", "open"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export function accessRank(access: Access): number {
  return ACCESS_LEVELS.indexOf(access);
}

/** The less open of two access levels. */
export function minAccess(a: Access, b: Access): Access {
  return accessRank(a) <= accessRank(b) ? a : b;
}

export const vAccess = v.union(
  v.literal("watch"),
  v.literal("suggest"),
  v.literal("drive"),
  v.literal("open"),
);

/**
 * What the agent in a run may do without asking (GLOSSARY.md, "Permission mode"), ordered from
 * most careful to most permissive. The names are T3 Code's runtime modes (contracts
 * providerPolicy.ts `RuntimeMode`, v0.1.8-nightly.20261105.4234): `approval-required` asks before
 * commands and edits, `auto-accept-edits` edits files without asking, `auto` lets a reviewer
 * answer most approvals, `full-access` asks for nothing. A run that names none is
 * `approval-required`, as every room run was before ADR 0043.
 */
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

export function runtimeModeRank(mode: RuntimeMode): number {
  return RUNTIME_MODES.indexOf(mode);
}

/** The more careful of two permission modes. */
export function minRuntimeMode(a: RuntimeMode, b: RuntimeMode): RuntimeMode {
  return runtimeModeRank(a) <= runtimeModeRank(b) ? a : b;
}

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value);
}

export const vRuntimeMode = v.union(
  v.literal("approval-required"),
  v.literal("auto-accept-edits"),
  v.literal("auto"),
  v.literal("full-access"),
);

/**
 * A file the room hands a bridge with a message (ADR 0043): its name, what it is, and a link the
 * bridge downloads it from once, then forgets. `kind` is the room's (`image` and `pdf` show in the
 * app, any other `file` is only downloaded); `mimeType` is the type the room stored it with.
 */
export const vRoomFile = v.object({
  name: v.string(),
  kind: v.union(v.literal("image"), v.literal("pdf"), v.literal("file")),
  mimeType: v.string(),
  size: v.number(),
  url: v.string(),
});
export type RoomFile = Infer<typeof vRoomFile>;
/** At most this many files go with one message, as with a chat message's attachments. */
export const MAX_MESSAGE_FILES = 10;

/**
 * What a run's adapter can say about it. `unknown` means the tool has no adapter. `stopped`
 * means someone ended the run before it finished (T3 Code's interrupted or cancelled run, or a
 * deleted thread); older bridges never send it.
 */
export const vReportedRunState = v.union(
  v.literal("working"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("unknown"),
  v.literal("stopped"),
);
export type ReportedRunState = Infer<typeof vReportedRunState>;

/**
 * One question of a T3 Code question prompt (ADR 0023), as T3 Code asks it. An answer is an
 * option's label (or several, with `multiSelect`), or the person's own words when `allowCustomAnswer`.
 */
export const vQuestion = v.object({
  id: v.string(),
  header: v.string(),
  question: v.string(),
  options: v.array(v.object({ label: v.string(), description: v.optional(v.string()) })),
  multiSelect: v.optional(v.boolean()),
  allowCustomAnswer: v.optional(v.boolean()),
});
export type Question = Infer<typeof vQuestion>;

/** What a waiting run asks for. Approvals, and T3 Code questions with `questions`, can be answered from the room. */
export const vPrompt = v.object({
  kind: v.union(v.literal("approval"), v.literal("question")),
  text: v.string(),
  /**
   * For a question the room can answer (ADR 0023): its questions. Sent only to a room that names
   * `thread_questions`; a question without them is answered on the machine.
   */
  questions: v.optional(v.array(vQuestion)),
  /** For approvals, the action it asks to take, such as a command. */
  action: v.optional(v.string()),
  /** True when the action is hard to undo (a deploy). */
  hardToUndo: v.optional(v.boolean()),
  /**
   * For approvals, and questions with `questions`: a fresh id the bridge gives each one it reports.
   * An answer applies only when it names the one still pending. Optional so prompts from bridges
   * that don't send ids still validate.
   */
  promptId: v.optional(v.string()),
});
export type Prompt = Infer<typeof vPrompt>;

/**
 * Where a run lives on the machine: a terminal the bridge shares, or a T3 Code thread.
 * In messages from the bridge, a `terminalId` is the room's id, or, until the
 * room sends `terminal_linked`, the terminal's `localRef`.
 */
export const vRunSource = v.union(
  v.object({ kind: v.literal("terminal"), terminalId: v.string() }),
  v.object({ kind: v.literal("thread"), threadRef: v.string() }),
);
export type RunSource = Infer<typeof vRunSource>;

/**
 * The machine's own limits, set on the machine by whoever it belongs to.
 * The bridge never goes past them, whatever the room asks.
 */
export const vMachineLimits = v.object({
  mostOpenAccess: vAccess,
  slots: v.number(),
  /** Longest a profile may be kept, in milliseconds. */
  longestProfileMs: v.number(),
});
export type MachineLimits = Infer<typeof vMachineLimits>;

/** Who the room says is acting. The bridge only compares these. */
export const vActorRef = v.object({ memberId: v.string(), name: v.string() });
export type ActorRef = Infer<typeof vActorRef>;

// ---------------------------------------------------------------------------
// What the room understands (ADR 0021)
// ---------------------------------------------------------------------------

/**
 * The bridge messages a room takes beyond the first protocol. `bridge.send` returns the list
 * (`{ features }`); a room from before it returns null. A bridge sends a message from this list
 * only once the room has named its feature, because a room refuses a message it doesn't know and
 * the bridge would then stop sharing.
 *
 * - `bridge_features`: `bridge_features` (what this bridge handles, below).
 * - `thread_access`: `thread_access` (a thread's access, clamped on the machine).
 * - `t3_status`: `t3_status` (the machine's T3 Code pairing).
 * - `thread_view`: `thread_items`, `thread_history_page` and `thread_diff` (a thread's conversation).
 * - `thread_messages`: `thread_message_result` (how a message sent from the room went).
 * - `thread_questions`: a `question` prompt with `questions` and a `promptId`, to answer from the room.
 * - `thread_closed`: `thread_closed` (T3 Code archived or deleted a thread).
 * - `run_messages`: `run_message_result` and `run_hearing` (messages to a live run, ADR 0026).
 * - `run_say`: `bridge:runSay`, a run in one of the bridge's terminals posting as itself (ADR 0026).
 * - `thread_run_messages`: `bridge:claimRunMessages` and `bridge:runSay` with a `threadRef`, for a run
 *   in a T3 Code thread (ADR 0037), and `run_hearing` for one.
 * - `thread_modes`: `thread_mode` (a thread's permission mode, and the modes its provider takes, ADR 0043).
 * - `run_message_files`: `bridge:claimRunMessages` takes `maxFiles`, and `bridge:holdRunMessages` holds
 *   a claim while its files move (ADR 0043). A room from before refuses a claim naming `maxFiles`.
 * - `run_say_files`: `bridge:runAttachUrl`, and `bridge:runSay` with `attachments`: a run sends files
 *   with what it posts (ADR 0047). A room from before refuses `attachments` in its argument validator.
 */
export const ROOM_FEATURES = [
  "bridge_features",
  "thread_access",
  "t3_status",
  "thread_view",
  "thread_messages",
  "thread_questions",
  "thread_closed",
  "run_messages",
  "run_say",
  "thread_run_messages",
  "thread_modes",
  "run_message_files",
  "run_say_files",
] as const;
export type RoomFeature = (typeof ROOM_FEATURES)[number];

/**
 * The room messages a bridge handles beyond the first protocol, which it names in
 * `bridge_features`. A bridge from before ignores room messages it doesn't know, so the room asks
 * for these only where the machine's bridge named them.
 *
 * - `thread_driver`: `change_thread_access` and `thread_driver_changed`. Without it the bridge
 *   keeps a thread's first driver, and answers sent as anyone else are refused.
 * - `thread_view`: `watch_thread`, `unwatch_thread`, `thread_history` and `thread_diff_request`.
 * - `thread_messages`: `send_thread_message` and `interrupt_thread` (ADR 0023).
 * - `thread_questions`: `answer_question` (ADR 0023).
 * - `thread_closed`: no room message. The bridge sends `thread_closed` when T3 Code archives or
 *   deletes a thread it reported, so the room keeps a thread run whose turn is Done addressable
 *   between turns (ADR 0026) only for a bridge that says when the thread goes.
 * - `run_messages`: `run_messages_waiting` (ADR 0026), after which the bridge claims the messages
 *   (`bridge:claimRunMessages`, `runMessages.ts`). Without it a message to a run on this machine
 *   waits in the run's inbox in the room.
 * - `thread_run_messages`: `run_messages_waiting` for a run in a T3 Code thread (ADR 0037). The bridge
 *   claims the messages by the thread and sends them into it. Without it they wait in the room.
 * - `thread_modes`: `start_thread` with a `runtimeMode`, and `set_thread_mode` (ADR 0043). Without it
 *   every thread the room starts there asks for approvals, and its mode can't change from the room.
 * - `thread_attachments`: `send_thread_message` with `attachments` (ADR 0043). Without it a message
 *   from the thread's box carries text only.
 * - `run_message_files`: `bridge:claimRunMessages` hands each message's files (`RunDelivery.files`),
 *   which the bridge gives the run the way its harness takes them (ADR 0043). Without it the run only
 *   hears how many files stay in the room.
 */
export const BRIDGE_FEATURES = [
  "thread_driver",
  "thread_view",
  "thread_messages",
  "thread_questions",
  "thread_closed",
  "run_messages",
  "thread_run_messages",
  "thread_modes",
  "thread_attachments",
  "run_message_files",
] as const;
export type BridgeFeature = (typeof BRIDGE_FEATURES)[number];

/**
 * Where the bridge's T3 Code pairing stands (GLOSSARY.md, "T3 Code pairing"). `connected`: T3 Code
 * answers with the bridge's session. `unreachable`: T3 Code isn't running, or doesn't answer.
 * `needs_pairing`: T3 Code refused the session, because it expired or was revoked; the bridge stops
 * retrying it until someone pairs again.
 */
export const vT3PairingState = v.union(v.literal("connected"), v.literal("unreachable"), v.literal("needs_pairing"));
export type T3PairingState = Infer<typeof vT3PairingState>;

// ---------------------------------------------------------------------------
// A thread's conversation (ADR 0022)
// ---------------------------------------------------------------------------

/**
 * The most a thread item carries, so a stored item stays far under Convex's 1 MiB document limit and
 * a page of them under its 16 MiB read limit. The bridge cuts to these; the room cuts again.
 */
/**
 * T3 Code's id for a message the room sent into a thread: this and the room's message id (ADR 0023).
 * A thread item's `messageRef` shows it, which is how the room knows who sent the message.
 */
export const ROOM_MESSAGE_PREFIX = "uplink-room:";

export const THREAD_ITEM_LIMITS = {
  /** A message's, reasoning's, plan's or notice's text, in characters. */
  text: 16_000,
  /** A tool call's input (its command), in characters. */
  input: 2_000,
  /** A tool call's output, its last characters. */
  output: 4_000,
  /** A file change's diff, its first characters. */
  diff: 12_000,
  /** A plan's steps, a checkpoint's files, a message's attachments. */
  list: 50,
  /** A diff fetched on request, in UTF-8 bytes. */
  turnDiff: 600_000,
} as const;

/**
 * One item of a T3 Code thread's conversation, as the room keeps it: a small, fixed shape the
 * bridge makes from T3 Code's turn items, so the room never depends on T3 Code's own types.
 *
 * - `message`: what someone wrote (`role` user) or the agent answered (`role` assistant).
 * - `reasoning`: the agent's thinking, when the harness shares it.
 * - `tool`: a tool call (`tool`: command, search, web, tool, subagent), with its input and output.
 * - `file_change`: a file the agent changed, with its diff when T3 Code has one.
 * - `plan`: a proposed plan (`text`, markdown) or a to-do list (`steps`).
 * - `request`: an approval, question, secret or link request, and how it ended (`outcome`).
 * - `checkpoint`: the end of a turn that changed files: its turn number and files.
 * - `notice`: an error, an interruption or another line from T3 Code (`tone`).
 */
export const vThreadItem = v.object({
  /** T3 Code's turn item id: an item streamed again replaces the one with its id. */
  itemId: v.string(),
  /** Where it sits in the thread: T3 Code's ordinal. Items with one order sort by `itemId`. */
  order: v.number(),
  kind: v.union(
    v.literal("message"),
    v.literal("reasoning"),
    v.literal("tool"),
    v.literal("file_change"),
    v.literal("plan"),
    v.literal("request"),
    v.literal("checkpoint"),
    v.literal("notice"),
  ),
  /** T3 Code's run (one turn) the item belongs to, so the view can fold a turn's work. */
  turnRef: v.optional(v.string()),
  /** T3 Code's item status: `running`, `completed`, `failed`, … */
  status: v.optional(v.string()),
  /** When it started, or else last changed (ms). */
  at: v.optional(v.number()),
  role: v.optional(v.union(v.literal("user"), v.literal("assistant"))),
  /** For a message: T3 Code's message id, so the room can tell which message it sent itself. */
  messageRef: v.optional(v.string()),
  text: v.optional(v.string()),
  /** Still streaming. */
  streaming: v.optional(v.boolean()),
  /** A tool call's title, a file's path. */
  title: v.optional(v.string()),
  tool: v.optional(v.string()),
  input: v.optional(v.string()),
  output: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  failed: v.optional(v.boolean()),
  additions: v.optional(v.number()),
  deletions: v.optional(v.number()),
  diff: v.optional(v.string()),
  steps: v.optional(v.array(v.object({ text: v.string(), status: v.string() }))),
  request: v.optional(v.union(v.literal("approval"), v.literal("question"), v.literal("secret"), v.literal("link"))),
  /** How a request ended: `accept`, `decline`, `answered`, `saved`, `linked`, `cancelled`, … */
  outcome: v.optional(v.string()),
  /** A checkpoint's turn number: its diff is `thread_diff_request` with this turn. */
  turn: v.optional(v.number()),
  files: v.optional(v.array(v.object({ path: v.string(), additions: v.number(), deletions: v.number() }))),
  /** Files sent with a message. Only their names and kinds: T3 Code's links to them are credentials. */
  attachments: v.optional(v.array(v.object({ name: v.string(), kind: v.string(), size: v.optional(v.number()) }))),
  tone: v.optional(v.union(v.literal("info"), v.literal("error"))),
  /** Some text was cut to THREAD_ITEM_LIMITS. */
  cut: v.optional(v.boolean()),
});
export type ThreadItem = Infer<typeof vThreadItem>;

// ---------------------------------------------------------------------------
// Messages to a live run (ADR 0026)
// ---------------------------------------------------------------------------

/**
 * How a run hears a message from the room. `mid_task`: during a turn, after its next tool call, and
 * at once when it is idle (Claude Code's hooks). `between_turns`: only when a turn starts or ends.
 * `none`: it has no delivery path, so its messages wait in the room.
 */
export const vRunHearing = v.union(v.literal("mid_task"), v.literal("between_turns"), v.literal("none"));
export type RunHearing = Infer<typeof vRunHearing>;

/** How a message reached a run: during a turn, or with the next one (which it may have started). */
export const vRunMessageHow = v.union(v.literal("mid_task"), v.literal("next_turn"));
export type RunMessageHow = Infer<typeof vRunMessageHow>;

/** The most of a message's text the room sends a run, in characters. The bridge cuts again to fit its harness. */
export const RUN_MESSAGE_TEXT_MAX = 8000;

/**
 * A run on the bridge's machine posting as itself (`bridge:runSay`, ADR 0026): in a place it names
 * (`in`: "#payments", or a channel id), or under a message it answers (`replyTo`), never both and
 * never neither (ADR 0029 D5). The run is the one in a terminal (`terminalRef`: the terminal's room
 * id, or its local ref for one shared from the machine) or in a T3 Code thread (`threadRef`, the
 * thread's ref in the room, ADR 0037), sent only to a room that names `thread_run_messages`.
 */
export type RunSay = RunRef & {
  text: string;
  in?: string;
  replyTo?: string;
  /**
   * Files the run sends with the message (ADR 0047), each uploaded to a URL from `bridge:runAttachUrl`:
   * what `messages.post` takes in `attachments`. Sent only to a room that names `run_say_files`. With
   * files, the text may be empty.
   */
  attachments?: RunSayAttachment[];
};
/** The run a `bridge:runSay` or `bridge:runAttachUrl` is for: in a terminal, or in a T3 Code thread. */
export type RunRef = { terminalRef: string; threadRef?: never } | { threadRef: string; terminalRef?: never };
/** One file a run sends: its upload, its stored bytes, and the name it shows under. */
export type RunSayAttachment = { uploadId: string; storageId: string; name: string };
/** What `bridge:runAttachUrl` answers: where to POST one file's bytes, and the upload they belong to. */
export type RunAttachTarget = { uploadUrl: string; uploadId: string };
/** What `bridge:runSay` answers: the message, the name the run posted under, and where it went. */
export type RunSaid = { messageId: string; label: string; place: string };
/** The longest message a run posts, in characters. */
export const RUN_SAY_TEXT_MAX = 20_000;
/** The most files a run sends with one message: as many as any message keeps. */
export const RUN_SAY_FILES_MAX = 10;
/**
 * The largest file a run sends, in bytes: the room's limit for a PDF or any other file. An image may be
 * at most 20 MB, which the room checks when the message keeps it.
 */
export const RUN_SAY_FILE_BYTES_MAX = 50 * 1024 * 1024;

/**
 * The content type a file is uploaded with, from its name's extension. The room keeps an image or PDF
 * only when its stored type matches its extension, and offers anything else as a download.
 */
export function attachmentContentType(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return ATTACHMENT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

// ---------------------------------------------------------------------------
// Spaces (spec #6, ADR 0009)
// ---------------------------------------------------------------------------

/** Whether a Space is running on its machine, or Cua stopped or suspended it. */
export const vSpacePower = v.union(v.literal("running"), v.literal("stopped"), v.literal("suspended"));
export type SpacePower = Infer<typeof vSpacePower>;

/**
 * A Cua Space the bridge found on its machine. `spaceRef` is Cua's own id for it, such as
 * `local:studio` or `direct:10.0.0.5:3211`; the room's id for a shared Space is `spaceId`.
 */
export const vFoundSpace = v.object({
  spaceRef: v.string(),
  name: v.string(),
  /** "linux", "macos" or "windows", when Cua knows. */
  os: v.optional(v.string()),
  /** "container", "vm" or "microvm", when Cua knows. */
  kind: v.optional(v.string()),
  /** Whether Cua has it running. Absent from older bridges: running. */
  state: v.optional(vSpacePower),
});
export type FoundSpace = Infer<typeof vFoundSpace>;

const vButton = v.union(v.literal("left"), v.literal("right"), v.literal("middle"));

/**
 * One Space action. Points are in the pixels of the screenshot named by `screenshotId` when it's
 * set (what computer-use agents click on), else in the screen's logical points.
 */
export const vSpaceAction = v.union(
  v.object({ kind: v.literal("screenshot") }),
  v.object({
    kind: v.literal("click"),
    x: v.number(),
    y: v.number(),
    button: v.optional(vButton),
    /** 1 single, 2 double, 3 triple. */
    count: v.optional(v.number()),
    screenshotId: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("move"), x: v.number(), y: v.number(), screenshotId: v.optional(v.string()) }),
  v.object({
    kind: v.literal("scroll"),
    dx: v.number(),
    dy: v.number(),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    screenshotId: v.optional(v.string()),
  }),
  /** A key or a chord, in press order: `["enter"]`, `["ctrl", "s"]`, `["a"]`. */
  v.object({ kind: v.literal("key"), keys: v.array(v.string()) }),
  v.object({ kind: v.literal("type"), text: v.string() }),
);
export type SpaceAction = Infer<typeof vSpaceAction>;

/** What a screenshot action returns: the image as base64, and the id later actions can point in. */
export const vSpaceScreenshot = v.object({
  image: v.string(),
  format: v.union(v.literal("jpeg"), v.literal("png")),
  width: v.number(),
  height: v.number(),
  screenshotId: v.optional(v.string()),
});
export type SpaceScreenshot = Infer<typeof vSpaceScreenshot>;

// ---------------------------------------------------------------------------
// Rex tabs (ADR 0019)
// ---------------------------------------------------------------------------

/**
 * In `register_machine.tools`: the bridge can open and share Rex tabs (macOS and Linux with the Rex
 * CLI). Older bridges never send it, so the room offers "In Rex" only to bridges that understand it.
 */
export const REX_TABS_TOOL = "rex-tabs";

/** In `room_features`: the room takes `rex_found` and `terminal_size`. */
export const REX_FEATURE = "rex";

/**
 * A Rex tab whose program runs through the bridge (`uplink-bridge rex-host`), so the room can show
 * it. `tabRef` is Rex's id for the tab's terminal block, and `sessionRef` its session's id.
 */
export const vRexTab = v.object({
  tabRef: v.string(),
  sessionRef: v.string(),
  /** The session's label in Rex. */
  session: v.string(),
  /** The tab's label in Rex. */
  title: v.string(),
  /** What the tab runs, as the shell sees it. */
  command: v.string(),
  cwd: v.optional(v.string()),
  /** Set while the bridge shares it: the terminal's room id, or its local ref until the room links it. */
  terminalRef: v.optional(v.string()),
});
export type RexTab = Infer<typeof vRexTab>;

// ---------------------------------------------------------------------------
// Messages from the bridge to the room
// ---------------------------------------------------------------------------

export const vBridgeMessage = v.union(
  v.object({
    v: v.literal(1),
    type: v.literal("register_machine"),
    hostname: v.string(),
    os: v.string(),
    bridgeVersion: v.string(),
    /** Tools found on the machine that have an adapter, such as "tmux" or "t3code". */
    tools: v.array(v.string()),
    limits: vMachineLimits,
    /**
     * The bridge's saved inbox cursor: the last room message seq it handled. The room then ends a
     * `starting` terminal whose `start_terminal` is at or below it (the previous process handled
     * it), and keeps one whose start comes after. Absent from older bridges: the room keeps every
     * terminal whose start is still queued.
     */
    afterSeq: v.optional(v.number()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The machine's own limits changed while the bridge runs. Unlike
     * `register_machine`, which a bridge sends once when it starts, this keeps
     * the room's live terminals.
     */
    type: v.literal("limits_changed"),
    limits: vMachineLimits,
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("terminal_started"),
    /** Set when the room asked for this terminal; absent for one found on the machine. */
    terminalId: v.optional(v.string()),
    localRef: v.string(),
    title: v.string(),
    tool: v.string(),
    cwd: v.optional(v.string()),
    repo: v.optional(v.string()),
    access: vAccess,
    /**
     * Set when the terminal is a Rex tab (ADR 0019): its Rex session and tab, so the room knows it's
     * one without waiting for the next `rex_found`. Sent only after the room's `room_features` lists
     * `rex`, since a room from before it refuses the field.
     */
    rex: v.optional(v.object({ sessionRef: v.string(), tabRef: v.string() })),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("terminal_start_failed"),
    terminalId: v.string(),
    reason: v.string(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("terminal_output"),
    terminalId: v.string(),
    seq: v.number(),
    data: v.string(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("terminal_access"),
    terminalId: v.string(),
    access: vAccess,
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("input_rejected"),
    terminalId: v.string(),
    memberId: v.string(),
    reason: v.string(),
    /**
     * For a refused `set_thread_mode` (ADR 0043): the mode that was asked for, so the room drops it
     * and keeps showing the one T3 Code still has. Sent only in answer to `set_thread_mode`.
     */
    runtimeMode: v.optional(vRuntimeMode),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("terminal_ended"),
    terminalId: v.string(),
    /** A shell killed by a signal exits with 128 + its number, as a shell reports it. */
    exitCode: v.optional(v.number()),
    /**
     * The signal that killed the process, if one did. The room reads it as exit code 128 + signal.
     * Bridges don't send it yet, because a room from before this field refuses a message that has
     * it; they put 128 + signal in exitCode instead.
     */
    signal: v.optional(v.number()),
    /**
     * Why it ended. `exited`: its process exited (see `exitCode`). `stopped`: the room or the
     * machine stopped it. `bridge_stopped`: the bridge closed. Absent from older bridges; the
     * room then treats it as `exited`.
     */
    reason: v.optional(v.union(v.literal("exited"), v.literal("stopped"), v.literal("bridge_stopped"))),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("run_state_changed"),
    source: vRunSource,
    state: vReportedRunState,
    prompt: v.optional(vPrompt),
    /** For threads: what the room needs to show an unfiled run. */
    harness: v.optional(v.string()),
    repo: v.optional(v.string()),
    title: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The thread a `start_thread` launched has this id in T3 Code. Sent before the bridge reports
     * anything about it, so the room moves the run's `threadRef` from its run id to `threadRef`
     * and later reports land on the same run instead of a new unfiled one.
     */
    type: v.literal("thread_bound"),
    runId: v.string(),
    threadRef: v.string(),
  }),
  v.object({
    v: v.literal(1),
    /**
     * T3 Code archived or deleted a thread the bridge reported. Its run's turn state is reported
     * as before; this says the thread itself is gone, so a run that finished its turn is no longer
     * open to messages (ADR 0026). Sent only to a room that names `thread_closed`.
     */
    type: v.literal("thread_closed"),
    threadRef: v.string(),
  }),
  v.object({
    v: v.literal(1),
    /**
     * A `start_thread` failed. `reason` is one of `sharing_stopped`, `t3_not_paired`,
     * `t3_unavailable`, `t3_auth`, `project_not_registered`, `harness_disabled`, `mode_unsupported`
     * or `launch_failed`;
     * `detail` is T3 Code's own message, when it gave one.
     */
    type: v.literal("thread_start_failed"),
    runId: v.string(),
    reason: v.string(),
    detail: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The room messages this bridge handles (BRIDGE_FEATURES), sent once a room names
     * `bridge_features`, after `register_machine`. It replaces the last list.
     */
    type: v.literal("bridge_features"),
    features: v.array(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The bridge clamped a thread's access to the machine's own limit, as `terminal_access` does for
     * a terminal. Sent only to a room that names `thread_access` (ROOM_FEATURES).
     */
    type: v.literal("thread_access"),
    threadRef: v.string(),
    access: vAccess,
  }),
  v.object({
    v: v.literal(1),
    /**
     * A watched thread's conversation (ADR 0022). `reset`: the first batch since the bridge started
     * following it, the newest items T3 Code gave; the room drops what it keeps newer than the
     * oldest of them, so items T3 Code removed go. `older`: whether T3 Code has items before them.
     */
    type: v.literal("thread_items"),
    threadRef: v.string(),
    items: v.array(vThreadItem),
    /** Items T3 Code no longer shows, such as a rolled-back turn's: the room drops them. */
    removed: v.optional(v.array(v.string())),
    reset: v.optional(v.boolean()),
    older: v.optional(v.boolean()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * Items before an item the room asked about (`thread_history`). `older`: whether T3 Code has
     * more before these. `error`: why there are none (`not_found`, `t3_unavailable`, or T3 Code's message).
     */
    type: v.literal("thread_history_page"),
    threadRef: v.string(),
    requestId: v.string(),
    items: v.array(vThreadItem),
    older: v.boolean(),
    error: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /** A turn's diff the room asked for (`thread_diff_request`), cut to THREAD_ITEM_LIMITS.turnDiff, or why not. */
    type: v.literal("thread_diff"),
    threadRef: v.string(),
    requestId: v.string(),
    diff: v.optional(v.string()),
    cut: v.optional(v.boolean()),
    error: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * How a message sent from the room went (ADR 0023): `sent` (it started a turn), `queued` (it
     * waits behind the turn in progress), or `failed` with `error` (`not_driver`,
     * `t3_unavailable`, `run_stopped` or `sharing_stopped` when that happened while its files
     * moved, or T3 Code's message).
     */
    type: v.literal("thread_message_result"),
    threadRef: v.string(),
    messageId: v.string(),
    status: v.union(v.literal("sent"), v.literal("queued"), v.literal("failed")),
    error: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * A thread's permission mode as T3 Code has it now (ADR 0043), and the modes its provider takes
     * (`modes`, absent when T3 Code doesn't list them). Sent when the bridge first sees the thread and
     * whenever either changes, from the room or in T3 Code. Sent only to a room that names `thread_modes`.
     */
    type: v.literal("thread_mode"),
    threadRef: v.string(),
    runtimeMode: vRuntimeMode,
    modes: v.optional(v.array(vRuntimeMode)),
  }),
  v.object({
    v: v.literal(1),
    /**
     * How a claim from `bridge:claimRunMessages` went (ADR 0026). `delivered`: the session's hook
     * wrote the messages for Claude Code, or Codex's app server took them (ADR 0038), `how` it said.
     * `released`: no hook got them, or Codex didn't take them, so they wait again. `unsure`: a hook got them and never said it wrote them, so the room sends them once
     * more and then gives up. Sent only to a room that names `run_messages` (ROOM_FEATURES).
     */
    type: v.literal("run_message_result"),
    claimId: v.string(),
    deliveryIds: v.array(v.string()),
    status: v.union(v.literal("delivered"), v.literal("released"), v.literal("unsure")),
    how: v.optional(vRunMessageHow),
  }),
  v.object({
    v: v.literal(1),
    /**
     * How a run on this machine hears messages, sent when the bridge learns it: a Claude Code terminal
     * whose hooks reach the bridge, or a Codex terminal on its own app server (ADR 0038), hears them
     * mid-task. Sent only to a room that names `run_messages`.
     */
    type: v.literal("run_hearing"),
    source: vRunSource,
    hearing: vRunHearing,
  }),
  v.object({
    v: v.literal(1),
    /**
     * Where the machine's T3 Code pairing stands, sent when it changes. Sent only to a room that
     * names `t3_status` (ROOM_FEATURES).
     */
    type: v.literal("t3_status"),
    state: vT3PairingState,
    /** When the bridge's T3 Code session ends (ms), if the bridge saved it at pairing. */
    expiresAt: v.optional(v.number()),
    /** For `needs_pairing`: `expired` once past `expiresAt`, otherwise `refused` (revoked, or another server). */
    reason: v.optional(v.union(v.literal("expired"), v.literal("refused"))),
    /** T3 Code's own id for this server (`environmentId`), for links to its threads. */
    environmentId: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("profile_created"),
    profileId: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("profile_expired"),
    profileId: v.string(),
  }),
  // Spaces --------------------------------------------------------------
  v.object({
    v: v.literal(1),
    /** Every Cua Space the bridge found on its machine, replacing the last report. */
    type: v.literal("spaces_found"),
    spaces: v.array(vFoundSpace),
  }),
  v.object({
    v: v.literal(1),
    /** A `share_space` worked. `gateway` lists the base URLs teammates may reach the Space gateway at. */
    type: v.literal("space_shared"),
    spaceId: v.string(),
    access: vAccess,
    gateway: v.array(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /** `reason`: `sharing_stopped`, `unknown_space` (Cua doesn't know it here), `unreachable` or `cua_failed`. */
    type: v.literal("space_share_failed"),
    spaceId: v.string(),
    reason: v.string(),
  }),
  v.object({
    v: v.literal(1),
    /** The bridge clamped a Space's access to the machine's own limit. */
    type: v.literal("space_access"),
    spaceId: v.string(),
    access: vAccess,
  }),
  v.object({
    v: v.literal(1),
    /** `stopped`: unshared from the room or the machine. `gone`: Cua no longer lists it. `bridge_stopped`: the bridge closed. */
    type: v.literal("space_ended"),
    spaceId: v.string(),
    reason: v.union(v.literal("stopped"), v.literal("gone"), v.literal("bridge_stopped")),
  }),
  v.object({
    v: v.literal(1),
    /**
     * A Space view is ready. The viewer loads `<a gateway URL><path>#ticket=<ticket>`. `interactive`
     * is what the bridge granted, which is false for anyone but the driver it knows.
     */
    type: v.literal("space_view_ready"),
    spaceId: v.string(),
    viewId: v.string(),
    path: v.string(),
    ticket: v.string(),
    expiresAt: v.number(),
    interactive: v.boolean(),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The bridge renewed a view's viewer ticket before it expired. The route and its path stay the
     * same and the gateway uses the new ticket, so an open video socket isn't touched.
     */
    type: v.literal("space_view_renewed"),
    spaceId: v.string(),
    viewId: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("space_view_failed"),
    spaceId: v.string(),
    viewId: v.string(),
    reason: v.string(),
  }),
  v.object({
    v: v.literal(1),
    /** `error`: `not_driver`, `space_not_shared`, `invalid_action` or Cua's own message. */
    type: v.literal("space_action_result"),
    spaceId: v.string(),
    actionId: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    screenshot: v.optional(vSpaceScreenshot),
  }),
  v.object({
    v: v.literal(1),
    /**
     * A shared Space stopped, was suspended, or runs again on its machine. While it isn't running,
     * the bridge has closed its views and refuses new views and Space actions (`space_stopped`).
     */
    type: v.literal("space_power"),
    spaceId: v.string(),
    state: vSpacePower,
  }),
  v.object({
    v: v.literal(1),
    /** The bridge refused a driver change on a Space (`driver_change_rejected`). */
    type: v.literal("space_rejected"),
    spaceId: v.string(),
    memberId: v.string(),
    reason: v.string(),
  }),
  // Rex tabs ---------------------------------------------------------------
  // Sent only after the room's `room_features` lists `rex`: a room from before them refuses a
  // message it doesn't know, and with it the whole batch.
  v.object({
    v: v.literal(1),
    /**
     * What the bridge found in Rex on its machine, replacing the last report. `running`: whether a
     * Rex server answered. `tabs`: the tabs that run through the bridge and so can be shared.
     * `otherTabs`: how many other terminal tabs Rex has, which can't be (ADR 0019); only the count
     * leaves the machine.
     */
    type: v.literal("rex_found"),
    running: v.boolean(),
    tabs: v.array(vRexTab),
    otherTabs: v.number(),
  }),
  v.object({
    v: v.literal(1),
    /**
     * A terminal's size changed outside the room: a Rex tab follows the size Rex gives it, which is
     * the Rex app's while the tab is open there.
     */
    type: v.literal("terminal_size"),
    terminalId: v.string(),
    cols: v.number(),
    rows: v.number(),
  }),
);
export type BridgeMessage = Infer<typeof vBridgeMessage>;

// ---------------------------------------------------------------------------
// Messages from the room to the bridge
// ---------------------------------------------------------------------------

export const vRoomMessage = v.union(
  v.object({
    v: v.literal(1),
    type: v.literal("start_terminal"),
    terminalId: v.string(),
    startedBy: vActorRef,
    /**
     * For a terminal an agent starts: the person accountable for the agent. While the machine's own
     * limit is below Drive, the bridge starts a room's terminal only for whoever the machine belongs
     * to, or for an agent of theirs (ADR 0025). A bridge that predates this field ignores it.
     */
    accountable: v.optional(vActorRef),
    /**
     * The room's view: true when someone other than whoever the machine belongs
     * to starts it. The bridge doesn't trust it; it decides slot use from who
     * the machine belongs to, saved when it was paired.
     */
    usesSlot: v.boolean(),
    access: vAccess,
    /** Absent: the machine setup. */
    profileId: v.optional(v.string()),
    /**
     * The run's harness, such as "claude-code". The bridge starts a terminal in a profile only for a
     * harness that keeps the profile's logins apart from the machine setup, and refuses the rest.
     */
    harness: v.optional(v.string()),
    command: v.optional(v.string()),
    cwd: v.optional(v.string()),
    /**
     * Run it without colors (NO_COLOR=1, no FORCE_COLOR): set for a shell an agent opens, since the
     * agent reads its output as text and stripping a colored inline diff merges its values. A bridge
     * that predates this field ignores it.
     */
    noColor: v.optional(v.boolean()),
    /**
     * Open it as a new Rex tab on the machine (ADR 0019), in the bridge's "Uplink Room" session. The
     * room sends it only to a bridge whose `tools` list `rex-tabs`; an older bridge would ignore it
     * and start a plain terminal.
     */
    inRex: v.optional(v.boolean()),
    /** The terminal's name, such as the task's title: the Rex tab's label. */
    title: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * What this room understands beyond the base protocol, sent after `register_machine`. A bridge
     * sends a feature's messages only once it hears the room has it. Older bridges ignore it.
     */
    type: v.literal("room_features"),
    features: v.array(v.string()),
  }),
  v.object({
    v: v.literal(1),
    /**
     * Share a Rex tab the bridge found (`rex_found`) as the terminal `terminalId`. Its program keeps
     * running when the share ends: stopping it in the room (`stop_terminal`) only unshares it. The
     * bridge answers with `terminal_started`, or `terminal_start_failed` (`sharing_stopped`,
     * `rex_unavailable`, `rex_tab_not_found` or `rex_tab_shared`).
     */
    type: v.literal("share_rex_tab"),
    terminalId: v.string(),
    tabRef: v.string(),
    sharedBy: vActorRef,
    access: vAccess,
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("start_thread"),
    /** The run this thread belongs to. The bridge sends `thread_bound` with T3 Code's thread id, or `thread_start_failed`. */
    runId: v.string(),
    harness: v.string(),
    startedBy: vActorRef,
    /** As in `start_terminal`: for a thread an agent starts, the person accountable for the agent. */
    accountable: v.optional(vActorRef),
    repo: v.optional(v.string()),
    cwd: v.optional(v.string()),
    prompt: v.optional(v.string()),
    /**
     * How much teammates may do in the thread (ADR 0021). The bridge clamps it to the machine's own
     * limit. Absent (and ignored by bridges from before ADR 0021): Watch.
     */
    access: v.optional(vAccess),
    /**
     * What the agent may do without asking (ADR 0043). Sent only to a bridge that names
     * `thread_modes`; absent, `approval-required`. The bridge refuses a mode the thread's provider
     * doesn't list (`mode_unsupported`).
     */
    runtimeMode: v.optional(vRuntimeMode),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The thread's driver changed its permission mode (ADR 0043). Only the driver's counts, as for its
     * messages; anyone else gets `input_rejected` (`not_driver`), and a mode T3 Code refuses gets
     * `mode_failed`. The bridge answers `thread_mode` once T3 Code has it. Sent only where the bridge
     * named `thread_modes`.
     */
    type: v.literal("set_thread_mode"),
    threadRef: v.string(),
    from: vActorRef,
    runtimeMode: vRuntimeMode,
  }),
  v.object({
    v: v.literal(1),
    /**
     * A thread's access changed in the room (ADR 0021). `threadRef` is the run's `threadRef`. The
     * bridge clamps it to the machine's own limit and answers `thread_access` when it did.
     */
    type: v.literal("change_thread_access"),
    threadRef: v.string(),
    access: vAccess,
  }),
  v.object({
    v: v.literal(1),
    /**
     * Send a message into a thread as its driver (ADR 0023). An idle thread starts a turn with it;
     * a busy one takes it after the turn in progress. The bridge takes it only from the thread's
     * driver, and answers `thread_message_result`. `messageId` is the room's, so a message
     * delivered again is sent once.
     */
    type: v.literal("send_thread_message"),
    threadRef: v.string(),
    messageId: v.string(),
    from: vActorRef,
    text: v.string(),
    /**
     * Files sent with it (ADR 0043), which the bridge hands T3 Code as the message's attachments.
     * Sent only where the bridge named `thread_attachments`.
     */
    attachments: v.optional(v.array(vRoomFile)),
  }),
  v.object({
    v: v.literal(1),
    /**
     * Messages wait in the room for the live run in this terminal (ADR 0026). The bridge claims them
     * (`bridge:claimRunMessages`) at the session's next hook, or at once for an idle session's waiter
     * or a Codex session (ADR 0038).
     * It carries no text: the room labels each message, and checks that the run's driver may still
     * read it, only when it hands it over. Sent only where the bridge named `run_messages`.
     */
    type: v.literal("run_messages_waiting"),
    source: vRunSource,
  }),
  v.object({
    v: v.literal(1),
    /** Stop the turn in progress, as the driver (ADR 0023). Others get `input_rejected` (`not_driver`). */
    type: v.literal("interrupt_thread"),
    threadRef: v.string(),
    from: vActorRef,
  }),
  v.object({
    v: v.literal(1),
    /**
     * Answer a thread's question (a `question` prompt with `questions`) as its driver (ADR 0023):
     * each question's id to an option's label, several labels, or the person's own words.
     * Refused like an approval's answer: `not_driver`, `stale_prompt`, `no_pending_question`,
     * `answer_failed`, in `input_rejected`.
     */
    type: v.literal("answer_question"),
    threadRef: v.string(),
    from: vActorRef,
    promptId: v.string(),
    answers: v.record(v.string(), v.union(v.string(), v.array(v.string()))),
  }),
  v.object({
    v: v.literal(1),
    /**
     * Someone opened a thread's view (ADR 0022): follow its conversation and send it as
     * `thread_items` until `unwatch_thread`. Sent again after the bridge registers.
     */
    type: v.literal("watch_thread"),
    threadRef: v.string(),
  }),
  v.object({ v: v.literal(1), type: v.literal("unwatch_thread"), threadRef: v.string() }),
  v.object({
    v: v.literal(1),
    /** Send the items before `beforeItemId` (an item the room keeps), as `thread_history_page`. */
    type: v.literal("thread_history"),
    threadRef: v.string(),
    requestId: v.string(),
    beforeItemId: v.string(),
  }),
  v.object({
    v: v.literal(1),
    /** Send one turn's diff (a checkpoint's `turn`) as `thread_diff`. */
    type: v.literal("thread_diff_request"),
    threadRef: v.string(),
    requestId: v.string(),
    turn: v.number(),
  }),
  v.object({
    v: v.literal(1),
    /**
     * The room passed a thread's wheel (ADR 0021). As for terminals, below Drive the bridge accepts
     * only whoever started the thread, and answers anyone else with `input_rejected`
     * (`driver_change_rejected`), naming the thread in `terminalId`.
     */
    type: v.literal("thread_driver_changed"),
    threadRef: v.string(),
    driver: v.optional(vActorRef),
    /**
     * Who started the thread (member id). A bridge that saved its threads before ADR 0021 never
     * recorded it, and takes it from here instead of assuming whoever linked the machine.
     */
    starterId: v.optional(v.string()),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("input"),
    terminalId: v.string(),
    from: vActorRef,
    data: v.string(),
    /**
     * Set when `data` is the room screen's own replies to the program (focus, device attributes,
     * status reports; `terminalReplies.ts`), which nobody typed. A bridge whose terminal already gets
     * them from elsewhere (a Rex tab, ADR 0019) drops them. Older bridges ignore it.
     */
    reply: v.optional(v.boolean()),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("resize_terminal"),
    terminalId: v.string(),
    /** Who asked. As with `input`, the bridge resizes only for the terminal's current driver. */
    from: vActorRef,
    /** The room clamps these to 20-500 columns and 5-200 rows; the bridge clamps them again. */
    cols: v.number(),
    rows: v.number(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("driver_changed"),
    terminalId: v.string(),
    driver: v.optional(vActorRef),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("change_access"),
    terminalId: v.string(),
    access: vAccess,
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("answer_prompt"),
    source: vRunSource,
    /** The run's driver. Whoever actually answered is recorded in the room. */
    from: vActorRef,
    /** The approval this answers (`Prompt.promptId`). The bridge rejects an answer to any other. */
    promptId: v.string(),
    answer: v.union(v.literal("allow"), v.literal("deny")),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("stop_terminal"),
    terminalId: v.string(),
  }),
  v.object({
    v: v.literal(1),
    /** Stop a T3 Code thread's run. `threadRef` is the run's `threadRef`: T3 Code's id, or the run id before `thread_bound`. */
    type: v.literal("stop_thread"),
    threadRef: v.string(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("terminal_linked"),
    /** A terminal found on the machine (`terminal_started` without `terminalId`) now has this room id. */
    localRef: v.string(),
    terminalId: v.string(),
  }),
  v.object({ v: v.literal(1), type: v.literal("stop_sharing") }),
  /** Share again after the room's `stop_sharing`. A stop made on the machine itself stays until the bridge restarts. */
  v.object({ v: v.literal(1), type: v.literal("resume_sharing") }),
  v.object({
    v: v.literal(1),
    type: v.literal("create_profile"),
    profileId: v.string(),
    person: vActorRef,
    expiresAt: v.number(),
  }),
  v.object({
    v: v.literal(1),
    type: v.literal("delete_profile"),
    profileId: v.string(),
  }),
  v.object({ v: v.literal(1), type: v.literal("unlink") }),
  // Spaces --------------------------------------------------------------
  v.object({
    v: v.literal(1),
    /** Share a Cua Space found on the machine. `sharedBy` is its first driver. */
    type: v.literal("share_space"),
    spaceId: v.string(),
    spaceRef: v.string(),
    sharedBy: vActorRef,
    access: vAccess,
  }),
  v.object({ v: v.literal(1), type: v.literal("unshare_space"), spaceId: v.string() }),
  v.object({ v: v.literal(1), type: v.literal("change_space_access"), spaceId: v.string(), access: vAccess }),
  v.object({
    v: v.literal(1),
    type: v.literal("space_driver_changed"),
    spaceId: v.string(),
    driver: v.optional(vActorRef),
  }),
  v.object({
    v: v.literal(1),
    /** Open a Space view for `viewer`. The room asks for `interactive` only for the driver; the bridge checks. */
    type: v.literal("open_space_view"),
    spaceId: v.string(),
    viewId: v.string(),
    viewer: vActorRef,
    interactive: v.boolean(),
  }),
  v.object({ v: v.literal(1), type: v.literal("close_space_view"), spaceId: v.string(), viewId: v.string() }),
  v.object({
    v: v.literal(1),
    type: v.literal("space_action"),
    spaceId: v.string(),
    actionId: v.string(),
    from: vActorRef,
    action: vSpaceAction,
  }),
);
export type RoomMessage = Infer<typeof vRoomMessage>;

export type BridgeMessageOf<T extends BridgeMessage["type"]> = Extract<BridgeMessage, { type: T }>;
export type RoomMessageOf<T extends RoomMessage["type"]> = Extract<RoomMessage, { type: T }>;
