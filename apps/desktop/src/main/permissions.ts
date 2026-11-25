import { join } from "node:path";
import { app, desktopCapturer, ipcMain, nativeImage, Notification, shell, systemPreferences } from "electron";
import { quiet } from "./notifications";
import { isPermissionKind, openPane, type PermissionsState, type PermissionStatus } from "./permissionsSpec";

/**
 * Onboarding's permissions step (research/onboarding-permissions.md): reads each permission's state,
 * shows macOS's prompt where it has one, opens the exact System Settings pane, and starts a drag of
 * the app itself, which System Settings' Screen Recording list accepts as a drop. Every call reads
 * or asks; none changes a setting.
 */

/** The running app's bundle (…/Uplink Room.app), from its executable's path. */
function bundlePath(): string {
  return join(app.getPath("exe"), "..", "..", "..");
}

function mediaStatus(kind: "microphone" | "camera" | "screen"): PermissionStatus {
  if (process.platform !== "darwin" && process.platform !== "win32") return "granted";
  const status = systemPreferences.getMediaAccessStatus(kind);
  return status === "granted" || status === "denied" || status === "not-determined" || status === "restricted"
    ? status
    : "unknown";
}

export function permissionsState(): PermissionsState {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    appName: app.getName(),
    statuses: {
      microphone: mediaStatus("microphone"),
      camera: mediaStatus("camera"),
      screen: mediaStatus("screen"),
      // Electron has no call that reads it (Notification has isSupported() only).
      notifications: Notification.isSupported() ? "unknown" : "denied",
    },
  };
}

export function registerPermissions(fromAppWindow: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle("uplink:permissions", (event) => (fromAppWindow(event) ? permissionsState() : null));

  // macOS's prompt for the microphone or camera. Shown once: after that it answers with the saved choice.
  ipcMain.handle("uplink:permission-ask", async (event, kind: unknown) => {
    if (!fromAppWindow(event) || (kind !== "microphone" && kind !== "camera")) return null;
    if (process.platform === "darwin") await systemPreferences.askForMediaAccess(kind);
    return permissionsState();
  });

  // The pane for one permission. Asking for the screens first is what lists the app under Screen Recording.
  ipcMain.handle("uplink:permission-open", async (event, kind: unknown) => {
    if (!fromAppWindow(event) || !isPermissionKind(kind) || process.platform !== "darwin") return;
    await openPane(kind, {
      listScreens: () => desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }),
      open: (url) => shell.openExternal(url),
    });
  });

  // The drag tile: the drop is the app's bundle, as if dragged from Finder. Installed builds only.
  ipcMain.on("uplink:permission-drag", (event) => {
    if (process.platform !== "darwin" || !app.isPackaged) return;
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || event.sender.getType() !== "window") return;
    void app.getFileIcon(bundlePath(), { size: "normal" }).then(
      (icon) => event.sender.startDrag({ file: bundlePath(), icon }),
      () => event.sender.startDrag({ file: bundlePath(), icon: nativeImage.createEmpty() }),
    );
  });

  // A test banner: the first one from the signed app is what makes macOS ask about notifications.
  ipcMain.handle("uplink:notify-test", (event) => {
    if (!fromAppWindow(event) || quiet || !Notification.isSupported()) return;
    new Notification({ title: "Uplink Room", body: "Banners work. You'll see one when something needs you." }).show();
  });
}
