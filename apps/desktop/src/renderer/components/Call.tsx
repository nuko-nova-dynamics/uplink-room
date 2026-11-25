/**
 * Calls in the app (spec #5, DESIGN.md "Calls"): the call dock at the bottom
 * of the sidebar, who's in each call under its channel, the call bar under the
 * channel's title, the stage for cameras and shared screens, and the screen picker.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Track } from "livekit-client";
import { Checkbox } from "@ui-sdk/react/checkbox";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { Radio, RadioGroup } from "@ui-sdk/react/radio";
import { Toggle } from "@ui-sdk/react/toggle";
import { api, type Id, type MemberRow } from "../lib/api";
import { useCall, useLiveCalls, type LiveCall } from "../lib/call";
import {
  effectiveShare,
  rememberedShare,
  rememberShare,
  VOICE,
  windowsCaptureFps,
  type ShareQuality,
} from "../lib/callQuality";
import { desktop, fakeMedia, type ScreenSource } from "../lib/desktop";
import {
  ScreenTools,
  ShareQualityChoice,
  useCallQualityLimit,
  VoiceQualityChoices,
  voiceWhere,
} from "./CallQuality";
import {
  CallSettings,
  createCallPanel,
  type CallPanel,
  type CallPanelController,
} from "./CallSettings";
import { CameraPicture } from "./Devices";
import { clock } from "../lib/format";
import { memberTile } from "../lib/tiles";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { Dialog } from "./Dialog";
import { Face } from "./Faces";
import { Icon } from "./Icon";
import { Tip } from "./Tip";
import { useNow } from "./useNow";

import "./calls.css";

type Person = LiveCall["participants"][number];

function memberOf(members: MemberRow[], memberId: string) {
  return members.find((m) => m.memberId === memberId);
}

/** A person's face or an agent's character, with a speaking ring while they talk. */
function CallFace({ who, speaking, size }: { who: Person; speaking: boolean; size: number }) {
  const { members } = useSession();
  return (
    <span className={`call-face ${speaking ? "speaking" : ""}`} title={who.name}>
      <Face
        who={{
          name: who.name,
          kind: who.kind,
          character: memberOf(members, who.memberId)?.character,
        }}
        // An agent in a call is at work, so its accessory is out (DESIGN.md, Characters).
        state={who.kind === "agent" ? "working" : "idle"}
        size={who.kind === "agent" ? size : undefined}
      />
    </span>
  );
}

/** One person or agent in a call: face, name, and whether they share a screen, have a camera on or are muted. */
function CallMemberRow({ who, speaking }: { who: Person; speaking: boolean }) {
  return (
    <li className="call-member">
      {/* 24 px, as elsewhere: a smaller face's initials fall under 11 px (DESIGN.md). */}
      <CallFace who={who} speaking={speaking} size={24} />
      <span className="truncate">{who.name}</span>
      <span className="call-member-icons">
        {who.takesNotes ? <Icon name="transcript" size={14} aria-label="Taking notes" /> : null}
        {who.screen ? <Icon name="screen" size={14} aria-label="Sharing a screen" /> : null}
        {who.camera ? <Icon name="camera" size={14} aria-label="Camera on" /> : null}
        {who.muted ? (
          <Icon name="mic-off" size={14} className="is-muted" aria-label="Muted" />
        ) : null}
      </span>
    </li>
  );
}

/** The people and agents in a channel's call, listed under the channel in the sidebar. */
export function ChannelCallMembers({ call }: { call: LiveCall }) {
  const { speaking, callId } = useCall();
  const inThisCall = callId === call.callId;
  return (
    <ul className="call-members" aria-label="In the call">
      {call.participants.slice(0, SHOWN_IN_SIDEBAR).map((p) => (
        <CallMemberRow key={p.memberId} who={p} speaking={inThisCall && speaking.has(p.memberId)} />
      ))}
      {call.participants.length > SHOWN_IN_SIDEBAR ? (
        <li className="call-member call-more muted">
          and {call.participants.length - SHOWN_IN_SIDEBAR} more
        </li>
      ) : null}
    </ul>
  );
}

