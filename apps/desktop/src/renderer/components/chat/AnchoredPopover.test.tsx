// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { AnchoredPopover } from "./NewDirectMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

/** A mouse press as a person makes one: down, up, then click. */
function press(el: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"])
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
    );
  (el as HTMLElement).click();
}

test("a press on the button that opened it is left to that button; a press elsewhere closes it", async () => {
  const opener = document.createElement("button");
  const elsewhere = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(opener, elsewhere, host);
  opener.focus();
  const onClose = vi.fn();
  const root = createRoot(host);
  const rect = opener.getBoundingClientRect();
  act(() =>
    root.render(
      <AnchoredPopover anchor={rect} onClose={onClose} className="pop" aria-label="New channel">
        <input aria-label="Name" />
      </AnchoredPopover>,
    ),
  );
  await act(() => settle());
  act(() => press(opener));
  await act(() => settle());
  expect(onClose).not.toHaveBeenCalled();
  act(() => press(elsewhere));
  await act(() => settle());
  expect(onClose).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
