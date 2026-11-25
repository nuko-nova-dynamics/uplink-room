/**
 * The call you're in (spec #5). One LiveKit room for the whole app, so the call survives moving
 * between the Inbox, boards, Settings and terminals. Joining goes through the Room API
 * (`calls.join`), which returns a token for this call alone (ADR 0007); presence is the heartbeat
 * every 20 seconds (callSession.ts).
 *
 * The call belongs to the app, not to a view (docs/calls.md, "Staying in a call"): an `AppCall`
 * per signed-in member holds the session, its media and its LiveKit room, outside React. A
 * CallProvider mounting for that member picks it up; one unmounting (the window reloading its
 * session after the computer wakes, the team chooser) leaves the call running for
 * `UNMOUNTED_GRACE_MS`, with its heartbeat and sound going, before leaving. Opening another team
 * or signing out (`endAppCall`) ends it at once.
 *
 * Under synthetic media (`UPLINK_FAKE_MEDIA=1`) the microphone, camera and screen are an oscillator
 * and canvases: no device is opened, nothing plays.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import {
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  type Participant,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  VideoQuality,
} from "livekit-client";
import { api, type Id } from "./api";
import { desktop, fakeMedia } from "./desktop";
import { errorMessage } from "./errors";
import { useRoomQuery, useSession, useToast } from "./session";
import { playCue } from "./sound";
import { CallSession, type Disconnect, type SessionState } from "./callSession";
import { track } from "./analytics";
import { reportInCall } from "./updates";
import {
  cameraOptions,
  micOptions,
  rememberedCamera,
  SHARE,
  SHARE_AUDIO_CAPTURE,
  shareConstraints,
  type CallQuality,
  type CameraQuality,
  type ShareQuality,
} from "./callQuality";
import { CallMedia, type MediaDevices } from "./callMedia";
import { DEFAULT_DEVICE, deviceConstraint, deviceFor, listDevices, onDevicesChange, onSavedDeviceChange, saveDevice, savedDevice, type DeviceOption } from "./devices";
import { errorFields, log, type Fields } from "./log";

export type LiveCall = NonNullable<ReturnType<typeof useLiveCalls>>[number];

/** The member a LiveKit identity belongs to. Identities name one join: `<member>.<participation>`. */
export function memberIdOf(identity: string): string {
  return identity.split(".")[0]!;
}

export type CallTile = {
  /** The member (not the join): a member on two devices has two tiles with the same id. */
  identity: string;
  /** The LiveKit identity: one join. */
  join: string;
  isLocal: boolean;
  camera?: Track | undefined;
  screen?: Track | undefined;
};

/** Krisp noise cancellation on this call's microphone, and why it's off when it is. */
export type KrispState = { state: "off" | "starting" | "on" | "failed"; why: string };

export type CallContextValue = {
  callId: Id<"calls"> | null;
  channelId: Id<"channels"> | null;
  status: "idle" | "joining" | "connected" | "reconnecting";
  muted: boolean;
  camera: boolean;
  screen: boolean;
  /** Member ids talking right now, from LiveKit. Only known while you're in the call. */
  speaking: ReadonlySet<string>;
  /** Cameras and screens by member, for the stage. */
  tiles: CallTile[];
  join(channelId: Id<"channels">): Promise<void>;
  leave(): Promise<void>;
  toggleMute(): Promise<void>;
  toggleCamera(): Promise<void>;
  /** Shares a screen or window the person picked in the app's picker, at the quality picked there. */
  shareScreen(source: { id: string; name: string }, audio: boolean, quality: ShareQuality): Promise<void>;
  stopScreen(): Promise<void>;
  /** The quality of your share while you share (issue #87). */
  shareQuality: ShareQuality | null;
  /** Shares the same screen or window again at another quality. */
  changeShareQuality(quality: ShareQuality): Promise<void>;
  /** The voice quality this call publishes with: its channel's, capped by the team's limit. */
  voice: CallQuality;
  /** How you watch each shared screen, by LiveKit identity: as adaptive stream picks, or its low layer. */
  screenView: ReadonlyMap<string, ScreenView>;
  setScreenView(join: string, view: ScreenView): void;
  /** Your camera's quality on this computer (Settings, Calls). */
  cameraQuality: CameraQuality;
  setCameraQuality(quality: CameraQuality): Promise<void>;
  /** The call's published microphone, for its level meter; null outside a call. */
  micTrack: MediaStreamTrack | null;
  /** Your published camera, for the self view; null while it's off. */
  selfCamera: LocalVideoTrack | null;
  krisp: KrispState;
};

export type ScreenView = "auto" | "low";

/** Exported for the gym (gym/), which gives the shell a call without LiveKit. */
export const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const call = useContext(CallContext);
  if (!call) throw new Error("useCall outside CallProvider");
  return call;
}

/** The team's live calls, with who is in each (from Convex, for everyone in the team). */
export function useLiveCalls() {
  return useRoomQuery(api.calls.live, {});
}

// ---------- synthetic media ----------

function fakeAudio(): MediaStreamTrack {
  const ac = new AudioContext();
  const oscillator = ac.createOscillator();
  const gain = ac.createGain();
  const out = ac.createMediaStreamDestination();
  oscillator.frequency.value = 180;
  gain.gain.value = 0;
  oscillator.connect(gain).connect(out);
  oscillator.start();
  // Bursts of "speech" so the speaking ring has something to show.
  let on = false;
  setInterval(() => {
    on = !on;
    gain.gain.setTargetAtTime(on ? 0.4 : 0, ac.currentTime, 0.05);
  }, 1600);
  return out.stream.getAudioTracks()[0]!;
}

