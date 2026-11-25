import * as Sentry from "@sentry/node";
import type { NodeOptions } from "@sentry/node";
import {
  TelemetryTestError,
  scrubBreadcrumb,
  scrubEvent,
  scrubOptions,
  telemetryDisabled,
  telemetryTest,
} from "./scrub.ts";

/**
 * Error reports from the bridge (Sentry project `uplink-room-bridge`): crashes, unhandled
 * rejections, a running bridge losing its room link, and programming errors in any command.
 * Only bundled builds report (`dist/uplink-bridge.mjs` and the copy inside the desktop app),
 * because only their build sets `__UPLINK_BRIDGE_RELEASE__`; running from source never does.
 * `UPLINK_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off. What a report may carry is decided in
 * scrub.ts.
 */

/** The `uplink-room-bridge` project's DSN. A DSN is public; it only lets a client send events. */
export const BRIDGE_DSN =
  "https://34e4e6da8c5a589cbf365a3a80414623@o4510681284804608.ingest.us.sentry.io/4512365834141696";

declare const __UPLINK_BRIDGE_RELEASE__: string | undefined;

/** The bundle's release, such as `uplink-room-bridge@0.1.0`, or undefined when running from source. */
export function bundledRelease(): string | undefined {
  return typeof __UPLINK_BRIDGE_RELEASE__ === "string" ? __UPLINK_BRIDGE_RELEASE__ : undefined;
}

let started = false;

/**
 * The SDK options: errors only (no tracing, logs or profiles), no hostname, no request data, no
 * console or HTTP breadcrumbs, no local variables or source lines, and every event and breadcrumb
 * passed through scrub.ts.
 */
export function telemetryOptions(
  dsn: string,
  release: string,
  env: NodeJS.ProcessEnv = process.env,
  extra: Partial<NodeOptions> = {},
): NodeOptions {
  const scrub = scrubOptions(env);
  return {
    dsn,
    release,
    environment: "production",
    includeServerName: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    initialScope: {
      tags: { "bridge.host": process.versions["electron"] ? "app" : "standalone" },
    },
    beforeSend: (event) => scrubEvent(event, scrub),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, scrub),
    ...extra,
  };
}

/**
 * Starts error reporting when this is a bundled build with a DSN and the person hasn't opted out.
 * Returns whether it started. `UPLINK_BRIDGE_SENTRY_DSN` overrides the DSN (a test receiver).
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  const release = bundledRelease();
  const dsn = env["UPLINK_BRIDGE_SENTRY_DSN"] || BRIDGE_DSN;
  if (started || !release || !dsn || telemetryDisabled(env)) return false;
  Sentry.init(telemetryOptions(dsn, release, env));
  started = true;
  return true;
}

/** With `UPLINK_TELEMETRY_TEST=1`, sends one TelemetryTestError and waits for it to go. */
export async function sendTestError(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (started && telemetryTest(env))
    await reportError(new TelemetryTestError("Bridge telemetry test"));
}

/** Ties reports to the member the machine belongs to (or who linked it), and its room machine id. */
export function setTelemetryMachine(
  member: string | null | undefined,
  machineId: string | undefined,
): void {
  if (!started) return;
  Sentry.setUser(member ? { id: member } : null);
  if (machineId) Sentry.setTag("machine", machineId);
}

/** Reports an error and waits up to two seconds for it to be sent, so a process about to exit still sends it. */
export async function reportError(error: unknown): Promise<void> {
  if (!started) return;
  Sentry.captureException(error);
  await Sentry.flush(2000);
}

/**
 * Whether a failed command is worth a report. A command fails with a plain `Error` (or the room's
 * `ConvexError`) for things the person can fix, such as a missing pairing or a bad code; those
 * aren't reported. A `TypeError`, `RangeError` or anything else is a bug.
 */
export function isBug(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.name !== "Error" && error.name !== "ConvexError";
}
