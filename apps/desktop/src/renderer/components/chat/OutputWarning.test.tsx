// @vitest-environment happy-dom
/** A direct message opened with a team run says in its header whose output the run is (ADR 0039, amended 2026-11-05). */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { OutputHeadNote } from "./OutputWarning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function show(runs: { warning?: string; seenBy?: "team" | "outside" }[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<OutputHeadNote runs={runs} />));
  return host;
}

test("the header says in a few words that the team sees the run's output, and names the whole warning", () => {
  const warning = "Claude Code (Ana)'s output is visible to the whole team, so what you send here won't stay private.";
  const note = show([{ warning, seenBy: "team" }]).querySelector(".head-output")!;
  expect(note.textContent).toBe("Output visible to the whole team");
  expect(note.getAttribute("title")).toBe(warning);
  expect(note.getAttribute("aria-label")).toBe(warning);
  // A run whose output stays in the direct message has no warning, and the header says nothing.
  expect(show([{}]).querySelector(".head-output")).toBeNull();
});

test("a run from another private place says that people outside the direct message see it", () => {
  const warning = "Codex (Ben)'s output is visible to people outside this direct message, so what you send here won't stay private.";
  const note = show([{ warning, seenBy: "outside" }]).querySelector(".head-output")!;
  expect(note.textContent).toBe("Output visible outside this direct message");
});
