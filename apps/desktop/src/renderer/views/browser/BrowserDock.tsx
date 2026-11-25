import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Id } from "../../lib/api";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { BrowserFrame, type FrameEvent } from "../../components/BrowserFrame";
import { Icon } from "../../components/Icon";
import { Tip } from "../../components/Tip";
import { Toggle } from "@ui-sdk/react/toggle";
import { BrowserPanel, type BrowserActions, type BrowserPanelData } from "./BrowserPanel";
import { track } from "../../lib/analytics";

const WATCH_EVERY_MS = 15_000;

/**
 * The channel header's browser button (DESIGN.md, "An agent's computer",
 * level 1: status). Its lamp is lit while a shared browser is live here.
 */
export function BrowserButton({
  channelId,
  open,
  onToggle,
}: {
  channelId: Id<"channels">;
  open: boolean;
  onToggle: () => void;
}) {
  const live = useRoomQuery(api.browsers.list, { channelId });
  const lit = (live ?? []).length > 0;
  const label = lit ? "Shared browser, live" : "Shared browser";
  return (
    <Tip label={label}>
      <Toggle
        className="btn browser-btn surface-btn"
        pressed={open}
        onPressedChange={onToggle}
        aria-label={label}
      >
        <span className="browser-icon">
          <Icon name="browser" />
          {lit ? <span className="lamp" aria-hidden="true" /> : null}
        </span>
        <span className="btn-label surface-label">Browser</span>
      </Toggle>
    </Tip>
  );
}

