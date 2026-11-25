// @vitest-environment happy-dom
/**
 * Under a message: what happened with a hosted agent the room reaches but can't follow (slice 14 of
 * #139). A webhook send says sent or why it failed, in amber; an agent that checks in says it sees
 * the message when it next checks, then Seen.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { Deliveries, type Delivery } from "./Deliveries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const grok = { memberId: "mgrok0000001", name: "Grok Bot", kind: "agent" } as Delivery["to"];
const duet = { memberId: "mduet0000001", name: "Claude Duet", kind: "agent" } as Delivery["to"];

function rendered(deliveries: Delivery[]): HTMLElement {
  const host = document.createElement("div");
  act(() => createRoot(host).render(<Deliveries deliveries={deliveries} />));
  return host;
}

test("a sent webhook and an agent that checks in each get one line", () => {
  const host = rendered([
    { to: grok, via: "webhook", status: "sent", at: 0 },
    { to: duet, via: "check_in", status: "waiting", at: 0 },
  ]);
  const lines = [...host.querySelectorAll(".delivery")].map((l) => l.textContent);
  expect(lines).toEqual([
    "Sent to Grok Bot. It answers here when its run is done.",
    "Claude Duet checks in on its own schedule and sees this when it next checks.",
  ]);
  expect(host.querySelector(".amber-text")).toBeNull();
});

test("a failed send gives the reason, in amber because someone has to fix it", () => {
  const host = rendered([
    { to: grok, via: "webhook", status: "failed", reason: "The webhook answered HTTP 401.", at: 0 },
  ]);
  const line = host.querySelector(".delivery")!;
  expect(line.textContent).toBe("Sending to Grok Bot failed. The webhook answered HTTP 401.");
  expect(line.classList.contains("amber-text")).toBe(true);
});

test("once it read the place, it says Seen", () => {
  expect(rendered([{ to: duet, via: "check_in", status: "seen", at: 0 }]).textContent).toBe("Seen by Claude Duet");
});

test("a message no hosted agent got shows nothing", () => {
  expect(rendered([]).innerHTML).toBe("");
});
