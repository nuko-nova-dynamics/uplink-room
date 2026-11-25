/**
 * How the app publishes each call quality choice (issue #87, ADR 0017). Which choices exist and what
 * a team's limit allows are the room's rules (`@uplink-room/backend/callQuality`); this file turns a
 * choice into LiveKit capture and publish options.
 */
import { AudioPresets, Track, VideoPreset, VideoPresets, type AudioCaptureOptions, type TrackPublishOptions, type VideoCaptureOptions } from "livekit-client";
import {
  CAMERA_QUALITIES,
  DEFAULT_SHARE_QUALITY,
  SHARE_QUALITIES,
  type CallQuality,
  type CameraQuality,
  type ShareQuality,
} from "@uplink-room/backend/callQuality";

export {
  CALL_QUALITIES,
  CALL_QUALITY_LIMITS,
  CAMERA_QUALITIES,
  cameraAllowed,
  DEFAULT_SHARE_QUALITY,
  effectiveCamera,
  effectiveShare,
  LIMIT_LABEL,
  SHARE_QUALITIES,
  shareAllowed,
  VOICE,
  voiceAllowed,
  type CallQuality,
  type CallQualityLimit,
  type CameraQuality,
  type ShareQuality,
} from "@uplink-room/backend/callQuality";

// ---------- voice ----------

/**
 * The microphone for a channel's voice quality. Standard and High keep the browser's echo
 * cancellation, noise suppression and auto gain, and Krisp on LiveKit Cloud. Music turns off
 * noise suppression, Krisp and auto gain, which damage music, keeps echo cancellation so the call
 * doesn't hear itself, and captures and sends stereo without DTX or RED, as LiveKit's hi-fi
 * settings do (docs.livekit.io, Codecs and more).
 */
export function micOptions(quality: CallQuality): { capture: AudioCaptureOptions; publish: TrackPublishOptions; krisp: boolean } {
  const source = Track.Source.Microphone;
  if (quality === "music") {
    return {
      capture: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, voiceIsolation: false, channelCount: 2 },
      publish: { source, audioPreset: AudioPresets.musicHighQualityStereo, forceStereo: true, dtx: false, red: false },
      krisp: false,
    };
  }
  return {
    capture: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    publish: {
      source,
      audioPreset: quality === "high" ? AudioPresets.musicHighQuality : AudioPresets.music,
      forceStereo: false,
      dtx: true,
      red: true,
    },
    krisp: true,
  };
}

// ---------- screen share ----------

type ShareSpec = {
  label: string;
  /** One line for the picker: what it sends and what it's for. */
  summary: string;
  /**
   * The top layer: the capture's largest size (the source keeps its own aspect inside it), its
   * frame rate, and the VP9 bitrate cap. The encoder uses less when the picture allows.
   */
  preset: VideoPreset;
  contentHint: "motion" | "detail";
  degradation: RTCDegradationPreference;
};

const MBPS = 1_000_000;

/**
 * A share's top layer. LiveKit's screen share presets stop at 1080p and 30 fps, so each choice has
 * its own preset, with its bitrate from one rule: LiveKit's VP8 preset for that size at 30 fps
 * (`ScreenSharePresets.h1080fps15` 2.5 Mbps, `h1080fps30` 5, `h720fps30` 2, `VideoPresets.h2160`
 * 8), times 1.5 at 60 fps (twice the frames, but each changes less from the last), times 0.85 for
 * VP9, the factor LiveKit applies itself when it picks a VP9 bitrate (`determineAppropriateEncoding`).
 */
function preset(width: number, height: number, fps: number, vp8At30: number): VideoPreset {
  const maxBitrate = Math.round((vp8At30 * (fps === 60 ? 1.5 : 1) * 0.85) / 100_000) * 100_000;
  return new VideoPreset(width, height, maxBitrate, fps, "medium");
}

/**
 * The share choices. At 60 fps (Smooth, Smooth HD, Source at 60) the hint is `motion` and the
 * frame rate holds when bandwidth drops; Sharp and Source at 30 are for text and hint `detail`,
 * keeping resolution. Balanced hints `detail` too: most shares are code, documents and apps, where
 * blurred text costs more than a dropped frame.
 */
export const SHARE: Record<ShareQuality, ShareSpec> = {
  sharp: {
    label: "Sharp",
    summary: "1080p at 15 fps, for reading code and text.",
    preset: preset(1920, 1080, 15, 2.5 * MBPS),
    contentHint: "detail",
    degradation: "maintain-resolution",
  },
  balanced: {
    label: "Balanced",
    summary: "1080p at 30 fps, for most sharing.",
    preset: preset(1920, 1080, 30, 5 * MBPS),
    contentHint: "detail",
    degradation: "balanced",
  },
  smooth: {
    label: "Smooth",
    summary: "720p at 60 fps, for video and games.",
    preset: preset(1280, 720, 60, 2 * MBPS),
    contentHint: "motion",
    degradation: "maintain-framerate",
  },
  smoothHd: {
    label: "Smooth HD",
    summary: "1080p at 60 fps, for video and games at full size.",
    preset: preset(1920, 1080, 60, 5 * MBPS),
    contentHint: "motion",
    degradation: "maintain-framerate",
  },
  source: {
    label: "Source",
    summary: "Your screen's own size, up to 4K, at 30 fps.",
    preset: preset(3840, 2160, 30, 8 * MBPS),
    contentHint: "detail",
    degradation: "maintain-resolution",
  },
  source60: {
    label: "Source",
    summary: "Your screen's own size, up to 4K, at 60 fps.",
    preset: preset(3840, 2160, 60, 8 * MBPS),
    contentHint: "motion",
    degradation: "maintain-framerate",
  },
};

