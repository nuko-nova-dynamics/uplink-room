/**
 * A local A2A 1.0 agent for tests and the end-to-end check (spec #8, ADR 0012).
 * It runs on the official SDK's server (`@a2a-js/sdk`), so the room's client is
 * checked against the reference implementation, not against our own reading of
 * the spec. Node only: vitest's globalSetup starts it, outside the edge runtime
 * the Convex tests run in.
 *
 * What it does depends on the first line of the text it receives:
 *
 *   reply: …   answers with a direct Message, no task
 *   work: …    a task that completes after `workMs` with a "Result" artifact
 *   ask: …     a task that asks a question (input required); the next message
 *              on that task completes it
 *   auth: …    a task that needs someone to sign in at the gateway
 *   fail: …    a task that fails with that reason
 *   reject: …  a task the agent rejects
 *   slow: …    a task that works until it is canceled (or 60 s pass)
 *   split: N   streams an artifact holding the gateway's token in N appended
 *              pieces, each committed on its own (a status change between)
 *   leak: N    asks a question whose text has the token after N characters
 *   drop: …    handled as what follows it ("drop: file: N" is "file: N"), but the
 *              HTTP connection is cut before the answer is written, so the caller
 *              can't tell whether it arrived
 *   err500: …  handled normally, then answered HTTP 500 with an internal error
 *   missing500: …  handled normally (a streaming send as a plain one), then
 *              answered HTTP 500 with "method not found"
 *
 * Conversations (ADR 0024). The agent remembers, per A2A context, every line it
 * heard. With `chat`, a message without a verb gets an answer like Hermes's: a
 * task that works, then completes with the answer as its status message and as
 * an artifact, saying what it heard, what it remembers from the context and how
 * many lines of history came with it. More verbs:
 *
 *   long: …    (chat) works for `workMs`, and answers with what else it was told
 *              meanwhile: a message to a task still working is noted, not a new task
 *   propose: T asks to open a thread titled T (a data part, input required); the
 *              answer on that task completes it, in the thread or here
 *   propose-mention: ID  the same, in a question that names ID (a member id, or run:<runId>)
 *   propose-line: T  the same in text, as an agent that answers only text does:
 *              the answer's first line, and the task completes
 *   file: N    completes with an artifact holding a small text file N as bytes
 *   reply-file: N       answers with a direct Message: a line of text and the file N as bytes
 *   reply-file-only: N  the same without the text
 *   link: N    completes with an artifact that links to https://example.com/files/N
 *   mention: ID  (chat) answers "<@ID> over to you.": ID is a member id, or run:<runId>
 *   progress: T  (chat) reports T as progress, then completes with T as its answer
 *
 * `maxTurns` refuses a context past that many messages, with Hermes's words;
 * `ignoreContext` and `ignoreTaskId` drop the room's context or task id before
 * the SDK sees them (Hermes opens a new task for every message);
 * `rejectContext` refuses a message whose context it doesn't know.
 *
 * The last three apply only to the send methods the gateway serves, so a send in
 * the other A2A version is refused as it would be otherwise.
 *
 * Options model the two gateways the room targets: Hermes (streaming, cancel,
 * task listing, per-peer bearer tokens) and OpenClaw (no streaming, no cancel,
 * no task listing; poll it).
 *
 * `serve: "0.3"` runs the official SDK at A2A 0.3 (`@a2a-js/sdk` 0.3.14) instead,
 * for the room's 0.3 support (ADR 0018). Its card is a 0.3 card unless `card` says
 * "1.0": then it promises 1.0 and answers only 0.3's methods, as some gateways do.
 *
 * Every gateway reads a request's body by its Content-Length only, as Hermes's
 * (Python's http.server) does, so a body sent chunked arrives empty and is
 * answered "method not found: ", as Hermes answered the room.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { AgentCard as AgentCardV03, Message as MessageV03 } from "@a2a-js/sdk-v03";
import {
  DefaultRequestHandler as DefaultRequestHandlerV03,
  InMemoryTaskStore as InMemoryTaskStoreV03,
  type AgentExecutor as AgentExecutorV03,
  type ExecutionEventBus as ExecutionEventBusV03,
  type RequestContext as RequestContextV03,
} from "@a2a-js/sdk-v03/server";
import {
  agentCardHandler as agentCardHandlerV03,
  jsonRpcHandler as jsonRpcHandlerV03,
  UserBuilder as UserBuilderV03,
} from "@a2a-js/sdk-v03/server/express";

export type FakeAgentOptions = {
  name?: string;
  streaming?: boolean;
  /** "supported" (default) or "unsupported": CancelTask answers UnsupportedOperationError, as OpenClaw does. */
  cancel?: "supported" | "unsupported";
  /** CancelTask answers with the task still working, and the task reports Canceled a moment later, as a gateway that cancels in the background does. */
  cancelAsync?: boolean;
  /** False: ListTasks answers method not found, as OpenClaw does. */
  listTasks?: boolean;
  /** When set, every JSON-RPC call needs `Authorization: Bearer <token>`. The card stays public. */
  bearer?: string;
  /** How long a `work:` task takes. */
  workMs?: number;
  /** Keep work pending until the test has observed progress and clears this flag. */
  holdWork?: boolean;
  /** Advertise this URL on the card instead of the server's own (to test a card pointing elsewhere). */
  advertiseUrl?: string;
  /** Advertise only this protocol version (to test a 0.3-only card). */
  protocolVersion?: string;
  /** SubscribeToTask sends only a Working snapshot of the task, then closes the stream. */
  subscribeSnapshotOnly?: boolean;
  /** SubscribeToTask answers JSON headers and then never finishes its body. */
  stallSubscribe?: boolean;
  /** ListTasks first answers this many empty pages, each with a nextPageToken, before the real one. */
  listPadPages?: number;
  /** The card's URL answers 302 to this location. */
  cardRedirect?: string;
  /** The tenant the card's interface names. */
  tenant?: string;
  /** Delay before each ListTasks answer. */
  listDelayMs?: number;
  /** ListTasks leaves artifacts out of every task, as some gateways do even when asked for them. */
  listWithoutArtifacts?: boolean;
  /** The next this many GetTask calls answer HTTP 503. */
  failGetTask?: number;
  /** GetTask answers TaskNotFoundError, as for a task that expired at the gateway. */
  getTaskNotFound?: boolean;
  /** SendStreamingMessage answers method not found, after this many ms, though the card says streaming. */
  streamUnsupportedAfterMs?: number;
  /** The A2A version whose methods the gateway answers (ADR 0018). Default "1.0". */
  serve?: "1.0" | "0.3";
  /** The version its card names: by default the one it serves. "1.0" with `serve: "0.3"` is a card that promises more. */
  card?: "1.0" | "0.3";
  /** Every JSON-RPC call answers "method not found: ", as a JSON-RPC server that isn't an A2A agent would. */
  refuseAll?: boolean;
  /** Every JSON-RPC call answers an error that echoes the request's headers and its bearer token. */
  echoHeaders?: boolean;
  /** Delay before each GetTask (or tasks/get) answer. */
  getTaskDelayMs?: number;
  /** Every JSON-RPC call answers an error whose message has the bearer token after this many characters. */
  echoTokenAt?: number;
  /** Answers a message without a verb as a chat agent does (ADR 0024). */
  chat?: boolean;
  /** Refuses a context after this many messages in it, as Hermes's anti-loop limit does. */
  maxTurns?: number;
  /** Drops the context the room sends, so every message starts a context of its own. */
  ignoreContext?: boolean;
  /** Drops the task id the room sends, so every message is a new task, as Hermes does. */
  ignoreTaskId?: boolean;
  /** SendMessage ignores `returnImmediately` and answers once the task is finished or needs input. */
  blocking?: boolean;
  /** Refuses a new message whose context it doesn't know with a JSON-RPC error. */
  rejectContext?: boolean;
};

