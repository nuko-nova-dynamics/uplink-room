/**
 * The two A2A versions the room speaks over JSON-RPC (ADR 0018): 1.0, the default, and 0.3, for
 * agents that only answer it. Only what the room sends differs here; what it reads is read the
 * same way for both (observe.ts accepts either shape).
 *
 * From the spec's own pages (a2a-protocol.org/latest/whats-new-v1 and the 0.3.0 JSON schema in
 * a2aproject/A2A, read 2026-11-04):
 *   - methods: SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask
 *     were message/send, message/stream, tasks/get, (none), tasks/cancel, tasks/resubscribe;
 *   - a message has `kind: "message"`, role "user" and parts with `kind: "text"` in 0.3, against
 *     role ROLE_USER and parts told apart by their members in 1.0;
 *   - SendMessage's `returnImmediately: true` was `blocking: false`;
 *   - the `A2A-Version` header: a 1.0 client sends it; an agent reads a missing one as 0.3
 *     (spec 3.6.1, 3.6.2), so the room leaves it out when it speaks 0.3.
 */
import type { Doc } from "../../_generated/dataModel";

export type Dialect = "1.0" | "0.3";

/** What the room asks of an agent. */
export type Op = "send" | "stream" | "get" | "list" | "cancel" | "subscribe";

const METHODS: Record<Dialect, Record<Op, string | null>> = {
  "1.0": {
    send: "SendMessage",
    stream: "SendStreamingMessage",
    get: "GetTask",
    list: "ListTasks",
    cancel: "CancelTask",
    subscribe: "SubscribeToTask",
  },
  "0.3": {
    send: "message/send",
    stream: "message/stream",
    get: "tasks/get",
    // A2A 0.3 has no way to list tasks.
    list: null,
    cancel: "tasks/cancel",
    subscribe: "tasks/resubscribe",
  },
};

/** The JSON-RPC method for `op` in `dialect`, or null when that version has none. */
export function methodFor(dialect: Dialect, op: Op): string | null {
  return METHODS[dialect][op];
}

export function otherDialect(dialect: Dialect): Dialect {
  return dialect === "1.0" ? "0.3" : "1.0";
}

/** The version an Agent Card's chosen interface names: "0.3" for any 0.3.x, otherwise "1.0". */
export function dialectOf(protocolVersion: string | undefined): Dialect {
  return protocolVersion && /^0\.3(\.|$)/.test(protocolVersion) ? "0.3" : "1.0";
}

/** What the card promises, and what the room speaks: what it learned, or else the card's. */
export function peerDialects(peer: Pick<Doc<"a2aPeers">, "card" | "speaks">): {
  declared: Dialect;
  speaks: Dialect;
  learned: boolean;
} {
  const declared = dialectOf(peer.card?.protocolVersion);
  return { declared, speaks: peer.speaks ?? declared, learned: peer.speaks !== undefined };
}

export type OutgoingText = {
  messageId: string;
  text: string;
  /**
   * More text parts after the message, such as what was said in its place since the agent last
   * heard (ADR 0024). The message comes first, so an agent that reads only the first part still
   * gets it; Hermes joins every text part.
   */
  more?: string[];
  taskId?: string;
  contextId?: string;
  /** Tasks this message refers to, such as the agent's last one in the conversation (spec 3.4.3). */
  referenceTaskIds?: string[];
  metadata: Record<string, unknown>;
};

/** A text message from the room, in the shape `dialect` expects. */
export function outgoingMessage(dialect: Dialect, m: OutgoingText): Record<string, unknown> {
  const ids = {
    ...(m.taskId ? { taskId: m.taskId } : {}),
    ...(m.contextId ? { contextId: m.contextId } : {}),
    ...(m.referenceTaskIds?.length ? { referenceTaskIds: m.referenceTaskIds } : {}),
  };
  const texts = [m.text, ...(m.more ?? [])];
  if (dialect === "0.3") {
    return {
      kind: "message",
      messageId: m.messageId,
      role: "user",
      parts: texts.map((text) => ({ kind: "text", text })),
      ...ids,
      metadata: m.metadata,
    };
  }
  return {
    messageId: m.messageId,
    role: "ROLE_USER",
    parts: texts.map((text) => ({ text, mediaType: "text/plain" })),
    ...ids,
    metadata: m.metadata,
  };
}

/** SendMessage's params: answer at once with the task, without its history. */
export function sendParams(dialect: Dialect, message: Record<string, unknown>) {
  return {
    message,
    configuration:
      dialect === "0.3"
        ? { blocking: false, historyLength: 0 }
        : { returnImmediately: true, historyLength: 0 },
  };
}

/**
 * What was said in a place since the agent last heard from it, as the agent reads it (ADR 0024): a
 * second text part after the message, headed so an LLM agent reads it as context, not as the ask.
 */
export function historyText(where: string, lines: { author: string; text: string; at: number }[]): string {
  const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
  return `Earlier in ${where}, since you last heard from it (oldest first, times in UTC):\n${lines
    .map((l) => `[${when(l.at)}] ${l.author}: ${l.text}`)
    .join("\n")}`;
}