function fakeCanvas(draw: (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  const start = performance.now();
  const tick = () => draw(g, w, h, (performance.now() - start) / 1000);
  tick();
  setInterval(tick, 1000 / 12);
  return canvas.captureStream(12).getVideoTracks()[0]!;
}

function fakeCamera(initials: string): MediaStreamTrack {
  return fakeCanvas(
    (g, w, h, t) => {
      g.fillStyle = "#273140";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#3a4a60";
      g.beginPath();
      g.arc(w / 2, h / 2 + 4 * Math.sin(t * 1.6), 92, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#ebecee";
      g.font = "700 72px 'Atkinson Hyperlegible Next', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(initials, w / 2, h / 2 + 4 * Math.sin(t * 1.6));
      g.font = "400 18px 'Atkinson Hyperlegible Next', sans-serif";
      g.fillStyle = "#8f939b";
      g.textAlign = "right";
      g.textBaseline = "top";
      g.fillText("Synthetic camera", w - 20, 20);
    },
    640,
    400,
  );
}

const FAKE_SCREEN_LINES = [
  "$ pnpm test --filter maps",
  "",
  " RUN  v5.0.5 packages/maps",
  "",
  " ✓ test/tiles.test.ts (12 tests) 41ms",
  " ✓ test/loader.test.ts (6 tests) 18ms",
  " ✓ test/save-slots.test.ts (9 tests) 33ms",
  "",
  " Test Files  3 passed (3)",
  "      Tests  27 passed (27)",
  "",
  "$ godot --export-release macos build/reef-runner.dmg",
];

function fakeScreen(): MediaStreamTrack {
  return fakeCanvas(
    (g, w, h, t) => {
      g.fillStyle = "#0b0c0d";
      g.fillRect(0, 0, w, h);
      g.font = "400 22px 'Atkinson Hyperlegible Mono', monospace";
      g.textBaseline = "top";
      const shown = Math.min(FAKE_SCREEN_LINES.length, 4 + Math.floor(t));
      FAKE_SCREEN_LINES.slice(0, shown).forEach((line, i) => {
        g.fillStyle = line.includes("✓") ? "#5fc38f" : line.startsWith("$") ? "#ebecee" : "#a7abb2";
        g.fillText(line, 36, 36 + i * 34);
      });
      g.fillStyle = "#5d6168";
      g.textAlign = "right";
      g.font = "400 18px 'Atkinson Hyperlegible Next', sans-serif";
      g.fillText("Synthetic screen", w - 24, h - 40);
      g.textAlign = "left";
    },
    1280,
    720,
  );
}

// ---------- the app's call ----------

/**
 * Someone joins or leaves the call you're in: the app's wood cues (lib/sound.ts), which follow the
 * Sounds setting and make Link react. Scripts run with UPLINK_QUIET, which mutes the window.
 */
function cue(name: "join" | "leave") {
  playCue(name);
}

/** How long a call keeps going with no CallProvider mounted for its member, before it leaves. */
export const UNMOUNTED_GRACE_MS = 2 * 60_000;

/** LiveKit disconnects that end the call for good; any other reason joins again (callSession.ts). */
const FINAL_DISCONNECTS = new Set<DisconnectReason>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
  DisconnectReason.USER_REJECTED,
  DisconnectReason.USER_UNAVAILABLE,
]);

/** Said when the call ends here because the person can't be in it any more. */
const REMOVED = "You're no longer in this channel's call.";

/** What a mounted CallProvider lends the app's call: its toasts and the member's name. */
type Host = { toast(text: string, ok?: boolean): void; name: string };

type Identity = { teamId: Id<"teams">; memberId: string };

class AppCall {
  readonly key: string;
  readonly teamId: Id<"teams">;
  readonly #convex: ConvexReactClient;
  readonly session: CallSession;
  readonly media: CallMedia;
  room: Room | null = null;
  host: Host | null = null;
  state: SessionState = { status: "idle", callId: null, participationId: null, channelId: null };
  speaking: ReadonlySet<string> = new Set();
  screenView: ReadonlyMap<string, ScreenView> = new Map();
  krisp: KrispState = { state: "off", why: "not in a call" };
  /** The voice quality calls.join gave, until channels.list has the channel. */
  joinedVoice: CallQuality = "standard";
  /** Bumped on every change, for useSyncExternalStore. */
  version = 0;
  readonly #listeners = new Set<() => void>();
  /** The call's remote audio, outside React, so it plays whatever the window shows. */
  readonly #audioHost: HTMLDivElement;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;
  disposed = false;
  /** The device lists as last read, and which saved devices were unplugged (so the call fell back). */
  #inputs: Record<"audioinput" | "videoinput" | "audiooutput", DeviceOption[]> = { audioinput: [], videoinput: [], audiooutput: [] };
  #applied: Record<"audioinput" | "videoinput" | "audiooutput", string> = { audioinput: "", videoinput: "", audiooutput: "" };
  /** A device a switch to just failed on, so device events don't retry it until something's plugged in. */
  #failed: Record<"audioinput" | "videoinput", string> = { audioinput: "", videoinput: "" };
  /** Each device switch's number, by kind: a failed one rolls back only while it's the newest. */
  readonly #switches: Record<"audioinput" | "videoinput", number> = { audioinput: 0, videoinput: 0 };
  /** The device the newest switch is moving to, until it's done. */
  readonly #moving: Record<"audioinput" | "videoinput", string> = { audioinput: "", videoinput: "" };
  /** Saved devices already said to be missing, so the toast comes once. */
  readonly #toldMissing = new Set<string>();
  readonly #stops: (() => void)[] = [];