export type FakeAgent = {
  url: string;
  cardUrl: string;
  /** Changes options while the agent runs (the card is served fresh each time). */
  setOptions: (patch: Partial<FakeAgentOptions>) => void;
  /** Every JSON-RPC request the agent received, in order. */
  calls: { method: string; headers: Record<string, string | undefined>; params: any }[];
  close: () => Promise<void>;
};

function text(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function agentMessage(value: string, taskId: string, contextId: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: crypto.randomUUID(),
    parts: [text(value)],
    taskId,
    contextId,
    extensions: [],
    metadata: {},
    referenceTaskIds: [],
  };
}

function firstLine(message: Message): string {
  const part = message.parts.find((p) => p.content?.$case === "text");
  const value = part?.content?.$case === "text" ? part.content.value : "";
  return value.split("\n")[0]!.trim();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeExecutor implements AgentExecutor {
  private readonly canceled = new Set<string>();
  /** Tasks whose execute() is still running, with their context. */
  private readonly running = new Map<string, string>();
  private readonly contexts = new Map<string, string>();
  /** How many questions each task asked. */
  private readonly asked = new Map<string, number>();
  /** Every line heard in each context, in order (ADR 0024). */
  private readonly memory = new Map<string, string[]>();
  /** Messages per context, for `maxTurns`. */
  private readonly turns = new Map<string, number>();
  /** What a task still working was told meanwhile. */
  private readonly notes = new Map<string, string[]>();
  /** The thread a task or context proposed, by its title. */
  private readonly proposed = new Map<string, string>();
  /** Lines of history that came with the last message, per task. */
  private readonly historyLines = new Map<string, number>();
  /** The contexts this agent has seen, for `rejectContext`. */
  readonly known = new Set<string>();

  /**
   * A message to a task still working (`long:`) is noted for that work, and answered with the task
   * as it stands, before the SDK sees it: the SDK runs a second execution for the same task, and
   * settles the task's events when that one returns, which would drop the first one's answer.
   */
  noteForRunning(taskId: string | undefined, line: string): { id: string; contextId: string } | null {
    if (!taskId || !this.running.has(taskId)) return null;
    this.notes.set(taskId, [...(this.notes.get(taskId) ?? []), line.replace(/^@\S+\s+/, "")]);
    return { id: taskId, contextId: this.running.get(taskId)! };
  }

  /** `cancelAsync`: marks a running task to cancel, and gives it as it stands, still working. */
  cancelLater(taskId: string): { id: string; contextId: string } | null {
    if (!this.running.has(taskId)) return null;
    this.canceled.add(taskId);
    return { id: taskId, contextId: this.running.get(taskId)! };
  }
  private readonly options: FakeAgentOptions;
  /** Set when the agent closes, so loops that wait end. */
  closed = false;
  constructor(options: FakeAgentOptions) {
    this.options = options;
  }

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    if (this.running.has(taskId)) {
      this.canceled.add(taskId);
      return;
    }
    // Nothing is running it (it waits for input): cancel it here.
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: this.contexts.get(taskId) ?? "",
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        metadata: {},
      }),
    );
  };

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = context;
    this.running.set(taskId, contextId);
    this.contexts.set(taskId, contextId);
    try {
      await this.run(context, bus);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async run(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    // A mention at the start ("@Hermes work: …") isn't part of the verb, and neither is "drop:".
    const line = firstLine(userMessage).replace(/^@\S+\s+/, "").replace(/^drop:\s*/, "");
    const status = (state: TaskState, message?: string, more: Part[] = []) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state,
            timestamp: new Date().toISOString(),
            message: message || more.length ? { ...agentMessage(message ?? "", taskId, contextId), parts: [...(message ? [text(message)] : []), ...more] } : undefined,
          },
          metadata: {},
        }),
      );
    const metadata = (userMessage.metadata ?? {}) as Record<string, any>;
    const decision = metadata["uplink.room/thread-decision"] as { open: boolean; byTimeout: boolean } | undefined;
    const earlier = this.memory.get(contextId) ?? [];
    this.memory.set(contextId, [...earlier, line]);
    this.known.add(contextId);
    const historyPart = userMessage.parts.filter((p) => p.content?.$case === "text")[1];
    const history = historyPart?.content?.$case === "text" ? historyPart.content.value.split("\n").length - 1 : 0;
    this.historyLines.set(taskId, history);
    const turn = (this.turns.get(contextId) ?? 0) + 1;
    this.turns.set(contextId, turn);
    if (this.options.maxTurns !== undefined && turn > this.options.maxTurns) {
      bus.publish(AgentEvent.task({ id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined }, artifacts: [], history: [userMessage], metadata: {} }));
      status(
        TaskState.TASK_STATE_REJECTED,
        `Anti-loop protection: context ${contextId} exceeded ${this.options.maxTurns} turns. Start a new context or increase A2A_MAX_PINGPONG_TURNS.`,
      );
      return;
    }
    const answer = (said: string) => {
      const before = earlier.filter((l) => l !== said);
      const lines = this.historyLines.get(taskId) ?? 0;
      return `${this.options.name ?? "Fake agent"} here. You said: “${said}”.${before.length ? ` Earlier you said: ${before.map((l) => `“${l}”`).join(", ")}.` : ""}${lines ? ` I can see ${lines} earlier messages.` : ""}`;
    };
    const complete = (said: string, extra: Part[] = []) => {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: { artifactId: "reply", name: "Reply", description: "", parts: [text(said), ...extra], metadata: undefined, extensions: [] },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      // The answer as the status message too, as Hermes sends it.
      status(TaskState.TASK_STATE_COMPLETED, said);
    };

    // The answer to a thread proposal made on this task.
    if (context.task && context.task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED && this.proposed.has(taskId)) {
      bus.publish(AgentEvent.task(context.task));
      const title = this.proposed.get(taskId)!;
      complete(`${decision?.open ? "In the thread" : "Here"}: the plan for ${title}.`);
      return;
    }
    // The answer to a thread proposal made in text, as the next task in the context.
    if (decision && this.proposed.has(contextId)) {
      bus.publish(AgentEvent.task({ id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined }, artifacts: [], history: [userMessage], metadata: {} }));
      complete(`${decision.open ? "Thread it is" : "Staying here"}: the plan for ${this.proposed.get(contextId)}.`);
      return;
    }

    // A follow-up on a task that asked a question finishes it.
    // "again…" keeps asking: a new question at once, without passing through Working.
    if (
      context.task &&
      context.task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED &&
      line.startsWith("again")
    ) {
      bus.publish(AgentEvent.task(context.task));
      this.asked.set(taskId, (this.asked.get(taskId) ?? 1) + 1);
      status(TaskState.TASK_STATE_INPUT_REQUIRED, `Question ${this.asked.get(taskId)}?`);
      return;
    }
    if (context.task && context.task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      bus.publish(AgentEvent.task(context.task));
      status(TaskState.TASK_STATE_WORKING);
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: "answer",
            name: "Answer",
            description: "",
            parts: [text(`Thanks: ${line}`)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      status(TaskState.TASK_STATE_COMPLETED);
      return;
    }

    if (line.startsWith("reply-file:") || line.startsWith("reply-file-only:")) {
      const name = line.slice(line.indexOf(":") + 1).trim() || "notes.txt";
      const file: Part = { content: { $case: "raw", value: Buffer.from("tide notes\n") }, metadata: undefined, filename: name, mediaType: "text/plain" };
      bus.publish(
        AgentEvent.message({
          role: Role.ROLE_AGENT,
          messageId: crypto.randomUUID(),
          parts: line.startsWith("reply-file-only:") ? [file] : [text(`Here is ${name}.`), file],
          taskId: "",
          contextId,
          extensions: [],
          metadata: {},
          referenceTaskIds: [],
        }),
      );
      return;
    }
    if (line.startsWith("reply:")) {
      bus.publish(
        AgentEvent.message({
          role: Role.ROLE_AGENT,
          messageId: crypto.randomUUID(),
          parts: [text(`You said ${line.slice("reply:".length).trim()}`)],
          taskId: "",
          contextId,
          extensions: [],
          metadata: {},
          referenceTaskIds: [],
        }),
      );
      return;
    }

    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        artifacts: [],
        history: [userMessage],
        metadata: {},
      }),
    );

    const [verb, ...rest] = line.split(":");
    const detail = rest.join(":").trim();
    try {
      switch (verb) {
        case "propose":
          this.proposed.set(taskId, detail || "this");
          status(TaskState.TASK_STATE_INPUT_REQUIRED, "This looks like it should be its own thread. Want me to open it?", [
            { content: { $case: "data", value: { kind: "uplink.room/propose-thread", title: detail || "this" } }, metadata: undefined, filename: "", mediaType: "application/json" },
          ]);
          return;
        case "propose-mention":
          // Proposes a thread in a question that names a member or a run ("propose-mention: run:<runId>").
          this.proposed.set(taskId, "the handover");
          status(TaskState.TASK_STATE_INPUT_REQUIRED, `<@${detail}> should see this. Want me to open a thread?`, [
            { content: { $case: "data", value: { kind: "uplink.room/propose-thread", title: "the handover" } }, metadata: undefined, filename: "", mediaType: "application/json" },
          ]);
          return;
        case "propose-line":
          this.proposed.set(contextId, detail || "this");
          status(TaskState.TASK_STATE_WORKING);
          status(TaskState.TASK_STATE_COMPLETED, `uplink.room/propose-thread: ${detail || "this"}\nShall I take this to a thread?`);
          return;
        case "file":
          status(TaskState.TASK_STATE_WORKING);
          complete(`Here is ${detail || "notes.txt"}.`, [
            { content: { $case: "raw", value: Buffer.from("tide notes\n") }, metadata: undefined, filename: detail || "notes.txt", mediaType: "text/plain" },
          ]);
          return;
        case "link":
          status(TaskState.TASK_STATE_WORKING);
          complete("Here is the link.", [
            { content: { $case: "url", value: `https://example.com/files/${detail}` }, metadata: undefined, filename: "", mediaType: "application/pdf" },
          ]);
          return;
        case "mention":
          // Names a member ("mention: <memberId>") or a run ("mention: run:<runId>") in its answer
          // with the Room API's token, as an agent that read the room's docs writes one. The room
          // sends mention tokens as names, so the id comes bare.
          if (!this.options.chat) break;
          status(TaskState.TASK_STATE_WORKING);
          complete(`<@${detail}> over to you.`);
          return;
        case "progress":
          if (!this.options.chat) break;
          status(TaskState.TASK_STATE_WORKING, detail);
          await sleep(300);
          complete(detail);
          return;
        case "long":
          if (!this.options.chat) break;
          status(TaskState.TASK_STATE_WORKING);
          await sleep(this.options.workMs ?? 600);
          complete(`Done with ${detail}. While I worked you also said: ${(this.notes.get(taskId) ?? []).map((l) => `“${l}”`).join(", ") || "nothing"}.`);
          return;
        case "ask":
          status(TaskState.TASK_STATE_INPUT_REQUIRED, detail || "Which branch?");
          return;
        case "auth":
          status(TaskState.TASK_STATE_AUTH_REQUIRED, "Sign in to GitHub at the gateway.");
          return;
        case "fail":
          status(TaskState.TASK_STATE_WORKING);
          status(TaskState.TASK_STATE_FAILED, detail || "It broke.");
          return;
        case "reject":
          status(TaskState.TASK_STATE_REJECTED, detail || "I won't do that.");
          return;
        case "split": {
          // The token, in pieces, appended to one artifact; a status change commits each piece alone.
          const token = this.options.bearer ?? "";
          const count = Number(detail) || 2;
          const size = Math.ceil(token.length / count);
          status(TaskState.TASK_STATE_WORKING);
          for (let i = 0; i < count; i++) {
            const piece = `${i === 0 ? "token: " : ""}${token.slice(i * size, (i + 1) * size)}${i === count - 1 ? " end" : ""}`;
            bus.publish(
              AgentEvent.artifactUpdate({
                taskId,
                contextId,
                artifact: {
                  artifactId: "echo",
                  name: "Echo",
                  description: "",
                  parts: [text(piece)],
                  metadata: undefined,
                  extensions: [],
                },
                append: i > 0,
                lastChunk: i === count - 1,
                metadata: undefined,
              }),
            );
            status(TaskState.TASK_STATE_WORKING, `piece ${i + 1}`);
            await sleep(60);
          }
          status(TaskState.TASK_STATE_COMPLETED);
          return;
        }
        case "leak":
          status(
            TaskState.TASK_STATE_INPUT_REQUIRED,
            `${"p".repeat(Number(detail) || 0)}${this.options.bearer ?? ""} end`,
          );
          return;
        case "chunks": {
          status(TaskState.TASK_STATE_WORKING);
          const piece = (artifactId: string, value: string, append: boolean) =>
            bus.publish(
              AgentEvent.artifactUpdate({
                taskId,
                contextId,
                artifact: {
                  artifactId,
                  name: artifactId,
                  description: "",
                  parts: [text(value)],
                  metadata: undefined,
                  extensions: [],
                },
                append,
                lastChunk: false,
                metadata: undefined,
              }),
            );
          piece("a", "a1", false);
          piece("b", "b1", false);
          // A status change commits both artifacts before the appends arrive.
          status(TaskState.TASK_STATE_WORKING, "halfway");
          await sleep(100);
          // Within one commit interval: appends to both artifacts.
          piece("a", "a2", true);
          piece("b", "b2", true);
          await sleep(100);
          status(TaskState.TASK_STATE_COMPLETED);
          return;
        }
        case "slow": {
          status(TaskState.TASK_STATE_WORKING, "Working on it");
          const until = Date.now() + 60_000;
          while (Date.now() < until && !this.closed) {
            if (this.canceled.has(taskId)) {
              status(TaskState.TASK_STATE_CANCELED, "Canceled by the caller.");
              return;
            }
            await sleep(50);
          }
          status(TaskState.TASK_STATE_COMPLETED);
          return;
        }
        default: {
          if (this.options.chat && !["work", "ask", "auth", "fail", "reject", "slow", "split", "leak", "chunks"].includes(verb!)) {
            status(TaskState.TASK_STATE_WORKING);
            await sleep(this.options.workMs ?? 100);
            complete(answer(line));
            return;
          }
          status(TaskState.TASK_STATE_WORKING, "Working on it");
          while (this.options.holdWork && !this.canceled.has(taskId)) await sleep(10);
          await sleep(this.options.workMs ?? 300);
          if (this.canceled.has(taskId)) {
            status(TaskState.TASK_STATE_CANCELED);
            return;
          }
          bus.publish(
            AgentEvent.artifactUpdate({
              taskId,
              contextId,
              artifact: {
                artifactId: "result",
                name: "Result",
                description: "",
                parts: [
                  text(`Done: ${detail || line}`),
                  {
                    content: { $case: "url", value: "https://example.com/report.pdf" },
                    metadata: undefined,
                    filename: "report.pdf",
                    mediaType: "application/pdf",
                  },
                ],
                metadata: undefined,
                extensions: [],
              },
              append: false,
              lastChunk: true,
              metadata: undefined,
            }),
          );
          status(TaskState.TASK_STATE_COMPLETED);
        }
      }
    } finally {
      this.canceled.delete(taskId);
    }
  }
}

