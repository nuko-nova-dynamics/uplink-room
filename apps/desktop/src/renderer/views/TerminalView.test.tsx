// @vitest-environment happy-dom
/**
 * A Rex tab keeps the size Rex gives it (ADR 0019), which can be larger than the pane: its screen
 * draws at that size inside a box that scrolls, so every column and row can be reached. A terminal
 * that follows the room's size still fits the pane, unscrolled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { XtermPane } from "./TerminalView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The same functions on every render, as Convex's hooks give them.
const convex = vi.hoisted(() => ({
  mutate: async () => null,
  output: { chunks: [], outputSeq: 0 },
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<typeof import("convex/react")>()),
  useMutation: () => convex.mutate,
  useQuery: () => convex.output,
}));

// The stylesheet rules for the screen's box, as the app ships them: happy-dom applies them, though it lays nothing out.
beforeAll(() => {
  const rules = [join(import.meta.dirname, "../styles.css"), join(import.meta.dirname, "work.css")]
    .map((file) => readFileSync(file, "utf8"))
    .flatMap((css) => css.match(/[^{}]*(?:xterm-frame|fixed-size)[^{}]*\{[^{}]*\}/g) ?? []);
  expect(rules.length).toBeGreaterThan(0);
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.append(style);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function render(fixedSize?: { cols: number; rows: number }) {
  const main = document.createElement("div");
  main.className = "terminal-main";
  document.body.append(main);
  const root = createRoot(main);
  roots.push(root);
  act(() =>
    root.render(
      <XtermPane
        terminalId={"t_rex" as never}
        teamId={"team" as never}
        keyboardOn
        responderScreenId={undefined}
        driverName="Rosa"
        live
        offline={false}
        fixedSize={fixedSize}
      />,
    ),
  );
  const host = main.querySelector<HTMLElement>(".xterm-host")!;
  // xterm opens once the screen's font has loaded (or the wait for it ends).
  await vi.waitFor(() => expect(host.querySelector(".xterm-rows")).not.toBeNull(), {
    timeout: 3000,
  });
  return { host, frame: host.querySelector<HTMLElement>(".xterm-frame")! };
}

test("a Rex tab wider and taller than the pane draws at Rex's size in a box that scrolls both ways", async () => {
  const { host, frame } = await render({ cols: 240, rows: 60 });
  expect(host.classList).toContain("fixed-size");
  // xterm is in the box that scrolls, at Rex's 60 rows, not a fitted size.
  expect(host.querySelector(".xterm")!.parentElement).toBe(frame);
  expect(host.querySelectorAll(".xterm-rows > div")).toHaveLength(60);
  expect(getComputedStyle(frame).overflow).toBe("auto");
  // The screen is as large as its rows and columns, so the box can scroll to its last column and row.
  const screen = getComputedStyle(host.querySelector(".xterm")!);
  expect([screen.width, screen.height]).toEqual(["max-content", "max-content"]);
  // The box stops above the keyboard strip, so no row scrolls under the badge.
  expect(getComputedStyle(frame).bottom).toBe("36px");
  expect(host.querySelector(".kb-badge")!.parentElement).toBe(host);
});

test("a terminal that follows the room's size fits the pane, with nothing to scroll", async () => {
  const { host, frame } = await render();
  expect(host.classList).not.toContain("fixed-size");
  expect(getComputedStyle(frame).overflow).toBe("hidden");
  // Its box fills the pane, as the screen's host did before: the fit measures the same space.
  expect(getComputedStyle(frame).bottom).not.toBe("36px");
});

test("modified Tab leaves terminal input in either direction without sending a shell key", async () => {
  const { host } = await render();
  const layout = document.createElement("div");
  layout.className = "terminal-layout";
  const before = document.createElement("button");
  const after = document.createElement("button");
  document.body.append(layout);
  layout.append(before, host.parentElement!, after);
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  for (const element of [before, input, after]) {
    vi.spyOn(element, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 24, 24),
    ] as unknown as DOMRectList);
  }
  input.focus();
  const next = new KeyboardEvent("keydown", {
    key: "Tab",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(next);
  expect(next.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(after);
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, bubbles: true }),
  );
  expect(document.activeElement).toBe(before);
  expect(input.getAttribute("aria-description")).toContain("Tab completes a command");
});
