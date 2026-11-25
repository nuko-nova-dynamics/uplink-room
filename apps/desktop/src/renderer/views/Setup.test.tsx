// @vitest-environment happy-dom
/** Setup's link step against this computer's pairing as it stands when setup opens. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { Setup, type PairApi } from "./Setup";
import type { PermissionsApi } from "../lib/permissions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const permissions: PermissionsApi = {
  read: async () => null,
  ask: async () => null,
  open: async () => {},
  drag: () => {},
  testNotification: async () => {},
};

function open(pair: PairApi) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Setup me="Rosa Vega" team="Harbor Labs" permissions={permissions} pair={pair} initialStep="pair" onDone={() => {}} />));
  // Setup is a UI SDK dialog, portaled to the body, so its content is found from there.
  return { host: document.body, close: () => act(() => root.unmount()) };
}

test("setup reads the pairing each time it opens, and a linked computer gets no link form", async () => {
  const refresh = vi.fn();
  const pair = vi.fn(async () => {});
  const first = open({ available: true, current: { status: "paired", name: "Rosa's Mac" }, pair, refresh });
  await act(async () => {});
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(first.host.textContent).toContain("This computer is linked as Rosa's Mac");
  expect(first.host.querySelector("#setup-pair-form")).toBeNull();
  first.close();
  roots.pop();

  open({ available: true, current: { status: "paired", name: "Rosa's Mac" }, pair, refresh });
  await act(async () => {});
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(pair).not.toHaveBeenCalled();
});

test("only the replace confirmation sends replace: true", async () => {
  const pair = vi.fn(async () => {});
  const { host } = open({ available: true, current: { status: "paired", name: "Rosa's Mac" }, pair });
  await act(async () => {});
  const click = (label: string) =>
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!.click());
  click("Replace this pairing");
  click("Replace pairing");
  const form = host.querySelector<HTMLFormElement>("#setup-pair-form")!;
  await act(async () => form.requestSubmit());
  expect(pair).toHaveBeenCalledWith(expect.any(String), { replace: true });
});

test("a computer with no pairing links without replace", async () => {
  const pair = vi.fn(async () => {});
  const { host } = open({ available: true, current: { status: "unpaired" }, pair });
  await act(async () => {});
  await act(async () => host.querySelector<HTMLFormElement>("#setup-pair-form")!.requestSubmit());
  expect(pair).toHaveBeenCalledWith(expect.any(String), { replace: false });
});

test("a pairing that couldn't be read offers Retry and no way to link", async () => {
  const refresh = vi.fn();
  const pair = vi.fn(async () => {});
  const { host } = open({ available: true, current: { status: "unknown", error: "EACCES: permission denied" }, pair, refresh });
  await act(async () => {});
  expect(host.textContent).toContain("Couldn't check this computer's link");
  expect(host.querySelector("#setup-pair-form")).toBeNull();
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(labels.some((l) => l.includes("Link this computer"))).toBe(false);
  expect(labels.some((l) => l.includes("Continue"))).toBe(false);
  act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click());
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("Continue past an existing pairing reports it as linked in the summary", async () => {
  const { host } = open({ available: true, current: { status: "paired", name: "Rosa's Mac" }, pair: vi.fn(async () => {}) });
  await act(async () => {});
  act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Continue")!.click());
  expect(host.textContent).toContain("This computer is linked as Rosa's Mac.");
  expect(host.textContent).not.toContain("This computer isn't linked");
});

test("Shift+Tab right after setup opens wraps to the dialog's last control instead of leaving it", async () => {
  // happy-dom lays nothing out; UI SDK's focus trap skips controls without boxes.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 28, 28)] as unknown as DOMRectList,
  );
  const { host } = open({ available: true, current: { status: "unpaired" }, pair: vi.fn(async () => {}) });
  await act(async () => {});
  await act(() => settle());
  // Focus starts on the dialog itself (UI SDK's content, the full-window overlay around the box).
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector(".setup")).not.toBeNull();
  expect(document.activeElement).toBe(dialog);
  act(() => {
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  });
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("the requested step stays on screen when the macOS permissions arrive after setup opens", async () => {
  // The platform starts as "other" (no Permissions step) and turns out to be macOS once the
  // permissions read answers, which adds a step before Link. The Link step must stay the one shown.
  Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
  let answer: (state: unknown) => void = () => {};
  const late: PermissionsApi = {
    ...permissions,
    read: () => new Promise((resolve) => (answer = resolve as (state: unknown) => void)) as never,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const pair = { available: true, current: { status: "unpaired" as const }, pair: vi.fn(async () => {}) };
  act(() => root.render(<Setup me="Rosa Vega" team="Harbor Labs" permissions={late} pair={pair} initialStep="pair" onDone={() => {}} />));
  await act(async () => {});
  expect(document.querySelector("#setup-pair-form")).not.toBeNull();
  const statuses = { microphone: "granted", camera: "granted", screen: "granted", notifications: "granted" };
  await act(async () => answer({ platform: "darwin", packaged: true, appName: "Uplink Room", statuses }));
  expect(document.querySelector("#setup-pair-form")).not.toBeNull();
});
