/**
 * What the A2A worker commits about an agent's task (ADR 0012): a bounded
 * observation, never the agent's raw answer. Texts are cut to a few KB, at
 * most a few artifacts and links are kept, and only http(s) links survive.
 *
 * It reads A2A 1.0 and A2A 0.3 answers alike (ADR 0018): 0.3 marks tasks,
 * messages, events and parts with `kind`, names states in lowercase
 * ("input-required"), and nests a file part's link in `file.uri`. States are
 * kept in 1.0's names.
 *
 * Every text the agent wrote passes through a `Redactor` (redact.ts) before it is cut, here and
 * wherever pieces are joined, so a cut never keeps part of the room's token. The worker parses with
 * one that knows the token; the mutation that saves applies it again to what it joined.
 */
import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { PLAIN_REDACTOR, type Redactor } from "./redact";

export const MAX_TEXT = 4_000;
export const MAX_ARTIFACTS = 8;
const MAX_URLS = 4;
const MAX_URL = 2_000;
const MAX_ID = 200;

export const vArtifactRef = v.object({
  artifactId: v.string(),
  name: v.optional(v.string()),
  /** Its text parts, joined and cut to MAX_TEXT. */
  text: v.optional(v.string()),
  /** Its http(s) file links. */
  urls: v.array(v.string()),
  /** True when it carries structured data or bytes the room doesn't keep. */
  hasData: v.optional(v.boolean()),
  /** For a stream chunk: add this text to the artifact's earlier text. */
  append: v.optional(v.boolean()),
  truncated: v.optional(v.boolean()),
});
export type ArtifactRef = Infer<typeof vArtifactRef>;

export const vObservation = v.object({
  /** "message": the agent answered with a direct Message (no task). "task": anything about a task. */
  kind: v.union(v.literal("task"), v.literal("message")),
  taskId: v.optional(v.string()),
  contextId: v.optional(v.string()),
  /** The A2A state name, such as TASK_STATE_WORKING. Absent on an artifact-only event. */
  state: v.optional(v.string()),
  /** The status timestamp the agent gave, in ms. */
  statusAt: v.optional(v.number()),
  /** The status message's text, or a direct reply's text. */
  message: v.optional(v.string()),
  artifacts: v.optional(v.array(vArtifactRef)),
  /** True for a whole task snapshot: its artifacts replace the stored ones. */
  snapshot: v.optional(v.boolean()),
  /** The status message came from the user's side (role user), so it isn't the agent speaking. */
  fromUser: v.optional(v.boolean()),
  /** The agent asked to move its work to a thread of its own (`uplink.room/propose-thread`, ADR 0024). */
  proposal: v.optional(v.object({ title: v.optional(v.string()) })),
});
export type Observation = Infer<typeof vObservation>;

export const TERMINAL = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

function id(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, MAX_ID) : undefined;
}


/** A2A 0.3's state names, as A2A 1.0 names them (a2a-protocol.org/latest/whats-new-v1). */
const LEGACY_STATES: Record<string, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  rejected: "TASK_STATE_REJECTED",
  unknown: "TASK_STATE_UNSPECIFIED",
};

function parts(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]).slice(0, 50) : [];
}

/** The text parts of a message, joined, cleaned, then cut. */
export function textOf(message: unknown, r: Redactor = PLAIN_REDACTOR): string | undefined {
  return speechOf(message, r).text;
}

const PROPOSE_THREAD = "uplink.room/propose-thread";
/** The text form of a thread proposal, for agents that answer only text: the answer's first line. */
const PROPOSE_LINE = /^\s*uplink\.room\/propose-thread\b[ \t]*:?[ \t]*(.*)$/i;

function proposalTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/**
 * What a message says: its text parts joined, cleaned and cut; whether it comes from the user's
 * side; and a thread proposal (ADR 0024), made in any of three ways: a data part
 * `{ "kind": "uplink.room/propose-thread", "title": … }` (`{ data: … }` in 1.0, `{ kind: "data",
 * data: … }` in 0.3), the message's metadata key `uplink.room/propose-thread`, or a first text line
 * `uplink.room/propose-thread: <title>`, which is taken out of the text.
 */
