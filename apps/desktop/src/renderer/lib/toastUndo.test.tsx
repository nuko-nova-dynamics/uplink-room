// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { ToastProvider, useToast } from "./session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

test("an Undo toast closes at Undo's deadline even while the pointer rests on it", async () => {
  let show!: ReturnType<typeof useToast>["show"];
  function Grab() {
    show = useToast().show;
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    ),
  );
  vi.useFakeTimers();
  act(() => show("Settled", true, { label: "Undo", onClick: () => {}, ms: 6000 }));
  await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
  const toast = document.querySelector<HTMLElement>('[data-slot="toast"]')!;
  expect(toast.textContent).toContain("Undo");
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"])
    act(() => toast.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" })));
  await act(async () => void (await vi.advanceTimersByTimeAsync(6500)));
  vi.useRealTimers();
  await act(() => settle());
  expect(document.querySelector('[data-slot="toast"]:not([data-ending-style])')).toBeNull();
  act(() => root.unmount());
});
