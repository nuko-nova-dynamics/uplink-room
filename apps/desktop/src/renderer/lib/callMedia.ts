/**
 * The call's own media while its quality changes (issue #87, PR #89 review): the microphone at the
 * channel's voice quality, the camera, and a screen share, each replaced when its quality changes.
 *
 * - Each kind keeps what the person wants (muted, camera on, the share and its quality, the
 *   channel's voice) apart from what is published, and runs its replacements one at a time, in
 *   lanes that belong to one room: a device open that never settles holds up only its own call.
 * - What is applied is read from the room's publications, never assumed: a publication counts as
 *   this class's only while it holds the track this class published.
 * - Changes wait while the call's first microphone is starting or LiveKit is republishing after a
 *   full reconnect; then one pass reconciles each kind, leaving at most one publication per source.
 * - After every wait (opening a device, publishing) a replacement checks that its room is still
 *   the call's and that nothing overtook it. A stale track is stopped at once, never published; an
 *   open that resolves after its call has gone is stopped too.
 * - A mute or an off pressed mid-replacement is the latest wish, applied to the new track before
 *   and after it publishes. A failed microphone replacement puts the old quality back; a
 *   microphone that still can't open comes back when you unmute.
 * - Lowering the team's limit lowers a running share and camera; every replacement rechecks it.
 * - Choosing another microphone or camera (lib/devices.ts) moves the published track to it, in
 *   that kind's lane, so a device switch never races a quality change. The speaker is switched
 *   on the room (`switchActiveDevice`).
 * - Krisp turning on after a microphone publishes is never waited for: it can't hold up the call.
 * - What the person wants (muted, camera on) lives outside any room: leaving a room keeps it, a
 *   join the session makes on its own (the room had dropped the old one) applies it to the new
 *   room, and only a join the person asks for starts over unmuted with the camera off. A screen
 *   share needs the picker again.
 * - While no window shows the call's controls (`setSuspended`), the microphone is muted and the
 *   camera and any share are stopped at once, even mid-reconnect, without changing what the person
 *   wants; both come back when the controls do.
 * - A device switch that fails reopens the device the track had, so a failed switch never leaves
 *   the call without a microphone or camera.
 * - A mute goes on at once, never behind a device that's still opening. An unmute waits its turn
 *   in the microphone's lane, behind any device switch, and reads the wish again after every wait;
 *   a device it needs opens while the microphone is still muted. So a Mute pressed while a device
 *   opens is never undone by the unmute before it (PR #98 review, round 2).
 */
import { type LocalAudioTrack, type LocalTrackPublication, type LocalVideoTrack, type Room, Track } from "livekit-client";
import {
  cameraOptions,
  effectiveCamera,
  effectiveShare,
  micOptions,
  rememberCamera,
  SHARE_AUDIO_PUBLISH,
  shareAllowed,
  sharePublish,
  VOICE,
  type CallQuality,
  type CallQualityLimit,
  type CameraQuality,
  type ShareQuality,
} from "./callQuality";
import { errorMessage } from "./errors";

export type ShareSource = { id: string; name: string };
/** The system's default microphone (lib/devices.ts, DEFAULT_DEVICE). */
const DEFAULT_ID = "default";
/** What a screen capture gave: its picture, and its sound when asked for. */
export type ScreenCapture = { video: MediaStreamTrack | LocalVideoTrack; audio?: MediaStreamTrack };

/** Opening devices, real or synthetic (call.tsx). */
export type MediaDevices = {
  openMic(room: Room, quality: CallQuality): Promise<LocalAudioTrack>;
  openCamera(room: Room, quality: CameraQuality): Promise<LocalVideoTrack>;
  openScreen(source: ShareSource, audio: boolean, quality: ShareQuality): Promise<ScreenCapture>;
  /** After a microphone publishes, such as turning Krisp on. Not waited for. */
  micPublished?(track: LocalAudioTrack, quality: CallQuality, url: string): Promise<void>;
  /** Whether unpublishing the microphone stops its device (the synthetic one is kept). */
  stopMicOnUnpublish: boolean;
};

