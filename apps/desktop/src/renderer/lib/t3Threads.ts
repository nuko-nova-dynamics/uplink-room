import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { T3ShareRequest, T3ThreadRow, T3ThreadsView } from "../../main/t3ThreadsSpec";
import { desktop } from "./desktop";

/**
 * This computer's T3 Code threads, for Settings, Machines on this computer's own machine
 * (main/t3ThreadsSpec.ts). Read from the bridge here, never from the room. The gym and the tests
 * provide their own through `T3ThreadsContext`.
 */
export type T3ThreadsApi = {
  read: () => Promise<T3ThreadsView>;
  /** Shares exactly `request.threads`; throws the bridge's refusal, worded for the person. */
  share: (request: T3ShareRequest) => Promise<T3ThreadsView>;
  /** The machine this computer is paired as, from bridge.json, for when its bridge doesn't answer. */
  pairedMachine: () => Promise<string | null>;
};

/** Null outside the desktop app, which has no bridge to ask. */
export const desktopT3Threads: T3ThreadsApi | null = desktop.t3Threads && desktop.shareT3Threads
  ? {
      read: async () => (await desktop.t3Threads!()) ?? { state: "unavailable", error: "The app didn't answer." },
      share: (request) => desktop.shareT3Threads!(request),
      pairedMachine: async () => {
        const pairing = await desktop.bridgePairing?.().catch(() => null);
        return pairing?.status === "paired" ? pairing.machineId : null;
      },
    }
  : null;

export const T3ThreadsContext = createContext<T3ThreadsApi | null>(desktopT3Threads);

/** How often the list is read again while it's shown, so threads made in T3 Code meanwhile appear. */
export const T3_REFRESH_MS = 10_000;

/**
 * The list, read when shown, every T3_REFRESH_MS while shown, and when the window comes back to the
 * front. An older read never replaces a newer one, and a save's answer replaces both.
 */
export function useT3Threads(api: T3ThreadsApi | null) {
  const [view, setView] = useState<T3ThreadsView | undefined>(undefined);
  const latest = useRef(0);
  const refresh = useCallback(() => {
    if (!api) return;
    const n = ++latest.current;
    void api.read().then(
      (next) => n === latest.current && setView(next),
      (error: unknown) => n === latest.current && setView({ state: "unavailable", error: error instanceof Error ? error.message : String(error) }),
    );
  }, [api]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, T3_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      latest.current++;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  /** A save's answer is the newest list there is. */
  const replace = useCallback((next: T3ThreadsView) => {
    latest.current++;
    setView(next);
  }, []);
  return { view, refresh, replace };
}

/** Each thread's share choice not yet saved, by id: true to share, false to stop. */
export type T3Draft = ReadonlyMap<string, boolean>;

/** Whether a thread is shared once the draft is saved. */
export const willShare = (row: { id: string; shared: boolean; fromRoom?: boolean }, draft: T3Draft) =>
  row.fromRoom ? true : (draft.get(row.id) ?? row.shared);

/** The draft less choices that match what's shared now, as after another save or a change elsewhere. */
export function pendingDraft(rows: readonly { id: string; shared: boolean; fromRoom?: boolean }[], draft: T3Draft): Map<string, boolean> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = new Map<string, boolean>();
  for (const [id, share] of draft) {
    const row = byId.get(id);
    if (row && !row.fromRoom && row.shared !== share) next.set(id, share);
  }
  return next;
}

/** The ids to save: what is shared, as the draft changes it. Room launches are left out; they're always shared. */
export function threadsToSave(view: Extract<T3ThreadsView, { threads: unknown }>, draft: T3Draft): string[] {
  const ids = view.threads.filter((row) => !row.fromRoom && willShare(row, draft)).map((row) => row.id);
  for (const row of view.missing) if (draft.get(row.id) !== false) ids.push(row.id);
  return ids;
}

/** Case-insensitive match on title, project, folder or id; every word must match. */
export function matchesThread(row: T3ThreadRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${row.title}\n${row.project}\n${row.projectRoot ?? ""}\n${row.id}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Shared first, then waiting and working before the rest, then the most recently changed. */
export function threadOrder(a: T3ThreadRow, b: T3ThreadRow): number {
  const rank = (row: T3ThreadRow) => (row.state === "waiting" ? 0 : row.state === "working" ? 1 : 2);
  return (
    Number(b.shared) - Number(a.shared) ||
    rank(a) - rank(b) ||
    (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) ||
    a.title.localeCompare(b.title)
  );
}
