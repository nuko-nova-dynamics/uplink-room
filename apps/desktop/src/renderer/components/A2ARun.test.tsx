// @vitest-environment happy-dom
/**
 * A run its agent's gateway didn't take says why once (ADR 0018): the reason, in full, without the
 * short "The agent didn't take it." note on top of it.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import type { RunView } from "../lib/api";
import { A2ARunDetails } from "./A2ARun";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REASON =
  "Icarus doesn't answer SendMessage, the A2A 1.0 method its Agent Card promises, or message/send from A2A 0.3. It said: “method not found”. Check that the address on its Agent Card is its A2A endpoint.";

function run(state: "failed" | "working", failReason?: string): RunView {
  return {
    runId: "r1",
    harness: "a2a",
    state,
    ...(failReason ? { failReason } : {}),
    private: false,
    startedAt: 0,
    stateChangedAt: 0,
    a2a: {
      agent: { agentId: "a1", memberId: "m1", name: "Icarus" },
      connected: true,
      canCancel: "unknown",
      following: false,
      delivery: "failed",
      artifacts: [],
      lastContactAt: 0,
      messages: [],
    },
  } as unknown as RunView;
}

function rendered(view: RunView): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<A2ARunDetails run={view} now={0} />));
  return host;
}

test("a refused run shows its reason once, without the short delivery note", () => {
  const notes = [...rendered(run("failed", REASON)).querySelectorAll(".note")].map(
    (n) => n.textContent,
  );
  expect(notes).toEqual([REASON]);
});

test("without a reason to show, the delivery note still says the agent didn't take it", () => {
  const notes = [...rendered(run("working")).querySelectorAll(".note")].map((n) => n.textContent);
  expect(notes).toEqual(["The agent didn't take it."]);
});