export type MediaEvents = {
  /** Something the app shows changed. */
  changed(): void;
  toast(text: string, success?: boolean): void;
  /** For people outside the call (calls.updateMedia). */
  report(media: { muted?: boolean; camera?: boolean; screen?: boolean }): void;
  /** One line for the diagnostic log (lib/log.ts). */
  log?(level: "info" | "warn" | "error", message: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
};

/** Runs tasks one after another; a failed task doesn't stop the next. */
class Lane {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => {});
    return result;
  }
}

/** One room's lanes. A new room gets new ones, so nothing stuck in an old call can hold it up. */
const lanes = () => ({ mic: new Lane(), camera: new Lane(), share: new Lane() });

const stopCapture = (capture: ScreenCapture) => {
  capture.video.stop();
  capture.audio?.stop();
};

/**
 * Whether LiveKit still has to open a device for this track, as its unmute decides it: a switch made
 * while muted (which LiveKit only notes, `pendingDeviceChange`, and opens on unmute) or a capture
 * that ended. Both are read from livekit-client 2.23's track, where they're protected: the capture
 * is `_mediaStreamTrack` (`mediaStreamTrack` is Krisp's processed track while Krisp runs).
 */
function needsDevice(track: LocalAudioTrack | LocalVideoTrack): boolean {
  const inner = track as unknown as { pendingDeviceChange?: boolean; _mediaStreamTrack?: MediaStreamTrack };
  return inner.pendingDeviceChange === true || (inner._mediaStreamTrack ?? track.mediaStreamTrack)?.readyState === "ended";
}

/**
 * Puts a track on a device. For a muted microphone LiveKit only notes the device and opens it on
 * unmute, inside the unmute; it's opened here instead, still muted (LiveKit's restart keeps a muted
 * track disabled), so a device that won't open fails now and an unmute never waits on one.
 */
async function moveTo(track: LocalAudioTrack | LocalVideoTrack, device: ConstrainDOMString): Promise<boolean> {
  const exact = await track.setDeviceId(device);
  if (track.isMuted && needsDevice(track)) await track.restartTrack();
  return exact;
}

/** How long a replacement waits for a device before giving up on it (a call's first microphone waits for the person). */
export const OPEN_TIMEOUT_MS = 30_000;

export function voiceToast(quality: CallQuality): string {
  return quality === "music"
    ? "Voice quality is now Music: stereo, with noise suppression and auto gain off."
    : `Voice quality is now ${VOICE[quality].label}.`;
}

type Share = { source: ShareSource; audio: boolean; quality: ShareQuality };
type Published<Q> = { track: unknown; quality: Q } | null;

export class CallMedia {
  readonly #devices: MediaDevices;
  readonly #events: MediaEvents;
  #room: Room | null = null;
  /** Moves on when a room is attached or detached, so work for an old one stops. */
  #generation = 0;
  #lanes = lanes();
  #url = "";
  #limit: CallQualityLimit = "none";
  /** False until the call's first microphone has started; changes wait until then. */
  #started = false;
  /** True while LiveKit republishes after a full reconnect; changes wait until it's done. */
  #reconnecting = false;

  #voice: CallQuality = "standard";
  /** Whether the channel's voice quality has been set for this room, so startup doesn't go back to calls.join's. */
  #voiceSet = false;
  #mic: Published<CallQuality> = null;
  #muted = false;

  #cameraOn = false;
  #cameraQuality: CameraQuality;
  #camera: Published<CameraQuality> = null;
  /** Each camera request's number: an older one's failure doesn't undo a newer one. */
  #cameraRequest = 0;

  #share: Share | null = null;
  /** True while no window shows the call's controls: the microphone is muted and the camera off. */
  #suspended = false;
  #shareApplied: { want: Share; track: unknown } | null = null;
  /** What the room was last told about sharing (calls.updateMedia). */
  #reportedScreen = false;
  /** Unpublishes the app makes itself, so they aren't read as the person ending the share. */
  #ownUnpublishes = 0;

  constructor(devices: MediaDevices, events: MediaEvents, cameraQuality: CameraQuality) {
    this.#devices = devices;
    this.#events = events;
    this.#cameraQuality = cameraQuality;
  }

