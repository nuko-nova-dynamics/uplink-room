/**
 * The app's diagnostic log (docs/logs.md), for the main process and, over IPC, the window.
 *
 * Files: `uplink-room.log` in the app's logs folder, rotating at 5 MB with four old files kept,
 * next to `bridge.log` (the bundled bridge's output, main/bridge.ts). The installed app uses the
 * OS's logs folder (`app.getPath("logs")`: `~/Library/Logs/Uplink Room` on macOS, the `logs`
 * folder in the app's data folder on Windows and Linux). Development runs, test-channel builds and
 * runs with `--user-data-dir` keep theirs in `<their data folder>/logs`, so they never mix with
 * the installed app's.
 *
 * Each line at info and above is also a Sentry breadcrumb (category `uplink`), so an error report
 * carries the steps before it. Lines are scrubbed in logFile.ts before either.
 */
import { join } from "node:path";
import * as Sentry from "@sentry/electron/main";
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import { formatLine, LEVELS, MAX_FIELDS, RotatingFile, type Fields, type Level } from "./logFile";

let file: RotatingFile | null = null;
/** Lines from before the logs folder could be opened (none, in practice: startLogging runs first). */
const early: string[] = [];
let minimum: Level = process.env["UPLINK_LOG_LEVEL"] === "debug" ? "debug" : "info";
let home: string | undefined;
function homeDir(): string | undefined {
  try {
    return (home ??= app.getPath("home"));
  } catch {
    return undefined;
  }
}

function enabled(level: Level) {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minimum);
}

export function writeLog(level: Level, scope: string, message: string, fields?: Fields): void {
  if (!enabled(level)) return;
  let line: string;
  try {
    line = formatLine(new Date(), level, scope, message, fields, homeDir());
  } catch {
    return;
  }
  try {
    if (file) file.write(line);
    else early.push(line);
  } catch {
    // A full or read-only disk loses log lines, never the app.
  }
  if (!app.isPackaged && process.env["UPLINK_LOG_STDOUT"] !== "0") console.log(line);
  if (level !== "debug") {
    try {
      Sentry.addBreadcrumb({
        category: "uplink",
        level: level === "warn" ? "warning" : level,
        // The scrubbed line, without its time and level (the breadcrumb has its own).
        message: line.slice(line.indexOf("[")),
      });
    } catch {
      // Sentry isn't started (development, or reports turned off).
    }
  }
}

export const log = {
  debug: (scope: string, message: string, fields?: Fields) => writeLog("debug", scope, message, fields),
  info: (scope: string, message: string, fields?: Fields) => writeLog("info", scope, message, fields),
  warn: (scope: string, message: string, fields?: Fields) => writeLog("warn", scope, message, fields),
  error: (scope: string, message: string, fields?: Fields) => writeLog("error", scope, message, fields),
};

/** The folder the logs are written to, once startLogging has run. */
export function logsDir(): string {
  return app.getPath("logs");
}

/** The newest lines of the log, for "Copy diagnostics". They're already scrubbed. */
export function recentLines(count: number): string[] {
  return file?.tail(count) ?? [...early].slice(-count);
}

/**
 * Picks the logs folder and opens the log. Call after `userData` is set and before anything asks
 * for the logs path (main/bridge.ts does, when it starts the bridge).
 */
/**
 * A development run echoes its log to stdout. When whatever started it goes away (a closed terminal,
 * a script that exited), writing there fails with EPIPE, which would end the main process with an
 * error dialog. A closed stdout or stderr only stops the echo.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on?.("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

export function startLogging(options: { separateData: boolean }): void {
  if (options.separateData) app.setAppLogsPath(join(app.getPath("userData"), "logs"));
  else app.setAppLogsPath();
  const dir = app.getPath("logs");
  try {
    file = new RotatingFile(dir, "uplink-room.log");
    for (const line of early.splice(0)) file.write(line);
  } catch {
    file = null;
  }
  log.info("app", "starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });
}

/** How many lines one window may send per second before the rest are dropped (a loop shouldn't fill the disk). */
const RENDERER_LINES_PER_SECOND = 50;

/**
 * Lines from the app's window (renderer/lib/log.ts), which arrive already scrubbed and are
 * scrubbed again here. Only the app's own main frame may write.
 */
export function registerRendererLog(fromAppWindow: (event: Electron.IpcMainEvent) => boolean): void {
  let second = 0;
  let count = 0;
  let dropped = 0;
  ipcMain.on("uplink:log", (event, level: unknown, scope: unknown, message: unknown, fields: unknown) => {
    if (!fromAppWindow(event)) return;
    if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level)) return;
    if (typeof scope !== "string" || typeof message !== "string") return;
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) {
      if (dropped > 0) log.warn("log", "dropped renderer lines", { count: dropped });
      second = now;
      count = 0;
      dropped = 0;
    }
    if (++count > RENDERER_LINES_PER_SECOND) {
      dropped++;
      return;
    }
    // Only a plain object's first MAX_FIELDS fields; formatLine caps their depth and the line's size.
    let safeFields: Fields | undefined;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      safeFields = {};
      let count = 0;
      for (const key in fields as Fields) {
        if (count++ > MAX_FIELDS) break;
        safeFields[key] = (fields as Fields)[key];
      }
    }
    writeLog(level as Level, `renderer:${scope.slice(0, 40)}`, message.slice(0, 200), safeFields);
  });
}

/** The app's lifecycle and the computer's power events, and telling the window about the latter. */
export function logLifecycle(): void {
  app.on("ready", () => log.info("app", "ready"));
  app.on("before-quit", () => log.info("app", "quitting"));
  app.on("will-quit", () => log.info("app", "will quit"));
  app.on("activate", () => log.info("app", "activated"));
  app.on("render-process-gone", (_event, _contents, details) =>
    log.error("app", "window's process gone", { reason: details.reason, exitCode: details.exitCode }),
  );
  app.on("child-process-gone", (_event, details) =>
    log.warn("app", "child process gone", { type: details.type, reason: details.reason, exitCode: details.exitCode }),
  );
  void app.whenReady().then(() => {
    // The window's call catches up after these (renderer/lib/call.tsx): a beat at once, a rejoin if the room dropped it.
    for (const name of ["suspend", "resume", "lock-screen", "unlock-screen", "shutdown"] as const) {
      powerMonitor.on(name as "suspend", () => {
        log.info("power", name);
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send("uplink:power", name);
        }
      });
    }
  });
}

/** One window's own lifecycle: shown, hidden, minimized, focus, and its renderer's health. */
export function logWindow(window: BrowserWindow): void {
  const events = ["show", "hide", "minimize", "restore", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "focus", "blur", "unresponsive", "responsive"] as const;
  for (const name of events) {
    window.on(name as "show", () => log[name === "unresponsive" ? "warn" : "info"]("window", name));
  }
  window.webContents.on("did-finish-load", () => log.info("window", "loaded"));
  window.webContents.on("did-fail-load", (_event, code) => log.warn("window", "load failed", { code }));
}
