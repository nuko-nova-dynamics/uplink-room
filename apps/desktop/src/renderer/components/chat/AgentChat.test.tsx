// @vitest-environment happy-dom
/**
 * Talking with an A2A agent in chat (ADR 0024): an agent's thread proposal with its countdown and
 * what it says once answered, the run panel's reply box after the agent finished, and an agent
 * shown writing for as long as it works. The session they read is stood in for.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { RunView } from "../../lib/api";

vi.mock("../../lib/session", () => ({
  useSession: () => ({ me: { memberId: "mrosa" }, members: [], teamId: "team" }),
  useAct: () => async () => ({ runId: "r2" }),
  useRoomQuery: () => undefined,
}));

const { ThreadProposal } = await import("./MessageItem");
const { A2ARunActions } = await import("../A2ARun");
const { noteTyping, typistsNow } = await import("./Typing");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(ui: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(ui));
  return host;
}

const base = { title: "Q3 station migration", triggerMessageId: "mtrigger", expiresAt: Date.now() + 24_500 };

test("a pending proposal offers Yes and No to whoever may answer, with the seconds left; others see only the countdown", () => {
  const mine = render(<ThreadProposal messageId={"mp" as never} agent="Icarus" proposal={{ ...base, status: "pending", canDecide: true } as never} />);
  expect([...mine.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Yes", "No"]);
  expect(mine.textContent).toMatch(/Opens a thread for “Q3 station migration” in 2[45] s unless you say no\./);
  const theirs = render(<ThreadProposal messageId={"mp" as never} agent="Icarus" proposal={{ ...base, status: "pending", canDecide: false } as never} />);
  expect(theirs.querySelectorAll("button")).toHaveLength(0);
  expect(theirs.textContent).toMatch(/in 2[45] s\.$/);
});

test("an answered proposal folds into one line: who opened the thread, or that nobody answered, or that it stays here", () => {
  const open = vi.fn();
  const yes = render(
    <ThreadProposal messageId={"mp" as never} agent="Icarus" proposal={{ ...base, status: "accepted", decidedBy: { name: "Rosa" } } as never} onOpenThread={open} />,
  );
  expect(yes.textContent).toBe("Rosa opened a thread.Open thread");
  act(() => (yes.querySelector("button") as HTMLButtonElement).click());
  expect(open).toHaveBeenCalledWith("mtrigger");
  const timedOut = render(<ThreadProposal messageId={"mp" as never} agent="Icarus" proposal={{ ...base, status: "accepted" } as never} />);
  expect(timedOut.textContent).toBe("Nobody answered within 30 seconds, so the thread opened.");
  const no = render(<ThreadProposal messageId={"mp" as never} agent="Icarus" proposal={{ ...base, status: "declined", decidedBy: { name: "Rosa" } } as never} />);
  expect(no.textContent).toBe("Rosa said no, so Icarus answers here.");
});

function run(a2a: Record<string, unknown>): RunView {
  return {
    runId: "r1",
    harness: "a2a",
    state: "done",
    private: false,
    startedAt: 0,
    stateChangedAt: 0,
    a2a: { agent: { agentId: "a1", memberId: "m1", name: "Icarus" }, connected: true, canCancel: "supported", delivery: "sent", artifacts: [], lastContactAt: 0, messages: [], ...a2a },
  } as unknown as RunView;
}

test("after the agent finished, the run panel keeps its reply box, which continues the conversation; stopping is gone", async () => {
  const opened = vi.fn();
  const host = render(<A2ARunActions run={run({ following: false, replies: "conversation", place: { channelId: "c1" } })} onOpenRun={opened} onOpenPlace={() => {}} />);
  const box = host.querySelector("textarea")!;
  expect(box.placeholder).toBe("Continue with Icarus");
  expect(host.textContent).toContain("It's posted in the chat this run came from, and Icarus answers there with what was said before.");
  expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Send reply", "Open in chat"]);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, "one more thing");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (host.querySelector("button.primary") as HTMLButtonElement).click());
  // The reply went to a new run: the panel opens it.
  expect(opened).toHaveBeenCalledWith("r2");
  // A finished run from a room before conversations takes no reply.
  expect(render(<A2ARunActions run={run({ following: false })} />).querySelector("textarea")).toBeNull();
});

test("an agent working on a message shows as writing for as long as the room lists it, whatever its last keystroke", () => {
  const now = 1_800_000_000_000;
  const seen = new Map<string, { at: number; seenAt: number }>();
  const icarus = { member: { memberId: "icarus", name: "Icarus", kind: "agent" as const }, at: now - 10 * 60_000, working: true };
  noteTyping(seen, [icarus], now);
  expect(typistsNow(seen, [icarus], undefined, now + 60_000).map((t) => t.name)).toEqual(["Icarus"]);
  expect(typistsNow(seen, [{ ...icarus, replyTo: "thread" }], undefined, now)).toEqual([]);
});
