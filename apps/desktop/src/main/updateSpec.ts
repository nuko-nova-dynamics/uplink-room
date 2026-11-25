/**
 * When the app checks for updates and when it offers to restart (updates.ts runs electron-updater
 * on these rules; docs/releases.md has the release side). Kept free of Electron so the tests can
 * cover every decision.
 *
 *  - Installed builds check at launch, then whenever four hours have passed since the last check.
 *    Development builds, `UPLINK_NO_UPDATES=1`, and Linux packages other than the AppImage never
 *    check.
 *  - Only an update on the app's own channel is taken: a test build in the latest feed is refused
 *    before it downloads.
 *  - An update downloads in the background. Its signature is checked (updateSignature.ts) once it's
 *    downloaded, or found already downloaded, before it can install, and on macOS Squirrel.Mac then
 *    stages it. Only then does the app offer "Restart to update". While you're in a call it neither
 *    offers the restart nor restarts.
 *  - A ready update also installs on its own: the app restarts itself once nobody is using the
 *    computer (no input for 30 minutes, or the screen is locked), nobody here is in a call, and the
 *    app's bridge has no terminal that quitting would end (autoRestartDue). It opens again afterwards.
 *  - A downloaded, checked update also installs whenever the app next quits.
 *  - If anything fails (the check, the download, the signature, staging or the install), the offer
 *    ends and a check can start again.
 */

/** Hours between checks. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** How often the app asks whether a check is due. Short, so a computer waking from sleep checks soon after. */
export const TICK_MS = 10 * 60 * 1000;

/**
 * Release channels, each a folder of the update feed (`https://uplinkroom.com/updates/<channel>/`).
 * A version's prerelease tag names its channel: 0.2.0 is on latest, 0.2.1-test.1 on test.
 */
export const CHANNELS = ["latest", "test"] as const;
export type UpdateChannel = (typeof CHANNELS)[number];

/** The feed's address, as electron-builder.yml `publish.url` bakes it into the app (a test checks they agree). */
export const FEED_BASE = "https://uplinkroom.com/updates";
export function feedUrl(channel: UpdateChannel): string {
  return `${FEED_BASE}/${channel}`;
}

/** The channel a version belongs to, or null for a prerelease tag that isn't a channel (0.2.0-beta.1). */
export function channelOf(version: string): UpdateChannel | null {
  const match =
    /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  const tag = match[1];
  if (tag === undefined) return "latest";
  return tag === "test" ? "test" : null;
}

/**
 * Whether the app may take this update: only one on its own channel. The latest feed is read only
 * by latest builds, so a test version there was put there by someone else; its signature (made for
 * the test channel) wouldn't pass either, but it's refused before it downloads.
 */
export function onChannel(state: Pick<UpdateState, "channel">, version: string): boolean {
  return state.channel !== null && channelOf(version) === state.channel;
}

/** Why the last update was refused. */
export type UpdateRefusal =
  | "signature" // its signature didn't check out
  | "channel"; // it was for another channel

/** Why this install doesn't update itself, or null when it does. */
export type UpdatesOff =
  | "development" // not an installed build
  | "turned-off" // UPLINK_NO_UPDATES=1
  | "linux-package" // a .deb (or anything but the AppImage) on Linux: install new versions from the download page
  | "unknown-channel"; // a prerelease version that belongs to no channel

export function updatesOff(input: {
  isPackaged: boolean;
  platform: string;
  version: string;
  env: Record<string, string | undefined>;
}): UpdatesOff | null {
  if (!input.isPackaged) return "development";
  if (input.env["UPLINK_NO_UPDATES"] === "1") return "turned-off";
  if (input.platform === "linux" && !input.env["APPIMAGE"]) return "linux-package";
  if (!channelOf(input.version)) return "unknown-channel";
  return null;
}

export type UpdatePhase =
  | "off" // this install doesn't update (see `off`)
  | "idle" // up to date, or not checked yet
  | "checking"
  | "downloading"
  | "preparing" // downloaded; its signature is being checked, and on macOS Squirrel.Mac is staging it
  | "ready" // checked (and on macOS staged); installs on restart or quit
  | "failed"; // the last check, download, signature check or install failed, or the update was refused

/** What the renderer shows: Settings, Updates, and the "Restart to update" prompt. */
export type UpdateState = {
  phase: UpdatePhase;
  /** The running version. */
  version: string;
  channel: UpdateChannel | null;
  off: UpdatesOff | null;
  /** The version being downloaded or ready to install. */
  next?: string;
  /** Download progress, 0 to 100. */
  percent?: number;
  /** When the last check started (ms since the epoch). */
  checkedAt?: number;
  /** True while this person is in a call (the renderer reports it). */
  inCall: boolean;
  /** Set when the last update was refused: its signature didn't check out, or it was for another channel. */
  failure?: UpdateRefusal;
};

export function initialState(input: Parameters<typeof updatesOff>[0]): UpdateState {
  const off = updatesOff(input);
  return {
    phase: off ? "off" : "idle",
    version: input.version,
    channel: channelOf(input.version),
    off,
    inCall: false,
  };
}

