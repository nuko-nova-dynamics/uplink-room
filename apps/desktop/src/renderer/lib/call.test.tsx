// @vitest-environment happy-dom
/**
 * The call's media while quality changes (issue #87, PR #89 review): CallProvider against a fake
 * LiveKit room whose device opens and publishes can be held, failed, or outlived by a leave.
 * Each test presses what a person would press while a microphone, camera or share is replaced.
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const fake = vi.hoisted(() => ({
  /** What the call told the main process about being in a call (main/updates.ts holds a restart back). */
  inCall: [] as boolean[],
  rooms: [] as any[],
  /** Holds for the next device opens and publishes, by kind: each open or publish waits for the first one queued. */
  hold: {
    audio: [] as { promise: Promise<void> }[],
    video: [] as { promise: Promise<void> }[],
    publish: [] as { promise: Promise<void> }[],
    connect: [] as { promise: Promise<void> }[],
    display: [] as { promise: Promise<void> }[],
    /** A published track opening another device (a switch, or LiveKit's restart). */
    restart: [] as { promise: Promise<void> }[],
  },
  /** The track's lock as LiveKit's setProcessor waits for it (a device switch can hold it). */
  trackLock: Promise.resolve() as Promise<void>,
  /** How many Krisp inits LiveKit started, and a hold on the next one. */
  krispInits: 0,
  krispInitHold: null as Promise<void> | null,
  /** How many of the next device opens, publishes or unpublishes fail. An unpublish fails after removing its publication, as a failed renegotiation does. */
  fail: { audio: 0, video: 0, publish: 0, unpublish: 0 },
  /** What the app told the room about this join (calls.updateMedia). */
  reports: [] as { muted?: boolean; camera?: boolean; screen?: boolean }[],
  /** Every track a device open made, in order. */
  opened: [] as any[],
  /** Every publish, with the room's state at that moment. */
  publishes: [] as { source: string; track: any; options: any; connected: boolean }[],
  store: { voice: "standard", limit: "none", version: 0, listeners: new Set<() => void>() },
  toasts: [] as string[],
  /** Every Room API mutation, by name, in order. */
  mutations: [] as string[],
  joins: 0,
  /** The LiveKit URL calls.join returns: LiveKit Cloud turns Krisp on. */
  url: "ws://127.0.0.1:7880",
  /** Krisp's enable step: never settles (as under the app's old content security policy), turns on, or fails. */
  krispEnabled: [] as boolean[],
  krispMode: "hang" as "hang" | "on" | "throw" | "reject-init" | "hang-init",
  /** How many Krisp processors were destroyed. */
  krispDestroyed: 0,
  /** Devices that fail to open (a busy or broken one), and the next heartbeat the room refuses. */
  broken: [] as string[],
  dropNextBeat: false,
  /** A code every heartbeat is refused with from now on (the room's `not_found` once the channel is out of reach). */
  refuseBeats: null as string | null,
  /** What calls.live lists, when a test changes it (null: the call in #general, with Ana). */
  liveCalls: null as unknown[] | null,
  /** Events dispatched on Krisp's processed track. */
  krispEvents: [] as string[],
  /** Device ids unplugged now, and who listens for devicechange. */
  unplugged: [] as string[],
  deviceListeners: new Set<() => void>(),
}));

