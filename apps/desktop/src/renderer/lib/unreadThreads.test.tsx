// @vitest-environment happy-dom
/**
 * useUnreadThreads against a stand-in for Convex's useQueries: the pages of
 * messages.unreadThreads it asks for, and that it asks with the same object on every render
 * (a new one each render made the channel view re-render without end, #99 review round 3).
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

type Request = Record<string, { args: { cursor: string | null } }>;
const asked: Request[] = [];
// Thirteen threads, newest reply first: topic 13's reply is seq 113, topic 1's is seq 101.
const threads = Array.from({ length: 13 }, (_, i) => ({ message: { messageId: `t${13 - i}`, lastReplySeq: 113 - i }, newReplies: 1, moreNew: false }));
function page(cursor: string | null) {
  const from = cursor === null ? 0 : threads.findIndex((t) => t.message.lastReplySeq < Number(cursor));
  const rows = threads.slice(from, from + 10);
  const isDone = from + 10 >= threads.length;
  return { page: rows, continueCursor: isDone ? "" : String(rows.at(-1)!.message.lastReplySeq), isDone };
}
vi.mock("convex/react", () => ({
  useQueries: (requests: Request) => {
    asked.push(requests);
    return Object.fromEntries(Object.entries(requests).map(([key, r]) => [key, page(r.args.cursor)]));
  },
}));
const { useUnreadThreads } = await import("./unreadThreads");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  asked.length = 0;
});

test("the strip's threads come ten at a time and the eleventh is reached; the same request goes to Convex each render", () => {
  let seen: ReturnType<typeof useUnreadThreads> | null = null;
  let renders = 0;
  function Probe({ readSeq }: { readSeq: number }) {
    const result = useUnreadThreads("team1", "channel1", readSeq, true);
    renders++;
    seen = result;
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Probe readSeq={100} />));
  act(() => root.render(<Probe readSeq={100} />));
  // Re-rendering asks with the very same object, so Convex keeps its subscription.
  expect(asked.at(-1)).toBe(asked.at(-2));
  expect(renders).toBeLessThan(5);
  expect(seen!.threads).toHaveLength(10);
  expect(seen!.complete).toBe(false);
  expect(seen!.next).toBe("104");
  // The next page: all thirteen, topic 1 (the oldest reply) among them, and nothing left.
  act(() => seen!.loadMore());
  expect(Object.values(asked.at(-1)!).map((r) => r.args.cursor)).toEqual([null, "104"]);
  expect(seen!.threads.map((t) => t.message.messageId)).toContain("t1");
  expect(seen!.threads).toHaveLength(13);
  expect(seen!.complete).toBe(true);
  // A moved read point starts over from the first page.
  act(() => root.render(<Probe readSeq={105} />));
  expect(Object.values(asked.at(-1)!).map((r) => r.args.cursor)).toEqual([null]);
});

test("the strip loads the next page itself once every thread listed has been offered", () => {
  let seen: ReturnType<typeof useUnreadThreads> | null = null;
  function Strip() {
    const result = useUnreadThreads("team1", "channel1", 100, true);
    seen = result;
    // As ChannelView does when no listed thread is still waiting.
    const { loadMore, next } = result;
    useEffect(() => {
      if (next !== null) loadMore();
    }, [next, loadMore]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Strip />));
  expect(seen!.threads).toHaveLength(13);
  expect(seen!.complete).toBe(true);
});
