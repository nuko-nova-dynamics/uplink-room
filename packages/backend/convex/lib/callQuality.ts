/**
 * Call quality (issue #87, ADR 0017): a channel's voice quality, the screen share choices, and the
 * team's limit on both. The room stores the channel's choice and the team's limit; each app
 * publishes with them. The desktop app imports this file too (`@uplink-room/backend/callQuality`),
 * so the rules about what a limit allows are written once.
 */
import { v, type Infer } from "convex/values";

/** A channel's voice quality. Absent on a channel: standard. */
export const vCallQuality = v.union(v.literal("standard"), v.literal("high"), v.literal("music"));
export type CallQuality = Infer<typeof vCallQuality>;
export const CALL_QUALITIES: readonly CallQuality[] = ["standard", "high", "music"];

/** How each voice quality publishes: Opus at this bitrate, mono or stereo. */
export const VOICE: Record<CallQuality, { label: string; kbps: number; stereo: boolean }> = {
  standard: { label: "Standard", kbps: 48, stereo: false },
  high: { label: "High", kbps: 96, stereo: false },
  music: { label: "Music", kbps: 128, stereo: true },
};

/** The team's "highest call quality allowed". Absent on a team: none, so everything is allowed. */
export const vCallQualityLimit = v.union(v.literal("standard"), v.literal("high"), v.literal("none"));
export type CallQualityLimit = Infer<typeof vCallQualityLimit>;
export const CALL_QUALITY_LIMITS: readonly CallQualityLimit[] = ["standard", "high", "none"];
export const LIMIT_LABEL: Record<CallQualityLimit, string> = { standard: "Standard", high: "High", none: "No limit" };

/**
 * A screen share's quality, chosen when sharing starts: Sharp (1080p, 15 fps), Balanced (1080p,
 * 30), Smooth (720p, 60), Smooth HD (1080p, 60), and Source (its own size up to 4K) at 30 fps
 * (`source`) or 60 (`source60`), the sharer's pick.
 */
export type ShareQuality = "sharp" | "balanced" | "smooth" | "smoothHd" | "source" | "source60";
export const SHARE_QUALITIES: readonly ShareQuality[] = ["sharp", "balanced", "smooth", "smoothHd", "source", "source60"];
export const DEFAULT_SHARE_QUALITY: ShareQuality = "balanced";

const LIMIT_RANK: Record<CallQualityLimit, number> = { standard: 0, high: 1, none: 2 };
const VOICE_RANK: Record<CallQuality, number> = { standard: 0, high: 1, music: 2 };
/**
 * Screen shares by the bandwidth each may use (the desktop app's lib/callQuality.ts has the
 * presets): Sharp (2.1 Mbps) fits the Standard limit, Smooth and Balanced (2.6 and 4.3) the High
 * one, and Smooth HD and Source (6.4 to 10.2) need no limit.
 */
const SHARE_RANK: Record<ShareQuality, number> = { sharp: 0, smooth: 1, balanced: 1, smoothHd: 2, source: 2, source60: 2 };

/** A person's camera quality, kept on their computer. */
export type CameraQuality = "720p" | "1080p";
export const CAMERA_QUALITIES: readonly CameraQuality[] = ["720p", "1080p"];
/** A 1080p camera (3 Mbps at LiveKit's preset) is above the Standard limit's 2.1 Mbps share; 720p fits it. */
const CAMERA_RANK: Record<CameraQuality, number> = { "720p": 0, "1080p": 1 };

export function cameraAllowed(quality: CameraQuality, limit: CallQualityLimit): boolean {
  return CAMERA_RANK[quality] <= LIMIT_RANK[limit];
}

/** The camera quality to publish: the one chosen, or 720p when the team's limit is below it. */
export function effectiveCamera(chosen: CameraQuality, limit: CallQualityLimit): CameraQuality {
  return cameraAllowed(chosen, limit) ? chosen : "720p";
}

export function limitOf(team: { callQualityLimit?: CallQualityLimit } | null): CallQualityLimit {
  return team?.callQualityLimit ?? "none";
}

export function voiceAllowed(quality: CallQuality, limit: CallQualityLimit): boolean {
  return VOICE_RANK[quality] <= LIMIT_RANK[limit];
}

export function shareAllowed(quality: ShareQuality, limit: CallQualityLimit): boolean {
  return SHARE_RANK[quality] <= LIMIT_RANK[limit];
}

/** What a channel's calls use: its choice, or the best the team's limit allows below it. */
export function effectiveVoice(chosen: CallQuality, limit: CallQualityLimit): CallQuality {
  for (let i = CALL_QUALITIES.indexOf(chosen); i > 0; i--) {
    if (voiceAllowed(CALL_QUALITIES[i]!, limit)) return CALL_QUALITIES[i]!;
  }
  return "standard";
}

/** The share quality to start with: the remembered one, or the closest the team's limit allows. */
export function effectiveShare(chosen: ShareQuality, limit: CallQualityLimit): ShareQuality {
  if (shareAllowed(chosen, limit)) return chosen;
  if (shareAllowed(DEFAULT_SHARE_QUALITY, limit)) return DEFAULT_SHARE_QUALITY;
  return "sharp";
}