vi.mock("livekit-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("livekit-client")>();
  class FakeTrack {
    kind: string;
    source: string;
    devices: string[] = [];
    isMuted = false;
    stopped = false;
    options: unknown;
    /** Constraints applied to the capture, in order (Krisp turns noise suppression off; the app puts it back). */
    constraints: object[] = [];
    mediaStreamTrack = {
      contentHint: "",
      getSettings: () => ({}),
      applyConstraints: async (c: object) => void this.constraints.push(c),
    };
    /** False once a restart stopped the capture and couldn't open another (LiveKit stops the old one first). */
    live = true;
    /** Every mute state the track took, in order (true muted, false sending). */
    muteLog: boolean[] = [];
    /** As LiveKit 2.23: a device chosen while muted is only noted, and opened on unmute or a restart. */
    pendingDeviceChange = false;
    pendingDevice = "";
    /** LiveKit's mute lock: a mute pressed during an unmute runs after it. */
    #muteLock: Promise<unknown> = Promise.resolve();
    constructor(kind: string, source: string, options?: unknown) {
      this.kind = kind;
      this.source = source;
      this.options = options;
      // The device it was opened on, as the capture's settings report it.
      const id = (options as { deviceId?: string | { exact?: string; ideal?: string } } | undefined)?.deviceId;
      if (id) this.devices.push(typeof id === "string" ? id : (id.exact ?? id.ideal ?? "default"));
    }
    #locked<T>(task: () => Promise<T>): Promise<T> {
      const run = this.#muteLock.then(task);
      this.#muteLock = run.catch(() => {});
      return run;
    }
    #muted(muted: boolean) {
      this.isMuted = muted;
      this.muteLog.push(muted);
    }
    /** Opens a device for the track: held by `fake.hold.restart`, and a broken one fails after LiveKit stopped the old capture. */
    async #open(device: string) {
      const held = fake.hold.restart.shift();
      if (held) await held.promise;
      if (fake.broken.includes(device)) {
        this.live = false;
        throw Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" });
      }
      this.devices.push(device);
      this.live = true;
      this.pendingDeviceChange = false;
    }
    mute() {
      return this.#locked(async () => {
        if (!this.isMuted) this.#muted(true);
      });
    }
    unmute() {
      return this.#locked(async () => {
        if (!this.isMuted) return;
        // LiveKit opens a pending device inside the unmute, then turns the sound on.
        if (this.pendingDeviceChange) await this.#open(this.pendingDevice);
        this.#muted(false);
      });
    }
    async restartTrack() {
      await this.#open(this.pendingDeviceChange ? this.pendingDevice : (this.devices.at(-1) ?? "default"));
    }
    stop() {
      this.stopped = true;
    }
    attach() {
      return document.createElement("audio");
    }
    detach() {
      return [];
    }
    async setDeviceId(id: string | { exact: string }) {
      const device = typeof id === "string" ? id : id.exact;
      if (this.isMuted) {
        this.pendingDeviceChange = true;
        this.pendingDevice = device;
        return true;
      }
      await this.#open(device);
      return true;
    }
    async getDeviceId() {
      return this.devices.at(-1) ?? "default";
    }
    processor: unknown;
    /** As LiveKit does: under the track's lock, the processor's init runs first, and the processor is kept only if it succeeds. */
    async setProcessor(processor: { init?: (o: unknown) => Promise<void> }) {
      await fake.trackLock;
      fake.krispInits++;
      await processor.init?.({ kind: this.kind, track: this.mediaStreamTrack });
      this.processor = processor;
    }
    getProcessor() {
      return this.processor;
    }
    async stopProcessor() {
      await (this.processor as { destroy?: () => Promise<void> } | undefined)?.destroy?.();
      this.processor = undefined;
    }
  }
  class LocalAudioTrack extends FakeTrack {
    constructor(_track?: unknown, options?: unknown) {
      super("audio", real.Track.Source.Microphone, options);
    }
  }
  class LocalVideoTrack extends FakeTrack {
    constructor(_track?: unknown, options?: unknown) {
      super("video", real.Track.Source.Camera, options);
    }
  }
  let sids = 0;
  class LocalParticipant {
    room: any;
    identity = "ana.join1";
    /** By track sid, as LiveKit keeps them: two publications of one source can exist. */
    trackPublications = new Map<string, any>();
    get publications() {
      return this.trackPublications;
    }
    constructor(room: any) {
      this.room = room;
    }
    async createTracks(options: { audio?: unknown; video?: unknown }) {
      const kind = options.audio ? "audio" : "video";
      const held = fake.hold[kind as "audio" | "video"].shift();
      if (held) await held.promise;
      if (fake.fail[kind as "audio" | "video"] > 0) {
        fake.fail[kind as "audio" | "video"]--;
        throw new Error(`could not open the ${kind} device`);
      }
      // An exact constraint on a device that isn't plugged in fails, as getUserMedia does.
      const wanted = (options.audio ?? options.video) as { deviceId?: { exact?: string } } | undefined;
      const exact = typeof wanted === "object" ? wanted?.deviceId?.exact : undefined;
      if (exact && (fake.unplugged.includes(exact) || !(await navigator.mediaDevices.enumerateDevices()).some((d) => d.deviceId === exact))) {
        throw Object.assign(new Error("Requested device not found"), { name: "OverconstrainedError" });
      }
      const track = kind === "audio" ? new LocalAudioTrack(undefined, options.audio) : new LocalVideoTrack(undefined, options.video);
      fake.opened.push(track);
      return [track];
    }
    async publishTrack(input: any, options: any = {}) {
      // LiveKit waits for a connection still being made before it publishes.
      if (this.room.state === "connecting") await this.room.connected;
      const held = fake.hold.publish.shift();
      if (held) await held.promise;
      const track = input instanceof FakeTrack ? input : Object.assign(new FakeTrack(input.kind, ""), { raw: input });
      const source = options.source ?? track.source;
      track.source = source;
      fake.publishes.push({ source, track, options, connected: this.room.state === "connected" });
      if (this.room.state !== "connected") throw new Error("not connected");
      if (fake.fail.publish > 0) {
        fake.fail.publish--;
        throw new Error("publish failed");
      }
      const publication = {
        source,
        track,
        get isMuted() {
          return track.isMuted;
        },
        mute: () => track.mute(),
        unmute: () => track.unmute(),
      };
      this.trackPublications.set(`TR_${++sids}`, publication);
      return publication;
    }
    async unpublishTrack(track: any, stop = true) {
      for (const [sid, p] of this.trackPublications) if (p.track === track) this.trackPublications.delete(sid);
      if (fake.fail.unpublish > 0) {
        fake.fail.unpublish--;
        throw new Error("negotiation failed");
      }
      if (stop) track.stop();
    }
    getTrackPublication(source: string) {
      for (const p of this.trackPublications.values()) if (p.source === source) return p;
      return undefined;
    }
    async setCameraEnabled(enabled: boolean, capture?: unknown, publish?: any) {
      if (!enabled) return this.getTrackPublication(real.Track.Source.Camera)?.mute();
      const [track] = await this.createTracks({ video: capture ?? true });
      return this.publishTrack(track, { ...publish, source: real.Track.Source.Camera });
    }
    async setMicrophoneEnabled(enabled: boolean) {
      const p = this.getTrackPublication(real.Track.Source.Microphone);
      return enabled ? p?.unmute() : p?.mute();
    }
  }
  class Room {
    state = "disconnected";
    localParticipant: LocalParticipant;
    remoteParticipants = new Map();
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    connected: Promise<void>;
    #connected!: () => void;
    constructor() {
      this.localParticipant = new LocalParticipant(this);
      this.connected = new Promise((r) => (this.#connected = r));
      fake.rooms.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
    async connect() {
      this.state = "connecting";
      const held = fake.hold.connect.shift();
      if (held) await held.promise;
      this.state = "connected";
      this.#connected();
    }
    async disconnect() {
      this.state = "disconnected";
      for (const p of this.localParticipant.publications.values()) p.track.stop();
      this.localParticipant.publications.clear();
    }
  }
  return { ...real, Room, LocalAudioTrack, LocalVideoTrack };
});

vi.mock("convex/react", () => {
  const mutation = async (ref: never, args: { channelId?: string } & Record<string, unknown>) => {
    const name = getFunctionName(ref);
    fake.mutations.push(name);
    if (name === "calls:updateMedia") {
      const { muted, camera, screen } = args as { muted?: boolean; camera?: boolean; screen?: boolean };
      fake.reports.push(Object.fromEntries(Object.entries({ muted, camera, screen }).filter(([, v]) => v !== undefined)));
      return null;
    }
    if (name === "calls:heartbeat" && fake.refuseBeats) throw { data: { code: fake.refuseBeats } };
    if (name === "calls:heartbeat" && fake.dropNextBeat) {
      fake.dropNextBeat = false;
      throw { data: { code: "conflict" } };
    }
    if (name === "calls:join") {
      fake.joins++;
      return { callId: "call1", participationId: `join${fake.joins}`, url: fake.url, token: "t", callQuality: fake.store.voice, channelId: args.channelId };
    }
    return null;
  };
  const client = { mutation };
  return { useConvex: () => client, useMutation: (ref: never) => (args: Record<string, unknown>) => mutation(ref, args) };
});

vi.mock("./session", () => ({
  useSession: () => ({ teamId: "team1", me: { memberId: "ana", name: "Ana Diaz" }, members: [], isAdmin: true }),
  useToast: () => ({ show: (text: string) => fake.toasts.push(text) }),
  useRoomQuery: (ref: never) => {
    useSyncExternalStore(
      (listener) => {
        fake.store.listeners.add(listener);
        return () => fake.store.listeners.delete(listener);
      },
      () => fake.store.version,
    );
    const name = getFunctionName(ref);
    if (name === "calls:live") return fake.liveCalls ?? [{ callId: "call1", channelId: "general", participants: [{ memberId: "ana" }] }];
    if (name === "channels:list") return [{ channelId: "general", kind: "channel", name: "general", callQuality: fake.store.voice, callQualityChosen: fake.store.voice }];
    if (name === "teams:settings") return { name: "Nuko Nova", linkPreviews: "on", callQualityLimit: fake.store.limit };
    return undefined;
  },
}));
vi.mock("./desktop", () => ({
  fakeMedia: false,
  desktop: { chooseScreenSource: async () => {}, setInCall: async (inCall: boolean) => void fake.inCall.push(inCall) },
}));
vi.mock("@livekit/krisp-noise-filter", () => ({
  isKrispNoiseFilterSupported: () => true,
  KrispNoiseFilter: () => {
    let on = false;
    return {
      processedTrack: { dispatchEvent: (event: Event) => fake.krispEvents.push(event.type) },
      // Krisp turns the browser's noise suppression off on the capture first, then can fail.
      init: (o: { track: { applyConstraints(c: object): Promise<void> } }) => {
        void o.track.applyConstraints({ noiseSuppression: false, voiceIsolation: false });
        if (fake.krispMode === "reject-init") return Promise.reject(Object.assign(new Error("worklet"), { name: "CompileError" }));
        if (fake.krispMode === "hang-init") return new Promise<void>(() => {});
        if (fake.krispInitHold) return fake.krispInitHold;
        return Promise.resolve();
      },
      destroy: async () => void fake.krispDestroyed++,
      isEnabled: () => on,
      setEnabled: (enable: boolean) => {
        fake.krispEnabled.push(enable);
        if (fake.krispMode === "throw") return Promise.reject(Object.assign(new Error("worklet"), { name: "CompileError" }));
        if (fake.krispMode === "on") {
          on = enable;
          return Promise.resolve(true);
        }
        return new Promise(() => {});
      },
    };
  },
}));
vi.mock("./sound", () => ({ playCue: () => {} }));
vi.mock("./analytics", () => ({ track: () => {} }));

const { Track } = await import("livekit-client");
const { CallProvider, enableKrisp, endAppCall, useCall } = await import("./call");
const { LocalAudioTrack } = await import("livekit-client");
const { resetSavedDevices, saveDevice, savedDevice } = await import("./devices");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let call: ReturnType<typeof useCall>;
function Probe() {
  call = useCall();
  return null;
}

const roots: Root[] = [];
beforeEach(() => {
  fake.rooms.length = 0;
  fake.opened.length = 0;
  fake.publishes.length = 0;
  fake.toasts.length = 0;
  fake.hold.audio.length = fake.hold.video.length = fake.hold.publish.length = 0;
  fake.hold.connect.length = fake.hold.display.length = fake.hold.restart.length = 0;
  fake.trackLock = Promise.resolve();
  fake.krispInits = 0;
  fake.krispInitHold = null;
  fake.fail = { audio: 0, video: 0, publish: 0, unpublish: 0 };
  fake.reports.length = 0;
  fake.store.voice = "standard";
  fake.store.limit = "none";
  fake.url = "ws://127.0.0.1:7880";
  fake.krispEnabled.length = 0;
  fake.krispMode = "hang";
  fake.krispDestroyed = 0;
  fake.broken.length = 0;
  fake.dropNextBeat = false;
  fake.refuseBeats = null;
  fake.liveCalls = null;
  fake.krispEvents.length = 0;
  fake.inCall.length = 0;
  fake.unplugged.length = 0;
  fake.deviceListeners.clear();
  localStorage.clear();
  resetSavedDevices();
  const screen = { kind: "video", contentHint: "", stop: vi.fn(), getSettings: () => ({}) };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () =>
        [
          { kind: "audioinput", deviceId: "default", label: "Default - Built-in", groupId: "g1" },
          { kind: "audioinput", deviceId: "mic-usb", label: "USB mic", groupId: "g2" },
          { kind: "audioinput", deviceId: "mic-broken", label: "Busy mic", groupId: "g4" },
          { kind: "audioinput", deviceId: "mic-desk", label: "Desk mic", groupId: "g5" },
          { kind: "audiooutput", deviceId: "default", label: "Default - Speakers", groupId: "g1" },
          { kind: "videoinput", deviceId: "cam-1", label: "Camera", groupId: "g3" },
        ].filter((d) => !fake.unplugged.includes(d.deviceId)),
      ),
      addEventListener: (_type: string, listener: () => void) => fake.deviceListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => fake.deviceListeners.delete(listener),
      getDisplayMedia: vi.fn(async () => {
        const held = fake.hold.display.shift();
        if (held) await held.promise;
        return { getVideoTracks: () => [screen], getAudioTracks: () => [], getTracks: () => [screen] };
      }),
    },
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  await act(async () => endAppCall?.());
  fake.mutations.length = 0;
  fake.joins = 0;
});

