// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { PickOne, PickOneItem } from "./PickOne";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

test("arrow keys move between the choices without choosing; a press chooses once", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPick = vi.fn();
  act(() =>
    root.render(
      <PickOne value="watch" onPick={onPick} aria-label="Teammates can">
        <PickOneItem value="watch">View</PickOneItem>
        <PickOneItem value="suggest">Suggest</PickOneItem>
        <PickOneItem value="drive">Take control</PickOneItem>
      </PickOne>,
    ),
  );
  await act(() => settle());
  const [view, suggest, drive] = [...host.querySelectorAll("button")];
  act(() => view!.focus());
  for (const _ of [1, 2])
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      ),
    );
  expect(document.activeElement).toBe(drive);
  expect(onPick).not.toHaveBeenCalled();
  act(() => suggest!.click());
  expect(onPick).toHaveBeenCalledExactlyOnceWith("suggest");
  // Pressing the chosen one changes nothing.
  act(() => view!.click());
  expect(onPick).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