  constructor(convex: ConvexReactClient, who: Identity) {
    this.key = `${who.teamId}:${who.memberId}`;
    this.teamId = who.teamId;
    this.#convex = convex;
    this.#audioHost = document.createElement("div");
    this.#audioHost.hidden = true;
    this.#audioHost.setAttribute("aria-hidden", "true");
    this.#audioHost.dataset["callAudio"] = "";
    document.body.append(this.#audioHost);
    const teamId = this.teamId;
    const mutate = <T,>(ref: unknown, args: Record<string, unknown>) =>
      (convex.mutation as (r: unknown, a: unknown) => Promise<T>)(ref, { teamId, ...args });

    this.media = new CallMedia(
      this.#devices(),
      {
        changed: () => this.bump(),
        toast: (text, success) => this.toast(text, success),
        report: (state) => {
          const id = this.session.state.participationId;
          if (id) void mutate(api.calls.updateMedia, { participationId: id, ...state }).catch(() => {});
        },
        log: (level, message, fields) => log[level]("call.media", message, fields),
      },
      rememberedCamera(),
    );
    this.session = new CallSession({
      api: {
        join: async (target) => {
          const joined = await mutate<{ callId: string; participationId: string; url: string; token: string; callQuality: CallQuality }>(api.calls.join, {
            channelId: target,
          });
          this.joinedVoice = joined.callQuality;
          track("call_joined");
          return joined;
        },
        leave: (id) => mutate(api.calls.leave, { participationId: id }),
        heartbeat: (id) => mutate(api.calls.heartbeat, { participationId: id }),
      },
      createRoom: (events, join) => this.#createRoom(events, join.rejoin),
      onState: (state) => {
        if (this.disposed) return;
        this.state = state;
        // While this call lasts (joining and reconnecting count), the app neither offers nor does a
        // restart to update, also while no view shows it (release keeps it for UNMOUNTED_GRACE_MS).
        reportInCall(state.status !== "idle");
        if (state.status === "idle") {
          this.screenView = new Map();
          this.speaking = new Set();
          this.krisp = { state: "off", why: "not in a call" };
        }
        this.bump();
      },
      onError: (error) => this.toast(callErrorText(errorMessage(error))),
      onRejoined: () => this.toast("Your connection dropped for a moment, so you joined the call again.", true),
      onRemoved: () => this.toast(REMOVED),
      cue,
      log: (level, message, fields) => log[level]("call", message, fields),
    });

    // Devices: a choice made in a picker, and a device plugged in or unplugged, reach the call at once.
    this.#stops.push(onSavedDeviceChange(() => void this.#applyDevices("chosen")));
    this.#stops.push(onDevicesChange(() => void this.#applyDevices("plugged")));
    // Catching up: the computer woke or unlocked, the network came back, the window showed again.
    const catchUp = (why: string) => this.session.catchUp(why);
    const online = () => catchUp("online");
    const visible = () => document.visibilityState === "visible" && catchUp("visible");
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    this.#stops.push(() => window.removeEventListener("online", online));
    this.#stops.push(() => document.removeEventListener("visibilitychange", visible));
    const offPower = desktop.onPower?.((event) => {
      if (event === "resume" || event === "unlock-screen") catchUp(event);
    });
    if (offPower) this.#stops.push(offPower);
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  bump = () => {
    this.version++;
    for (const listener of this.#listeners) listener();
  };

  toast(text: string, ok?: boolean) {
    if (this.host) this.host.toast(text, ok);
    else log.info("call", "toast while no window was showing the call");
  }

  /**
   * A CallProvider for this member mounted: it gets the call, a pending leave is called off, and
   * the microphone and camera come back as the person left them (the dock's controls are back).
   */
  adopt(host: Host) {
    this.host = host;
    this.media.setSuspended(false);
    if (this.#releaseTimer) {
      clearTimeout(this.#releaseTimer);
      this.#releaseTimer = null;
      log.info("call", "picked up by the window again", { status: this.state.status });
    }
  }

  /**
   * Its CallProvider unmounted (the window shows a splash while it reconnects, or the team chooser):
   * no mute or Leave is on screen now, so the microphone is muted and the camera and any share
   * stopped at once. The call itself is kept for a while, in case the controls come back.
   */
  release(host: Host) {
    if (this.host !== host) return;
    this.host = null;
    if (this.state.status === "idle") return;
    this.media.setSuspended(true);
    log.info("call", "no view is showing the call; keeping it", { graceSeconds: UNMOUNTED_GRACE_MS / 1000 });
    this.#releaseTimer = setTimeout(() => {
      log.warn("call", "nothing picked the call up again; leaving");
      void endAppCall("no view picked it up");
    }, UNMOUNTED_GRACE_MS);
  }

  async dispose(why?: string) {
    if (this.disposed) return;
    this.disposed = true;
    reportInCall(false);
    if (this.#releaseTimer) clearTimeout(this.#releaseTimer);
    for (const stop of this.#stops.splice(0)) stop();
    await this.session.dispose(why);
    this.#audioHost.remove();
  }

  // ---------- devices ----------

  /** Opening the call's devices for CallMedia: the chosen ones, or under synthetic media an oscillator and canvases. */
  #devices(): MediaDevices {
    return {
      openMic: async (room, quality) => {
        // Leaving a call stops the synthetic microphone, so the next call makes a new one.
        if (fakeMedia && fakeMic?.readyState !== "live") fakeMic = fakeAudio();
        if (fakeMedia && fakeMic) return new LocalAudioTrack(fakeMic, undefined, true);
        const { id, choice, constraint } = await this.#deviceToOpen("audioinput");
        const mic = (await room.localParticipant.createTracks({ audio: { ...micOptions(quality).capture, ...constraint } })).find(
          (t) => t instanceof LocalAudioTrack,
        );
        if (!mic) throw new Error("No microphone was opened.");
        this.#opened("audioinput", id, choice);
        return mic;
      },
      openCamera: async (room, quality) => {
        if (fakeMedia) return new LocalVideoTrack(fakeCamera(initialsOf(this.host?.name ?? "")), undefined, true);
        const { id, choice, constraint } = await this.#deviceToOpen("videoinput");
        const camera = (await room.localParticipant.createTracks({ video: { ...cameraOptions(quality).capture, ...constraint } })).find(
          (t) => t instanceof LocalVideoTrack,
        );
        if (!camera) throw new Error("No camera was opened.");
        this.#opened("videoinput", id, choice);
        return camera;
      },
      // The screen or window picked in the main process (media.ts), at the quality's size and frame
      // rate, with the content hint on the track; with its sound when asked.
      openScreen: async (source, audio, quality) => {
        if (fakeMedia) return { video: new LocalVideoTrack(fakeScreen(), undefined, true) };
        await desktop.chooseScreenSource?.(source.id, source.name, audio);
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: shareConstraints(quality),
          audio: audio ? SHARE_AUDIO_CAPTURE : false,
        });
        const video = stream.getVideoTracks()[0];
        if (!video) {
          for (const t of stream.getTracks()) t.stop();
          throw new Error("No picture came from the screen.");
        }
        video.contentHint = SHARE[quality].contentHint;
        return { video, audio: stream.getAudioTracks()[0] };
      },
      // Krisp runs for Standard and High, never for Music.
      micPublished: async (track, quality, url) => {
        if (fakeMedia) {
          this.#setKrisp({ state: "off", why: "synthetic media" });
          return;
        }
        if (!micOptions(quality).krisp) {
          this.#setKrisp({ state: "off", why: "Music voice quality" });
          return;
        }
        await enableKrisp(url, track, (state) => this.#setKrisp(state));
      },
      stopMicOnUnpublish: !fakeMedia,
    };
  }

  #setKrisp(state: KrispState) {
    this.krisp = state;
    this.bump();
  }

  /**
   * The device to open for a kind now, read from the devices plugged in at this moment: the saved
   * one while it's there (an exact constraint), else the system default, said once per choice. An
   * exact constraint on a device that isn't there would fail the join. When the list can't say (no
   * device ids before the app may use devices), the saved one is only preferred, never required.
   */
  async #deviceToOpen(kind: "audioinput" | "videoinput"): Promise<{ id: string; choice: string; constraint: { deviceId?: ConstrainDOMString } }> {
    const choice = savedDevice(kind);
    if (choice === DEFAULT_DEVICE) return { id: DEFAULT_DEVICE, choice, constraint: deviceConstraint(kind, DEFAULT_DEVICE) };
    try {
      this.#inputs[kind] = (await listDevices(kind)).devices;
    } catch {
      // Not listed: decided below as unknown.
    }
    const listed = this.#inputs[kind].filter((d) => d.id !== DEFAULT_DEVICE);
    if (listed.length === 0) return { id: choice, choice, constraint: { deviceId: { ideal: choice } } };
    const { id, missing } = deviceFor(kind, this.#inputs[kind], choice);
    if (missing && !this.#toldMissing.has(choice)) {
      this.#toldMissing.add(choice);
      const what = kind === "audioinput" ? "microphone" : "camera";
      log.info("devices", "the chosen device isn't connected; opening the default", { kind });
      this.toast(`The ${what} you chose isn't connected, so the call uses the system default.`);
    }
    return { id, choice, constraint: deviceConstraint(kind, id) };
  }

  /**
   * A microphone or camera opened on `id`, for the choice saved when it started opening. A device
   * picked while this call's first one opened found nothing to move then, so the call moves to it
   * now: the switch queues behind this track's publish in its lane. (A pick during a later open
   * already queued its own switch.)
   */
  #opened(kind: "audioinput" | "videoinput", id: string, choice: string) {
    const first = !this.#applied[kind];
    this.#applied[kind] = id;
    if (!first || savedDevice(kind) === choice) return;
    log.info("devices", "picked while it opened; moving to it", { kind });
    void this.#applyDevices("chosen");
  }