/** The picker's buttons: Source covers `source` and `source60`, with the frame rate picked beside it. */
export const SHARE_CHOICES = ["sharp", "balanced", "smooth", "smoothHd", "source"] as const satisfies readonly ShareQuality[];
export type ShareChoice = (typeof SHARE_CHOICES)[number];
export const choiceOf = (quality: ShareQuality): ShareChoice => (quality === "source60" ? "source" : quality);
export const fpsOf = (quality: ShareQuality): number => SHARE[quality].preset.encoding.maxFramerate ?? 30;

/**
 * The frame rate Windows 11 capture gives a 60 fps share on a display faster than 60 Hz, or null
 * when 60 holds. Since Chromium 151, Windows 11 24H2 and later capture through Windows Graphics
 * Capture, which by default delivers a frame at most every 16 ms, so frames land on every second
 * or third refresh: about 48 fps at 144 Hz, 53 at 160, 55 at 165, and 60 at 120 or 240 (Chromium
 * issue 565075148, still open in Chromium 156, which Electron 45 uses).
 */
export function windowsCaptureFps(refreshRate: number | null): number | null {
  if (!refreshRate || refreshRate <= 60) return null;
  const fps = refreshRate / Math.ceil((16 * refreshRate) / 1000);
  return fps < 59 ? Math.round(fps) : null;
}

/**
 * Chromium's screen capture delivers about 0.92 of the frame rate asked for: on macOS, in Electron
 * 45, asking 60 gave 53 to 56 fps and asking 66 gave 61, on 75 Hz and 100 Hz displays alike (ADR
 * 0017). So capture asks 10% more, and the encoding's `maxFramerate` holds what is sent to the
 * choice's rate.
 */
export const CAPTURE_HEADROOM = 1.1;
const withHeadroom = (fps: number) => Math.ceil(fps * CAPTURE_HEADROOM);

/** getDisplayMedia's video constraints for a choice: never larger than the source, never upscaled. */
export function shareConstraints(quality: ShareQuality): MediaTrackConstraints {
  const { width, height } = SHARE[quality].preset;
  const fps = withHeadroom(fpsOf(quality));
  return { width: { max: width }, height: { max: height }, frameRate: { ideal: fps, max: fps } };
}

/**
 * How a share publishes: VP9 with VP8 as LiveKit's backup codec for a viewer that can't decode it
 * (ADR 0017), as rid simulcast of single-spatial-layer VP9 (`L1T3`). That gives a half-size layer
 * that adaptive stream, dynacast and a viewer's "Low" can pick, and LiveKit leaves the content
 * hint alone (it forces `motion` on screen shares only in multi-layer SVC mode).
 */
export function sharePublish(quality: ShareQuality): TrackPublishOptions {
  const spec = SHARE[quality];
  return {
    source: Track.Source.ScreenShare,
    videoCodec: "vp9",
    backupCodec: { codec: "vp8" },
    simulcast: true,
    scalabilityMode: "L1T3",
    screenShareEncoding: spec.preset.encoding,
    degradationPreference: spec.degradation,
  };
}

/**
 * How a share's own sound is captured: as Music voice is, in stereo with noise suppression and
 * auto gain off, which getDisplayMedia otherwise leaves on and which downmix it to mono. Echo
 * cancellation stays on, so the call's own voices, playing on the sharer's computer, are taken out
 * of the shared sound instead of going back to the call.
 */
export const SHARE_AUDIO_CAPTURE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 2 },
};

/** A share's own sound: Opus stereo at 128 kbps, whatever the channel's voice quality. */
export const SHARE_AUDIO_PUBLISH: TrackPublishOptions = {
  source: Track.Source.ScreenShareAudio,
  audioPreset: AudioPresets.musicHighQualityStereo,
  forceStereo: true,
  dtx: false,
  red: false,
};

// ---------- camera ----------


/** The camera at 720p or 1080p, 30 fps, with LiveKit's presets for each (VP8, simulcast). */
export function cameraOptions(quality: CameraQuality): { capture: VideoCaptureOptions; publish: TrackPublishOptions } {
  const preset = quality === "1080p" ? VideoPresets.h1080 : VideoPresets.h720;
  return {
    capture: { resolution: preset.resolution },
    publish: { source: Track.Source.Camera, videoEncoding: preset.encoding },
  };
}

// ---------- remembered on this computer ----------

const SHARE_KEY = "uplink.shareQuality";
const CAMERA_KEY = "uplink.cameraQuality";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return fallback;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore: the choice just isn't remembered.
  }
}

export const rememberedShare = () => read(SHARE_KEY, SHARE_QUALITIES, DEFAULT_SHARE_QUALITY);
export const rememberShare = (quality: ShareQuality) => write(SHARE_KEY, quality);
export const rememberedCamera = () => read(CAMERA_KEY, CAMERA_QUALITIES, "720p");
export const rememberCamera = (quality: CameraQuality) => write(CAMERA_KEY, quality);
