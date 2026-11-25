import type { MachineRow } from "./api";
import { ACCESS_META, accessRank } from "./format";

/**
 * Which machines the run picker offers (#10). A machine whose bridge is
 * offline can't take a run, except a cloud machine the room can start: a run
 * started there wakes it first (wake-before-start), so it's offered as
 * "Starts when you run". Sharing and slots are checked the same either way.
 */

export function slotsFree(machine: MachineRow): number {
  return machine.slots - machine.slotsInUse;
}

/** A cloud machine that isn't up yet but that starting a run will start. */
export function wakesOnRun(machine: MachineRow): boolean {
  const state = machine.cloud?.state;
  return state !== undefined && state !== "running" && state !== "deleting" && state !== "deleted";
}

/**
 * True when someone else's personal machine is set to Watch or Suggest: only the person it belongs
 * to, and their agents, can start runs there (ADR 0025). Team machines take runs from anyone.
 */
export function takesOnlyItsPersonsRuns(machine: MachineRow, mine: boolean): boolean {
  return !mine && machine.belongsTo.kind === "person" && accessRank(machine.mostOpenAccess) < accessRank("drive");
}

/**
 * The person who drives every terminal and thread on a machine: set for a personal machine at Watch
 * or Suggest, whose person takes the wheel of what teammates drove there (ADR 0025).
 */
export function personDriving(machine: MachineRow | undefined): { memberId: string; name: string } | undefined {
  if (!machine || machine.belongsTo.kind !== "person") return undefined;
  return accessRank(machine.mostOpenAccess) < accessRank("drive") ? machine.belongsTo.member : undefined;
}

/**
 * Whether someone may take back, or be handed, the wheel of a terminal or thread set below Drive:
 * whoever started it; on a machine its person drives (personDriving), that person, or an agent of
 * theirs that started it. The room and the bridge check the same.
 */
export function mayDriveBelowDrive(
  machine: MachineRow | undefined,
  startedBy: { memberId: string; addedBy?: { memberId: string } | undefined } | undefined,
  memberId: string,
): boolean {
  const person = personDriving(machine);
  if (!person) return memberId === startedBy?.memberId;
  return memberId === person.memberId || (memberId === startedBy?.memberId && startedBy.addedBy?.memberId === person.memberId);
}

/** Someone's first name, for short sentences: "Axel" from "Axel Manosalvas". */
export function firstName(name: string): string {
  return name.split(" ")[0] || name;
}

/** Why a machine can't take a run right now, or null. */
export function machineBlock(machine: MachineRow, mine: boolean): string | null {
  if (machine.cloud && (machine.cloud.state === "deleting" || machine.cloud.state === "deleted")) {
    return "This cloud machine is being deleted.";
  }
  if (takesOnlyItsPersonsRuns(machine, mine) && machine.belongsTo.kind === "person") {
    return `${firstName(machine.belongsTo.member.name)}'s machine is set to ${ACCESS_META[machine.mostOpenAccess].label}: teammates can't start runs there.`;
  }
  if (machine.sharingStopped) return "Sharing is stopped on this machine.";
  if (!machine.online && !wakesOnRun(machine)) return "Its bridge is offline.";
  if (!mine && slotsFree(machine) <= 0) return "No free slot. Pick another machine or ask whoever it belongs to.";
  return null;
}

/** The picker's first choice: a machine that is up, else one that starts when you run. */
export function defaultMachine(machines: MachineRow[], mineOn: (m: MachineRow) => boolean): MachineRow | undefined {
  const open = machines.filter((m) => machineBlock(m, mineOn(m)) === null);
  return open.find((m) => !wakesOnRun(m) && m.online) ?? open[0];
}

/**
 * Why a machine can't take a run in Rex (ADR 0019), or null when it can. A machine's bridge opens
 * Rex tabs only on macOS and Linux with Rex installed, and the room checks the same.
 */
export function rexBlock(machine: MachineRow | undefined): string | null {
  if (!machine) return null;
  if (!machine.rex?.available)
    return `${machine.name} can't open Rex tabs: Rex isn't installed there, it's a Windows machine, or its Uplink Room app is older than Rex tabs.`;
  if (machine.rex?.running === false) return `Rex isn't running on ${machine.name}. Open Rex there first.`;
  return null;
}