  /** Moves the call to the devices chosen now, or back to the system default while one is unplugged. */
  async #applyDevices(why: "chosen" | "plugged" | "connected") {
    if (this.disposed) return;
    try {
      const [mics, cameras, speakers] = await Promise.all([listDevices("audioinput"), listDevices("videoinput"), listDevices("audiooutput")]);
      this.#inputs = { audioinput: mics.devices, videoinput: cameras.devices, audiooutput: speakers.devices };
    } catch {
      return;
    }
    if (why === "plugged") log.info("devices", "devices changed", { mics: this.#inputs.audioinput.length - 1, cameras: this.#inputs.videoinput.length - 1, speakers: this.#inputs.audiooutput.length - 1 });
    if (this.state.status === "idle" || this.state.status === "joining") return;
    for (const kind of ["audioinput", "videoinput"] as const) {
      const choice = savedDevice(kind);
      const { id, missing } = deviceFor(kind, this.#inputs[kind], choice);
      const before = this.#applied[kind];
      // Not opened yet: it opens on the right device when it does.
      if (!before) continue;
      // The system default moved (a headset plugged in): a track on "default" stays on the old
      // device in Chromium, so it's opened on the default again.
      const defaultMoved = id === DEFAULT_DEVICE && why === "plugged" && kind === "audioinput" && this.#defaultMoved();
      // Where the call is headed: a switch still on its way counts as done, so picking the device
      // the call had (back to the default before the switch to USB finished) isn't skipped.
      const headed = this.#moving[kind] || before;
      if (id === headed && !defaultMoved) continue;
      if (why !== "plugged" && this.#failed[kind] === id) continue;
      if (missing && before !== id) this.toast(`Your ${kind === "audioinput" ? "microphone" : "camera"} was unplugged, so the call uses the system default.`);
      else if (!missing && before === DEFAULT_DEVICE && choice !== DEFAULT_DEVICE && why === "plugged") this.toast(`Your ${kind === "audioinput" ? "microphone" : "camera"} is back.`, true);
      log.info("devices", "moving the call to a device", { kind, why, default: id === DEFAULT_DEVICE, missing });
      const target = id === DEFAULT_DEVICE && kind === "videoinput" ? (this.#inputs.videoinput[1]?.id ?? DEFAULT_DEVICE) : id;
      const request = ++this.#switches[kind];
      this.#moving[kind] = id;
      const moved = await this.media.setInputDevice(kind, target);
      const newest = request === this.#switches[kind];
      if (newest) this.#moving[kind] = "";
      if (moved) {
        this.#applied[kind] = id;
        this.#failed[kind] = "";
      } else {
        // The track went back to the device it had (callMedia.ts). A device the person just picked
        // is unpicked too, so the picker shows what the call uses; but only while it's still the
        // choice and no newer switch was asked for, so a pick made meanwhile is never overwritten.
        this.#failed[kind] = id;
        if (why === "chosen" && choice === id && savedDevice(kind) === choice && newest) saveDevice(kind, this.#applied[kind] || before);
      }
      // The newest switch is done: if the saved choice moved on meanwhile and nothing is on its way
      // there, the call follows it now rather than at the next device event.
      if (newest) this.#reconcileDevice(kind);
    }
    const speaker = deviceFor("audiooutput", this.#inputs.audiooutput, savedDevice("audiooutput")).id;
    if (speaker !== this.#applied.audiooutput && (await this.media.setOutputDevice(speaker))) {
      this.#applied.audiooutput = speaker;
      for (const element of this.#audioHost.querySelectorAll("audio")) void setSink(element, speaker);
    }
  }

  /** After the newest switch for a kind: the call moves to the saved choice if it isn't on it (and it hasn't just failed). */
  #reconcileDevice(kind: "audioinput" | "videoinput") {
    if (this.disposed || this.#moving[kind]) return;
    const { id } = deviceFor(kind, this.#inputs[kind], savedDevice(kind));
    if (id === this.#applied[kind] || id === this.#failed[kind]) return;
    log.info("devices", "the choice changed during a switch; following it", { kind });
    void this.#applyDevices("chosen");
  }

  /** Whether the microphone's track is on another device than the system default now is. */
  #defaultMoved(): boolean {
    const track = this.media.micTrack;
    const group = track?.getSettings?.().groupId;
    const systemDefault = this.#inputs.audioinput[0];
    return Boolean(group && systemDefault?.groupId && group !== systemDefault.groupId);
  }

  // ---------- the LiveKit room ----------

  #createRoom(events: { onDisconnected(why?: Disconnect): void }, rejoin: boolean) {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      audioOutput: { deviceId: savedDevice("audiooutput") },
    });
    const refresh = () => this.bump();
    // This room's audio elements only, so a stale room's cleanup never silences a newer call.
    const audio = new Set<HTMLMediaElement>();
    const lk = (level: "info" | "warn", message: string, fields?: Fields) => log[level]("call.livekit", message, fields);
    room
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        this.speaking = new Set(speakers.map((p) => memberIdOf(p.identity)));
        refresh();
      })
      .on(RoomEvent.TrackSubscribed, (remote: RemoteTrack) => {
        if (remote.kind === Track.Kind.Audio) {
          const element = remote.attach();
          element.muted = fakeMedia;
          audio.add(element);
          this.#audioHost.append(element);
          const speaker = savedDevice("audiooutput");
          if (speaker !== DEFAULT_DEVICE) void setSink(element, speaker);
        }
        lk("info", "track subscribed", { kind: remote.kind, source: remote.source });
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (remote: RemoteTrack) => {
        remote.detach().forEach((element) => {
          element.remove();
          audio.delete(element);
        });
        lk("info", "track unsubscribed", { kind: remote.kind, source: remote.source });
        refresh();
      })
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, (publication) => {
        lk("info", "published", { source: publication.source });
        refresh();
      })
      .on(RoomEvent.LocalTrackUnpublished, (publication) => {
        lk("info", "unpublished", { source: publication.source });
        this.media.unpublished(publication.source);
        refresh();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        lk("info", "someone joined", { others: room.remoteParticipants.size });
        cue("join");
        refresh();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        lk("info", "someone left", { others: room.remoteParticipants.size });
        cue("leave");
        refresh();
      })
      .on(RoomEvent.ConnectionStateChanged, (state) => lk("info", "connection state", { state }))
      .on(RoomEvent.SignalReconnecting, () => lk("warn", "signal reconnecting"))
      .on(RoomEvent.MediaDevicesError, (error: Error) => lk("warn", "device error", errorFields(error)))
      .on(RoomEvent.ActiveDeviceChanged, (kind: MediaDeviceKind) => lk("info", "active device changed", { kind }))
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant === room.localParticipant) lk(quality === "poor" || quality === "lost" ? "warn" : "info", "connection quality", { quality });
      })
      // A full reconnect republishes every track: media changes wait for it, then reconcile.
      .on(RoomEvent.Reconnecting, () => {
        this.session.setReconnecting(true);
        this.media.setReconnecting(true);
      })
      .on(RoomEvent.Reconnected, () => {
        this.session.setReconnecting(false);
        this.media.setReconnecting(false);
        // A reconnect after a long silence: make sure the room still has this join.
        this.session.catchUp("livekit reconnected");
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        const name = reason === undefined ? "UNKNOWN_REASON" : (DisconnectReason[reason] ?? String(reason));
        events.onDisconnected({ reason: name, final: reason !== undefined && FINAL_DISCONNECTS.has(reason) });
      });
    this.room = room;
    this.#applied = { audioinput: "", videoinput: "", audiooutput: savedDevice("audiooutput") };
    this.media.attach(room, rejoin);
    return {
      connect: async (url: string, token: string) => {
        await room.connect(url, token);
        void this.#applyDevices("connected");
      },
      enableMicrophone: async (url: string) => {
        await this.media.startMicrophone(this.joinedVoice, url);
        const id = this.session.state.participationId;
        if (id) {
          void (this.#convex.mutation as (r: unknown, a: unknown) => Promise<unknown>)(api.calls.updateMedia, {
            teamId: this.teamId,
            participationId: id,
            muted: this.media.muted,
            camera: this.media.camera,
            screen: false,
          }).catch(() => {});
        }
        refresh();
      },
      disconnect: async () => {
        // First, so a replacement still opening a device for this room stops it instead of publishing.
        this.media.detach(room);
        room.removeAllListeners();
        await room.disconnect();
        if (this.room === room) this.room = null;
        for (const element of audio) element.remove();
        audio.clear();
      },
    };
  }

  tiles(): CallTile[] {
    const room = this.room;
    if (!room || this.state.status === "idle") return [];
    const participants: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    return participants.map((p) => ({
      identity: memberIdOf(p.identity),
      join: p.identity,
      isLocal: p === room.localParticipant,
      camera: visible(p.getTrackPublication(Track.Source.Camera)?.track),
      screen: visible(p.getTrackPublication(Track.Source.ScreenShare)?.track),
    }));
  }
}

