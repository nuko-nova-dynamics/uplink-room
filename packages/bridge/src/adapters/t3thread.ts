/**
 * A T3 Code thread's conversation, as the room keeps it (ADR 0022): T3 Code's turn items turned
 * into the room's small `ThreadItem` shape, and one thread followed over `orchestration.subscribeThread`.
 *
 * The turn item shapes are T3 Code's `OrchestrationV2TurnItem` (packages/contracts/src/
 * orchestrationV2.ts) at commit 9e85538535c8553901351112ab02dd1dd62db5ee (v0.1.8-nightly.20261104.4179),
 * written here as plain types because T3 Code's contracts aren't published.
 *
 * Two rules are copied from T3 Code, which is MIT licensed (Copyright (c) 2026 T3 Tools Inc.,
 * https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/LICENSE):
 *
 * - Which items show: `createOrchestrationV2TurnItemVisibility` in packages/shared/src/
 *   orchestrationV2Timeline.ts hides a rolled-back run's items and a cancelled queued message.
 * - Their order: `upsertVisibleTurnItem` in packages/client-runtime/src/state/
 *   orchestrationV2Projection.ts sorts a thread's own items by `ordinal`, then by id.
 */
import { THREAD_ITEM_LIMITS, type ThreadItem } from "@uplink-room/protocol";

/** The parts of a T3 Code turn item the room reads. */
export interface T3TurnItem {
  id: string;
  type: string;
  runId: string | null;
  ordinal: number;
  status?: string;
  title?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  // Messages, reasoning, plans
  text?: string;
  streaming?: boolean;
  markdown?: string;
  inputIntent?: string;
  messageId?: string;
  attachments?: { type?: string; name?: string; mimeType?: string; sizeBytes?: number }[];
  steps?: { text: string; status: string }[];
  explanation?: string;
  // Requests
  requestId?: string;
  requestKind?: string;
  prompt?: string;
  reason?: string;
  questions?: { question: string; options?: { label: string }[] }[];
  label?: string;
  secretStatus?: string;
  linkStatus?: string;
  // Tools and files
  input?: unknown;
  output?: unknown;
  outputOmitted?: boolean;
  outputIndicatesFailure?: boolean;
  exitCode?: number;
  fileName?: string;
  additions?: number;
  deletions?: number;
  diffStr?: string;
  pattern?: string;
  patterns?: string[];
  results?: { fileName?: string; line?: number; title?: string; url?: string }[];
  toolName?: string | null;
  result?: string | null;
  progress?: string;
  // Checkpoints and notices
  checkpointId?: string;
  files?: { path: string; additions: number; deletions: number }[];
  message?: string;
  failure?: { message?: string };
  summary?: string;
  toModel?: string;
  detail?: string;
}

/** What a thread's items depend on besides themselves: its runs, requests and checkpoints. */
export interface ThreadContext {
  /** Run id → T3 Code's run status. */
  runs: Map<string, string>;
  /** Runtime request id → its status and the decision or answers it got. */
  requests: Map<string, { status: string; decision?: string; answered?: boolean }>;
  /** Checkpoint id → its turn number (`appRunOrdinal`). */
  checkpoints: Map<string, number>;
}

export function newThreadContext(): ThreadContext {
  return { runs: new Map(), requests: new Map(), checkpoints: new Map() };
}