export type UpdateEvent =
  | { type: "check"; at: number }
  | { type: "available"; version: string }
  | { type: "progress"; percent: number }
  | { type: "not-available" }
  | { type: "downloaded"; version: string }
  | { type: "prepared" }
  | { type: "failed"; reason?: UpdateRefusal }
  | { type: "call"; inCall: boolean };

export function reduce(state: UpdateState, event: UpdateEvent): UpdateState {
  if (event.type === "call") return { ...state, inCall: event.inCall };
  if (state.phase === "off") return state;
  switch (event.type) {
    case "check": {
      const { failure: _failure, ...rest } = state;
      return { ...rest, phase: "checking", checkedAt: event.at };
    }
    case "available":
      return { ...state, phase: "downloading", next: event.version, percent: 0 };
    case "progress":
      return state.phase === "downloading"
        ? { ...state, percent: Math.max(0, Math.min(100, Math.round(event.percent))) }
        : state;
    case "not-available": {
      const { next: _next, percent: _percent, ...rest } = state;
      return { ...rest, phase: "idle" };
    }
    case "downloaded": {
      // Every platform checks the signature after the download (or of a file already downloaded),
      // so a downloaded update is never ready at once.
      const { percent: _percent, ...rest } = state;
      return { ...rest, phase: "preparing", next: event.version };
    }
    case "prepared":
      return state.phase === "preparing" ? { ...state, phase: "ready" } : state;
    case "failed": {
      // Whatever failed (a check, a download, the signature, staging, the install), the offer ends:
      // the prompt goes, and a check can fetch the update again.
      const { next: _next, percent: _percent, failure: _failure, ...rest } = state;
      return { ...rest, phase: "failed", ...(event.reason ? { failure: event.reason } : {}) };
    }
  }
}

/**
 * Whether a scheduled check should start now: at launch (never checked), then four hours after the
 * last one, failed or not. Never while a check or download runs, and not once an update is ready,
 * so the file waiting to install isn't replaced under it.
 */
export function checkDue(state: UpdateState, now: number): boolean {
  if (
    state.phase === "off" ||
    state.phase === "checking" ||
    state.phase === "downloading" ||
    state.phase === "preparing" ||
    state.phase === "ready"
  )
    return false;
  return state.checkedAt === undefined || now - state.checkedAt >= CHECK_EVERY_MS;
}

/** Whether "Check for updates" (Settings) may start a check now. */
export function canCheckNow(state: UpdateState): boolean {
  return state.phase === "idle" || state.phase === "failed";
}

/**
 * Whether to show "Restart to update", and whether a restart may happen: an update that's
 * downloaded, checked and staged, and no call. The app asks again right before it quits.
 */
export function canRestart(state: UpdateState): boolean {
  return state.phase === "ready" && !state.inCall;
}

/** Seconds without keyboard or mouse input before the app may restart itself to install an update. */
export const AUTO_RESTART_IDLE_SECONDS = 30 * 60;
/** How often the app asks whether it may restart itself, while an update is ready. */
export const AUTO_RESTART_TICK_MS = 60 * 1000;

/** What the app knows about the computer when it asks whether to restart itself. */
export type Quiet = {
  /** Electron's powerMonitor.getSystemIdleState(AUTO_RESTART_IDLE_SECONDS). */
  idle: "active" | "idle" | "locked" | "unknown";
  /** Terminals the app's bridge would end by quitting, or null when it couldn't tell. */
  terminals: number | null;
};

/**
 * Whether the app restarts itself now to install a ready update: everything "Restart to update"
 * needs (canRestart), and nobody at the computer (idle or locked; "unknown", as on some Linux
 * desktops, never counts), and no terminal of the app's bridge that quitting would end.
 */
export function autoRestartDue(state: UpdateState, quiet: Quiet): boolean {
  if (!canRestart(state)) return false;
  if (quiet.idle !== "idle" && quiet.idle !== "locked") return false;
  return quiet.terminals === 0;
}

/**
 * Errors worth an error report. A computer that's offline or behind a captive portal fails every
 * check the same way, so network failures are left out; everything else (a bad feed, a failed
 * signature check, a full disk) is reported once per launch for each code.
 */
const OFFLINE =
  /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED|TIMED_OUT)|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED)$/;

/** A short code for an error: electron-updater's own (`ERR_UPDATER_…`), a Node or Chromium network code, or an HTTP status. */
export function errorCode(error: unknown): string {
  const e = error as { code?: unknown; statusCode?: unknown; message?: unknown } | null;
  if (typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code)) return e.code;
  if (typeof e?.statusCode === "number") return `HTTP_${e.statusCode}`;
  // Chromium's net errors arrive in the message, as in `net::ERR_INTERNET_DISCONNECTED`.
  const net =
    typeof e?.message === "string" ? /net::(ERR_[A-Z_]+)/.exec(e.message)?.[1] : undefined;
  return net ?? "UNKNOWN";
}

export function isOffline(code: string): boolean {
  return OFFLINE.test(code);
}
