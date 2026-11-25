/**
 * A task's runs as the task panel draws them (ADR 0041): the runs of one agent conversation as one
 * chat, every other run as its own card. Runs stay the backend's unit; this only groups them.
 */
import type { RunView } from "./api";

type A2A = NonNullable<RunView["a2a"]>;
type Given = NonNullable<RunView["given"]>;

export type RunGroup =
  | { kind: "card"; run: RunView }
  /** One agent conversation: its runs, oldest first. The last is the open run, which the composer and the stop buttons act on. */
  | { kind: "chat"; key: string; runs: RunView[] };

/**
 * A run given to an agent the room can't follow over A2A (ADR 0044) in the shape the chat reads: what
 * was sent to it, and the agent's latest line from runs.report. It keeps `given`, which says how far
 * the send got and that a stop marks the run stopped at once.
 */
export function givenAsA2A(run: RunView): RunView {
  const given = run.given!;
  const sending = given.delivery?.status === "sending";
  const a2a: A2A = {
    agent: { agentId: given.agent.agentId, memberId: given.agent.memberId, name: given.agent.name },
    connected: true,
    canCancel: "supported",
    externalState: undefined,
    observedAt: undefined,
    contextId: undefined,
    taskId: undefined,
    conversationId: undefined,
    following: false,
    delivery: "sent",
    artifacts: [],
    lastMessage: given.lastMessage?.text,
    statusAt: given.lastMessage?.at,
    lastError: undefined,
    lastContactAt: given.lastMessage?.at ?? run.startedAt,
    place: undefined,
    cancel: undefined,
    detached: undefined,
    // A reply goes to the same run while it hasn't ended: kept for the agent, and sent to a webhook again.
    replies: run.canReply ? "task" : "none",
    messages: given.messages.map((m, i) => ({
      kind: m.kind,
      text: m.text,
      at: m.at,
      // Only the latest send can still be on its way to the routine.
      status: sending && i === given.messages.length - 1 ? ("sending" as const) : ("sent" as const),
      error: undefined,
      by: m.from,
    })),
  };
  return { ...run, a2a };
}

/** How far the latest send to a given run's agent got, as a short line; nothing while it is on its way. */
export function deliveryLine(given: Given): { text: string; tone: "info" | "warn" } | undefined {
  const delivery = given.delivery;
  if (!delivery) return undefined;
  if (delivery.status === "sent") return { text: "Sent to its routine", tone: "info" };
  if (delivery.status === "failed")
    return { text: `Failed: ${delivery.reason ?? "its routine didn't take it."}`, tone: "warn" };
  if (delivery.status === "waiting") return { text: "Waiting for it to check in", tone: "info" };
  if (delivery.status === "seen") return { text: "Seen", tone: "info" };
  return undefined;
}

/**
 * Groups a task's runs in the order the task lists them: an A2A run joins the chat of its
 * conversation (`a2a.conversationId`), which sits where its first run was. A run from before
 * conversations has none, so it is a chat of its own, as is a run given to an agent (givenAsA2A); any
 * other run stays a card.
 */
export function groupRuns(runs: readonly RunView[]): RunGroup[] {
  const groups: RunGroup[] = [];
  const chats = new Map<string, Extract<RunGroup, { kind: "chat" }>>();
  for (const listed of runs) {
    const run = listed.given && !listed.a2a ? givenAsA2A(listed) : listed;
    if (!run.a2a) {
      groups.push({ kind: "card", run });
      continue;
    }
    const key = run.a2a.conversationId ?? `run:${run.runId}`;
    const chat = chats.get(key);
    if (chat) {
      chat.runs.push(run);
      continue;
    }
    const fresh = { kind: "chat" as const, key, runs: [run] };
    chats.set(key, fresh);
    groups.push(fresh);
  }
  for (const chat of chats.values()) chat.runs.sort((a, b) => a.startedAt - b.startedAt);
  return groups;
}

type Sender = A2A["messages"][number]["by"];
type Artifact = A2A["artifacts"][number];

export type ChatItem =
  /** What a person (or an agent) sent the agent in this run: its first message, or a reply to its open task. */
  | { kind: "sent"; key: string; run: RunView; text: string; by: Sender; at: number; sending: boolean }
  /** The agent's answer, or its question while it waits on one. */
  | { kind: "answer"; key: string; run: RunView; text: string; at: number; artifacts: Artifact[]; asking: boolean }
  /** What the agent didn't say itself (a failure, a refusal, a stop), or its progress while it works: a short centered line. */
  | { kind: "line"; key: string; run: RunView; text: string; at: number; tone: "info" | "warn" | "working" };

