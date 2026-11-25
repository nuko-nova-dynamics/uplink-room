import { expect, test } from "vitest";
import { COPY_CHANNEL, MAX_COPY_LENGTH, registerClipboard } from "./clipboard";

/** The main side of the copy fix: Electron's clipboard writes for the app's own window, and only for it. */
function setup() {
  const handlers = new Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const written: string[] = [];
  const appEvent = { app: true } as unknown as Electron.IpcMainInvokeEvent;
  const frameEvent = { app: false } as unknown as Electron.IpcMainInvokeEvent;
  registerClipboard(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { writeText: (text) => written.push(text) },
    (event) => (event as unknown as { app: boolean }).app,
  );
  const copy = (event: Electron.IpcMainInvokeEvent, text: unknown) => handlers.get(COPY_CHANNEL)!(event, text);
  return { copy, written, appEvent, frameEvent };
}

test("the app's window copies text through Electron's clipboard", () => {
  const { copy, written, appEvent } = setup();
  copy(appEvent, "https://uplinkroom.com/invite#uri_0123456789abcdef");
  expect(written).toEqual(["https://uplinkroom.com/invite#uri_0123456789abcdef"]);
});

test("other frames, and anything but text of a sane size, can't write to the clipboard", () => {
  const { copy, written, appEvent, frameEvent } = setup();
  expect(() => copy(frameEvent, "from a posted page")).toThrow(/Not allowed/);
  expect(() => copy(appEvent, { not: "text" })).toThrow(/Only text/);
  expect(() => copy(appEvent, "")).toThrow(/Only text/);
  expect(() => copy(appEvent, "x".repeat(MAX_COPY_LENGTH + 1))).toThrow(/Only text/);
  expect(written).toEqual([]);
});
