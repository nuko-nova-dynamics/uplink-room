// The replay recorder, bundled: the app loads no script from PostHog's servers (its CSP forbids
// it), so posthog-js comes from its no-external build with the one extension the app uses.
import "posthog-js/dist/posthog-recorder";
import posthogJs from "posthog-js/dist/module.no-external";
import { useCallback, useSyncExternalStore } from "react";
import {
  pageAddress,
  POSTHOG_HOST,
  scrubEvent,
  type EventName,
  type EventProps,
} from "../../main/analyticsSpec";
import { desktop } from "./desktop";

/**
 * Product analytics in the renderer (posthog-js). What is sent, and what never is, is in
 * main/analyticsSpec.ts and docs/analytics.md. In short:
 *  - Only the events in `EVENTS`, with enum, boolean or count properties. No autocapture,
 *    pageviews, heatmaps, surveys, exceptions, console logs or network timing.
 *  - The person is their member ID and the team its team ID.
 *  - Session replay masks every text node, every input and every attribute (links, image
 *    addresses, titles, labels), and blocks terminals, files, Spaces, shared browsers, frames,
 *    canvases and video outright (`.ph-no-capture`).
 *  - "Share usage data" off: posthog-js isn't started, or is opted out and stops recording.
 */

type PostHog = typeof posthogJs;
type Config = NonNullable<Parameters<PostHog["init"]>[1]>;

/** Add to an element to keep it, and everything inside it, out of session replay entirely. */
export const NO_CAPTURE = "ph-no-capture";

/**
 * Replay blocks these whole (a box of the same size in the recording): anything marked
 * `ph-no-capture`, every frame (posted HTML, PDFs, Spaces, shared browsers), every canvas
 * (Excalidraw, terminals drawn with WebGL) and every video (calls, screen shares).
 */
export const REPLAY_BLOCK = `.${NO_CAPTURE}, iframe, canvas, video, .xterm`;

/** Attributes replay keeps as they are: they lay the page out and carry no content. */
const LAYOUT_ATTRIBUTES = new Set([
  "class",
  "role",
  "type",
  "tabindex",
  "disabled",
  "hidden",
  "aria-hidden",
  "aria-pressed",
  "aria-current",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "width",
  "height",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "rx",
  "ry",
  "points",
  "xmlns",
]);

/** Replay's attribute rule: layout attributes stay, a style stays unless it names a URL, the rest is emptied. */
export function maskAttribute(name: string, value: string): string {
  if (LAYOUT_ATTRIBUTES.has(name)) return value;
  if (name === "style" && !/url\s*\(/i.test(value)) return value;
  return "";
}

/** Replay's text rule: every character becomes `*`, keeping only the whitespace (and so the layout). */
export function maskText(text: string): string {
  return text.replace(/\S/g, "*");
}

export function posthogConfig(options: {
  /**
   * The anonymous ID to start from, given only when posthog-js doesn't have it yet (`startIdentity`).
   * A bootstrap ID replaces whatever ID posthog-js kept, so passing one on every launch would bring
   * back an ID that a reset had already moved away from.
   */
  bootstrapId?: string | undefined;
  enabled: boolean;
  /** Checked on every event: false drops it, whatever posthog-js thinks. */
  sending: () => boolean;
}): Config {
  return {
    api_host: POSTHOG_HOST,
    defaults: "2026-08-30",
    // Both processes start from the same anonymous ID, until a team opens and it becomes the member ID.
    ...(options.bootstrapId ? { bootstrap: { distinctID: options.bootstrapId } } : {}),
    person_profiles: "identified_only",
    persistence: "localStorage",
    opt_out_capturing_by_default: !options.enabled,
    // Nothing is captured on its own: only the app's own events.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    rageclick: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_scroll_properties: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    save_referrer: false,
    save_campaign_params: false,
    // No surveys, tours, chat, experiments, flags or remote scripts.
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_feature_flags: true,
    enable_recording_console_log: false,
    logs: { captureConsoleLogs: false },
    // Each event goes out on its own, so turning sharing off leaves nothing waiting in a batch.
    request_batching: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: maskText,
      maskAttributeFn: maskAttribute,
      blockClass: NO_CAPTURE,
      blockSelector: REPLAY_BLOCK,
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      captureJsonLd: false,
      collectFonts: false,
      // The page address shows in the replay; the sign-in flow keeps state in its query and hash.
      maskCapturedNetworkRequestFn: (request) => {
        if (request.name) request.name = pageAddress(request.name);
        return request;
      },
    },
    before_send: (event) => (event && options.sending() ? scrubEvent(event) : null),
  };
}

