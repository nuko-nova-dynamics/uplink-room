import { useEffect, useRef } from "react";
import { api, type Id } from "../lib/api";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import {
  bannerAction,
  bannerRequest,
  changes,
  liveKeys,
  snapshot,
  type Snapshot,
} from "../lib/signals";
import { playCue } from "../lib/sound";
import { useAddressedNotices } from "../lib/addressedFeed";
import type { NotifyChoice, NotifyRequest } from "../../main/notifySpec";
import type { Nav } from "../Shell";
import { track } from "../lib/analytics";

type Desktop = {
  notify?: (request: NotifyRequest, session: string) => Promise<void>;
  dismissNotification?: (id: string) => Promise<void>;
  reconcileNotifications?: (session: string, live: string[]) => Promise<void>;
  endNotificationSession?: (session: string) => Promise<void>;
  onNotification?: (
    listener: (answer: { choice: NotifyChoice; request: NotifyRequest; session: string }) => void,
  ) => () => void;
};
const desktop = (window as unknown as { uplink?: Desktop }).uplink;

/**
 * Watches the Room for the events that make a sound or a banner (DESIGN.md,
 * Sound and Notifications): something new needs you, the wheel becomes yours,
 * and the Inbox reaches zero. Settling plays its own cue where it happens (the
 * Inbox). Renders nothing.
 *
 * Each mount is one session: one person in one team (Shell keys it by team).
 * Its first snapshot tells main what is live, so banners a reloaded page left
 * behind go away, and unmounting (sign-out, another team) takes its banners
 * with it.
 */
export function Signals({
  nav,
  notifications,
  sounds,
  openChannelId,
}: {
  nav: Nav;
  notifications: boolean;
  sounds: boolean;
  /** The channel open in the app: messages there don't interrupt while the window has focus. */
  openChannelId: string | null;
}) {
  const session = useSession();
  const me = session.me.memberId;
  const inbox = useRoomQuery(api.inbox.get, {});
  const terminals = useRoomQuery(api.terminals.list, {});
  const answer = useAct(api.inbox.answer);
  const last = useRef<Snapshot | null>(null);
  const id = useRef(crypto.randomUUID()).current;

  useEffect(() => {
    if (!inbox || !terminals) return;
    const next = snapshot(inbox, terminals, me);
    const first = last.current === null;
    const found = changes(last.current, next, me);
    last.current = next;
    if (first) void desktop?.reconcileNotifications?.(id, liveKeys(next, me));
    for (const cue of found.cues) playCue(cue);
    for (const key of found.dismiss) void desktop?.dismissNotification?.(key);
    if (!notifications) return;
    for (const banner of found.banners) void desktop?.notify?.(bannerRequest(banner), id);
  }, [inbox, terminals, me, notifications, id]);

  useEffect(() => () => void desktop?.endNotificationSession?.(id), [id]);

  // Messages addressed to you (spec #63): direct messages, mentions, @everyone, replies, and
  // channels set to all, in the order they reached you (useAddressedNotices).
  const bannersByChannel = useRef(new Map<string, string[]>());
  const watch = useRef({ openChannelId, notifications, sounds });
  watch.current = { openChannelId, notifications, sounds };
  useAddressedNotices(
    () => ({ ...watch.current, banners: watch.current.notifications, focused: document.hasFocus() }),
    (found) => {
      if (found.cue) playCue("message");
      for (const banner of found.banners) {
        if (banner.kind !== "message") continue;
        const keys = bannersByChannel.current.get(banner.channelId) ?? [];
        bannersByChannel.current.set(banner.channelId, [...keys, banner.id]);
        void desktop?.notify?.(banner, id);
      }
    },
  );
  // Opening a channel takes its message banners away.
  useEffect(() => {
    if (!openChannelId) return;
    for (const key of bannersByChannel.current.get(openChannelId) ?? []) void desktop?.dismissNotification?.(key);
    bannersByChannel.current.delete(openChannelId);
  }, [openChannelId]);

  // A banner was clicked, or its Allow or Open button. Main hands back the request the banner
  // showed and the session it belongs to; only that session acts on it, and Allow answers only
  // while that approval is still the one waiting.
  useEffect(
    () =>
      desktop?.onNotification?.(({ choice, request, session: from }) => {
        const action = bannerAction(choice, request, last.current, from, id);
        if (action.kind === "ignore") return;
        if (action.kind === "openTerminal") {
          nav.openTerminal(action.terminalId as Id<"terminals">);
        } else if (action.kind === "openMessage") {
          nav.go({ name: "channel", channelId: action.channelId as Id<"channels">, messageId: action.messageId as Id<"messages"> });
        } else if (action.kind === "answer") {
          // Names the approval the banner showed, so it can't land on a newer one.
          void answer({
            runId: action.runId as Id<"runs">,
            answer: "allow",
            promptId: action.promptId,
          }).then((done) => {
            if (done !== undefined) track("approval_answered", { answer: "allow", from: "notification" });
          });
        } else {
          nav.go({ name: "inbox" });
          nav.openRun({
            taskId: action.taskId as Id<"tasks"> | undefined,
            terminalId: action.terminalId as Id<"terminals"> | undefined,
          });
        }
      }),
    [nav, answer, id],
  );

  return null;
}