  get muted() {
    return this.#muted;
  }
  get camera() {
    return this.#cameraOn;
  }
  get cameraQuality() {
    return this.#cameraQuality;
  }
  get screen() {
    return this.#share !== null;
  }
  get shareQuality(): ShareQuality | null {
    return this.#share?.quality ?? null;
  }

  // ---------- the room ----------

  /**
   * A call's room, with fresh lanes. A join the person asked for starts unmuted with the camera off;
   * `keep` (a join the session made on its own) applies what the person wanted in the room before:
   * the microphone muted if it was, the camera on if it was.
   */
  attach(room: Room, keep = false) {
    if (!keep) {
      this.#muted = false;
      this.#cameraOn = false;
    }
    this.#room = room;
    this.#begin();
    if (keep) {
      this.#events.log?.("info", "keeping what you chose", { muted: this.#muted, camera: this.#cameraOn });
      if (this.#muted || this.#cameraOn) this.#events.report({ muted: this.#micMuted(), camera: this.#cameraWanted() });
    }
  }

  /**
   * The call's room is going: work still opening devices for it stops them instead of publishing.
   * What the person wants (muted, camera on) stays for the next room; a share ends with its room.
   */
  detach(room: Room) {
    if (this.#room !== room) return;
    this.#room = null;
    this.#begin();
  }

  /** Resets what belongs to one room. Never what the person wants. */
  #begin() {
    this.#generation++;
    this.#lanes = lanes();
    this.#started = false;
    this.#reconnecting = false;
    this.#voiceSet = false;
    this.#mic = null;
    this.#camera = null;
    this.#share = null;
    this.#shareApplied = null;
    this.#reportedScreen = false;
    this.#events.changed();
  }

  /** The microphone is muted when the person muted it, or while no window shows the call's controls. */
  #micMuted() {
    return this.#muted || this.#suspended;
  }

