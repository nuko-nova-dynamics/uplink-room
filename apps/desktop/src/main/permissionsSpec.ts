/**
 * The permissions the app uses (research/onboarding-permissions.md), and what onboarding offers for
 * each state. Pure, so the renderer, the gym and the tests share it.
 *
 * - Microphone and camera: calls. macOS has a prompt for them, shown once; after a denial only
 *   System Settings can turn them on, and the app must restart.
 * - Screen Recording: sharing a screen in a call. There is no prompt to ask for; the app is listed
 *   once it asks for the screens, and you switch it on (or drag it in) in System Settings.
 * - Notifications: banners. macOS asks the first time the signed app shows one; Electron can't read
 *   the setting, so its state is "unknown".
 * Nothing in the app needs Accessibility: no feature types or clicks on this computer.
 */

export type PermissionKind = "microphone" | "camera" | "screen" | "notifications";
/** Electron's `getMediaAccessStatus` answers, plus "unknown" where nothing can be read. */
export type PermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export type PermissionsState = {
  platform: string;
  /** False in development, where the running app is Electron's own and the drag tile would name it. */
  packaged: boolean;
  /** The app's name as System Settings lists it. */
  appName: string;
  statuses: Record<PermissionKind, PermissionStatus>;
};

export const PERMISSION_KINDS: PermissionKind[] = ["microphone", "camera", "screen", "notifications"];

/** System Settings' Privacy & Security panes (the URLs Hex opens), and Notifications. */
export const SETTINGS_PANE: Record<PermissionKind, string> = {
  microphone: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
  camera: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Camera",
  screen: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
};

export function isPermissionKind(value: unknown): value is PermissionKind {
  return typeof value === "string" && (PERMISSION_KINDS as string[]).includes(value);
}

/**
 * What onboarding offers for a permission:
 *  - `ask`: macOS's own prompt (microphone, camera, not asked yet);
 *  - `list`: open Screen Recording, where the app is added by dragging it in;
 *  - `switch-on`: open the pane, where the app is already listed and only needs switching on;
 *  - `test`: show a banner, which makes macOS ask the first time;
 *  - `none`: nothing to do.
 */
export type PermissionAction = "ask" | "list" | "switch-on" | "test" | "none";

export function actionFor(kind: PermissionKind, status: PermissionStatus): PermissionAction {
  if (status === "granted") return "none";
  if (kind === "notifications") return "test";
  if (kind === "screen") return "list";
  // A restricted device is managed (parental controls, a profile): nothing here can change it.
  if (status === "restricted") return "none";
  return status === "not-determined" ? "ask" : "switch-on";
}

/**
 * Opens a permission's System Settings pane. For Screen Recording it first asks for the screens,
 * which is what lists the app there; with access denied that call fails, and the pane opens anyway.
 */
export async function openPane(
  kind: PermissionKind,
  deps: { listScreens: () => Promise<unknown>; open: (url: string) => Promise<void> },
): Promise<void> {
  if (kind === "screen") {
    try {
      await deps.listScreens();
    } catch {
      // Denied (or no screens to list): the pane is where that gets fixed.
    }
  }
  await deps.open(SETTINGS_PANE[kind]);
}

/** The steps the setup shows on this platform: the permissions step is for macOS only. */
export function setupSteps(platform: string, devices: boolean): ("welcome" | "devices" | "permissions" | "pair" | "done")[] {
  return [
    "welcome",
    ...(devices ? (["devices"] as const) : []),
    ...(platform === "darwin" ? (["permissions"] as const) : []),
    "pair",
    "done",
  ];
}
