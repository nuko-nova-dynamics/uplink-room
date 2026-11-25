import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow, nativeImage, Notification } from "electron";
import { Banners } from "./notifyRegistry";
import { notifySpec, shouldShow, type NotifyChoice, type NotifyRequest } from "./notifySpec";

/**
 * System notifications (DESIGN.md, Notifications), shown by the main process
 * with Electron's Notification module:
 *
 *  - macOS: notifications need the signed app (an unsigned build emits `failed`),
 *    and the extra button needs `NSUserNotificationAlertStyle: alert` in
 *    Info.plist (electron-builder.yml `mac.extendInfo`). The icon is always the
 *    app's (Link's face).
 *  - Windows: toasts need the app's AppUserModelID, which the NSIS shortcut gets
 *    from `appId`, so the packaged app sets the same id (index.ts). A toast's id
 *    is at most 64 characters, so each banner gets a short id of its own, and a
 *    toast that timed out stays in Notification Center until it is removed.
 *  - Linux: libnotify; buttons show only if the notification server has the
 *    `actions` capability, and clicking the banner always opens.
 *
 * On Windows and Linux the banner's icon is Link, waiting (build/notification.png).
 * The app's own sound cue plays for these events, so banners are silent.
 *
 * `UPLINK_QUIET=1` (the screenshot script and other checks) never shows a
 * banner: each one is written to `UPLINK_NOTIFY_LOG` instead, as a JSON line,
 * and a stand-in is tracked in its place (whether or not the window has
 * focus), so the log also records when the app takes each one away.
 */
export const quiet = process.env["UPLINK_QUIET"] === "1";
const logFile = process.env["UPLINK_NOTIFY_LOG"];

function log(line: Record<string, unknown>): void {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...line })}\n`);
}

/** A shown Notification, or in quiet runs a stand-in whose closing is only logged. */
type Shown = { close(): void };

/**
 * The banners shown and still listed, each under a short system id (Windows takes at most 64
 * characters; notifyRegistry.ts). Holding the Notification keeps its events firing, and lets the
 * app remove it later: on Windows `close()` takes a timed-out toast out of Notification Center.
 */
const banners = new Banners<Shown>();

let icon: Electron.NativeImage | undefined;
function bannerIcon(): Electron.NativeImage | undefined {
  if (process.platform === "darwin") return undefined;
  if (icon) return icon;
  const file = app.isPackaged
    ? join(process.resourcesPath, "notification.png")
    : join(app.getAppPath(), "build", "notification.png");
  if (existsSync(file)) icon = nativeImage.createFromPath(file);
  return icon;
}

/**
 * A click or a button on a banner, with the request that banner showed and the renderer session it
 * belongs to now. Only that session acts on it: a click that lands after a team switch, in the
 * moment before the old session's banners are taken away, must not act in the new team.
 */
export type Answer = { choice: NotifyChoice; request: NotifyRequest; session: string };

export function notify(
  window: BrowserWindow,
  request: NotifyRequest,
  session: string,
  onAnswer: (answer: Answer) => void,
): void {
  const spec = notifySpec(request, process.platform);
  const nativeId = banners.nextId();
  // A banner interrupts; while the window has focus the Inbox and the sound cue already say it,
  // except for a message in a channel other than the one you're reading (shouldShow).
  const focused = window.isFocused();
  const show = shouldShow(request, focused);
  log({ event: "show", id: request.id, nativeId, focused, wouldShow: show, ...spec });
  if (quiet) {
    const standIn = { close: () => log({ event: "closed", id: request.id, nativeId }) };
    banners.add(nativeId, request, standIn, session)?.notification.close();
    return;
  }
  if (!show || !Notification.isSupported()) return;

  const image = bannerIcon();
  const notification = new Notification({
    id: nativeId,
    groupId: request.kind,
    title: spec.title,
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    body: spec.body,
    silent: true,
    ...(image ? { icon: image } : {}),
    actions: spec.buttons.map((b) => ({ type: "button" as const, text: b.text })),
  });
  // Acts on the request this banner showed, looked up by its own id, once.
  const answer = (choice: NotifyChoice) => {
    const entry = banners.take(nativeId);
    if (entry) onAnswer({ choice, request: entry.request, session: entry.session });
  };
  notification.on("click", () => answer("open"));
  notification.on("action", (event) => answer(spec.buttons[event.actionIndex]?.choice ?? "open"));
  // A toast that timed out stays in Windows' Notification Center, where it can still be clicked,
  // so it stays tracked until it's answered or the app takes it away (notifyRegistry.ts).
  notification.on("close", (event) => banners.closed(nativeId, event.reason));
  notification.on("failed", (_event, error) => {
    console.warn("Uplink Room: a notification could not be shown:", error);
    banners.closed(nativeId);
  });
  banners.add(nativeId, request, notification, session)?.notification.close();
  notification.show();
}

/**
 * The run was answered or the wheel moved on: take its banner away. On Windows, closing a toast
 * that already timed out removes it from Notification Center.
 */
export function dismiss(key: string): void {
  const entry = banners.release(key);
  if (!entry) return;
  log({ event: "dismiss", id: key, nativeId: entry.nativeId });
  entry.notification.close();
}

/**
 * A renderer session started (after a reload, a sign-in or opening a team) and sent what is live
 * now: take away every banner that is out of date, which a session that went away without
 * cleaning up (a reload) may have left behind.
 */
export function reconcile(session: string, live: readonly string[]): void {
  const dismissed = banners.reconcile(session, new Set(live));
  log({ event: "reconcile", session, live: live.length, dismissed: dismissed.map((e) => e.request.id) });
  for (const entry of dismissed) entry.notification.close();
}

/** A renderer session ended (sign-out, another team): take its banners away. */
export function endSession(session: string): void {
  const dismissed = banners.endSession(session);
  log({ event: "end", session, dismissed: dismissed.map((e) => e.request.id) });
  for (const entry of dismissed) entry.notification.close();
}
