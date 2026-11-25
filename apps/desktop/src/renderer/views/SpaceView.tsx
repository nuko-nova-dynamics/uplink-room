import { useEffect, useRef, useState } from "react";
import { Input } from "@ui-sdk/react/input";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { log } from "../lib/log";
import type { FunctionReturnType } from "convex/server";
import { api, type Access, type Id, type MemberRow } from "../lib/api";
import { ACCESS_META, accessRank, formatTime } from "../lib/format";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { MemberFace } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Tip } from "../components/Tip";
import {
  AccessControl,
  DriverPill,
  RailClose,
  RailToggle,
  Watching,
  useRail,
} from "../components/WorkHead";
import type { Nav } from "../Shell";
import "./space.css";
import "./work.css";
import { NO_CAPTURE } from "../lib/analytics";

/**
 * A Space (spec #6): a Cua desktop on a machine, shown through the bridge's Space gateway. It
 * follows the terminals' rules, so it reuses the terminal view's layout: header, access bar,
 * the screen, and a side panel for the wheel, suggestions and who did what.
 */

type Space = FunctionReturnType<typeof api.spaces.get>;
type WheelRequest = FunctionReturnType<typeof api.spaces.wheelRequests>[number];
type Suggestion = FunctionReturnType<typeof api.spaces.suggestions>[number];
type SpaceActionRow = FunctionReturnType<typeof api.spaces.actions>[number];

const WATCH_EVERY_MS = 15_000;
const OS_LABEL: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

/** What the screen area shows. */
export type Stage =
  | { kind: "opening"; note?: string }
  | { kind: "ready"; frameUrl: string; interactive: boolean }
  | { kind: "unreachable"; machine: string }
  | { kind: "failed"; reason: string }
  | { kind: "ended" }
  | { kind: "stopped"; power: string; machine: string };

type Uplink = {
  openSpaceView(urls: string[]): Promise<string>;
  closeSpaceView(url: string): Promise<void>;
};
const desktop = (window as unknown as { uplink?: Uplink }).uplink;

const FAIL_TEXT: Record<string, string> = {
  space_not_shared: "the bridge isn't sharing this Space any more",
  sharing_stopped: "sharing is stopped on its machine",
  unreachable: "Cua can't reach the Space on its machine",
  cua_failed: "Cua didn't answer on its machine",
  wheel_moved: "control moved while it opened",
};

