// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { Dialog } from "./Dialog";
import { SettingsOverlay } from "./SettingsOverlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const press = (key: string) =>
  act(() =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    ),
  );

test("Escape in a dialog inside Settings closes only that dialog; the next one closes Settings", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 28, 28)] as unknown as DOMRectList,
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const closeSettings = vi.fn();
  const closeChild = vi.fn();
  const render = async (child: boolean) => {
    act(() =>
      root.render(
        <SettingsOverlay onClose={closeSettings}>
          {child ? (
            <Dialog title="Link a machine" onClose={closeChild}>
              <input aria-label="Name" />
            </Dialog>
          ) : null}
        </SettingsOverlay>,
      ),
    );
    await act(() => settle());
  };
  // Settings opens first, then a dialog from inside it.
  await render(false);
  await render(true);
  press("Escape");
  expect(closeChild).toHaveBeenCalledTimes(1);
  expect(closeSettings).not.toHaveBeenCalled();
  await render(false);
  press("Escape");
  expect(closeSettings).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

test("Settings keeps Tab inside it and its background inert", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 28, 28)] as unknown as DOMRectList,
  );
  const behind = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(behind, host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <SettingsOverlay onClose={() => {}}>
        <button type="button">Agents</button>
      </SettingsOverlay>,
    ),
  );
  await act(() => settle());
  // The page goes inert a frame or two after the dialog opens.
  await act(() => vi.waitFor(() => expect(behind.inert).toBe(true)));
  // Tab wraps at the ends: past Agents, the last control, to Close settings, the first, and back.
  act(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Agents")!.focus());
  press("Tab");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close settings");
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement?.textContent).toBe("Agents");
  act(() => root.unmount());
  expect(behind.inert).toBe(false);
});

test("a menu still listening under Settings doesn't take its Escape", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const closeSettings = vi.fn();
  const closeMenu = vi.fn();
  // The view underneath: a menu that closes on Escape from the document, as the thread's access menu does.
  const menuKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };
  document.addEventListener("keydown", menuKey);
  act(() =>
    root.render(
      <SettingsOverlay onClose={closeSettings}>
        <button type="button">Agents</button>
      </SettingsOverlay>,
    ),
  );
  await act(() => settle());
  press("Escape");
  expect(closeSettings).toHaveBeenCalledTimes(1);
  expect(closeMenu).not.toHaveBeenCalled();
  document.removeEventListener("keydown", menuKey);
  act(() => root.unmount());
});