/** The first `limit` characters, and whether anything was cut. */
function head(text: string | undefined, limit: number): [string | undefined, boolean] {
  if (text === undefined) return [undefined, false];
  return text.length > limit ? [text.slice(0, limit), true] : [text, false];
}
/** The last `limit` characters, and whether anything was cut. */
function tail(text: string | undefined, limit: number): [string | undefined, boolean] {
  if (text === undefined) return [undefined, false];
  return text.length > limit ? [text.slice(text.length - limit), true] : [text, false];
}
function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function time(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether T3 Code shows an item (`createOrchestrationV2TurnItemVisibility`, see the header). */
export function isVisible(item: T3TurnItem, context: ThreadContext): boolean {
  const status = item.runId === null ? undefined : context.runs.get(item.runId);
  if (status === "rolled_back") return false;
  if (status === "cancelled" && item.type === "user_message" && item.inputIntent === "queued_turn") return false;
  return true;
}

/** Sorts items as T3 Code does: by ordinal, then by id. */
export function byOrder(a: { order: number; itemId: string }, b: { order: number; itemId: string }) {
  return a.order - b.order || a.itemId.localeCompare(b.itemId);
}

/**
 * The room's shape for one T3 Code turn item, cut to THREAD_ITEM_LIMITS, or undefined for an item
 * the room doesn't show (an unknown type).
 */
export function normalizeItem(item: T3TurnItem, context: ThreadContext): ThreadItem | undefined {
  let cut = false;
  const take = (pair: [string | undefined, boolean]) => {
    if (pair[1]) cut = true;
    return pair[0];
  };
  const base = {
    itemId: item.id,
    order: item.ordinal,
    ...(item.runId ? { turnRef: item.runId } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...((time(item.startedAt) ?? time(item.updatedAt)) !== undefined ? { at: (time(item.startedAt) ?? time(item.updatedAt))! } : {}),
  };
  const attachments = item.attachments?.length
    ? item.attachments.slice(0, THREAD_ITEM_LIMITS.list).map((a) => ({
        name: (a.name ?? "attachment").slice(0, 255),
        kind: a.type === "image" ? "image" : "file",
        ...(typeof a.sizeBytes === "number" ? { size: a.sizeBytes } : {}),
      }))
    : undefined;
  const finish = (fields: Omit<ThreadItem, "itemId" | "order">): ThreadItem => {
    const result: ThreadItem = { ...base, ...fields };
    for (const key of Object.keys(result) as (keyof ThreadItem)[]) if (result[key] === undefined) delete result[key];
    if (cut) result.cut = true;
    return result;
  };
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return finish({
        kind: "message",
        role: item.type === "user_message" ? "user" : "assistant",
        ...(item.messageId ? { messageRef: item.messageId.slice(0, 200) } : {}),
        text: take(head(item.text ?? "", THREAD_ITEM_LIMITS.text)),
        ...(item.streaming ? { streaming: true } : {}),
        ...(attachments ? { attachments } : {}),
      });
    case "reasoning":
      return finish({ kind: "reasoning", text: take(head(item.text ?? "", THREAD_ITEM_LIMITS.text)), ...(item.streaming ? { streaming: true } : {}) });
    case "proposed_plan":
      return finish({ kind: "plan", text: take(head(item.markdown ?? "", THREAD_ITEM_LIMITS.text)), ...(item.streaming ? { streaming: true } : {}) });
    case "todo_list":
      return finish({
        kind: "plan",
        steps: (item.steps ?? []).slice(0, THREAD_ITEM_LIMITS.list).map((s) => ({ text: s.text.slice(0, 500), status: s.status })),
        ...(item.explanation ? { text: take(head(item.explanation, THREAD_ITEM_LIMITS.text)) } : {}),
      });
    case "command_execution": {
      const input = take(head(asText(item.input) ?? "", THREAD_ITEM_LIMITS.input));
      return finish({
        kind: "tool",
        tool: "command",
        title: take(head(item.title ?? input, 300)),
        input,
        output: take(tail(asText(item.output), THREAD_ITEM_LIMITS.output)),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
        ...(item.outputIndicatesFailure || item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0) ? { failed: true } : {}),
      });
    }
    case "file_search":
      return finish({
        kind: "tool",
        tool: "search",
        title: take(head(item.title ?? (item.pattern ? `Search for ${item.pattern}` : "Search files"), 300)),
        output: take(tail(item.results?.map((r) => (r.line ? `${r.fileName}:${r.line}` : r.fileName)).join("\n"), THREAD_ITEM_LIMITS.output)),
      });
    case "web_search":
      return finish({
        kind: "tool",
        tool: "web",
        title: take(head(item.title ?? `Search the web for ${(item.patterns ?? []).join(", ")}`, 300)),
        output: take(tail(item.results?.map((r) => [r.title, r.url].filter(Boolean).join(" ")).join("\n"), THREAD_ITEM_LIMITS.output)),
      });
    case "dynamic_tool":
      return finish({
        kind: "tool",
        tool: "tool",
        title: take(head(item.toolName ?? item.title ?? "Tool", 300)),
        input: take(head(asText(item.input), THREAD_ITEM_LIMITS.input)),
        output: take(tail(asText(item.output), THREAD_ITEM_LIMITS.output)),
        ...(item.status === "failed" ? { failed: true } : {}),
      });
    case "subagent":
      return finish({
        kind: "tool",
        tool: "subagent",
        title: take(head(item.title ?? "Subagent", 300)),
        input: take(head(item.prompt, THREAD_ITEM_LIMITS.input)),
        output: take(tail(item.result ?? item.progress, THREAD_ITEM_LIMITS.output)),
      });
    case "file_change":
      return finish({
        kind: "file_change",
        title: (item.fileName ?? item.title ?? "a file").slice(0, 500),
        ...(typeof item.additions === "number" ? { additions: item.additions } : {}),
        ...(typeof item.deletions === "number" ? { deletions: item.deletions } : {}),
        diff: take(head(item.diffStr, THREAD_ITEM_LIMITS.diff)),
      });
    case "approval_request": {
      const request = item.requestId ? context.requests.get(item.requestId) : undefined;
      return finish({
        kind: "request",
        request: "approval",
        text: take(head(item.reason ?? item.prompt ?? `The agent asks to ${(item.requestKind ?? "act").replace("-", " ")}.`, THREAD_ITEM_LIMITS.text)),
        input: take(head(item.prompt, THREAD_ITEM_LIMITS.input)),
        outcome: request?.decision ?? (request && request.status !== "pending" ? request.status : undefined),
      });
    }
    case "user_input_request": {
      const request = item.requestId ? context.requests.get(item.requestId) : undefined;
      const text = (item.questions ?? [])
        .map((q) => (q.options?.length ? `${q.question} (${q.options.map((o) => o.label).join(" / ")})` : q.question))
        .join("\n");
      return finish({
        kind: "request",
        request: "question",
        text: take(head(text || "The agent asked a question.", THREAD_ITEM_LIMITS.text)),
        outcome: request?.answered ? "answered" : request && request.status !== "pending" ? request.status : undefined,
      });
    }
    case "secret_request":
      return finish({
        kind: "request",
        request: "secret",
        text: take(head(`${item.label ?? "A secret"}${item.reason ? `: ${item.reason}` : ""}`, THREAD_ITEM_LIMITS.text)),
        ...(item.secretStatus && item.secretStatus !== "pending" ? { outcome: item.secretStatus } : {}),
      });
    case "link_request":
      return finish({
        kind: "request",
        request: "link",
        text: take(head(item.reason || "Link another machine to T3 Code.", THREAD_ITEM_LIMITS.text)),
        ...(item.linkStatus && item.linkStatus !== "pending" ? { outcome: item.linkStatus } : {}),
      });
    case "checkpoint": {
      const turn = item.checkpointId ? context.checkpoints.get(item.checkpointId) : undefined;
      return finish({
        kind: "checkpoint",
        ...(turn !== undefined ? { turn } : {}),
        files: (item.files ?? []).slice(0, THREAD_ITEM_LIMITS.list).map((f) => ({ path: f.path.slice(0, 500), additions: f.additions, deletions: f.deletions })),
      });
    }
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return finish({ kind: "notice", tone: "info", text: take(head(item.message ?? "", THREAD_ITEM_LIMITS.text)) });
    case "error":
      return finish({ kind: "notice", tone: "error", text: take(head(item.failure?.message ?? "The agent stopped with an error.", THREAD_ITEM_LIMITS.text)) });
    case "compaction":
      return finish({ kind: "notice", tone: "info", text: "T3 Code compacted the conversation to fit the model's context." });
    case "handoff":
      return finish({ kind: "notice", tone: "info", text: item.toModel ? `The thread went on with ${item.toModel}.` : "The thread went on with another model." });
    case "notification":
      return finish({ kind: "notice", tone: "info", text: take(head(item.summary ?? item.detail ?? "", THREAD_ITEM_LIMITS.text)) });
    default:
      return undefined;
  }
}