export function SpaceView({ spaceId, nav }: { spaceId: Id<"spaces">; nav: Nav }) {
  const session = useSession();
  const me = session.me.memberId;
  const space = useRoomQuery(api.spaces.get, { spaceId });
  const view = useRoomQuery(api.spaces.myView, { spaceId });
  const machines = useRoomQuery(api.machines.list, {});
  const wheelRequests = useRoomQuery(api.spaces.wheelRequests, { spaceId });
  const suggestions = useRoomQuery(api.spaces.suggestions, { spaceId });
  const actions = useRoomQuery(api.spaces.actions, { spaceId });

  const openView = useAct(api.spaces.openView);
  const watch = useAct(api.spaces.watch);
  const closeView = useAct(api.spaces.closeView);
  const setAccess = useAct(api.spaces.setAccess);
  const takeWheel = useAct(api.spaces.takeWheel, { success: "You have control" });
  const requestWheel = useAct(api.spaces.requestWheel, { success: "Asked for control" });
  const passWheel = useAct(api.spaces.passWheel, { success: "Handed off" });
  const answerWheel = useAct(api.spaces.answerWheelRequest);
  const suggest = useAct(api.spaces.suggest, { success: "Suggested" });
  const answerSuggestion = useAct(api.spaces.answerSuggestion);
  const stopSharing = useAct(api.spaces.stopSharing, { success: "Stopped sharing the Space" });

  const live = space?.status === "live" || space?.status === "starting";
  const running = space?.power === "running";
  const isDriver = space?.driver?.memberId === me;

  // Open a view when the Space is live, and again when the wheel moves (the room closes a view
  // whose input no longer matches). The heartbeat keeps it open; leaving closes it.
  const needsView =
    live &&
    running &&
    space?.status === "live" &&
    (!view ||
      view.status === "closed" ||
      (view.status !== "failed" && view.interactive !== isDriver));
  useEffect(() => {
    if (needsView) void openView({ spaceId });
  }, [needsView, isDriver, openView, spaceId]);
  useEffect(() => {
    const id = setInterval(() => void watch({ spaceId }), WATCH_EVERY_MS);
    return () => {
      clearInterval(id);
      void closeView({ spaceId });
    };
  }, [spaceId, watch, closeView]);

  // Forward the ready view to a loopback port (see main/spaceForward.ts).
  const urls = view?.status === "ready" ? view.urls : [];
  const urlsKey = urls.join(" ");
  const [frame, setFrame] = useState<{ key: string; url?: string; error?: string }>({ key: "" });
  // "Try again" bumps this, so the forward is attempted again even when the view's links are the same.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!urlsKey || !desktop) return;
    let cancelled = false;
    let opened: string | undefined;
    desktop
      .openSpaceView(urlsKey.split(" "))
      .then((url) => {
        opened = url;
        log.info("space", "view open", { addresses: urlsKey.split(" ").length });
        if (cancelled) void desktop.closeSpaceView(url);
        else setFrame({ key: urlsKey, url });
      })
      .catch(() => {
        log.warn("space", "view unreachable", { addresses: urlsKey.split(" ").length });
        if (!cancelled) setFrame({ key: urlsKey, error: "unreachable" });
      });
    return () => {
      cancelled = true;
      if (opened) void desktop.closeSpaceView(opened);
    };
  }, [urlsKey, attempt]);

  const machineName = space?.machine?.name ?? "its machine";
  const stage: Stage = !space
    ? { kind: "opening" }
    : !live
      ? { kind: "ended" }
      : !running
        ? { kind: "stopped", power: space.power, machine: machineName }
        : view?.status === "failed"
          ? {
              kind: "failed",
              reason: FAIL_TEXT[view.failReason ?? ""] ?? view.failReason ?? "unknown",
            }
          : frame.key === urlsKey && frame.error
            ? { kind: "unreachable", machine: machineName }
            : frame.key === urlsKey && frame.url
              ? { kind: "ready", frameUrl: frame.url, interactive: view!.interactive }
              : {
                  kind: "opening",
                  ...(view?.closedReason === "wheel_moved"
                    ? { note: "Control moved. Reopening the Space…" }
                    : {}),
                  ...(urlsKey && !desktop ? { note: "Spaces open only in the desktop app." } : {}),
                };

  const machine = machines?.find((m) => m.machineId === space?.machine?.machineId);
  const ownsMachine =
    machine?.belongsTo.kind === "person"
      ? machine.belongsTo.member.memberId === me
      : session.isAdmin;

  if (!space) return <div className="empty">Loading the Space…</div>;
  return (
    <SpaceScreen
      space={space}
      me={me}
      members={session.members}
      ownsMachine={Boolean(ownsMachine)}
      machineOffline={machine ? !machine.online : false}
      stage={stage}
      wheelRequests={wheelRequests ?? []}
      suggestions={suggestions ?? []}
      actions={actions ?? []}
      on={{
        back: () => nav.go({ name: "inbox" }),
        retry: () => {
          setFrame({ key: "" });
          setAttempt((n) => n + 1);
          void openView({ spaceId });
        },
        setAccess: (access) => void setAccess({ spaceId, access }),
        takeWheel: () => void takeWheel({ spaceId }),
        requestWheel: () => void requestWheel({ spaceId }),
        passWheel: (to) => void passWheel({ spaceId, to }),
        answerWheel: (requestId, grant) => void answerWheel({ requestId, grant }),
        suggest: async (text) => (await suggest({ spaceId, text })) !== undefined,
        answerSuggestion: (suggestionId, done) => void answerSuggestion({ suggestionId, done }),
        stopSharing: () => void stopSharing({ spaceId }),
      }}
    />
  );
}

export type SpaceScreenProps = {
  space: Space;
  me: Id<"members">;
  members: MemberRow[];
  ownsMachine: boolean;
  /** Its machine's bridge is offline, so the Space can't be reached or controlled. */
  machineOffline?: boolean;
  stage: Stage;
  wheelRequests: WheelRequest[];
  suggestions: Suggestion[];
  actions: SpaceActionRow[];
  on: {
    back(): void;
    retry(): void;
    setAccess(access: Access): void;
    takeWheel(): void;
    requestWheel(): void;
    passWheel(to: Id<"members">): void;
    answerWheel(requestId: Id<"spaceWheelRequests">, grant: boolean): void;
    suggest(text: string): Promise<boolean>;
    answerSuggestion(suggestionId: Id<"spaceSuggestions">, done: boolean): void;
    stopSharing(): void;
  };
};