export function speechOf(
  message: unknown,
  r: Redactor = PLAIN_REDACTOR,
): { text?: string; fromUser?: boolean; proposal?: { title?: string } } {
  if (!message || typeof message !== "object") return {};
  const m = message as Record<string, unknown>;
  const ps = parts(m["parts"]);
  let proposal: { title?: string } | undefined;
  for (const p of ps) {
    const data = p["data"];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (d["kind"] === PROPOSE_THREAD || d["type"] === PROPOSE_THREAD) {
        const title = proposalTitle(d["title"]);
        proposal = title ? { title } : {};
      }
    }
  }
  const meta = m["metadata"] && typeof m["metadata"] === "object" ? (m["metadata"] as Record<string, unknown>)[PROPOSE_THREAD] : undefined;
  if (!proposal && meta) {
    const title = proposalTitle(typeof meta === "object" ? (meta as Record<string, unknown>)["title"] : undefined);
    proposal = title ? { title } : {};
  }
  let joined = ps
    .map((p) => (typeof p["text"] === "string" ? p["text"] : ""))
    .filter(Boolean)
    .join("\n");
  const lines = joined.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const line = first >= 0 ? PROPOSE_LINE.exec(lines[first]!) : null;
  if (line) {
    const title = proposalTitle(line[1]);
    proposal = proposal ?? (title ? { title } : {});
    joined = lines.slice(first + 1).join("\n").trim();
  }
  const role = m["role"];
  const fromUser = role === "ROLE_USER" || role === "user";
  return {
    ...(joined ? { text: r.cut(joined, MAX_TEXT).text } : {}),
    ...(fromUser ? { fromUser } : {}),
    ...(proposal ? { proposal: proposal.title ? { title: r.cut(proposal.title, 120).text } : {} } : {}),
  };
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function artifactRef(
  value: unknown,
  append?: boolean,
  r: Redactor = PLAIN_REDACTOR,
): ArtifactRef | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  const artifactId = id(a["artifactId"]);
  if (!artifactId) return null;
  const ps = parts(a["parts"]);
  const joined = ps
    .map((p) => (typeof p["text"] === "string" ? p["text"] : ""))
    .filter(Boolean)
    .join("\n");
  const { text, truncated } = r.cut(joined, MAX_TEXT);
  // A 0.3 file part is { kind: "file", file: { uri | bytes, mimeType, name } }.
  const file = (p: Record<string, unknown>) =>
    p["file"] && typeof p["file"] === "object" ? (p["file"] as Record<string, unknown>) : {};
  const urls = ps
    .map((p) => safeUrl(p["url"]) ?? safeUrl(file(p)["uri"]))
    .filter((u): u is string => !!u)
    .slice(0, MAX_URLS)
    .map((u) => r.clean(u));
  const hasData = ps.some(
    (p) => p["data"] !== undefined || p["raw"] !== undefined || file(p)["bytes"] !== undefined,
  );
  const name = typeof a["name"] === "string" && a["name"] ? r.cut(a["name"], 200).text : undefined;
  return {
    artifactId,
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    urls,
    ...(hasData ? { hasData } : {}),
    ...(append ? { append } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

function time(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function fromStatus(status: unknown, r: Redactor) {
  const s = (status ?? {}) as Record<string, unknown>;
  const named = typeof s["state"] === "string" ? s["state"] : undefined;
  const state = named ? (LEGACY_STATES[named] ?? named).slice(0, 60) : undefined;
  const statusAt = time(s["timestamp"]);
  const { text: message, fromUser, proposal } = speechOf(s["message"], r);
  return {
    ...(state ? { state } : {}),
    ...(statusAt !== undefined ? { statusAt } : {}),
    ...(message ? { message } : {}),
    ...(fromUser ? { fromUser } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

/** A Task (spec 4.1.1). */
export function fromTask(task: unknown, r: Redactor = PLAIN_REDACTOR): Observation | null {
  if (!task || typeof task !== "object") return null;
  const t = task as Record<string, unknown>;
  const taskId = id(t["id"]);
  if (!taskId) return null;
  const contextId = id(t["contextId"]);
  const artifacts = Array.isArray(t["artifacts"])
    ? (t["artifacts"] as unknown[])
        .map((a) => artifactRef(a, undefined, r))
        .filter((a): a is ArtifactRef => !!a)
        .slice(0, MAX_ARTIFACTS)
    : undefined;
  return {
    kind: "task",
    taskId,
    ...(contextId ? { contextId } : {}),
    ...fromStatus(t["status"], r),
    ...(artifacts ? { artifacts } : {}),
    snapshot: true,
  };
}

/** A direct Message reply (spec 4.1.4). */
export function fromMessage(message: unknown, r: Redactor = PLAIN_REDACTOR): Observation | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const contextId = id(m["contextId"]);
  const taskId = id(m["taskId"]);
  const { text, proposal } = speechOf(m, r);
  return {
    kind: "message",
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(text ? { message: text } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

/** A SendMessage result: `{ task }` or `{ message }` (spec 9.4.1), or in 0.3 the Task or Message itself. */
export function fromSendResult(result: unknown, redactor: Redactor = PLAIN_REDACTOR): Observation | null {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r["task"]) return fromTask(r["task"], redactor);
  if (r["message"]) return fromMessage(r["message"], redactor);
  if (r["kind"] === "task") return fromTask(r, redactor);
  if (r["kind"] === "message") return fromMessage(r, redactor);
  return null;
}

/**
 * One StreamResponse (spec 3.2.3): a task, a message, a status update or an artifact update. In
 * 0.3 each is the object itself, marked by `kind` ("task", "message", "status-update",
 * "artifact-update").
 */
export function fromStreamResult(
  result: unknown,
  redactor: Redactor = PLAIN_REDACTOR,
): Observation | null {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r["task"]) return fromTask(r["task"], redactor);
  if (r["message"]) return fromMessage(r["message"], redactor);
  if (r["kind"] === "task") return fromTask(r, redactor);
  if (r["kind"] === "message") return fromMessage(r, redactor);
  const status = (r["statusUpdate"] ?? (r["kind"] === "status-update" ? r : undefined)) as
    | Record<string, unknown>
    | undefined;
  if (status) {
    const taskId = id(status["taskId"]);
    if (!taskId) return null;
    const contextId = id(status["contextId"]);
    return {
      kind: "task",
      taskId,
      ...(contextId ? { contextId } : {}),
      ...fromStatus(status["status"], redactor),
    };
  }
  const artifact = (r["artifactUpdate"] ?? (r["kind"] === "artifact-update" ? r : undefined)) as
    | Record<string, unknown>
    | undefined;
  if (artifact) {
    const taskId = id(artifact["taskId"]);
    const ref = artifactRef(artifact["artifact"], artifact["append"] === true, redactor);
    if (!taskId || !ref) return null;
    const contextId = id(artifact["contextId"]);
    return { kind: "task", taskId, ...(contextId ? { contextId } : {}), artifacts: [ref] };
  }
  return null;
}

/** A ref as it is about to be kept: its texts and links cleaned again, its text cut after that. */
function cleanRef(ref: ArtifactRef, r: Redactor): ArtifactRef {
  const cut = ref.text !== undefined ? r.cut(ref.text, MAX_TEXT) : undefined;
  return {
    ...ref,
    ...(ref.name !== undefined ? { name: r.cut(ref.name, 200).text } : {}),
    ...(cut ? { text: cut.text } : {}),
    urls: ref.urls.map((u) => r.clean(u)),
    ...(cut?.truncated || ref.truncated ? { truncated: true } : {}),
  };
}

/** An append joined onto the artifact before it: the joined text is cleaned, then cut. */
function joined(prev: ArtifactRef, next: ArtifactRef, r: Redactor): ArtifactRef {
  // Cleaned whole: a token sent in pieces only shows once its pieces are joined.
  const { text, truncated } = r.cut([prev.text, next.text].filter(Boolean).join(""), MAX_TEXT);
  return {
    ...prev,
    ...(text ? { text } : {}),
    urls: [...new Set([...prev.urls, ...next.urls].map((u) => r.clean(u)))].slice(0, MAX_URLS),
    ...(prev.hasData || next.hasData ? { hasData: true } : {}),
    ...(truncated || prev.truncated || next.truncated ? { truncated: true } : {}),
  };
}

/**
 * Combines stream chunks not committed yet, keeping what each means for the
 * stored artifact: an append to an artifact stays an append (its texts joined),
 * a replacement stays a replacement (later appends join onto it).
 */
export function coalesceArtifacts(
  held: ArtifactRef[],
  incoming: ArtifactRef[],
  r: Redactor = PLAIN_REDACTOR,
): ArtifactRef[] {
  const out = held.map((a) => ({ ...a }));
  for (const ref of incoming) {
    const at = out.findIndex((a) => a.artifactId === ref.artifactId);
    if (at < 0 || !ref.append) {
      if (at < 0) out.push({ ...ref });
      else out[at] = { ...ref };
      continue;
    }
    out[at] = joined(out[at]!, ref, r);
  }
  return out.slice(0, MAX_ARTIFACTS);
}

/**
 * Merges new artifact refs into the stored ones, keeping at most MAX_ARTIFACTS. Runs in the
 * mutation that saves them, with the redactor that knows the room's token: every artifact it keeps
 * is cleaned there, after any join.
 */
export function mergeArtifacts(
  stored: ArtifactRef[],
  incoming: ArtifactRef[],
  snapshot: boolean,
  r: Redactor = PLAIN_REDACTOR,
): ArtifactRef[] {
  const out = snapshot ? [] : stored.map((a) => ({ ...a }));
  for (const ref of incoming) {
    const { append, ...rest } = ref;
    const at = out.findIndex((a) => a.artifactId === ref.artifactId);
    if (at < 0) {
      out.push(cleanRef(rest, r));
      continue;
    }
    out[at] = append ? joined(out[at]!, rest, r) : cleanRef(rest, r);
  }
  return out.slice(0, MAX_ARTIFACTS);
}

/** How an A2A task state shows as a run state (research/decision-a2a-agents.md, ADR 0012). */
export function roomStateFor(
  a2aState: string,
  agentName: string,
  message: string | undefined,
): Pick<Doc<"runs">, "state" | "prompt" | "failReason"> {
  switch (a2aState) {
    case "TASK_STATE_SUBMITTED":
    case "TASK_STATE_WORKING":
      return { state: "working" };
    case "TASK_STATE_INPUT_REQUIRED":
      return {
        state: "waiting",
        prompt: { kind: "question", text: message ?? `${agentName} needs more from you to go on.` },
      };
    case "TASK_STATE_AUTH_REQUIRED":
      return {
        state: "waiting",
        prompt: {
          kind: "question",
          text: `${agentName} needs someone to sign in at its gateway before it can go on.${message ? ` It says: ${message}` : ""}`,
        },
      };
    case "TASK_STATE_COMPLETED":
      return { state: "done" };
    case "TASK_STATE_FAILED":
      return {
        state: "failed",
        failReason: message ?? `${agentName} reported that the task failed.`,
      };
    case "TASK_STATE_REJECTED":
      return {
        state: "failed",
        failReason: `Rejected: ${message ?? `${agentName} won't do this task.`}`,
      };
    case "TASK_STATE_CANCELED":
      return { state: "stopped" };
    default:
      return { state: "unknown" };
  }
}