/** Level 2 and 3: the side panel next to the conversation, or the whole channel. */
export function BrowserDock({
  channelId,
  channelName,
  size,
  onToggleSize,
  onClose,
}: {
  channelId: Id<"channels">;
  channelName: string;
  size: "side" | "full";
  onToggleSize: () => void;
  onClose: () => void;
}) {
  const session = useSession();
  const settings = useRoomQuery(api.browsers.settings, {});
  const live = useRoomQuery(api.browsers.list, { channelId });
  const browser = live === undefined ? undefined : (live[0] ?? null);
  const browserId = browser?.browserId;

  // Remember the last browser here, so the panel can say why it ended.
  const [lastId, setLastId] = useState<Id<"browsers"> | null>(null);
  useEffect(() => {
    if (browserId) setLastId(browserId);
  }, [browserId]);
  const last = useRoomQuery(
    api.browsers.get,
    lastId && !browserId ? { browserId: lastId } : "skip",
  );

  const suggestions = useRoomQuery(api.browsers.suggestions, browserId ? { browserId } : "skip");
  const savedLogins = useRoomQuery(api.savedLogins.list, { channelId });
  const wheelRequests = useRoomQuery(
    api.browsers.wheelRequests,
    browserId ? { browserId } : "skip",
  );

  const act = {
    start: useAct(api.browsers.start),
    end: useAct(api.browsers.end, { success: "Browser ended" }),
    openUrl: useAct(api.browsers.openUrl),
    suggestUrl: useAct(api.browsers.suggestUrl, { success: "Suggested to whoever is in control" }),
    openSuggestion: useAct(api.browsers.openSuggestion),
    dismissSuggestion: useAct(api.browsers.dismissSuggestion),
    setAccess: useAct(api.browsers.setAccess),
    takeWheel: useAct(api.browsers.takeWheel, { success: "You have control" }),
    requestWheel: useAct(api.browsers.requestWheel, { success: "Asked for control" }),
    passWheel: useAct(api.browsers.passWheel, { success: "Handed off" }),
    answer: useAct(api.browsers.answerWheelRequest),
    join: useAct(api.browsers.join),
    watch: useAct(api.browsers.watch),
    leave: useAct(api.browsers.leave),
    setKeep: useAct(api.savedLogins.setKeep, { success: "Saved logins updated" }),
    rename: useAct(api.savedLogins.rename, { success: "Saved logins renamed" }),
    forget: useAct(api.savedLogins.forget, { success: "Saved logins forgotten" }),
  };

  // Join once the browser is live: a one-time ticket for the frame, then a heartbeat while it's open.
  const [connect, setConnect] = useState<{ embedUrl: string; ticket: string } | null>(null);
  const [connection, setConnection] = useState<BrowserPanelData["connection"]>(null);
  const isLive = browser?.status === "live";
  const join = act.join;
  const watch = act.watch;
  const leave = act.leave;
  /** Analytics: the browser this panel last opened, so a reconnect isn't counted again. */
  const opened = useRef<string | null>(null);
  const rejoin = useCallback(async () => {
    if (!browserId) return;
    setConnection(null);
    const joined = await join({ browserId });
    if (joined && typeof joined === "object") {
      setConnect({ embedUrl: joined.embedUrl, ticket: joined.ticket });
      if (opened.current !== browserId) track("shared_browser_opened");
      opened.current = browserId;
    }
  }, [browserId, join]);

  useEffect(() => {
    if (!isLive || !browserId) {
      setConnect(null);
      return;
    }
    void rejoin();
    const id = setInterval(() => void watch({ browserId }), WATCH_EVERY_MS);
    return () => {
      clearInterval(id);
      void leave({ browserId });
    };
  }, [isLive, browserId, rejoin, watch, leave]);

  const onFrame = useCallback((event: FrameEvent) => {
    if (event.type === "state")
      setConnection(event.state === "waiting" ? null : { state: event.state });
    else if (event.type === "closing") setConnection({ state: "closing", closingInMs: event.inMs });
    else if (event.type === "ended")
      setConnection({
        state: "ended",
        message:
          event.reason === "unauthorized"
            ? "The browser didn't let this window in."
            : "The browser connection closed.",
      });
    else if (event.type === "error") setConnection({ state: "error", message: event.message });
  }, []);

  const data: BrowserPanelData = {
    channelName,
    configured: settings?.configured ?? true,
    envVar: settings?.envVar ?? "HYPERBEAM_API_KEY",
    idleMinutes: settings?.idleMinutes ?? 10,
    mostOpenAccess: settings?.mostOpenAccess ?? "open",
    browser: settings === undefined ? undefined : browser,
    ended: last ?? null,
    suggestions: suggestions ?? [],
    wheelRequests: wheelRequests ?? [],
    me: session.me.memberId,
    isAdmin: session.isAdmin,
    members: session.members,
    stage: (
      <BrowserFrame
        connect={connect}
        onEvent={onFrame}
        title={`Shared browser in #${channelName}`}
      />
    ),
    connection,
    savedLogins: savedLogins ?? [],
  };

  const actions: BrowserActions = useMemo(
    () => ({
      start: (args) =>
        void act.start({ channelId, ...args }).then((done) => {
          if (done !== undefined) track("shared_browser_started");
        }),
      end: () => browserId && void act.end({ browserId }),
      openUrl: (url) => browserId && void act.openUrl({ browserId, url }),
      suggestUrl: (url) => browserId && void act.suggestUrl({ browserId, url }),
      openSuggestion: (suggestionId) => void act.openSuggestion({ suggestionId }),
      dismissSuggestion: (suggestionId) => void act.dismissSuggestion({ suggestionId }),
      setAccess: (access) => browserId && void act.setAccess({ browserId, access }),
      takeWheel: () => browserId && void act.takeWheel({ browserId }),
      requestWheel: () => browserId && void act.requestWheel({ browserId }),
      passWheel: (to) => browserId && void act.passWheel({ browserId, to }),
      answerWheelRequest: (requestId, grant) => void act.answer({ requestId, grant }),
      reconnect: () => void rejoin(),
      setKeep: (savedLoginId, keep) => void act.setKeep({ savedLoginId, keep }),
      rename: (savedLoginId, name) => void act.rename({ savedLoginId, name }),
      forget: (savedLoginId) => void act.forget({ savedLoginId }),
    }),
    // The act functions are stable per team; the browser and channel change what they act on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [browserId, channelId, rejoin],
  );

  return (
    <BrowserPanel
      data={data}
      actions={actions}
      size={size}
      onToggleSize={onToggleSize}
      onClose={onClose}
    />
  );
}