export type TrackOptions = {
  /** The page is about to reload (signing out): send with a beacon, which outlives the page. */
  beforeReload?: boolean;
};

type Desktop = Pick<typeof desktop, "analyticsState" | "setAnalyticsEnabled" | "analyticsIdentify">;

/**
 * What the renderer remembers between launches (localStorage): the anonymous ID posthog-js was
 * last given, and the member it last identified.
 */
const IDENTITY_KEY = "uplink.analytics.identity";
type Remembered = { anonymous: string | null; member: string | null };

function recall(): Remembered {
  try {
    const parsed = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "null") as Partial<Remembered> | null;
    return { anonymous: parsed?.anonymous ?? null, member: parsed?.member ?? null };
  } catch {
    return { anonymous: null, member: null };
  }
}

function remember(value: Remembered): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable: the next launch starts posthog-js from main's ID again.
  }
}

/**
 * The bootstrap ID for this launch: main's anonymous ID, unless posthog-js already has it (and
 * kept, since then, either that ID or the member it was merged into).
 */
export function startIdentity(remembered: Remembered, deviceId: string): string | undefined {
  return remembered.anonymous === deviceId ? undefined : deviceId;
}

/** posthog-js's retry queue (1.444.0, retry-queue.ts): the one place a request waits to go out again. */
type RetryQueue = {
  _queue: unknown[];
  _enqueue: (...args: unknown[]) => void;
  retriableRequest: (...args: unknown[]) => void;
};

function retryQueue(posthog: PostHog): RetryQueue | undefined {
  const queue = (posthog as unknown as { _retryQueue?: RetryQueue })._retryQueue;
  return queue && Array.isArray(queue._queue) && typeof queue._enqueue === "function" ? queue : undefined;
}

/**
 * posthog-js resends a failed request from its retry queue without running `before_send` again,
 * and opting out doesn't empty that queue. While sharing is off, the queue takes nothing new and
 * sends nothing, so a request that fails around the moment sharing is turned off never goes out.
 * (Main also cancels every request to PostHog while sharing is off: main/index.ts.)
 */
function guardRetries(posthog: PostHog, sending: () => boolean): void {
  const queue = retryQueue(posthog);
  if (!queue) return;
  const enqueue = queue._enqueue.bind(queue);
  const send = queue.retriableRequest.bind(queue);
  queue._enqueue = (...args) => {
    if (sending()) enqueue(...args);
  };
  queue.retriableRequest = (...args) => {
    if (sending()) send(...args);
  };
}

function dropRetries(posthog: PostHog): void {
  const queue = retryQueue(posthog);
  if (queue) queue._queue = [];
}

export type Analytics = ReturnType<typeof createAnalytics>;

/**
 * The analytics client. Without a project key (development and test builds) or the desktop
 * bridge, every call does nothing.
 */