/** Lets every pending promise, effect and render run. */
async function settle() {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
function update(change: () => void) {
  change();
  fake.store.version++;
  for (const listener of fake.store.listeners) listener();
}
const held = (kind: "audio" | "video" | "publish" | "connect" | "display" | "restart") => {
  const d = deferred();
  fake.hold[kind].push(d);
  return d;
};
const room = () => fake.rooms.at(-1);
const published = (source: string) => room()?.localParticipant.getTrackPublication(source);
const all = (source: string) => [...(room()?.localParticipant.trackPublications.values() ?? [])].filter((p: any) => p.source === source);
const micPublishes = () => fake.publishes.filter((p) => p.source === Track.Source.Microphone);

async function mounted() {
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<CallProvider><Probe /></CallProvider>));
  return root;
}

async function joined() {
  await mounted();
  await act(async () => void call.join("general" as never));
  await settle();
  expect(call.status).toBe("connected");
  expect(published(Track.Source.Microphone)).toBeTruthy();
}

test("a mute pressed while the microphone is replaced for a new voice quality holds on the new one", async () => {
  await joined();
  // Pressed while the new microphone is being opened.
  const opening = held("audio");
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  await act(async () => call.toggleMute());
  opening.resolve();
  await settle();
  const mic = published(Track.Source.Microphone);
  expect(fake.publishes.filter((p) => p.source === Track.Source.Microphone).at(-1)!.options.forceStereo).toBe(true);
  expect(mic.isMuted).toBe(true);
  expect(call.muted).toBe(true);

  // Pressed again (unmute) while the next replacement's publish is in flight.
  const publishing = held("publish");
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  await act(async () => call.toggleMute());
  publishing.resolve();
  await settle();
  expect(published(Track.Source.Microphone).isMuted).toBe(false);
  expect(call.muted).toBe(false);
  // And a mute pressed during that kind of publish holds too.
  const publishingAgain = held("publish");
  await act(async () => update(() => (fake.store.voice = "standard")));
  await settle();
  await act(async () => call.toggleMute());
  publishingAgain.resolve();
  await settle();
  expect(published(Track.Source.Microphone).isMuted).toBe(true);
});

