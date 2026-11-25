/**
 * What the A2A tests share (tests/a2a.test.ts, tests/a2aChat.test.ts): local agents built on the
 * official SDK (fakeAgent.ts, started by globalSetup.ts), a team with one connected, and waiting on
 * the worker's scheduled steps.
 */
import { inject } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { a2aTiming, setA2ATimingForTests } from "../../convex/lib/a2a/timing";
import { newRoom, newTeam, type Person, type Room } from "../setup";
import type { FakeAgentOptions } from "./fakeAgent";

export type Spawned = { id: string; url: string; cardUrl: string };

export async function spawn(options: FakeAgentOptions = {}): Promise<Spawned> {
  const response = await fetch(`${inject("fakeAgents")}/agents`, {
    method: "POST",
    body: JSON.stringify(options),
  });
  return (await response.json()) as Spawned;
}

export async function setOptions(agent: Spawned, patch: FakeAgentOptions): Promise<void> {
  await fetch(`${inject("fakeAgents")}/agents/${agent.id}/options`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function callsOf(
  agent: Spawned,
): Promise<{ method: string; headers: Record<string, string | undefined>; params: any }[]> {
  return (await (await fetch(`${inject("fakeAgents")}/agents/${agent.id}/calls`)).json()) as never;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fastTiming() {
  setA2ATimingForTests({ fast: true });
  return a2aTiming();
}

/**
 * Runs scheduled work (the worker's actions) until `read` gives a value `ok` accepts.
 * `live`: don't wait for running steps (one may hold a stream open); just poll while they run.
 * 15 s by default, under the package's 20 s test timeout: a full run, worker and local agent
 * included, took more than 8 s on a Windows runner while another job shared it.
 */
export async function until<T>(
  t: Room,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 15_000,
  live = false,
): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    if (!live) await t.finishInProgressScheduledFunctions();
    last = await read();
    if (ok(last)) return last;
    await sleep(15);
  }
  throw new Error(`Timed out. Last value: ${JSON.stringify(last, null, 2)}`);
}

/** A team, an A2A agent added by Julio, and its endpoint connected and checked. */
export async function connected(
  options: FakeAgentOptions & { token?: string; sendWork?: "team" | "accountable"; agentName?: string } = {},
) {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const agentName = options.agentName ?? "Hermes";
  const agentId = await admin.as.mutation(api.agents.add, {
    teamId,
    name: agentName,
    connection: "a2a",
  });
  const fake = await spawn(options);
  await admin.as.mutation(api.a2a.connect, {
    teamId,
    agentId,
    cardUrl: fake.url,
    ...(options.token ? { credential: { kind: "bearer" as const, secret: options.token } } : {}),
    ...(options.sendWork ? { sendWork: options.sendWork } : {}),
  });
  const peer = await until(
    t,
    () => admin.as.query(api.a2a.get, { teamId, agentId }),
    (p) => p?.status !== "checking",
  );
  const members = await admin.as.query(api.teams.members, { teamId });
  const agentMemberId = members.find((m) => m.name === agentName)!.memberId as Id<"members">;
  return { t, teamId, admin, agentId, agentMemberId, fake, peer: peer! };
}

export async function runOf(t: Room, person: Person, teamId: Id<"teams">, runId: Id<"runs">) {
  return person.as.query(api.runs.get, { teamId, runId });
}

export async function settled(
  t: Room,
  person: Person,
  teamId: Id<"teams">,
  runId: Id<"runs">,
  state: string,
) {
  return until(
    t,
    () => runOf(t, person, teamId, runId),
    (r) => r.state === state,
  );
}

