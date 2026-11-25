// @vitest-environment happy-dom
/**
 * The banner feed (spec #63) against a stand-in for messages.addressed that answers as the backend
 * does: the newest first without `after`; with it, oldest first after that seq, a page at a time.
 */
import { act, useMemo, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Addressed, MessageWatch } from "./messageSignals";

const store = vi.hoisted(() => ({ alerts: [] as Addressed[], version: 0, listeners: new Set<() => void>() }));

vi.mock("./session", () => ({
  useRoomQuery: (_query: unknown, args: { after?: number; limit?: number }) => {
    const version = useSyncExternalStore(
      (listener) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      () => store.version,
    );
    return useMemo(() => {
      const bySeq = [...store.alerts].sort((a, b) => a.seq - b.seq);
      if (args.after === undefined) return bySeq.reverse().slice(0, 20);
      return bySeq.filter((a) => a.seq > args.after!).slice(0, args.limit ?? 20);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version, args.after, args.limit]);
  },
}));

const { useAddressedNotices } = await import("./addressedFeed");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  store.alerts = [];
  store.version = 0;
});

const alert = (seq: number): Addressed => ({
  messageId: `m${seq}`,
  channelId: "general",
  channel: { kind: "channel", label: "#general" },
  author: { name: "Ana" },
  reason: "mention",
  preview: `item ${seq}`,
  at: seq,
  seq,
});

function arrive(...alerts: Addressed[]) {
  store.alerts.push(...alerts);
  store.version++;
  for (const listener of store.listeners) listener();
}

const away: MessageWatch = { openChannelId: null, focused: false, banners: true, sounds: true };

function Feed({ onBanners }: { onBanners: (ids: string[]) => void }) {
  useAddressedNotices(
    () => away,
    (found) => onBanners(found.banners.map((b) => b.id)),
  );
  return null;
}

test("a backlog bigger than a page, from a reconnect, gets every banner, in the order it reached you", () => {
  arrive(alert(1), alert(2), alert(3));
  const banners: string[] = [];
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Feed onBanners={(ids) => banners.push(...ids)} />));
  // What was there when the app opened shows nothing.
  expect(banners).toEqual([]);

  // 120 reach you while the connection was down, and arrive at once.
  const backlog = Array.from({ length: 120 }, (_, i) => alert(i + 4));
  act(() => arrive(...backlog));
  expect(banners).toEqual(backlog.map((a) => `message:${a.messageId}`));

  // Then one more, on its own.
  act(() => arrive(alert(124)));
  expect(banners.at(-1)).toBe("message:m124");
  expect(banners).toHaveLength(121);
});