/**
 * The same agent at A2A 0.3, on the 0.3 SDK: `kind` on every object, lowercase states, and
 * `finished()` once the work is over. It knows reply:, ask: (the next message on the task
 * completes it), fail:, slow: (until canceled) and work (the default).
 */
class FakeExecutorV03 implements AgentExecutorV03 {
  private readonly canceled = new Set<string>();
  private readonly running = new Set<string>();
  private readonly contexts = new Map<string, string>();
  private readonly options: FakeAgentOptions;
  closed = false;
  constructor(options: FakeAgentOptions) {
    this.options = options;
  }

  cancelTask = async (taskId: string, bus: ExecutionEventBusV03): Promise<void> => {
    if (this.running.has(taskId)) {
      this.canceled.add(taskId);
      return;
    }
    bus.publish({
      kind: "status-update",
      taskId,
      contextId: this.contexts.get(taskId) ?? "",
      status: { state: "canceled", timestamp: new Date().toISOString() },
      final: true,
    });
    bus.finished();
  };

  async execute(context: RequestContextV03, bus: ExecutionEventBusV03): Promise<void> {
    this.running.add(context.taskId);
    this.contexts.set(context.taskId, context.contextId);
    try {
      await this.run(context, bus);
    } finally {
      this.running.delete(context.taskId);
      bus.finished();
    }
  }