/** Bridge messages stay well under Convex's 16 MiB argument limit: at most this many items, and bytes. */
export const BATCH_ITEMS = 50;
export const BATCH_BYTES = 900_000;
/** The first batch goes as one message, so the room can drop what T3 Code no longer has; at most this many bytes. */
export const RESET_BYTES = 2_000_000;

/** The newest items that fit in RESET_BYTES, oldest first, and whether older ones were left out. */
export function newestThatFit(items: ThreadItem[]): { items: ThreadItem[]; left: boolean } {
  let bytes = 0;
  let from = items.length;
  while (from > 0) {
    const size = Buffer.byteLength(JSON.stringify(items[from - 1]));
    if (bytes + size > RESET_BYTES && from < items.length) break;
    bytes += size;
    from--;
  }
  return { items: items.slice(from), left: from > 0 };
}

/** Splits items into batches of at most BATCH_ITEMS and about BATCH_BYTES each. */
export function batches(items: ThreadItem[]): ThreadItem[][] {
  const out: ThreadItem[][] = [];
  let current: ThreadItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (current.length && (current.length >= BATCH_ITEMS || bytes + size > BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** How many of a thread's newest items the bridge sends when it starts following it. */
export const FIRST_ITEMS = 150;
/** How many items a history page holds. */
export const HISTORY_PAGE = 50;
