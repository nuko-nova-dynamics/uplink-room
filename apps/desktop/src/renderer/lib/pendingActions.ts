/**
 * Settle and Snooze from the Inbox wait a few seconds before they're sent, so Undo on the toast can
 * take them back (the room has no unsettle). The queue lives here, outside any view: leaving the
 * Inbox keeps the wait and its Undo, and nothing is sent early. Each entry is also saved with its
 * deadline, because a closed window runs no cleanup: the next start sends what was due
 * (`replay`), so an action is never dropped.
 */

export const UNDO_MS = 6000;
const KEY = "uplink-room.pending-inbox-actions";

export type PendingAction = {
  /** The Inbox row: its task, or its run when it has no task. */
  id: string;
  teamId: string;
  kind: "settle" | "snooze";
  args: { taskId?: string; runId?: string; until?: number };
  /** When it's sent unless undone. */
  deadline: number;
  /** The row's `changedAt` when it was queued. A row that changes before the deadline is no
   * longer the row you settled, so the action is cancelled and the change shows instead. */
  changedAt: number;
};

type Commit = (action: PendingAction) => Promise<unknown>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
};

export function createPendingQueue(
  storage: Storage | undefined,
  timers: Timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  },
) {
  const live = new Map<string, { action: PendingAction; timer: unknown; sending: boolean }>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlySet<string> = new Set();

  const saved = (): PendingAction[] => {
    try {
      const parsed = JSON.parse(storage?.getItem(KEY) ?? "[]") as unknown;
      return Array.isArray(parsed) ? (parsed as PendingAction[]) : [];
    } catch {
      return [];
    }
  };
  const save = (all: PendingAction[]) => {
    try {
      storage?.setItem(KEY, JSON.stringify(all));
    } catch {
      // Storage full or blocked: the in-memory queue still sends on time.
    }
  };
  const forget = (id: string) => save(saved().filter((a) => a.id !== id));
  const changed = () => {
    snapshot = new Set(live.keys());
    for (const listener of listeners) listener();
  };

  function fire(id: string, commit: Commit) {
    const entry = live.get(id);
    if (!entry || entry.sending) return;
    entry.sending = true;
    // The row stays hidden until the room has it, then the saved copy goes.
    void Promise.resolve()
      .then(() => commit(entry.action))
      .catch(() => undefined)
      .finally(() => {
        live.delete(id);
        forget(id);
        changed();
      });
  }

  return {
    /** Queues an action; false if one is already pending for that row. */
    queue(action: PendingAction, commit: Commit): boolean {
      if (live.has(action.id)) return false;
      const wait = Math.max(0, action.deadline - timers.now());
      live.set(action.id, { action, sending: false, timer: timers.set(() => fire(action.id, commit), wait) });
      save([...saved().filter((a) => a.id !== action.id), action]);
      changed();
      return true;
    },
    /** Takes an action back before it's sent (Undo, or the row changed). False once it's sending. */
    cancel(id: string): boolean {
      const entry = live.get(id);
      if (!entry || entry.sending) return false;
      timers.clear(entry.timer);
      live.delete(id);
      forget(id);
      changed();
      return true;
    },
    /** The queued actions not yet sending whose row has changed since: each should be cancelled. */
    stale(rows: { id: string; changedAt: number }[]): PendingAction[] {
      const now = new Map(rows.map((r) => [r.id, r.changedAt]));
      return [...live.values()]
        .filter((e) => !e.sending && now.has(e.action.id) && now.get(e.action.id) !== e.action.changedAt)
        .map((e) => e.action);
    },
    /**
     * At startup: sends this team's saved actions that came due while the app was closed, and
     * queues again those still inside their Undo window. Returns the ones queued again, so the
     * caller can offer Undo for them.
     */
    replay(teamId: string, commit: Commit): PendingAction[] {
      const again: PendingAction[] = [];
      for (const action of saved()) {
        if (action.teamId !== teamId || live.has(action.id)) continue;
        if (action.deadline <= timers.now()) {
          live.set(action.id, { action, sending: false, timer: undefined });
          fire(action.id, commit);
        } else {
          live.set(action.id, { action, sending: false, timer: timers.set(() => fire(action.id, commit), action.deadline - timers.now()) });
          again.push(action);
        }
      }
      changed();
      return again;
    },
    /** The rows with an action pending: the Inbox hides them meanwhile. */
    ids(): ReadonlySet<string> {
      return snapshot;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function localStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The app's one queue. */
export const pendingActions = createPendingQueue(localStore());
