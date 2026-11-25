import { expect, test, vi } from "vitest";

vi.mock("../lib/call", () => ({}));
vi.mock("../lib/session", () => ({}));
vi.mock("../lib/presence", () => ({}));
vi.mock("./Faces", () => ({}));
vi.mock("./useNow", () => ({}));
const { byPresence, doingOf, groupOf } = await import("./People");
type Person = Parameters<typeof doingOf>[0];

const person = (
  over: Partial<Person> & { name?: string; status?: string; kind?: "person" | "agent" } = {},
): Person => ({
  member: {
    memberId: over.name ?? "ana",
    name: over.name ?? "Ana",
    kind: over.kind ?? "person",
    role: "member",
    status: over.status,
  } as Person["member"],
  me: over.me ?? false,
  presence: over.presence ?? "active",
  presenceText: over.presenceText ?? "Active",
  inCall: over.inCall,
  agent: over.agent,
});

test("what someone is doing: their call first, then their status, then whether they're here", () => {
  expect(doingOf(person({ presence: "offline", presenceText: "Last seen 5 min ago" }))).toBe(
    "Last seen 5 min ago",
  );
  expect(doingOf(person({ status: "Reviewing PRs" }))).toBe("Reviewing PRs");
  expect(
    doingOf(
      person({ status: "Reviewing PRs", inCall: { channelId: "g" as never, where: "#general" } }),
    ),
  ).toBe("In a call in #general · Reviewing PRs");
  expect(doingOf(person({ me: true }))).toBe("Set a status");
  expect(doingOf(person({ presence: "away", presenceText: "Away" }))).toBe("Away");
  expect(doingOf(person())).toBe("");
  expect(doingOf(person({ presence: "offline", presenceText: "Offline" }))).toBe("");
});

test("an agent says its run state and what it's on, or Idle", () => {
  const agent = (state: "working" | "idle", line?: string) =>
    person({ kind: "agent", name: "Hermes", agent: { state, line, checksIn: false } });
  expect(doingOf(agent("working", "Fix the flaky test"))).toBe("Working: Fix the flaky test");
  expect(doingOf(agent("idle"))).toBe("Idle");
  expect(groupOf(agent("idle"))).toBe("agents");
});

test("online people are grouped apart from offline ones, you first, then a call, active, away", () => {
  expect(groupOf(person({ presence: "offline" }))).toBe("offline");
  expect(groupOf(person({ presence: "away" }))).toBe("online");
  expect(
    groupOf(
      person({ presence: "offline", inCall: { channelId: "g" as never, where: "#general" } }),
    ),
  ).toBe("online");
  const sorted = [
    person({ name: "Zed", presence: "away" }),
    person({ name: "Bo", presence: "active" }),
    person({ name: "Cy", inCall: { channelId: "g" as never, where: "#general" } }),
    person({ name: "Me", me: true }),
  ].sort(byPresence);
  expect(sorted.map((p) => p.member.name)).toEqual(["Me", "Cy", "Bo", "Zed"]);
});