/** How many people a call lists under its channel before "and N more", so the channels below stay in reach. */
const SHOWN_IN_SIDEBAR = 5;

/** How many call bars (your call's controls in its channel) are on screen; the dock hides while one is. */
let stageBars = 0;
const stageBarListeners = new Set<() => void>();
function onStageBarChange(listener: () => void) {
  stageBarListeners.add(listener);
  return () => stageBarListeners.delete(listener);
}
/** Counts this call bar as on screen while `on`, so the sidebar's dock steps aside. */
function useStageBar(on: boolean) {
  useEffect(() => {
    if (!on) return;
    stageBars += 1;
    stageBarListeners.forEach((l) => l());
    return () => {
      stageBars -= 1;
      stageBarListeners.forEach((l) => l());
    };
  }, [on]);
}

/**
 * The dock at the bottom of the sidebar while you're in a call: mute, camera, screen share, call
 * settings and leave, and your own camera while it's on. Turning the camera on opens its preview
 * first (CallSettings); turning it off is at once.
 */
export function CallDock({
  onOpenChannel,
}: {
  onOpenChannel: (channelId: Id<"channels">) => void;
}) {
  const call = useCall();
  const live = useLiveCalls();
  const channels = useRoomQuery(api.channels.list, {});
  const now = useNow();
  const onStage = useSyncExternalStore(onStageBarChange, () => stageBars > 0);
  if (call.status === "idle" || !call.channelId) return null;
  // The call's own controls (and whether it's joining or reconnecting) are on screen in its
  // channel's call bar, so the dock steps aside.
  if (onStage) return null;
  const mine = live?.find((c) => c.callId === call.callId);
  const channel = channels?.find((c) => c.channelId === call.channelId);
  const notetakers = (mine?.participants ?? []).filter((p) => p.takesNotes);
  const label =
    call.status === "joining"
      ? "Joining"
      : call.status === "reconnecting"
        ? "Reconnecting"
        : "In call";
  return (
    <section className="call-dock" aria-label="Call">
      <div className="call-dock-head">
        <button
          className="call-dock-where"
          type="button"
          onClick={() => onOpenChannel(call.channelId!)}
        >
          <b className={call.status === "connected" ? "in" : ""}>{label}</b>
          <span className="truncate">{channel ? `#${channel.name}` : ""}</span>
        </button>
        {mine ? (
          <span className="mono muted call-dock-time">{clock(mine.startedAt, now)}</span>
        ) : null}
      </div>
      {notetakers.length > 0 ? (
        <div className="call-dock-note">
          {notetakers.map((n) => n.name).join(" and ")} {notetakers.length === 1 ? "is" : "are"}{" "}
          taking notes
        </div>
      ) : null}
      {call.camera && call.selfCamera ? (
        <div className="call-dock-self" aria-label="Your camera, as others see it, mirrored">
          <CameraPicture track={call.selfCamera} mirror={!fakeMedia} />
        </div>
      ) : null}
      <CallControls />
    </section>
  );
}

/**
 * Your media controls in a call: mute, camera (previewed first), share, devices and leave, with the
 * panels they open, in the sidebar's dock. In the call's channel, the call bar holds them instead.
 */
export function CallControls({ className = "call-dock-controls" }: { className?: string }) {
  const call = useCall();
  const [picking, setPicking] = useState(false);
  const [panel] = useState(createCallPanel);
  const row = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={row} className={className}>
        <MuteToggle />
        <CameraToggle panel={panel} />
        <ShareToggle onPick={() => setPicking(true)} />
        <Tip label="Microphone, speaker and camera">
          <PopoverTrigger
            controller={panel}
            payload={"settings" satisfies CallPanel}
            className="btn icon"
            aria-label="Call settings"
          >
            <Icon name="sliders" />
          </PopoverTrigger>
        </Tip>
        <LeaveButton />
      </div>
      {/* It rises above the whole dock, not just this row. */}
      <CallSettings controller={panel} anchor={() => row.current?.parentElement ?? row.current} />
      {picking ? (
        <ScreenPicker
          onClose={() => setPicking(false)}
          onShare={(source, audio, quality) => {
            setPicking(false);
            void call.shareScreen(source, audio, quality);
          }}
        />
      ) : null}
    </>
  );
}