  private async run(context: RequestContextV03, bus: ExecutionEventBusV03): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const part = userMessage.parts.find((p) => p.kind === "text");
    // A mention at the start ("@Hermes reply: …") isn't part of the verb.
    const line = (part?.kind === "text" ? part.text : "").split("\n")[0]!.trim().replace(/^@\S+\s+/, "");
    const agentText = (text: string): MessageV03 => ({
      kind: "message",
      role: "agent",
      messageId: crypto.randomUUID(),
      parts: [{ kind: "text", text }],
      taskId,
      contextId,
    });
    const status = (
      state: "working" | "input-required" | "completed" | "failed" | "canceled",
      message?: string,
    ) =>
      bus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state,
          timestamp: new Date().toISOString(),
          ...(message ? { message: agentText(message) } : {}),
        },
        final: state !== "working",
      });

    if (context.task?.status.state === "input-required") {
      bus.publish(context.task);
      status("working");
      bus.publish({
        kind: "artifact-update",
        taskId,
        contextId,
        artifact: { artifactId: "answer", name: "Answer", parts: [{ kind: "text", text: `Thanks: ${line}` }] },
        append: false,
        lastChunk: true,
      });
      status("completed");
      return;
    }
    if (line.startsWith("reply:")) {
      bus.publish({ ...agentText(`You said ${line.slice("reply:".length).trim()}`), taskId: undefined });
      return;
    }
    bus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: [userMessage],
      artifacts: [],
    });
    const [verb, ...rest] = line.split(":");
    const detail = rest.join(":").trim();
    switch (verb) {
      case "ask":
        status("input-required", detail || "Which branch?");
        return;
      case "fail":
        status("working");
        status("failed", detail || "It broke.");
        return;
      case "slow": {
        status("working", "Working on it");
        const until = Date.now() + 60_000;
        while (Date.now() < until && !this.closed) {
          if (this.canceled.has(taskId)) {
            this.canceled.delete(taskId);
            status("canceled", "Canceled by the caller.");
            return;
          }
          await sleep(50);
        }
        status("completed");
        return;
      }
      default: {
        status("working", "Working on it");
        await sleep(this.options.workMs ?? 300);
        bus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: {
            artifactId: "result",
            name: "Result",
            parts: [
              { kind: "text", text: `Done: ${detail || line}` },
              {
                kind: "file",
                file: { uri: "https://example.com/report.pdf", mimeType: "application/pdf", name: "report.pdf" },
              },
            ],
          },
          append: false,
          lastChunk: true,
        });
        status("completed");
      }
    }
  }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Starts the agent on a free port on 127.0.0.1 (or `port`). */
