import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Banners, MAX_NATIVE_ID } from "./notifyRegistry.ts";
import { parseNotifyRequest, type NotifyRequest } from "./notifySpec.ts";
import { bannerRequest, changes, snapshot } from "../renderer/lib/signals.ts";

/** A run id from a local Convex backend, and a prompt id the way the bridge makes them. */
const RUN_ID = "kx7eca8w024tgccxkqyc6j0qex8hfcfy";
const PROMPT_ID = randomUUID();
const ME = "kh7bq8tq3cz1x9m5v2y4n6r8w0a3d5f7";

/** The request the renderer sends when that approval starts waiting on me, as the app builds it. */
function realRequest(): NotifyRequest {
  const row = {
    title: "Save slots on the title screen",
    taskId: "kn78hd0r2wq6x4fz1c9ytb3m5v7s8a2e",
    runs: [
      {
        runId: RUN_ID,
        terminalId: "k5764m0zq2ah8bdc3x7wfr9n1e6t4yjs",
        harness: "claude-code",
        state: "waiting",
        stateChangedAt: 1_793_640_000_000,
        driver: { memberId: ME, kind: "person", name: "Julio Díaz" },
        prompt: {
          kind: "approval" as const,
          text: "Claude Code wants to run pnpm test --filter save",
          action: "pnpm test --filter save",
          promptId: PROMPT_ID,
        },
      },
    ],
  };
  const before = snapshot({ needsYou: [], done: [] }, [], ME);
  const after = snapshot({ needsYou: [row], done: [] }, [], ME);
  const [banner] = changes(before, after, ME).banners;
  return parseNotifyRequest(bannerRequest(banner!))!;
}

const fake = () => ({ closed: 0, close() { this.closed++; } });

test("a banner for a real approval gets an id Windows accepts, and its button answers that approval", () => {
  const request = realRequest();
  // The renderer's key is too long to be a Windows notification id.
  expect(request.id).toBe(`${RUN_ID}:${PROMPT_ID}`);
  expect(request.id.length).toBeGreaterThan(MAX_NATIVE_ID);

  const banners = new Banners<ReturnType<typeof fake>>();
  const nativeId = banners.nextId();
  expect(nativeId.length).toBeLessThanOrEqual(MAX_NATIVE_ID);
  expect(banners.nextId()).not.toBe(nativeId);
  banners.add(nativeId, request, fake(), "s");

  const answered = banners.take(nativeId)!.request;
  expect(answered).toMatchObject({ kind: "needs", runId: RUN_ID, promptId: PROMPT_ID, canAllow: true });
  // Answered once: a second click finds nothing.
  expect(banners.take(nativeId)).toBeUndefined();
});

test("a toast that timed out stays tracked, so the app can still remove it from Notification Center", () => {
  const banners = new Banners<ReturnType<typeof fake>>();
  const wheel: NotifyRequest = {
    kind: "wheel",
    id: "wheel:k5764m0zq2ah8bdc3x7wfr9n1e6t4yjs",
    terminal: "Tile map loader",
    terminalId: "k5764m0zq2ah8bdc3x7wfr9n1e6t4yjs",
  };
  const timedOut = banners.nextId();
  const notification = fake();
  banners.add(timedOut, wheel, notification, "s");
  banners.closed(timedOut, "timedOut");
  expect(banners.size).toBe(1);
  // The wheel moved on: dismissing it hands back the toast to close, which removes it.
  banners.release(wheel.id)?.notification.close();
  expect(notification.closed).toBe(1);
  expect(banners.size).toBe(0);

  // Dismissed by the person, hidden, or closed with no reason (macOS, Linux): it's gone.
  for (const reason of ["userCanceled", "applicationHidden", undefined]) {
    const id = banners.nextId();
    banners.add(id, wheel, fake(), "s");
    banners.closed(id, reason);
    expect(banners.release(wheel.id)).toBeUndefined();
  }
});

test("showing a banner again for the same key replaces the old one, which the caller closes", () => {
  const banners = new Banners<ReturnType<typeof fake>>();
  const request = realRequest();
  const first = fake();
  const firstId = banners.nextId();
  banners.add(firstId, request, first, "s");
  const replaced = banners.add(banners.nextId(), request, fake(), "s");
  expect(replaced?.notification).toBe(first);
  // The old banner's own close event, or a late click on it, no longer touches the new one.
  banners.closed(firstId);
  expect(banners.take(firstId)).toBeUndefined();
  expect(banners.size).toBe(1);
});

test("after a reload, banners whose approval is gone are dismissed, and the rest join the new session", () => {
  const banners = new Banners<ReturnType<typeof fake>>();
  const still = realRequest();
  const gone: NotifyRequest = { ...still, id: `${RUN_ID}:${randomUUID()}` };
  const goneToast = fake();
  banners.add(banners.nextId(), still, fake(), "before-reload");
  const goneId = banners.nextId();
  banners.add(goneId, gone, goneToast, "before-reload");
  // Its toast timed out, so it is still listed in Notification Center.
  banners.closed(goneId, "timedOut");

  const dismissed = banners.reconcile("after-reload", new Set([still.id]));
  expect(dismissed.map((e) => e.request.id)).toEqual([gone.id]);
  expect(dismissed[0]!.notification).toBe(goneToast);
  // The banner still waiting now belongs to the new session: ending that one takes it away.
  expect(banners.endSession("before-reload")).toEqual([]);
  expect(banners.endSession("after-reload").map((e) => e.request.id)).toEqual([still.id]);
  expect(banners.size).toBe(0);
});

test("ending a session (sign-out, another team) dismisses that session's banners, timed-out ones too", () => {
  const banners = new Banners<ReturnType<typeof fake>>();
  const mine = realRequest();
  const timedOut = banners.nextId();
  banners.add(timedOut, mine, fake(), "team-a");
  banners.closed(timedOut, "timedOut");
  const other: NotifyRequest = { ...mine, id: `${RUN_ID}:${randomUUID()}` };
  banners.add(banners.nextId(), other, fake(), "team-b");

  expect(banners.endSession("team-a").map((e) => e.request.id)).toEqual([mine.id]);
  expect(banners.size).toBe(1);
});
