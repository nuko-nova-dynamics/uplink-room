// @vitest-environment happy-dom
/**
 * The task menu (the composer's "Mention a task or run", a roster agent's "Give it a task"): it
 * opens where it's rendered with the keys on its first task once the tasks arrive, picks with
 * Enter, and closes on Escape.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { settle } from "@ui-sdk/core/testing";
import { afterEach, expect, test, vi } from "vitest";

const board = vi.hoisted(() => ({ tasks: undefined as unknown[] | undefined }));
vi.mock("../lib/session", () => ({ useRoomQuery: () => board.tasks }));

const { TaskPicker } = await import("./TaskPicker");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  board.tasks = undefined;
});

const tasks = [
  { taskId: "t1", title: "Fix the Safari checkout", runs: [{ runId: "r1", harness: "codex" }] },
  { taskId: "t2", title: "Compress hero images", runs: [] },
];

async function press(key: string) {
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await act(() => settle());
}

function mount() {
  const onClose = vi.fn();
  const onPick = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = () =>
    act(() =>
      root.render(
        <div className="composer-tool">
          <TaskPicker
            focus
            title="Mention a task or run"
            empty="No tasks yet."
            onClose={onClose}
            onPick={onPick}
          />
        </div>,
      ),
    );
  render();
  return { render, onClose, onPick };
}

test("it opens while the tasks load, puts the keys on the first task once they arrive, and Enter picks", async () => {
  const { render, onPick } = mount();
  await act(() => settle());
  const menu = document.querySelector('[role="menu"][aria-label="Mention a task or run"]');
  expect(menu?.textContent).toContain("Loading tasks");
  board.tasks = tasks;
  render();
  await act(() => settle());
  expect(document.activeElement?.textContent).toContain("Fix the Safari checkout");
  await press("ArrowDown");
  expect(document.activeElement?.textContent).toContain("run");
  await press("Enter");
  expect(onPick).toHaveBeenCalledWith(
    { kind: "run", id: "r1", label: "Codex run" },
    expect.objectContaining({ taskId: "t1" }),
  );
});

test("Escape closes it through onClose", async () => {
  board.tasks = tasks;
  const { onClose } = mount();
  await act(() => settle());
  await press("Escape");
  expect(onClose).toHaveBeenCalled();
});
