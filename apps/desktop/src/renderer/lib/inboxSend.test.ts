import { describe, expect, test } from "vitest";
import type { MachineRow } from "./api";
import { taskTitle, threadMachine } from "./inboxSend";

function machine(over: Partial<Omit<MachineRow, "machineId">> & { machineId?: string } = {}): MachineRow {
  return {
    machineId: "m1",
    name: "box",
    belongsTo: { kind: "team" },
    online: true,
    tools: [],
    mostOpenAccess: "drive",
    slots: 2,
    slotsInUse: 0,
    longestProfileMs: 0,
    sharingStopped: false,
    liveTerminals: 0,
    t3: { state: "connected" },
    ...over,
  } as unknown as MachineRow;
}

describe("threadMachine", () => {
  test("takes your own machine with T3 Code connected before a team machine", () => {
    const team = machine({ machineId: "team" });
    const mine = machine({ machineId: "mine" });
    expect(threadMachine([team, mine], (m) => m.machineId === "mine")?.machineId).toBe("mine");
  });

  test("skips a machine whose T3 Code isn't connected, or that can't take a run", () => {
    const unpaired = machine({ machineId: "a", t3: { state: "needs_pairing" } } as never);
    const offline = machine({ machineId: "b", online: false });
    const noT3 = machine({ machineId: "c", t3: undefined } as never);
    expect(threadMachine([unpaired, offline, noT3], () => false)).toBeUndefined();
  });
});

describe("taskTitle", () => {
  test("is the first line of the message", () => {
    expect(taskTitle("  Fix the Safari checkout crash\nIt throws on submit.")).toBe(
      "Fix the Safari checkout crash",
    );
  });

  test("cuts a long first line at a word", () => {
    const title = taskTitle(
      "the checkout page crashes on Safari when the cart has more than ten items and a coupon applied, can someone look",
    );
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toBe("the checkout page crashes on Safari when the cart has more than ten items and…");
  });
});
