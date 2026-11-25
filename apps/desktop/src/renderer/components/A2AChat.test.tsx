// @vitest-environment happy-dom
/**
 * An agent conversation in the task panel is one chat (ADR 0041): the runs of one conversation draw
 * as one chat with one composer, separate conversations as separate chats, other runs as cards, and
 * the composer replies on the conversation's latest run. A run given to an agent the room can't
 * follow over A2A (ADR 0044) draws in the same chat. The session is stood in for.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, expect, test, vi } from "vitest";
import type { RunView } from "../lib/api";

const calls: { fn: string; args: unknown }[] = [];
let task: unknown;

vi.mock("../lib/session", () => ({
  useSession: () => ({ me: { memberId: "mrosa" }, members: [], teamId: "team", isAdmin: false }),
  useAct: (fn: never) => async (args: unknown) => {
    calls.push({ fn: getFunctionName(fn), args });
    return { runId: "r-new" };
  },
  useRoomQuery: (fn: never, args: unknown) => (args !== "skip" && getFunctionName(fn) === "tasks:get" ? task : undefined),
  useActOnce: () => [async () => undefined, false],
  useSoftRoomQuery: () => undefined,
  useToast: () => ({ show: () => {} }),
}));

const { groupRuns, chatItems } = await import("../lib/a2aChat");
const { TaskPanel } = await import("../views/TaskPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  calls.length = 0;
});

function render(ui: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(ui));
  return host;
}

const rosa = { kind: "person", memberId: "mrosa", name: "Rosa Vega" };

/** A run sent to Icarus on the task, as tasks.get shows it. */
function a2aRun(runId: string, at: number, more: { state?: string; conversationId?: string; sent?: string; answer?: string; failReason?: string; delivery?: string; externalState?: string; replies?: string } = {}): RunView {
  const state = more.state ?? "done";
  return {
    runId,
    taskId: "t1",
    harness: "a2a",
    state,
    ...(more.failReason ? { failReason: more.failReason } : {}),
    private: false,
    driver: rosa,
    startedAt: at,
    stateChangedAt: at + 1000,
    canReply: true,
    a2a: {
      agent: { agentId: "a1", memberId: "micarus", name: "Icarus" },
      connected: true,
      canCancel: "supported",
      ...(more.conversationId ? { conversationId: more.conversationId } : {}),
      following: state === "working" || state === "waiting",
      delivery: more.delivery ?? "sent",
      externalState: more.externalState ?? (state === "done" ? "TASK_STATE_COMPLETED" : undefined),
      statusAt: at + 1000,
      ...(more.answer ? { lastMessage: more.answer } : {}),
      artifacts: [],
      lastContactAt: at,
      replies: more.replies ?? "conversation",
      messages: more.sent ? [{ kind: "start", text: more.sent, at, status: more.delivery ?? "sent", by: rosa }] : [],
    },
  } as unknown as RunView;
}

function terminalRun(runId: string, at: number): RunView {
  return { runId, taskId: "t1", harness: "claude-code", state: "working", private: false, driver: rosa, startedAt: at, stateChangedAt: at, canReply: false, machine: { machineId: "mac1", name: "studio-mini" } } as unknown as RunView;
}

const REFUSED = "Icarus doesn't answer SendMessage, the A2A 1.0 method its Agent Card promises.";
const conversation = [
  a2aRun("r1", 1000, { state: "failed", conversationId: "c1", sent: "Pull last year's Bayview table", delivery: "failed", failReason: REFUSED }),
  a2aRun("r2", 2000, { conversationId: "c1", sent: "Pull last year's Bayview table", answer: "High tide was 6.2 ft at 4:12 PM." }),
  a2aRun("r3", 3000, { state: "working", conversationId: "c1", sent: "Compare it with this year", answer: "Reading the 2026 table", replies: "task" }),
];

