/**
 * "Open at login" (Settings, Updates; loginItem.ts does the work). Kept free of Electron so the
 * tests can cover every decision.
 *
 *  - Installed builds on the latest channel turn it on by themselves once, at their first launch
 *    with this setting, so a computer is in the room (and its bridge running) after a restart.
 *    Whatever the person chooses after that stays: the app never turns it on again by itself.
 *  - Test-channel and development builds never turn it on by themselves.
 *  - macOS and Windows keep it as the system's login item (Electron's setLoginItemSettings).
 *    Linux keeps it as an XDG autostart entry, `~/.config/autostart/uplink-room.desktop`, which
 *    the app writes again at each launch while it's on, so it follows an AppImage that an update
 *    renamed (#128).
 *  - A login launch opens the window, as any launch does.
 */

import type { UpdateChannel } from "./updateSpec";

/** What Settings shows. */
export type LoginItemState = {
  /** False in development builds and on systems the app can't add itself to. */
  supported: boolean;
  on: boolean;
  /** macOS: it's on, but System Settings, General, Login Items has to allow it first. */
  needsApproval: boolean;
};

/** Whether this launch turns "Open at login" on by itself. */
export function defaultsOn(input: {
  isPackaged: boolean;
  channel: UpdateChannel | null;
  /** Whether an earlier launch already did (or skipped) this. */
  defaulted: boolean;
}): boolean {
  return input.isPackaged && input.channel === "latest" && !input.defaulted;
}

/** The autostart entry's file name under `$XDG_CONFIG_HOME/autostart`. */
export const AUTOSTART_FILE = "uplink-room.desktop";

/**
 * One argument of a desktop entry's `Exec` key (Desktop Entry Specification 1.5, "The Exec key"):
 * plain when it holds only safe characters, otherwise in double quotes with `"`, `` ` ``, `$` and
 * `\` escaped. The string-value escape (`\` as `\\`) applies on top of that, and `%` is doubled,
 * since a lone `%` starts a field code. Null for a value no entry can hold (a line break).
 */
export function execArgument(value: string): string | null {
  if (value === "" || /[\n\r]/.test(value)) return null;
  if (/^[A-Za-z0-9_/.+,:=@-]+$/.test(value)) return value;
  const quoted = `"${value.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** The autostart entry that opens `executable` at login, or null when its path can't be written into one. */
export function autostartEntry(executable: string): string | null {
  const exec = execArgument(executable);
  if (!exec) return null;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Uplink Room",
    "Comment=Opens Uplink Room when you log in",
    `Exec=${exec}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Whether an autostart entry's text, as found on disk, still opens the app (a desktop may have turned it off in place). */
export function autostartOn(text: string | null): boolean {
  if (text === null) return false;
  return !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text);
}
