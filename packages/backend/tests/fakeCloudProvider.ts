import type {
  BootStep,
  CloudMachineProvider,
  MachineSpec,
  ProviderState,
  SessionOptions,
} from "../convex/lib/cloudProvider";

type Op = "create" | "start" | "stop" | "extend" | "status" | "delete" | "list" | "deleteSnapshot";

/**
 * A cloud machine provider that runs nothing and models what Vercel Sandbox
 * does, standing in for it in Room API tests:
 *  - machines are found by name, so a repeated create or start changes nothing;
 *  - a stopped machine keeps its disk (`disk`), and nothing else: the next boot
 *    is a new session that runs the boot step again;
 *  - the provider can stop a machine by itself, as at the end of a session;
 *  - any call can be made to fail once, and a call can be held part-way so a
 *    test can act while it is in flight.
 */
export function fakeCloudProvider() {
  type Machine = {
    spec: MachineSpec;
    state: ProviderState;
    disk: Map<string, string>;
    sessions: number;
    timeoutMs: number;
    tags: Record<string, string>;
  };
  /** Snapshots by id, with the name of the box they came from. Each stop keeps one per box, as `keepLastSnapshots: 1` does. */
  const snapshots = new Map<string, string>();
  let snapshotCount = 0;
  /** When set, a delete leaves the box's snapshots behind, as Vercel's asynchronous snapshot cleanup can. */
  let leaveSnapshots = false;
  const machines = new Map<string, Machine>();
  const calls: { op: Op; name: string }[] = [];
  const created: { spec: MachineSpec; session: SessionOptions }[] = [];
  const boots: { name: string; boot: BootStep; session: SessionOptions }[] = [];
  const extended: { name: string; ms: number }[] = [];
  const failing = new Map<Op, { reason: string; times: number }>();
  const holds = new Map<Op, { reached: () => void; released: Promise<void> }>();

  async function enter(op: Op, name: string) {
    calls.push({ op, name });
    const hold = holds.get(op);
    if (hold) {
      holds.delete(op);
      hold.reached();
      await hold.released;
    }
    const failure = failing.get(op);
    if (failure !== undefined) {
      if (--failure.times <= 0) failing.delete(op);
      throw new Error(failure.reason);
    }
  }

  function get(name: string): Machine {
    const machine = machines.get(name);
    if (!machine) throw new Error(`Vercel answered 404: no sandbox named ${name}`);
    return machine;
  }

  const provider: CloudMachineProvider = {
    name: "fake",
    async create(spec, session) {
      await enter("create", spec.name);
      created.push({ spec, session });
      if (machines.has(spec.name)) return;
      machines.set(spec.name, {
        spec,
        state: "running",
        disk: new Map(),
        sessions: 1,
        timeoutMs: session.timeoutMs,
        tags: { ...spec.tags },
      });
    },
    async start(name, session, boot, generation) {
      await enter("start", name);
      const machine = get(name);
      machine.tags["gen"] = String(generation);
      if (machine.state !== "running") {
        machine.sessions++;
        machine.timeoutMs = session.timeoutMs;
      }
      machine.state = "running";
      boots.push({ name, boot, session });
    },
    async stop(name) {
      await enter("stop", name);
      const machine = machines.get(name);
      if (machine && machine.state !== "stopped") {
        machine.state = "stopped";
        for (const [id, from] of snapshots) if (from === name) snapshots.delete(id);
        snapshots.set(`snap-${++snapshotCount}`, name);
      }
    },
    async extend(name, ms) {
      await enter("extend", name);
      get(name).timeoutMs += ms;
      extended.push({ name, ms });
    },
    async status(name) {
      await enter("status", name);
      return machines.get(name)?.state ?? "missing";
    },
    async delete(name) {
      await enter("delete", name);
      machines.delete(name);
      // `deleteOrphanSnapshots: true`.
      if (!leaveSnapshots) for (const [id, from] of snapshots) if (from === name) snapshots.delete(id);
    },
    async list(room) {
      // The listing is what the provider saw when asked; the room may move on while it is in flight.
      const seen = [...machines.entries()]
        .filter(([, m]) => m.tags["room"] === room)
        .map(([name, m]) => ({ name, state: m.state, tags: { ...m.tags } }));
      await enter("list", room);
      return seen;
    },
    async listSnapshots(name) {
      // As seen live (2026-11-02): listing by name finds nothing once the box is gone.
      if (!machines.has(name)) return [];
      return [...snapshots.entries()].filter(([, from]) => from === name).map(([id]) => id);
    },
    async deleteSnapshot(id) {
      await enter("deleteSnapshot", id);
      snapshots.delete(id);
    },
  };

  return {
    provider,
    calls,
    created,
    boots,
    extended,
    /** How many times `op` was called. */
    count: (op: Op) => calls.filter((c) => c.op === op).length,
    /** The machine's state at the provider, or `missing`. */
    state: (name: string): ProviderState => machines.get(name)?.state ?? "missing",
    /** The machine's kept disk: what survives a stop. */
    disk: (name: string) => get(name).disk,
    sessions: (name: string) => get(name).sessions,
    /** The snapshots kept from the box with this name. */
    snapshotsOf: (name: string) => [...snapshots.entries()].filter(([, from]) => from === name).map(([id]) => id),
    /** A snapshot the provider kept although its box is gone, as when a delete skipped it. */
    addSnapshot: (name: string) => {
      const id = `snap-${++snapshotCount}`;
      snapshots.set(id, name);
      return id;
    },
    /** Deletes leave snapshots behind from now on. */
    leaveSnapshotsOnDelete: () => {
      leaveSnapshots = true;
    },
    /** A box someone made in the provider project directly, with these tags. */
    addBox: (name: string, tags: Record<string, string>, state: ProviderState = "running") => {
      machines.set(name, {
        spec: { name, region: "iad1", vcpus: 1, tags },
        state,
        disk: new Map(),
        sessions: 1,
        timeoutMs: 0,
        tags: { ...tags },
      });
    },
    /** The box runs although nobody asked the provider to start it, as after a compensating stop that failed. */
    runByItself: (name: string) => {
      get(name).state = "running";
    },
    tags: (name: string) => ({ ...get(name).tags }),
    /** The provider stops the machine by itself, as when its session runs out. No call reaches the room. */
    stopByItself: (name: string) => {
      get(name).state = "stopped";
    },
    /** The next call of `op` throws this. */
    failNext: (op: Op, reason: string) => {
      failing.set(op, { reason, times: 1 });
    },
    /** The next `times` calls of `op` throw this, as during a provider outage. */
    failTimes: (op: Op, times: number, reason: string) => {
      failing.set(op, { reason, times });
    },
    /** The next call of `op` waits until `release()`. `reached` resolves once it is waiting. */
    holdNext: (op: Op) => {
      let reached!: () => void;
      let release!: () => void;
      const reachedP = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      holds.set(op, { reached, released });
      return { reached: reachedP, release };
    },
  };
}

export type FakeCloudProvider = ReturnType<typeof fakeCloudProvider>;