test("turning the camera off while it's replaced for a new camera quality leaves no camera", async () => {
  await joined();
  await act(async () => call.toggleCamera());
  await settle();
  expect(published(Track.Source.Camera)).toBeTruthy();

  const opening = held("video");
  let change!: Promise<void>;
  await act(async () => void (change = call.setCameraQuality("1080p")));
  await settle();
  await act(async () => call.toggleCamera());
  opening.resolve();
  await act(async () => change);
  await settle();
  expect(published(Track.Source.Camera)).toBeUndefined();
  expect(fake.opened.filter((t) => t.kind === "video").every((t) => t.stopped)).toBe(true);
  expect(call.camera).toBe(false);
});

test("a failed microphone replacement puts a microphone back, and unmuting brings back a missing one", async () => {
  await joined();
  fake.fail.audio = 1;
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  expect(published(Track.Source.Microphone)).toBeTruthy();
  expect(published(Track.Source.Microphone).isMuted).toBe(false);

  // The replacement and the way back both fail: no microphone, until you unmute.
  fake.fail.audio = 2;
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  expect(published(Track.Source.Microphone)).toBeUndefined();
  await act(async () => call.toggleMute());
  await act(async () => call.toggleMute());
  await settle();
  expect(published(Track.Source.Microphone)).toBeTruthy();
  expect(published(Track.Source.Microphone).isMuted).toBe(false);
  expect(fake.publishes.filter((p) => p.source === Track.Source.Microphone).at(-1)!.options.audioPreset.maxBitrate).toBe(96_000);
  expect(call.muted).toBe(false);
});

test("leaving while a new microphone is opened stops it and publishes nothing; a failed publish stops its track", async () => {
  await joined();
  const opening = held("audio");
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  const leftRoom = room();
  await act(async () => call.leave());
  await settle();
  opening.resolve();
  await settle();
  expect(fake.publishes.filter((p) => !p.connected)).toEqual([]);
  expect(fake.opened.every((t) => t.stopped)).toBe(true);
  expect(leftRoom.localParticipant.publications.size).toBe(0);

  // In a new call, a replacement whose publish fails doesn't keep its device open.
  await act(async () => update(() => (fake.store.voice = "standard")));
  await act(async () => void call.join("general" as never));
  await settle();
  fake.fail.publish = 1;
  const before = fake.opened.length;
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  expect(fake.opened.length).toBeGreaterThan(before);
  expect(fake.opened[before].stopped).toBe(true);
});

