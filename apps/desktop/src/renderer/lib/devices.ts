/**
 * Microphones, speakers and cameras on this computer (docs/devices.md): what there is, which one
 * the person chose for each kind, a microphone's level, a camera's preview and a speaker test.
 * Calls (lib/call.tsx, lib/callMedia.ts), the call settings popover and Settings, Calls use it,
 * and so can anything else that needs a device, such as onboarding, without device code of its own.
 *
 * The API:
 *  - `listDevices(kind)` and `useDevices(kind)`: the devices of a kind, "System default" first.
 *  - `onDevicesChange(listener)`: a device was plugged in or unplugged (`devicechange`).
 *  - `savedDevice(kind)`, `saveDevice(kind, id)` and `useSavedDevice(kind)`: the choice per kind,
 *    kept on this computer. `DEFAULT_DEVICE` ("default") follows the system's default device.
 *  - `deviceFor(kind, devices)`: the device to open for the saved choice, falling back to the
 *    system default while the chosen one is unplugged.
 *  - `useMicLevel(source)`: a microphone's level, 0 to 1, from a track or by opening the device.
 *  - `useCameraPreview(options)`: a camera's picture before it's published, stopped on cancel.
 *  - `playTestSound(outputId)` and `useTestSound(outputId)`: a short sound on a speaker.
 * The pickers built on it are in components/Devices.tsx.
 *
 * Under synthetic media (`UPLINK_FAKE_MEDIA=1`) nothing here opens a device: the lists hold sample
 * devices, the level meter moves on its own and the preview is a drawn picture.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fakeMedia } from "./desktop";
import { log } from "./log";

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";
/** The choice that follows the system's default device. */
export const DEFAULT_DEVICE = "default";

export type DeviceOption = {
  /** `DEFAULT_DEVICE`, or the browser's device id. */
  id: string;
  label: string;
  /** Devices from one piece of hardware share a group (a headset's microphone and speaker). */
  groupId: string;
};

export const KIND_LABEL: Record<DeviceKind, string> = {
  audioinput: "Microphone",
  audiooutput: "Speaker",
  videoinput: "Camera",
};

// ---------- the saved choice ----------

const STORAGE: Record<DeviceKind, string> = {
  audioinput: "uplink.device.audioinput",
  audiooutput: "uplink.device.audiooutput",
  videoinput: "uplink.device.videoinput",
};
const saved = new Map<DeviceKind, string>();
const savedListeners = new Set<() => void>();

/** The device chosen for a kind on this computer, or `DEFAULT_DEVICE`. */
export function savedDevice(kind: DeviceKind): string {
  if (!saved.has(kind)) {
    let value: string | null = null;
    try {
      value = localStorage.getItem(STORAGE[kind]);
    } catch {
      // Storage unavailable: the system default.
    }
    saved.set(kind, value || DEFAULT_DEVICE);
  }
  return saved.get(kind)!;
}

/** Remembers the device for a kind on this computer. Calls switch to it at once (lib/call.tsx). */
export function saveDevice(kind: DeviceKind, id: string): void {
  const value = id || DEFAULT_DEVICE;
  if (savedDevice(kind) === value) return;
  saved.set(kind, value);
  try {
    if (value !== DEFAULT_DEVICE) localStorage.setItem(STORAGE[kind], value);
    else localStorage.removeItem(STORAGE[kind]);
  } catch {
    // Not remembered past this launch.
  }
  log.info("devices", "device chosen", { kind, choice: value === DEFAULT_DEVICE ? "default" : "a device" });
  for (const listener of savedListeners) listener();
}