export async function startFakeAgent(options: FakeAgentOptions = {}, port = 0): Promise<FakeAgent> {
  const calls: FakeAgent["calls"] = [];
  const app = express();
  let url = "";
  const card = (): AgentCard =>
    ({
      name: options.name ?? "Fake agent",
      description: "A local A2A agent for Uplink Room tests.",
      supportedInterfaces: [
        {
          url: options.advertiseUrl ?? url,
          protocolBinding: "JSONRPC",
          tenant: options.tenant ?? "",
          protocolVersion: options.protocolVersion ?? "1.0",
        },
      ],
      provider: { organization: "Uplink Room tests", url: "https://example.com" },
      version: "1.0.0",
      capabilities: {
        streaming: options.streaming ?? false,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
      },
      securitySchemes: options.bearer
        ? {
            bearer: {
              scheme: {
                $case: "httpAuthSecurityScheme",
                value: { description: "", scheme: "Bearer", bearerFormat: "" },
              },
            },
          }
        : {},
      securityRequirements: options.bearer ? [{ schemes: { bearer: { list: [] } } }] : [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [
        {
          id: "chores",
          name: "Chores",
          description: "Does small jobs.",
          tags: ["test"],
          examples: [],
          inputModes: [],
          outputModes: [],
          securityRequirements: [],
        },
      ],
      documentationUrl: "",
      signatures: [],
      iconUrl: "",
    }) as AgentCard;

  const serve = options.serve ?? "1.0";
  // Read per request: a test can change what the card names while the agent runs.
  const cardVersion = () => options.card ?? serve;
  const sends = serve === "0.3" ? ["message/send", "message/stream"] : ["SendMessage", "SendStreamingMessage"];
  /** An A2A 0.3 card: the endpoint at the top, with its transport and version. */
  const cardV03 = (): AgentCardV03 => ({
    name: options.name ?? "Fake agent",
    description: "A local A2A 0.3 agent for Uplink Room tests.",
    url: options.advertiseUrl ?? url,
    preferredTransport: "JSONRPC",
    protocolVersion: options.protocolVersion ?? "0.3.0",
    version: "1.0.0",
    capabilities: { streaming: options.streaming ?? false, pushNotifications: false },
    ...(options.bearer
      ? {
          securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
          security: [{ bearer: [] }],
        }
      : {}),
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "chores", name: "Chores", description: "Does small jobs.", tags: ["test"] }],
  });
  const executor = serve === "0.3" ? new FakeExecutorV03(options) : new FakeExecutor(options);
  const requestHandler =
    serve === "0.3"
      ? new DefaultRequestHandlerV03(cardV03(), new InMemoryTaskStoreV03(), executor as FakeExecutorV03)
      : new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor as FakeExecutor);
  if (options.cardRedirect) {
    const to = options.cardRedirect;
    app.get(`/${AGENT_CARD_PATH}`, (_req, res) => {
      res.redirect(302, to);
    });
  }
  // The card's URL is only known once the server listens, so it is served fresh.
  const cardHandlerV03 = agentCardHandlerV03({ agentCardProvider: async () => cardV03() });
  const cardHandlerV1 = agentCardHandler({ agentCardProvider: { getAgentCard: async () => card() } });
  app.use(`/${AGENT_CARD_PATH}`, (req, res, next) =>
    (cardVersion() === "0.3" ? cardHandlerV03 : cardHandlerV1)(req, res, next),
  );
  // As Hermes's gateway reads a request: by Content-Length only (Python's http.server).
  const contentLengthOnly: express.RequestHandler = (req, res, next) => {
    if (req.header("content-length") === undefined) {
      calls.push({ method: "", headers: { "transfer-encoding": req.header("transfer-encoding") }, params: {} });
      res.json(rpcError(null, -32601, "method not found: "));
      return;
    }
    next();
  };
  app.post("/", contentLengthOnly, express.json({ limit: "1mb" }), async (req, res, next) => {
    const body = req.body as { id?: unknown; method?: string; params?: any };
    calls.push({
      method: String(body?.method),
      headers: {
        authorization: req.header("authorization"),
        "a2a-version": req.header("a2a-version"),
        "content-type": req.header("content-type"),
      },
      params: body?.params,
    });
    if (options.bearer && req.header("authorization") !== `Bearer ${options.bearer}`) {
      res.status(401).json(rpcError(body?.id, -32001, "Unauthorized"));
      return;
    }
    if (options.refuseAll) {
      res.json(rpcError(body?.id, -32601, "method not found: "));
      return;
    }
    if (options.echoTokenAt !== undefined) {
      const token = (req.header("authorization") ?? "").replace(/^Bearer /, "");
      res.json(rpcError(body?.id, -32602, `${"p".repeat(options.echoTokenAt)}${token} end`));
      return;
    }
    if (options.echoHeaders) {
      const token = (req.header("authorization") ?? "").replace(/^Bearer /, "");
      res.json(
        rpcError(body?.id, -32602, `invalid params; your headers were ${JSON.stringify(req.headers)}; token ${token}`),
      );
      return;
    }
    if ((body?.method === "GetTask" || body?.method === "tasks/get") && options.getTaskDelayMs) {
      await sleep(options.getTaskDelayMs);
    }
    if (body?.method === "SendStreamingMessage" && options.streamUnsupportedAfterMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.streamUnsupportedAfterMs));
      res.json(rpcError(body.id, -32601, "Method not found"));
      return;
    }
    if (body?.method === "CancelTask" && options.cancel === "unsupported") {
      res.json(rpcError(body.id, -32004, "Cancel is not supported by this gateway."));
      return;
    }
    if (body?.method === "CancelTask" && options.cancelAsync && executor instanceof FakeExecutor) {
      const task = executor.cancelLater(String(body.params?.id ?? ""));
      if (task) {
        res.json({ jsonrpc: "2.0", id: body.id, result: { ...task, status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() } } });
        return;
      }
    }
    if (body?.method === "ListTasks" && options.listTasks === false) {
      res.json(rpcError(body.id, -32601, "Method not found"));
      return;
    }
    if (body?.method === "SubscribeToTask" && options.subscribeSnapshotOnly) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const task = { id: body.params?.id, status: { state: "TASK_STATE_WORKING" } };
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task } })}\n\n`);
      return;
    }
    if (body?.method === "SubscribeToTask" && options.stallSubscribe) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      return;
    }
    if (body?.method === "GetTask" && options.getTaskNotFound) {
      res.json(rpcError(body.id, -32001, "Task not found"));
      return;
    }
    if (body?.method === "GetTask" && options.failGetTask) {
      options.failGetTask--;
      res.status(503).json(rpcError(body.id, -32603, "Service unavailable"));
      return;
    }
    if (body?.method === "ListTasks" && options.listWithoutArtifacts) {
      const json = res.json.bind(res);
      res.json = ((answer: { result?: { tasks?: Record<string, unknown>[] } }) => {
        for (const task of answer?.result?.tasks ?? []) delete task["artifacts"];
        return json(answer);
      }) as typeof res.json;
    }
    if (body?.method === "ListTasks" && options.listDelayMs) {
      await sleep(options.listDelayMs);
    }
    if (body?.method === "ListTasks" && options.listPadPages) {
      const token = String(body.params?.pageToken ?? "");
      const page = token.startsWith("pad-") ? Number(token.slice(4)) : 0;
      if (page < options.listPadPages) {
        res.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tasks: [], nextPageToken: `pad-${page + 1}`, pageSize: 0, totalSize: 0 },
        });
        return;
      }
      delete body.params.pageToken;
    }
    const incoming = body?.params?.message as { contextId?: string; taskId?: string } | undefined;
    if (incoming && sends.includes(String(body?.method))) {
      // An agent that can't accept a context it doesn't know refuses the message (spec 3.4.1).
      if (options.rejectContext && incoming.contextId && !incoming.taskId && !(executor as FakeExecutor).known?.has(incoming.contextId)) {
        res.json(rpcError(body.id, -32602, `Unknown context ${incoming.contextId}`));
        return;
      }
      if (options.ignoreContext && !incoming.taskId) delete incoming.contextId;
      if (options.ignoreTaskId) delete incoming.taskId;
      if (options.blocking && body.params.configuration) delete body.params.configuration.returnImmediately;
      const first = String((body.params.message.parts ?? []).find((p: { text?: unknown }) => typeof p.text === "string")?.text ?? "").split("\n")[0]!.trim();
      const working = executor instanceof FakeExecutor ? executor.noteForRunning(incoming.taskId, first) : null;
      if (working) {
        const task = { ...working, status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() } };
        res.json({ jsonrpc: "2.0", id: body.id, result: { task } });
        return;
      }
    }
    const raw = body?.params?.message?.parts?.[0]?.text;
    // Faults apply to the sends this gateway serves; another version's send is refused as usual.
    const sent = sends.includes(String(body?.method)) ? raw : undefined;
    if (typeof sent === "string" && sent.startsWith("missing500:")) {
      // The agent takes the message, then the gateway answers HTTP 500 with "method not found":
      // nothing tells the caller it didn't arrive. A streaming send is handled as a plain one.
      if (body.method === sends[1]) body.method = sends[0];
      const json = res.json.bind(res);
      res.json = ((_body: unknown) => {
        res.status(500);
        return json(rpcError(body.id, -32601, "Method not found"));
      }) as typeof res.json;
    }
    if (typeof sent === "string" && sent.startsWith("err500:")) {
      // The agent takes the message, then the gateway answers an internal error anyway.
      const json = res.json.bind(res);
      res.json = ((_body: unknown) => {
        res.status(500);
        return json(rpcError(body.id, -32603, "Internal error"));
      }) as typeof res.json;
    }
    if (typeof sent === "string" && sent.startsWith("drop:")) {
      // Let the agent take the message, then cut the connection before the answer goes out.
      const end = res.end.bind(res);
      res.end = ((..._args: unknown[]) => {
        req.socket.destroy();
        return res;
      }) as typeof res.end;
      void end;
    }
    next();
  });
  app.use(
    serve === "0.3"
      ? jsonRpcHandlerV03({
          requestHandler: requestHandler as DefaultRequestHandlerV03,
          userBuilder: UserBuilderV03.noAuthentication,
        })
      : jsonRpcHandler({
          requestHandler: requestHandler as DefaultRequestHandler,
          userBuilder: UserBuilder.noAuthentication,
        }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}/`;
  return {
    url,
    cardUrl: `${url}${AGENT_CARD_PATH}`,
    setOptions: (patch) => Object.assign(options, patch),
    calls,
    close: () =>
      new Promise((resolve) => {
        executor.closed = true;
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