/** Mute: pressed while you're muted. */
function MuteToggle() {
  const call = useCall();
  const label = call.muted ? "Unmute" : "Mute";
  return (
    <Tip label={label}>
      <Toggle
        className={`btn icon ${call.muted ? "is-off" : ""}`}
        pressed={call.muted}
        aria-label={label}
        disabled={call.status !== "connected"}
        onPressedChange={() => void call.toggleMute()}
      >
        <Icon name={call.muted ? "mic-off" : "mic"} />
      </Toggle>
    </Tip>
  );
}

/** The camera: pressed while it's on. Off, it opens the camera's preview first; on, it turns off at once. */
function CameraToggle({ panel }: { panel: CallPanelController }) {
  const call = useCall();
  const disabled = call.status !== "connected";
  return (
    <Tip label={call.camera ? "Turn camera off" : "Turn camera on: preview it first"}>
      <PopoverTrigger
        controller={panel}
        payload={"camera" satisfies CallPanel}
        render={<Toggle pressed={call.camera} disabled={disabled} />}
        className={`btn icon ${call.camera ? "is-on" : ""}`}
        aria-label={call.camera ? "Turn camera off" : "Turn camera on"}
        disabled={disabled}
        onClick={(event) => {
          if (!call.camera) return;
          // Turning it off needs no preview, so this press doesn't open the popover.
          event.preventDefault();
          panel.close();
          void call.toggleCamera();
        }}
      >
        <Icon name={call.camera ? "camera" : "camera-off"} />
      </PopoverTrigger>
    </Tip>
  );
}

/** Share a screen: pressed while you share one. Off, it opens the screen picker. */
function ShareToggle({ onPick }: { onPick: () => void }) {
  const call = useCall();
  const label = call.screen ? "Stop sharing" : "Share a screen";
  return (
    <Tip label={label}>
      <Toggle
        className={`btn icon ${call.screen ? "is-on" : ""}`}
        pressed={call.screen}
        aria-label={label}
        disabled={call.status !== "connected"}
        onPressedChange={() => (call.screen ? void call.stopScreen() : onPick())}
      >
        <Icon name="screen" />
      </Toggle>
    </Tip>
  );
}

function LeaveButton() {
  const call = useCall();
  return (
    <Tip label="Leave the call">
      <button
        type="button"
        className="btn icon leave"
        aria-label="Leave the call"
        onClick={() => void call.leave()}
      >
        <Icon name="leave" />
      </button>
    </Tip>
  );
}

/**
 * Choose exactly which screen or window to share, with or without its sound, and its quality
 * (issue #87): remembered on this computer, and kept within the team's limit.
 */