/** Calls `listener` when the saved choice for any kind changes. */
export function onSavedDeviceChange(listener: () => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

/** For tests: forget what was read from storage. */
export function resetSavedDevices(): void {
  saved.clear();
}

export function useSavedDevice(kind: DeviceKind): [string, (id: string) => void] {
  const value = useSyncExternalStore(onSavedDeviceChange, () => savedDevice(kind));
  const set = useCallback((id: string) => saveDevice(kind, id), [kind]);
  return [value, set];
}

// ---------- listing ----------

const SAMPLE: Record<DeviceKind, DeviceOption[]> = {
  audioinput: [
    { id: "sample-mic-1", label: "Built-in microphone (sample)", groupId: "g1" },
    { id: "sample-mic-2", label: "USB microphone (sample)", groupId: "g2" },
  ],
  audiooutput: [
    { id: "sample-out-1", label: "Built-in speakers (sample)", groupId: "g1" },
    { id: "sample-out-2", label: "Headphones (sample)", groupId: "g3" },
  ],
  videoinput: [
    { id: "sample-cam-1", label: "Built-in camera (sample)", groupId: "g1" },
    { id: "sample-cam-2", label: "USB camera (sample)", groupId: "g4" },
  ],
};

/**
 * The devices of a kind, with "System default" first (a camera has no system default, so its
 * default is the first camera). Labels are empty until the app has been allowed the device once;
 * `labelled` says whether they're there.
 */
export async function listDevices(kind: DeviceKind): Promise<{ devices: DeviceOption[]; labelled: boolean }> {
  if (fakeMedia) return { devices: [{ id: DEFAULT_DEVICE, label: "System default", groupId: "" }, ...SAMPLE[kind]], labelled: true };
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const ofKind = all.filter((d) => d.kind === kind && d.deviceId !== "communications");
  const real = ofKind.filter((d) => d.deviceId && d.deviceId !== DEFAULT_DEVICE);
  const systemDefault = ofKind.find((d) => d.deviceId === DEFAULT_DEVICE);
  const labelled = ofKind.some((d) => d.label);
  const devices: DeviceOption[] = [
    {
      id: DEFAULT_DEVICE,
      // Chromium names the default "Default - <device>"; say which device that is now.
      label:
        kind === "videoinput"
          ? "First camera"
          : systemDefault?.label
            ? `System default (${systemDefault.label.replace(/^Default - /, "")})`
            : "System default",
      groupId: systemDefault?.groupId ?? "",
    },
    ...real.map((d, i) => ({ id: d.deviceId, label: d.label || `${KIND_LABEL[kind]} ${i + 1}`, groupId: d.groupId })),
  ];
  return { devices, labelled };
}

/** Calls `listener` when a device is plugged in or unplugged. */
export function onDevicesChange(listener: () => void): () => void {
  const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!md?.addEventListener) return () => {};
  md.addEventListener("devicechange", listener);
  return () => md.removeEventListener("devicechange", listener);
}

/** The devices of a kind, kept up to date as they're plugged in and unplugged. */
export function useDevices(kind: DeviceKind): { devices: DeviceOption[]; labelled: boolean; ready: boolean; refresh: () => void } {
  const [state, setState] = useState<{ devices: DeviceOption[]; labelled: boolean; ready: boolean }>({
    devices: [{ id: DEFAULT_DEVICE, label: kind === "videoinput" ? "First camera" : "System default", groupId: "" }],
    labelled: false,
    ready: false,
  });
  const refresh = useCallback(() => {
    void listDevices(kind)
      .then((listed) => setState({ ...listed, ready: true }))
      .catch(() => setState((s) => ({ ...s, ready: true })));
  }, [kind]);
  useEffect(() => {
    refresh();
    return onDevicesChange(refresh);
  }, [refresh]);
  return { ...state, refresh };
}

/**
 * The device to open for a kind's saved choice: the chosen one while it's plugged in, else the
 * system default. `missing` is true when the chosen one isn't there.
 */
export function deviceFor(kind: DeviceKind, devices: readonly DeviceOption[], choice = savedDevice(kind)): { id: string; missing: boolean } {
  if (choice === DEFAULT_DEVICE) return { id: DEFAULT_DEVICE, missing: false };
  if (devices.some((d) => d.id === choice)) return { id: choice, missing: false };
  return { id: DEFAULT_DEVICE, missing: true };
}

/** A `getUserMedia` device constraint for a device id: none for a camera's default. */
export function deviceConstraint(kind: DeviceKind, id: string): { deviceId?: ConstrainDOMString } {
  if (id === DEFAULT_DEVICE) return kind === "videoinput" ? {} : { deviceId: DEFAULT_DEVICE };
  return { deviceId: { exact: id } };
}

// ---------- the microphone's level ----------

/** RMS of a block of samples on a scale where speech sits around the middle: 0 to 1. */
export function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  // -60 dBFS reads as 0, -10 dBFS and louder as 1.
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/**
 * A microphone's level, 0 to 1, about 15 times a second. `source` is a live track (a call's
 * microphone), a device id to open just for the meter (before a call), or null for none. A device
 * opened here is stopped when the meter goes.
 */
