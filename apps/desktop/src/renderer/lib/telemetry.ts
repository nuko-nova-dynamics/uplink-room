import * as Sentry from "@sentry/electron/renderer";
import { TelemetryTestError, scrubBreadcrumb, scrubEvent } from "@uplink-room/bridge/scrub";
import { desktop } from "./desktop";
import { nameBlobFrames } from "./log";

/**
 * Error reports from the app's window, in release builds only (see main/telemetry.ts, which sends
 * them and scrubs them again). The renderer's SDK takes no DSN or release; the main process has them.
 *
 * Breadcrumbs from the console and from the DOM (clicks and key presses, which name the element
 * and can include its text) are off. Session Replay is off: the terminal view draws its text into
 * the page (xterm's DOM renderer), and file and page names sit in `title` attributes, so a replay
 * would rely on masking defaults covering every one of them.
 */
let started = false;

export function startTelemetry(): void {
  if (
    import.meta.env.MODE !== "release" ||
    !import.meta.env["VITE_SENTRY_DSN"] ||
    desktop.telemetryOff
  )
    return;
  Sentry.init({
    integrations: (defaults) => [
      // Console breadcrumbs come from their own integration ("Console").
      ...defaults.filter(
        (integration) => integration.name !== "Breadcrumbs" && integration.name !== "Console",
      ),
      Sentry.breadcrumbsIntegration({
        dom: false,
        fetch: true,
        xhr: true,
        history: true,
        sentry: true,
      }),
    ],
    // A frame in a blob: script (Krisp's code) is named by the bundle that made it (lib/log.ts).
    // Error messages are left for the main process, which templates each once, after taking out
    // the environment's values (this window doesn't know them).
    beforeSend: (event) => scrubEvent(nameBlobFrames(event), { messagesLater: true }),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  started = true;
  if (desktop.telemetryTest)
    Sentry.captureException(new TelemetryTestError("Renderer telemetry test"));
}

/** Ties reports to the signed-in member of the open team, by member id only. Null clears it. */
export function setTelemetryMember(memberId: string | null): void {
  if (started) Sentry.setUser(memberId ? { id: memberId } : null);
}