/** The app's one call, for the member whose team is open. */
let appCall: AppCall | null = null;

function acquireAppCall(convex: ConvexReactClient, who: Identity): AppCall {
  const key = `${who.teamId}:${who.memberId}`;
  if (appCall && !appCall.disposed && appCall.key === key) return appCall;
  // Another team or another person: the old call ends now.
  if (appCall) void appCall.dispose("another team opened");
  appCall = new AppCall(convex, who);
  return appCall;
}

/** Ends the app's call now: signing out, closing the window. */
export async function endAppCall(why = "signed out"): Promise<void> {
  const ending = appCall;
  appCall = null;
  await ending?.dispose(why);
}

// Closing (or reloading) the window leaves the call.
if (typeof window !== "undefined") window.addEventListener("beforeunload", () => void endAppCall("the window closed"));

/** The heartbeat's and Krisp's state, for "Copy diagnostics". */
export function callDiagnostics(): Record<string, string | number | boolean | null> {
  const call = appCall;
  if (!call) return { status: "no call" };
  const presence = call.session.presence;
  return {
    status: call.state.status,
    join: call.state.participationId?.slice(0, 8) ?? null,
    livekit: call.room?.state ?? "none",
    beats: presence.beats,
    heartbeatFailures: presence.failures,
    lastHeartbeatSecondsAgo: presence.lastOkSecondsAgo,
    rejoins: presence.rejoins,
    muted: call.media.muted,
    camera: call.media.camera,
    sharing: call.media.screen,
    krisp: call.krisp.state,
    krispWhy: call.krisp.why,
    microphone: savedDevice("audioinput") === DEFAULT_DEVICE ? "system default" : "chosen",
    speaker: savedDevice("audiooutput") === DEFAULT_DEVICE ? "system default" : "chosen",
    cameraDevice: savedDevice("videoinput") === DEFAULT_DEVICE ? "first camera" : "chosen",
  };
}