export function ScreenPicker({
  onClose,
  onShare,
}: {
  onClose: () => void;
  onShare: (source: ScreenSource, audio: boolean, quality: ShareQuality) => void;
}) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [audio, setAudio] = useState(true);
  const limit = useCallQualityLimit();
  const [picked, setPicked] = useState<ShareQuality>(rememberedShare);
  // The remembered choice, or the closest the team's limit allows (it may load after the picker opens).
  const quality = effectiveShare(picked, limit);
  const share = (source: ScreenSource) => {
    rememberShare(quality);
    onShare(source, audio, quality);
  };
  useEffect(() => {
    let alive = true;
    (desktop.screenSources?.() ?? Promise.resolve([]))
      .then((list) => alive && setSources(list))
      .catch((error: unknown) => alive && setFailed(String(error)));
    return () => {
      alive = false;
    };
  }, []);
  const choice = sources?.find((s) => s.id === selected);
  // Windows 11 holds capture under 60 fps on a display above 60 Hz (lib/callQuality.ts): say so for
  // the screen picked, or before one is, for the fastest display.
  const hz = choice
    ? choice.refreshRate
    : Math.max(0, ...(sources ?? []).map((s) => s.refreshRate ?? 0)) || null;
  const windowsFps = desktop.platform === "win32" ? windowsCaptureFps(hz) : null;
  const windowsNote = windowsFps
    ? `${choice ? "This display runs" : "Your fastest display runs"} at ${hz} Hz, so on Windows 11 a 60 fps share runs at about ${windowsFps} fps: Chromium's Windows capture can't hold 60 there yet.`
    : null;
  const groups: [string, ScreenSource[]][] = [
    ["Screens", (sources ?? []).filter((s) => s.kind === "screen")],
    ["Windows", (sources ?? []).filter((s) => s.kind === "window")],
  ];
  return (
    <Dialog
      title="Share a screen or window"
      onClose={onClose}
      wide
      footer={
        <>
          <label className="check-row grow">
            <Checkbox checked={audio} onCheckedChange={(checked) => setAudio(checked === true)} />
            Share its sound
          </label>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!choice}
            onClick={() => choice && share(choice)}
          >
            Share
          </button>
        </>
      }
    >
      <div className="screen-picker">
        <div className="field">
          <span className="label" id="share-quality-label">
            Quality
          </span>
          <ShareQualityChoice
            value={quality}
            onChange={setPicked}
            limit={limit}
            labelId="share-quality-label"
            windowsNote={windowsNote}
            initialFocus
          />
        </div>
        {failed ? <p className="hint">Couldn't list screens: {failed}</p> : null}
        {sources === null && !failed ? (
          <p className="hint">Looking for screens and windows…</p>
        ) : null}
        {sources !== null && sources.length === 0 ? (
          <p className="hint">
            No screens to share. On macOS, allow Uplink Room in System Settings, Privacy & Security,
            Screen & System Audio Recording.
          </p>
        ) : null}
        {groups.map(([title, list]) =>
          list.length === 0 ? null : (
            <div key={title} className="field">
              <span className="label">{title}</span>
              <RadioGroup
                className="source-grid"
                aria-label={title}
                value={list.some((s) => s.id === selected) ? selected : null}
                onValueChange={(id) => {
                  if (id) setSelected(id);
                }}
              >
                {list.map((source) => (
                  <Radio
                    key={source.id}
                    value={source.id}
                    className="source"
                    onDoubleClick={() => share(source)}
                  >
                    <span className="source-thumb">
                      {source.thumbnail ? (
                        <img src={source.thumbnail} alt="" />
                      ) : (
                        <span className="source-placeholder">
                          <Icon name={source.kind === "screen" ? "screen" : "file"} size={14} />
                          <span>
                            {source.kind === "screen"
                              ? "Screen preview unavailable"
                              : "Window preview unavailable"}
                          </span>
                        </span>
                      )}
                    </span>
                    <span className="truncate">{source.name}</span>
                  </Radio>
                ))}
              </RadioGroup>
            </div>
          ),
        )}
      </div>
    </Dialog>
  );
}

/** Plays a LiveKit video track in a <video> element. */
export function TrackVideo({
  track,
  mirror = false,
  fit,
  participant,
  label,
}: {
  track: Track;
  mirror?: boolean;
  fit: "cover" | "contain";
  participant?: Person;
  label?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const { members } = useSession();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setReady(false);
    track.attach(element);
    if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);
    return () => {
      track.detach(element);
    };
  }, [track]);
  const name = participant?.name ?? label ?? "Participant";
  return (
    <div className={`tile-video ${fit} ${ready ? "ready" : ""}`}>
      <video
        ref={ref}
        className={mirror ? "mirror" : ""}
        muted
        playsInline
        autoPlay
        onLoadedData={() => setReady(true)}
        onEmptied={() => setReady(false)}
        onError={() => setReady(false)}
      />
      {!ready ? (
        <div className="track-placeholder" role="status">
          {label ? (
            <Icon name="screen" size={20} />
          ) : (
            <Face
              who={{
                name,
                kind: participant?.kind ?? "person",
                character: participant
                  ? memberOf(members, participant.memberId)?.character
                  : undefined,
              }}
            />
          )}
          <span className="truncate">{name}</span>
          <span className="muted">{label ? "Waiting for the screen" : "Video unavailable"}</span>
        </div>
      ) : null}
    </div>
  );
}