export function createAnalytics(deps: { posthog: PostHog; key: string | undefined; desktop: Desktop }) {
  const { posthog, key } = deps;
  let enabled = true;
  let started = false;
  let ready = false;
  /** The current anonymous ID, shared with main. */
  let deviceId = "";
  let identity: { memberId: string; teamId: string } | null = null;
  /** The member posthog-js last identified, kept across launches, so another member starts a new person. */
  let identified: string | null = null;
  /** A sign-out that came before main's state did; applied once it arrives. */
  let resetPending = false;
  /** Events tracked before the setting was read from main. */
  const early: [EventName, Record<string, unknown>, TrackOptions][] = [];
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());
  const sending = () => enabled;

  function startPostHog(): void {
    if (started || !key) return;
    started = true;
    const remembered = recall();
    posthog.init(key, posthogConfig({ bootstrapId: startIdentity(remembered, deviceId), enabled, sending }));
    remember({ ...remembered, anonymous: deviceId });
    guardRetries(posthog, sending);
    // posthog-js keeps its own opt-out from an earlier launch; this setting is the one that counts.
    if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
    if (identity) applyIdentity(identity);
  }

  /**
   * A new person on this computer (sign-out, or another team's member): move both processes to a
   * new anonymous ID, so nothing sent before the next identify lands on the member the old ID was
   * merged into.
   */
  function rotate(): void {
    deviceId = crypto.randomUUID();
    identified = null;
    if (!started) {
      // posthog-js isn't running: it takes the new ID as its bootstrap when it starts.
      remember({ ...recall(), member: null });
      return;
    }
    posthog.reset({ bootstrap: { distinctID: deviceId } });
    remember({ anonymous: deviceId, member: null });
    // reset() also forgets posthog-js's opt-out, so put it back while sharing is off.
    if (!enabled) stopSending();
  }

  function applyIdentity(next: { memberId: string; teamId: string }): void {
    identified = next.memberId;
    remember({ ...recall(), member: next.memberId });
    posthog.identify(next.memberId);
    posthog.register({ team_id: next.teamId });
  }

  function stopSending(): void {
    posthog.stopSessionRecording();
    posthog.opt_out_capturing();
    dropRetries(posthog);
  }

  return {
    /** Reads "Share usage data" from main, starts posthog-js if it's on, and sends what waited. */
    async start(): Promise<void> {
      if (ready) return;
      const state = key ? await deps.desktop.analyticsState?.().catch(() => null) : null;
      ready = true;
      if (!state) {
        early.length = 0;
        return;
      }
      enabled = state.enabled;
      deviceId = state.deviceId;
      identified = recall().member;
      // Signed out before the state arrived, and no team opened since: a new person, as in reset().
      if (resetPending && !identity) {
        rotate();
        void deps.desktop.analyticsIdentify?.(null, deviceId).catch(() => undefined);
      }
      resetPending = false;
      // A team opened before the setting arrived, as a different member than last time.
      if (identity && identified && identified !== identity.memberId) {
        rotate();
        void deps.desktop.analyticsIdentify?.(identity, deviceId).catch(() => undefined);
      }
      notify();
      if (enabled) startPostHog();
      for (const [event, properties, options] of early.splice(0)) this.track(event, properties as never, options);
    },

    track<E extends EventName>(event: E, properties: EventProps<E> = {}, options: TrackOptions = {}): void {
      if (!ready) {
        if (early.length < 50) early.push([event, properties, options]);
        return;
      }
      if (!enabled || !started) return;
      posthog.capture(event, properties, options.beforeReload ? { transport: "sendBeacon" } : undefined);
    },

    /** A team opened: the person is now this member. */
    identify(next: { memberId: string; teamId: string }): void {
      if (identity?.memberId === next.memberId && identity.teamId === next.teamId) return;
      const previous = identity?.memberId ?? identified;
      identity = next;
      if (ready && previous && previous !== next.memberId) rotate();
      void deps.desktop.analyticsIdentify?.(next, deviceId).catch(() => undefined);
      if (started) applyIdentity(next);
    },

    /** Signed out: forget the member, so the next person on this computer starts anonymous. */
    reset(): void {
      identity = null;
      if (!ready) {
        // Without main's state there's no ID to rotate from yet: start() does it.
        resetPending = true;
        return;
      }
      rotate();
      void deps.desktop.analyticsIdentify?.(null, deviceId).catch(() => undefined);
    },

    get enabled(): boolean {
      return enabled;
    },

    /** Whether there's anything to turn on or off: a release build in the desktop app. */
    get available(): boolean {
      return Boolean(key && deps.desktop.analyticsState);
    },

    async setEnabled(next: boolean): Promise<void> {
      enabled = next;
      notify();
      await deps.desktop.setAnalyticsEnabled?.(next).catch(() => undefined);
      if (!next) {
        if (started) stopSending();
        return;
      }
      if (!started) {
        if (ready && deviceId) startPostHog();
        return;
      }
      posthog.opt_in_capturing();
      // An identify made while sharing was off may not have reached posthog-js.
      if (identity) applyIdentity(identity);
      // stopSessionRecording() set disable_session_recording, which opting in doesn't clear. With no
      // override, this clears only that flag: the project's own replay setting and sampling still decide.
      try {
        posthog.startSessionRecording();
      } catch {
        // A recorder that can't start must not stop events from resuming.
      }
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const analytics = createAnalytics({
  posthog: posthogJs,
  key: import.meta.env["VITE_POSTHOG_KEY"] as string | undefined,
  desktop,
});

/** Shorthand for `analytics.track`. */
export function track<E extends EventName>(event: E, properties?: EventProps<E>, options?: TrackOptions): void {
  analytics.track(event, properties, options);
}

/** The "Share usage data" setting, live: `[on, set, available]`. */
export function useUsageData(): [boolean, (on: boolean) => void, boolean] {
  const on = useSyncExternalStore(analytics.subscribe, () => analytics.enabled);
  const set = useCallback((value: boolean) => void analytics.setEnabled(value), []);
  return [on, set, analytics.available];
}