/** The Space screen without data fetching, so the harness can render it with sample data. */
export function SpaceScreen({
  space,
  me,
  members,
  ownsMachine,
  machineOffline = false,
  stage,
  wheelRequests,
  suggestions,
  actions,
  on,
}: SpaceScreenProps) {
  const live = space.status === "live" || space.status === "starting";
  const isDriver = space.driver?.memberId === me;
  const isSharer = space.sharedBy.memberId === me;
  const asked = wheelRequests.some((r) => r.from.memberId === me);
  const passTo = members.filter(
    (m) =>
      m.memberId !== me &&
      (accessRank(space.access) >= accessRank("drive") || m.memberId === space.sharedBy.memberId),
  );
  const asksMe = isDriver ? wheelRequests.length : 0;
  // The screen comes first: the panel opens on its own only while something waits there.
  const rail = useRail(live && suggestions.length + asksMe > 0);

  return (
    <div className={`terminal-layout space-layout ${NO_CAPTURE} ${rail.open ? "" : "rail-closed"}`}>
      <div className="terminal-main">
        <header className="main-head work-head">
          <Tip label="Back">
            <button className="btn icon" type="button" aria-label="Back" onClick={on.back}>
              <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
            </button>
          </Tip>
          <h1 title={space.name}>
            <Icon className="head-glyph" name="machine" />
            <span className="space-title-name">{space.name}</span>
          </h1>
          <span className="grow" />
          <DriverPill
            driver={space.driver}
            me={me}
            members={members}
            ended={live ? undefined : space.status === "failed" ? "didnt_start" : "ended"}
          />
          {live && !isDriver && !machineOffline ? (
            space.access === "open" || (isSharer && space.access !== "drive") ? (
              <button className="btn" type="button" onClick={on.takeWheel}>
                <Icon name="wheel" /> Take control
              </button>
            ) : space.access === "drive" ? (
              <button className="btn" type="button" disabled={asked} onClick={on.requestWheel}>
                <Icon name="wheel" /> {asked ? "Asked for control" : "Ask for control"}
              </button>
            ) : null
          ) : null}
          {live && isDriver && !machineOffline ? (
            <PassWheel members={members} candidates={passTo} onPass={on.passWheel} />
          ) : null}
          {/* With the panel folded, stopping the share stays one click away in the title row. */}
          {live && !rail.open && (isSharer || ownsMachine) ? (
            <button className="btn" type="button" onClick={on.stopSharing}>
              <Icon name="stop" /> Stop sharing
            </button>
          ) : null}
          <RailToggle
            open={rail.open}
            onToggle={rail.toggle}
            waiting={suggestions.length + asksMe}
            urgent={asksMe > 0}
          />
        </header>

        <div className="terminal-bar">
          <AccessControl
            access={space.access}
            loweredFrom={space.loweredFrom}
            mostOpen={space.machine?.mostOpenAccess}
            machineName={space.machine?.name}
            canOpenUp={isSharer && !machineOffline}
            canLower={ownsMachine && !machineOffline}
            live={live}
            onSet={on.setAccess}
            starterLabel="whoever shared this Space"
            surface="space"
            oneRow
            driver={isDriver ? { me: true } : { me: false, name: space.driver?.name }}
          />
          {isSharer &&
          !machineOffline &&
          space.machine?.mostOpenAccess &&
          space.machine.mostOpenAccess !== "open" ? (
            <span className="hint access-cap space-access-cap">
              <span className="mono">{space.machine.name}</span> allows up to{" "}
              {ACCESS_META[space.machine.mostOpenAccess].label}.
            </span>
          ) : null}
          <span className="grow" />
          <span className="muted where">
            {space.os ? (OS_LABEL[space.os] ?? space.os) : "Space"}
            {space.machine ? (
              <>
                {" on "}
                <span className="mono">{space.machine.name}</span>
              </>
            ) : null}
          </span>
          {/* The access control's line and who is watching go on the bar's second row. */}
          <span className="bar-break" aria-hidden="true" />
          {live ? (
            <Watching
              watching={space.watching}
              me={me}
              driverId={space.driver?.memberId}
              members={members}
            />
          ) : null}
        </div>

        {live && machineOffline ? (
          <div className="note space-offline">
            <span className="mono">{space.machine?.name ?? "Its machine"}</span> is offline, so this
            Space can't be reached or controlled until its bridge is back.
          </div>
        ) : null}
        <SpaceStage stage={stage} space={space} isDriver={isDriver} onRetry={on.retry} />
      </div>

      <aside className="terminal-side" aria-label="Space controls" hidden={!rail.open}>
        <RailClose onClose={rail.toggle} />
        {isDriver && wheelRequests.length > 0 ? (
          <div className="side-block">
            <h2>Asking for control</h2>
            {wheelRequests.map((request) => (
              <div key={request.requestId} className="sugg">
                <div className="row-flex">
                  <MemberFace member={request.from} members={members} size={20} />
                  <span className="grow">{request.from.name} wants control</span>
                </div>
                <div className="row-flex">
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => on.answerWheel(request.requestId, true)}
                  >
                    Hand it over
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => on.answerWheel(request.requestId, false)}
                  >
                    Not now
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="side-block">
          <h2>Suggestions</h2>
          {suggestions.length === 0 ? <span className="muted">None waiting.</span> : null}
          {suggestions.map((s) => (
            <div key={s.suggestionId} className="sugg">
              <div className="row-flex">
                <MemberFace member={s.from} members={members} size={18} />
                <span className="muted">{s.from.name} suggests</span>
              </div>
              <span>{s.text}</span>
              {isDriver ? (
                <div className="row-flex">
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => on.answerSuggestion(s.suggestionId, true)}
                  >
                    Done
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => on.answerSuggestion(s.suggestionId, false)}
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {live && !isDriver ? <SuggestForm access={space.access} onSuggest={on.suggest} /> : null}

        <div className="side-block">
          <h2>Who did what</h2>
          {actions.length === 0 ? <span className="muted">No Space actions yet.</span> : null}
          {actions.slice(0, 12).map((a) => (
            <div key={a.actionId} className="log-line" title={formatTime(a.at)}>
              <b style={{ fontWeight: 500, color: "var(--text)" }}>{a.by.name}</b>
              <span>
                {describeAction(a.action)}
                {a.status === "failed" ? (
                  <span className="space-failed">, not done: {failText(a.error)}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>

        <div className="side-block">
          <h2>This Space</h2>
          <div className="row-flex">
            <MemberFace member={space.sharedBy} members={members} size={18} />
            <span>Shared by {isSharer ? "you" : space.sharedBy.name}</span>
          </div>
          <span className="muted space-ref">{space.spaceRef}</span>
          {live && (isSharer || ownsMachine) ? (
            <button className="btn" type="button" onClick={on.stopSharing}>
              <Icon name="stop" /> Stop sharing
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function SpaceStage({
  stage,
  space,
  isDriver,
  onRetry,
}: {
  stage: Stage;
  space: Space;
  isDriver: boolean;
  onRetry(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const interactive = stage.kind === "ready" && stage.interactive;
  const badge = isDriver
    ? "Input on"
    : `Watching${space.driver ? `: ${space.driver.name} is in control` : ""}`;
  return (
    <div
      className={`space-stage ${stage.kind === "ready" ? "" : "idle"}`}
      data-testid="space-stage"
      role="group"
      aria-label={
        interactive ? "Space screen. Press Enter to use the remote desktop." : "Space screen"
      }
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(event) => {
        if (interactive && event.target === event.currentTarget && event.key === "Enter") {
          event.preventDefault();
          frame.current?.focus();
        }
      }}
    >
      {stage.kind === "ready" ? (
        <iframe
          ref={frame}
          className="space-frame"
          tabIndex={-1}
          title={`${space.name}, ${isDriver ? "you're in control" : "watching"}`}
          src={stage.frameUrl}
          // Its own loopback origin: it can keep its ticket in its own storage, never the app's.
          sandbox="allow-scripts allow-same-origin allow-pointer-lock"
          allow={stage.interactive ? "clipboard-read; clipboard-write; fullscreen" : "fullscreen"}
        />
      ) : (
        <div className="space-state" role="status">
          {stage.kind === "opening" ? (
            <>
              <Icon name="working" className="spin" />
              <h2>Opening the Space…</h2>
              {stage.note ? <p>{stage.note}</p> : null}
            </>
          ) : stage.kind === "ended" ? (
            <>
              <Icon name="stop" />
              <h2>Space no longer shared</h2>
            </>
          ) : stage.kind === "stopped" ? (
            <>
              <Icon name="stop" />
              <h2>Space {stage.power}</h2>
              <p>
                This Space is {stage.power} on <span className="mono">{stage.machine}</span>. It
                shows here again when it starts.
              </p>
            </>
          ) : (
            <>
              <Icon name="alert" />
              <h2>{stage.kind === "unreachable" ? "Space unreachable" : "Space didn't open"}</h2>
              <p>
                {stage.kind === "unreachable" ? (
                  <>
                    Can't reach <span className="mono">{stage.machine}</span> from this computer. A
                    Space opens on the same network as its machine, or over Tailscale.
                  </>
                ) : (
                  <>The Space didn't open: {stage.reason.trim().replace(/[.]+$/, "")}.</>
                )}
              </p>
              <button className="btn" type="button" onClick={onRetry}>
                Try again
              </button>
            </>
          )}
        </div>
      )}
      {stage.kind === "ready" ? (
        <div className="space-input-strip">
          <span className={`kb-badge ${isDriver ? "on" : ""}`} role="status">
            <Icon name={isDriver ? "wheel" : "eye"} size={14} />
            {badge}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SuggestForm({
  access,
  onSuggest,
}: {
  access: Access;
  onSuggest(text: string): Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const canSuggest = accessRank(access) >= accessRank("suggest");
  return (
    <form
      className="side-block space-suggest"
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim() && (await onSuggest(text))) setText("");
      }}
    >
      <h2>Suggest to whoever is in control</h2>
      <Input
        className="input"
        placeholder={canSuggest ? "Open Settings, then Deploy" : "This Space is on View"}
        disabled={!canSuggest}
        value={text}
        maxLength={500}
        onValueChange={setText}
        aria-label="Suggest to whoever is in control"
      />
      <button className="btn" type="submit" disabled={!canSuggest || !text.trim()}>
        <Icon name="suggest" /> Suggest
      </button>
      {!canSuggest ? (
        <span className="hint">Teammates can suggest once the access is Suggest or more open.</span>
      ) : null}
    </form>
  );
}

function PassWheel({
  members,
  candidates,
  onPass,
}: {
  members: MemberRow[];
  candidates: MemberRow[];
  onPass(to: Id<"members">): void;
}) {
  return (
    <Menu onAction={(memberId) => onPass(memberId as Id<"members">)}>
      <MenuTrigger className="btn">
        <Icon name="wheel" /> Hand off
      </MenuTrigger>
      <MenuContent
        className="pop space-handoff-menu"
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={8}
      >
        <MenuGroup>
          <MenuGroupLabel className="pop-title">Hand off to</MenuGroupLabel>
          {candidates.length === 0 ? (
            <div className="muted" style={{ padding: "6px 9px" }}>
              Nobody can take it at this access level.
            </div>
          ) : null}
          {candidates.map((m) => (
            <MenuItem key={m.memberId} value={m.memberId} label={m.name}>
              <span className="space-handoff-face">
                <MemberFace member={m} members={members} size={m.kind === "agent" ? 30 : 24} />
              </span>
              <span>{m.name}</span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

const ACTION_FAIL_TEXT: Record<string, string> = {
  not_driver: "it wasn't in control",
  space_not_shared: "the Space wasn't shared",
  invalid_action: "not a valid action",
};

function failText(error: string | undefined) {
  return error ? (ACTION_FAIL_TEXT[error] ?? error) : "it failed";
}

const KEY_LABEL: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Cmd",
  meta: "Cmd",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
};

/** One line for a Space action, as people read it. */
export function describeAction(action: SpaceActionRow["action"]): string {
  switch (action.kind) {
    case "screenshot":
      return "took a screenshot";
    case "click":
      return `${action.count === 2 ? "double-clicked" : action.button === "right" ? "right-clicked" : "clicked"} at ${Math.round(action.x)}, ${Math.round(action.y)}`;
    case "move":
      return `moved to ${Math.round(action.x)}, ${Math.round(action.y)}`;
    case "scroll":
      return `scrolled ${action.dy > 0 ? "down" : action.dy < 0 ? "up" : action.dx > 0 ? "right" : "left"}`;
    case "key":
      return `pressed ${action.keys.map((k) => KEY_LABEL[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k)).join("+")}`;
    case "type":
      return `typed “${action.text.length > 40 ? `${action.text.slice(0, 40)}…` : action.text}”`;
  }
}
