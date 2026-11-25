import * as Sentry from "@sentry/electron/main";
import { IPCMode } from "@sentry/electron/main";
import { app } from "electron";
import {
  TelemetryTestError,
  scrubBreadcrumb,
  scrubEvent,
  scrubOptions,
  telemetryDisabled,
  telemetryTest,
} from "@uplink-room/bridge/scrub";
import { channelOf } from "./updateSpec";

/**
 * Error reports from the app (Sentry project `uplink-room-desktop`). Only release builds
 * (`electron-vite build --mode release`, which `pnpm dist` and the Package workflow use) report,
 * and only when `.env.release` sets `VITE_SENTRY_DSN`. Development and test builds never start it,
 * and `UPLINK_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off, as for the bridge.
 *
 * Renderer errors reach Sentry through this process (the renderer's SDK sends them over IPC), so
 * `beforeSend` here scrubs every event, the renderer's included. What an event may carry is decided
 * in packages/bridge/src/telemetry/scrub.ts.
 *
 * Integrations left out, and why:
 *  - ElectronMinidump: a native crash dump holds raw process memory, which can include terminal
 *    output, documents and tokens. Renderer and GPU crashes are still reported (ChildProcess), with
 *    no dump.
 *  - Console, LocalVariables, ContextLines: console output and variable values can hold anything
 *    on screen; source lines come from the uploaded source maps instead.
 *  - Screenshots: off by default already; listed so it stays off.
 *  - PreloadInjection: the main process is bundled, so the SDK can't find its preload file. The
 *    app's own preload loads it instead (src/preload/index.ts).
 *  - GpuContext: it calls `app.getGPUInfo()` for each event, and an error before the app is ready
 *    then starts Chromium's GPU manager too early, which fails Chromium's check (`Check failed: !GpuDataManagerImpl::Initialized()`).
 */
const LEFT_OUT = new Set([
  "GpuContext",
  "ElectronMinidump",
  "SentryMinidump",
  "Console",
  "LocalVariables",
  "ContextLines",
  "Screenshots",
  "PreloadInjection",
]);

declare const __UPLINK_DESKTOP_RELEASE__: string | undefined;

let started = false;

export function startTelemetry(): boolean {
  const dsn = import.meta.env["VITE_SENTRY_DSN"] as string | undefined;
  const release =
    typeof __UPLINK_DESKTOP_RELEASE__ === "string" ? __UPLINK_DESKTOP_RELEASE__ : undefined;
  if (import.meta.env.MODE !== "release" || !dsn || !release || telemetryDisabled(process.env))
    return false;
  const scrub = scrubOptions(process.env);
  Sentry.init({
    dsn,
    release,
    // Test-channel builds (0.2.1-test.1, docs/releases.md) report apart from the released app.
    environment: channelOf(app.getVersion()) === "test" ? "test" : "production",
    // Renderers talk to this process over IPC, through the app's preload. The `sentry-ipc://`
    // protocol would need a CSP exception in the app's pages.
    ipcMode: IPCMode.Classic,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    integrations: (defaults) => defaults.filter((integration) => !LEFT_OUT.has(integration.name)),
    beforeSend: (event) => scrubEvent(event, scrub),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, scrub),
  });
  started = true;
  // UPLINK_TELEMETRY_TEST=1 checks the setup end to end (the renderer sends one too).
  if (telemetryTest(process.env))
    void app
      .whenReady()
      .then(() => Sentry.captureException(new TelemetryTestError("Main process telemetry test")));
  return true;
}

/**
 * Reports an error the app handled (a failed update check, for one), with tags that say where it
 * happened. Tags are short codes, never text from the error. Does nothing when error reports are
 * off. Like every event, it passes `scrubEvent`, which keeps only the error's type and stack.
 */
export function reportError(error: unknown, tags: Record<string, string>): void {
  if (!started) return;
  try {
    Sentry.captureException(error, { tags });
  } catch {
    // Error reports never get in the way of the app.
  }
}
