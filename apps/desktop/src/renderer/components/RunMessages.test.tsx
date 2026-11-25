// @vitest-environment happy-dom
/** A live run's messages in its panel (ADR 0026): what "Message this run" says before it opens a direct message. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { RunMessages, type LiveRunFacts } from "./RunMessages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

const ana = { memberId: "mana", name: "Ana", kind: "person" as const };
const run: LiveRunFacts = { runId: "r1", label: "Claude Code (Ana)", driver: ana, hears: "anyone", hearsYou: true, hearing: "mid_task" };

function show(facts: LiveRunFacts) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<RunMessages run={facts} me="mjulio" inbox={{ waiting: 0 }} onSetHears={() => {}} onMessage={() => {}} />));
  return host;
}

test("Message this run says first that the whole team sees a team run's output, so a direct message with it won't stay private (ADR 0039)", () => {
  const host = show({ ...run, visibleToTeam: true });
  const actions = host.querySelector(".run-message-action")!;
  expect(actions.querySelector(".output-warn")!.textContent).toBe("Claude Code (Ana)'s output is visible to the whole team, so what you send it won't stay private.");
  expect(actions.querySelector("button")!.textContent?.trim()).toBe("Message this run");

  // A run from a direct message or private channel shows its output only to that place's members: no warning.
  expect(show(run).querySelector(".run-message-action .output-warn")).toBeNull();
});