  #cameraWanted() {
    return this.#cameraOn && !this.#suspended;
  }

  /**
   * No window shows the call's controls (true), or one does again (false). Suspended, the microphone
   * is muted and the camera and any share are stopped, so nothing is captured that the person
   * can't see or stop; resuming applies what they wanted. The room is told either way.
   */
  setSuspended(suspended: boolean) {
    if (suspended === this.#suspended) return;
    this.#suspended = suspended;
    this.#events.log?.("info", suspended ? "no controls on screen: microphone muted, camera off" : "controls back: as you chose", {
      muted: this.#muted,
      camera: this.#cameraOn,
    });
    if (suspended) {
      this.#share = null;
      if (this.#room) void this.#stopCaptureNow(this.#room);
    }
    this.#events.report({ muted: this.#micMuted(), camera: this.#cameraWanted() });
    this.#events.changed();
    void this.#applyMute();
    void this.#syncCamera(++this.#cameraRequest);
  }

  get suspended() {
    return this.#suspended;
  }

  /**
   * Suspended: the camera and any share stop at the device now. Not through the lanes, which can be
   * waiting on a device, nor the reconnect guards: during a full reconnect LiveKit republishes what
   * it holds and restarts an unmuted camera first, so the camera is muted as well as stopped and
   * unpublished. Work still opening one sees the suspension and stops its track.
   */
  async #stopCaptureNow(room: Room) {
    const camera = new Set<LocalVideoTrack>();
    for (const p of this.#publications(room, Track.Source.Camera)) if (p.track) camera.add(p.track as LocalVideoTrack);
    if (this.#camera) camera.add(this.#camera.track as LocalVideoTrack);
    const share = new Set<{ stop(): void }>();
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      for (const p of this.#publications(room, source)) if (p.track) share.add(p.track);
    }
    this.#camera = null;
    this.#shareApplied = null;
    this.#reportScreen(false);
    for (const track of [...camera, ...share]) track.stop();
    this.#ownUnpublishes++;
    try {
      await Promise.all([
        ...[...camera].map((track) => track.mute().catch(() => {})),
        ...[...camera, ...share].map((track) => room.localParticipant.unpublishTrack(track as LocalVideoTrack).catch(() => {})),
      ]);
    } finally {
      this.#ownUnpublishes--;
    }
    this.#events.log?.("info", "capture stopped", { cameras: camera.size, shares: share.size, reconnecting: this.#reconnecting });
    this.#events.changed();
  }

  /**
   * Puts the microphone's mute in line with what's wanted now. A mute goes on at once, outside the
   * lane, so it never waits behind a device that's still opening (LiveKit's own lock puts it after
   * an unmute already under way, never before). Then, queued behind any device work, the lane
   * settles it from the wish as it is by then; that also brings back a missing microphone when
   * unmuted. Not awaited: the button never waits for a device.
   */
  async #applyMute(): Promise<void> {
    const now = this.#now();
    if (!now) return;
    const [room, generation] = now;
    void this.#lanes.mic.run(() => this.#settleMute(room, generation)).catch((error: unknown) => this.#events.toast(errorMessage(error)));
    if (this.#micMuted()) await this.#muteNow(room);
  }

  /** Every microphone track this call has, muted now. */
  async #muteNow(room: Room) {
    const tracks = new Set<LocalAudioTrack>();
    for (const p of this.#publications(room, Track.Source.Microphone)) if (p.track) tracks.add(p.track as LocalAudioTrack);
    if (this.#mic) tracks.add(this.#mic.track as LocalAudioTrack);
    await Promise.all([...tracks].map((track) => track.mute().catch(() => {})));
  }

  /**
   * In the microphone's lane: the published microphone's mute as wanted, read again after every
   * wait. An unmute that needs a device (picked while muted, or one that ended) opens it first,
   * still muted: LiveKit's own unmute would turn the sound on as soon as that device opened, after
   * a Mute pressed meanwhile had already looked and found the microphone muted.
   */
  async #settleMute(room: Room, generation: number) {
    for (let pass = 0; pass < 4 && this.#isCurrent(room, generation); pass++) {
      const track = this.#publication(room, Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
      const muted = this.#micMuted();
      if (!track) {
        // Unmuting brings back a microphone the room doesn't have (queued after this).
        if (!muted) void this.#syncMic();
        return;
      }
      if (track.isMuted === muted) return;
      if (muted) await track.mute();
      else if (needsDevice(track)) await track.restartTrack();
      else await track.unmute();
    }
  }

  /** After a device opened for the microphone: a Mute pressed meanwhile goes on before anything else. */
  async #keepMuted(track: LocalAudioTrack | LocalVideoTrack) {
    if (track.kind === Track.Kind.Audio && this.#micMuted() && !track.isMuted) await track.mute();
  }

  #isCurrent(room: Room, generation: number) {
    return this.#room === room && this.#generation === generation;
  }

  /** The room and generation now, for work that has to stop if either moves on. */
  #now(): [Room, number] | null {
    return this.#room ? [this.#room, this.#generation] : null;
  }

  /** Whether changes run now, or wait for startup or a reconnect to finish. */
  #ready() {
    return this.#started && !this.#reconnecting;
  }

  #publications(room: Room, source: Track.Source): LocalTrackPublication[] {
    return [...room.localParticipant.trackPublications.values()].filter((p) => p.source === source);
  }

  #publication(room: Room, source: Track.Source): LocalTrackPublication | undefined {
    return this.#publications(room, source)[0];
  }

  /** What this class published for a source, if the room still has it; null otherwise. */
  #applied<Q>(room: Room, source: Track.Source, published: Published<Q>): Q | null {
    return published && this.#publications(room, source).some((p) => p.track === published.track) ? published.quality : null;
  }

  /** At most one publication per source: keeps this class's own track, else the newest. */
  async #dedupe(room: Room, source: Track.Source, keep: unknown) {
    const all = this.#publications(room, source);
    if (all.length < 2) return;
    const kept = all.find((p) => p.track === keep) ?? all.at(-1)!;
    this.#ownUnpublishes++;
    try {
      for (const p of all) if (p !== kept && p.track) await room.localParticipant.unpublishTrack(p.track).catch(() => {});
    } finally {
      this.#ownUnpublishes--;
    }
  }

  /** A device open a replacement waits on: bounded, and a late track is stopped. */
  #bounded<T>(open: Promise<T>, what: string, stop: (value: T) => void): Promise<T> {
    let timedOut = false;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`The ${what} didn't open within ${OPEN_TIMEOUT_MS / 1000} seconds.`));
      }, OPEN_TIMEOUT_MS);
      open.then(
        (value) => {
          clearTimeout(timer);
          if (timedOut) stop(value);
          else resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** LiveKit's full reconnect: changes wait while it republishes, then each kind is reconciled. */
  setReconnecting(reconnecting: boolean) {
    if (reconnecting === this.#reconnecting) return;
    this.#reconnecting = reconnecting;
    if (!reconnecting) this.#reconcile();
  }

  #reconcile() {
    if (!this.#ready()) return;
    void this.#syncMic();
    void this.#syncCamera(this.#cameraRequest);
    void this.#syncShare();
  }

  // ---------- the team's limit ----------

  /** The team's limit changed: a share or camera above it is replaced with the best it allows. */
  setLimit(limit: CallQualityLimit) {
    if (limit === this.#limit) return;
    this.#events.log?.("info", "team limit changed", { from: this.#limit, to: limit });
    this.#limit = limit;
    if (this.#share && !shareAllowed(this.#share.quality, limit)) {
      this.#share = { ...this.#share, quality: effectiveShare(this.#share.quality, limit) };
      this.#events.changed();
      void this.#syncShare();
    }
    // The camera follows the limit both ways: down to 720p, and back to the chosen 1080p.
    if (this.#cameraOn) void this.#syncCamera(this.#cameraRequest);
  }

  // ---------- microphone ----------

  /**
   * A join's first microphone, at the channel's quality (calls.join's, unless the channel's
   * changed since). Publishes only if the room has no microphone yet. Throws when it can't open,
   * so the join fails. Changes made meanwhile are applied once it's done.
   */
  async startMicrophone(quality: CallQuality, url: string): Promise<void> {
    this.#url = url;
    if (!this.#voiceSet) this.#voice = quality;
    const now = this.#now();
    if (!now) return;
    const [room, generation] = now;
    await this.#lanes.mic.run(async () => {
      if (!this.#isCurrent(room, generation) || this.#publication(room, Track.Source.Microphone)) return;
      await this.#publishMic(room, generation, this.#voice, false);
    });
    // Started: apply what changed meanwhile. (A failed start throws above, and the join ends.)
    if (this.#isCurrent(room, generation)) {
      this.#started = true;
      this.#reconcile();
    }
  }

  /** The channel's voice quality, as the room has it now. A change replaces the microphone. */
  setVoice(quality: CallQuality) {
    this.#voiceSet = true;
    if (quality === this.#voice) return;
    this.#events.log?.("info", "voice quality changed", { from: this.#voice, to: quality });
    this.#voice = quality;
    void this.#syncMic();
  }

  async toggleMute(): Promise<void> {
    this.#muted = !this.#muted;
    this.#events.report({ muted: this.#micMuted() });
    this.#events.changed();
    await this.#applyMute();
  }

  #syncMic(): Promise<void> {
    const now = this.#now();
    if (!now || !this.#ready()) return Promise.resolve();
    return this.#lanes.mic.run(() => this.#replaceMic(...now)).catch(() => {});
  }

  async #replaceMic(room: Room, generation: number) {
    if (!this.#isCurrent(room, generation) || !this.#ready()) return;
    await this.#dedupe(room, Track.Source.Microphone, this.#mic?.track);
    const target = this.#voice;
    const applied = this.#applied(room, Track.Source.Microphone, this.#mic);
    const old = this.#publication(room, Track.Source.Microphone)?.track;
    if (old && applied === target) return;
    try {
      if (old) await room.localParticipant.unpublishTrack(old, this.#devices.stopMicOnUnpublish);
    } catch (error) {
      // A failed renegotiation can still have taken the publication down: what the room has decides.
      this.#events.toast(errorMessage(error));
    }
    if (!this.#isCurrent(room, generation)) return;
    if (this.#publication(room, Track.Source.Microphone)) return;
    this.#mic = null;
    try {
      if ((await this.#publishMic(room, generation, target, true)) && applied) this.#events.toast(voiceToast(target), true);
    } catch (error) {
      this.#events.toast(errorMessage(error));
      // Put the microphone back as it was. If that fails too, unmuting tries again.
      if (applied && this.#isCurrent(room, generation) && !this.#publication(room, Track.Source.Microphone)) {
        await this.#publishMic(room, generation, applied, true).catch(() => {});
      }
    }
    this.#events.changed();
  }

  /** Opens and publishes a microphone. False when its room went away meanwhile; nothing is left open. */
  async #publishMic(room: Room, generation: number, quality: CallQuality, bounded: boolean): Promise<boolean> {
    const opening = this.#devices.openMic(room, quality);
    const track = bounded ? await this.#bounded(opening, "microphone", (t) => t.stop()) : await opening;
    if (!this.#isCurrent(room, generation)) {
      track.stop();
      return false;
    }
    // The latest mute, before the track goes out and again once it has.
    if (this.#micMuted()) await track.mute();
    try {
      await room.localParticipant.publishTrack(track, micOptions(quality).publish);
    } catch (error) {
      track.stop();
      throw error;
    }
    if (!this.#isCurrent(room, generation)) {
      await room.localParticipant.unpublishTrack(track).catch(() => {});
      track.stop();
      return false;
    }
    if (track.isMuted !== this.#micMuted()) await (this.#micMuted() ? track.mute() : track.unmute());
    this.#mic = { track, quality };
    this.#events.changed();
    this.#events.log?.("info", "microphone published", { quality, muted: this.#micMuted() });
    // Krisp, on LiveKit Cloud: never waited for. A noise filter that doesn't start (or never settles)
    // leaves the browser's own noise suppression on and the call going (lib/call.tsx logs why).
    void this.#devices.micPublished?.(track, quality, this.#url).catch(() => {});
    return true;
  }

  // ---------- devices ----------

  /**
   * Moves the microphone or camera to another device (an id from lib/devices.ts, or "default"), in
   * its lane, after any replacement already queued. A kind that isn't published opens on the new
   * device next time. Resolves false when the device couldn't be opened; the old one stays. A
   * restart that opened a device other than the one asked for (Chromium can hand back another id
   * for the same hardware) still counts, and both ids are logged, so the app doesn't retry it on
   * every device event.
   */
  setInputDevice(kind: "audioinput" | "videoinput", deviceId: string): Promise<boolean> {
    const now = this.#now();
    if (!now) return Promise.resolve(true);
    const [room, generation] = now;
    const source = kind === "audioinput" ? Track.Source.Microphone : Track.Source.Camera;
    const lane = kind === "audioinput" ? this.#lanes.mic : this.#lanes.camera;
    const what = kind === "audioinput" ? "microphone" : "camera";
    return lane.run(async () => {
      if (!this.#isCurrent(room, generation)) return true;
      const track = this.#publication(room, source)?.track as (LocalAudioTrack | LocalVideoTrack) | undefined;
      if (!track) return true;
      // The device the track has now, to go back to: LiveKit stops the old capture before it opens
      // the new one, so a failed switch would otherwise leave the call with neither.
      const previous = (await track.getDeviceId(false).catch(() => undefined)) || undefined;
      try {
        // LiveKit restarts the track on the device, keeping its publication, mute and processor (Krisp).
        // `exact`: a bare id is only "ideal" to getUserMedia, and Chromium can keep the old device.
        const exact = await moveTo(track, { exact: deviceId });
        await this.#keepMuted(track);
        const got = (await track.getDeviceId(false).catch(() => undefined)) ?? "";
        this.#events.log?.("info", "device switched", { kind, asked: deviceId.slice(0, 6), got: got.slice(0, 6), exact, muted: track.isMuted });
        this.#events.changed();
        return true;
      } catch (error) {
        this.#events.log?.("warn", "device switch failed", { kind, type: (error as Error)?.name ?? "unknown" });
        this.#events.toast(`Couldn't switch the ${what}: ${errorMessage(error)}`);
        // Back on the device it had, or the system's default if that's gone too.
        for (const back of [previous ? { exact: previous } : undefined, kind === "audioinput" ? DEFAULT_ID : undefined]) {
          if (!back || !this.#isCurrent(room, generation)) continue;
          try {
            await moveTo(track, back);
            this.#events.log?.("info", "device restored", { kind, to: typeof back === "string" ? "default" : "the previous one" });
            break;
          } catch {
            this.#events.log?.("warn", "device restore failed", { kind });
          }
        }
        await this.#keepMuted(track).catch(() => {});
        this.#events.changed();
        return false;
      }
    }).catch(() => false);
  }

  /** Plays the call's sound on another speaker ("default" for the system's). */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    const room = this.#room;
    if (!room) return true;
    try {
      await room.switchActiveDevice("audiooutput", deviceId);
      this.#events.log?.("info", "device switched", { kind: "audiooutput" });
      return true;
    } catch (error) {
      this.#events.log?.("warn", "device switch failed", { kind: "audiooutput", type: (error as Error)?.name ?? "unknown" });
      this.#events.toast(`Couldn't switch the speaker: ${errorMessage(error)}`);
      return false;
    }
  }

  /** The published microphone's track, for the level meter. */
  get micTrack(): MediaStreamTrack | null {
    const room = this.#room;
    const track = room ? this.#publication(room, Track.Source.Microphone)?.track : undefined;
    return (track?.mediaStreamTrack as MediaStreamTrack | undefined) ?? null;
  }

  /** The published camera's track, for the self view. */
  get cameraTrack(): LocalVideoTrack | null {
    const room = this.#room;
    const track = room ? this.#publication(room, Track.Source.Camera)?.track : undefined;
    return (track as LocalVideoTrack | undefined) ?? null;
  }

  // ---------- camera ----------

  setCamera(on: boolean): Promise<void> {
    this.#cameraOn = on;
    this.#events.log?.("info", on ? "camera on" : "camera off", { quality: this.#cameraQuality });
    this.#events.report({ camera: this.#cameraWanted() });
    this.#events.changed();
    return this.#syncCamera(++this.#cameraRequest);
  }

  /** This computer's camera quality: a camera that's on changes now. */
  setCameraQuality(quality: CameraQuality): Promise<void> {
    rememberCamera(quality);
    this.#cameraQuality = quality;
    this.#events.changed();
    return this.#syncCamera(++this.#cameraRequest);
  }

  #syncCamera(request: number): Promise<void> {
    const now = this.#now();
    if (!now || this.#reconnecting) return Promise.resolve();
    const [room, generation] = now;
    return this.#lanes.camera.run(() => this.#replaceCamera(room, generation)).catch((error: unknown) => {
      this.#events.toast(errorMessage(error));
      // Only the newest request in this call speaks for the camera: an older one's failure leaves it be.
      if (!this.#isCurrent(room, generation) || request !== this.#cameraRequest) return;
      if (this.#cameraWanted() && !this.#publication(room, Track.Source.Camera)) {
        this.#cameraOn = false;
        this.#events.report({ camera: false });
        this.#events.changed();
      }
    });
  }

  async #replaceCamera(room: Room, generation: number) {
    if (!this.#isCurrent(room, generation) || this.#reconnecting) return;
    await this.#dedupe(room, Track.Source.Camera, this.#camera?.track);
    const wanted = () => (this.#cameraWanted() ? effectiveCamera(this.#cameraQuality, this.#limit) : null);
    const target = wanted();
    const old = this.#publication(room, Track.Source.Camera)?.track;
    if (target && old && this.#applied(room, Track.Source.Camera, this.#camera) === target) return;
    if (!target && !old) return;
    if (old) await room.localParticipant.unpublishTrack(old);
    this.#camera = null;
    this.#events.changed();
    if (!target) return;
    // Overtaken by the room going, the camera being turned off or suspended (no controls on
    // screen), or another quality (queued after this).
    const overtaken = () => !this.#isCurrent(room, generation) || this.#suspended || wanted() !== target;
    const track = await this.#bounded(this.#devices.openCamera(room, target), "camera", (t) => t.stop());
    if (overtaken()) {
      track.stop();
      return;
    }
    try {
      await room.localParticipant.publishTrack(track, cameraOptions(target).publish);
    } catch (error) {
      track.stop();
      throw error;
    }
    if (overtaken()) {
      await room.localParticipant.unpublishTrack(track).catch(() => {});
      track.stop();
      return;
    }
    this.#camera = { track, quality: target };
    this.#events.log?.("info", "camera published", { quality: target });
    this.#events.changed();
  }

  // ---------- screen share ----------

  /** Tells the room whether you're sharing, when that changes from what it was last told. */
  #reportScreen(sharing: boolean) {
    if (sharing === this.#reportedScreen) return;
    this.#reportedScreen = sharing;
    this.#events.report({ screen: sharing });
  }

  /** Shares a screen or window at a quality, kept within the team's limit. */
  shareScreen(source: ShareSource, audio: boolean, quality: ShareQuality): Promise<void> {
    this.#share = { source, audio, quality: effectiveShare(quality, this.#limit) };
    this.#events.changed();
    return this.#syncShare();
  }

  /** Stops sharing: the room is told at once, whatever is still being replaced. */
  stopScreen(): Promise<void> {
    this.#share = null;
    this.#reportScreen(false);
    this.#events.changed();
    return this.#syncShare();
  }

  /** The same screen or window again at another quality: LiveKit can't change a published share's capture. */
  changeShareQuality(quality: ShareQuality): Promise<void> {
    if (!this.#share) return Promise.resolve();
    this.#share = { ...this.#share, quality: effectiveShare(quality, this.#limit) };
    this.#events.changed();
    return this.#syncShare();
  }

  /** LiveKit unpublished a share track: unless the app did it, the person ended the share. */
  unpublished(source: Track.Source) {
    if (source !== Track.Source.ScreenShare || this.#ownUnpublishes > 0 || this.#reconnecting || !this.#shareApplied) return;
    this.#share = null;
    this.#shareApplied = null;
    this.#reportScreen(false);
    this.#events.changed();
  }

  #syncShare(): Promise<void> {
    const now = this.#now();
    if (!now || this.#reconnecting) return Promise.resolve();
    return this.#lanes.share.run(() => this.#replaceShare(...now)).catch((error: unknown) => {
      const name = this.#share?.source.name ?? "the screen";
      this.#events.toast(`Couldn't share ${name}: ${errorMessage(error)}`);
    });
  }

  async #takeDownShare(room: Room) {
    this.#ownUnpublishes++;
    try {
      for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
        for (const p of this.#publications(room, source)) if (p.track) await room.localParticipant.unpublishTrack(p.track);
      }
    } finally {
      this.#ownUnpublishes--;
    }
  }

  async #replaceShare(room: Room, generation: number) {
    if (!this.#isCurrent(room, generation) || this.#reconnecting) return;
    await this.#dedupe(room, Track.Source.ScreenShare, this.#shareApplied?.track);
    // The limit, rechecked as the replacement starts.
    if (this.#share && !shareAllowed(this.#share.quality, this.#limit)) {
      this.#share = { ...this.#share, quality: effectiveShare(this.#share.quality, this.#limit) };
    }
    const want = this.#share;
    const live = this.#publications(room, Track.Source.ScreenShare).some((p) => p.track === this.#shareApplied?.track);
    if (want && want === this.#shareApplied?.want && live) return;
    await this.#takeDownShare(room);
    this.#shareApplied = null;
    if (!want) {
      this.#reportScreen(false);
      this.#events.changed();
      return;
    }
    const overtaken = () => !this.#isCurrent(room, generation) || this.#suspended || this.#share !== want;
    const giveUp = () => {
      if (this.#share !== want) return;
      this.#share = null;
      this.#reportScreen(false);
      this.#events.changed();
    };
    let capture: ScreenCapture;
    try {
      capture = await this.#bounded(this.#devices.openScreen(want.source, want.audio, want.quality), "screen capture", stopCapture);
    } catch (error) {
      giveUp();
      throw error;
    }
    if (overtaken()) {
      stopCapture(capture);
      return;
    }
    let video: LocalTrackPublication;
    try {
      video = await room.localParticipant.publishTrack(capture.video, sharePublish(want.quality));
      if (capture.audio) await room.localParticipant.publishTrack(capture.audio, SHARE_AUDIO_PUBLISH);
    } catch (error) {
      await this.#takeDownShare(room).catch(() => {});
      stopCapture(capture);
      giveUp();
      throw error;
    }
    if (overtaken()) {
      await this.#takeDownShare(room).catch(() => {});
      stopCapture(capture);
      return;
    }
    this.#shareApplied = { want, track: video.track };
    this.#events.log?.("info", "screen share published", { quality: want.quality, sound: Boolean(capture.audio) });
    this.#reportScreen(true);
    this.#events.changed();
  }
}
