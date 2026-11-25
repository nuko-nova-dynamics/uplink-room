// @vitest-environment happy-dom
/**
 * Settings, Machines on this computer: its T3 Code threads, private until shared (ADR 0045). Only
 * this computer's own machine shows them; search narrows the list; Save sends exactly what's picked;
 * a refused save says why and keeps the picks; empty and unavailable states say what to do.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { T3ShareRequest, T3ThreadsView } from "../../../main/t3ThreadsSpec";

const mocks = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../../lib/session", () => ({ useToast: () => ({ show: (text: string) => mocks.toasts.push(text) }) }));

const { MachineT3Threads } = await import("./MachineT3Threads");
const { T3ThreadsContext } = await import("../../lib/t3Threads");
type Api = import("../../lib/t3Threads").T3ThreadsApi;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIST: T3ThreadsView = {
  state: "ready",
  machineId: "m-here",
  revision: 4,
  environmentId: "env-1",
  threads: [
    { id: "t-fix", title: "Fix invoice rounding", project: "Billing", projectRoot: "/work/billing", state: "working", shared: true, fromRoom: false },
    { id: "t-roadmap", title: "Draft the Q4 roadmap", project: "Planning", state: "done", shared: false, fromRoom: false },
    { id: "t-tax", title: "Tax export for Ana", project: "Billing", state: "waiting", shared: false, fromRoom: false },
    { id: "uplink-room-run-1", title: "Totals per station", project: "Billing", state: "working", shared: true, fromRoom: true },
  ],
  missing: [{ id: "t-old", title: "Old migration", project: "Billing" }],
};

let root: Root;
let host: HTMLDivElement;
let shares: T3ShareRequest[];
beforeEach(() => {
  mocks.toasts.length = 0;
  shares = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function fake(view: T3ThreadsView | (() => T3ThreadsView), share?: (request: T3ShareRequest) => Promise<T3ThreadsView>, paired: string | null = "m-here"): Api {
  return {
    read: async () => (typeof view === "function" ? view() : view),
    share: async (request) => {
      shares.push(request);
      return share ? share(request) : (typeof view === "function" ? view() : view);
    },
    pairedMachine: async () => paired,
  };
}
async function show(api: Api, machineId = "m-here") {
  await act(async () => root.render(<T3ThreadsContext.Provider value={api}><MachineT3Threads machineId={machineId} /></T3ThreadsContext.Provider>));
  await act(async () => {});
}
const rows = () => [...host.querySelectorAll(".t3-thread")].map((row) => row.querySelector(".t3-thread-title")?.textContent);
const box = (title: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.t3-thread [role="checkbox"]')].find((input) => input.closest(".t3-thread")?.textContent?.includes(title))!;
/** A UI SDK Checkbox is a button: checked is its aria-checked. */
const boxState = (title: string) => ({ checked: box(title).getAttribute("aria-checked") === "true", disabled: box(title).disabled });
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
async function type(text: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("only this computer's own machine shows its threads, never another machine's settings", async () => {
  await show(fake(LIST), "m-other");
  expect(host.textContent).toBe("");
  // Paired as another machine now: its bridge's answer names that one.
  await show(fake({ ...LIST, machineId: "m-new" }), "m-here");
  expect(host.textContent).toBe("");
});

test("the list says what's shared; a room launch is locked on; search narrows by title or repo", async () => {
  await show(fake(LIST));
  expect(host.querySelector(".t3-threads-head")?.textContent).toContain("3 of 5 shared");
  // Shared first, then waiting, then the rest.
  expect(rows()).toEqual(["Fix invoice rounding", "Totals per station", "Tax export for Ana", "Draft the Q4 roadmap", "Old migration"]);
  expect(boxState("Totals per station")).toEqual({ checked: true, disabled: true });
  expect(host.textContent).toContain("started from the room, so it stays shared until it ends");
  expect(boxState("Tax export")).toEqual({ checked: false, disabled: false });
  // Each box is named by its title and described by its project and state.
  const described = host.querySelector(`#${CSS.escape(box("Tax export").getAttribute("aria-describedby")!)}`);
  expect(described?.textContent).toBe("Billing, Waiting for an answer");
  await type("planning");
  expect(rows()).toEqual(["Draft the Q4 roadmap"]);
  await type("billing tax");
  expect(rows()).toEqual(["Tax export for Ana"]);
  await type("Old migration");
  expect(rows()).toEqual(["Old migration"]);
  expect(host.textContent).not.toContain("No thread matches");
  await type("nothing like it");
  expect(rows()).toEqual([]);
  expect(host.textContent).toContain("No thread matches “nothing like it”.");
  await act(async () => button("Clear search")!.click());
  expect(rows()).toHaveLength(5);
});

test("Save sends exactly the threads picked, room launches left out, and Discard drops the picks", async () => {
  await show(fake(LIST));
  expect(button("Save changes")).toMatchObject({ disabled: true });
  await act(async () => box("Tax export").click());
  await act(async () => box("Fix invoice").click());
  expect(host.querySelector(".t3-threads-foot")?.textContent).toContain(
    "Share 1 thread and stop sharing 1 thread when you save. A thread you stop sharing keeps running in T3 Code",
  );
  await act(async () => button("Discard")!.click());
  expect(boxState("Tax export").checked).toBe(false);
  expect(button("Save changes")).toMatchObject({ disabled: true });
  await act(async () => box("Tax export").click());
  await act(async () => box("Old migration").click());
  await act(async () => button("Save changes")!.click());
  expect(shares).toEqual([{ machineId: "m-here", environmentId: "env-1", revision: 4, threads: ["t-fix", "t-tax"] }]);
  expect(mocks.toasts).toEqual(["Shared 1 thread and stopped sharing 1 thread"]);
});

test("a refused save says why, keeps the picks, and saving again sends them again", async () => {
  let refuse = true;
  const api = fake(LIST, async () => {
    if (refuse) throw new Error("Couldn't save the choice on this computer (EACCES). Try again.");
    return { ...LIST, revision: 5, threads: LIST.threads.map((t) => (t.id === "t-roadmap" ? { ...t, shared: true } : t)) };
  });
  await show(api);
  await act(async () => box("Draft the Q4").click());
  await act(async () => button("Save changes")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save the choice on this computer (EACCES). Try again.");
  expect(boxState("Draft the Q4").checked).toBe(true);
  expect(mocks.toasts).toEqual([]);
  refuse = false;
  await act(async () => button("Save changes")!.click());
  expect(shares.map((s) => s.threads)).toEqual([["t-fix", "t-roadmap", "t-old"], ["t-fix", "t-roadmap", "t-old"]]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.toasts).toEqual(["Shared 1 thread from this computer"]);
  expect(button("Save changes")).toMatchObject({ disabled: true });
});

test("with no threads, no bridge, or a bridge that can't list them, it says so and offers what helps", async () => {
  await show(fake({ ...LIST, threads: [], missing: [] }));
  expect(host.textContent).toContain("T3 Code has no threads on this computer yet. New threads show up here, private until you share them.");
  expect(host.querySelector('input[type="search"]')).toBeNull();
  expect(host.textContent).not.toContain("of 0 shared");
  // The bridge is off: this computer is known from its pairing.
  await show(fake({ state: "bridge_off" }));
  expect(host.textContent).toContain("The bridge isn't running on this computer");
  let calls = 0;
  await show({ ...fake({ state: "unavailable", error: "The bridge running on this computer can't list T3 Code threads." }), read: async () => (calls++, { state: "unavailable", error: "The bridge running on this computer can't list T3 Code threads." }) });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("can't list T3 Code threads");
  const before = calls;
  await act(async () => button("Try again")!.click());
  expect(calls).toBe(before + 1);
  await show(fake({ ...LIST, threads: [], missing: [], otherEnvironment: 2 }));
  expect(host.textContent).toContain("2 threads were shared while T3 Code here was another environment, so none of them is shared now.");
});