test("lowering the team's limit lowers a running share and camera, and a later change keeps to it", async () => {
  await joined();
  await act(async () => call.setCameraQuality("1080p"));
  await act(async () => call.toggleCamera());
  await act(async () => call.shareScreen({ id: "window:1", name: "Reef Runner" }, false, "source"));
  await settle();
  const shareBitrate = () => fake.publishes.filter((p) => p.source === Track.Source.ScreenShare).at(-1)!.options.screenShareEncoding.maxBitrate;
  const cameraHeight = () => fake.opened.filter((t) => t.kind === "video").at(-1)!.options.resolution.height;
  expect(shareBitrate()).toBe(6_800_000);
  expect(cameraHeight()).toBe(1080);

  await act(async () => update(() => (fake.store.limit = "standard")));
  await settle();
  expect(call.shareQuality).toBe("sharp");
  expect(shareBitrate()).toBe(2_100_000);
  expect(published(Track.Source.ScreenShare)).toBeTruthy();
  expect(cameraHeight()).toBe(720);
  expect(published(Track.Source.Camera)).toBeTruthy();

  // Asked for Source under a High limit, the share gets the closest it allows.
  await act(async () => update(() => (fake.store.limit = "high")));
  await act(async () => call.changeShareQuality("source"));
  await settle();
  expect(call.shareQuality).toBe("balanced");
  expect(shareBitrate()).toBe(4_300_000);
});

test("a voice change whose unpublish fails still ends with a microphone, and unmuting brings back a missing one", async () => {
  await joined();
  // LiveKit removed the publication, then the renegotiation failed.
  fake.fail.unpublish = 1;
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  expect(all(Track.Source.Microphone)).toHaveLength(1);
  expect(micPublishes().at(-1)!.options.forceStereo).toBe(true);

  // The same, and then neither the new microphone nor the old one opens: unmuting tries again.
  fake.fail.unpublish = 1;
  fake.fail.audio = 2;
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  expect(all(Track.Source.Microphone)).toHaveLength(0);
  await act(async () => call.toggleMute());
  await act(async () => call.toggleMute());
  await settle();
  expect(all(Track.Source.Microphone)).toHaveLength(1);
  expect(micPublishes().at(-1)!.options.audioPreset.maxBitrate).toBe(96_000);
});

test("a voice change while the call connects, or during a full reconnect, leaves one microphone", async () => {
  await mounted();
  const connecting = held("connect");
  await act(async () => void call.join("general" as never));
  await settle();
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  connecting.resolve();
  await settle();
  expect(call.status).toBe("connected");
  expect(all(Track.Source.Microphone)).toHaveLength(1);
  expect(micPublishes().filter((p) => p.connected).at(-1)!.options.forceStereo).toBe(true);

  // A full reconnect: LiveKit takes the publications down and publishes the same tracks again.
  const lp = room().localParticipant;
  await act(async () => room().emit("reconnecting"));
  const republished = [...lp.trackPublications.entries()];
  lp.trackPublications.clear();
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  for (const [sid, p] of republished) lp.trackPublications.set(sid, p);
  await act(async () => room().emit("reconnected"));
  await settle();
  expect(all(Track.Source.Microphone)).toHaveLength(1);
  expect(micPublishes().at(-1)!.options.audioPreset.maxBitrate).toBe(96_000);
});

test("a device open that never settles doesn't hold up the next call's microphone, and is stopped if it ever opens", async () => {
  await joined();
  const never = held("audio");
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  await act(async () => call.leave());
  await settle();
  await act(async () => void call.join("general" as never));
  await settle();
  expect(call.status).toBe("connected");
  expect(all(Track.Source.Microphone)).toHaveLength(1);
  // The first call's open settles at last: its track is stopped, not published anywhere.
  const before = fake.publishes.length;
  never.resolve();
  await settle();
  expect(fake.publishes.length).toBe(before);
  expect(fake.opened.filter((t) => !t.stopped)).toHaveLength(1);
});

test("an older camera change that fails doesn't turn off a newer camera request", async () => {
  await joined();
  await act(async () => call.toggleCamera());
  await settle();
  const opening = held("video");
  fake.fail.video = 1;
  await act(async () => void call.setCameraQuality("1080p"));
  await settle();
  await act(async () => call.toggleCamera());
  await act(async () => call.toggleCamera());
  opening.resolve();
  await settle();
  expect(call.camera).toBe(true);
  expect(all(Track.Source.Camera)).toHaveLength(1);
  expect(fake.reports.filter((r) => "camera" in r).at(-1)).toEqual({ camera: true });
});

test("Stop pressed while a share is being replaced tells the room the share stopped", async () => {
  await joined();
  await act(async () => call.shareScreen({ id: "window:1", name: "Reef Runner" }, false, "balanced"));
  await settle();
  expect(fake.reports.filter((r) => "screen" in r).at(-1)).toEqual({ screen: true });
  const capturing = held("display");
  await act(async () => void call.changeShareQuality("sharp"));
  await settle();
  await act(async () => void call.stopScreen());
  capturing.resolve();
  await settle();
  expect(all(Track.Source.ScreenShare)).toHaveLength(0);
  expect(call.screen).toBe(false);
  expect(fake.reports.filter((r) => "screen" in r).at(-1)).toEqual({ screen: false });
});

// ---------- staying in the call (2026-11-04) ----------

test("a microphone whose Krisp never turns on still finishes joining and tells the room", async () => {
  // 0.2.0 to 0.2.2: Krisp's enable step never settled, the join never got past its microphone,
  // and the room heard nothing from it (not even this updateMedia) until it dropped the join.
  fake.url = "wss://uplink-room-test.livekit.cloud";
  await mounted();
  await act(async () => void call.join("general" as never));
  await settle();
  expect(call.status).toBe("connected");
  expect(fake.krispEnabled).toEqual([true]);
  expect(fake.mutations).toContain("calls:updateMedia");
  expect(call.krisp.state).toBe("starting");
});

test("the call keeps going when its view unmounts and mounts again, with the same join and no leave", async () => {
  // The window's session reloading after the computer wakes, or the team chooser opening and closing.
  const root = await mounted();
  await act(async () => void call.join("general" as never));
  await settle();
  const before = room();
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  await settle();
  expect(fake.mutations).not.toContain("calls:leave");
  expect(before.state).toBe("connected");
  await mounted();
  await settle();
  expect(call.status).toBe("connected");
  expect(room()).toBe(before);
  expect(fake.mutations).not.toContain("calls:leave");
  expect(fake.joins).toBe(1);
});