// ---------- provider ----------

export function CallProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const toast = useToast();
  const convex = useConvex();
  const live = useLiveCalls();
  const channels = useRoomQuery(api.channels.list, {});
  const limit = useRoomQuery(api.teams.settings, {})?.callQualityLimit ?? "none";
  const teamId = session.teamId;
  const memberId = session.me.memberId;

  // The app's call for this member, picked up on mount and let go (not ended) on unmount.
  const [call, setCall] = useState<AppCall | null>(null);
  // The toast and name through a ref: picking the call up and letting it go mute and unmute it, so
  // that happens on mount and unmount only, never because a callback changed identity.
  const lent = useRef({ toast, name: session.me.name });
  lent.current = { toast, name: session.me.name };
  useEffect(() => {
    const current = acquireAppCall(convex, { teamId, memberId });
    const host: Host = {
      toast: (text, ok) => lent.current.toast.show(text, ok),
      get name() {
        return lent.current.name;
      },
    };
    current.adopt(host);
    setCall(current);
    return () => current.release(host);
    // The name only names the synthetic camera; it doesn't change which call this is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, teamId, memberId]);

  const subscribe = useCallback((listener: () => void) => call?.subscribe(listener) ?? (() => {}), [call]);
  const version = useSyncExternalStore(subscribe, () => call?.version ?? -1);
  const state = call?.state ?? { status: "idle" as const, callId: null, participationId: null, channelId: null };
  const callId = state.callId as Id<"calls"> | null;
  const channelId = state.channelId as Id<"channels"> | null;
  const status = state.status;

  const join = useCallback(async (target: Id<"channels">) => call?.session.join(target), [call]);
  const leave = useCallback(async () => call?.session.leave(), [call]);

  // The call is gone from calls.live for this person (it ended, or they can't see its channel any
  // more): it ends here, whatever LiveKit's own removal is still doing. Listed without this person
  // (the room dropped the join, after a sleep): ask the room directly. A heartbeat it refuses joins
  // again; one it accepts means the list was behind.
  useEffect(() => {
    if (!call || !callId || status !== "connected" || live === undefined) return;
    const mine = live.find((c) => c.callId === callId);
    if (!mine) {
      call.toast(REMOVED);
      void call.session.ended();
    } else if (!mine.participants.some((p) => p.memberId === memberId)) call.session.catchUp("not listed in the call");
  }, [call, callId, status, live, memberId]);

  // The channel's voice quality, live: someone changing it mid-call republishes this microphone
  // with the new setting (issue #87). Until channels.list has the channel, what calls.join said.
  const voice: CallQuality = channels?.find((c) => c.channelId === channelId)?.callQuality ?? call?.joinedVoice ?? "standard";
  useEffect(() => call?.media.setVoice(voice), [call, voice]);
  // The team's limit, live: a share or camera above a lowered limit is replaced.
  useEffect(() => call?.media.setLimit(limit), [call, limit]);

  const media = call?.media;
  const participationId = state.participationId;
  const toggleMute = useCallback(async () => {
    if (participationId) await call?.media.toggleMute();
  }, [call, participationId]);
  // The camera's on or off takes effect at once: not awaited, so turning it off never waits for a
  // camera still opening (CallMedia stops that one instead of publishing it).
  const toggleCamera = useCallback(async () => {
    if (participationId && call) void call.media.setCamera(!call.media.camera);
  }, [call, participationId]);
  const setCameraQuality = useCallback(async (quality: CameraQuality) => {
    await call?.media.setCameraQuality(quality);
  }, [call]);
  const shareScreen = useCallback(
    async (source: { id: string; name: string }, audio: boolean, quality: ShareQuality) => {
      if (participationId) await call?.media.shareScreen(source, audio, quality);
    },
    [call, participationId],
  );
  const stopScreen = useCallback(async () => {
    await call?.media.stopScreen();
  }, [call]);
  const changeShareQuality = useCallback(async (quality: ShareQuality) => {
    await call?.media.changeShareQuality(quality);
  }, [call]);

  const setScreenView = useCallback(
    (joinId: string, view: ScreenView) => {
      if (!call) return;
      call.screenView = new Map(call.screenView).set(joinId, view);
      call.bump();
    },
    [call],
  );
  const screenView = call?.screenView ?? EMPTY_VIEWS;
  // Low asks LiveKit for the share's low layer, whatever the tile's size; Auto lets adaptive stream
  // pick again. Applied again when a share starts over (a new publication).
  useEffect(() => {
    const room = call?.room;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      const publication = participant.getTrackPublication(Track.Source.ScreenShare) as RemoteTrackPublication | undefined;
      if (!publication?.isSubscribed) continue;
      publication.setVideoQuality(screenView.get(participant.identity) === "low" ? VideoQuality.LOW : VideoQuality.HIGH);
    }
  }, [call, screenView, version]);

  // `version` changes whenever a track or participant changes.
  const tiles = useMemo<CallTile[]>(() => (version < 0 || !call ? [] : call.tiles()), [call, version]);
  const speaking = call?.speaking ?? EMPTY_SPEAKING;
  const muted = media?.muted ?? false;
  const camera = media?.camera ?? false;
  const screen = media?.screen ?? false;
  const shareQuality = media?.shareQuality ?? null;
  const cameraQuality = media?.cameraQuality ?? rememberedCamera();
  const micTrack = status === "idle" ? null : (media?.micTrack ?? null);
  const selfCamera = status === "idle" ? null : (media?.cameraTrack ?? null);
  const krisp = call?.krisp ?? IDLE_KRISP;
  const value = useMemo<CallContextValue>(
    () => ({
      callId,
      channelId,
      status,
      muted,
      camera,
      screen,
      speaking,
      tiles,
      join,
      leave,
      toggleMute,
      toggleCamera,
      shareScreen,
      stopScreen,
      shareQuality,
      changeShareQuality,
      voice,
      screenView,
      setScreenView,
      cameraQuality,
      setCameraQuality,
      micTrack,
      selfCamera,
      krisp,
    }),
    // `version` stands for the media fields read off the call (muted, camera and the rest).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [callId, channelId, status, muted, camera, screen, speaking, tiles, join, leave, toggleMute, toggleCamera, shareScreen, stopScreen, shareQuality, changeShareQuality, voice, screenView, setScreenView, cameraQuality, setCameraQuality, micTrack, selfCamera, krisp, version],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

const EMPTY_VIEWS: ReadonlyMap<string, ScreenView> = new Map();
const EMPTY_SPEAKING: ReadonlySet<string> = new Set();
const IDLE_KRISP: KrispState = { state: "off", why: "not in a call" };

function visible(t: Track | undefined): Track | undefined {
  return t && !t.isMuted ? t : undefined;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

async function setSink(element: HTMLMediaElement, deviceId: string) {
  try {
    await (element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(deviceId === DEFAULT_DEVICE ? "" : deviceId);
  } catch {
    // The element stays on the system's speaker.
  }
}

/** The synthetic microphone, made once and published again when the voice quality changes. */
let fakeMic: MediaStreamTrack | null = null;

/** How long each step of turning Krisp on may take before the app gives up on it. */
export const KRISP_STEP_MS = 15_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`Krisp: ${what} didn't finish within ${ms / 1000} seconds`), { name: "KrispTimeout" })), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The parts of Krisp's processor the app uses. */
type KrispProcessor = {
  init(options: unknown): Promise<void>;
  setEnabled(enable: boolean): Promise<unknown>;
  isEnabled(): boolean;
  destroy?(): Promise<void> | void;
  processedTrack?: MediaStreamTrack;
};

/**
 * Krisp's processor with a time limit on its `init`. LiveKit runs a processor's init while it holds
 * the track's lock and keeps the processor only once init succeeds: an init that never settles
 * would hold the lock (and every later device switch) for good, and one that fails leaves LiveKit
 * nothing to take off. With the limit, `setProcessor` fails in time and lets go of the lock.
 *
 * `giveUp` is for the setup's own time limit: `setProcessor` can still be waiting for the track's
 * lock then (a device switch holds it), and would run init once it's free. After `giveUp`, init
 * fails at once, so LiveKit never keeps it.
 */
function limitInit<P extends KrispProcessor>(processor: P, ms: number): { processor: P; giveUp(): void } {
  let givenUp = false;
  const limited = new Proxy(processor, {
    get(target, key) {
      if (key === "init")
        return (options: unknown) =>
          givenUp
            ? Promise.reject(Object.assign(new Error("Krisp: setup was given up on"), { name: "KrispTimeout" }))
            : within(target.init(options), ms, "init");
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { processor: limited, giveUp: () => void (givenUp = true) };
}

/**
 * Takes Krisp back off a microphone after it failed or didn't turn on: off the track if LiveKit
 * has it, destroyed either way (it can change the capture before it fails), and the browser's noise
 * suppression, echo cancellation and auto gain put back on the capture, which Krisp turns off
 * while it runs. Each step is bounded, so nothing here can hang the call.
 */
async function undoKrisp(mic: LocalAudioTrack, processor: KrispProcessor | undefined, ms: number): Promise<void> {
  if (mic.getProcessor()) await within(mic.stopProcessor(), ms, "stopProcessor").catch(() => log.warn("krisp", "couldn't take it off the track"));
  if (processor) await within(Promise.resolve(processor.destroy?.()), ms, "destroy").catch(() => {});
  try {
    await within(mic.mediaStreamTrack.applyConstraints({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }), ms, "restore");
    log.info("krisp", "browser noise suppression restored");
  } catch (error) {
    log.warn("krisp", "couldn't restore the browser's noise suppression", errorFields(error));
  }
}

/**
 * Krisp noise cancellation, on LiveKit Cloud only (it doesn't run against the open-source server).
 * Each step is logged, with why it's off when it is, and each has a time limit (`stepMs`). A failure,
 * a step that never settles or a Krisp that doesn't turn on is taken back off the microphone, with
 * the browser's own noise suppression put back (undoKrisp). Before 0.2.3 the app's policy refused
 * Krisp's WebAssembly (csp.ts), so Krisp never turned on and its enable step never settled.
 */
export async function enableKrisp(
  url: string,
  mic: Track | undefined,
  report: (state: KrispState) => void = () => {},
  stepMs = KRISP_STEP_MS,
): Promise<void> {
  if (!mic || !(mic instanceof LocalAudioTrack)) return;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL: not LiveKit Cloud.
  }
  if (!host.endsWith(".livekit.cloud")) {
    report({ state: "off", why: "not LiveKit Cloud" });
    log.info("krisp", "off", { why: "not LiveKit Cloud" });
    return;
  }
  report({ state: "starting", why: "" });
  log.info("krisp", "starting");
  let processor: KrispProcessor | undefined;
  try {
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import("@livekit/krisp-noise-filter");
    if (!isKrispNoiseFilterSupported()) {
      report({ state: "off", why: "not supported here" });
      log.warn("krisp", "off", { why: "not supported here" });
      return;
    }
    processor = KrispNoiseFilter() as unknown as KrispProcessor;
    const limited = limitInit(processor, stepMs);
    const setting = mic.setProcessor(limited.processor as never);
    try {
      await within(setting, stepMs * 2, "setProcessor");
    } catch (error) {
      // Given up on: an init still waiting for the track's lock fails at once when it gets it. One
      // already running can still finish and LiveKit then keeps it, so it's taken off again then.
      limited.giveUp();
      const late = processor;
      void setting.then(
        async () => {
          if (mic.getProcessor() !== (limited.processor as unknown)) return;
          log.warn("krisp", "attached after it was given up on; taking it off");
          await undoKrisp(mic, late, stepMs);
        },
        () => {},
      );
      throw error;
    }
    await within(processor.setEnabled(true), stepMs, "setEnabled");
    if (processor.isEnabled()) {
      report({ state: "on", why: "" });
      // livekit-client tells the room Krisp is on (audio feature 5, TF_ENHANCED_NOISE_CANCELLATION)
      // when the processed track fires `enable-lk-krisp-noise-filter`. Krisp 0.4.5 carries its own
      // copy of livekit-client and never fires it, so the room heard nothing; it's fired here once
      // Krisp says it's on.
      processor.processedTrack?.dispatchEvent(new Event("enable-lk-krisp-noise-filter"));
      log.info("krisp", "on", { told: mic.enhancedNoiseCancellation });
    } else {
      report({ state: "off", why: "didn't turn on" });
      log.warn("krisp", "off", { why: "didn't turn on" });
      await undoKrisp(mic, processor, stepMs);
    }
  } catch (error) {
    const fields = errorFields(error);
    report({ state: "failed", why: fields.type });
    log.warn("krisp", "failed; putting the browser's noise suppression back", fields);
    await undoKrisp(mic, processor, stepMs);
  }
}

/** A call error in words people use: the backend's "deployment" means this team's server. */
export function callErrorText(message: string): string {
  if (/aren't set up on this deployment/i.test(message)) {
    return "Calls aren't turned on for this team yet. A team admin can set them up.";
  }
  return /[.!?]$/.test(message) ? message : `${message}.`;
}
