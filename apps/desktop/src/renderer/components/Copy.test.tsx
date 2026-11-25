// @vitest-environment happy-dom
/**
 * The copy fix, in the renderer: CopyButton copies through the preload's Electron clipboard, never
 * the window's `navigator.clipboard` (which the app's permission handler refuses), says "Copied",
 * and says "Couldn't copy" when it fails instead of doing nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const bridge = vi.hoisted(() => ({ copyText: vi.fn<(text: string) => Promise<void>>() }));
vi.mock("../lib/desktop", () => ({ desktop: bridge }));

const { CopyButton } = await import("./Copy");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const windowClipboard = vi.fn(async () => {
  throw new DOMException("Write permission denied.", "NotAllowedError");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: windowClipboard }, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  bridge.copyText.mockReset();
  windowClipboard.mockClear();
  vi.useRealTimers();
});

const button = () => host.querySelector("button")!;
const status = () => host.querySelector('[role="status"]')!.textContent;

test("Copy the token copies through Electron's clipboard and confirms, then goes back to its label", async () => {
  bridge.copyText.mockResolvedValue(undefined);
  act(() => root.render(<CopyButton text="uri_0123456789abcdef" label="Copy the token" />));
  expect(button().getAttribute("aria-label")).toBe("Copy the token");

  await act(async () => button().click());
  expect(bridge.copyText).toHaveBeenCalledWith("uri_0123456789abcdef");
  expect(windowClipboard).not.toHaveBeenCalled();
  expect(button().getAttribute("aria-label")).toBe("Copied");
  expect(status()).toBe("Copy the token: copied");

  await act(async () => vi.advanceTimersByTime(2000));
  expect(button().getAttribute("aria-label")).toBe("Copy the token");
});

test("a copy that fails says so, and points to copying by hand", async () => {
  bridge.copyText.mockRejectedValue(new Error("Not allowed"));
  act(() => root.render(<CopyButton text="uri_0123456789abcdef" label="Copy link" />));
  await act(async () => button().click());
  expect(button().getAttribute("aria-label")).toBe("Couldn't copy");
  expect(status()).toBe("Couldn't copy. Select the text and copy it.");
});
