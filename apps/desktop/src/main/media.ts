/**
 * Microphone, camera and screen share for calls (spec #5).
 *
 * - Only the app's own main frame gets the microphone and camera. Posted HTML
 *   pages (another origin, in a sandboxed frame) never do.
 * - Screen share goes through the app's own picker: the renderer lists the
 *   sources, the person picks one, and the next getDisplayMedia() gets exactly
 *   that one, with its sound as system-audio loopback when asked. On macOS
 *   14.2+ the sound needs NSAudioCaptureUsageDescription (electron-builder.yml).
 * - With UPLINK_FAKE_MEDIA=1 (tests and screenshot scripts) the renderer makes
 *   synthetic tracks and no source is ever listed, so nothing asks the OS for
 *   a device or the screen.
 */
import { desktopCapturer, ipcMain, screen, session, type WebContents } from "electron";

export const fakeMedia = process.env["UPLINK_FAKE_MEDIA"] === "1";

type Chosen = { id: string; name: string; audio: boolean; at: number };
let chosen: Chosen | null = null;

export type ScreenSource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string | null;
  /**
   * The refresh rate in Hz of the display a screen is, or for a window the fastest display it could
   * be on; null when unknown. The picker uses it for Windows' capture limit above 60 Hz (issue #87).
   */
  refreshRate: number | null;
};

const FAKE_SOURCES: ScreenSource[] = [
  { id: "screen:fake:0", name: "Entire screen", kind: "screen", thumbnail: null, refreshRate: null },
  { id: "window:fake:1", name: "Reef Runner (Godot)", kind: "window", thumbnail: null, refreshRate: null },
  { id: "window:fake:2", name: "Terminal: pnpm test --watch", kind: "window", thumbnail: null, refreshRate: null },
];

export function registerMedia(
  /** True for the app window's own main frame at this URL. */
  isAppFrame: (contents: WebContents, url: string, isMainFrame: boolean) => boolean,
  fromAppWindow: (event: Electron.IpcMainInvokeEvent) => boolean,
): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const appFrame = isAppFrame(contents, details.requestingUrl ?? "", details.isMainFrame);
    if (permission === "media" && appFrame) {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return callback(types.every((t) => t === "audio" || t === "video"));
    }
    if (permission === "display-capture" && appFrame) return callback(true);
    // Nothing else (location, notifications, other origins) is granted.
    callback(false);
  });
  // Media checks (such as listing devices with their labels) pass only for the app's own frame.
  // Other checks keep Electron's default (granted), so frames such as Space views work as before.
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== "media" && permission !== "display-capture") return true;
    return contents ? isAppFrame(contents, details.requestingUrl || origin, details.isMainFrame) : false;
  });

  ses.setDisplayMediaRequestHandler((request, callback) => {
    const pick = chosen;
    chosen = null;
    if (!pick || Date.now() - pick.at > 30_000 || !request.frame || request.frame.parent) {
      // No source picked in the app's own picker: refuse, so getDisplayMedia() rejects.
      return callback(null as unknown as Electron.Streams);
    }
    callback({
      video: { id: pick.id, name: pick.name },
      ...(pick.audio && request.audioRequested ? { audio: "loopback" as const } : {}),
    });
  });

  ipcMain.handle("uplink:screen-sources", async (event): Promise<ScreenSource[]> => {
    if (!fromAppWindow(event)) return [];
    if (fakeMedia) return FAKE_SOURCES;
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 200 },
    });
    const displays = screen.getAllDisplays();
    const rate = (hz: number | undefined) => (hz && hz > 0 ? Math.round(hz) : null);
    const fastest = rate(Math.max(0, ...displays.map((d) => d.displayFrequency)));
    return sources.map((s) => {
      const kind = s.id.startsWith("screen:") ? "screen" : "window";
      return {
        id: s.id,
        name: s.name,
        kind,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        refreshRate:
          kind === "screen" ? rate(displays.find((d) => String(d.id) === s.display_id)?.displayFrequency) : fastest,
      };
    });
  });

  ipcMain.handle("uplink:choose-screen-source", (event, id: unknown, name: unknown, audio: unknown) => {
    if (!fromAppWindow(event) || typeof id !== "string" || typeof name !== "string") throw new Error("Not allowed");
    chosen = { id, name, audio: audio === true, at: Date.now() };
  });
}
