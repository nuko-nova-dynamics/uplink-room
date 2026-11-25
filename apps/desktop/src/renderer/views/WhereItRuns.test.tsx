// @vitest-environment happy-dom
/** Start a run's "Where it runs" offers a T3 Code thread only for a harness T3 Code can run. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { WhereItRuns } from "./TaskPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(harness: string, via: "terminal" | "thread") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<WhereItRuns harness={harness} via={via} onVia={() => {}} />));
  const [terminal, thread] = [...host.querySelectorAll("button")];
  const shown = {
    terminal: terminal!.getAttribute("aria-checked"),
    threadOff: thread!.disabled,
    why: host.querySelector(".hint")?.textContent,
  };
  act(() => root.unmount());
  return shown;
}

test("a harness T3 Code can't run shows the terminal picked, the thread off, and why", () => {
  // Thread was picked, then Shell: the two controls can't disagree.
  expect(render("shell", "thread")).toEqual({
    terminal: "true",
    threadOff: true,
    why: "T3 Code runs agents, not a plain shell, so a shell runs in a shared terminal.",
  });
  expect(render("hermes-agent", "terminal")).toMatchObject({
    threadOff: true,
    why: expect.stringContaining("no Hermes Agent provider"),
  });
  expect(render("claude-code", "thread")).toEqual({
    terminal: "false",
    threadOff: false,
    why: undefined,
  });
});