/** How many camera tiles the stage shows before one "+N" tile, so it never runs off its edge. */
const MAX_TILES = 12;

/**
 * The call stage under the call bar: shared screens largest, then a tile for each camera that's on.
 * People and agents with no camera have no tile; their faces are in the call bar. With no camera
 * and no screen, there is no stage.
 */
export function CallStage({ call }: { call: LiveCall }) {
  const { tiles, speaking } = useCall();
  const screens = tiles.filter((t) => t.screen);
  const cameras = call.participants.flatMap((p) => {
    const tile = memberTile(tiles, p.memberId);
    return tile?.camera ? [{ who: p, tile, camera: tile.camera }] : [];
  });
  // One shared screen at a time can fill the stage, so adaptive stream asks for its full size.
  const [expanded, setExpanded] = useState<string | null>(null);
  const big = screens.some((t) => t.join === expanded) ? expanded : null;
  if (screens.length === 0 && cameras.length === 0) return null;
  const shown = cameras.length > MAX_TILES ? cameras.slice(0, MAX_TILES - 1) : cameras;
  return (
    <section
      className={`call-stage ${screens.length > 0 ? "has-screen" : ""} ${big ? "expanded" : ""} ${cameras.length > 6 ? "compact" : ""}`}
      aria-label="Call stage"
    >
      {screens.map((t) => {
        const who = call.participants.find((p) => p.memberId === t.identity);
        return (
          <figure
            key={`screen-${t.join}`}
            className={`tile screen ${big === t.join ? "is-expanded" : ""}`}
          >
            <TrackVideo
              track={t.screen!}
              fit="contain"
              label={who ? `${who.name}’s screen` : "Shared screen"}
            />
            <ScreenTools
              join={t.join}
              isLocal={t.isLocal}
              expanded={big === t.join}
              onExpand={() => setExpanded(big === t.join ? null : t.join)}
            />
            <figcaption className="tile-name">
              <Icon name="screen" size={14} />{" "}
              {t.isLocal ? "Your screen" : who ? `${who.name}'s screen` : "Shared screen"}
            </figcaption>
          </figure>
        );
      })}
      {shown.map(({ who, tile, camera }) => (
        <figure
          key={who.memberId}
          className={`tile ${who.kind} ${speaking.has(who.memberId) ? "speaking" : ""}`}
        >
          {/* Your own camera is mirrored, as in a mirror; the synthetic one has text, so it isn't. */}
          <TrackVideo
            track={camera}
            mirror={tile.isLocal && !fakeMedia}
            fit="cover"
            participant={who}
          />
          <figcaption className="tile-name">
            {who.muted ? (
              <Icon name="mic-off" size={14} className="is-muted" aria-label="Muted" />
            ) : null}
            <span className="truncate">{who.name}</span>
          </figcaption>
        </figure>
      ))}
      {cameras.length > MAX_TILES ? (
        <figure
          className="tile more-tile"
          title={cameras
            .slice(MAX_TILES - 1)
            .map((c) => c.who.name)
            .join(", ")}
        >
          <span className="more-count">+{cameras.length - (MAX_TILES - 1)}</span>
        </figure>
      ) : null}
    </section>
  );
}

/** How many faces the call bar shows before "+N". */
const FACES_IN_BAR = 3;

