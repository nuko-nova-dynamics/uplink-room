/**
 * Copying text for the app's copy buttons (renderer/lib/clipboard.ts).
 *
 * The renderer can't use `navigator.clipboard.writeText`: in a sandboxed window, Chromium asks the
 * session's permission request handler for `clipboard-sanitized-write` before it writes, and
 * media.ts grants that handler nothing but a call's media and screen. So every copy button failed
 * with "Write permission denied". Electron's clipboard here, in the main process, needs no
 * permission. Only the app's own window may write, and only text of a sane size.
 */
export const COPY_CHANNEL = "uplink:copy-text";
/** Longer than any link, token or command the app copies. */
export const MAX_COPY_LENGTH = 64 * 1024;

type Ipc = {
  handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
};
type Clipboard = { writeText(text: string): void };

export function registerClipboard(
  ipc: Ipc,
  clipboard: Clipboard,
  fromAppWindow: (event: Electron.IpcMainInvokeEvent) => boolean,
): void {
  ipc.handle(COPY_CHANNEL, (event, text) => {
    if (!fromAppWindow(event)) throw new Error("Not allowed");
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_COPY_LENGTH) {
      throw new Error("Only text up to 64 KB can be copied.");
    }
    clipboard.writeText(text);
  });
}