const ENDED = new Set(["done", "failed", "stopped"]);

/**
 * The conversation's messages in order, as chat posts them for a conversation in a place (ADR 0024):
 * per run, what was sent, then what the agent answered or why it didn't. A run keeps only the agent's
 * latest status message, so earlier progress in a run isn't here.
 */
export function chatItems(runs: readonly RunView[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const run of runs) {
    const a2a = run.a2a;
    if (!a2a) continue;
    const name = a2a.agent.name;
    const at = a2a.statusAt ?? a2a.observedAt ?? run.endedAt ?? run.stateChangedAt ?? run.startedAt;
    a2a.messages.forEach((m, i) => {
      const key = `${run.runId}:sent:${i}`;
      if (m.text.trim()) {
        items.push({ kind: "sent", key, run, text: m.text, by: m.by, at: m.at, sending: m.status === "pending" || m.status === "sending" });
      }
      // The run's own reason says it in full when the agent took nothing (ADR 0018): said once, below.
      if (m.status === "failed" && m.error && m.error !== run.failReason) {
        items.push({ kind: "line", key: `${key}:failed`, run, text: `${name} didn't take this message: ${m.error}`, at: m.at, tone: "warn" });
      } else if (m.status === "unconfirmed") {
        items.push({ kind: "line", key: `${key}:unconfirmed`, run, text: `This may not have reached ${name}. It wasn't sent again.`, at: m.at, tone: "info" });
      }
    });
    const given = run.given;
    const sent = given ? deliveryLine(given) : undefined;
    // How far the send got matters until the agent has said something, or when it didn't arrive.
    if (sent && (run.state === "unknown" || sent.tone === "warn")) {
      items.push({
        kind: "line",
        key: `${run.runId}:delivery`,
        run,
        text: sent.text,
        at: run.stateChangedAt ?? run.startedAt,
        tone: sent.tone,
      });
    }
    if (run.private) {
      items.push({ kind: "line", key: `${run.runId}:private`, run, text: "Sent from a conversation you aren't in, so what was said isn't shown.", at, tone: "info" });
      continue;
    }
    const said = a2a.lastMessage?.trim() ?? "";
    // Hermes sends its answer as both the status message and an artifact: each said once, as chat does.
    const artifacts = a2a.artifacts.filter((x) => !(x.urls.length === 0 && !x.hasData && (x.text ?? "").trim() === said && said));
    const line = (text: string, tone: "info" | "warn" | "working") => items.push({ kind: "line", key: `${run.runId}:end`, run, text, at, tone });
    const ext = a2a.externalState;
    if (run.state === "done") {
      if (said || artifacts.length) items.push({ kind: "answer", key: `${run.runId}:answer`, run, text: said, at, artifacts, asking: false });
      else line(`${name} finished without a message.`, "info");
    } else if (run.state === "waiting") {
      if (ext === "TASK_STATE_AUTH_REQUIRED") line(run.prompt?.text ?? `${name} needs someone to sign in at its gateway before it can go on.`, "warn");
      else items.push({ kind: "answer", key: `${run.runId}:answer`, run, text: said || run.prompt?.text || `${name} needs more from you to go on.`, at, artifacts, asking: true });
    } else if (run.state === "working") {
      // Progress: only a status message with text, never the bare state; the writing line says it works.
      if (said) line(said, "working");
    } else if (run.state === "failed" && given) {
      line(
        run.failReason
          ? `${name} couldn't finish: ${run.failReason}`
          : `${name} reported that the task failed.`,
        "warn",
      );
    } else if (run.state === "stopped" && given) {
      line(`Stopped. ${name} can't report on it any more.`, "info");
    } else if (run.state === "failed") {
      line(
        ext === "TASK_STATE_FAILED"
          ? said
            ? `${name} couldn't finish: ${said}`
            : `${name} reported that the task failed.`
          : ext === "TASK_STATE_REJECTED"
            ? said
              ? `${name} declined: ${said}`
              : `${name} won't do this task.`
            : // The agent never took the work (refused, unreachable): the room's reason says why.
              (run.failReason ?? `${name} didn't take it.`),
        "warn",
      );
    } else if (run.state === "stopped") {
      line(a2a.cancel ? `${name} stopped, as asked.` : `${name} stopped this work.`, "info");
    } else if (run.state === "unknown" && run.failReason) {
      line(run.failReason, "warn");
    }
    if (ENDED.has(run.state) && run.state !== "done" && artifacts.length) {
      items.push({ kind: "answer", key: `${run.runId}:results`, run, text: "", at, artifacts, asking: false });
    }
  }
  return items;
}
