// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { Dialog } from "./Dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("a modal keeps Tab inside, keeps its background inert and restores its opener", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 28, 28)] as unknown as DOMRectList,
  );
  const opener = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(opener, host);
  opener.focus();
  const root = createRoot(host);
  act(() =>
    root.render(
      <Dialog title="Pick a repo" onClose={() => {}} footer={<button type="button">Save</button>}>
        <input
          aria-label="Repo"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.preventDefault();
          }}
        />
        <button type="button">Remove repo</button>
      </Dialog>,
    ),
  );
  await act(() => settle());
  // The page goes inert a frame or two after the dialog opens.
  await act(() => vi.waitFor(() => expect(opener.inert).toBe(true)));
  const input = document.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  const tab = (shiftKey: boolean) =>
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
      ),
    );
  // Tab wraps at the ends: past Save, the last control, to Close, the first, and back.
  const save = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
  act(() => save.focus());
  tab(false);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
  tab(true);
  expect(document.activeElement?.textContent).toBe("Save");
  act(() => root.unmount());
  expect(opener.inert).toBe(false);
  expect(document.activeElement).toBe(opener);
});

test("Escape handled by a nested picker does not close its dialog", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 28, 28)] as unknown as DOMRectList,
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  act(() =>
    root.render(
      <Dialog title="Pick a repo" onClose={close}>
        <input
          aria-label="Repo"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.preventDefault();
          }}
        />
      </Dialog>,
    ),
  );
  await act(() => settle());
  act(() =>
    document
      .querySelector("input")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
  );
  expect(close).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test("a dialog opened from a removed menu item returns to its surviving trigger", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 28, 28)] as unknown as DOMRectList,
  );
  const menuItem = document.createElement("button");
  const trigger = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(trigger, menuItem, host);
  menuItem.focus();
  const root = createRoot(host);
  act(() =>
    root.render(
      <Dialog title="Delete message" onClose={() => {}} returnFocus={{ current: trigger }}>
        Confirm
      </Dialog>,
    ),
  );
  await act(() => settle());
  menuItem.remove();
  act(() => root.unmount());
  expect(document.activeElement).toBe(trigger);
});