test("the app stays in a call for updates while no view shows it, and leaves it when the call ends", async () => {
  // The team chooser opens mid-call: the call goes on for a while with no Shell mounted, and an
  // update must not restart the app under it.
  const root = await mounted();
  await act(async () => void call.join("general" as never));
  await settle();
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  await settle();
  expect(fake.inCall.at(-1)).toBe(true);
  await act(async () => endAppCall());
  await settle();
  expect(fake.inCall.at(-1)).toBe(false);
});

test("signing out ends the call at once", async () => {
  await joined();
  await act(async () => endAppCall());
  await settle();
  expect(fake.mutations).toContain("calls:leave");
  expect(room().state).toBe("disconnected");
});

test("choosing another microphone mid-call moves the published track, after a voice change already queued", async () => {
  await joined();
  const opening = held("audio");
  await act(async () => update(() => (fake.store.voice = "music")));
  await settle();
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await settle();
  // The switch waits in the microphone's lane behind the voice change.
  expect(fake.opened.filter((t) => t.kind === "audio").flatMap((t) => t.devices)).not.toContain("mic-usb");
  opening.resolve();
  await settle();
  const mic = published(Track.Source.Microphone).track;
  expect(mic.devices.at(-1)).toBe("mic-usb");
  expect(mic.devices.filter((d: string) => d === "mic-usb")).toHaveLength(1);
  expect(fake.toasts.filter((t) => t.startsWith("Couldn't"))).toEqual([]);
  expect(all(Track.Source.Microphone)).toHaveLength(1);
  // A microphone opened later opens on the chosen device.
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  expect(fake.opened.filter((t) => t.kind === "audio").at(-1).options.deviceId).toEqual({ exact: "mic-usb" });
});

test("Krisp that turns on is announced to LiveKit, so the room lists noise cancellation (audio feature 5)", async () => {
  fake.krispMode = "on";
  const mic = new LocalAudioTrack(undefined as never);
  const states: string[] = [];
  await enableKrisp("wss://uplink-room-test.livekit.cloud", mic, (s) => states.push(s.state));
  expect(states).toEqual(["starting", "on"]);
  expect(fake.krispEvents).toEqual(["enable-lk-krisp-noise-filter"]);
});

test("Krisp that fails is taken off the microphone, which puts the browser's noise suppression back", async () => {
  fake.krispMode = "throw";
  const mic = new LocalAudioTrack(undefined as never) as unknown as { processor: unknown };
  const states: { state: string; why: string }[] = [];
  await enableKrisp("wss://uplink-room-test.livekit.cloud", mic as never, (s) => states.push(s));
  await settle();
  expect(states.at(-1)).toEqual({ state: "failed", why: "CompileError" });
  expect(mic.processor).toBeUndefined();
  expect(fake.krispEvents).toEqual([]);
  // Off the cloud, Krisp never starts.
  const elsewhere: string[] = [];
  await enableKrisp("ws://127.0.0.1:7880", mic as never, (s) => elsewhere.push(s.why));
  expect(elsewhere).toEqual(["not LiveKit Cloud"]);
});

test("the chosen microphone unplugged mid-call moves the call to the system default, and back when it returns", async () => {
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await joined();
  expect(fake.opened.filter((t) => t.kind === "audio").at(-1).options.deviceId).toEqual({ exact: "mic-usb" });
  const mic = () => published(Track.Source.Microphone).track;
  fake.unplugged.push("mic-usb");
  await act(async () => fake.deviceListeners.forEach((l) => l()));
  await settle();
  expect(mic().devices.at(-1)).toBe("default");
  expect(fake.toasts.at(-1)).toBe("Your microphone was unplugged, so the call uses the system default.");
  fake.unplugged.length = 0;
  await act(async () => fake.deviceListeners.forEach((l) => l()));
  await settle();
  expect(mic().devices.at(-1)).toBe("mic-usb");
  expect(fake.toasts.at(-1)).toBe("Your microphone is back.");
  expect(all(Track.Source.Microphone)).toHaveLength(1);
});

// ---------- review round 1 (PR #98) ----------

test("muted with the camera on, the room drops the join: the call joins again still muted, with the camera back", async () => {
  await joined();
  await act(async () => call.toggleMute());
  await act(async () => call.toggleCamera());
  await settle();
  const before = room();
  fake.dropNextBeat = true;
  // The network coming back makes the call beat at once; the room refuses it, so it joins again.
  await act(async () => void window.dispatchEvent(new Event("online")));
  await settle();
  await settle();
  expect(fake.joins).toBe(2);
  expect(room()).not.toBe(before);
  expect(call.status).toBe("connected");
  expect(call.muted).toBe(true);
  expect(published(Track.Source.Microphone).isMuted).toBe(true);
  expect(fake.publishes.filter((p) => p.source === Track.Source.Microphone && p.connected).every((p) => p.track.isMuted)).toBe(true);
  expect(call.camera).toBe(true);
  expect(published(Track.Source.Camera)).toBeTruthy();
  expect(fake.reports.filter((r) => "muted" in r).at(-1)).toMatchObject({ muted: true });
});

test("with no call controls on screen, the microphone is muted and the camera stopped; both come back with the controls", async () => {
  const root = await mounted();
  await act(async () => void call.join("general" as never));
  await settle();
  await act(async () => call.toggleCamera());
  await settle();
  // The window shows a splash (the session reconnecting): the dock and its controls are gone.
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  await settle();
  expect(published(Track.Source.Microphone).isMuted).toBe(true);
  expect(published(Track.Source.Camera)).toBeUndefined();
  expect(fake.reports.at(-1)).toEqual({ muted: true, camera: false });
  expect(fake.mutations).not.toContain("calls:leave");
  // The controls are back: as the person left it.
  await mounted();
  await settle();
  expect(call.muted).toBe(false);
  expect(published(Track.Source.Microphone).isMuted).toBe(false);
  expect(published(Track.Source.Camera)).toBeTruthy();
  expect(fake.reports.at(-1)).toEqual({ muted: false, camera: true });
});