export function useMicLevel(source: MediaStreamTrack | string | null): { level: number; error: string | null } {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLevel(0);
    setError(null);
    if (source === null) return;
    if (fakeMedia) {
      const timer = setInterval(() => setLevel(0.25 + 0.35 * Math.abs(Math.sin(Date.now() / 400))), 66);
      return () => clearInterval(timer);
    }
    let stopped = false;
    let opened: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        if (typeof source === "string") {
          opened = await navigator.mediaDevices.getUserMedia({
            audio: { ...deviceConstraint("audioinput", source), echoCancellation: true, noiseSuppression: true },
          });
        }
        const track = typeof source === "string" ? opened!.getAudioTracks()[0]! : source;
        if (stopped) return;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          setLevel(levelOf(samples));
        }, 66);
      } catch (e) {
        if (!stopped) setError(deviceError(e, "microphone"));
      } finally {
        if (stopped) for (const t of opened?.getTracks() ?? []) t.stop();
      }
    })();
    return () => {
      stopped = true;
      clearInterval(timer);
      void context?.close().catch(() => {});
      for (const t of opened?.getTracks() ?? []) t.stop();
    };
  }, [source]);
  return { level, error };
}

/** What to tell the person when a device won't open. */
export function deviceError(error: unknown, what: "microphone" | "camera"): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError")
    return `Uplink Room isn't allowed to use the ${what}. Allow it in System Settings, Privacy & Security, ${what === "camera" ? "Camera" : "Microphone"}.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `That ${what} isn't connected.`;
  if (name === "NotReadableError") return `Another app is using the ${what}, or it stopped responding.`;
  return `The ${what} didn't open.`;
}

// ---------- the camera's preview ----------

/**
 * A camera's picture before it goes out: opens the device while `enabled`, and stops it when
 * disabled, unmounted, or the device or size changes. Nothing is published.
 */
export function useCameraPreview({ deviceId, width, height, enabled }: { deviceId: string; width: number; height: number; enabled: boolean }): {
  stream: MediaStream | null;
  error: string | null;
  starting: boolean;
} {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    setStream(null);
    setError(null);
    if (!enabled) return;
    let stopped = false;
    let opened: MediaStream | null = null;
    setStarting(true);
    void (async () => {
      try {
        opened = fakeMedia
          ? drawnCamera(width, height)
          : await navigator.mediaDevices.getUserMedia({
              video: { ...deviceConstraint("videoinput", deviceId), width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
            });
        if (stopped) {
          for (const t of opened.getTracks()) t.stop();
          return;
        }
        setStream(opened);
        log.info("devices", "camera preview started", { width, height });
      } catch (e) {
        if (!stopped) {
          setError(deviceError(e, "camera"));
          log.warn("devices", "camera preview failed", { type: (e as Error)?.name ?? "unknown" });
        }
      } finally {
        if (!stopped) setStarting(false);
      }
    })();
    return () => {
      stopped = true;
      for (const t of opened?.getTracks() ?? []) t.stop();
      setStarting(false);
    };
  }, [deviceId, width, height, enabled]);
  return { stream, error, starting };
}

/** The synthetic camera's picture, for tests and screenshots. */
function drawnCamera(width: number, height: number): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = Math.round((640 * height) / width);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#273140";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#3a4a60";
  g.beginPath();
  g.arc(canvas.width / 2, canvas.height / 2, canvas.height / 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#8f939b";
  g.font = "400 18px 'Atkinson Hyperlegible Next', sans-serif";
  g.fillText("Synthetic camera", 20, 34);
  return canvas.captureStream(12);
}

// ---------- the speaker test ----------

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** Plays a short three-note sound on a speaker (`DEFAULT_DEVICE` for the system's). Resolves when it's done. */
export async function playTestSound(outputId: string): Promise<void> {
  const context = new AudioContext() as SinkContext;
  try {
    if (outputId !== DEFAULT_DEVICE && !fakeMedia) await context.setSinkId?.(outputId);
    const start = context.currentTime + 0.05;
    for (const [i, frequency] of [523, 659, 784].entries()) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.frequency.value = frequency;
      const at = start + i * 0.18;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0004, at + 0.4);
      osc.connect(gain).connect(context.destination);
      osc.start(at);
      osc.stop(at + 0.45);
    }
    await new Promise((r) => setTimeout(r, 1000));
  } finally {
    await context.close().catch(() => {});
  }
}

/** A speaker test with a "playing" state for its button. */
export function useTestSound(outputId: string): { playing: boolean; play: () => void } {
  const [playing, setPlaying] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const play = useCallback(() => {
    setPlaying(true);
    log.info("devices", "speaker test", { choice: outputId === DEFAULT_DEVICE ? "default" : "a device" });
    void playTestSound(outputId)
      .catch(() => log.warn("devices", "speaker test failed"))
      .finally(() => {
        if (alive.current) setPlaying(false);
      });
  }, [outputId]);
  return { playing, play };
}