/** Who's in a call: up to three faces, the ones talking first, and the whole list on a click. */
function CallWho({ call, talking }: { call: LiveCall; talking: ReadonlySet<string> }) {
  // Sorting is stable, so the rest keep the order they joined in.
  const people = [...call.participants].sort(
    (a, b) => Number(talking.has(b.memberId)) - Number(talking.has(a.memberId)),
  );
  const more = people.length - FACES_IN_BAR;
  return (
    <div className="call-who">
      <Popover>
        <Tip label={people.map((p) => p.name).join(", ")}>
          <PopoverTrigger className="call-faces" aria-label={`${people.length} in the call`}>
            <span className="call-face-stack">
              {people.slice(0, FACES_IN_BAR).map((p) => (
                <CallFace key={p.memberId} who={p} speaking={talking.has(p.memberId)} size={24} />
              ))}
            </span>
            {more > 0 ? <span className="call-faces-more">+{more}</span> : null}
          </PopoverTrigger>
        </Tip>
        <PopoverContent
          className="pop call-people"
          aria-label="In the call"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
        >
          <div className="pop-title">In the call</div>
          <ul className="call-members">
            {people.map((p) => (
              <CallMemberRow key={p.memberId} who={p} speaking={talking.has(p.memberId)} />
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The call bar under a channel's title while it has a call (DESIGN.md, "Calls"): one pill with
 * who's in it and how long it has run, then Join, or, while you're in it, Mute, Share, a menu
 * (camera, devices, voice quality, asking an agent to join) and Leave.
 */
export function CallBar({
  call,
  channelId,
  controls = true,
}: {
  call: LiveCall;
  channelId: Id<"channels">;
  /** False while the channel is out of sight (the browser fills the window); the dock shows instead. */
  controls?: boolean;
}) {
  const me = useCall();
  const now = useNow();
  const here = me.callId === call.callId && me.status !== "idle";
  useStageBar(here && controls);
  if (!controls) return null;
  const talking: ReadonlySet<string> = here ? me.speaking : new Set();
  const notetakers = call.participants.filter((p) => p.takesNotes);
  const notesLine = `${notetakers.map((n) => n.name).join(" and ")} ${notetakers.length === 1 ? "is" : "are"} taking notes`;
  return (
    <div className="stage-bar call-bar">
      <div className="stage-controls call-pill" role="group" aria-label="Call">
        <CallWho call={call} talking={talking} />
        {/* In a narrow column the time and the words "Taking notes" drop out, whole; the status and
          the notes icon never do. */}
        {here && me.status !== "connected" ? (
          <span className="call-status" role="status">
            {me.status === "joining" ? "Joining" : "Reconnecting"}
          </span>
        ) : (
          <span className="call-drop call-drop-time">
            <span className="call-time" title="How long the call has run">
              {clock(call.startedAt, now)}
            </span>
          </span>
        )}
        {notetakers.length > 0 ? (
          <>
            {/* Nobody is transcribed without knowing (spec #5, story 22): the icon always shows. */}
            <span className="call-notes" role="img" aria-label={notesLine} title={notesLine}>
              <Icon name="transcript" size={14} />
            </span>
            <span className="call-drop call-drop-notes" aria-hidden="true">
              <span className="call-notes-label">Taking notes</span>
            </span>
          </>
        ) : null}
        {here ? (
          // One group, so in a column too narrow for one line the controls move together to the next.
          <span className="call-controls">
            <span className="call-bar-sep" aria-hidden="true" />
            <CallBarControls call={call} channelId={channelId} />
          </span>
        ) : (
          <Tip label="Join call">
            <button
              className="btn primary call-join"
              type="button"
              aria-label="Join call"
              disabled={me.status === "joining"}
              onClick={() => void me.join(channelId)}
            >
              Join
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** Your controls in the call bar: Mute, Share and Leave, with the rest in one menu. */
function CallBarControls({ call, channelId }: { call: LiveCall; channelId: Id<"channels"> }) {
  const me = useCall();
  const session = useSession();
  const invite = useAct(api.calls.invite, { success: "Asked to join" });
  const channel = useRoomQuery(api.channels.list, {})?.find((c) => c.channelId === channelId);
  const voice = channel?.callQuality;
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [panel] = useState(createCallPanel);
  const moreButton = useRef<HTMLButtonElement>(null);
  // A panel chosen in the menu opens once the menu has closed and given focus back to its button,
  // so the panel returns focus there too.
  const pendingPanel = useRef<CallPanel | null>(null);
  const connected = me.status === "connected";
  const inCall = new Set(call.participants.map((p) => p.memberId));
  const askable = session.members.filter((m) => m.kind === "agent" && !inCall.has(m.memberId));
  return (
    <>
      <MuteToggle />
      <ShareToggle onPick={() => setPicking(true)} />
      <div className="call-menu-wrap">
        <Menu
          open={menu}
          onOpenChange={setMenu}
          onOpenChangeComplete={(open) => {
            const which = pendingPanel.current;
            pendingPanel.current = null;
            if (!open && which) void panel.open({ payload: which });
          }}
        >
          <Tip label="Camera, devices, voice quality and agents">
            <MenuTrigger
              ref={moreButton}
              className={`btn icon ${me.camera ? "is-on" : ""}`}
              aria-label="More call controls"
            >
              <Icon name="more" />
            </MenuTrigger>
          </Tip>
          <MenuContent
            className="pop call-menu"
            aria-label="Call"
            align="end"
            sideOffset={8}
            collisionPadding={8}
          >
            <MenuItem
              disabled={!connected}
              onSelect={() => {
                if (me.camera) void me.toggleCamera();
                else pendingPanel.current = "camera";
              }}
            >
              <Icon name={me.camera ? "camera-off" : "camera"} />
              <span className="grow">{me.camera ? "Turn camera off" : "Turn camera on"}</span>
            </MenuItem>
            <MenuItem onSelect={() => (pendingPanel.current = "settings")}>
              <Icon name="sliders" />
              <span className="grow">Microphone, speaker and camera</span>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <Icon name="volume" />
                <span className="grow">Voice quality</span>
                {voice ? <span className="muted">{VOICE[voice].label}</span> : null}
                <Icon name="chevron" size={12} />
              </MenuSubTrigger>
              <MenuSubContent
                className="pop call-menu quality-choices"
                aria-label={channel ? `Voice quality in ${voiceWhere(channel)}` : "Voice quality"}
                collisionPadding={8}
              >
                <VoiceQualityChoices channelId={channelId} onChosen={() => setMenu(false)} />
              </MenuSubContent>
            </MenuSub>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel className="pop-title">Ask an agent to join</MenuGroupLabel>
              {askable.length === 0 ? (
                <div className="muted call-menu-note">
                  {session.members.some((m) => m.kind === "agent")
                    ? "Every agent is already here."
                    : "No agents yet. Add one in Settings, Agents."}
                </div>
              ) : null}
              {askable.map((agent) => (
                <MenuItem
                  key={agent.memberId}
                  label={agent.name}
                  disabled={!me.callId}
                  onSelect={() => {
                    if (me.callId) void invite({ callId: me.callId, memberId: agent.memberId });
                  }}
                >
                  <Face
                    who={{ name: agent.name, kind: "agent", character: agent.character }}
                    size={20}
                  />
                  <span className="grow truncate">{agent.name}</span>
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuContent>
        </Menu>
      </div>
      <LeaveButton />
      <CallSettings
        controller={panel}
        anchor={() => moreButton.current?.closest(".call-controls") ?? moreButton.current}
      />
      {picking ? (
        <ScreenPicker
          onClose={() => setPicking(false)}
          onShare={(source, audio, quality) => {
            setPicking(false);
            void me.shareScreen(source, audio, quality);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The channel header's call action while nobody is talking here: Join call, which starts the call by
 * joining it, so there is no separate "start". Its label never folds to a bare icon. A running call
 * is joined from its call bar.
 */
export function CallHeaderActions({
  channelId,
  call,
}: {
  channelId: Id<"channels">;
  call: LiveCall | undefined;
}) {
  const me = useCall();
  if (call) return null;
  return (
    <div className="call-actions">
      <Tip label="Join the call here: teammates can join you from Voice in the sidebar">
        <button
          className="btn call-head-join"
          type="button"
          disabled={me.status === "joining"}
          aria-label="Join call"
          onClick={() => void me.join(channelId)}
        >
          <Icon name="volume" /> <span className="call-join-label">Join call</span>
        </button>
      </Tip>
    </div>
  );
}