test("a saved microphone that isn't plugged in doesn't fail the first join: the default opens, said once", async () => {
  await act(async () => saveDevice("audioinput", "mic-gone"));
  await joined();
  expect(fake.opened.filter((t) => t.kind === "audio").at(-1).options.deviceId).toBe("default");
  expect(fake.toasts.filter((t) => t.includes("isn't connected"))).toEqual(["The microphone you chose isn't connected, so the call uses the system default."]);
  // A later microphone (a voice change) opens the default again, without saying it twice.
  await act(async () => update(() => (fake.store.voice = "high")));
  await settle();
  expect(fake.opened.filter((t) => t.kind === "audio").at(-1).options.deviceId).toBe("default");
  expect(fake.toasts.filter((t) => t.includes("isn't connected"))).toHaveLength(1);
});

test("a live switch to a microphone that won't open goes back to the one it had, says so, and unpicks it", async () => {
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await joined();
  const mic = published(Track.Source.Microphone).track;
  fake.broken.push("mic-broken");
  await act(async () => saveDevice("audioinput", "mic-broken"));
  await settle();
  // LiveKit stopped the old capture to try the broken one; the app opened the old one again.
  expect(mic.live).toBe(true);
  expect(await mic.getDeviceId()).toBe("mic-usb");
  expect(fake.toasts.at(-1)).toBe("Couldn't switch the microphone: Could not start audio source");
  expect(savedDevice("audioinput")).toBe("mic-usb");
  // Nothing retries the broken one on the next device event.
  const tries = mic.devices.length;
  await act(async () => saveDevice("audiooutput", "default-2"));
  await settle();
  expect(mic.devices.length).toBe(tries);
});

test("Krisp whose init fails after turning noise suppression off is destroyed, and the capture's settings come back", async () => {
  fake.krispMode = "reject-init";
  const mic = new LocalAudioTrack(undefined as never) as unknown as { processor: unknown; constraints: object[] };
  const states: { state: string; why: string }[] = [];
  await enableKrisp("wss://uplink-room-test.livekit.cloud", mic as never, (s) => states.push(s), 200);
  expect(states.at(-1)).toEqual({ state: "failed", why: "CompileError" });
  expect(mic.processor).toBeUndefined();
  expect(fake.krispDestroyed).toBe(1);
  expect(mic.constraints.at(-1)).toEqual({ noiseSuppression: true, echoCancellation: true, autoGainControl: true });
});

test("Krisp whose init never settles is given up on in time, never kept on the track, and the capture's settings come back", async () => {
  fake.krispMode = "hang-init";
  const mic = new LocalAudioTrack(undefined as never) as unknown as { processor: unknown; constraints: object[] };
  const states: { state: string; why: string }[] = [];
  const started = Date.now();
  await enableKrisp("wss://uplink-room-test.livekit.cloud", mic as never, (s) => states.push(s), 100);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(states.at(-1)).toEqual({ state: "failed", why: "KrispTimeout" });
  expect(mic.processor).toBeUndefined();
  expect(fake.krispDestroyed).toBe(1);
  expect(mic.constraints).toEqual([{ noiseSuppression: false, voiceIsolation: false }, { noiseSuppression: true, echoCancellation: true, autoGainControl: true }]);
});


// ---------- review round 2 (PR #98) ----------

test("a Mute pressed while an unmute waits for a newly picked microphone holds: nothing is sent after it", async () => {
  await joined();
  await act(async () => call.toggleMute());
  await settle();
  const mic = published(Track.Source.Microphone).track;
  // While muted, another microphone is picked, and it opens slowly.
  const opening = held("restart");
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await settle();
  await act(async () => void call.toggleMute());
  await settle();
  const pressed = mic.muteLog.length;
  // Mute, while that device is still opening.
  await act(async () => void call.toggleMute());
  await settle();
  opening.resolve();
  await settle();
  expect(mic.muteLog.slice(pressed)).not.toContain(false);
  expect(mic.isMuted).toBe(true);
  expect(call.muted).toBe(true);
  expect(mic.devices.at(-1)).toBe("mic-usb");
  expect(fake.reports.filter((r) => "muted" in r).at(-1)).toEqual({ muted: true });
  // Unmuted again, it sends on the new device.
  await act(async () => void call.toggleMute());
  await settle();
  expect(mic.isMuted).toBe(false);
});

test("losing the call's controls during a full reconnect stops the camera and share at once, and LiveKit's republish brings neither back", async () => {
  const root = await mounted();
  await act(async () => void call.join("general" as never));
  await settle();
  await act(async () => call.toggleCamera());
  await act(async () => call.shareScreen({ id: "window:1", name: "Reef Runner" }, false, "balanced"));
  await settle();
  const camera = published(Track.Source.Camera).track;
  const share = published(Track.Source.ScreenShare).track;
  const lp = room().localParticipant;
  // LiveKit starts a full reconnect, holding what it will publish again once it's back.
  await act(async () => room().emit("reconnecting"));
  const republish = [...lp.trackPublications.entries()];
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  await settle();
  expect(camera.stopped).toBe(true);
  expect(camera.isMuted).toBe(true);
  expect(share.stopped).toBe(true);
  expect(all(Track.Source.Camera)).toHaveLength(0);
  expect(all(Track.Source.ScreenShare)).toHaveLength(0);
  expect(published(Track.Source.Microphone).isMuted).toBe(true);
  // LiveKit's republish: what it held goes out again, restarting an unmuted camera or microphone first.
  for (const [sid, p] of republish) {
    if (!p.track.isMuted && p.source !== Track.Source.ScreenShare) p.track.stopped = false;
    lp.trackPublications.set(sid, p);
  }
  await act(async () => room().emit("reconnected"));
  await settle();
  expect(all(Track.Source.Camera)).toHaveLength(0);
  expect(all(Track.Source.ScreenShare)).toHaveLength(0);
  expect(camera.stopped).toBe(true);
  expect(share.stopped).toBe(true);
  expect(fake.opened.filter((t) => t.kind === "video" && !t.stopped)).toEqual([]);
});

