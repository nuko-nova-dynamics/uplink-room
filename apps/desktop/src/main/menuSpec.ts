import type { MenuItemConstructorOptions } from "electron";

/**
 * The window's traffic lights on macOS (`titleBarStyle: "hiddenInset"`). They are 14 px circles;
 * at y 19 their centers sit on the title row's center line, 26 px down its 52 px (DESIGN.md,
 * "Window chrome"), and x 16 is the same inset as the header's last control from the right edge.
 */
export const TRAFFIC_LIGHTS = { x: 16, y: 19 } as const;

/**
 * Settings… asked for while no window exists: the menu opens a window, and the request waits until
 * that window's shell is up and takes it (`uplink:take-open-settings`), so it isn't lost on the way.
 */
export class SettingsRequest {
  #pending = false;
  /** Returns true when there's no window to send it to, so the caller opens one. */
  request(hasWindow: boolean): boolean {
    if (hasWindow) return false;
    this.#pending = true;
    return true;
  }
  /** The shell is ready: true once if Settings was asked for. */
  take(): boolean {
    const pending = this.#pending;
    this.#pending = false;
    return pending;
  }
}

/**
 * The macOS menu bar (Apple HIG, "The menu bar"): the app menu with About, then Settings… on
 * Command-comma, then the system's items; Electron's own File, Edit, View and Window menus; and a
 * Help menu that points at the product instead of at Electron. Windows and Linux keep Electron's
 * default menu. Pure, so the test can read it without Electron.
 */
export function appMenuTemplate(actions: {
  openSettings: () => void;
  openWebsite: () => void;
}): MenuItemConstructorOptions[] {
  return [
    {
      // macOS titles the first menu with the app's name whatever the label says.
      label: "Uplink Room",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { id: "settings", label: "Settings…", accelerator: "CommandOrControl+,", click: actions.openSettings },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Uplink Room website", click: actions.openWebsite }] },
  ];
}
