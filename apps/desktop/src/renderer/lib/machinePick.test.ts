import { describe, expect, test } from "vitest";
import type { MachineRow } from "./api";
import { defaultMachine, machineBlock, rexBlock, wakesOnRun } from "./machinePick";

/** #10, review finding 8: the run picker offers stopped cloud machines, which start when the run does. */

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
    ...over,
  } as unknown as MachineRow;
}

const cloud = (state: string) => ({ state, region: "iad1", idleMinutes: 15 }) as unknown as MachineRow["cloud"];

describe("machineBlock", () => {
  test("an offline linked machine is blocked", () => {
    expect(machineBlock(machine({ online: false }), false)).toMatch(/offline/);
  });

  test("a stopped, failed or still starting cloud machine is offered, and starts when you run", () => {
    for (const state of ["stopped", "stopping", "failed", "starting", "creating"]) {
      const m = machine({ online: false, cloud: cloud(state) });
      expect(machineBlock(m, false)).toBeNull();
      expect(wakesOnRun(m)).toBe(true);
    }
    expect(wakesOnRun(machine({ online: true, cloud: cloud("running") }))).toBe(false);
  });

  test("a cloud machine being deleted is blocked", () => {
    expect(machineBlock(machine({ online: false, cloud: cloud("deleting") }), false)).toMatch(/deleted/);
  });

  test("sharing and slot checks still apply to a stopped cloud machine", () => {
    expect(machineBlock(machine({ online: false, cloud: cloud("stopped"), sharingStopped: true }), false)).toMatch(/Sharing/);
    expect(machineBlock(machine({ online: false, cloud: cloud("stopped"), slotsInUse: 2 }), false)).toMatch(/slot/);
  });
});

test("someone else's personal machine set to View or Suggest won't take your run, and says why; yours always will (ADR 0025)", () => {
  const axels = (mostOpenAccess: string) =>
    machine({ mostOpenAccess, belongsTo: { kind: "person", member: { memberId: "axel", name: "Axel Manosalvas", kind: "person" } } } as never);
  expect(machineBlock(axels("suggest"), false)).toBe("Axel's machine is set to Suggest: teammates can't start runs there.");
  expect(machineBlock(axels("watch"), false)).toBe("Axel's machine is set to View: teammates can't start runs there.");
  for (const level of ["drive", "open"]) expect(machineBlock(axels(level), false)).toBeNull();
  // Axel's own view of it, and a team machine at Suggest.
  expect(machineBlock(axels("suggest"), true)).toBeNull();
  expect(machineBlock(machine({ mostOpenAccess: "suggest" } as never), false)).toBeNull();
});

test("the picker's first choice is a machine that is up; a stopped cloud machine only when none is", () => {
  const stopped = machine({ machineId: "cloud", online: false, cloud: cloud("stopped") });
  const up = machine({ machineId: "up" });
  expect(defaultMachine([stopped, up], () => false)?.machineId).toBe("up");
  expect(defaultMachine([stopped], () => false)?.machineId).toBe("cloud");
  expect(defaultMachine([machine({ online: false })], () => false)).toBeUndefined();
});

describe("rexBlock", () => {
  test("In Rex is offered where the bridge opens Rex tabs, and off with the reason elsewhere", () => {
    const rex = (available: boolean, running?: boolean) => ({ available, running }) as MachineRow["rex"];
    expect(rexBlock(machine({ rex: rex(true, true) }))).toBeNull();
    // Unknown until the bridge reports: the room checks again, and the bridge refuses if Rex is gone.
    expect(rexBlock(machine({ rex: rex(true) }))).toBeNull();
    expect(rexBlock(machine({ rex: rex(true, false) }))).toMatch(/Rex isn't running on box/);
    expect(rexBlock(machine({ rex: rex(false) }))).toMatch(/can't open Rex tabs/);
  });
});