test("runs of one conversation are one chat where the first one was; another conversation is its own chat; other runs stay cards", () => {
  const legacy = a2aRun("r9", 500);
  const groups = groupRuns([terminalRun("t", 0), legacy, conversation[2]!, a2aRun("r5", 2500, { conversationId: "c2" }), conversation[0]!, conversation[1]!]);
  expect(groups.map((g) => (g.kind === "card" ? `card ${g.run.runId}` : `chat ${g.runs.map((r) => r.runId).join(",")}`))).toEqual([
    "card t",
    // A run from before conversations has none: a chat of its own.
    "chat r9",
    // Oldest first, whatever order the task listed them in.
    "chat r1,r2,r3",
    "chat r5",
  ]);
});

test("the chat reads in order: what Rosa sent, the agent's refusal once, its answer, then its progress while it works", () => {
  expect(chatItems(conversation).map((i) => `${i.kind}: ${i.text}`)).toEqual([
    "sent: Pull last year's Bayview table",
    `line: ${REFUSED}`,
    "sent: Pull last year's Bayview table",
    "answer: High tide was 6.2 ft at 4:12 PM.",
    "sent: Compare it with this year",
    "line: Reading the 2026 table",
  ]);
});

test("the task panel draws a three-run conversation as one chat with one composer, beside a terminal run's card", async () => {
  task = { taskId: "t1", title: "Bayview tides", state: "working", owner: rosa, private: false, waitingOn: [], runs: [terminalRun("t", 0), ...conversation] };
  const nav = { go: vi.fn(), openTask: vi.fn(), openTerminal: vi.fn(), openSpace: vi.fn(), openThread: vi.fn(), openRun: vi.fn() };
  const host = render(<TaskPanel taskId={"t1" as never} nav={nav} onClose={() => {}} />);
  expect(host.querySelectorAll(".a2a-chat")).toHaveLength(1);
  expect(host.querySelectorAll(".run-card")).toHaveLength(1);
  expect(host.querySelectorAll(".a2a-chat textarea")).toHaveLength(1);
  expect(host.querySelector(".a2a-chat-under")!.textContent).toBe("Icarus is writing…");
  // Each answer links its own run.
  const links = [...host.querySelectorAll<HTMLButtonElement>('.a2a-chat button[aria-label="Run details"]')];
  expect(links).toHaveLength(3);
  act(() => links[1]!.click());
  expect(nav.openRun).toHaveBeenCalledWith({ runId: "r2" });

  // The one box replies on the conversation's latest run.
  const box = host.querySelector<HTMLTextAreaElement>(".a2a-chat textarea")!;
  expect(box.placeholder).toBe("Tell Icarus more");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, "and the 2024 one?");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(calls).toContainEqual({ fn: "runs:reply", args: { runId: "r3", text: "and the 2024 one?" } });

  // Stop applies to the open run too.
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".a2a-chat-head button")].find((b) => b.textContent === "Ask it to stop")!.click());
  expect(calls).toContainEqual({ fn: "runs:stop", args: { runId: "r3" } });
});

/** A run given to Grok Bot at its routine webhook (ADR 0044), as tasks.get shows it. */
function givenRun(
  runId: string,
  more: {
    state?: string;
    delivery?: { status: string; reason?: string };
    line?: string;
    question?: string;
    failReason?: string;
    canReply?: boolean;
  } = {},
): RunView {
  const state = more.state ?? "unknown";
  return {
    runId,
    taskId: "t1",
    harness: "agent",
    state,
    private: false,
    driver: rosa,
    startedAt: 4000,
    stateChangedAt: 5000,
    canReply: more.canReply ?? true,
    ...(more.question ? { prompt: { kind: "question", text: more.question } } : {}),
    ...(more.failReason ? { failReason: more.failReason } : {}),
    given: {
      agent: { memberId: "mgrok", agentId: "agrok", name: "Grok Bot" },
      reach: "webhook",
      ...(more.delivery ? { delivery: more.delivery } : {}),
      ...(more.line ? { lastMessage: { text: more.line, at: 5000 } } : {}),
      messages: [{ kind: "start", text: "Export tide tables as CSV", from: rosa, at: 4000 }],
    },
  } as unknown as RunView;
}