test("Krisp still waiting on the track's lock when its setup times out never attaches, and one that finishes late is taken off", async () => {
  vi.useFakeTimers();
  try {
    fake.url = "wss://uplink-room-test.livekit.cloud";
    fake.krispMode = "on";
    const restored = { noiseSuppression: true, echoCancellation: true, autoGainControl: true };

    // A device switch holds the track's lock past the setup's limit (2 × 100 ms).
    const lock = deferred();
    fake.trackLock = lock.promise;
    const mic = new LocalAudioTrack(undefined as never) as unknown as { processor: unknown; constraints: object[] };
    const states: { state: string; why: string }[] = [];
    const setup = enableKrisp(fake.url, mic as never, (s) => states.push(s), 100);
    await vi.advanceTimersByTimeAsync(250);
    await setup;
    expect(states.at(-1)).toEqual({ state: "failed", why: "KrispTimeout" });
    lock.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.krispInits).toBe(1);
    expect(mic.processor).toBeUndefined();
    expect(mic.constraints).toEqual([restored]);

    // The lock frees just before the limit and init finishes just after it: LiveKit keeps it, and it's taken off.
    const lateLock = deferred();
    const init = deferred();
    fake.trackLock = lateLock.promise;
    fake.krispInitHold = init.promise;
    const late = new LocalAudioTrack(undefined as never) as unknown as { processor: unknown; constraints: object[] };
    const lateSetup = enableKrisp(fake.url, late as never, () => {}, 100);
    await vi.advanceTimersByTimeAsync(150);
    lateLock.resolve();
    await vi.advanceTimersByTimeAsync(60);
    await lateSetup;
    init.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(late.processor).toBeUndefined();
    expect(late.constraints.at(-1)).toEqual(restored);
  } finally {
    vi.useRealTimers();
  }
});

test("a failed switch doesn't put back the old microphone over one picked after it", async () => {
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await joined();
  const mic = published(Track.Source.Microphone).track;
  fake.broken.push("mic-broken");
  // The broken one opens slowly and then fails; the desk mic is picked before it does.
  const opening = held("restart");
  await act(async () => saveDevice("audioinput", "mic-broken"));
  await settle();
  await act(async () => saveDevice("audioinput", "mic-desk"));
  await settle();
  opening.resolve();
  await settle();
  await settle();
  expect(fake.toasts).toContain("Couldn't switch the microphone: Could not start audio source");
  expect(savedDevice("audioinput")).toBe("mic-desk");
  expect(await mic.getDeviceId()).toBe("mic-desk");
});

test("a microphone picked while the call's first one is still opening is the one the call ends up on", async () => {
  await mounted();
  const opening = held("audio");
  await act(async () => void call.join("general" as never));
  await settle();
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await settle();
  opening.resolve();
  await settle();
  await settle();
  const mic = published(Track.Source.Microphone).track;
  expect(mic.devices.at(-1)).toBe("mic-usb");
  expect(savedDevice("audioinput")).toBe("mic-usb");
  expect(all(Track.Source.Microphone)).toHaveLength(1);
});

// ---------- review round 3 (PR #98) ----------

test("a heartbeat the room refuses for good (no access to the channel) ends the call here at once, stops capture and says why", async () => {
  await joined();
  const lk = room();
  const mic = published(Track.Source.Microphone).track;
  // Removed from the private channel: LiveKit's own removal is late, and the room says not_found.
  fake.refuseBeats = "not_found";
  await act(async () => void window.dispatchEvent(new Event("online")));
  await settle();
  expect(call.status).toBe("idle");
  expect(lk.state).toBe("disconnected");
  expect(mic.stopped).toBe(true);
  expect(fake.toasts).toContain("You're no longer in this channel's call.");
  expect(fake.joins).toBe(1);
});

test("the call gone from calls.live for this person ends it here, not only a catch-up", async () => {
  await joined();
  const lk = room();
  await act(async () => update(() => (fake.liveCalls = [])));
  await settle();
  expect(call.status).toBe("idle");
  expect(lk.state).toBe("disconnected");
  expect(fake.toasts).toContain("You're no longer in this channel's call.");
  // Listed without this person (the room dropped the join): the call asks the room, and stays.
  fake.liveCalls = null;
  await act(async () => void call.join("general" as never));
  await settle();
  await act(async () => update(() => (fake.liveCalls = [{ callId: "call1", channelId: "general", participants: [] }])));
  await settle();
  expect(call.status).toBe("connected");
});

test("picking the device the call had again before a switch away from it finishes moves the call back", async () => {
  await joined();
  const mic = published(Track.Source.Microphone).track;
  expect(mic.devices.at(-1)).toBe("default");
  // To the USB mic, which opens slowly; then back to the default before it's done.
  const opening = held("restart");
  await act(async () => saveDevice("audioinput", "mic-usb"));
  await settle();
  await act(async () => saveDevice("audioinput", "default"));
  await settle();
  opening.resolve();
  await settle();
  await settle();
  expect(savedDevice("audioinput")).toBe("default");
  expect(mic.devices.at(-1)).toBe("default");
  expect(all(Track.Source.Microphone)).toHaveLength(1);
});
