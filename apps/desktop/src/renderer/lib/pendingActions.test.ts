import { expect, test, vi } from "vitest";
import { createPendingQueue, UNDO_MS, type PendingAction } from "./pendingActions";

/** A fake clock and storage, so a test can close the "window" and start a new queue on the same storage. */
function world() {
  let now = 0;
  const due: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  const timers = {
    set: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, cancelled: false };
      due.push(t);
      return t;
    },
    clear: (t: unknown) => void ((t as { cancelled: boolean }).cancelled = true),
    now: () => now,
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of due.filter((t) => !t.cancelled && t.at <= now)) {
      t.cancelled = true;
      t.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  /** The window closes: its timers never fire and no cleanup runs. */
  const closeWindow = () => due.forEach((t) => (t.cancelled = true));
  return { storage, timers, advance, closeWindow, now: () => now };
}

const settle = (id: string, at: number, changedAt = 100): PendingAction => ({
  id,
  teamId: "team",
  kind: "settle",
  args: { taskId: id },
  deadline: at + UNDO_MS,
  changedAt,
});

test("a Settle waits out its Undo window wherever you are, then is sent once", async () => {
  const w = world();
  const queue = createPendingQueue(w.storage, w.timers);
  const commit = vi.fn(async (_action: PendingAction) => null);
  expect(queue.queue(settle("task1", 0), commit)).toBe(true);
  expect(queue.ids().has("task1")).toBe(true);
  // Leaving the Inbox unmounts nothing here: the queue isn't a view, so the wait goes on.
  await w.advance(UNDO_MS - 1);
  expect(commit).not.toHaveBeenCalled();
  await w.advance(1);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(queue.ids().has("task1")).toBe(false);
});

test("Undo takes it back before it's sent", async () => {
  const w = world();
  const queue = createPendingQueue(w.storage, w.timers);
  const commit = vi.fn(async (_action: PendingAction) => null);
  queue.queue(settle("task1", 0), commit);
  expect(queue.cancel("task1")).toBe(true);
  await w.advance(UNDO_MS);
  expect(commit).not.toHaveBeenCalled();
});

test("a row that changes during the wait is cancelled, not settled", async () => {
  const w = world();
  const queue = createPendingQueue(w.storage, w.timers);
  const commit = vi.fn(async (_action: PendingAction) => null);
  queue.queue(settle("task1", 0, 100), commit);
  expect(queue.stale([{ id: "task1", changedAt: 100 }])).toEqual([]);
  const [stale] = queue.stale([{ id: "task1", changedAt: 250 }]);
  expect(stale?.id).toBe("task1");
  queue.cancel(stale!.id);
  await w.advance(UNDO_MS);
  expect(commit).not.toHaveBeenCalled();
});

test("a Settle queued when the window closed is sent on the next start, once its time is past", async () => {
  const w = world();
  const before = createPendingQueue(w.storage, w.timers);
  before.queue(settle("task1", 0), async () => null);
  before.queue(settle("task2", 0), async () => null);
  before.cancel("task2");
  // The window closes: no cleanup runs. The app starts again later, with a fresh queue.
  w.closeWindow();
  await w.advance(UNDO_MS + 30_000);
  const after = createPendingQueue(w.storage, w.timers);
  const commit = vi.fn(async (_action: PendingAction) => null);
  expect(after.replay("other-team", commit)).toEqual([]);
  expect(commit).not.toHaveBeenCalled();
  after.replay("team", commit);
  await w.advance(0);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0]?.[0]).toMatchObject({ id: "task1", kind: "settle" });
  // Sent once: a third start finds nothing left.
  const third = createPendingQueue(w.storage, w.timers);
  const again = vi.fn(async (_action: PendingAction) => null);
  third.replay("team", again);
  await w.advance(0);
  expect(again).not.toHaveBeenCalled();
});

test("one still inside its Undo window at start waits out the rest of it", async () => {
  const w = world();
  createPendingQueue(w.storage, w.timers).queue(settle("task1", 0), async () => null);
  w.closeWindow();
  await w.advance(2_000);
  const after = createPendingQueue(w.storage, w.timers);
  const commit = vi.fn(async (_action: PendingAction) => null);
  expect(after.replay("team", commit).map((a) => a.id)).toEqual(["task1"]);
  await w.advance(UNDO_MS - 2_000 - 1);
  expect(commit).not.toHaveBeenCalled();
  await w.advance(1);
  expect(commit).toHaveBeenCalledTimes(1);
});