test("a run given to an agent is a chat of its own, which says how far the send got until the agent reports", () => {
  const groups = groupRuns([terminalRun("t", 0), givenRun("g1", { delivery: { status: "sent" } })]);
  expect(groups.map((g) => g.kind)).toEqual(["card", "chat"]);
  const [, chat] = groups;
  expect(chat!.kind === "chat" && chat!.runs[0]!.a2a?.agent.name).toBe("Grok Bot");
  const lines = (run: RunView) =>
    chatItems(groupRuns([run]).flatMap((g) => (g.kind === "chat" ? g.runs : []))).map(
      (i) => `${i.kind}: ${i.text}`,
    );
  expect(lines(givenRun("g1", { delivery: { status: "sent" } }))).toEqual([
    "sent: Export tide tables as CSV",
    "line: Sent to its routine",
  ]);
  expect(
    lines(givenRun("g1", { delivery: { status: "failed", reason: "The webhook answered 500." } })),
  ).toEqual(["sent: Export tide tables as CSV", "line: Failed: The webhook answered 500."]);
  expect(lines(givenRun("g1", { delivery: { status: "waiting" } }))).toEqual([
    "sent: Export tide tables as CSV",
    "line: Waiting for it to check in",
  ]);
  // Once it reports, its own words say where it is.
  expect(
    lines(
      givenRun("g1", {
        state: "waiting",
        delivery: { status: "sent" },
        line: "Which station?",
        question: "Which station?",
      }),
    ),
  ).toEqual(["sent: Export tide tables as CSV", "answer: Which station?"]);
  expect(
    lines(
      givenRun("g1", {
        state: "failed",
        delivery: { status: "sent" },
        failReason: "No access to the repo.",
      }),
    ),
  ).toEqual([
    "sent: Export tide tables as CSV",
    "line: Grok Bot couldn't finish: No access to the repo.",
  ]);
  expect(lines(givenRun("g1", { state: "stopped", canReply: false }))).toEqual([
    "sent: Export tide tables as CSV",
    "line: Stopped. Grok Bot can't report on it any more.",
  ]);
});

test("the task panel draws a given run as a chat, not a card: its box replies and Stop stops it", async () => {
  task = {
    taskId: "t1",
    title: "Bayview tides",
    state: "waiting",
    owner: rosa,
    private: false,
    waitingOn: [],
    runs: [
      givenRun("g1", {
        state: "waiting",
        delivery: { status: "sent" },
        line: "Which station?",
        question: "Which station?",
      }),
    ],
  };
  const nav = {
    go: vi.fn(),
    openTask: vi.fn(),
    openTerminal: vi.fn(),
    openSpace: vi.fn(),
    openThread: vi.fn(),
    openRun: vi.fn(),
  };
  const host = render(<TaskPanel taskId={"t1" as never} nav={nav} onClose={() => {}} />);
  expect(host.querySelectorAll(".run-card")).toHaveLength(0);
  expect(host.querySelector(".a2a-chat-name")!.textContent).toBe("Grok Bot");
  expect(host.querySelector(".agent-run.waiting")!.textContent).toContain(
    "Grok Bot is waiting on your answer",
  );
  const box = host.querySelector<HTMLTextAreaElement>(".a2a-chat textarea")!;
  expect(box.placeholder).toBe("Answer Grok Bot");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, "Bayview");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(calls).toContainEqual({ fn: "runs:reply", args: { runId: "g1", text: "Bayview" } });
  const head = [...host.querySelectorAll<HTMLButtonElement>(".a2a-chat-head button")].map(
    (b) => b.textContent,
  );
  expect(head).toEqual(["Stop"]);
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>(".a2a-chat-head button")][0]!.click(),
  );
  expect(calls).toContainEqual({ fn: "runs:stop", args: { runId: "g1" } });
});
